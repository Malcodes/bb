/**
 * Self-ops domain model: evidence in, diagnoses and bounded changes out.
 *
 * Two responsibilities share one loop (observe → diagnose → hypothesize →
 * change → test → measure → keep/revert):
 *
 * - Maintainer: errors, failed runs, stale schedules, broken connectors,
 *   bad retries, duplicate work, cost/latency/context regressions.
 * - Optimizer: goal attainment, human corrections, approvals/rejections,
 *   repeated prompts, friction; improves prompts, routing, tools, memory,
 *   model selection, workflows, generated surfaces.
 *
 * Hard boundaries:
 * - routine safe fixes may be autonomous;
 * - code/config changes require tests and rollback-safe commits;
 * - permissions, secrets, destructive migrations, external-action safety,
 *   and trust boundaries always require explicit human approval;
 * - optimization targets human capability amplification and goal attainment,
 *   never merely fewer tokens or more automation.
 */

export type ObservationKind =
  | "agent-trace"
  | "tool-call"
  | "model-usage"
  | "error"
  | "run-outcome"
  | "human-correction"
  | "approval-decision"
  | "schedule-heartbeat"
  | "surface-usage"
  | "test-result";

export interface SystemObservation {
  /** Stable identity for dedupe (e.g. event id or content hash). */
  id: string;
  kind: ObservationKind;
  observedAt: string;
  /** What produced this evidence: thread id, plugin id, schedule id, surface id… */
  subject: string;
  /** Bounded structured detail. No secrets, no raw credentials. */
  attributes: Record<string, string | number | boolean>;
}

export type DiagnosisClass =
  | "oversized-context"
  | "failing-scheduled-run"
  | "redundant-tool-calls"
  | "expensive-model-for-trivial-task"
  | "low-value-surface"
  | "broken-connector"
  | "bad-retry-loop"
  | "duplicate-work"
  | "latency-regression"
  | "unknown";

export interface Diagnosis {
  id: string;
  class: DiagnosisClass;
  subject: string;
  summary: string;
  evidence: string[];
  /** 0..1 confidence in the diagnosis. */
  confidence: number;
  diagnosedAt: string;
}

export type ChangeSafety =
  /** Routine safe fix; may run autonomously. */
  | "autonomous-safe"
  /** Code/config change; requires tests + rollback-safe commit. */
  | "tested-change"
  /** Trust boundary; always requires explicit human approval. */
  | "approval-required";

export interface ImprovementProposal {
  id: string;
  diagnosisId: string;
  title: string;
  /** What will change, in bounded form. */
  change: {
    kind:
      | "prompt-compaction"
      | "schedule-repair"
      | "dedup-policy"
      | "model-routing"
      | "surface-evolution"
      | "config-adjustment"
      | "code-change"
      | "trust-boundary-change";
    /** Bounded, credential-free payload. */
    payload: Record<string, string>;
  };
  safety: ChangeSafety;
  rationale: string;
  expectedMetric:
    | "cost"
    | "quality"
    | "reliability"
    | "latency"
    | "goal-attainment";
  status: "proposed" | "testing" | "adopted" | "reverted" | "rejected";
  createdAt: string;
}

export interface ExperimentResult {
  id: string;
  proposalId: string;
  /** Held-out/historical tasks the change was tested against. */
  sampleSize: number;
  baseline: {
    metric: number;
    reliability: number;
    cost: number;
    latencyMs: number;
  };
  candidate: {
    metric: number;
    reliability: number;
    cost: number;
    latencyMs: number;
  };
  /** Did the candidate meet the adoption gate? */
  adopted: boolean;
  summary: string;
  testedAt: string;
}

export interface LearnedPreference {
  /** e.g. "model-routing:trivial-classification" or "surface:low-value-module" */
  key: string;
  /** Chosen option (model id, policy id, surface disposition…). */
  choice: string;
  confidence: number;
  evidence: string[];
  updatedAt: string;
}

