/**
 * First-party Google Workspace connector.
 *
 * Owns the OAuth lifecycle for BB's Google access: a "Connect Google" flow
 * started from Settings → Plugins → Google (PKCE + loopback redirect into
 * /oauth/callback), durable refresh-token storage in the plugin's own
 * SQLite file, automatic access-token refresh (lazy on vending + a 30-min
 * proactive sweep), revoke/reconnect, and health reporting.
 *
 * It deliberately ships no Gmail/Calendar UI and no agent tools: reads and
 * approval-gated writes flow through the existing GoogleWork adapters in
 * the sales plugin, which pulls a fresh token per cycle via the
 * `accessToken` RPC. Repeated refresh failures feed SelfOps as
 * broken-connector evidence.
 */
import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  GOOGLE_SCOPES,
  GoogleOAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  fetchAccountEmail,
  refreshAccessToken,
  revokeToken,
  type FetchLike,
} from "./oauth.js";
import { ConnectorStore } from "./store.js";
import { googleWorkspaceRpcContract } from "./rpc.js";

const SELFOPS_PLUGIN_ID = "selfops";
const REFRESH_SKEW_MS = 60_000;

export interface GoogleWorkspaceOptions {
  /** Overridable for tests. */
  fetchImpl?: FetchLike;
  now?: () => Date;
}

class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const CALLBACK_PATH = "/oauth/callback";

