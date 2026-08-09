/**
 * Pure Google OAuth helpers for the connector — authorize URL construction
 * (PKCE S256, loopback redirect), code exchange, access-token refresh, and
 * revocation. All network goes through an injected fetch so tests drive the
 * whole lifecycle without HTTP.
 */
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/**
 * Minimum scopes for the existing GoogleWork adapters:
 * - gmail.readonly — history/list/get ingestion (pollGoogleWork)
 * - gmail.send — approval-gated replies (executeGoogleWorkAction)
 * - calendar.events — read + approval-gated event updates
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  // Google only issues a refresh token on the first consent without this;
  // requiring it makes reconnect-after-revoke reliable.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly googleError: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
  /** True when the stored credential is dead (revoked/expired refresh token). */
  get isInvalidGrant(): boolean {
    return this.googleError === "invalid_grant";
  }
}

function formBody(fields: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== "") body.set(key, value);
  }
  return body.toString();
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const googleError =
      typeof payload.error === "string" ? payload.error : undefined;
    const description =
      typeof payload.error_description === "string"
        ? payload.error_description
        : undefined;
    throw new GoogleOAuthError(
      description ?? googleError ?? `Google OAuth request failed (${response.status})`,
      googleError,
      response.status,
    );
  }
  return payload;
}

function clientAuthFields(input: {
  clientId: string;
  clientSecret?: string;
}): Record<string, string> {
  // Installed-app (desktop) clients authenticate with the PKCE verifier and
  // need no secret; web-type clients require it at the token endpoint.
  return {
    client_id: input.clientId,
    client_secret: input.clientSecret ?? "",
  };
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  input: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<{ refreshToken: string; accessToken: string; expiresAt: string; scope: string }> {
  const payload = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    ...clientAuthFields(input),
  });
  const refreshToken = payload.refresh_token;
  const accessToken = payload.access_token;
  if (typeof refreshToken !== "string" || typeof accessToken !== "string") {
    throw new GoogleOAuthError(
      "Google did not return a refresh token; reconnect with consent prompt.",
      "missing_refresh_token",
      200,
    );
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    refreshToken,
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}

export async function refreshAccessToken(
  fetchImpl: FetchLike,
  input: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  },
): Promise<{ accessToken: string; expiresAt: string }> {
  const payload = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    ...clientAuthFields(input),
  });
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string") {
    throw new GoogleOAuthError("Google returned no access token.", undefined, 200);
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/** Revoke a token at Google. Returns true when Google accepted the revocation. */
export async function revokeToken(
  fetchImpl: FetchLike,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Best-effort account identity for status display; needs an access token. */
export async function fetchAccountEmail(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await fetchImpl(GMAIL_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    return typeof payload.emailAddress === "string" ? payload.emailAddress : null;
  } catch {
    return null;
  }
}
