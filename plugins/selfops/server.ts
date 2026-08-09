import { z } from "zod";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import {
  emptySelfOpsState,
  rollbackAutonomousChange,
  runSelfOpsLoop,
  type LoopHooks,
  type SelfOpsState,
} from "./src/loop.js";
import {
  heldOutTasksFromHistory,
  type CandidateRun,
  type HeldOutTask,
  type SystemObservation,
} from "./src/model.js";

const STATE_KEY = "selfops-state";

const observationSchema = z
  .object({
    id: z.string().min(1).max(300),
    kind: z.enum([
      "agent-trace",
      "tool-call",
      "model-usage",
      "error",
      "run-outcome",
      "human-correction",
      "approval-decision",
      "schedule-heartbeat",
      "surface-usage",
      "test-result",
    ]),
    observedAt: z.string(),
    subject: z.string().min(1).max(500),
    attributes: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();

export const selfopsRpcContract = defineRpcContract({
  ingestObservations: {
    input: z
      .object({ observations: z.array(observationSchema).min(1).max(500) })
      .strict(),
    output: z
      .object({
        ingested: z.number(),
        diagnoses: z.number(),
        autoFixed: z.number(),
        escalated: z.number(),
      })
      .strict(),
  },
  readBrief: {
    input: z.object({}).strict(),
    output: z
      .object({
        openAttention: z.number(),
        adoptedChanges: z.number(),
        revertedChanges: z.number(),
        autoFixed: z.number(),
        recentExperiments: z.array(z.string()),
        /**
         * Hidden-by-default BB-wide status: only the four surfacing
         * categories — material failures, approval-needed improvements,
         * meaningful adopted improvements, significant regressions.
         */
        notices: z.array(
          z
            .object({
              id: z.string(),
              category: z.enum([
                "material-failure",
                "approval-required",
                "adopted-improvement",
                "regression",
              ]),
              title: z.string(),
              detail: z.string(),
              attentionId: z.string().optional(),
            })
            .strict(),
        ),
        attention: z.array(
          z
            .object({
              id: z.string(),
              kind: z.string(),
              title: z.string(),
              rationale: z.string(),
              status: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  resolveAttention: {
    input: z
      .object({
        attentionId: z.string().min(1),
        decision: z.enum(["approved", "rejected", "dismissed"]),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export interface SelfOpsOptions {
  /** Telemetry collectors producing evidence from BB's own operation. */
  collectors?: Array<() => Promise<SystemObservation[]>>;
  hooks?: Partial<LoopHooks>;
  now?: () => string;
}

function defaultHeldOutTasks(changeKind: string): HeldOutTask[] {
  // Canonical replay set. Production expands this from recorded traces; the
  // gate refuses adoption without samples.
  if (changeKind === "model-routing") {
    return [
      {
        id: "cls-1",
        taskClass: "classification",
        input: "triage sample A",
        assertions: ["correct-class"],
      },
      {
        id: "cls-2",
        taskClass: "classification",
        input: "triage sample B",
        assertions: ["correct-class"],
      },
      {
        id: "cls-3",
        taskClass: "dedupe",
        input: "duplicate sample",
        assertions: ["correct-class"],
      },
    ];
  }
  if (
    changeKind === "prompt-compaction" ||
    changeKind === "dedup-policy" ||
    changeKind === "surface-evolution"
  ) {
    return [
      {
        id: "trace-1",
        taskClass: "replay",
        input: "historical trace A",
        assertions: ["goal-attained"],
      },
      {
        id: "trace-2",
        taskClass: "replay",
        input: "historical trace B",
        assertions: ["goal-attained"],
      },
    ];
  }
  return [];
}

export default async function plugin(
  bb: BbPluginApi,
  options: SelfOpsOptions = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  async function loadState(): Promise<SelfOpsState> {
    const stored = await bb.storage.kv.get<SelfOpsState>(STATE_KEY);
    return stored ?? emptySelfOpsState();
  }
  async function saveState(state: SelfOpsState): Promise<void> {
    state.observations = state.observations.slice(-5_000);
    state.diagnoses = state.diagnoses.slice(0, 500);
    state.proposals = state.proposals.slice(0, 500);
    state.experiments = state.experiments.slice(0, 500);
    state.attention = state.attention.slice(0, 200);
    await bb.storage.kv.set(STATE_KEY, state);
  }

  const hooks: LoopHooks = {
    now,
    // Actual historical workloads first (live state at experiment time);
    // the canonical replay set is the fallback; empty means "do not adopt".
    heldOutTasks: (changeKind) =>
      heldOutTasksFromHistory(changeKind, currentEvidence).length > 0
        ? heldOutTasksFromHistory(changeKind, currentEvidence)
        : (options.hooks?.heldOutTasks ?? defaultHeldOutTasks)(changeKind),
    runExperiment:
      options.hooks?.runExperiment ??
      (async ({ proposal, heldOut }) => {
        // Production default: without a replay harness wired to real traces we
        // must not adopt — return empty candidate runs so the gate reverts and
        // the change escalates as a decision instead of silently shipping.
        if (heldOut.length === 0) {
          return {
            baseline: [] as CandidateRun[],
            candidate: [] as CandidateRun[],
          };
        }
        // Replay uses recorded baseline outcomes; candidates require a real
        // executor, so default to baseline-parity (no adoption signal).
        const baseline: CandidateRun[] = heldOut.map((task) => ({
          taskId: task.id,
          passed: true,
          cost: 1,
          latencyMs: 1_000,
        }));
        return { baseline, candidate: [] };
      }),
    applyAutonomousFix:
      options.hooks?.applyAutonomousFix ??
      (async (proposal) => {
        await bb.storage.kv.set(
          `selfops:applied:${proposal.change.payload.subject}`,
          proposal.change.payload,
        );
        bb.log.info(
          `selfops autonomous fix: ${proposal.title} (${JSON.stringify(proposal.change.payload)})`,
        );
        return `applied ${proposal.change.kind} to ${proposal.change.payload.subject}`;
      }),
    capturePriorValue:
      options.hooks?.capturePriorValue ??
      (async (proposal) => {
        const prior = await bb.storage.kv.get<Record<string, string>>(
          `selfops:applied:${proposal.change.payload.subject}`,
        );
        return prior ? JSON.stringify(prior) : undefined;
      }),
    rollbackAutonomousFix:
      options.hooks?.rollbackAutonomousFix ??
      (async (proposal) => {
        const key = `selfops:applied:${proposal.change.payload.subject}`;
        const prior = proposal.change.payload.priorValue;
        if (prior !== undefined) {
          await bb.storage.kv.set(key, JSON.parse(prior));
        } else {
          await bb.storage.kv.delete(key);
        }
        bb.log.info(`selfops rollback: ${proposal.title}`);
        return `reverted ${proposal.change.kind} on ${proposal.change.payload.subject}`;
      }),
  };

  async function collectEvidence(): Promise<SystemObservation[]> {
    const batches = await Promise.all(
      (options.collectors ?? []).map(async (collector) => {
        try {
          return await collector();
        } catch (error) {
          bb.log.warn(
            `selfops collector failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [] as SystemObservation[];
        }
      }),
    );
    return batches.flat();
  }

  async function runLoop(): Promise<void> {
    const evidence = await collectEvidence();
    await ingest(evidence);
  }

  let currentEvidence: SystemObservation[] = [];
  async function ingest(
    evidence: SystemObservation[],
  ): Promise<{ diagnoses: number; autoFixed: number; escalated: number }> {
    const state = await loadState();
    currentEvidence = [...state.observations, ...evidence];
    const outcome = await runSelfOpsLoop(state, evidence, hooks);
    if (
      outcome.newDiagnoses.length > 0 ||
      outcome.autoFixed.length > 0 ||
      outcome.escalated.length > 0
    ) {
      bb.log.info(
        `selfops loop: ${outcome.newDiagnoses.length} diagnoses, ${outcome.autoFixed.length} autonomous fixes, ${outcome.tested.length} experiments, ${outcome.escalated.length} escalations`,
      );
    }
    await saveState(outcome.state);
    bb.realtime.publish("selfops-changed", { at: Date.now() });
    return {
      diagnoses: outcome.newDiagnoses.length,
      autoFixed: outcome.autoFixed.length,
      escalated: outcome.escalated.length,
    };
  }

  bb.background.schedule("selfops-loop", "*/10 * * * *", runLoop);

  bb.agents.registerTool({
    name: "selfops_observe",
    description:
      "Contribute operational evidence (traces, tool calls, model usage, errors, run outcomes, corrections, approvals, schedule heartbeats, surface usage) to BB's self-maintenance layer.",
    parameters: z
      .object({ observations: z.array(observationSchema).min(1).max(200) })
      .strict(),
    async execute(input) {
      const state = await loadState();
      const outcome = await runSelfOpsLoop(state, input.observations, hooks);
      await saveState(outcome.state);
      return JSON.stringify({
        diagnoses: outcome.newDiagnoses.map((d) => ({
          class: d.class,
          summary: d.summary,
        })),
        autoFixed: outcome.autoFixed,
        tested: outcome.tested.map((e) => ({
          adopted: e.adopted,
          summary: e.summary,
        })),
        escalated: outcome.escalated.map((e) => e.title),
      });
    },
  });

  bb.agents.registerTool({
    name: "selfops_read_brief",
    description:
      "Read the self-maintenance layer's current state: open human attention items, adopted/reverted changes, and recent experiment outcomes.",
    parameters: z.object({}).strict(),
    async execute() {
      const state = await loadState();
      return JSON.stringify({
        openAttention: state.attention.filter((a) => a.status === "open"),
        adopted: state.proposals
          .filter((p) => p.status === "adopted")
          .map((p) => p.title),
        reverted: state.proposals
          .filter((p) => p.status === "reverted")
          .map((p) => p.title),
        preferences: state.preferences,
        recentExperiments: state.experiments.slice(0, 10).map((e) => e.summary),
      });
    },
  });

  bb.agents.registerTool({
    name: "selfops_resolve_attention",
    description:
      "Resolve a self-ops human attention item. Approving an approval-required item authorizes exactly that bounded change; nothing else.",
    parameters: z
      .object({
        attentionId: z.string().min(1),
        decision: z.enum(["approved", "rejected", "dismissed"]),
      })
      .strict(),
    async execute(input) {
      const state = await loadState();
      const item = state.attention.find((a) => a.id === input.attentionId);
      if (!item)
        throw new Error(`attention item not found: ${input.attentionId}`);
      if (item.status !== "open")
        throw new Error(`attention item already ${item.status}`);
      item.status = input.decision;
      item.resolvedAt = now();
      if (item.proposalId) {
        const proposal = state.proposals.find((p) => p.id === item.proposalId);
        if (proposal) {
          proposal.status =
            input.decision === "approved" ? "adopted" : "rejected";
        }
      }
      await saveState(state);
      return JSON.stringify({ ok: true });
    },
  });

  bb.agents.configure(() => ({
    tools: [
      "selfops_observe",
      "selfops_read_brief",
      "selfops_resolve_attention",
    ],
    skills: [],
    instructions: `BB self-maintenance (selfops) is active. Contribute operational evidence via selfops_observe when you encounter errors, failed runs, redundant tool calls, oversized context, expensive-model trivial work, low-value surfaces, or human corrections. The loop diagnoses, autonomously repairs only routine safe failures, tests bounded changes against held-out tasks before adopting, and escalates trust-boundary changes for explicit approval. Optimize for human capability amplification and goal attainment — never merely fewer tokens or more automation.`,
  }));

  bb.agents.registerTool({
    name: "selfops_rollback_change",
    description:
      "Roll back an adopted autonomous-safe change to its audited prior value.",
    parameters: z.object({ proposalId: z.string().min(1) }).strict(),
    async execute(input) {
      const state = await loadState();
      const proposal = await rollbackAutonomousChange(
        state,
        input.proposalId,
        hooks,
      );
      await saveState(state);
      bb.realtime.publish("selfops-changed", { at: Date.now() });
      return JSON.stringify({
        id: proposal.id,
        status: proposal.status,
        priorValue: proposal.change.payload.priorValue ?? null,
      });
    },
  });

  bb.rpc.register(selfopsRpcContract, {
    async ingestObservations({ observations }) {
      const result = await ingest(observations as SystemObservation[]);
      return {
        ingested: observations.length,
        diagnoses: result.diagnoses,
        autoFixed: result.autoFixed,
        escalated: result.escalated,
      };
    },
    async readBrief() {
      const state = await loadState();
      const dayAgo = Date.now() - 24 * 60 * 60_000;
      const notices: Array<{
        id: string;
        category:
          | "material-failure"
          | "approval-required"
          | "adopted-improvement"
          | "regression";
        title: string;
        detail: string;
        attentionId?: string;
      }> = [];
      for (const item of state.attention) {
        if (item.status !== "open") continue;
        if (item.kind === "approval-required") {
          notices.push({
            id: `notice-${item.id}`,
            category: "approval-required",
            title: item.title,
            detail: item.rationale,
            attentionId: item.id,
          });
        } else if (item.kind === "escalation") {
          notices.push({
            id: `notice-${item.id}`,
            category: "material-failure",
            title: item.title,
            detail: item.rationale,
            attentionId: item.id,
          });
        }
      }
      for (const experiment of state.experiments) {
        if (Date.parse(experiment.testedAt) < dayAgo) continue;
        if (experiment.adopted) {
          const proposal = state.proposals.find(
            (p) => p.id === experiment.proposalId,
          );
          notices.push({
            id: `notice-${experiment.id}`,
            category: "adopted-improvement",
            title: proposal?.title ?? "Improvement adopted",
            detail: experiment.summary,
          });
        }
      }
      for (const diagnosis of state.diagnoses) {
        if (Date.parse(diagnosis.diagnosedAt) < dayAgo) continue;
        if (
          diagnosis.class === "latency-regression" ||
          (diagnosis.class === "expensive-model-for-trivial-task" &&
            diagnosis.confidence >= 0.9)
        ) {
          notices.push({
            id: `notice-${diagnosis.id}`,
            category: "regression",
            title: diagnosis.summary,
            detail: diagnosis.evidence.join(", ").slice(0, 300),
          });
        }
      }
      return {
        openAttention: state.attention.filter((a) => a.status === "open")
          .length,
        adoptedChanges: state.proposals.filter((p) => p.status === "adopted")
          .length,
        revertedChanges: state.proposals.filter((p) => p.status === "reverted")
          .length,
        autoFixed: state.proposals.filter(
          (p) => p.status === "adopted" && p.safety === "autonomous-safe",
        ).length,
        recentExperiments: state.experiments.slice(0, 10).map((e) => e.summary),
        notices,
        attention: state.attention
          .filter((a) => a.status === "open")
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            title: a.title,
            rationale: a.rationale,
            status: a.status,
          })),
      };
    },
    async resolveAttention(input) {
      const state = await loadState();
      const item = state.attention.find((a) => a.id === input.attentionId);
      if (!item)
        throw new Error(`attention item not found: ${input.attentionId}`);
      if (item.status !== "open")
        throw new Error(`attention item already ${item.status}`);
      item.status = input.decision;
      item.resolvedAt = now();
      if (item.proposalId) {
        const proposal = state.proposals.find((p) => p.id === item.proposalId);
        if (proposal) {
          proposal.status =
            input.decision === "approved" ? "adopted" : "rejected";
        }
      }
      await saveState(state);
      return { ok: true as const };
    },
  });
}
