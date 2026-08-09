/** Generic persistent autonomy contract for BB-generated tools. */
export type GeneratedToolSourceKind =
  | "email"
  | "calendar"
  | "meeting-transcript"
  | "contacts"
  | "files"
  | "web"
  | "custom";

export type GeneratedToolCapabilityBinding = {
  id: string;
  role: "source" | "infrastructure" | "action-channel";
  kind: string;
  label: string;
  enabled: boolean;
  /** Adapter-owned resource reference; credentials remain in BB's connector layer. */
  resource?: string;
  scopes: string[];
};

/** A binding to a BB/shared connector. No generated tool embeds credentials. */
export type GeneratedToolSourceBinding = {
  id: string;
  kind: GeneratedToolSourceKind;
  label: string;
  enabled: boolean;
  /** Connector-owned account/resource reference, never a credential. */
  resource?: string;
  scopes: string[];
};

export type GeneratedToolPermissionModel = {
  /** Read/consume events and information from these bound source ids. */
  observe: { sourceIds: string[] };
  /** Reconcile evidence into agent-maintained state. */
  internalState: "automatic" | "recommend-only";
  /** Evolve the generated tool definition/presentation within host-safe primitives. */
  evolvePresentation: "automatic" | "recommend-only" | "disabled";
  /** Draft messages/forms/transactions without committing them externally. */
  prepareExternalActions: "automatic" | "recommend-only" | "disabled";
  /** The hard boundary: execution is either disabled or individually approved. */
  executeConsequentialActions: "require-approval" | "disabled";
};

export type GeneratedToolAutonomyPolicy = {
  enabled: boolean;
  goal: string;
  constraints: string[];
  cadenceMinutes: number;
  permissions: GeneratedToolPermissionModel;
};

export type GeneratedToolSignal = {
  id: string;
  /** One normalized signal may reconcile into several workspace projections. */
  targetWorkspaceIds: string[];
  /** Canonical entity/workstream references used for cross-workspace routing. */
  entityRefs: string[];
  sourceBindingId: string;
  sourceKind: GeneratedToolSourceKind;
  fingerprint: string;
  observedAt: string;
  title: string;
  summary: string;
  evidence: string[];
  reconciledAt?: string;
};

export type GeneratedToolAutonomyRun = {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  workerThreadId?: string;
  summary?: string;
  error?: string;
};

export type GeneratedToolRecommendation = {
  id: string;
  kind: "recommendation" | "exception" | "external-action";
  title: string;
  rationale: string;
  evidence: string[];
  proposedAction?: string;
  externalActionId?: string;
  status: "open" | "approved" | "rejected" | "resolved";
  createdAt: string;
  resolvedAt?: string;
};

export type GeneratedToolAutonomyState = {
  policy: GeneratedToolAutonomyPolicy;
  capabilities: GeneratedToolCapabilityBinding[];
  goals: GeneratedGoalState[];
  entities: GeneratedEntityMemory[];
  opportunities: GeneratedOpportunity[];
  externalActions: GeneratedExternalAction[];
  outcomes: GeneratedOutcomeEvaluation[];
  sources: GeneratedToolSourceBinding[];
  signals: GeneratedToolSignal[];
  runs: GeneratedToolAutonomyRun[];
  recommendations: GeneratedToolRecommendation[];
};

export const DEFAULT_GENERATED_TOOL_PERMISSION_MODEL: GeneratedToolPermissionModel =
  {
    observe: { sourceIds: [] },
    internalState: "automatic",
    evolvePresentation: "automatic",
    prepareExternalActions: "automatic",
    executeConsequentialActions: "require-approval",
  };

export const DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY: GeneratedToolAutonomyPolicy =
  {
    enabled: false,
    goal: "",
    constraints: [],
    cadenceMinutes: 30,
    permissions: DEFAULT_GENERATED_TOOL_PERMISSION_MODEL,
  };