export default async function plugin(
  bb: BbPluginApi,
  options: GoogleWorkspaceOptions = {},
) {
  const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = () => (options.now ?? (() => new Date()))();
  const store = new ConnectorStore(bb.storage);

  const settings = bb.settings.define({
    googleClientId: {
      type: "string",
      label: "Google OAuth client ID",
      description:
        "From a Google Cloud project with the Gmail and Calendar APIs enabled (OAuth client type: Desktop app).",
    },
    googleClientSecret: {
      type: "string",
      label: "Google OAuth client secret",
      description:
        "Only needed for Web-type OAuth clients; Desktop clients use PKCE and can leave this unset.",
      secret: true,
    },
  });

  // In-memory access-token cache only — never persisted, never agent-visible.
  let cached: { token: string; expiresAtMs: number } | null = null;

  function redirectUri(): string {
    return `${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`;
  }

  async function emitConnectorError(error: string): Promise<void> {
    const health = store.getHealth();
    const consecutive = health.consecutiveFailures + 1;
    store.saveHealth({ ...health, consecutiveFailures: consecutive, lastError: error });
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: SELFOPS_PLUGIN_ID,
        method: "ingestObservations",
        input: {
          observations: [
            {
              id: `google-workspace-error-${now().toISOString()}`,
              kind: "error",
              observedAt: now().toISOString(),
              subject: "connector:google-workspace",
              attributes: { consecutive, error },
            },
          ],
        },
        outputSchema: z.object({
          ingested: z.number(),
          diagnoses: z.number(),
          autoFixed: z.number(),
          escalated: z.number(),
        }),
      });
    } catch {
      // SelfOps absent/disabled: health is already recorded locally.
    }
  }

  function recordRefreshSuccess(): void {
    const health = store.getHealth();
    store.saveHealth({
      ...health,
      lastRefreshAt: now().toISOString(),
      lastError: undefined,
      consecutiveFailures: 0,
    });
  }

  /** Fresh access token, refreshing when expired/near expiry. Throws RpcError. */
  async function currentAccessToken(): Promise<{
    token: string;
    expiresAt: string;
    email: string;
  }> {
    const credential = store.getCredential();
    if (!credential) {
      const reconnect = store.getHealth().reconnectRequired;
      throw new RpcError(
        reconnect ? "reconnect-required" : "not-connected",
        reconnect
          ? "Google access was revoked or expired. Reconnect from Settings → Plugins → Google."
          : "Google is not connected. Connect it from Settings → Plugins → Google.",
      );
    }
    const values = await settings.get();
    if (!values.googleClientId) {
      throw new RpcError(
        "not-configured",
        "Google OAuth client ID is not set on the Google plugin.",
      );
    }
    if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > now().getTime()) {
      return {
        token: cached.token,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
        email: credential.email,
      };
    }
    try {
      const refreshed = await refreshAccessToken(fetchImpl, {
        refreshToken: credential.refreshToken,
        clientId: values.googleClientId,
        clientSecret: values.googleClientSecret ?? undefined,
      });
      cached = {
        token: refreshed.accessToken,
        expiresAtMs: Date.parse(refreshed.expiresAt),
      };
      recordRefreshSuccess();
      return {
        token: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        email: credential.email,
      };
    } catch (error) {
      cached = null;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GoogleOAuthError && error.isInvalidGrant) {
        // Revoked/expired refresh token: wipe it so status shows
        // reconnect-required instead of vending failures forever.
        store.clearCredential();
        store.saveHealth({
          ...store.getHealth(),
          reconnectRequired: true,
        });
        await emitConnectorError(message);
        throw new RpcError(
          "reconnect-required",
          "Google access was revoked or expired. Reconnect from Settings → Plugins → Google.",
        );
      }
      await emitConnectorError(message);
      throw new RpcError("refresh-failed", `Google token refresh failed: ${message}`);
    }
  }

  bb.http.route(
    "GET",
    CALLBACK_PATH,
    async (context) => {
      const url = new URL(context.req.url);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      const pending = state ? store.takePendingAuth(state) : null;
      const page = (title: string, body: string, ok: boolean) =>
        new Response(
          `<!doctype html><html><head><title>${title}</title></head>` +
            `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
            `<h2>${title}</h2><p>${body}</p>` +
            (ok ? `<p>You can close this tab and return to BB.</p>` : "") +
            `</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );

      if (!pending) {
        return page(
          "Connection failed",
          "This sign-in attempt is unknown or expired. Start Connect Google again from BB settings.",
          false,
        );
      }
      if (oauthError || !code) {
        const message = oauthError ?? "missing code";
        await emitConnectorError(`OAuth callback: ${message}`);
        return page("Connection cancelled", `Google returned: ${message}.`, false);
      }
      const values = await settings.get();
      if (!values.googleClientId) {
        return page("Connection failed", "The Google OAuth client ID setting was removed mid-flow.", false);
      }
      try {
        const tokens = await exchangeCode(fetchImpl, {
          code,
          clientId: values.googleClientId,
          clientSecret: values.googleClientSecret ?? undefined,
          redirectUri: redirectUri(),
          codeVerifier: pending.verifier,
        });
        const email =
          (await fetchAccountEmail(fetchImpl, tokens.accessToken)) ?? "unknown";
        store.saveCredential({
          refreshToken: tokens.refreshToken,
          email,
          scopes: tokens.scope || GOOGLE_SCOPES.join(" "),
          grantedAt: now().toISOString(),
        });
        cached = {
          token: tokens.accessToken,
          expiresAtMs: Date.parse(tokens.expiresAt),
        };
        bb.realtime.publish("connection-changed", { connected: true, email });
        return page("Google connected", `Connected as <b>${email}</b>.`, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitConnectorError(`OAuth exchange: ${message}`);
        return page("Connection failed", message, false);
      }
    },
    // Browser redirect from Google: no Origin/CSRF header is present. The
    // one-time `state` parameter (consumed on use) is the verification.
    { auth: "none" },
  );

  bb.rpc.register(googleWorkspaceRpcContract, {
    async status() {
      const values = await settings.get();
      const credential = store.getCredential();
      const health = store.getHealth();
      return {
        configured: Boolean(values.googleClientId),
        connected: credential !== null,
        email: credential?.email ?? null,
        scopes: credential ? credential.scopes.split(" ").filter(Boolean) : [],
        grantedAt: credential?.grantedAt ?? null,
        lastRefreshAt: health.lastRefreshAt ?? null,
        lastError: health.lastError ?? null,
        consecutiveFailures: health.consecutiveFailures,
        reconnectRequired: health.reconnectRequired,
        redirectUri: redirectUri(),
      };
    },
    async beginAuth() {
      const values = await settings.get();
      if (!values.googleClientId) {
        throw new RpcError(
          "not-configured",
          "Set the Google OAuth client ID below, then connect.",
        );
      }
      const { verifier, challenge } = createPkcePair();
      const state = createState();
      store.savePendingAuth({
        state,
        verifier,
        createdAt: now().toISOString(),
      });
      return {
        url: buildAuthorizeUrl({
          clientId: values.googleClientId,
          redirectUri: redirectUri(),
          state,
          codeChallenge: challenge,
        }),
      };
    },
    async disconnect() {
      const credential = store.getCredential();
      let revoked = false;
      if (credential) {
        revoked = await revokeToken(fetchImpl, credential.refreshToken);
      }
      store.clearCredential();
      cached = null;
      const health = store.getHealth();
      store.saveHealth({
        ...health,
        lastError: undefined,
        consecutiveFailures: 0,
        reconnectRequired: false,
      });
      bb.realtime.publish("connection-changed", { connected: false });
      return { revoked };
    },
    async accessToken() {
      return currentAccessToken();
    },
  });

  // Proactive token maintenance: keeps access tokens warm and — more
  // importantly — detects revocation/expiry within 30 minutes instead of at
  // the next sales poll, feeding SelfOps broken-connector evidence.
  bb.background.schedule("refresh-google-token", "*/30 * * * *", async () => {
    if (!store.getCredential()) return;
    cached = null; // force a real refresh so failures surface here
    try {
      await currentAccessToken();
    } catch {
      // Already recorded + reported by currentAccessToken.
    }
  });

  const initialValues = await settings.get();
  if (!initialValues.googleClientId) {
    bb.status.needsConfiguration(
      "Set a Google OAuth client ID, then Connect Google from this plugin's settings section.",
    );
  }
}
