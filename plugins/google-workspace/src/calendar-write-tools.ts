/**
 * Google Calendar write agent tools with the solo/shared safety split:
 *
 * - Events with no other attendees (personal blocks, solo appointments) may
 *   be created, edited, moved, resized, and cancelled directly — with an
 *   audit-trail entry for every change.
 * - Anything affecting another person — invites, attendee changes,
 *   cancellations, notifications, material rescheduling of a shared meeting
 *   — is executed ONLY after an explicit human approval via
 *   bb.ui.requestInput (approved → executed with Google notifications;
 *   declined/timeout → nothing happens).
 *
 * All writes preserve the existing event id (PATCH/DELETE on it; moves
 * update start/end in place — never delete+recreate).
 */
import { z } from "zod";
import type { BbPluginApi, JsonValue, PluginAgentToolContext } from "@bb/plugin-sdk";
import { googleApi } from "./google-api.js";
import type { GoogleTokenProvider } from "./read-tools.js";
import type { AuditLog } from "./audit.js";

const MAX_RESULTS_CAP = 50;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export const CALENDAR_APPROVAL_RENDERER_ID = "calendar-change-approval";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toEvent(raw: any): Record<string, unknown> {
  return {
    id: raw.id,
    calendarId: raw.organizer?.email ? undefined : undefined, // caller-known
    summary: raw.summary ?? "",
    description: clip(raw.description ?? "", 2_000) || undefined,
    location: raw.location,
    status: raw.status,
    start: raw.start,
    end: raw.end,
    recurrence: raw.recurrence,
    recurringEventId: raw.recurringEventId,
    organizer: raw.organizer?.email
      ? { email: raw.organizer.email, self: raw.organizer.self === true }
      : undefined,
    attendees: (raw.attendees ?? []).map((a: any) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
    htmlLink: raw.htmlLink,
  };
}

/** True when the event involves nobody but the account owner. */
function isSoloEvent(raw: any, userEmail: string): boolean {
  const attendees = (raw.attendees ?? []).filter((a: any) => a?.email);
  if (attendees.length === 0) return true;
  const self = userEmail.toLowerCase();
  return attendees.every(
    (a: any) =>
      a.self === true || String(a.email).toLowerCase() === self,
  );
}

function isAllDay(raw: any): boolean {
  return Boolean(raw.start?.date && !raw.start?.dateTime);
}

export function registerCalendarWriteTools(
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

  const eventPath = (calendarId: string, eventId: string) =>
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  async function getEvent(token: string, calendarId: string, eventId: string) {
    return googleApi.get(token, eventPath(calendarId, eventId));
  }

  /**
   * Gate a person-affecting change behind explicit human approval, then
   * execute it with Google notifications on approval.
   */
  async function requireApproval<T>(input: {
    ctx: PluginAgentToolContext;
    title: string;
    payload: JsonValue;
    auditAction: string;
    auditTarget: string;
    reason: string;
    execute: () => Promise<T>;
    describe: () => string;
  }): Promise<{ result?: T; approved: boolean; note: string }> {
    const interaction = await bb.ui.requestInput(
      {
        threadId: input.ctx.threadId,
        rendererId: CALENDAR_APPROVAL_RENDERER_ID,
        title: input.title,
        payload: input.payload,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
      { signal: input.ctx.signal },
    );
    const value =
      interaction.outcome === "submitted"
        ? (interaction.value as { approved?: boolean; note?: string } | null)
        : null;
    const approved = value?.approved === true;
    const note = value?.note ?? "";
    if (!approved) {
      auditRecord({
        action: input.auditAction,
        target: input.auditTarget,
        reason: input.reason,
        outcome: `NOT executed — ${
          interaction.outcome === "submitted"
            ? "declined by user"
            : `approval ${interaction.outcome}`
        }`,
      });
      return { approved: false, note };
    }
    const result = await input.execute();
    auditRecord({
      action: input.auditAction,
      target: input.auditTarget,
      reason: input.reason,
      outcome: `approved (${note || "no note"}) — ${input.describe()}`,
    });
    return { result, approved: true, note };
  }

  /** True when a patch to a shared event materially affects other people. */
  function sharedMaterialChange(raw: any, patch: Record<string, unknown>): boolean {
    if (patch.attendees !== undefined) return true;
    if (patch.start !== undefined || patch.end !== undefined) {
      const oldStart = JSON.stringify(raw.start ?? null);
      const newStart = JSON.stringify(patch.start ?? null);
      const oldEnd = JSON.stringify(raw.end ?? null);
      const newEnd = JSON.stringify(patch.end ?? null);
      if (oldStart !== newStart || oldEnd !== newEnd) return true;
    }
    if (patch.summary !== undefined && patch.summary !== raw.summary) return true;
    if (patch.location !== undefined && patch.location !== raw.location) return true;
    return false;
  }

  const timeBlock = z.object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  });

  const patchSchema = z
    .object({
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: timeBlock.optional(),
      end: timeBlock.optional(),
      recurrence: z.array(z.string()).optional(),
    })
    .strict();

  bb.agents.registerTool({
    name: "calendar_create_event",
    description:
      "Create a calendar event. Events with no other attendees are created directly. Inviting other people requires explicit user approval first — invitations are never sent without it. Preserves time zones and supports all-day and recurring (RRULE) events.",
    parameters: z
      .object({
        calendarId: z.string().min(1).default("primary"),
        summary: z.string().min(1),
        description: z.string().optional(),
        location: z.string().optional(),
        start: timeBlock,
        end: timeBlock,
        attendees: z.array(z.string().min(1)).optional(),
        recurrence: z.array(z.string()).optional(),
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input, ctx) {
      const { token } = await getToken();
      const invitees = input.attendees ?? [];
      const body: Record<string, unknown> = {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        recurrence: input.recurrence,
        ...(invitees.length
          ? { attendees: invitees.map((email) => ({ email })) }
          : {}),
      };
      const create = (sendUpdates: "all" | "none") =>
        googleApi.post(
          token,
          `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=${sendUpdates}`,
          body,
        );
      if (invitees.length === 0) {
        const created = await create("none");
        auditRecord({
          action: "calendar.create-event",
          target: `event:${input.calendarId}:${created.id}`,
          reason: input.reason ?? "personal event",
          outcome: `created solo event "${input.summary}"`,
        });
        return JSON.stringify(toEvent(created));
      }
      const outcome = await requireApproval({
        ctx,
        title: `Create "${input.summary}" and invite ${invitees.join(", ")}?`,
        payload: {
          kind: "calendar.create-with-invitees",
          summary: input.summary,
          start: input.start,
          end: input.end,
          invitees,
          reason: input.reason ?? "",
        },
        auditAction: "calendar.create-event",
        auditTarget: `event:${input.calendarId}:new`,
        reason: input.reason ?? "shared event",
        execute: () => create("all"),
        describe: () => `created "${input.summary}" and notified ${invitees.join(", ")}`,
      });
      if (!outcome.approved) {
        return JSON.stringify({
          created: false,
          reason: "invitation requires user approval; not created",
        });
      }
      return JSON.stringify({ ...toEvent(outcome.result), inviteesNotified: true });
    },
  });

  bb.agents.registerTool({
    name: "calendar_update_event",
    description:
      "Update an existing event in place (same event id — never creates a duplicate). Solo events (no other attendees) update directly, including moves. Changes affecting other attendees (material reschedule, summary/location changes) require user approval before anyone is notified.",
    parameters: z
      .object({
        eventId: z.string().min(1),
        calendarId: z.string().min(1).default("primary"),
        patch: patchSchema,
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input, ctx) {
      const { token, email } = await getToken();
      const raw = await getEvent(token, input.calendarId, input.eventId);
      const patch = input.patch as Record<string, unknown>;
      const solo = isSoloEvent(raw, email);
      const apply = (sendUpdates: "all" | "none") =>
        googleApi.patchWithQuery(
          token,
          eventPath(input.calendarId, input.eventId),
          patch,
          { sendUpdates },
        );
      if (solo) {
        const updated = await apply("none");
        auditRecord({
          action: "calendar.update-event",
          target: `event:${input.calendarId}:${input.eventId}`,
          reason: input.reason ?? "solo event update",
          outcome: `updated solo event fields: ${Object.keys(patch).join(", ")}`,
        });
        return JSON.stringify(toEvent(updated));
      }
      if (!sharedMaterialChange(raw, patch)) {
        // Non-material shared edits (e.g. private description notes).
        const updated = await apply("none");
        auditRecord({
          action: "calendar.update-event",
          target: `event:${input.calendarId}:${input.eventId}`,
          reason: input.reason ?? "non-material shared event note",
          outcome: `updated without notifications: ${Object.keys(patch).join(", ")}`,
        });
        return JSON.stringify(toEvent(updated));
      }
      const outcome = await requireApproval({
        ctx,
        title: `Update shared event "${raw.summary ?? input.eventId}" and notify attendees?`,
        payload: {
          kind: "calendar.update-shared",
          eventId: input.eventId,
          summary: raw.summary,
          currentStart: raw.start,
          currentEnd: raw.end,
          patch: patch as JsonValue,
          attendees: (raw.attendees ?? []).map((a: any) => a.email),
          reason: input.reason ?? "",
        },
        auditAction: "calendar.update-event",
        auditTarget: `event:${input.calendarId}:${input.eventId}`,
        reason: input.reason ?? "shared event change",
        execute: () => apply("all"),
        describe: () =>
          `updated shared event and notified attendees: ${Object.keys(patch).join(", ")}`,
      });
      if (!outcome.approved) {
        return JSON.stringify({
          updated: false,
          reason: "shared-event change requires user approval; not applied",
        });
      }
      return JSON.stringify({ ...toEvent(outcome.result), attendeesNotified: true });
    },
  });

  bb.agents.registerTool({
    name: "calendar_move_event",
    description:
      "Move/resize an event to a new start/end (updates the existing event — same id). Solo events move directly. Moving a shared meeting requires user approval before attendees are notified. Respects time zones and all-day events (pass date-only blocks for all-day).",
    parameters: z
      .object({
        eventId: z.string().min(1),
        calendarId: z.string().min(1).default("primary"),
        start: timeBlock,
        end: timeBlock,
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input, ctx) {
      const { token, email } = await getToken();
      const raw = await getEvent(token, input.calendarId, input.eventId);
      const patch: Record<string, unknown> = {};
      // Preserve the event's timeZone when the caller didn't supply one.
      patch.start = {
        ...input.start,
        ...(input.start.dateTime && !input.start.timeZone && raw.start?.timeZone
          ? { timeZone: raw.start.timeZone }
          : {}),
      };
      patch.end = {
        ...input.end,
        ...(input.end.dateTime && !input.end.timeZone && raw.end?.timeZone
          ? { timeZone: raw.end.timeZone }
          : {}),
      };
      if (isAllDay(raw) && (input.start.dateTime || input.end.dateTime)) {
        throw new Error(
          "This is an all-day event; pass date-only start/end blocks to move it.",
        );
      }
      const solo = isSoloEvent(raw, email);
      const apply = (sendUpdates: "all" | "none") =>
        googleApi.patchWithQuery(
          token,
          eventPath(input.calendarId, input.eventId),
          patch,
          { sendUpdates },
        );
      if (solo) {
        const updated = await apply("none");
        auditRecord({
          action: "calendar.move-event",
          target: `event:${input.calendarId}:${input.eventId}`,
          reason: input.reason ?? "solo move",
          outcome: `moved solo event to ${JSON.stringify(patch.start)}`,
        });
        return JSON.stringify(toEvent(updated));
      }
      const outcome = await requireApproval({
        ctx,
        title: `Move shared meeting "${raw.summary ?? input.eventId}" and notify attendees?`,
        payload: {
          kind: "calendar.move-shared",
          eventId: input.eventId,
          summary: raw.summary,
          currentStart: raw.start,
          currentEnd: raw.end,
          newStart: patch.start as JsonValue,
          newEnd: patch.end as JsonValue,
          attendees: (raw.attendees ?? []).map((a: any) => a.email),
          reason: input.reason ?? "",
        },
        auditAction: "calendar.move-event",
        auditTarget: `event:${input.calendarId}:${input.eventId}`,
        reason: input.reason ?? "shared move",
        execute: () => apply("all"),
        describe: () => "moved shared meeting and notified attendees",
      });
      if (!outcome.approved) {
        return JSON.stringify({
          moved: false,
          reason: "moving a shared meeting requires user approval; not moved",
        });
      }
      return JSON.stringify({ ...toEvent(outcome.result), attendeesNotified: true });
    },
  });

  bb.agents.registerTool({
    name: "calendar_cancel_event",
    description:
      "Cancel/delete an event. Solo events cancel directly. Cancelling a shared event requires user approval before attendees are notified.",
    parameters: z
      .object({
        eventId: z.string().min(1),
        calendarId: z.string().min(1).default("primary"),
        reason: z.string().optional(),
      })
      .strict(),
    async execute(input, ctx) {
      const { token, email } = await getToken();
      const raw = await getEvent(token, input.calendarId, input.eventId);
      const apply = (sendUpdates: "all" | "none") =>
        googleApi.deleteWithQuery(
          token,
          eventPath(input.calendarId, input.eventId),
          { sendUpdates },
        );
      if (isSoloEvent(raw, email)) {
        await apply("none");
        auditRecord({
          action: "calendar.cancel-event",
          target: `event:${input.calendarId}:${input.eventId}`,
          reason: input.reason ?? "solo cancel",
          outcome: `cancelled solo event "${raw.summary ?? input.eventId}"`,
        });
        return JSON.stringify({ cancelled: true, eventId: input.eventId });
      }
      const outcome = await requireApproval({
        ctx,
        title: `Cancel shared event "${raw.summary ?? input.eventId}" and notify attendees?`,
        payload: {
          kind: "calendar.cancel-shared",
          eventId: input.eventId,
          summary: raw.summary,
          attendees: (raw.attendees ?? []).map((a: any) => a.email),
          reason: input.reason ?? "",
        },
        auditAction: "calendar.cancel-event",
        auditTarget: `event:${input.calendarId}:${input.eventId}`,
        reason: input.reason ?? "shared cancel",
        execute: () => apply("all"),
        describe: () => "cancelled shared event and notified attendees",
      });
      if (!outcome.approved) {
        return JSON.stringify({
          cancelled: false,
          reason: "cancelling a shared event requires user approval",
        });
      }
      return JSON.stringify({ cancelled: true, eventId: input.eventId, attendeesNotified: true });
    },
  });

  const attendeeTools: Array<{
    name: "calendar_add_attendee" | "calendar_remove_attendee";
    verb: "add" | "remove";
  }> = [
    { name: "calendar_add_attendee", verb: "add" },
    { name: "calendar_remove_attendee", verb: "remove" },
  ];
  for (const tool of attendeeTools) {
    bb.agents.registerTool({
      name: tool.name,
      description: `${tool.verb === "add" ? "Invite someone to" : "Remove someone from"} an existing event. ALWAYS requires explicit user approval — attendees are notified by Google on approval; nothing changes without it.`,
      parameters: z
        .object({
          eventId: z.string().min(1),
          calendarId: z.string().min(1).default("primary"),
          email: z.string().min(1),
          reason: z.string().optional(),
        })
        .strict(),
      async execute(input, ctx) {
        const { token } = await getToken();
        const raw = await getEvent(token, input.calendarId, input.eventId);
        const current = (raw.attendees ?? []).map((a: any) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        }));
        const already = current.some(
          (a: any) => a.email.toLowerCase() === input.email.toLowerCase(),
        );
        const attendees =
          tool.verb === "add"
            ? already
              ? current
              : [...current, { email: input.email }]
            : current.filter(
                (a: any) => a.email.toLowerCase() !== input.email.toLowerCase(),
              );
        const outcome = await requireApproval({
          ctx,
          title: `${tool.verb === "add" ? "Invite" : "Remove"} ${input.email} ${tool.verb === "add" ? "to" : "from"} "${raw.summary ?? input.eventId}"?`,
          payload: {
            kind: `calendar.${tool.verb}-attendee`,
            eventId: input.eventId,
            summary: raw.summary,
            email: input.email,
            reason: input.reason ?? "",
          },
          auditAction: `calendar.${tool.verb}-attendee`,
          auditTarget: `event:${input.calendarId}:${input.eventId}`,
          reason: input.reason ?? "attendee change",
          execute: () =>
            googleApi.patchWithQuery(
              token,
              eventPath(input.calendarId, input.eventId),
              { attendees },
              { sendUpdates: "all" },
            ),
          describe: () => `${tool.verb}ed attendee ${input.email} and notified`,
        });
        if (!outcome.approved) {
          return JSON.stringify({
            changed: false,
            reason: "attendee changes require user approval; not applied",
          });
        }
        return JSON.stringify({ ...toEvent(outcome.result), attendeesNotified: true });
      },
    });
  }

  bb.agents.registerTool({
    name: "calendar_find_free_time",
    description:
      "Find free time across calendars via Google's free/busy API. Without attendees: the user's own free windows (for protecting blocks, scheduling focus time). With attendees: mutual availability proposals — use the result to propose slots; inviting people still requires approval via calendar_create_event.",
    parameters: z
      .object({
        timeMin: z.string(),
        timeMax: z.string(),
        durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
        attendees: z.array(z.string().min(1)).optional(),
        calendarIds: z.array(z.string().min(1)).optional(),
        timeZone: z.string().optional(),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(10),
      })
      .strict(),
    async execute(input) {
      const { token } = await getToken();
      const items = [
        ...(input.calendarIds ?? ["primary"]).map((id) => ({ id })),
        ...(input.attendees ?? []).map((email) => ({ id: email })),
      ];
      const data = await googleApi.post(token, "/calendar/v3/freeBusy", {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone: input.timeZone,
        items,
      });
      // Merge busy intervals across all queried calendars.
      const busy: Array<{ start: number; end: number }> = [];
      for (const cal of Object.values(data.calendars ?? {}) as any[]) {
        for (const interval of cal.busy ?? []) {
          busy.push({
            start: Date.parse(interval.start),
            end: Date.parse(interval.end),
          });
        }
      }
      busy.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const interval of busy) {
        const last = merged.at(-1);
        if (last && interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
      const windowStart = Date.parse(input.timeMin);
      const windowEnd = Date.parse(input.timeMax);
      const durationMs = input.durationMinutes * 60_000;
      const free: Array<{ start: string; end: string }> = [];
      let cursor = windowStart;
      for (const interval of merged) {
        if (interval.start - cursor >= durationMs) {
          free.push({
            start: new Date(cursor).toISOString(),
            end: new Date(interval.start).toISOString(),
          });
        }
        cursor = Math.max(cursor, interval.end);
        if (cursor >= windowEnd) break;
      }
      if (windowEnd - cursor >= durationMs) {
        free.push({
          start: new Date(cursor).toISOString(),
          end: new Date(windowEnd).toISOString(),
        });
      }
      return JSON.stringify(free.slice(0, input.maxResults));
    },
  });
}
