/**
 * Read-only Gmail + Calendar agent tools.
 *
 * Every call vends a fresh short-lived access token from this connector's
 * own OAuth path (no second flow, no stored access token) and calls the
 * Google REST API directly. All mutations — sends, replies, event writes —
 * stay in the sales plugin's approval-gated action path and are not
 * reachable from these tools.
 */
import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";

export interface GoogleTokenProvider {
  (): Promise<{ token: string; expiresAt: string; email: string }>;
}

const MAX_RESULTS_CAP = 50;
const MAX_BODY_CHARS = 8_000;

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseAddressList(value = ""): Array<{ email: string; name?: string }> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(part);
      return match
        ? { name: match[1]?.replace(/^"|"$/g, "").trim(), email: match[2]!.trim() }
        : { email: part };
    });
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function bodyText(payload: any): string {
  if (payload?.mimeType === "text/plain" && payload.body?.data)
    return decodeBase64Url(payload.body.data);
  const plain = payload?.parts?.find((part: any) => part.mimeType === "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = payload?.parts?.find((part: any) => part.mimeType === "text/html");
  return html?.body?.data
    ? decodeBase64Url(html.body.data)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function toMessage(raw: any): Record<string, unknown> {
  const headers = raw.payload?.headers ?? [];
  const internalDate = new Date(Number(raw.internalDate ?? Date.now()));
  return {
    id: raw.id,
    threadId: raw.threadId,
    date: internalDate.toISOString(),
    from: parseAddressList(headerValue(headers, "From"))[0] ?? null,
    to: parseAddressList(headerValue(headers, "To")),
    subject: headerValue(headers, "Subject"),
    snippet: raw.snippet ?? "",
    labels: raw.labelIds ?? [],
  };
}

async function googleGet(
  accessToken: string,
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const query = new URLSearchParams(params);
  const response = await fetch(
    `https://www.googleapis.com${path}?${query.toString()}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Google API ${response.status}: ${detail}`);
  }
  return response.json();
}

function capMaxResults(value: number | undefined): number {
  return Math.min(Math.max(value ?? 10, 1), MAX_RESULTS_CAP);
}

export function registerGoogleReadTools(
  bb: BbPluginApi,
  getToken: GoogleTokenProvider,
): void {
  const withToken = async <T>(
    fn: (accessToken: string) => Promise<T>,
  ): Promise<string> => {
    const { token } = await getToken();
    return JSON.stringify(await fn(token));
  };

  bb.agents.registerTool({
    name: "gmail_list_recent",
    description:
      "List the most recent emails in the connected Gmail account (id, threadId, date, from, subject, snippet, labels). Read-only.",
    parameters: z
      .object({
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      return withToken(async (token) => {
        const list = await googleGet(token, "/gmail/v1/users/me/messages", {
          maxResults: String(capMaxResults(input.maxResults)),
        });
        const ids = (list.messages ?? []).map((m: any) => m.id as string);
        const messages = await Promise.all(
          ids.map((id: string) =>
            googleGet(token, `/gmail/v1/users/me/messages/${id}`, {
              format: "full",
            }),
          ),
        );
        return messages.map(toMessage);
      });
    },
  });

  bb.agents.registerTool({
    name: "gmail_search",
    description:
      "Search Gmail with Gmail query syntax (e.g. from:ada@acme.com subject:launch newer_than:7d). Returns matching messages with id, threadId, date, from, subject, snippet. Read-only.",
    parameters: z
      .object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      return withToken(async (token) => {
        const list = await googleGet(token, "/gmail/v1/users/me/messages", {
          q: input.query,
          maxResults: String(capMaxResults(input.maxResults)),
        });
        const ids = (list.messages ?? []).map((m: any) => m.id as string);
        const messages = await Promise.all(
          ids.map((id: string) =>
            googleGet(token, `/gmail/v1/users/me/messages/${id}`, {
              format: "full",
            }),
          ),
        );
        return messages.map(toMessage);
      });
    },
  });

  bb.agents.registerTool({
    name: "gmail_read_thread",
    description:
      "Read a full Gmail thread: every message with from/to/date/subject and plain-text body. Use a threadId from gmail_list_recent or gmail_search. Read-only.",
    parameters: z
      .object({
        threadId: z.string().min(1),
        maxBodyChars: z.number().int().min(500).max(MAX_BODY_CHARS).default(4_000),
      })
      .strict(),
    async execute(input) {
      return withToken(async (token) => {
        const thread = await googleGet(
          token,
          `/gmail/v1/users/me/threads/${input.threadId}`,
          { format: "full" },
        );
        return (thread.messages ?? []).map((raw: any) => ({
          ...toMessage(raw),
          body: clip(bodyText(raw.payload), input.maxBodyChars),
        }));
      });
    },
  });

  bb.agents.registerTool({
    name: "calendar_list_events",
    description:
      "List events on a Google Calendar within a time range (defaults: now → +7 days). Returns id, summary, start, end, location, status, organizer, attendees. Read-only.",
    parameters: z
      .object({
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        calendarId: z.string().min(1).default("primary"),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      return withToken(async (token) => {
        const now = new Date();
        const timeMin = input.timeMin ?? now.toISOString();
        const timeMax =
          input.timeMax ??
          new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
        const data = await googleGet(
          token,
          `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
          {
            timeMin,
            timeMax,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(capMaxResults(input.maxResults)),
          },
        );
        return (data.items ?? []).map((item: any) => ({
          id: item.id,
          summary: item.summary ?? "",
          start: item.start?.dateTime ?? item.start?.date,
          end: item.end?.dateTime ?? item.end?.date,
          location: item.location,
          status: item.status,
          organizer: item.organizer?.email,
          attendees: (item.attendees ?? []).map((a: any) => ({
            email: a.email,
            responseStatus: a.responseStatus,
          })),
        }));
      });
    },
  });

  bb.agents.registerTool({
    name: "calendar_search_events",
    description:
      "Free-text search across Google Calendar events (matches summary, description, location, attendees). Optional time bounds. Read-only.",
    parameters: z
      .object({
        query: z.string().min(1),
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        calendarId: z.string().min(1).default("primary"),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      return withToken(async (token) => {
        const params: Record<string, string> = {
          q: input.query,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(capMaxResults(input.maxResults)),
        };
        if (input.timeMin) params.timeMin = input.timeMin;
        if (input.timeMax) params.timeMax = input.timeMax;
        const data = await googleGet(
          token,
          `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
          params,
        );
        return (data.items ?? []).map((item: any) => ({
          id: item.id,
          summary: item.summary ?? "",
          start: item.start?.dateTime ?? item.start?.date,
          end: item.end?.dateTime ?? item.end?.date,
          location: item.location,
          status: item.status,
        }));
      });
    },
  });

  // Expose the read tools to every thread. Mutations are intentionally not
  // here: sends/replies/event writes stay in the sales approval path.
  bb.agents.configure(() => ({
    tools: [
      "gmail_list_recent",
      "gmail_search",
      "gmail_read_thread",
      "calendar_list_events",
      "calendar_search_events",
    ],
    skills: [],
  }));
}
