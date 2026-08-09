/**
 * The self-ops loop: observe → diagnose → hypothesize → change → test →
 * measure → keep/revert, split into Maintainer and Optimizer responsibilities.
 *
 * This module is pure: the server supplies storage, telemetry collectors, and
 * appliers; tests supply deterministic fakes.
 */
import {
  DEFAULT_THRESHOLDS,
  diagnoseObservations,
  evaluateExperiment,
  learnPreferences,
  proposeImprovement,
  updateModelRouting,
  type CandidateRun,
  type Diagnosis,
  type DiagnosisThresholds,
  type ExperimentResult,
  type HeldOutTask,
  type HumanAttentionItem,
  type ImprovementProposal,
  type LearnedPreference,
  type SystemObservation,
} from "./model.js";

export interface SelfOpsState {
  observations: SystemObservation[];
  diagnoses: Diagnosis[];
  proposals: ImprovementProposal[];
  experiments: ExperimentResult[];
  preferences: LearnedPreference[];
  attention: HumanAttentionItem[];
  /** Subjects already diagnosed for their current evidence batch (dedupe). */
  handledFingerprints: string[];
}

export function emptySelfOpsState(): SelfOpsState {
  return {
    observations: [],
    diagnoses: [],
    proposals: [],
    experiments: [],
    preferences: [],
    attention: [],
    handledFingerprints: [],
  };
}

function fingerprint(obs: SystemObservation[]): string {
  return obs
    .map((o) => o.id)
    .sort()
    .join("|");
}

export interface LoopHooks {
  /** Run the proposal against held-out tasks; production replays real traces. */
  runExperiment(input: {
    proposal: ImprovementProposal;
    heldOut: HeldOutTask[];
  }): Promise<{ baseline: CandidateRun[]; candidate: CandidateRun[] }>;
  /** Apply an autonomous-safe change. Returns a human-readable receipt. */
  applyAutonomousFix(proposal: ImprovementProposal): Promise<string>;
  /**
   * Capture the value an autonomous change replaces, for the audit record and
   * rollback. Returns undefined when nothing pre-exists.
   */
  capturePriorValue?(
    proposal: ImprovementProposal,
  ): Promise<string | undefined>;
  /** Revert an autonomous change to its captured prior value. */
  rollbackAutonomousFix?(proposal: ImprovementProposal): Promise<string>;
  /** Held-out task registry, keyed by change kind. */
  heldOutTasks(changeKind: string): HeldOutTask[];
  now(): string;
  thresholds?: DiagnosisThresholds;
}

export interface LoopOutcome {
  state: SelfOpsState;
  newDiagnoses: Diagnosis[];
  newProposals: ImprovementProposal[];
  autoFixed: Array<{ proposalId: string; receipt: string }>;
  tested: ExperimentResult[];
  escalated: HumanAttentionItem[];
}

/**
 * One full loop turn over newly observed evidence. Idempotent: already-handled
 * evidence fingerprints produce nothing new.
 */