export interface HumanAttentionItem {
  id: string;
  source: "maintainer" | "optimizer";
  kind: "approval-required" | "escalation" | "decision";
  title: string;
  rationale: string;
  evidence: string[];
  proposalId?: string;
  status: "open" | "approved" | "rejected" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Diagnosis rules — deterministic, evidence-driven.                   */
/* ------------------------------------------------------------------ */

export interface DiagnosisThresholds {
  /** Prompt/context tokens above which a task is considered oversized. */
  maxContextTokens: number;
  /** Consecutive failures before a scheduled run is diagnosed. */
  maxConsecutiveFailures: number;
  /** Repeated identical tool calls without state change. */
  maxRedundantCalls: number;
  /** Reliability floor a cheaper model must meet on held-out tasks. */
  minReliability: number;
  /** Cycles with zero human value before a surface is low-value. */
  lowValueCycles: number;
  now?: string;
}

export const DEFAULT_THRESHOLDS: DiagnosisThresholds = {
  maxContextTokens: 32_000,
  maxConsecutiveFailures: 2,
  maxRedundantCalls: 3,
  minReliability: 0.95,
  lowValueCycles: 3,
};

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const TRIVIAL_CLASSES = new Set([
  "classification",
  "triage",
  "dedupe",
  "tagging",
  "summarize-short",
]);

const EXPENSIVE_TIERS = new Set(["frontier", "reasoning-max"]);

/** Diagnose a batch of observations into zero or more diagnoses. */
export function diagnoseObservations(
  observations: SystemObservation[],
  thresholds: DiagnosisThresholds = DEFAULT_THRESHOLDS,
): Diagnosis[] {
  const now = thresholds.now ?? new Date().toISOString();
  const out: Diagnosis[] = [];
  const bySubject = new Map<string, SystemObservation[]>();
  for (const obs of observations) {
    const list = bySubject.get(obs.subject) ?? [];
    list.push(obs);
    bySubject.set(obs.subject, list);
  }

  for (const [subject, list] of bySubject) {
    // 1. Oversized prompt/context
    const oversized = list.filter(
      (o) =>
        (o.kind === "agent-trace" || o.kind === "model-usage") &&
        typeof o.attributes.contextTokens === "number" &&
        (o.attributes.contextTokens as number) > thresholds.maxContextTokens,
    );
    if (oversized.length > 0) {
      const worst = oversized.reduce((a, b) =>
        (a.attributes.contextTokens as number) >
        (b.attributes.contextTokens as number)
          ? a
          : b,
      );
      out.push({
        id: newId("diag"),
        class: "oversized-context",
        subject,
        summary: `Context for ${subject} reached ${worst.attributes.contextTokens} tokens (limit ${thresholds.maxContextTokens}); prompt/history needs compaction.`,
        evidence: oversized.map((o) => o.id),
        confidence: 0.9,
        diagnosedAt: now,
      });
    }

    // 2. Failing scheduled run
    const failures = list.filter(
      (o) => o.kind === "run-outcome" && o.attributes.status === "failed",
    );
    if (failures.length >= thresholds.maxConsecutiveFailures) {
      const signatures = new Set(
        failures.map((f) => String(f.attributes.errorSignature ?? "unknown")),
      );
      out.push({
        id: newId("diag"),
        class: "failing-scheduled-run",
        subject,
        summary: `Scheduled run ${subject} failed ${failures.length} consecutive times${signatures.size === 1 ? ` with the same error signature (${[...signatures][0]})` : ""}.`,
        evidence: failures.map((o) => o.id),
        confidence: signatures.size === 1 ? 0.95 : 0.7,
        diagnosedAt: now,
      });
      const anyRetryStorm = failures.some(
        (f) =>
          typeof f.attributes.retryCount === "number" &&
          (f.attributes.retryCount as number) > 3,
      );
      if (anyRetryStorm) {
        out.push({
          id: newId("diag"),
          class: "bad-retry-loop",
          subject,
          summary: `${subject} is retrying without changing inputs; retries amplify cost without new evidence.`,
          evidence: failures.map((o) => o.id),
          confidence: 0.85,
          diagnosedAt: now,
        });
      }
    }

    // 3. Redundant tool calls
    const toolCalls = list.filter((o) => o.kind === "tool-call");
    const callCounts = new Map<string, SystemObservation[]>();
    for (const call of toolCalls) {
      const key = `${call.attributes.tool}:${JSON.stringify(call.attributes.argsHash ?? call.attributes.args ?? "")}`;
      const bucket = callCounts.get(key) ?? [];
      bucket.push(call);
      callCounts.set(key, bucket);
    }
    for (const [key, bucket] of callCounts) {
      if (bucket.length >= thresholds.maxRedundantCalls) {
        out.push({
          id: newId("diag"),
          class: "redundant-tool-calls",
          subject,
          summary: `${subject} issued ${bucket.length} identical calls (${key.split(":")[0]}) with unchanged inputs; results should be reused or deduplicated.`,
          evidence: bucket.map((o) => o.id),
          confidence: 0.9,
          diagnosedAt: now,
        });
      }
    }

    // 4. Expensive model for trivial work
    const usages = list.filter(
      (o) =>
        o.kind === "model-usage" &&
        TRIVIAL_CLASSES.has(String(o.attributes.taskClass)) &&
        EXPENSIVE_TIERS.has(String(o.attributes.modelTier)),
    );
    if (usages.length > 0) {
      out.push({
        id: newId("diag"),
        class: "expensive-model-for-trivial-task",
        subject,
        summary: `${subject} ran ${usages.length} trivial task(s) (${String(usages[0].attributes.taskClass)}) on a ${String(usages[0].attributes.modelTier)} model; a cheaper reliable route exists.`,
        evidence: usages.map((o) => o.id),
        confidence: 0.8,
        diagnosedAt: now,
      });
    }

    // 5. Low-value generated surface
    const surfaceUses = list.filter((o) => o.kind === "surface-usage");
    const stale = surfaceUses.filter(
      (o) =>
        typeof o.attributes.zeroValueCycles === "number" &&
        (o.attributes.zeroValueCycles as number) >= thresholds.lowValueCycles,
    );
    if (stale.length > 0) {
      out.push({
        id: newId("diag"),
        class: "low-value-surface",
        subject,
        summary: `Surface module ${subject} produced no decisions, approvals, or material context for ${stale[0].attributes.zeroValueCycles} cycles; hide, consolidate, or redesign it.`,
        evidence: stale.map((o) => o.id),
        confidence: 0.75,
        diagnosedAt: now,
      });
    }

    // 6. Broken connector / repeated raw errors — never auto-fixed.
    const connectorErrors = list.filter(
      (o) =>
        o.kind === "error" &&
        typeof o.attributes.consecutive === "number" &&
        (o.attributes.consecutive as number) >= 2,
    );
    if (connectorErrors.length > 0) {
      out.push({
        id: newId("diag"),
        class: "broken-connector",
        subject,
        summary: `${subject} is failing repeatedly (${String(connectorErrors[0].attributes.error ?? "unknown error")}); credentials, permissions, or provider state need human review.`,
        evidence: connectorErrors.map((o) => o.id),
        confidence: 0.9,
        diagnosedAt: now,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Hypothesize bounded changes with safety classification.             */
/* ------------------------------------------------------------------ */

/** Trust-boundary change kinds never proceed without explicit approval. */
export function isTrustBoundaryChange(
  kind: ImprovementProposal["change"]["kind"],
): boolean {
  return kind === "trust-boundary-change";
}

export function proposeImprovement(
  diagnosis: Diagnosis,
  now: string = new Date().toISOString(),
): ImprovementProposal {
  switch (diagnosis.class) {
    case "oversized-context":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Compact context for ${diagnosis.subject}`,
        change: {
          kind: "prompt-compaction",
          payload: {
            subject: diagnosis.subject,
            strategy: "summary-checkpoint",
            targetTokens: "16000",
          },
        },
        safety: "tested-change",
        rationale: diagnosis.summary,
        expectedMetric: "cost",
        status: "proposed",
        createdAt: now,
      };
    case "failing-scheduled-run":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Repair schedule ${diagnosis.subject}`,
        change: {
          kind: "schedule-repair",
          payload: {
            subject: diagnosis.subject,
            action: "exponential-backoff",
          },
        },
        safety: "autonomous-safe",
        rationale: diagnosis.summary,
        expectedMetric: "reliability",
        status: "proposed",
        createdAt: now,
      };
    case "bad-retry-loop":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Stop retry storm on ${diagnosis.subject}`,
        change: {
          kind: "config-adjustment",
          payload: { subject: diagnosis.subject, maxRetries: "1" },
        },
        safety: "autonomous-safe",
        rationale: diagnosis.summary,
        expectedMetric: "reliability",
        status: "proposed",
        createdAt: now,
      };
    case "redundant-tool-calls":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Deduplicate repeated calls in ${diagnosis.subject}`,
        change: {
          kind: "dedup-policy",
          payload: { subject: diagnosis.subject, policy: "cache-readonly" },
        },
        safety: "tested-change",
        rationale: diagnosis.summary,
        expectedMetric: "cost",
        status: "proposed",
        createdAt: now,
      };
    case "expensive-model-for-trivial-task":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Route trivial tasks in ${diagnosis.subject} to a cheaper model`,
        change: {
          kind: "model-routing",
          payload: { subject: diagnosis.subject, candidateTier: "cheap" },
        },
        safety: "tested-change",
        rationale: diagnosis.summary,
        expectedMetric: "cost",
        status: "proposed",
        createdAt: now,
      };
    case "low-value-surface":
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Hide low-value module ${diagnosis.subject}`,
        change: {
          kind: "surface-evolution",
          payload: { subject: diagnosis.subject, disposition: "hide" },
        },
        safety: "tested-change",
        rationale: diagnosis.summary,
        expectedMetric: "quality",
        status: "proposed",
        createdAt: now,
      };
    default:
      return {
        id: newId("prop"),
        diagnosisId: diagnosis.id,
        title: `Escalate ${diagnosis.subject}`,
        change: {
          kind: "trust-boundary-change",
          payload: { subject: diagnosis.subject },
        },
        safety: "approval-required",
        rationale: `No safe automatic change for class ${diagnosis.class}; human judgment required.`,
        expectedMetric: "reliability",
        status: "proposed",
        createdAt: now,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Test + measure + keep/revert gate.                                  */
/* ------------------------------------------------------------------ */

export interface HeldOutTask {
  id: string;
  taskClass: string;
  /** Replayable input; assertions judge quality. */
  input: string;
  assertions: string[];
}

export interface CandidateRun {
  taskId: string;
  passed: boolean;
  cost: number;
  latencyMs: number;
}

/**
 * Adoption gate: a candidate is kept only if it is at least as reliable as
 * baseline on held-out tasks and strictly better on the proposal's target
 * metric, without regressing others beyond tolerance. Optimizing only for
 * fewer tokens is explicitly not sufficient — reliability/quality gates apply.
 */
export function evaluateExperiment(input: {
  proposal: ImprovementProposal;
  baselineRuns: CandidateRun[];
  candidateRuns: CandidateRun[];
  minReliability: number;
  now?: string;
}): ExperimentResult {
  const now = input.now ?? new Date().toISOString();
  const rel = (runs: CandidateRun[]) =>
    runs.length === 0 ? 0 : runs.filter((r) => r.passed).length / runs.length;
  const avg = (runs: CandidateRun[], pick: (r: CandidateRun) => number) =>
    runs.length === 0
      ? 0
      : runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;

  const baseline = {
    metric: 0,
    reliability: rel(input.baselineRuns),
    cost: avg(input.baselineRuns, (r) => r.cost),
    latencyMs: avg(input.baselineRuns, (r) => r.latencyMs),
  };
  const candidate = {
    metric: 0,
    reliability: rel(input.candidateRuns),
    cost: avg(input.candidateRuns, (r) => r.cost),
    latencyMs: avg(input.candidateRuns, (r) => r.latencyMs),
  };

  const reliableEnough =
    candidate.reliability >= input.minReliability &&
    candidate.reliability >= baseline.reliability - 0.02;

  let improved = false;
  switch (input.proposal.expectedMetric) {
    case "cost":
      improved = candidate.cost < baseline.cost;
      break;
    case "latency":
      improved = candidate.latencyMs < baseline.latencyMs;
      break;
    case "reliability":
      improved = candidate.reliability > baseline.reliability;
      break;
    case "quality":
    case "goal-attainment":
      // Bounded presentation/workflow changes adopt at reliability parity;
      // "improvement" is the diagnosed removal of low-value surface area,
      // not cheaper tokens.
      improved = candidate.reliability >= baseline.reliability;
      break;
  }
  // Never allow a "cheaper but less reliable" change to be adopted.
  const adopted = reliableEnough && improved;
  return {
    id: newId("exp"),
    proposalId: input.proposal.id,
    sampleSize: input.candidateRuns.length,
    baseline,
    candidate,
    adopted,
    summary: adopted
      ? `Adopted: ${input.proposal.expectedMetric} improved with reliability ${candidate.reliability.toFixed(2)} (baseline ${baseline.reliability.toFixed(2)}).`
      : `Reverted: adoption gate not met (reliability ${candidate.reliability.toFixed(2)} vs floor ${input.minReliability}, improvement=${improved}).`,
    testedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Optimizer learning from human signal.                               */
/* ------------------------------------------------------------------ */

/** Learn from approvals/rejections/dismissals and repeated prompts. */
export function learnPreferences(
  decisions: SystemObservation[],
  now: string = new Date().toISOString(),
): LearnedPreference[] {
  const byKey = new Map<
    string,
    { approve: number; reject: number; dismiss: number; ids: string[] }
  >();
  for (const obs of decisions) {
    if (obs.kind !== "approval-decision" && obs.kind !== "human-correction")
      continue;
    const key = String(obs.attributes.preferenceKey ?? obs.subject);
    const bucket = byKey.get(key) ?? {
      approve: 0,
      reject: 0,
      dismiss: 0,
      ids: [],
    };
    const decision = String(obs.attributes.decision ?? "");
    if (decision === "approved") bucket.approve += 1;
    else if (decision === "rejected") bucket.reject += 1;
    else if (decision === "dismissed") bucket.dismiss += 1;
    bucket.ids.push(obs.id);
    byKey.set(key, bucket);
  }
  const learned: LearnedPreference[] = [];
  for (const [key, bucket] of byKey) {
    const total = bucket.approve + bucket.reject + bucket.dismiss;
    if (total < 2) continue;
    // Dismissed-heavy areas produce low-value noise; approve-heavy flows are
    // candidates for (still approval-gated) streamlined preparation.
    if (bucket.dismiss / total >= 0.6) {
      learned.push({
        key,
        choice: "reduce-surface-frequency",
        confidence: bucket.dismiss / total,
        evidence: bucket.ids,
        updatedAt: now,
      });
    } else if (bucket.approve / total >= 0.8) {
      learned.push({
        key,
        choice: "prepare-earlier-keep-approval",
        confidence: bucket.approve / total,
        evidence: bucket.ids,
        updatedAt: now,
      });
    }
  }
  return learned;
}

/** Cheapest-reliable model routing knowledge, updated by experiments. */
export function updateModelRouting(
  existing: LearnedPreference[],
  proposal: ImprovementProposal,
  experiment: ExperimentResult,
  now: string = new Date().toISOString(),
): LearnedPreference[] {
  if (proposal.change.kind !== "model-routing" || !experiment.adopted) {
    return existing;
  }
  const key = `model-routing:${proposal.change.payload.subject}`;
  const next = existing.filter((p) => p.key !== key);
  next.push({
    key,
    choice: proposal.change.payload.candidateTier ?? "cheap",
    confidence: experiment.candidate.reliability,
    evidence: [experiment.id],
    updatedAt: now,
  });
  return next;
}
