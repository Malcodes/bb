import {
  DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY,
  buildGeneratedOperationsBrief,
  buildGeneratedToolAutonomyPrompt,
  defineRpcContract,
  generatedToolCapabilityAllowed,
  type BbPluginApi,
  type GeneratedToolAutonomyState,
  type GeneratedToolSignal,
} from "@bb/plugin-sdk";
import { z } from "zod";
import {
  applyMutation,
  newId,
  upgradeLegacyMetrics,
  type Mutation,
  type Workspace,
} from "./src/model.js";
import {
  createWorkspaceInputSchema,
  mutationSchema,
  workspaceSchema,
} from "./src/schemas.js";
import { SALES_AGENT_INSTRUCTIONS } from "./src/instructions.js";
import { workspaceDirective } from "./src/workspace-directive.js";

const WORKSPACES_KEY = "workspaces";
const OPERATIONS_SIGNALS_KEY = "generated-operations-signals";
const SIGNAL_CHANNEL = "workspaces-changed";
const pinnedItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    icon: z.string(),
    subPath: z.string(),
    navOrder: z.number(),
  })
  .strict();

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const salesRpcContract = defineRpcContract({
  getWorkspace: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: workspaceSchema.strict(),
  },
  mutate: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative().optional(),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
  setPinned: {
    input: z
      .object({ workspaceId: z.string().min(1), pinned: z.boolean() })
      .strict(),
    output: workspaceSchema.strict(),
  },
  listPinned: {
    input: z.object({}).strict(),
    output: z.object({ items: z.array(pinnedItemSchema) }).strict(),
  },
  reorderPinned: {
    input: z.object({ workspaceIds: z.array(z.string()) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  configureAutonomy: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        enabled: z.boolean(),
        goal: z.string().max(2000),
        constraints: z.array(z.string().max(500)).max(20),
        cadenceMinutes: z.number().int().min(5).max(1440),
        sourceBindings: z
          .array(
            z
              .object({
                id: z.string().min(1),
                kind: z.enum([
                  "email",
                  "calendar",
                  "meeting-transcript",
                  "contacts",
                  "files",
                  "web",
                  "custom",
                ]),
                label: z.string().min(1),
                enabled: z.boolean(),
                resource: z.string().optional(),
                scopes: z.array(z.string()),
              })
              .strict(),
          )
          .max(50),
        permissions: z
          .object({
            observe: z.object({ sourceIds: z.array(z.string()) }).strict(),
            internalState: z.enum(["automatic", "recommend-only"]),
            prepareExternalActions: z.enum([
              "automatic",
              "recommend-only",
              "disabled",
            ]),
            executeConsequentialActions: z.enum([
              "require-approval",
              "disabled",
            ]),
          })
          .strict(),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
  resolveRecommendation: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        recommendationId: z.string().min(1),
        decision: z.enum(["approved", "rejected", "resolved"]),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  // Serialize all read-modify-write transactions. Revisions then reliably
  // reject stale UI writes instead of allowing simultaneous human/agent turns
  // to overwrite each other between KV reads.
  let writeTail: Promise<void> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = writeTail.then(task, task);
    writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function autonomy(ws: Workspace): GeneratedToolAutonomyState {
    if (!ws.autonomy) {
      ws.autonomy = {
        policy: structuredClone(DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY),
        sources: [],
        signals: [],
        runs: [],
        recommendations: [],
      };
    }
    const legacy = ws.autonomy as GeneratedToolAutonomyState & {
      policy: GeneratedToolAutonomyState["policy"] & {
        internalActions?: "automatic" | "recommend-only";
        externalActions?: "require-approval";
      };
      sources?: GeneratedToolAutonomyState["sources"];
      signals?: GeneratedToolAutonomyState["signals"];
    };
    legacy.sources ??= [];
    legacy.signals ??= [];
    legacy.policy.permissions ??= {
      observe: {
        sourceIds: legacy.sources
          .filter((source) => source.enabled)
          .map((source) => source.id),
      },
      internalState: legacy.policy.internalActions ?? "automatic",
      prepareExternalActions: "automatic",
      executeConsequentialActions:
        legacy.policy.externalActions ?? "require-approval",
    };
    delete legacy.policy.internalActions;
    delete legacy.policy.externalActions;
    return legacy;
  }

  async function loadOperationSignals(): Promise<GeneratedToolSignal[]> {
    return (
      (await bb.storage.kv.get<GeneratedToolSignal[]>(
        OPERATIONS_SIGNALS_KEY,
      )) ?? []
    );
  }
  async function saveOperationSignals(
    signals: GeneratedToolSignal[],
  ): Promise<void> {
    await bb.storage.kv.set(OPERATIONS_SIGNALS_KEY, signals.slice(0, 2000));
  }

  async function loadAll(): Promise<Workspace[]> {
    const raw =
      (await bb.storage.kv.get<Array<Partial<Workspace> & { id: string }>>(
        WORKSPACES_KEY,
      )) ?? [];
    // Non-destructive migration from the thread-contained prototype.
    return raw.map((ws, index) => {
      const workspace = {
        ...ws,
        originThreadId:
          ws.originThreadId ??
          (ws as { threadId?: string }).threadId ??
          "legacy",
        pinnedAt: ws.pinnedAt ?? null,
        navOrder: ws.navOrder ?? index,
        revision: ws.revision ?? 0,
      } as Workspace;
      upgradeLegacyMetrics(workspace);
      return workspace;
    });
  }
  async function saveAll(workspaces: Workspace[]): Promise<void> {
    await bb.storage.kv.set(WORKSPACES_KEY, workspaces);
  }
  async function getWorkspace(workspaceId: string): Promise<Workspace> {
    const ws = (await loadAll()).find((item) => item.id === workspaceId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    return ws;
  }
  function changed(workspaceId?: string): void {
    bb.realtime.publish(SIGNAL_CHANNEL, { workspaceId, at: Date.now() });
  }
  async function applyMutations(
    workspaceId: string,
    mutations: Mutation[],
    expectedRevision?: number,
  ): Promise<Workspace> {
    const all = await loadAll();
    const ws = all.find((item) => item.id === workspaceId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    if (expectedRevision !== undefined && expectedRevision !== ws.revision) {
      throw new Error(
        `workspace changed; expected revision ${expectedRevision}, current ${ws.revision}`,
      );
    }
    for (const mutation of mutations) {
      if (mutation.workspaceId !== workspaceId)
        throw new Error("mutation workspaceId mismatch");
      applyMutation(ws, mutation);
    }
    ws.revision += 1;
    ws.updatedAt = new Date().toISOString();
    await saveAll(all);
    changed(workspaceId);
    return ws;
  }
  async function createWorkspace(
    threadId: string,
    input: z.infer<typeof createWorkspaceInputSchema>,
  ): Promise<Workspace> {
    const all = await loadAll();
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: newId("ws"),
      originThreadId: threadId,
      pinnedAt: null,
      navOrder: all.filter((item) => item.pinnedAt).length,
      revision: 0,
      title: input.title,
      description: input.description,
      icon: input.icon,
      createdAt: now,
      updatedAt: now,
      collections: input.collections,
      views: input.views.map((view) => ({
        ...view,
        id: view.id ?? newId("view"),
      })),
    };
    all.push(ws);
    await saveAll(all);
    changed(ws.id);
    return ws;
  }
  async function setPinned(
    workspaceId: string,
    pinned: boolean,
  ): Promise<Workspace> {
    const all = await loadAll();
    const ws = all.find((item) => item.id === workspaceId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    ws.pinnedAt = pinned ? new Date().toISOString() : null;
    if (pinned)
      ws.navOrder = all.filter(
        (item) => item.pinnedAt && item.id !== ws.id,
      ).length;
    ws.revision += 1;
    ws.updatedAt = new Date().toISOString();
    await saveAll(all);
    changed(workspaceId);
    return ws;
  }
  async function reorderPinned(workspaceIds: readonly string[]): Promise<void> {
    const all = await loadAll();
    const order = new Map(workspaceIds.map((id, index) => [id, index]));
    for (const ws of all) {
      const next = order.get(ws.id);
      if (ws.pinnedAt && next !== undefined) ws.navOrder = next;
    }
    await saveAll(all);
    changed();
  }

  async function updateWorkspace(
    workspaceId: string,
    update: (workspace: Workspace) => void,
  ): Promise<Workspace> {
    return exclusive(async () => {
      const all = await loadAll();
      const workspace = all.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
      update(workspace);
      workspace.revision += 1;
      workspace.updatedAt = new Date().toISOString();
      await saveAll(all);
      changed(workspaceId);
      return workspace;
    });
  }

  async function runAutonomySweep(): Promise<void> {
    const snapshots = await loadAll();
    const now = Date.now();
    for (const snapshot of snapshots) {
      const state = autonomy(snapshot);
      if (!state.policy.enabled) continue;
      if (state.runs.some((run) => run.status === "running")) continue;
      const lastAt = state.runs[0] ? Date.parse(state.runs[0]!.startedAt) : 0;
      if (now - lastAt < state.policy.cadenceMinutes * 60_000) continue;
      try {
        const origin = await bb.sdk.threads.get({
          threadId: snapshot.originThreadId,
        });
        if (!origin.environmentId) continue;
        const defaults = await bb.sdk.threads.defaultExecutionOptions({
          threadId: snapshot.originThreadId,
        });
        if (!defaults) continue;
        const runId = newId("run");
        const worker = await bb.sdk.threads.spawn({
          projectId: origin.projectId,
          environment: { type: "reuse", environmentId: origin.environmentId },
          prompt: buildGeneratedToolAutonomyPrompt({
            workspaceId: snapshot.id,
            title: snapshot.title,
            policy: state.policy,
            sources: state.sources,
          }),
          title: `${snapshot.title} · operator cycle`,
          providerId: origin.providerId,
          model: defaults.model,
          reasoningLevel: defaults.reasoningLevel,
          permissionMode: "auto",
          visibility: "hidden",
        });
        await updateWorkspace(snapshot.id, (workspace) => {
          const current = autonomy(workspace);
          current.runs.unshift({
            id: runId,
            status: "running",
            startedAt: new Date().toISOString(),
            workerThreadId: worker.id,
          });
          current.runs = current.runs.slice(0, 20);
        });
      } catch (error) {
        bb.log.warn(
          `Could not start autonomy cycle for ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function settleWorker(
    threadId: string,
    status: "completed" | "failed",
    detail: string | null,
  ): Promise<void> {
    await exclusive(async () => {
      const all = await loadAll();
      let changedWorkspace: string | undefined;
      for (const workspace of all) {
        const run = workspace.autonomy?.runs.find(
          (candidate) =>
            candidate.workerThreadId === threadId &&
            candidate.status === "running",
        );
        if (!run) continue;
        run.status = status;
        run.completedAt = new Date().toISOString();
        if (status === "completed") run.summary = detail ?? "Cycle completed.";
        else run.error = detail ?? "Operator cycle failed.";
        workspace.revision += 1;
        workspace.updatedAt = new Date().toISOString();
        changedWorkspace = workspace.id;
        break;
      }
      if (!changedWorkspace) return;
      await saveAll(all);
      changed(changedWorkspace);
    });
  }

  bb.background.schedule(
    "generated-tool-operator-sweep",
    "*/5 * * * *",
    runAutonomySweep,
  );
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    settleWorker(thread.id, "completed", lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    settleWorker(thread.id, "failed", error),
  );

  bb.agents.registerTool({
    name: "sales_list_workspaces",
    description:
      "List persistent native work surfaces created from this thread plus pinned tools.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      return JSON.stringify(
        (await loadAll())
          .filter(
            (ws) =>
              ws.originThreadId === context.threadId || ws.pinnedAt !== null,
          )
          .map((ws) => ({
            id: ws.id,
            title: ws.title,
            pinned: ws.pinnedAt !== null,
            revision: ws.revision,
          })),
      );
    },
  });
  bb.agents.registerTool({
    name: "sales_read_workspace",
    description:
      "Read a native work surface's current collections, views, and revision.",
    parameters: z.object({ workspaceId: z.string().min(1) }).strict(),
    async execute({ workspaceId }) {
      return JSON.stringify(toJson(await getWorkspace(workspaceId)));
    },
  });
  bb.agents.registerTool({
    name: "sales_create_workspace",
    description:
      "Create a persistent native interactive surface and return its id for ::sales-workspace.",
    parameters: createWorkspaceInputSchema.strict(),
    async execute(input, context) {
      const workspace = await createWorkspace(context.threadId, input);
      return JSON.stringify(
        toJson({
          workspaceId: workspace.id,
          renderDirective: workspaceDirective(workspace.id),
          workspace,
        }),
      );
    },
  });
  bb.agents.registerTool({
    name: "sales_mutate_workspace",
    description:
      "Mutate a work surface through the same path used by inline and full-width UI.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative().optional(),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    async execute({ workspaceId, expectedRevision, mutations }, context) {
      const current = await getWorkspace(workspaceId);
      const isOperator = current.autonomy?.runs.some(
        (run) =>
          run.status === "running" && run.workerThreadId === context.threadId,
      );
      if (
        isOperator &&
        !generatedToolCapabilityAllowed(autonomy(current).policy.permissions, {
          capability: "modify-internal-state",
        })
      ) {
        throw new Error(
          "operator has recommend-only internal-state permission; surface a recommendation instead",
        );
      }
      return JSON.stringify(
        toJson(
          await applyMutations(
            workspaceId,
            mutations as Mutation[],
            expectedRevision,
          ),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_ingest_signal",
    description:
      "Normalize one shared connector event, route it to canonical entities/workstreams and one or more generated-workspace projections, and deduplicate by source fingerprint.",
    parameters: z
      .object({
        targetWorkspaceIds: z.array(z.string().min(1)).min(1).max(50),
        sourceBindingId: z.string().min(1),
        sourceKind: z.enum([
          "email",
          "calendar",
          "meeting-transcript",
          "contacts",
          "files",
          "web",
          "custom",
        ]),
        entityRefs: z.array(z.string().min(1)).max(50),
        fingerprint: z.string().min(1).max(500),
        observedAt: z.string(),
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(2000),
        evidence: z.array(z.string().max(1000)).min(1).max(20),
        reconciled: z.boolean().default(false),
      })
      .strict(),
    async execute(input) {
      const workspaces = await loadAll();
      for (const workspaceId of input.targetWorkspaceIds) {
        const workspace = workspaces.find((item) => item.id === workspaceId);
        if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
        const state = autonomy(workspace);
        const source = state.sources.find(
          (item) =>
            item.id === input.sourceBindingId &&
            item.enabled &&
            item.kind === input.sourceKind,
        );
        if (
          !source ||
          !state.policy.permissions.observe.sourceIds.includes(source.id)
        ) {
          throw new Error(
            `source binding is not granted for observation in ${workspaceId}: ${input.sourceBindingId}`,
          );
        }
      }
      const signals = await loadOperationSignals();
      const existing = signals.find(
        (signal) =>
          signal.sourceBindingId === input.sourceBindingId &&
          signal.fingerprint === input.fingerprint,
      );
      const normalized: GeneratedToolSignal = {
        id: existing?.id ?? newId("sig"),
        targetWorkspaceIds: [...new Set(input.targetWorkspaceIds)],
        entityRefs: [...new Set(input.entityRefs)],
        sourceBindingId: input.sourceBindingId,
        sourceKind: input.sourceKind,
        fingerprint: input.fingerprint,
        observedAt: input.observedAt,
        title: input.title,
        summary: input.summary,
        evidence: input.evidence,
        reconciledAt: input.reconciled
          ? new Date().toISOString()
          : existing?.reconciledAt,
      };
      if (existing) Object.assign(existing, normalized);
      else signals.unshift(normalized);
      await saveOperationSignals(signals);
      for (const workspaceId of normalized.targetWorkspaceIds)
        changed(workspaceId);
      return JSON.stringify(toJson(normalized));
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_read_brief",
    description:
      "Read what agents handled and what requires human attention across all generated workspace projections available here.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const workspaces = (await loadAll()).filter(
        (workspace) =>
          workspace.originThreadId === context.threadId ||
          workspace.pinnedAt !== null,
      );
      return JSON.stringify(
        buildGeneratedOperationsBrief(
          workspaces.map((workspace) => ({
            workspaceId: workspace.id,
            autonomy: workspace.autonomy,
          })),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_tool_configure_autonomy",
    description:
      "Set a generated workspace's persistent operator goal, constraints, cadence, and safe internal-action policy.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        enabled: z.boolean(),
        goal: z.string().max(2000),
        constraints: z.array(z.string().max(500)).max(20),
        cadenceMinutes: z.number().int().min(5).max(1440),
        sourceBindings: z
          .array(
            z
              .object({
                id: z.string().min(1),
                kind: z.enum([
                  "email",
                  "calendar",
                  "meeting-transcript",
                  "contacts",
                  "files",
                  "web",
                  "custom",
                ]),
                label: z.string().min(1),
                enabled: z.boolean(),
                resource: z.string().optional(),
                scopes: z.array(z.string()),
              })
              .strict(),
          )
          .max(50),
        permissions: z
          .object({
            observe: z.object({ sourceIds: z.array(z.string()) }).strict(),
            internalState: z.enum(["automatic", "recommend-only"]),
            prepareExternalActions: z.enum([
              "automatic",
              "recommend-only",
              "disabled",
            ]),
            executeConsequentialActions: z.enum([
              "require-approval",
              "disabled",
            ]),
          })
          .strict(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            autonomy(workspace).sources = input.sourceBindings;
            autonomy(workspace).policy = {
              enabled: input.enabled,
              goal: input.goal,
              constraints: input.constraints,
              cadenceMinutes: input.cadenceMinutes,
              permissions: input.permissions,
            };
          }),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_tool_report_recommendation",
    description:
      "Surface a recommendation, exception, or consequential external-action proposal with evidence. External actions always await human approval.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        kind: z.enum(["recommendation", "exception", "external-action"]),
        title: z.string().min(1).max(200),
        rationale: z.string().min(1).max(2000),
        evidence: z.array(z.string().max(1000)).min(1).max(20),
        proposedAction: z.string().max(1000).optional(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            autonomy(workspace).recommendations.unshift({
              id: newId("rec"),
              kind: input.kind,
              title: input.title,
              rationale: input.rationale,
              evidence: input.evidence,
              proposedAction: input.proposedAction,
              status: "open",
              createdAt: new Date().toISOString(),
            });
            autonomy(workspace).recommendations = autonomy(
              workspace,
            ).recommendations.slice(0, 100);
          }),
        ),
      );
    },
  });

  bb.agents.configure(() => ({
    tools: [
      "sales_list_workspaces",
      "sales_read_workspace",
      "sales_create_workspace",
      "sales_mutate_workspace",
      "generated_tool_configure_autonomy",
      "generated_tool_report_recommendation",
      "generated_operations_ingest_signal",
      "generated_operations_read_brief",
    ],
    skills: [],
    instructions: SALES_AGENT_INSTRUCTIONS,
  }));

  bb.rpc.register(salesRpcContract, {
    async getWorkspace({ workspaceId }) {
      return toJson(await getWorkspace(workspaceId));
    },
    async mutate({ workspaceId, expectedRevision, mutations }) {
      return toJson(
        await exclusive(() =>
          applyMutations(
            workspaceId,
            mutations as Mutation[],
            expectedRevision,
          ),
        ),
      );
    },
    async setPinned({ workspaceId, pinned }) {
      return toJson(await exclusive(() => setPinned(workspaceId, pinned)));
    },
    async listPinned() {
      const items = (await loadAll())
        .filter((ws) => ws.pinnedAt !== null)
        .sort((a, b) => a.navOrder - b.navOrder)
        .map((ws) => ({
          id: ws.id,
          title: ws.title,
          icon: ws.icon ?? "Kanban",
          subPath: ws.id,
          navOrder: ws.navOrder,
        }));
      return { items };
    },
    async reorderPinned({ workspaceIds }) {
      await exclusive(() => reorderPinned(workspaceIds));
      return { ok: true as const };
    },
    async configureAutonomy(input) {
      return toJson(
        await updateWorkspace(input.workspaceId, (workspace) => {
          autonomy(workspace).sources = input.sourceBindings;
          autonomy(workspace).policy = {
            enabled: input.enabled,
            goal: input.goal,
            constraints: input.constraints,
            cadenceMinutes: input.cadenceMinutes,
            permissions: input.permissions,
          };
        }),
      );
    },
    async resolveRecommendation({ workspaceId, recommendationId, decision }) {
      return toJson(
        await updateWorkspace(workspaceId, (workspace) => {
          const recommendation = autonomy(workspace).recommendations.find(
            (item) => item.id === recommendationId,
          );
          if (!recommendation)
            throw new Error(`recommendation not found: ${recommendationId}`);
          recommendation.status = decision;
          recommendation.resolvedAt = new Date().toISOString();
        }),
      );
    },
  });
}
