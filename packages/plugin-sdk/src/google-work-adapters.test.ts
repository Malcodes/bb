import { describe, expect, it } from "vitest";
import {
  executeGoogleWorkAction,
  pollGoogleWork,
  type GmailMessage,
  type GoogleCalendarEvent,
  type GoogleWorkTransport,
} from "./google-work-adapters.js";

const person = (email: string) => ({ email });
function message(
  overrides: Partial<GmailMessage> &
    Pick<
      GmailMessage,
      "id" | "threadId" | "internalDate" | "from" | "subject" | "text"
    >,
): GmailMessage {
  return {
    historyId: overrides.id,
    to: [person("me@example.com")],
    cc: [],
    labels: [],
    ...overrides,
  };
}

describe("Gmail and Google Calendar capability adapters", () => {
  it("maintains obligations and meeting context across several unattended hours", async () => {
    const replyThread = [
      message({
        id: "m1",
        threadId: "reply-thread",
        historyId: "101",
        internalDate: "2026-08-09T09:00:00Z",
        from: person("ada@acme.com"),
        subject: "Launch decision",
        text: "Could you review the launch plan and let me know by tomorrow?",
        labels: ["IMPORTANT"],
      }),
    ];
    const commitmentThread = [
      message({
        id: "m2",
        threadId: "commitment-thread",
        historyId: "102",
        internalDate: "2026-08-08T06:00:00Z",
        from: person("me@example.com"),
        to: [person("grace@example.org")],
        subject: "Follow-up materials",
        text: "I'll send the revised brief today.",
      }),
    ];
    const meeting: GoogleCalendarEvent = {
      id: "event-1",
      calendarId: "primary",
      updated: "2026-08-09T12:00:00Z",
      status: "confirmed",
      summary: "Acme launch review",
      description:
        "Decision: launch timing. Next step: confirm owner for rollout",
      start: "2026-08-09T15:00:00Z",
      end: "2026-08-09T15:30:00Z",
      organizer: person("ada@acme.com"),
      attendees: [
        { email: "me@example.com", responseStatus: "accepted" },
        { email: "ada@acme.com", responseStatus: "accepted" },
      ],
    };
    const calls: string[] = [];
    const transport: GoogleWorkTransport = {
      async readGmailChanges({ historyId }) {
        calls.push(`gmail:${historyId ?? "initial"}`);
        return historyId
          ? { messages: [], historyId: "103" }
          : {
              messages: [replyThread[0]!, commitmentThread[0]!],
              historyId: "102",
            };
      },
      async readGmailThread(threadId) {
        return threadId === "reply-thread" ? replyThread : commitmentThread;
      },
      async readCalendarChanges({ syncToken }) {
        calls.push(`calendar:${syncToken ?? "initial"}`);
        return syncToken
          ? { events: [], nextSyncToken: "cal-2" }
          : { events: [meeting], nextSyncToken: "cal-1" };
      },
      async sendGmailReply(input) {
        calls.push(`send:${input.idempotencyKey}:${input.body}`);
        return { messageId: "sent-1", threadId: input.threadId };
      },
      async updateCalendarEvent(input) {
        calls.push(`update:${input.idempotencyKey}:${input.eventId}`);
        return { eventId: input.eventId, updated: "2026-08-09T13:01:00Z" };
      },
    };

    const first = await pollGoogleWork({
      transport,
      cursor: { calendarSyncTokens: {} },
      gmailBindingId: "gmail-main",
      calendarBindingId: "calendar-main",
      calendarIds: ["primary"],
      userEmail: "me@example.com",
      now: new Date("2026-08-09T12:00:00Z"),
      unansweredHours: 24,
    });
    expect(first.evidence.map((item) => item.attention)).toEqual(
      expect.arrayContaining([
        "response-needed",
        "follow-up-overdue",
        "meeting-prep",
      ]),
    );
    const response = first.evidence.find(
      (item) => item.attention === "response-needed",
    );
    expect(response).toMatchObject({
      importance: "high",
      entityRefs: expect.arrayContaining([
        "person:ada@acme.com",
        "company-domain:acme.com",
      ]),
    });
    expect(response?.context.thread?.[0]?.text).toContain("launch plan");
    const prep = first.evidence.find(
      (item) => item.attention === "meeting-prep",
    );
    expect(prep?.context.commitments).toContain("confirm owner for rollout");
    expect(first.cursor).toMatchObject({
      gmailHistoryId: "102",
      calendarSyncTokens: { primary: "cal-1" },
    });

    const second = await pollGoogleWork({
      transport,
      cursor: first.cursor,
      gmailBindingId: "gmail-main",
      calendarBindingId: "calendar-main",
      calendarIds: ["primary"],
      userEmail: "me@example.com",
      now: new Date("2026-08-09T16:00:00Z"),
    });
    expect(second.evidence).toEqual([]);
    expect(calls).toContain("gmail:102");
    expect(calls).toContain("calendar:cal-1");

    const sent = await executeGoogleWorkAction({
      transport,
      actionType: "gmail.send-reply",
      idempotencyKey: "reply:reply-thread:v1",
      payload: {
        threadId: "reply-thread",
        inReplyToMessageId: "m1",
        to: JSON.stringify(["ada@acme.com"]),
        subject: "Re: Launch decision",
        body: "Reviewed. I support option B.",
      },
    });
    expect(sent).toEqual({
      outcome: "Gmail reply sent in thread reply-thread.",
      evidence: ["gmail-message:sent-1"],
    });
    expect(calls).toContain(
      "send:reply:reply-thread:v1:Reviewed. I support option B.",
    );
  });
});
