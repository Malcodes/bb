/**
 * Minimal Google REST client used by the draft + calendar agent tools.
 * Calls go out with a connector-vended bearer token; nothing here persists
 * or logs credentials.
 */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API ${status}: ${detail.slice(0, 300)}`);
    this.name = "GoogleApiError";
  }
  /** 403 with insufficient scopes — the stored grant predates new scopes. */
  get isInsufficientScope(): boolean {
    return this.status === 403;
  }
}

async function request(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(`https://www.googleapis.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  return response.status === 204 ? {} : response.json();
}

export const googleApi = {
  get: (token: string, path: string) => request(token, "GET", path),
  getWithQuery(token: string, path: string, params: Record<string, string>) {
    const query = new URLSearchParams(params).toString();
    return request(token, "GET", `${path}?${query}`);
  },
  post: (token: string, path: string, body: unknown) =>
    request(token, "POST", path, body),
  patch: (token: string, path: string, body: unknown) =>
    request(token, "PATCH", path, body),
  put: (token: string, path: string, body: unknown) =>
    request(token, "PUT", path, body),
  delete: (token: string, path: string) => request(token, "DELETE", path),
  /** Patch with an explicit sendUpdates query (invite-notification control). */
  patchWithQuery(
    token: string,
    path: string,
    body: unknown,
    params: Record<string, string>,
  ) {
    const query = new URLSearchParams(params).toString();
    return request(token, "PATCH", `${path}?${query}`, body);
  },
  deleteWithQuery(token: string, path: string, params: Record<string, string>) {
    const query = new URLSearchParams(params).toString();
    return request(token, "DELETE", `${path}?${query}`);
  },
};
