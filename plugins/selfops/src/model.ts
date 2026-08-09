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

export {
  DEFAULT_THRESHOLDS,
  diagnoseObservations,
  evaluateExperiment,
  heldOutTasksFromHistory,
  isTrustBoundaryChange,
  learnPreferences,
  newId,
  proposeImprovement,
  updateModelRouting,
} from "@bb/plugin-sdk";

export type {
  CandidateRun,
  ChangeSafety,
  Diagnosis,
  DiagnosisClass,
  DiagnosisThresholds,
  ExperimentResult,
  HeldOutTask,
  HumanAttentionItem,
  ImprovementProposal,
  LearnedPreference,
  ObservationKind,
  SystemObservation,
} from "@bb/plugin-sdk";
