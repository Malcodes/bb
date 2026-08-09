/**
 * SelfOps native-telemetry collector: periodically converts BB's own
 * production signal (thread events, scheduler rows, connector sessions) into
 * SelfOps observations and feeds the selfops plugin through its RPC contract.
 * Agents never report their own telemetry; the server normalizes it.
 */
import type { DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import type { PluginService } from "../plugins/plugin-service.js";
import type { SystemObservation } from "@bb/plugin-sdk";
import {
  loadCursor,
  saveCursor,
  scanConnectors,
  scanSchedules,
  scanThreadEvents,
} from "./telemetry.js";

export interface SelfOpsCollectorDeps {
  db: DbConnection;
  plugins: PluginService;
  logger: Logger;
  /** Scan cadence; defaults to 60s. */
  intervalMs?: number;
}

export interface SelfOpsCollector {
  stop(): void;
  /** One scan+ingest pass; exposed for tests. */
  runOnce(): Promise<{ ingested: number }>;
}

export function startSelfOpsCollector(
  deps: SelfOpsCollectorDeps,
): SelfOpsCollector {
  const intervalMs = deps.intervalMs ?? 60_000;

  async function runOnce(): Promise<{ ingested: number }> {
    const cursor = loadCursor(deps.db);
    const now = Date.now();
    const batches: SystemObservation[][] = [];
    const events = scanThreadEvents(deps.db, cursor);
    batches.push(events.observations);
    const streaks = { ...(cursor.scheduleStreaks ?? {}) };
    batches.push(scanSchedules(deps.db, now, streaks));
    batches.push(scanConnectors(deps.db, now, streaks));
    const observations = batches.flat();
    saveCursor(deps.db, { ...events.cursor, scheduleStreaks: streaks });

    if (observations.length === 0) return { ingested: 0 };

    const lookup = deps.plugins.getRpcHandler("selfops", "ingestObservations");
    if (lookup.outcome !== "found") return { ingested: 0 };
    const outcome = await deps.plugins.invokeRpcHandler(
      "selfops",
      "ingestObservations",
      lookup.value,
      { observations: observations.slice(0, 500) },
    );
    if (!outcome.ok) {
      deps.logger.warn({ err: outcome.error.message }, "SelfOps ingest failed");
      return { ingested: 0 };
    }
    return { ingested: observations.length };
  }

  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      deps.logger.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        "SelfOps collector pass failed",
      );
    });
  }, intervalMs);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}
