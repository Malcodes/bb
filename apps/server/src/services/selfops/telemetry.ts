/**
 * SelfOps telemetry normalizer: converts BB's native production signal into
 * SystemObservation evidence, so Maintainer and Optimizer operate on actual
 * system behavior instead of agent-reported notes.
 *
 * Sources (all server-native):
 * - thread events: tool-call traces (repeated identical calls, no-op loops),
 *   turn completions/failures, goal token budgets, command failures;
 * - threads: model/provider, status, retries;
 * - plugin_schedules: missed/stale runs and failure streaks;
 * - host daemon sessions: connector health/auth errors;
 * - attention decisions recorded via the sales surface RPC.
 *
 * Each observation carries a stable fingerprint so re-scans are idempotent.
 */
import type { DbConnection } from "@bb/db";
import { createHash } from "node:crypto";
import type { SystemObservation } from "@bb/plugin-sdk";

export interface TelemetryCursor {
  lastEventCreatedAt: number;
  lastEventId: string;
  lastScanAt: number;
  scheduleStreaks?: ScheduleStreaks;
}

const CURSOR_KEY = "selfops:telemetry-cursor";

function fingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 24);
}

interface EventRow {
  id: string;
  thread_id: string;
  type: string;
  item_kind: string | null;
  data: string;
  created_at: number;
}

