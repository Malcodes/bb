/** Concrete Gmail + Google Calendar capability adapters for generated operations. */
export type GooglePerson = { email: string; name?: string };
export type GmailMessage = {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  from: GooglePerson;
  to: GooglePerson[];
  cc: GooglePerson[];
  subject: string;
  text: string;
  labels: string[];
};
export type GoogleCalendarEvent = {
  id: string;
  calendarId: string;
  updated: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  organizer?: GooglePerson;
  attendees: Array<GooglePerson & { responseStatus?: string }>;
};
export type GoogleWorkCursor = {
  gmailHistoryId?: string;
  calendarSyncTokens: Record<string, string>;
  lastSuccessfulPollAt?: string;
};
export type GoogleWorkEvidence = {
  source: "gmail" | "google-calendar";
  sourceBindingId: string;
  fingerprint: string;
  observedAt: string;
  title: string;
  summary: string;
  evidence: string[];
  entityRefs: string[];
  workstreamHints: string[];
  importance: "low" | "normal" | "high";
  attention:
    | "none"
    | "response-needed"
    | "follow-up-overdue"
    | "meeting-prep"
    | "commitment"
    | "scheduling-decision";
  context: {
    thread?: GmailMessage[];
    event?: GoogleCalendarEvent;
    commitments: string[];
    suggestedAction?: string;
  };
};
export interface GoogleWorkTransport {
  readGmailChanges(input: {
    historyId?: string;
    since: string;
  }): Promise<{ messages: GmailMessage[]; historyId?: string }>;
  readGmailThread(threadId: string): Promise<GmailMessage[]>;
  readCalendarChanges(input: {
    calendarId: string;
    syncToken?: string;
    timeMin: string;
    timeMax: string;
  }): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken?: string }>;
  sendGmailReply(input: {
    threadId: string;
    inReplyToMessageId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string; threadId: string }>;
  updateCalendarEvent(input: {
    calendarId: string;
    eventId: string;
    patch: Record<string, string>;
    notifyAttendees: boolean;
    idempotencyKey: string;
  }): Promise<{ eventId: string; updated: string }>;
}
const commitmentPatterns = [
  /\b(?:i|we)'?ll\s+([^.!?\n]+)/gi,
  /\b(?:i|we) will\s+([^.!?\n]+)/gi,
  /\b(?:action|next step|todo|follow[- ]up)\s*[:\-]\s*([^.!?\n]+)/gi,
];
export function extractCommitments(text: string): string[] {
  const values = new Set<string>();
  for (const pattern of commitmentPatterns)
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value && value.length >= 3) values.add(value.slice(0, 300));
    }
  return [...values].slice(0, 20);
}
const personRef = (email: string) => `person:${email.trim().toLowerCase()}`;
const companyRef = (email: string) =>
  email.includes("@")
    ? `company-domain:${email.split("@")[1]!.toLowerCase()}`
    : null;