export async function runSelfOpsLoop(
  state: SelfOpsState,
  newEvidence: SystemObservation[],
  hooks: LoopHooks,
): Promise<LoopOutcome> {
  const now = hooks.now();
  const thresholds = hooks.thresholds ?? DEFAULT_THRESHOLDS;
  const fresh = newEvidence.filter(
    (o) =>
      !state.handledFingerprints.some((fp) => fp.split("|").includes(o.id)),
  );
  if (fresh.length === 0) {
    return {
      state,
      newDiagnoses: [],
      newProposals: [],
      autoFixed: [],
      tested: [],
      escalated: [],
    };
  }

  state.observations.push(...fresh);
  state.observations = state.observations.slice(-5_000);
  state.handledFingerprints.push(fingerprint(fresh));
  state.handledFingerprints = state.handledFingerprints.slice(-200);

  // Maintainer: diagnose operational weaknesses.
  const diagnoses = diagnoseObservations(fresh, { ...thresholds, now });
  state.diagnoses.unshift(...diagnoses);

  const newProposals: ImprovementProposal[] = [];
  const autoFixed: LoopOutcome["autoFixed"] = [];
  const tested: ExperimentResult[] = [];
  const escalated: HumanAttentionItem[] = [];

  for (const diagnosis of diagnoses) {
    // Hypothesize a bounded change.
    const proposal = proposeImprovement(diagnosis, now);
    state.proposals.unshift(proposal);
    newProposals.push(proposal);

    if (proposal.safety === "approval-required") {
      const item: HumanAttentionItem = {
        id: `att-${proposal.id}`,
        source: "maintainer",
        kind: "approval-required",
        title: proposal.title,
        rationale: proposal.rationale,
        evidence: diagnosis.evidence,
        proposalId: proposal.id,
        status: "open",
        createdAt: now,
      };
      state.attention.unshift(item);
      escalated.push(item);
      continue;
    }

    if (proposal.safety === "autonomous-safe") {
      // Maintainer routine repair: apply, then verify on the next observation
      // pass (failure recurs → diagnosis reopens with new evidence).
      // Auditable before/after: capture what this change replaces before
      // applying, so the proposal record is itself the rollback path.
      const prior = hooks.capturePriorValue
        ? await hooks.capturePriorValue(proposal)
        : undefined;
      if (prior !== undefined) proposal.change.payload.priorValue = prior;
      proposal.change.payload.appliedAt = now;
      const receipt = await hooks.applyAutonomousFix(proposal);
      proposal.status = "adopted";
      autoFixed.push({ proposalId: proposal.id, receipt });
      continue;
    }

    // Tested change: measure against held-out/historical tasks before keeping.
    const heldOut = hooks.heldOutTasks(proposal.change.kind);
    proposal.status = "testing";
    const runs = await hooks.runExperiment({ proposal, heldOut });
    const result = evaluateExperiment({
      proposal,
      baselineRuns: runs.baseline,
      candidateRuns: runs.candidate,
      minReliability: thresholds.minReliability,
      now,
    });
    state.experiments.unshift(result);
    tested.push(result);
    proposal.status = result.adopted ? "adopted" : "reverted";
    state.preferences = updateModelRouting(
      state.preferences,
      proposal,
      result,
      now,
    );
    if (!result.adopted && proposal.expectedMetric === "reliability") {
      escalated.push({
        id: `att-${proposal.id}`,
        source: "maintainer",
        kind: "escalation",
        title: `Could not safely repair ${diagnosis.subject}`,
        rationale: result.summary,
        evidence: diagnosis.evidence,
        proposalId: proposal.id,
        status: "open",
        createdAt: now,
      });
      state.attention.unshift(escalated[escalated.length - 1]);
    }
  }

  // Optimizer: learn from human corrections/approvals in this batch.
  const learned = learnPreferences(fresh, now);
  for (const pref of learned) {
    const existing = state.preferences.findIndex((p) => p.key === pref.key);
    if (existing >= 0) state.preferences[existing] = pref;
    else state.preferences.push(pref);
  }

  return {
    state,
    newDiagnoses: diagnoses,
    newProposals,
    autoFixed,
    tested,
    escalated,
  };
}

/** Roll back an adopted autonomous-safe change to its captured prior value. */
export async function rollbackAutonomousChange(
  state: SelfOpsState,
  proposalId: string,
  hooks: LoopHooks,
): Promise<ImprovementProposal> {
  const proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  if (proposal.safety !== "autonomous-safe") {
    throw new Error("only autonomous-safe changes carry a rollback path");
  }
  if (proposal.status !== "adopted") {
    throw new Error(`cannot roll back proposal in status ${proposal.status}`);
  }
  if (!hooks.rollbackAutonomousFix) {
    throw new Error("no rollback applier is registered");
  }
  await hooks.rollbackAutonomousFix(proposal);
  proposal.status = "reverted";
  proposal.change.payload.revertedAt = hooks.now();
  return proposal;
}
