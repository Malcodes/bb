/** Generic persistent autonomy contract for BB-generated tools. */
export type GeneratedToolSourceKind =
  | "email"
  | "calendar"
  | "meeting-transcript"
  | "contacts"
  | "files"
  | "web"
  | "custom";

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
  status: "open" | "approved" | "rejected" | "resolved";
  createdAt: string;
  resolvedAt?: string;
};

export type GeneratedToolAutonomyState = {
  policy: GeneratedToolAutonomyPolicy;
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
}): string {
  const sources = (args.sources ?? []).filter(
    (source) =>
      source.enabled &&
      args.policy.permissions.observe.sourceIds.includes(source.id),
  );
  return `[BB generated-tool autonomy cycle]

Workspace projection: ${args.title} (${args.workspaceId})
Goal: ${args.policy.goal || "Keep the agent-maintained state accurate, current, and decision-ready."}
Constraints:
${args.policy.constraints.length ? args.policy.constraints.map((item) => `- ${item}`).join("\n") : "- Preserve provenance and do not invent facts."}
Observable shared sources:
${sources.length ? sources.map((source) => `- ${source.id}: ${source.kind} (${source.label}); scopes=${source.scopes.join(",") || "default"}`).join("\n") : "- No connector source is currently granted. Use only workspace state and generally available tools."}
Permissions:
- Observe: only the source bindings listed above.
- Internal state: ${args.policy.permissions.internalState}.
- Evolve generated-tool presentation: ${args.policy.permissions.evolvePresentation}.
- Prepare external actions: ${args.policy.permissions.prepareExternalActions}.
- Execute consequential external actions: ${args.policy.permissions.executeConsequentialActions}.

The workspace is a human-facing projection of agent-maintained state, not an isolated database. Consume available connector events and information, normalize evidence, deduplicate it by source/fingerprint, and reconcile it into maintained state. Source, research, verify, enrich, classify, prioritize, and advance records when supported by evidence. Surface material recommendations, uncertainty, stale data, exceptions, and decisions.

Never bypass the permission levels. Observation does not imply mutation. Internal mutation does not imply permission to evolve the human-facing tool definition or act externally. Presentation evolution is limited to generated-tool definitions and host-safe primitives; never modify BB platform/runtime infrastructure unless explicitly asked in a development context. Preparing a draft does not authorize execution. Never perform a consequential external action (sending messages, applying, purchasing, publishing, committing on the human's behalf, or changing an external system) unless its individual proposal has explicit human approval; when execution is disabled, do not execute even after preparation. Do not ask the human to perform clerical maintenance. End with a concise run summary.`;
}

export type GeneratedOperationsBrief = {
  generatedAt: string;
  changedWorkspaceIds: string[];
  handled: Array<{ workspaceId: string; summary: string }>;
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
  const handled: GeneratedOperationsBrief["handled"] = [];
  const attention: GeneratedOperationsBrief["attention"] = [];
  const changed = new Set<string>();
  for (const projection of projections) {
    const state = projection.autonomy;
    if (!state) continue;
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
    handled,
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
