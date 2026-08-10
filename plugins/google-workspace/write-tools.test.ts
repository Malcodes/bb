/**
 * Acceptance: Gmail drafts (create/update/list/read/delete — never send),
 * calendar writes (solo direct, shared approval-gated), free/busy, audit
 * trail, and scope-upgrade signaling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./src/server.js";
import { GOOGLE_TOKEN_URL, GMAIL_PROFILE_URL, type FetchLike } from "./src/oauth.js";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function res(status: number, payload: unknown) {
  return {
    ok: status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const SOLO_EVENT = {
  id: "solo-1",
  summary: "Morning run",
  start: { dateTime: "2026-08-10T07:00:00-07:00", timeZone: "America/Vancouver" },
  end: { dateTime: "2026-08-10T07:45:00-07:00", timeZone: "America/Vancouver" },
  status: "confirmed",
  organizer: { email: "me@example.com", self: true },
};

const SHARED_EVENT = {
  id: "shared-1",
  summary: "Acme launch review",
  start: { dateTime: "2026-08-10T15:00:00-07:00", timeZone: "America/Vancouver" },
  end: { dateTime: "2026-08-10T15:30:00-07:00", timeZone: "America/Vancouver" },
  status: "confirmed",
  organizer: { email: "me@example.com", self: true },
  attendees: [
    { email: "me@example.com", responseStatus: "accepted", self: true },
    { email: "ada@acme.com", responseStatus: "accepted" },
  ],
};

function fakeGoogle() {
  const calls: Array<{ url: string; method: string; body?: any; auth: string }> = [];
  const drafts = new Map<string, any>();
  const fetchImpl = (async (url: string, init?: any) => {
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      const body = new URLSearchParams(init?.body ?? "");
      if (body.get("grant_type") === "authorization_code") {
        return res(200, {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events",
        });
      }
      return res(200, { access_token: "access-1", expires_in: 3600 });
    }
    if (url.startsWith(GMAIL_PROFILE_URL)) {
      return res(200, { emailAddress: "me@example.com" });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, auth: init?.headers?.authorization ?? "" });

    // --- Gmail drafts ---
    if (url.includes("/gmail/v1/users/me/drafts")) {
      const draftPath = url.split("?")[0]!;
      if (method === "POST" && draftPath.endsWith("/drafts")) {
        const id = `draft-${drafts.size + 1}`;
        const raw = Buffer.from(body.message.raw, "base64url").toString("utf8");
        const header = (name: string) =>
          raw.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
        const draft = {
          id,
          message: {
            id: `msg-${id}`,
            threadId: body.message.threadId,
            snippet: raw.split("\r\n\r\n")[1]?.slice(0, 60) ?? "",
            internalDate: "1754784000000",
            payload: {
              mimeType: "text/plain",
              body: {
                data: Buffer.from(raw.split("\r\n\r\n")[1] ?? "").toString("base64url"),
              },
              headers: [
                { name: "To", value: header("To") },
                { name: "Cc", value: header("Cc") },
                { name: "Subject", value: header("Subject") },
                { name: "In-Reply-To", value: header("In-Reply-To") },
                { name: "References", value: header("References") },
              ],
            },
          },
        };
        drafts.set(id, draft);
        return res(200, draft);
      }
      if (method === "GET" && draftPath.endsWith("/drafts")) {
        return res(200, { drafts: [...drafts.values()].map((d) => ({ id: d.id })) });
      }
      const id = draftPath.split("/drafts/")[1] ?? "";
      const existing = drafts.get(id);
      if (!existing) return res(404, { error: "not found" });
      if (method === "GET") return res(200, existing);
      if (method === "PUT") {
        const raw = Buffer.from(body.message.raw, "base64url").toString("utf8");
        const header = (name: string) =>
          raw.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
        existing.message.payload.headers = [
          { name: "To", value: header("To") },
          { name: "Cc", value: header("Cc") },
          { name: "Subject", value: header("Subject") },
        ];
        existing.message.payload.body.data = Buffer.from(
          raw.split("\r\n\r\n")[1] ?? "",
        ).toString("base64url");
        return res(200, existing);
      }
      if (method === "DELETE") {
        drafts.delete(id);
        return res(200, {});
      }
    }
    if (url.includes("/gmail/v1/users/me/threads/")) {
      return res(200, {
        messages: [
          {
            id: "m1",
            threadId: "thread-justin",
            payload: {
              headers: [
                { name: "From", value: "Justin <justin@x.com>" },
                { name: "Subject", value: "Catch up" },
                { name: "Message-ID", value: "<m1@x.com>" },
              ],
            },
          },
        ],
      });
    }
    // --- Calendar ---
    if (url.includes("/calendar/v3/freeBusy")) {
      return res(200, {
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-08-11T16:00:00Z",
                end: "2026-08-11T18:00:00Z",
              },
            ],
          },
        },
      });
    }
    if (url.includes("/calendar/v3/calendars/")) {
      if (method === "POST" && url.includes("/events?")) {
        return res(200, { id: "new-evt-1", ...body, status: "confirmed" });
      }
      const path = url.split("/events/")[1];
      const eventId = path?.split("?")[0];
      const base = eventId === "shared-1" ? SHARED_EVENT : SOLO_EVENT;
      if (method === "GET") return res(200, structuredClone(base));
      if (method === "PATCH") return res(200, { ...structuredClone(base), ...body });
      if (method === "DELETE") return res(200, {});
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) satisfies FetchLike;
  return { calls, drafts, fetchImpl };
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

describe("gmail draft tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a reply draft with thread headers — and never sends", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("gmail_create_draft", {
          to: ["justin@x.com"],
          subject: "",
          body: "I'll call you tomorrow.",
          threadId: "thread-justin",
        }),
      ),
    );
    expect(out.draftId).toBe("draft-1");
    expect(out.threadId).toBe("thread-justin");
    expect(out.subject).toBe("Re: Catch up");
    const create = google.calls.find(
      (c) => c.method === "POST" && c.url.includes("/drafts"),
    )!;
    const raw = Buffer.from(create.body.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <m1@x.com>");
    expect(raw).toContain("To: justin@x.com");
    // No send endpoint was touched anywhere.
    expect(
      google.calls.some((c) => c.url.includes("/messages/send") || c.url.includes("/drafts/send")),
    ).toBe(false);
  });

  it("creates, lists, reads, updates, and deletes a draft", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const created = JSON.parse(
      String(
        await host.harness.callAgentTool("gmail_create_draft", {
          to: ["x@y.com"],
          subject: "Project Y",
          body: "Long detailed body about the project.",
        }),
      ),
    );
    expect(created.draftId).toBe("draft-1");

    const listed = JSON.parse(
      String(await host.harness.callAgentTool("gmail_list_drafts", {})),
    );
    expect(listed).toHaveLength(1);

    const read = JSON.parse(
      String(await host.harness.callAgentTool("gmail_read_draft", { draftId: "draft-1" })),
    );
    expect(read.body).toBe("Long detailed body about the project.");

    // "Make that draft shorter."
    const updated = JSON.parse(
      String(
        await host.harness.callAgentTool("gmail_update_draft", {
          draftId: "draft-1",
          body: "Short version.",
          reason: "make it shorter",
        }),
      ),
    );
    expect(updated.draftId).toBe("draft-1"); // same draft, not a new one
    expect(updated.to).toBe("x@y.com"); // untouched fields preserved
    expect(updated.subject).toBe("Project Y");
    const reread = JSON.parse(
      String(await host.harness.callAgentTool("gmail_read_draft", { draftId: "draft-1" })),
    );
    expect(reread.body).toBe("Short version.");

    const deleted = JSON.parse(
      String(await host.harness.callAgentTool("gmail_delete_draft", { draftId: "draft-1" })),
    );
    expect(deleted.deleted).toBe(true);
  });
});

describe("calendar write tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves a solo event directly, preserving its id and time zone", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_move_event", {
          eventId: "solo-1",
          start: { dateTime: "2026-08-10T16:00:00-07:00" },
          end: { dateTime: "2026-08-10T17:30:00-07:00" },
          reason: "run in the afternoon, 90-minute block",
        }),
      ),
    );
    expect(out.id).toBe("solo-1");
    const patch = google.calls.find(
      (c) => c.method === "PATCH" && c.url.includes("solo-1"),
    )!;
    expect(patch.url).toContain("sendUpdates=none");
    expect(patch.body.start.timeZone).toBe("America/Vancouver"); // preserved
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });

  it("creates a solo event directly and audits it", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const out = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_create_event", {
          summary: "Deep work",
          start: { dateTime: "2026-08-14T13:00:00-07:00", timeZone: "America/Vancouver" },
          end: { dateTime: "2026-08-14T17:00:00-07:00", timeZone: "America/Vancouver" },
          reason: "clear Friday afternoon for deep work",
        }),
      ),
    );
    expect(out.id).toBe("new-evt-1");
    expect(host.harness.pendingInteractions).toHaveLength(0);
    const audit = (await host.harness.callRpc("auditTrail", { limit: 10 })) as any;
    expect(audit.entries.some((e: any) => e.action === "calendar.create-event")).toBe(true);
  });

  it("creates an event with invitees only after explicit approval", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const pending = host.harness.callAgentTool("calendar_create_event", {
      summary: "Call with Sarah",
      start: { dateTime: "2026-08-12T10:00:00-07:00" },
      end: { dateTime: "2026-08-12T10:30:00-07:00" },
      attendees: ["sarah@y.com"],
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    // Nothing was created yet — approval is pending.
    expect(google.calls.some((c) => c.method === "POST" && c.url.includes("/events"))).toBe(false);
    const interaction = host.harness.pendingInteractions[0]!;
    expect(interaction.title).toContain("Call with Sarah");
    host.harness.submitInteraction(interaction.id, { approved: true });
    const out = JSON.parse(String(await pending));
    expect(out.id).toBe("new-evt-1");
    expect(out.inviteesNotified).toBe(true);
    const create = google.calls.find(
      (c) => c.method === "POST" && c.url.includes("/events"),
    )!;
    expect(create.url).toContain("sendUpdates=all");
  });

  it("declined approval leaves the shared meeting untouched", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const pending = host.harness.callAgentTool("calendar_move_event", {
      eventId: "shared-1",
      start: { dateTime: "2026-08-11T15:00:00-07:00" },
      end: { dateTime: "2026-08-11T15:30:00-07:00" },
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      approved: false,
    });
    const out = JSON.parse(String(await pending));
    expect(out.moved).toBe(false);
    expect(
      google.calls.some((c) => c.method === "PATCH" && c.url.includes("shared-1")),
    ).toBe(false);
    // The decline itself is audited.
    const audit = (await host.harness.callRpc("auditTrail", { limit: 10 })) as any;
    expect(
      audit.entries.some((e: any) => e.outcome.includes("declined by user")),
    ).toBe(true);
  });

  it("attendee add/remove always requires approval", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const pending = host.harness.callAgentTool("calendar_add_attendee", {
      eventId: "solo-1",
      email: "sarah@y.com",
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    expect(
      google.calls.some((c) => c.method === "PATCH"),
    ).toBe(false);
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      approved: true,
    });
    const out = JSON.parse(String(await pending));
    expect(out.attendeesNotified).toBe(true);
    const patch = google.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.attendees).toContainEqual({ email: "sarah@y.com" });
  });

  it("cancels a solo event directly but gates a shared cancellation", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const solo = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_cancel_event", {
          eventId: "solo-1",
        }),
      ),
    );
    expect(solo.cancelled).toBe(true);
    expect(host.harness.pendingInteractions).toHaveLength(0);

    const pending = host.harness.callAgentTool("calendar_cancel_event", {
      eventId: "shared-1",
    });
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      approved: true,
    });
    const out = JSON.parse(String(await pending));
    expect(out.cancelled).toBe(true);
    const del = google.calls.find(
      (c) => c.method === "DELETE" && c.url.includes("shared-1"),
    )!;
    expect(del.url).toContain("sendUpdates=all");
  });

  it("finds free time by merging busy intervals", async () => {
    const google = fakeGoogle();
    const host = await connectedHost(google.fetchImpl);
    const free = JSON.parse(
      String(
        await host.harness.callAgentTool("calendar_find_free_time", {
          timeMin: "2026-08-11T15:00:00Z",
          timeMax: "2026-08-11T23:00:00Z",
          durationMinutes: 120,
        }),
      ),
    );
    // Busy 16:00–18:00 → free 15:00–16:00 (1h, too short) and 18:00–23:00.
    expect(free).toEqual([
      { start: "2026-08-11T18:00:00.000Z", end: "2026-08-11T23:00:00.000Z" },
    ]);
  });

  it("detects a scope upgrade for older grants and reconnect reconsents", async () => {
    // Simulate a token granted before gmail.compose existed.
    const google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetchImpl);
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
    // Narrow scope on the stored grant (simulating a pre-drafts token).
    const narrowFetch: FetchLike = async (u, init) => {
      if (u.startsWith(GOOGLE_TOKEN_URL)) {
        return res(200, {
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
        });
      }
      if (u.startsWith(GMAIL_PROFILE_URL)) return res(200, { emailAddress: "me@example.com" });
      return google.fetchImpl(u, init);
    };
    await plugin(host.bb, { fetchImpl: narrowFetch });
    const { url } = (await host.harness.callRpc("beginAuth", null)) as any;
    const state = new URL(url).searchParams.get("state")!;
    await host.harness.fetchHttp("GET", `/oauth/callback?code=good&state=${state}`);
    const status = (await host.harness.callRpc("status", null)) as any;
    expect(status.scopeUpgradeRequired).toBe(true);
    expect(status.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
  });
});