export function buildGeneratedToolAutonomyPrompt(args: {
  workspaceId: string;
  title: string;
  policy: GeneratedToolAutonomyPolicy;
  sources?: GeneratedToolSourceBinding[];
  capabilities?: GeneratedToolCapabilityBinding[];
}): string {
  const sources = (args.sources ?? []).filter(
    (source) =>
      source.enabled &&
      args.policy.permissions.observe.sourceIds.includes(source.id),
  );
  const capabilities = (args.capabilities ?? []).filter(
    (binding) => binding.enabled,
  );
  return `[BB generated-tool autonomy cycle]

Workspace projection: ${args.title} (${args.workspaceId})
Goal: ${args.policy.goal || "Keep the agent-maintained state accurate, current, and decision-ready."}
Constraints:
${args.policy.constraints.length ? args.policy.constraints.map((item) => `- ${item}`).join("\n") : "- Preserve provenance and do not invent facts."}
Observable shared sources:
${sources.length ? sources.map((source) => `- ${source.id}: ${source.kind} (${source.label}); scopes=${source.scopes.join(",") || "default"}`).join("\n") : "- No connector source is currently granted. Use only workspace state and generally available tools."}
Shared capability adapters:
${capabilities.length ? capabilities.map((binding) => `- ${binding.id}: ${binding.role}/${binding.kind} (${binding.label}); scopes=${binding.scopes.join(",") || "default"}`).join("\n") : "- No additional infrastructure or action channels are bound."}
Permissions:
- Observe: only the source bindings listed above.
- Internal state: ${args.policy.permissions.internalState}.
- Evolve generated-tool presentation: ${args.policy.permissions.evolvePresentation}.
- Prepare external actions: ${args.policy.permissions.prepareExternalActions}.
- Execute consequential external actions: ${args.policy.permissions.executeConsequentialActions}.

The workspace is a human-facing projection of agent-maintained state, not an isolated database. Consume available connector events and information, normalize evidence, deduplicate it by source/fingerprint, and reconcile it into maintained state. Source, research, verify, enrich, classify, prioritize, and advance records when supported by evidence. Surface material recommendations, uncertainty, stale data, exceptions, and decisions.

Persistent operation loop: read active goals and entity memory; consume new signals; discover/research/score opportunities; choose the highest-value safe next action; execute permitted internal work; evaluate outcomes against goal success criteria; update memory and progress; surface only attention-worthy exceptions, approvals, or high-value actions. For an external side effect, first create an idempotent action proposal, wait for approval, atomically claim the approved action before executing through a shared connector/tool, and record its outcome afterward. Never infer approval from conversation context or a general connector grant.

Never bypass the permission levels. Observation does not imply mutation. Internal mutation does not imply permission to evolve the human-facing tool definition or act externally. Presentation evolution is limited to generated-tool definitions and host-safe primitives; never modify BB platform/runtime infrastructure unless explicitly asked in a development context. Preparing a draft does not authorize execution. Never perform a consequential external action (sending messages, applying, purchasing, publishing, committing on the human's behalf, or changing an external system) unless its individual proposal has explicit human approval; when execution is disabled, do not execute even after preparation. Do not ask the human to perform clerical maintenance. End with a concise run summary.`;
}

export type GeneratedOperationsBrief = {
  generatedAt: string;
  changedWorkspaceIds: string[];
  goals: Array<{
    workspaceId: string;
    goalId: string;
    objective: string;
    status: GeneratedGoalState["status"];
    progress: number;
    assessment?: string;
  }>;
  handled: Array<{ workspaceId: string; summary: string }>;
  outcomes: Array<{
    workspaceId: string;
    outcomeId: string;
    result: GeneratedOutcomeEvaluation["result"];
    assessment: string;
    observedAt: string;
  }>;
  attention: Array<{
    workspaceId: string;
    recommendationId: string;
    kind: GeneratedToolRecommendation["kind"];
    title: string;
    rationale: string;
    status: GeneratedToolRecommendation["status"];
  }>;
};

