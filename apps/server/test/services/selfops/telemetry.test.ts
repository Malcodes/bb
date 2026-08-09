/**
 * Acceptance: SelfOps discovers the five known failure modes from BB's native
 * production telemetry (events/plugin_schedules/host sessions tables) with no
 * explicit agent-reported observations.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import {
  diagnoseObservations,
  proposeImprovement,
  type SystemObservation,
} from "@bb/plugin-sdk";
import {
  recordAttentionDecision,
  scanConnectors,
  scanSchedules,
  scanThreadEvents,
  surfaceUsageObservation,
  type TelemetryCursor,
} from "../../../src/services/selfops/telemetry.js";

let db: DbConnection;
let workDir: string;

beforeEach(async () => {
  db = createConnection(":memory:");
  migrate(db);
  workDir = await mkdtemp(join(tmpdir(), "bb-selfops-telemetry-"));
});

afterEach(async () => {
  db.$client.close();
  await rm(workDir, { recursive: true, force: true });
});

function insertProjectAndThread(threadId: string, model: string): void {
  db.$client
    .prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'p', 0, 0)`,
    )
    .run(`project-${threadId}`);
  db.$client
    .prepare(
      `INSERT INTO threads (id, project_id, provider_id, model_override, status, latest_attention_at, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, 'idle', 0, 0, 0)`,
    )
    .run(threadId, `project-${threadId}`, model);
}

function insertEvent(input: {
  id: string;
  threadId: string;
  type: string;
  itemKind?: string;
  data: unknown;
  createdAt: number;
}): void {
  db.$client
    .prepare(
      `INSERT INTO events (id, thread_id, scope_kind, sequence, type, item_kind, data, created_at)
       VALUES (?, ?, 'thread', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.threadId,
      input.createdAt,
      input.type,
      input.itemKind ?? null,
      JSON.stringify(input.data),
      input.createdAt,
    );
}

const cursor: TelemetryCursor = {
  lastEventCreatedAt: 0,
  lastEventId: "",
  lastScanAt: 0,
};

describe("SelfOps native telemetry normalization", () => {
  it("discovers the five failure modes from native tables, then the loop diagnoses and acts", () => {
    const t0 = Date.parse("2026-08-09T20:00:00Z");

    // A thread on an expensive model that: blows its context budget, loops an
    // identical tool call, and runs a trivial background task on a frontier model.
    insertProjectAndThread("thread-bad", "codex/gpt-5-pro");
    insertEvent({
      id: "e1",
      threadId: "thread-bad",
      type: "thread/goal/updated",
      data: {
        objective: "triage",
        status: "active",
        tokenBudget: 100_000,
        tokensUsed: 250_000,
        timeUsedSeconds: 900,
      },
      createdAt: t0,
    });
    for (let i = 0; i < 4; i++) {
      insertEvent({
        id: `tc-${i}`,
        threadId: "thread-bad",
        type: "item/completed",
        itemKind: "toolCall",
        data: {
          item: {
            type: "toolCall",
            id: `call-${i}`,
            tool: "google_search",
            arguments: { q: "same query" },
            status: "completed",
            durationMs: 120,
          },
        },
        createdAt: t0 + i + 1,
      });
    }
    insertEvent({
      id: "bg-1",
      threadId: "thread-bad",
      type: "item/completed",
      itemKind: "backgroundTask",
      data: {
        item: {
          type: "backgroundTask",
          id: "task-1",
          taskType: "triage",
          description: "classify an email",
          status: "completed",
          taskStatus: "completed",
          skipTranscript: false,
          usage: { totalTokens: 4_000, toolUses: 1, durationMs: 8_000 },
        },
      },
      createdAt: t0 + 10,
    });

    // A plugin schedule failing repeatedly with the same error.
    db.$client
      .prepare(
        `INSERT INTO plugin_schedules (plugin_id, name, cron, next_run_at, last_run_at, last_status, last_error, updated_at)
         VALUES ('automations', 'nightly', '0 0 * * *', ?, ?, 'error', 'connection refused', ?)`,
      )
      .run(t0 - 3_600_000, t0 - 60_000, t0);

    // A broken connector (daemon session closed with an auth error).
    db.$client
      .prepare(
        `INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host-1', 'mbp', 'workstation', 0, 0)`,
      )
      .run();
    db.$client
      .prepare(
        `INSERT INTO host_daemon_sessions (id, host_id, instance_id, host_name, host_type, data_dir, protocol_version, heartbeat_interval_ms, lease_timeout_ms, status, lease_expires_at, close_reason, created_at, updated_at)
         VALUES ('sess-1', 'host-1', 'inst', 'mbp', 'workstation', '/tmp', 1, 1000, 5000, 'closed', 0, 'auth token rejected', 0, 0)`,
      )
      .run();

    // Scan twice so the schedule error streak crosses the diagnosis threshold.
    let streaks = {};
    const first = scanThreadEvents(db, cursor);
    scanSchedules(db, t0, streaks);
    const schedObs = scanSchedules(db, t0 + 60_000, streaks);
    const schedAgain = scanSchedules(db, t0 + 120_000, streaks);
    const observations: SystemObservation[] = [
      ...first.observations,
      ...schedObs,
      ...schedAgain,
      ...scanConnectors(db, t0, streaks),
      ...scanConnectors(db, t0 + 30_000, streaks),
      // Surface telemetry arrives from generated tools, not agent self-reports.
      surfaceUsageObservation("ws-1", "module-pipeline", 5),
      recordAttentionDecision("ws-1", "att-9", "information", "dismissed"),
    ];

    const diagnoses = diagnoseObservations(observations, {
      maxContextTokens: 100_000,
      maxConsecutiveFailures: 3,
      maxRedundantCalls: 3,
      minReliability: 0.95,
      lowValueCycles: 5,
      now: new Date(t0 + 200_000).toISOString(),
    });
    const classes = diagnoses.map((d) => d.class);
    expect(classes).toContain("oversized-context");
    expect(classes).toContain("redundant-tool-calls");
    expect(classes).toContain("expensive-model-for-trivial-task");
    expect(classes).toContain("failing-scheduled-run");
    expect(classes).toContain("low-value-surface");
    expect(classes).toContain("broken-connector");

    // Bounded change classification follows from native diagnoses.
    const proposals = diagnoses.map((d) =>
      proposeImprovement(d, new Date(t0 + 200_000).toISOString()),
    );
    const byClass = new Map(diagnoses.map((d, i) => [d.class, proposals[i]]));
    // schedule repair is autonomous-safe
    expect(byClass.get("failing-scheduled-run")?.safety).toBe(
      "autonomous-safe",
    );
    // broken connector requires explicit approval, never silent adoption
    expect(byClass.get("broken-connector")?.safety).toBe("approval-required");
    // cost/surface improvements are gated behind experiments
    expect(byClass.get("expensive-model-for-trivial-task")?.safety).toBe(
      "tested-change",
    );
    expect(byClass.get("low-value-surface")?.safety).toBe("tested-change");
  });

  it("event scanning is cursor-incremental and idempotent", () => {
    const t0 = Date.parse("2026-08-09T20:00:00Z");
    insertProjectAndThread("thread-x", "codex/gpt-5-mini");
    insertEvent({
      id: "only",
      threadId: "thread-x",
      type: "turn/completed",
      data: { status: "completed" },
      createdAt: t0,
    });
    const first = scanThreadEvents(db, cursor);
    expect(first.observations.length).toBeGreaterThan(0);
    const second = scanThreadEvents(db, first.cursor);
    expect(second.observations).toEqual([]);
  });
});
