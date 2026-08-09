/**
 * Connector lifecycle acceptance test:
 * connect (OAuth) → token vending → automatic refresh → revoke handling →
 * SelfOps error evidence → reconnect → disconnect. All Google HTTP is faked
 * behind the injected FetchLike; the fake plugin host runs real storage,
 * http routes, rpc, and schedules.
 */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./src/server.js";
import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GMAIL_PROFILE_URL,
  type FetchLike,
} from "./src/oauth.js";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (host: any, method: string) =>
  host.harness.callRpc(method, null) as Promise<any>;

/** Scriptable fake of the Google endpoints the connector talks to. */
function fakeGoogle(initial?: { revokeRefreshTokens?: boolean }) {
  const state = {
    refreshTokenValid: !initial?.revokeRefreshTokens,
    refreshCalls: 0,
    exchangeCalls: 0,
    revokeCalls: 0,
    issuedTokens: [] as string[],
  };
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      const body = new URLSearchParams(init?.body ?? "");
      if (body.get("grant_type") === "authorization_code") {
        state.exchangeCalls += 1;
        if (body.get("code") !== "good-code") {
          return json(400, {
            error: "invalid_grant",
            error_description: "Bad code",
          });
        }
        return json(200, {
          access_token: `access-${state.exchangeCalls}`,
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
        });
      }
      // refresh_token grant
      state.refreshCalls += 1;
      if (!state.refreshTokenValid) {
        return json(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      const token = `refreshed-${state.refreshCalls}`;
      state.issuedTokens.push(token);
      return json(200, { access_token: token, expires_in: 3600 });
    }
    if (url.startsWith(GOOGLE_REVOKE_URL)) {
      state.revokeCalls += 1;
      state.refreshTokenValid = false;
      return json(200, {});
    }
    if (url.startsWith(GMAIL_PROFILE_URL)) {
      return json(200, { emailAddress: "malcolm.macintyre@gmail.com" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { state, fetchImpl };
}

function json(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

async function makeHost(fetchImpl: FetchLike) {
  const selfopsCalls: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "google-workspace",
    settings: { googleClientId: CLIENT_ID },
    sdk: {
      plugins: {
        callRpc: async (args: any) => {
          if (args.pluginId === "selfops") {
            selfopsCalls.push(args.input);
            return { ingested: 1, diagnoses: 0, autoFixed: 0, escalated: 0 };
          }
          throw new Error(`unexpected plugin rpc: ${args.pluginId}`);
        },
      },
    },
  });
  await plugin(host.bb, { fetchImpl });
  return { host, selfopsCalls };
}

/** Drive beginAuth → browser redirect → callback. */
async function connectFlow(host: Awaited<ReturnType<typeof makeHost>>["host"]) {
  const { url } = (await rpc(host, "beginAuth")) as {
    url: string;
  };
  const authorize = new URL(url);
  expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("access_type")).toBe("offline");
  const state = authorize.searchParams.get("state")!;
  const response = await host.harness.fetchHttp(
    "GET",
    `/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Google connected");
}

describe("google-workspace connector", () => {
  it("connects via OAuth and reports status", async () => {
    const google = fakeGoogle();
    const { host } = await makeHost(google.fetchImpl);
    expect((await rpc(host, "status")).connected).toBe(false);

    await connectFlow(host);

    const status = await rpc(host, "status");
    expect(status.connected).toBe(true);
    expect(status.email).toBe("malcolm.macintyre@gmail.com");
    expect(status.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(status.reconnectRequired).toBe(false);
    expect(google.state.exchangeCalls).toBe(1);
  });

  it("vends access tokens and refreshes automatically on expiry", async () => {
    const google = fakeGoogle();
    const { host } = await makeHost(google.fetchImpl);
    await connectFlow(host);

    const first = await rpc(host, "accessToken");
    expect(first.token).toBe("access-1"); // from the code exchange
    expect(first.email).toBe("malcolm.macintyre@gmail.com");

    // Cached: no refresh yet.
    const second = await rpc(host, "accessToken");
    expect(second.token).toBe("access-1");
    expect(google.state.refreshCalls).toBe(0);

    // The proactive sweep forces a real refresh.
    await host.harness.runSchedule("refresh-google-token");
    expect(google.state.refreshCalls).toBe(1);

    const third = await rpc(host, "accessToken");
    expect(third.token).toBe("refreshed-1");
  });

  it("rejects an unknown or replayed OAuth state", async () => {
    const google = fakeGoogle();
    const { host } = await makeHost(google.fetchImpl);
    const response = await host.harness.fetchHttp(
      "GET",
      "/oauth/callback?code=good-code&state=forged",
    );
    expect(await response.text()).toContain("unknown or expired");
    expect((await rpc(host, "status")).connected).toBe(false);
  });

  it("detects revoked credentials, reports to SelfOps, and recovers on reconnect", async () => {
    const google = fakeGoogle();
    const { host, selfopsCalls } = await makeHost(google.fetchImpl);
    await connectFlow(host);

    // User revokes access at myaccount.google.com: next refresh fails.
    google.state.refreshTokenValid = false;
    await host.harness.runSchedule("refresh-google-token");

    const status = await rpc(host, "status");
    expect(status.connected).toBe(false);
    expect(status.reconnectRequired).toBe(true);
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toContain("revoked");

    // SelfOps received broken-connector evidence (kind=error, consecutive≥1).
    expect(selfopsCalls.length).toBeGreaterThanOrEqual(1);
    const observation = (
      selfopsCalls[0] as { observations: Array<Record<string, unknown>> }
    ).observations[0];
    expect(observation.kind).toBe("error");
    expect(observation.subject).toBe("connector:google-workspace");

    // Token vending now fails with a clear reconnect error.
    await expect(rpc(host, "accessToken")).rejects.toThrow(
      /reconnect/i,
    );

    // Reconnect restores service with no leftover state.
    google.state.refreshTokenValid = true;
    await connectFlow(host);
    const restored = await rpc(host, "status");
    expect(restored.connected).toBe(true);
    expect(restored.reconnectRequired).toBe(false);
    const token = await rpc(host, "accessToken");
    expect(token.token).toBeTruthy();
  });

  it("disconnects with remote revocation and wipes the credential", async () => {
    const google = fakeGoogle();
    const { host } = await makeHost(google.fetchImpl);
    await connectFlow(host);

    const result = await rpc(host, "disconnect");
    expect(result.revoked).toBe(true);
    expect(google.state.revokeCalls).toBe(1);

    const status = await rpc(host, "status");
    expect(status.connected).toBe(false);
    await expect(rpc(host, "accessToken")).rejects.toThrow(
      /not connected/i,
    );
  });

  it("needs no client secret for desktop (PKCE) flow and requires configuration without a client id", async () => {
    const google = fakeGoogle();
    const host = createFakePluginHost({
      pluginId: "google-workspace",
      settings: {},
      sdk: {
        plugins: {
          callRpc: async () => ({
            ingested: 0,
            diagnoses: 0,
            autoFixed: 0,
            escalated: 0,
          }),
        },
      },
    });
    await plugin(host.bb, { fetchImpl: google.fetchImpl });
    const status = await rpc(host, "status");
    expect(status.configured).toBe(false);
    await expect(rpc(host, "beginAuth")).rejects.toThrow(
      /client ID/i,
    );
  });
});