/** Domain-neutral cross-workspace rollup for the human orchestrator. */
export function buildGeneratedOperationsBrief(
  projections: Array<{
    workspaceId: string;
    autonomy?: GeneratedToolAutonomyState;
  }>,
): GeneratedOperationsBrief {
  const goals: GeneratedOperationsBrief["goals"] = [];
  const handled: GeneratedOperationsBrief["handled"] = [];
  const outcomes: GeneratedOperationsBrief["outcomes"] = [];
  const attention: GeneratedOperationsBrief["attention"] = [];
  const changed = new Set<string>();
  for (const projection of projections) {
    const state = projection.autonomy;
    if (!state) continue;
    for (const goal of state.goals.filter((candidate) =>
      ["active", "blocked", "achieved"].includes(candidate.status),
    )) {
      goals.push({
        workspaceId: projection.workspaceId,
        goalId: goal.id,
        objective: goal.objective,
        status: goal.status,
        progress: goal.progress,
        assessment: goal.assessment,
      });
      if (goal.status === "blocked") changed.add(projection.workspaceId);
    }
    for (const outcome of state.outcomes.slice(0, 5)) {
      outcomes.push({
        workspaceId: projection.workspaceId,
        outcomeId: outcome.id,
        result: outcome.result,
        assessment: outcome.assessment,
        observedAt: outcome.observedAt,
      });
      changed.add(projection.workspaceId);
    }
    const latest = state.runs[0];
    if (latest?.status === "completed" && latest.summary) {
      handled.push({
        workspaceId: projection.workspaceId,
        summary: latest.summary,
      });
      changed.add(projection.workspaceId);
    }
    for (const item of state.recommendations.filter(
      (candidate) => candidate.status === "open",
    )) {
      attention.push({
        workspaceId: projection.workspaceId,
        recommendationId: item.id,
        kind: item.kind,
        title: item.title,
        rationale: item.rationale,
        status: item.status,
      });
      changed.add(projection.workspaceId);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    changedWorkspaceIds: [...changed],
    goals,
    handled,
    outcomes,
    attention,
  };
}

export type GeneratedToolCapabilityRequest =
  | { capability: "observe"; sourceId: string }
  | { capability: "modify-internal-state" }
  | { capability: "evolve-presentation" }
  | { capability: "prepare-external-action" }
  | {
      capability: "execute-consequential-action";
      proposalStatus: GeneratedToolRecommendation["status"];
    };

/** Central policy decision used by connector/action adapters before side effects. */
export function generatedToolCapabilityAllowed(
  permissions: GeneratedToolPermissionModel,
  request: GeneratedToolCapabilityRequest,
): boolean {
  switch (request.capability) {
    case "observe":
      return permissions.observe.sourceIds.includes(request.sourceId);
    case "modify-internal-state":
      return permissions.internalState === "automatic";
    case "evolve-presentation":
      return permissions.evolvePresentation === "automatic";
    case "prepare-external-action":
      return permissions.prepareExternalActions === "automatic";
    case "execute-consequential-action":
      return (
        permissions.executeConsequentialActions === "require-approval" &&
        request.proposalStatus === "approved"
      );
  }
}

export type GeneratedGoalState = {
  id: string;
  objective: string;
  successCriteria: string[];
  status: "active" | "paused" | "achieved" | "blocked";
  progress: number;
  lastEvaluatedAt?: string;
  assessment?: string;
};

export type GeneratedEntityFact = {
  key: string;
  value: string;
  confidence: number;
  evidence: string[];
  observedAt: string;
};

export type GeneratedEntityMemory = {
  ref: string;
  kind: string;
  label: string;
  aliases: string[];
  facts: GeneratedEntityFact[];
  updatedAt: string;
};

export type GeneratedOpportunity = {
  id: string;
  entityRefs: string[];
  title: string;
  hypothesis: string;
  evidence: string[];
  score: number;
  status:
    | "discovered"
    | "researching"
    | "qualified"
    | "advanced"
    | "dismissed"
    | "completed";
  nextAction?: string;
  discoveredAt: string;
  updatedAt: string;
};

export type GeneratedExternalAction = {
  id: string;
  idempotencyKey: string;
  title: string;
  actionType: string;
  channelBindingId: string;
  target: string;
  payloadSummary: string;
  rationale: string;
  evidence: string[];
  status:
    | "proposed"
    | "approved"
    | "rejected"
    | "executing"
    | "succeeded"
    | "failed";
  createdAt: string;
  approvedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  attempts: number;
  lastError?: string;
  outcome?: string;
};

export type GeneratedOutcomeEvaluation = {
  id: string;
  goalId?: string;
  actionId?: string;
  observedAt: string;
  result: "positive" | "negative" | "neutral" | "unknown";
  assessment: string;
  evidence: string[];
  followUp?: string;
};
