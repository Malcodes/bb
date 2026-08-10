/**
 * Gmail draft agent tools. Drafts are prepared content — create, read,
 * update, list, delete are direct actions. Sending is NOT here and never
 * will be: the Gmail drafts API cannot send, and sends stay in the sales
 * approval-gated path.
 */
import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { googleApi } from "./google-api.js";
import type { GoogleTokenProvider } from "./read-tools.js";
import type { AuditLog } from "./audit.js";

const MAX_RESULTS_CAP = 50;

function headerValue(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8");
}

function buildRfc822(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function toDraftSummary(raw: any): Record<string, unknown> {
  const headers = raw.message?.payload?.headers ?? [];
  return {
    draftId: raw.id,
    messageId: raw.message?.id,
    threadId: raw.message?.threadId,
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    subject: headerValue(headers, "Subject"),
    snippet: raw.message?.snippet ?? "",
    updated: raw.message?.internalDate
      ? new Date(Number(raw.message.internalDate)).toISOString()
      : undefined,
  };
}

export function registerGmailDraftTools(
  bb: BbPluginApi,
  getToken: GoogleTokenProvider,
  audit: AuditLog,
  now: () => Date,
): void {
  const auditRecord = (entry: {
    action: string;
    target: string;
    reason: string;
    outcome: string;
  }) => audit.record(now().toISOString(), entry);

  bb.agents.registerTool({
    name: "gmail_create_draft",
    description:
      "Create a Gmail draft (never sends). For a reply draft, pass threadId; the reply headers are derived from the thread's latest message. The draft appears in Gmail for the user to review and send.",
    parameters: z
      .object({
        to: z.array(z.string().min(1)).min(1),
        cc: z.array(z.string().min(1)).optional(),
        bcc: z.array(z.string().min(1)).optional(),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().min(1).optional(),
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input) {
      const { token } = await getToken();
      let inReplyTo: string | undefined;
      let references: string | undefined;
      let subject = input.subject;
      if (input.threadId) {
        const thread = await googleApi.getWithQuery(
          token,
          `/gmail/v1/users/me/threads/${input.threadId}`,
          { format: "full" },
        );
        const messages = thread.messages ?? [];
        const last = messages.at(-1);
        const headers = last?.payload?.headers ?? [];
        const messageId = headerValue(headers, "Message-ID");
        const priorReferences = headerValue(headers, "References");
        if (messageId) {
          inReplyTo = messageId;
          references = priorReferences
            ? `${priorReferences} ${messageId}`
            : messageId;
        }
        if (!subject.trim()) {
          const threadSubject = headerValue(headers, "Subject");
          subject = threadSubject.startsWith("Re:")
            ? threadSubject
            : `Re: ${threadSubject}`;
        }
      }
      const raw = buildRfc822({ ...input, subject, inReplyTo, references });
      const created = await googleApi.post(token, "/gmail/v1/users/me/drafts", {
        message: {
          raw,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
      auditRecord({
        action: "gmail.create-draft",
        target: `draft:${created.id}`,
        reason:
          input.reason ??
          (input.threadId ? `reply draft in thread ${input.threadId}` : "new draft"),
        outcome: `created draft for ${input.to.join(", ")} — "${subject}"`,
      });
      return JSON.stringify(toDraftSummary(created));
    },
  });

  bb.agents.registerTool({
    name: "gmail_update_draft",
    description:
      "Replace the content of an existing Gmail draft (to/cc/bcc/subject/body). Pass only the fields to change; omitted fields keep their current values. Never sends.",
    parameters: z
      .object({
        draftId: z.string().min(1),
        to: z.array(z.string().min(1)).optional(),
        cc: z.array(z.string().min(1)).optional(),
        bcc: z.array(z.string().min(1)).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input) {
      const { token } = await getToken();
      const existing = await googleApi.getWithQuery(
        token,
        `/gmail/v1/users/me/drafts/${input.draftId}`,
        { format: "full" },
      );
      const headers = existing.message?.payload?.headers ?? [];
      const readList = (name: string): string[] =>
        headerValue(headers, name)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      const payload = existing.message?.payload;
      const existingBody =
        payload?.mimeType === "text/plain" && payload.body?.data
          ? decodeBase64Url(payload.body.data)
          : "";
      const merged = {
        to: input.to ?? readList("To"),
        cc: input.cc ?? readList("Cc"),
        bcc: input.bcc ?? readList("Bcc"),
        subject: input.subject ?? headerValue(headers, "Subject"),
        body: input.body ?? existingBody,
        inReplyTo: headerValue(headers, "In-Reply-To") || undefined,
        references: headerValue(headers, "References") || undefined,
      };
      const raw = buildRfc822(merged);
      const updated = await googleApi.put(
        token,
        `/gmail/v1/users/me/drafts/${input.draftId}`,
        {
          message: {
            raw,
            ...(existing.message?.threadId
              ? { threadId: existing.message.threadId }
              : {}),
          },
        },
      );
      auditRecord({
        action: "gmail.update-draft",
        target: `draft:${input.draftId}`,
        reason: input.reason ?? "draft edit",
        outcome: `updated fields: ${Object.keys(input)
          .filter((k) => !["draftId", "reason"].includes(k))
          .join(", ")}`,
      });
      return JSON.stringify(toDraftSummary(updated));
    },
  });

  bb.agents.registerTool({
    name: "gmail_list_drafts",
    description: "List Gmail drafts (draftId, to, subject, snippet, updated). Read-only.",
    parameters: z
      .object({
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      const { token } = await getToken();
      const list = await googleApi.getWithQuery(token, "/gmail/v1/users/me/drafts", {
        maxResults: String(Math.min(input.maxResults, MAX_RESULTS_CAP)),
      });
      const drafts = await Promise.all(
        (list.drafts ?? []).map((d: any) =>
          googleApi.getWithQuery(token, `/gmail/v1/users/me/drafts/${d.id}`, {
            format: "full",
          }),
        ),
      );
      return JSON.stringify(drafts.map(toDraftSummary));
    },
  });

  bb.agents.registerTool({
    name: "gmail_read_draft",
    description: "Read one Gmail draft in full, including the body. Read-only.",
    parameters: z.object({ draftId: z.string().min(1) }).strict(),
    async execute(input) {
      const { token } = await getToken();
      const draft = await googleApi.getWithQuery(
        token,
        `/gmail/v1/users/me/drafts/${input.draftId}`,
        { format: "full" },
      );
      const payload = draft.message?.payload;
      const body =
        payload?.mimeType === "text/plain" && payload.body?.data
          ? decodeBase64Url(payload.body.data)
          : "";
      return JSON.stringify({ ...toDraftSummary(draft), body });
    },
  });

  bb.agents.registerTool({
    name: "gmail_delete_draft",
    description:
      "Delete a Gmail draft. Deleting a draft discards prepared content; it never sends anything.",
    parameters: z
      .object({
        draftId: z.string().min(1),
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input) {
      const { token } = await getToken();
      await googleApi.delete(token, `/gmail/v1/users/me/drafts/${input.draftId}`);
      auditRecord({
        action: "gmail.delete-draft",
        target: `draft:${input.draftId}`,
        reason: input.reason ?? "draft discarded",
        outcome: "deleted",
      });
      return JSON.stringify({ deleted: true, draftId: input.draftId });
    },
  });
}
