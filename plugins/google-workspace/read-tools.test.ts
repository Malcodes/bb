/**
 * Read-only agent tools: each call must vend a token through the
 * connector's own path, call the right Google endpoint, and return bounded,
 * credential-free output.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./src/server.js";
import { GOOGLE_TOKEN_URL, GMAIL_PROFILE_URL, type FetchLike } from "./src/oauth.js";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function gmailMessage(id: string, subject: string, from: string) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "1754784000000",
    snippet: `snippet ${id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from(`body of ${id}`).toString("base64url") },
      headers: [
        { name: "From", value: from },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: subject },
      ],
    },
  };
}

/** Full fake Google: OAuth + Gmail + Calendar REST. */
function fakeGoogle() {
  const state = { refreshCalls: 0, tokenRequests: 0 };
  const apiCalls: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init?: any) => {
    // Agent tools use global fetch; stubbed to this same impl in connectedHost.
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      state.tokenRequests += 1;
      const body = new URLSearchParams(init?.body ?? "");
      if (body.get("grant_type") === "authorization_code") {
        return res(200, {
          access_token: "access-initial",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: "gmail.readonly gmail.send calendar.events",
        });
      }
      state.refreshCalls += 1;
      return res(200, {
        access_token: `access-refresh-${state.refreshCalls}`,
        expires_in: 3600,
      });
    }
    if (url.startsWith(GMAIL_PROFILE_URL)) {
      return res(200, { emailAddress: "me@example.com" });
    }
    const auth = init?.headers?.authorization ?? "";
    apiCalls.push({ url, auth });
    if (url.includes("/gmail/v1/users/me/threads/")) {
      return res(200, {
        messages: [gmailMessage("m1", "Launch approval", "Ada <ada@acme.com>")],
      });
    }
    if (url.match(/\/gmail\/v1\/users\/me\/messages\/[^/?]+/)) {
      const id = url.split("/messages/")[1]!.split("?")[0]!;
      return res(200, gmailMessage(id, `Subject ${id}`, `sender-${id}@x.com`));
    }
    if (url.includes("/gmail/v1/users/me/messages")) {
      return res(200, {
        messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }],
      });
    }
    if (url.includes("/calendar/v3/calendars/")) {
      return res(200, {
        items: [
          {
            id: "evt-1",
            summary: "Acme launch review",
            start: { dateTime: "2026-08-10T15:00:00-07:00" },
            end: { dateTime: "2026-08-10T15:30:00-07:00" },
            status: "confirmed",
            organizer: { email: "ada@acme.com" },
            attendees: [
              { email: "me@example.com", responseStatus: "accepted" },
            ],
          },
        ],
        nextSyncToken: "cal-1",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) satisfies FetchLike;
  return { state, apiCalls, fetchImpl };
}

function res(status: number, payload: unknown) {
  return { ok: status < 300, status, json: async () => payload };
}

async function connectedHost(fetchImpl: FetchLike) {
  vi.stubGlobal("fetch", fetchImpl);
  const host = createFakePluginHost({
    pluginId: "google-workspace",
    settings: { googleClientId: CLIENT_ID },
    sdk: {
      plugins: {
        callRpc: async () => ({
          ingested: 0, diagnoses: 0, autoFixed: 0, escalated: 0,
        }),
      },
    },
  });
  await plugin(host.bb, { fetchImpl });
  const { url } = (await host.harness.callRpc("beginAuth", null)) as any;
  const state = new URL(url).searchParams.get("state")!;
  await host.harness.fetchHttp("GET", `/oauth/callback?code=good&state=${state}`);
  return host;
}

describe("google-workspace read-only agent tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes exactly the five read tools to every thread", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const config = await host.harness.resolveAgentConfiguration({
      thread: { id: "t1" } as any,
      projectId: "p1",
      origin: "user",
    } as any);
    expect(config.tools.map((t: any) => t.name).sort()).toEqual([
      "calendar_list_events",
      "calendar_search_events",
      "gmail_list_recent",
      "gmail_read_thread",
      "gmail_search",
    ]);
  });

  it("gmail_list_recent answers 'my 5 most recent emails' using the connector token", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(await host.harness.callAgentTool("gmail_list_recent", { maxResults: 5 })),
    );
    expect(out).toHaveLength(5);
    expect(out[0].subject).toBe("Subject m1");
    expect(out[0].from.email).toBe("sender-m1@x.com");
    // The Gmail API was hit with a connector-vended bearer token.
    const gmailCalls = google.apiCalls.filter((c) => c.url.includes("/gmail/"));
    expect(gmailCalls.length).toBeGreaterThanOrEqual(6); // list + 5 message fetches
    for (const call of gmailCalls) {
      expect(call.auth).toMatch(/^Bearer access-/);
    }
    // No credential material in tool output.
    expect(JSON.stringify(out)).not.toContain("access-");
    expect(JSON.stringify(out)).not.toContain("refresh-1");
  });

  it("gmail_search forwards Gmail query syntax", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("gmail_search", {
          query: "from:ada@acme.com subject:launch",
          maxResults: 3,
        }),
      ),
    );
    expect(out).toHaveLength(5); // fake returns 5 ids regardless of q
    const listCall = google.apiCalls.find((c) =>
      c.url.includes("/gmail/v1/users/me/messages?"),
    );
    expect(decodeURIComponent(listCall!.url)).toContain(
      "q=from:ada@acme.com+subject:launch",
    );
  });

  it("gmail_read_thread returns bodies with bounded length", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(await host.harness.callAgentTool("gmail_read_thread", { threadId: "thread-1" })),
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("body of m1");
    expect(out[0].subject).toBe("Launch approval");
  });

  it("calendar_list_events answers 'what's on my calendar tomorrow'", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_list_events", {
          timeMin: "2026-08-10T00:00:00-07:00",
          timeMax: "2026-08-11T00:00:00-07:00",
        }),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("Acme launch review");
    const calCall = google.apiCalls.find((c) => c.url.includes("/calendar/"));
    expect(decodeURIComponent(calCall!.url)).toContain("timeMin=2026-08-10");
    expect(calCall!.auth).toMatch(/^Bearer access-/);
  });

  it("calendar_search_events forwards q and bounds", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_search_events", {
          query: "launch",
          timeMin: "2026-08-09T00:00:00Z",
        }),
      ),
    );
    expect(out).toHaveLength(1);
    const call = google.apiCalls.find((c) => c.url.includes("/calendar/"));
    expect(decodeURIComponent(call!.url)).toContain("q=launch");
  });

  it("fails cleanly when Google is not connected, without leaking tokens", async () => {
    const google = fakeGoogle();
    const host = createFakePluginHost({
      pluginId: "google-workspace",
      settings: { googleClientId: CLIENT_ID },
      sdk: {
        plugins: {
          callRpc: async () => ({ ingested: 0, diagnoses: 0, autoFixed: 0, escalated: 0 }),
        },
      },
    });
    await plugin(host.bb, { fetchImpl: google.fetchImpl });
    await expect(
      host.harness.callAgentTool("gmail_list_recent", { maxResults: 5 }),
    ).rejects.toThrow(/not connected/i);
  });
});
