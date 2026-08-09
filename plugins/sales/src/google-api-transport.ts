import type {
  GmailMessage,
  GoogleCalendarEvent,
  GooglePerson,
  GoogleWorkTransport,
} from "@bb/plugin-sdk";

function decodeBase64Url(value: string): string {
  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}
function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
function people(value = ""): GooglePerson[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(part);
      return match
        ? {
            name: match[1]?.replace(/^"|"$/g, "").trim(),
            email: match[2]!.trim(),
          }
        : { email: part };
    });
}
function textFromPayload(payload: any): string {
  if (payload?.mimeType === "text/plain" && payload.body?.data)
    return decodeBase64Url(payload.body.data);
  const plain = payload?.parts?.find(
    (part: any) => part.mimeType === "text/plain",
  );
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = payload?.parts?.find(
    (part: any) => part.mimeType === "text/html",
  );
  return html?.body?.data
    ? decodeBase64Url(html.body.data)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}
function gmailMessage(raw: any): GmailMessage {
  const headers = new Map(
    (raw.payload?.headers ?? []).map((header: any) => [
      String(header.name).toLowerCase(),
      String(header.value),
    ]),
  );
  return {
    id: raw.id,
    threadId: raw.threadId,
    historyId: raw.historyId,
    internalDate: new Date(Number(raw.internalDate)).toISOString(),
    from: people(headers.get("from") as string)[0] ?? { email: "unknown" },
    to: people(headers.get("to") as string),
    cc: people(headers.get("cc") as string),
    subject: (headers.get("subject") as string) ?? "",
    text: textFromPayload(raw.payload),
    labels: raw.labelIds ?? [],
  };
}
class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API ${status}: ${detail}`);
  }
}

export class GoogleApiWorkTransport implements GoogleWorkTransport {
  constructor(
    private readonly accessToken: string,
    private readonly userEmail: string,
  ) {}
  private async request(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`https://www.googleapis.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok)
      throw new GoogleApiError(
        response.status,
        (await response.text()).slice(0, 500),
      );
    return response.status === 204 ? {} : response.json();
  }
  async readGmailChanges(input: { historyId?: string; since: string }) {
    const ids = new Set<string>();
    let historyId = input.historyId;
    const initial = async () => {
      let pageToken: string | undefined;
      do {
        const suffix = pageToken
          ? `&pageToken=${encodeURIComponent(pageToken)}`
          : "";
        const seconds = Math.floor(Date.parse(input.since) / 1000);
        const data = await this.request(
          `/gmail/v1/users/me/messages?q=${encodeURIComponent(`after:${seconds}`)}&maxResults=100${suffix}`,
        );
        for (const message of data.messages ?? []) ids.add(message.id);
        pageToken = data.nextPageToken;
      } while (pageToken && ids.size < 500);
    };
    if (input.historyId) {
      try {
        let pageToken: string | undefined;
        do {
          const suffix = pageToken
            ? `&pageToken=${encodeURIComponent(pageToken)}`
            : "";
          const data = await this.request(
            `/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(input.historyId)}&historyTypes=messageAdded&maxResults=100${suffix}`,
          );
          for (const row of data.history ?? [])
            for (const added of row.messagesAdded ?? [])
              if (added.message?.id) ids.add(added.message.id);
          historyId = data.historyId ?? historyId;
          pageToken = data.nextPageToken;
        } while (pageToken && ids.size < 500);
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 404)
          throw error;
        historyId = undefined;
        await initial();
      }
    } else await initial();
    const messages = await Promise.all(
      [...ids].map(async (id) =>
        gmailMessage(
          await this.request(`/gmail/v1/users/me/messages/${id}?format=full`),
        ),
      ),
    );
    historyId ??= messages
      .map((message) => message.historyId)
      .sort()
      .at(-1);
    return { messages, historyId };
  }
  async readGmailThread(threadId: string) {
    const data = await this.request(
      `/gmail/v1/users/me/threads/${threadId}?format=full`,
    );
    return (data.messages ?? []).map(gmailMessage);
  }
  async readCalendarChanges(input: {
    calendarId: string;
    syncToken?: string;
    timeMin: string;
    timeMax: string;
  }) {
    const query = input.syncToken
      ? `syncToken=${encodeURIComponent(input.syncToken)}`
      : `timeMin=${encodeURIComponent(input.timeMin)}&timeMax=${encodeURIComponent(input.timeMax)}&singleEvents=true&showDeleted=true`;
    let data: any;
    try {
      data = await this.request(
        `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?${query}&maxResults=2500`,
      );
    } catch (error) {
      if (
        !(error instanceof GoogleApiError) ||
        error.status !== 410 ||
        !input.syncToken
      )
        throw error;
      data = await this.request(
        `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?timeMin=${encodeURIComponent(input.timeMin)}&timeMax=${encodeURIComponent(input.timeMax)}&singleEvents=true&showDeleted=true&maxResults=2500`,
      );
    }
    const events: GoogleCalendarEvent[] = (data.items ?? []).map(
      (item: any) => ({
        id: item.id,
        calendarId: input.calendarId,
        updated: item.updated,
        status: item.status ?? "confirmed",
        summary: item.summary ?? "",
        description: item.description,
        location: item.location,
        start: item.start?.dateTime ?? item.start?.date,
        end: item.end?.dateTime ?? item.end?.date,
        organizer: item.organizer?.email
          ? { email: item.organizer.email, name: item.organizer.displayName }
          : undefined,
        attendees: (item.attendees ?? []).map((person: any) => ({
          email: person.email,
          name: person.displayName,
          responseStatus: person.responseStatus,
        })),
      }),
    );
    return { events, nextSyncToken: data.nextSyncToken };
  }
  async sendGmailReply(input: {
    threadId: string;
    inReplyToMessageId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    idempotencyKey: string;
  }) {
    const raw = [
      `From: ${this.userEmail}`,
      `To: ${input.to.join(", ")}`,
      ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
      `Subject: ${input.subject}`,
      `In-Reply-To: <${input.inReplyToMessageId}>`,
      `References: <${input.inReplyToMessageId}>`,
      `X-BB-Idempotency-Key: ${input.idempotencyKey}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body,
    ].join("\r\n");
    const result = await this.request("/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: JSON.stringify({
        threadId: input.threadId,
        raw: encodeBase64Url(raw),
      }),
    });
    return { messageId: result.id, threadId: result.threadId };
  }
  async updateCalendarEvent(input: {
    calendarId: string;
    eventId: string;
    patch: Record<string, string>;
    notifyAttendees: boolean;
    idempotencyKey: string;
  }) {
    const result = await this.request(
      `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?sendUpdates=${input.notifyAttendees ? "all" : "none"}`,
      {
        method: "PATCH",
        headers: { "x-bb-idempotency-key": input.idempotencyKey },
        body: JSON.stringify(input.patch),
      },
    );
    return { eventId: result.id, updated: result.updated };
  }
}
