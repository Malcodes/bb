/**
 * RPC surface for the Google connector.
 *
 * `status` / `beginAuth` / `disconnect` drive the Settings→Plugins section.
 * `accessToken` is the internal token-vending method consumed server-side by
 * other plugins (sales) via bb.sdk.plugins.callRpc — it returns a fresh,
 * short-lived access token, refreshing first when needed. The refresh token
 * is never exposed over RPC.
 */
import { z } from "zod";
import { defineRpcContract } from "@bb/plugin-sdk";

export const connectorStatusSchema = z.object({
  /** Client id setting is present; OAuth can begin. */
  configured: z.boolean(),
  /** A refresh token is stored and (as far as we know) valid. */
  connected: z.boolean(),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  grantedAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number(),
  /** Refresh token rejected (invalid_grant): user must reconnect. */
  reconnectRequired: z.boolean(),
  /** Stored grant predates the current scope set: reconnect to upgrade consent. */
  scopeUpgradeRequired: z.boolean(),
  /** Scopes this connector now requires (for the settings UI hint). */
  requiredScopes: z.array(z.string()),
  /** Loopback redirect URI to allowlist in the Google OAuth client. */
  redirectUri: z.string(),
});

export const googleWorkspaceRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: connectorStatusSchema,
  },
  beginAuth: {
    input: z.null(),
    output: z.object({
      /** Google consent URL to open in the user's browser. */
      url: z.string(),
    }),
  },
  disconnect: {
    input: z.null(),
    output: z.object({
      /** True when Google confirmed revocation (false = local wipe only). */
      revoked: z.boolean(),
    }),
  },
  auditTrail: {
    input: z.object({
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({
      entries: z.array(
        z.object({
          at: z.string(),
          action: z.string(),
          target: z.string(),
          reason: z.string(),
          outcome: z.string(),
        }),
      ),
    }),
  },
  accessToken: {
    input: z.null(),
    output: z.object({
      token: z.string(),
      expiresAt: z.string(),
      email: z.string(),
    }),
  },
});

export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