function responseNeeded(message: GmailMessage, userEmail: string): boolean {
  if (message.from.email.toLowerCase() === userEmail.toLowerCase())
    return false;
  if (
    /no[-_.]?reply|notifications?@|mailer-daemon/i.test(message.from.email) ||
    message.labels.includes("CATEGORY_PROMOTIONS")
  )
    return false;
  return /\?|\b(?:please|could you|can you|would you|let me know|your thoughts|confirm|review|approve|respond|reply)\b/i.test(
    message.text,
  );
}
function important(message: GmailMessage): boolean {
  return (
    message.labels.some(
      (label) => label === "IMPORTANT" || label === "STARRED",
    ) ||
    /\b(?:urgent|deadline|approval|decision|required|commitment)\b/i.test(
      `${message.subject} ${message.text}`,
    )
  );
}
function overdue(
  thread: GmailMessage[],
  userEmail: string,
  now: number,
  threshold: number,
): boolean {
  const latest = [...thread].sort(
    (a, b) => Date.parse(b.internalDate) - Date.parse(a.internalDate),
  )[0];
  return Boolean(
    latest &&
    latest.from.email.toLowerCase() === userEmail.toLowerCase() &&
    now - Date.parse(latest.internalDate) >= threshold &&
    extractCommitments(latest.text).length,
  );
}
export async function pollGoogleWork(input: {
  transport: GoogleWorkTransport;
  cursor: GoogleWorkCursor;
  gmailBindingId: string;
  calendarBindingId: string;
  calendarIds: string[];
  userEmail: string;
  now?: Date;
  lookbackHours?: number;
  lookaheadHours?: number;
  unansweredHours?: number;
}): Promise<{ cursor: GoogleWorkCursor; evidence: GoogleWorkEvidence[] }> {
  const now = input.now ?? new Date();
  const gmail = await input.transport.readGmailChanges({
    historyId: input.cursor.gmailHistoryId,
    since: new Date(
      now.getTime() - (input.lookbackHours ?? 24) * 3_600_000,
    ).toISOString(),
  });
  const evidence: GoogleWorkEvidence[] = [];
  const threads = new Set<string>();
  for (const changed of gmail.messages) {
    if (threads.has(changed.threadId)) continue;
    threads.add(changed.threadId);
    const thread = await input.transport.readGmailThread(changed.threadId);
    const latest =
      [...thread].sort(
        (a, b) => Date.parse(b.internalDate) - Date.parse(a.internalDate),
      )[0] ?? changed;
    const commitments = [
      ...new Set(thread.flatMap((message) => extractCommitments(message.text))),
    ];
    const isOverdue = overdue(
      thread,
      input.userEmail,
      now.getTime(),
      (input.unansweredHours ?? 24) * 3_600_000,
    );
    const needsResponse = responseNeeded(latest, input.userEmail);
    const emails = new Set(
      thread.flatMap((message) => [
        message.from.email,
        ...message.to.map((p) => p.email),
        ...message.cc.map((p) => p.email),
      ]),
    );
    const entityRefs = [...emails]
      .flatMap((email) => [personRef(email), companyRef(email)])
      .filter((ref): ref is string => Boolean(ref));
    evidence.push({
      source: "gmail",
      sourceBindingId: input.gmailBindingId,
      fingerprint: `gmail-thread:${latest.threadId}:${latest.historyId}`,
      observedAt: latest.internalDate,
      title: latest.subject || "Email thread",
      summary: latest.text.slice(0, 1000),
      evidence: thread.map((message) => `gmail-message:${message.id}`),
      entityRefs: [...new Set(entityRefs)],
      workstreamHints: [latest.subject, ...commitments],
      importance: important(latest)
        ? "high"
        : needsResponse || isOverdue
          ? "normal"
          : "low",
      attention: isOverdue
        ? "follow-up-overdue"
        : needsResponse
          ? "response-needed"
          : commitments.length
            ? "commitment"
            : "none",
      context: {
        thread,
        commitments,
        suggestedAction: isOverdue
          ? "Prepare a follow-up for the outstanding commitment."
          : needsResponse
            ? "Draft a reply using the complete thread history."
            : undefined,
      },
    });
  }
  const calendarSyncTokens = { ...input.cursor.calendarSyncTokens };
  for (const calendarId of input.calendarIds) {
    const result = await input.transport.readCalendarChanges({
      calendarId,
      syncToken: input.cursor.calendarSyncTokens[calendarId],
      timeMin: new Date(now.getTime() - 3_600_000).toISOString(),
      timeMax: new Date(
        now.getTime() + (input.lookaheadHours ?? 36) * 3_600_000,
      ).toISOString(),
    });
    if (result.nextSyncToken)
      calendarSyncTokens[calendarId] = result.nextSyncToken;
    for (const event of result.events) {
      if (event.status === "cancelled") continue;
      const commitments = extractCommitments(event.description ?? "");
      const emails = [
        event.organizer?.email,
        ...event.attendees.map((p) => p.email),
      ].filter((email): email is string => Boolean(email));
      const entityRefs = emails
        .flatMap((email) => [personRef(email), companyRef(email)])
        .filter((ref): ref is string => Boolean(ref));
      const startsIn = Date.parse(event.start) - now.getTime();
      const pending = event.attendees.some(
        (attendee) => attendee.responseStatus === "needsAction",
      );
      const attention =
        startsIn >= 0 && startsIn <= 24 * 3_600_000
          ? "meeting-prep"
          : pending
            ? "scheduling-decision"
            : commitments.length
              ? "commitment"
              : "none";
      evidence.push({
        source: "google-calendar",
        sourceBindingId: input.calendarBindingId,
        fingerprint: `gcal-event:${calendarId}:${event.id}:${event.updated}`,
        observedAt: event.updated,
        title: event.summary || "Calendar event",
        summary: [event.start, event.end, event.location, event.description]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
        evidence: [`gcal-event:${calendarId}:${event.id}`],
        entityRefs: [...new Set(entityRefs)],
        workstreamHints: [event.summary, ...commitments],
        importance: attention === "meeting-prep" ? "high" : "normal",
        attention,
        context: {
          event,
          commitments,
          suggestedAction:
            attention === "meeting-prep"
              ? "Prepare a concise meeting brief from entity history, commitments, and recent signals."
              : attention === "scheduling-decision"
                ? "Prepare a scheduling adjustment for review."
                : undefined,
        },
      });
    }
  }
  evidence.sort(
    (a, b) =>
      ({ high: 2, normal: 1, low: 0 })[b.importance] -
        { high: 2, normal: 1, low: 0 }[a.importance] ||
      Date.parse(b.observedAt) - Date.parse(a.observedAt),
  );
  return {
    cursor: {
      gmailHistoryId: gmail.historyId ?? input.cursor.gmailHistoryId,
      calendarSyncTokens,
      lastSuccessfulPollAt: now.toISOString(),
    },
    evidence,
  };
}
export async function executeGoogleWorkAction(input: {
  transport: GoogleWorkTransport;
  actionType: string;
  idempotencyKey: string;
  payload: Record<string, string>;
}): Promise<{ outcome: string; evidence: string[] }> {
  if (input.actionType === "gmail.send-reply") {
    const result = await input.transport.sendGmailReply({
      threadId: input.payload.threadId ?? "",
      inReplyToMessageId: input.payload.inReplyToMessageId ?? "",
      to: JSON.parse(input.payload.to ?? "[]") as string[],
      cc: JSON.parse(input.payload.cc ?? "[]") as string[],
      subject: input.payload.subject ?? "",
      body: input.payload.body ?? "",
      idempotencyKey: input.idempotencyKey,
    });
    return {
      outcome: `Gmail reply sent in thread ${result.threadId}.`,
      evidence: [`gmail-message:${result.messageId}`],
    };
  }
  if (input.actionType === "google-calendar.update-event") {
    const result = await input.transport.updateCalendarEvent({
      calendarId: input.payload.calendarId ?? "primary",
      eventId: input.payload.eventId ?? "",
      patch: JSON.parse(input.payload.patch ?? "{}") as Record<string, string>,
      notifyAttendees: input.payload.notifyAttendees === "true",
      idempotencyKey: input.idempotencyKey,
    });
    return {
      outcome: `Calendar event ${result.eventId} updated.`,
      evidence: [
        `gcal-event:${input.payload.calendarId ?? "primary"}:${result.eventId}:${result.updated}`,
      ],
    };
  }
  throw new Error(`Unsupported Google work action type: ${input.actionType}`);
}