function parseData(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Pull new thread events since the cursor and normalize them into
 * observations. Returns the new cursor.
 */
export function scanThreadEvents(
  db: DbConnection,
  cursor: TelemetryCursor,
): { observations: SystemObservation[]; cursor: TelemetryCursor } {
  const rows = db.$client
    .prepare(
      `SELECT id, thread_id, type, item_kind, data, created_at FROM events
       WHERE created_at > ? OR (created_at = ? AND id > ?)
       ORDER BY created_at, id LIMIT 5000`,
    )
    .all(
      cursor.lastEventCreatedAt,
      cursor.lastEventCreatedAt,
      cursor.lastEventId,
    ) as unknown as EventRow[];
  const out: SystemObservation[] = [];
  let last = { ...cursor };

  // Track per-thread recent tool-call fingerprints for repeat detection.
  const seenToolCalls = new Map<string, number>();

  for (const row of rows) {
    last = {
      lastEventCreatedAt: row.created_at,
      lastEventId: row.id,
      lastScanAt: Date.now(),
    };
    const data = parseData(row.data);
    const ts = new Date(row.created_at).toISOString();
    const subject = `thread:${row.thread_id}`;

    if (row.type === "item/completed" && row.item_kind === "toolCall") {
      const item = (data.item ?? data) as Record<string, unknown>;
      const tool = String(item.tool ?? "unknown");
      const args = JSON.stringify(item.arguments ?? {});
      const key = fingerprint([tool, args]);
      const count = (seenToolCalls.get(key) ?? 0) + 1;
      seenToolCalls.set(key, count);
      out.push({
        id: `obs-${row.id}`,
        kind: "tool-call",
        observedAt: ts,
        subject,
        attributes: {
          tool,
          argsHash: key,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : 0,
          failed: item.error ? 1 : 0,
          repeatIndex: count,
        },
      });
      if (item.error) {
        out.push({
          id: `obs-err-${row.id}`,
          kind: "error",
          observedAt: ts,
          subject,
          attributes: { error: String(item.error).slice(0, 200), tool },
        });
      }
    }

    if (row.type === "item/completed" && row.item_kind === "commandExecution") {
      const item = (data.item ?? data) as Record<string, unknown>;
      if (typeof item.exitCode === "number" && item.exitCode !== 0) {
        out.push({
          id: `obs-cmd-${row.id}`,
          kind: "run-outcome",
          observedAt: ts,
          subject,
          attributes: {
            succeeded: 0,
            exitCode: item.exitCode,
            command: String(item.command ?? "").slice(0, 200),
          },
        });
      }
    }

    if (row.type === "turn/completed") {
      const status = String(data.status ?? "unknown");
      out.push({
        id: `obs-turn-${row.id}`,
        kind: "run-outcome",
        observedAt: ts,
        subject,
        attributes: {
          succeeded: status === "completed" ? 1 : 0,
          turnStatus: status,
        },
      });
      if (data.error && typeof data.error === "object") {
        out.push({
          id: `obs-turnerr-${row.id}`,
          kind: "error",
          observedAt: ts,
          subject,
          attributes: {
            error: String(
              (data.error as { message?: unknown }).message ?? "",
            ).slice(0, 200),
          },
        });
      }
    }

    if (row.type === "thread/goal/updated") {
      const tokensUsed =
        typeof data.tokensUsed === "number" ? data.tokensUsed : 0;
      const budget =
        typeof data.tokenBudget === "number" ? data.tokenBudget : 0;
      out.push({
        id: `obs-goal-${row.id}`,
        kind: "agent-trace",
        observedAt: ts,
        subject,
        attributes: {
          contextTokens: tokensUsed,
          tokensUsed,
          tokenBudget: budget,
          timeUsedSeconds:
            typeof data.timeUsedSeconds === "number" ? data.timeUsedSeconds : 0,
          oversized: budget > 0 && tokensUsed > budget ? 1 : 0,
        },
      });
    }

    if (row.type === "item/completed" && row.item_kind === "backgroundTask") {
      const item = (data.item ?? data) as Record<string, unknown>;
      const usage = (item.usage ?? {}) as Record<string, unknown>;
      out.push({
        id: `obs-bgtask-${row.id}`,
        kind: "model-usage",
        observedAt: ts,
        subject,
        attributes: {
          taskClass: String(item.taskType ?? "unknown"),
          modelTier: inferModelTier(threadModel(db, row.thread_id) ?? ""),
          contextTokens:
            typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
          latencyMs:
            typeof usage.durationMs === "number" ? usage.durationMs : 0,
          failed: item.error ? 1 : 0,
        },
      });
    }
  }
  return { observations: out, cursor: last };
}

export interface ScheduleStreaks {
  [subject: string]: { consecutive: number; signature: string };
}

/** Scheduler evidence: stale or failing plugin schedules. */
export function scanSchedules(
  db: DbConnection,
  now: number,
  streaks: ScheduleStreaks = {},
): SystemObservation[] {
  const rows = db.$client
    .prepare(
      `SELECT plugin_id, name, cron, next_run_at, last_run_at, last_status, last_error FROM plugin_schedules`,
    )
    .all() as unknown as Array<{
    plugin_id: string;
    name: string;
    cron: string;
    next_run_at: number;
    last_run_at: number | null;
    last_status: string | null;
    last_error: string | null;
  }>;
  const out: SystemObservation[] = [];
  for (const row of rows) {
    const subject = `schedule:${row.plugin_id}/${row.name}`;
    const stale =
      row.last_run_at !== null && row.next_run_at < now - 10 * 60_000;
    const signature = fingerprint([row.last_error ?? "ok"]);
    const streak = streaks[subject] ?? { consecutive: 0, signature };
    if (row.last_status === "error") {
      streak.consecutive =
        streak.signature === signature ? streak.consecutive + 1 : 1;
      streak.signature = signature;
    } else if (row.last_status === "ok") {
      streak.consecutive = 0;
    }
    streaks[subject] = streak;
    out.push({
      id: `obs-sched-${fingerprint([subject, String(row.next_run_at)])}`,
      kind: "schedule-heartbeat",
      observedAt: new Date(now).toISOString(),
      subject,
      attributes: {
        stale: stale ? 1 : 0,
        lastStatus: row.last_status ?? "unknown",
        consecutiveFailures: streak.consecutive,
        ...(row.last_error ? { error: row.last_error.slice(0, 200) } : {}),
      },
    });
    if (row.last_status === "error") {
      out.push({
        id: `obs-schederr-${fingerprint([subject, String(row.last_run_at), String(streak.consecutive)])}`,
        kind: "run-outcome",
        observedAt: new Date(row.last_run_at ?? now).toISOString(),
        subject,
        attributes: {
          status: "failed",
          errorSignature: signature,
          retryCount: streak.consecutive,
          consecutive: streak.consecutive,
        },
      });
    }
  }
  return out;
}

/** Connector health: offline/errored host daemon sessions, streaked. */
export function scanConnectors(
  db: DbConnection,
  now: number,
  streaks: ScheduleStreaks = {},
): SystemObservation[] {
  const rows = db.$client
    .prepare(
      `SELECT host_id, status, close_reason AS last_error FROM host_daemon_sessions WHERE status != 'active'`,
    )
    .all() as unknown as Array<{
    host_id: string;
    status: string;
    last_error: string | null;
  }>;
  return rows.map((row) => {
    const subject = `connector:${row.host_id}`;
    const signature = fingerprint([row.status, row.last_error ?? ""]);
    const streak = streaks[subject] ?? { consecutive: 0, signature };
    streak.consecutive =
      streak.signature === signature ? streak.consecutive + 1 : 1;
    streak.signature = signature;
    streaks[subject] = streak;
    return {
      id: `obs-conn-${fingerprint([subject, signature])}`,
      kind: "error" as const,
      observedAt: new Date(now).toISOString(),
      subject,
      attributes: {
        error: (row.last_error ?? `status=${row.status}`).slice(0, 200),
        consecutive: streak.consecutive,
      },
    };
  });
}

/** Human attention decisions recorded by generated surfaces. */
export function recordAttentionDecision(
  workspaceId: string,
  itemId: string,
  kind: string,
  decision: "approved" | "rejected" | "resolved" | "dismissed",
): SystemObservation {
  return {
    id: `obs-att-${fingerprint([workspaceId, itemId, decision, String(Date.now())])}`,
    kind: "approval-decision",
    observedAt: new Date().toISOString(),
    subject: `surface:${workspaceId}`,
    attributes: { itemId, itemKind: kind, decision },
  };
}

/** Surface usage heartbeat: a module existed but led to no decision/action. */
export function surfaceUsageObservation(
  workspaceId: string,
  moduleId: string,
  zeroValueCycles: number,
): SystemObservation {
  return {
    id: `obs-surf-${fingerprint([workspaceId, moduleId])}`,
    kind: "surface-usage",
    observedAt: new Date().toISOString(),
    subject: `surface:${workspaceId}/${moduleId}`,
    attributes: { zeroValueCycles },
  };
}

const threadModelCache = new Map<string, string | null>();
function threadModel(db: DbConnection, threadId: string): string | null {
  if (threadModelCache.has(threadId))
    return threadModelCache.get(threadId) ?? null;
  const row = db.$client
    .prepare(`SELECT provider_id, model_override FROM threads WHERE id = ?`)
    .get(threadId) as
    | { provider_id: string; model_override: string | null }
    | undefined;
  const value = row ? `${row.provider_id}/${row.model_override ?? ""}` : null;
  threadModelCache.set(threadId, value);
  return value;
}

function inferModelTier(model: string): string {
  const m = model.toLowerCase();
  if (/o3|reasoning|deepthink/.test(m)) return "reasoning-max";
  if (/opus|gpt-5|pro|frontier|claude-4/.test(m)) return "frontier";
  if (/mini|flash|haiku|cheap|small/.test(m)) return "cheap";
  return "standard";
}

export function loadCursor(db: DbConnection): TelemetryCursor {
  const row = db.$client
    .prepare(
      `SELECT value FROM plugin_kv WHERE plugin_id = 'selfops' AND key = ?`,
    )
    .get(CURSOR_KEY) as { value: string } | undefined;
  if (!row) return { lastEventCreatedAt: 0, lastEventId: "", lastScanAt: 0 };
  return JSON.parse(row.value) as TelemetryCursor;
}

export function saveCursor(db: DbConnection, cursor: TelemetryCursor): void {
  db.$client
    .prepare(
      `INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES ('selfops', ?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(CURSOR_KEY, JSON.stringify(cursor), Date.now());
}
