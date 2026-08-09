import {
  DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY,
  buildGeneratedOperationsBrief,
  buildGeneratedToolAutonomyPrompt,
  defineRpcContract,
  executeGoogleWorkAction,
  generatedToolCapabilityAllowed,
  pollGoogleWork,
  type BbPluginApi,
  type GeneratedEntityFact,
  type GoogleWorkCursor,
  type GoogleWorkTransport,
  type GeneratedToolAutonomyState,
  type GeneratedToolSignal,
} from "@bb/plugin-sdk";
import { z } from "zod";
import {
  applyMutation,
  newId,
  upgradeLegacyMetrics,
  validateNativeComposition,
  type Mutation,
  type Workspace,
} from "./src/model.js";
import {
  createWorkspaceInputSchema,
  mutationSchema,
  presentationMutationSchema,
  workspaceSchema,
} from "./src/schemas.js";
import { SALES_AGENT_INSTRUCTIONS } from "./src/instructions.js";
import { workspaceDirective } from "./src/workspace-directive.js";
import { GoogleApiWorkTransport } from "./src/google-api-transport.js";

const WORKSPACES_KEY = "workspaces";
const SELFOPS_PLUGIN_ID = "selfops";

/** Feed a native-telemetry observation into the selfops layer, best-effort. */
async function emitSelfOpsObservation(
  bb: BbPluginApi,
  observation: {
    id: string;
    kind: string;
    observedAt: string;
    subject: string;
    attributes: Record<string, string | number | boolean>;
  },
): Promise<void> {
  try {
    await bb.sdk.plugins.callRpc({
      pluginId: SELFOPS_PLUGIN_ID,
      method: "ingestObservations",
      input: { observations: [observation] },
      outputSchema: z.object({
        ingested: z.number(),
        diagnoses: z.number(),
        autoFixed: z.number(),
        escalated: z.number(),
      }),
    });
  } catch {
    // selfops absent or not running; telemetry emission must never block work.
  }
}
const OPERATIONS_SIGNALS_KEY = "generated-operations-signals";
const SIGNAL_CHANNEL = "workspaces-changed";
const GOOGLE_CURSOR_KEY = "google-work-cursor";
const GOOGLE_CONNECTOR_PLUGIN_ID = "google-workspace";
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
        capabilityBindings: z
          .array(
            z
              .object({
                id: z.string().min(1),
                role: z.enum(["source", "infrastructure", "action-channel"]),
                kind: z.string().min(1),
                label: z.string().min(1),
                enabled: z.boolean(),
                resource: z.string().optional(),
                scopes: z.array(z.string()),
              })
              .strict(),
          )
          .max(100)
          .default([]),
        permissions: z
          .object({
            observe: z.object({ sourceIds: z.array(z.string()) }).strict(),
            internalState: z.enum(["automatic", "recommend-only"]),
            evolvePresentation: z.enum([
              "automatic",
              "recommend-only",
              "disabled",
            ]),
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
  resolveAttentionItem: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        itemId: z.string().min(1),
        decision: z.enum(["approved", "rejected", "resolved", "dismissed"]),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
});

export interface SalesPluginOptions {
  googleTransport?: GoogleWorkTransport;
  googleUserEmail?: string;
  googleCalendarIds?: string[];
  now?: () => Date;
}

export default async function plugin(
  bb: BbPluginApi,
  options: SalesPluginOptions = {},
) {
  const googleSettings = bb.settings.define({
    googleAccessToken: {
      type: "string",
      label: "Google OAuth access token",
      description:
        "Secret token supplied by BB's Google connector; never stored in workspace state.",
      secret: true,
    },
    googleUserEmail: {
      type: "string",
      label: "Google account email",
      description:
        "Used to distinguish incoming messages from outstanding commitments.",
    },
    googleCalendarIds: {
      type: "string",
      label: "Google Calendar ids",
      description: "Comma-separated calendars to monitor.",
      default: "primary",
    },
  });
  async function googleRuntime(): Promise<{
    transport: GoogleWorkTransport;
    userEmail: string;
    calendarIds: string[];
  } | null> {
    if (options.googleTransport && options.googleUserEmail) {
      return {
        transport: options.googleTransport,
        userEmail: options.googleUserEmail,
        calendarIds: options.googleCalendarIds ?? ["primary"],
      };
    }
    const settings = await googleSettings.get();
    const calendarIds = settings.googleCalendarIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    // Preferred: the first-party google-workspace connector owns OAuth and
    // refresh; a fresh token is vended per cycle so expiry never strands a
    // long-lived transport.
    try {
      const vended = await bb.sdk.plugins.callRpc({
        pluginId: GOOGLE_CONNECTOR_PLUGIN_ID,
        method: "accessToken",
        input: null,
        outputSchema: z.object({
          token: z.string(),
          expiresAt: z.string(),
          email: z.string(),
        }),
      });
      return {
        transport: new GoogleApiWorkTransport(vended.token, vended.email),
        userEmail: vended.email,
        calendarIds,
      };
    } catch {
      // Connector absent, unconnected, or unhealthy — fall through to the
      // manual settings token (or no Google at all).
    }
    if (!settings.googleAccessToken || !settings.googleUserEmail) return null;
    return {
      transport: new GoogleApiWorkTransport(
        settings.googleAccessToken,
        settings.googleUserEmail,
      ),
      userEmail: settings.googleUserEmail,
      calendarIds,
    };
  }
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
        capabilities: [],
        goals: [],
        entities: [],
        opportunities: [],
        externalActions: [],
        outcomes: [],
        sources: [],
        signals: [],
        runs: [],
        attentionItems: [],
      };
    }
    const legacy = ws.autonomy as GeneratedToolAutonomyState & {
      policy: GeneratedToolAutonomyState["policy"] & {
        internalActions?: "automatic" | "recommend-only";
        externalActions?: "require-approval";
      };
      capabilities?: GeneratedToolAutonomyState["capabilities"];
      goals?: GeneratedToolAutonomyState["goals"];
      entities?: GeneratedToolAutonomyState["entities"];
      opportunities?: GeneratedToolAutonomyState["opportunities"];
      externalActions?: GeneratedToolAutonomyState["externalActions"];
      outcomes?: GeneratedToolAutonomyState["outcomes"];
      sources?: GeneratedToolAutonomyState["sources"];
      signals?: GeneratedToolAutonomyState["signals"];
    };
    legacy.capabilities ??=
      legacy.sources?.map((source) => ({
        id: source.id,
        role: "source" as const,
        kind: source.kind,
        label: source.label,
        enabled: source.enabled,
        resource: source.resource,
        scopes: source.scopes,
      })) ?? [];
    legacy.goals ??= [];
    legacy.entities ??= [];
    legacy.opportunities ??= [];
    legacy.externalActions ??= [];
    legacy.outcomes ??= [];
    legacy.sources ??= [];
    legacy.signals ??= [];
    (legacy as Record<string, unknown>).attentionItems ??= [];
    // Migrate legacy recommendations
    if ("recommendations" in (legacy as Record<string, unknown>)) {
      const oldRecs = (legacy as Record<string, unknown>)
        .recommendations as unknown[];
      if (Array.isArray(oldRecs) && oldRecs.length > 0) {
        (legacy as Record<string, unknown>).attentionItems = [
          ...oldRecs.map((r: unknown) => {
            const rec = r as Record<string, unknown>;
            return {
              id: rec.id,
              kind:
                rec.kind === "external-action"
                  ? ("action-proposal" as const)
                  : rec.kind === "recommendation"
                    ? ("information" as const)
                    : ("exception" as const),
              title: rec.title,
              rationale: rec.rationale,
              evidence: (rec.evidence as string[]) ?? [],
              externalActionId: (rec.externalActionId as string) ?? undefined,
              status: (rec.status as string) ?? "open",
              createdAt: rec.createdAt as string,
              resolvedAt: (rec.resolvedAt as string) ?? undefined,
            };
          }),
          ...((legacy as Record<string, unknown>).attentionItems as unknown[]),
        ];
      }
      delete (legacy as Record<string, unknown>).recommendations;
    }
    legacy.policy.permissions ??= {
      observe: {
        sourceIds: legacy.sources
          .filter((source) => source.enabled)
          .map((source) => source.id),
      },
      internalState: legacy.policy.internalActions ?? "automatic",
      evolvePresentation: "automatic",
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
      if (workspace.autonomy) autonomy(workspace);
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
      composition: input.composition,
    };
    if (ws.composition && !validateNativeComposition(ws, ws.composition)) {
      throw new Error(
        "composition is invalid or references missing/hidden view ids; give composed views explicit ids",
      );
    }
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

  async function pollGoogleCapabilityAdapters(): Promise<void> {
    const runtime = await googleRuntime();
    if (!runtime) return;
    const { transport } = runtime;
    const cursor = (await bb.storage.kv.get<GoogleWorkCursor>(
      GOOGLE_CURSOR_KEY,
    )) ?? {
      calendarSyncTokens: {},
    };
    const polled = await pollGoogleWork({
      transport,
      cursor,
      gmailBindingId: "google:gmail",
      calendarBindingId: "google:calendar",
      calendarIds: runtime.calendarIds,
      userEmail: runtime.userEmail,
      now: options.now?.(),
    });
    const workspaces = await loadAll();
    const globalSignals = await loadOperationSignals();
    for (const evidence of polled.evidence) {
      for (const snapshot of workspaces) {
        const state = autonomy(snapshot);
        if (!state.policy.enabled) continue;
        const wantedKind = evidence.source === "gmail" ? "email" : "calendar";
        const source = state.sources.find(
          (binding) => binding.enabled && binding.kind === wantedKind,
        );
        if (
          !source ||
          !generatedToolCapabilityAllowed(state.policy.permissions, {
            capability: "observe",
            sourceId: source.id,
          })
        )
          continue;
        await updateWorkspace(snapshot.id, (workspace) => {
          const current = autonomy(workspace);
          const fingerprint = evidence.fingerprint;
          if (
            !current.signals.some(
              (signal) =>
                signal.sourceBindingId === source.id &&
                signal.fingerprint === fingerprint,
            )
          ) {
            const signal: GeneratedToolSignal = {
              id: newId("sig"),
              targetWorkspaceIds: [workspace.id],
              entityRefs: evidence.entityRefs,
              sourceBindingId: source.id,
              sourceKind: wantedKind,
              fingerprint,
              observedAt: evidence.observedAt,
              title: evidence.title,
              summary: evidence.summary,
              evidence: evidence.evidence,
              context: JSON.stringify(evidence.context),
              attention: evidence.attention,
            };
            current.signals.unshift(signal);
            current.signals = current.signals.slice(0, 500);
            globalSignals.unshift(signal);
          }
          for (const ref of evidence.entityRefs) {
            const entity = current.entities.find(
              (candidate) => candidate.ref === ref,
            );
            const fact: GeneratedEntityFact = {
              key: `latest-${evidence.source}`,
              value: evidence.summary.slice(0, 1_000),
              confidence: 0.85,
              evidence: evidence.evidence,
              observedAt: evidence.observedAt,
            };
            if (!entity) {
              current.entities.unshift({
                ref,
                kind: ref.startsWith("person:") ? "person" : "company",
                label: ref.split(":").slice(1).join(":"),
                aliases: [],
                facts: [fact],
                updatedAt: evidence.observedAt,
              });
            } else {
              const existing = entity.facts.find(
                (candidate) => candidate.key === fact.key,
              );
              if (!existing || fact.observedAt >= existing.observedAt)
                existing
                  ? Object.assign(existing, fact)
                  : entity.facts.push(fact);
              entity.updatedAt = evidence.observedAt;
            }
          }
          if (
            ["follow-up-overdue", "scheduling-decision"].includes(
              evidence.attention,
            ) &&
            !current.attentionItems.some((item) =>
              item.evidence.includes(evidence.fingerprint),
            )
          ) {
            const exception = evidence.attention === "follow-up-overdue";
            current.attentionItems.unshift({
              id: newId("att"),
              kind: exception ? "exception" : "information",
              title:
                evidence.attention === "response-needed"
                  ? `Response needed: ${evidence.title}`
                  : evidence.attention === "meeting-prep"
                    ? `Meeting brief: ${evidence.title}`
                    : evidence.attention === "scheduling-decision"
                      ? `Scheduling decision: ${evidence.title}`
                      : `Outstanding commitment: ${evidence.title}`,
              rationale:
                evidence.context.suggestedAction ??
                "New context requires agent analysis or human attention.",
              evidence: [evidence.fingerprint, ...evidence.evidence],
              status: "open",
              createdAt: new Date().toISOString(),
            });
          }
        });
      }
    }
    await saveOperationSignals(globalSignals);
    await bb.storage.kv.set(GOOGLE_CURSOR_KEY, polled.cursor);
  }

  bb.background.schedule(
    "google-work-capability-poll",
    "*/5 * * * *",
    pollGoogleCapabilityAdapters,
  );

  async function runAutonomySweep(): Promise<void> {
    const snapshots = await loadAll();
    const now = Date.now();
    for (const snapshot of snapshots) {
      const state = autonomy(snapshot);
      if (!state.policy.enabled) continue;
      if (state.runs.some((run) => run.status === "running")) continue;
      const lastAt = state.runs[0] ? Date.parse(state.runs[0]!.startedAt) : 0;
      const hasApprovedAction = state.externalActions.some(
        (action) => action.status === "approved",
      );
      const hasUnreconciledSignal = state.signals.some(
        (signal) => signal.reconciledAt === undefined,
      );
      if (
        !hasApprovedAction &&
        !hasUnreconciledSignal &&
        now - lastAt < state.policy.cadenceMinutes * 60_000
      )
        continue;
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
            capabilities: state.capabilities,
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
        if (status === "completed") {
          run.summary = detail ?? "Cycle completed.";
          const reconciledAt = new Date().toISOString();
          for (const signal of workspace.autonomy?.signals ?? []) {
            signal.reconciledAt ??= reconciledAt;
          }
        } else run.error = detail ?? "Operator cycle failed.";
        // SelfOps surface-value telemetry: a completed cycle with no open
        // attention items is a zero-value cycle for the human surface.
        if (workspace.autonomy) {
          const state = workspace.autonomy;
          const openItems = state.attentionItems.filter(
            (candidate) => candidate.status === "open",
          ).length;
          state.zeroValueSurfaceCycles =
            openItems === 0 && status === "completed"
              ? (state.zeroValueSurfaceCycles ?? 0) + 1
              : 0;
          if (status === "completed") {
            void emitSelfOpsObservation(bb, {
              id: `surf-${workspace.id}-${state.zeroValueSurfaceCycles}`,
              kind: "surface-usage",
              observedAt: new Date().toISOString(),
              subject: `surface:${workspace.id}`,
              attributes: {
                zeroValueCycles: state.zeroValueSurfaceCycles,
                openAttention: openItems,
              },
            });
          }
        }
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
        capabilityBindings: z
          .array(
            z
              .object({
                id: z.string().min(1),
                role: z.enum(["source", "infrastructure", "action-channel"]),
                kind: z.string().min(1),
                label: z.string().min(1),
                enabled: z.boolean(),
                resource: z.string().optional(),
                scopes: z.array(z.string()),
              })
              .strict(),
          )
          .max(100)
          .default([]),
        permissions: z
          .object({
            observe: z.object({ sourceIds: z.array(z.string()) }).strict(),
            internalState: z.enum(["automatic", "recommend-only"]),
            evolvePresentation: z.enum([
              "automatic",
              "recommend-only",
              "disabled",
            ]),
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
            autonomy(workspace).capabilities = [
              ...input.capabilityBindings,
              ...input.sourceBindings
                .filter(
                  (source) =>
                    !input.capabilityBindings.some(
                      (binding) => binding.id === source.id,
                    ),
                )
                .map((source) => ({ ...source, role: "source" as const })),
            ];
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
    name: "generated_operations_set_goal",
    description:
      "Create or update a durable goal with explicit success criteria and measured progress.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        goalId: z.string().min(1).optional(),
        objective: z.string().min(1).max(2000),
        successCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
        status: z
          .enum(["active", "paused", "achieved", "blocked"])
          .default("active"),
        progress: z.number().min(0).max(1).default(0),
        assessment: z.string().max(2000).optional(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            const state = autonomy(workspace);
            const existing = input.goalId
              ? state.goals.find((goal) => goal.id === input.goalId)
              : undefined;
            const goal = {
              id: existing?.id ?? newId("goal"),
              objective: input.objective,
              successCriteria: input.successCriteria,
              status: input.status,
              progress: input.progress,
              lastEvaluatedAt: new Date().toISOString(),
              assessment: input.assessment,
            };
            if (existing) Object.assign(existing, goal);
            else state.goals.unshift(goal);
            state.policy.goal =
              state.goals.find((candidate) => candidate.status === "active")
                ?.objective ?? state.policy.goal;
          }),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_upsert_entity",
    description:
      "Maintain canonical entity memory with confidence-scored, evidence-backed facts and aliases.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        ref: z.string().min(1),
        kind: z.string().min(1),
        label: z.string().min(1),
        aliases: z.array(z.string()).max(50).default([]),
        facts: z
          .array(
            z
              .object({
                key: z.string().min(1),
                value: z.string(),
                confidence: z.number().min(0).max(1),
                evidence: z.array(z.string()).min(1).max(20),
                observedAt: z.string(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            const state = autonomy(workspace);
            const entity = state.entities.find(
              (candidate) => candidate.ref === input.ref,
            );
            if (!entity) {
              state.entities.unshift({
                ref: input.ref,
                kind: input.kind,
                label: input.label,
                aliases: [...new Set(input.aliases)],
                facts: input.facts,
                updatedAt: new Date().toISOString(),
              });
              return;
            }
            entity.kind = input.kind;
            entity.label = input.label;
            entity.aliases = [
              ...new Set([...entity.aliases, ...input.aliases]),
            ];
            for (const fact of input.facts) {
              const current = entity.facts.find(
                (candidate) => candidate.key === fact.key,
              );
              if (
                !current ||
                fact.observedAt >= current.observedAt ||
                fact.confidence > current.confidence
              ) {
                if (current) Object.assign(current, fact);
                else entity.facts.push(fact);
              }
            }
            entity.updatedAt = new Date().toISOString();
          }),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_upsert_opportunity",
    description:
      "Discover, research, score, prioritize, and advance a goal-relevant opportunity with evidence.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        opportunityId: z.string().min(1).optional(),
        entityRefs: z.array(z.string().min(1)).max(50),
        title: z.string().min(1).max(200),
        hypothesis: z.string().min(1).max(2000),
        evidence: z.array(z.string()).min(1).max(30),
        score: z.number().min(0).max(1),
        status: z.enum([
          "discovered",
          "researching",
          "qualified",
          "advanced",
          "dismissed",
          "completed",
        ]),
        nextAction: z.string().max(1000).optional(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            const state = autonomy(workspace);
            const now = new Date().toISOString();
            const existing = input.opportunityId
              ? state.opportunities.find(
                  (item) => item.id === input.opportunityId,
                )
              : state.opportunities.find(
                  (item) =>
                    item.title === input.title && item.status !== "dismissed",
                );
            const opportunity = {
              id: existing?.id ?? newId("opp"),
              entityRefs: [...new Set(input.entityRefs)],
              title: input.title,
              hypothesis: input.hypothesis,
              evidence: input.evidence,
              score: input.score,
              status: input.status,
              nextAction: input.nextAction,
              discoveredAt: existing?.discoveredAt ?? now,
              updatedAt: now,
            };
            if (existing) Object.assign(existing, opportunity);
            else state.opportunities.unshift(opportunity);
            state.opportunities.sort((a, b) => b.score - a.score);
          }),
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_propose_external_action",
    description:
      "Create an idempotent consequential external-action proposal for explicit human approval; this does not execute it.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        idempotencyKey: z.string().min(1).max(300),
        title: z.string().min(1).max(200),
        actionType: z.string().min(1).max(100),
        channelBindingId: z.string().min(1),
        target: z.string().min(1).max(500),
        payloadSummary: z.string().min(1).max(2000),
        payload: z
          .record(z.string(), z.string())
          .refine((value) => JSON.stringify(value).length <= 20_000),
        rationale: z.string().min(1).max(2000),
        evidence: z.array(z.string()).min(1).max(30),
      })
      .strict(),
    async execute(input) {
      let actionId = "";
      const workspace = await updateWorkspace(
        input.workspaceId,
        (workspace) => {
          const state = autonomy(workspace);
          if (
            !generatedToolCapabilityAllowed(state.policy.permissions, {
              capability: "prepare-external-action",
            })
          ) {
            throw new Error(
              "external-action preparation is recommend-only or disabled",
            );
          }
          const channel = state.capabilities.find(
            (binding) =>
              binding.id === input.channelBindingId &&
              binding.role === "action-channel" &&
              binding.enabled,
          );
          if (!channel) {
            throw new Error(
              `enabled action-channel binding not found: ${input.channelBindingId}`,
            );
          }
          const duplicate = state.externalActions.find(
            (item) => item.idempotencyKey === input.idempotencyKey,
          );
          if (duplicate) {
            actionId = duplicate.id;
            return;
          }
          const action = {
            id: newId("action"),
            idempotencyKey: input.idempotencyKey,
            title: input.title,
            actionType: input.actionType,
            channelBindingId: input.channelBindingId,
            target: input.target,
            payloadSummary: input.payloadSummary,
            payload: input.payload,
            rationale: input.rationale,
            evidence: input.evidence,
            status: "proposed" as const,
            createdAt: new Date().toISOString(),
            attempts: 0,
          };
          actionId = action.id;
          state.externalActions.unshift(action);
          state.attentionItems.unshift({
            id: newId("att"),
            kind: "action-proposal",
            title: input.title,
            rationale: input.rationale,
            evidence: [input.evidence[0] ?? ""],
            externalActionId: action.id,
            status: "open",
            createdAt: action.createdAt,
          });
        },
      );
      const action = autonomy(workspace).externalActions.find(
        (item) => item.id === actionId,
      );
      return JSON.stringify(toJson(action));
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_claim_approved_action",
    description:
      "Atomically claim one explicitly approved external action before executing it. Idempotency prevents duplicate side effects.",
    parameters: z
      .object({ workspaceId: z.string().min(1), actionId: z.string().min(1) })
      .strict(),
    async execute({ workspaceId, actionId }) {
      let claimed: unknown;
      await updateWorkspace(workspaceId, (workspace) => {
        const state = autonomy(workspace);
        const action = state.externalActions.find(
          (item) => item.id === actionId,
        );
        if (!action) throw new Error(`external action not found: ${actionId}`);
        if (
          !generatedToolCapabilityAllowed(state.policy.permissions, {
            capability: "execute-consequential-action",
            proposalStatus: action.status === "approved" ? "approved" : "open",
          })
        ) {
          throw new Error(
            "external action is not explicitly approved for execution",
          );
        }
        if (action.status !== "approved")
          throw new Error(
            `external action cannot be claimed from status ${action.status}`,
          );
        action.status = "executing";
        action.executionStartedAt = new Date().toISOString();
        action.attempts += 1;
        claimed = structuredClone(action);
      });
      return JSON.stringify(toJson(claimed));
    },
  });
  bb.agents.registerTool({
    name: "generated_operations_record_action_outcome",
    description:
      "Record the authoritative result of a claimed external action and evaluate what it means for the goal.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        actionId: z.string().min(1),
        succeeded: z.boolean(),
        outcome: z.string().min(1).max(3000),
        error: z.string().max(2000).optional(),
        result: z.enum(["positive", "negative", "neutral", "unknown"]),
        assessment: z.string().min(1).max(2000),
        evidence: z.array(z.string()).min(1).max(30),
        goalId: z.string().optional(),
        followUp: z.string().max(1000).optional(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            const state = autonomy(workspace);
            const action = state.externalActions.find(
              (item) => item.id === input.actionId,
            );
            if (!action)
              throw new Error(`external action not found: ${input.actionId}`);
            if (action.status !== "executing")
              throw new Error(
                `external action outcome requires executing status, found ${action.status}`,
              );
            action.status = input.succeeded ? "succeeded" : "failed";
            action.completedAt = new Date().toISOString();
            action.outcome = input.outcome;
            action.lastError = input.error;
            void emitSelfOpsObservation(bb, {
              id: `outcome-${workspace.id}-${action.id}`,
              kind: "test-result",
              observedAt: new Date().toISOString(),
              subject: `surface:${workspace.id}`,
              attributes: {
                result: input.result,
                succeeded: input.succeeded ? 1 : 0,
                actionType: action.actionType,
              },
            });
            state.outcomes.unshift({
              id: newId("outcome"),
              goalId: input.goalId,
              actionId: action.id,
              observedAt: action.completedAt,
              result: input.result,
              assessment: input.assessment,
              evidence: input.evidence,
              followUp: input.followUp,
            });
          }),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "google_work_execute_claimed_action",
    description:
      "Execute one already-claimed Gmail reply or Google Calendar update through its bound Google action channel, then persist the authoritative outcome.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        actionId: z.string().min(1),
        goalId: z.string().optional(),
      })
      .strict(),
    async execute({ workspaceId, actionId, goalId }) {
      const workspace = await getWorkspace(workspaceId);
      const state = autonomy(workspace);
      const action = state.externalActions.find((item) => item.id === actionId);
      if (!action) throw new Error(`external action not found: ${actionId}`);
      if (action.status !== "executing") {
        throw new Error(
          `Google action must be approved and claimed before execution; found ${action.status}`,
        );
      }
      const binding = state.capabilities.find(
        (candidate) =>
          candidate.id === action.channelBindingId &&
          candidate.role === "action-channel" &&
          candidate.enabled &&
          candidate.kind === "google-work",
      );
      if (!binding) {
        throw new Error(
          `enabled google-work action channel not found: ${action.channelBindingId}`,
        );
      }
      const runtime = await googleRuntime();
      if (!runtime) throw new Error("Google connector is not configured");
      const { transport } = runtime;
      try {
        const result = await executeGoogleWorkAction({
          transport,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
          payload: action.payload,
        });
        const updated = await updateWorkspace(
          workspaceId,
          (currentWorkspace) => {
            const current = autonomy(currentWorkspace);
            const live = current.externalActions.find(
              (item) => item.id === actionId,
            );
            if (!live || live.status !== "executing") {
              throw new Error(
                "external action changed while Google execution was in flight",
              );
            }
            live.status = "succeeded";
            live.completedAt = new Date().toISOString();
            live.outcome = result.outcome;
            current.outcomes.unshift({
              id: newId("outcome"),
              goalId,
              actionId,
              observedAt: live.completedAt,
              result: "positive",
              assessment: result.outcome,
              evidence: result.evidence,
              followUp:
                action.actionType === "gmail.send-reply"
                  ? "Observe the thread for a response."
                  : "Observe attendee responses and calendar changes.",
            });
          },
        );
        return JSON.stringify(toJson(updated));
      } catch (error) {
        await updateWorkspace(workspaceId, (currentWorkspace) => {
          const live = autonomy(currentWorkspace).externalActions.find(
            (item) => item.id === actionId,
          );
          if (live?.status === "executing") {
            live.status = "failed";
            live.completedAt = new Date().toISOString();
            live.lastError =
              error instanceof Error ? error.message : String(error);
          }
        });
        throw error;
      }
    },
  });

  bb.agents.registerTool({
    name: "generated_tool_evolve_presentation",
    description:
      "Safely evolve a generated tool's human-facing definition: add/update/hide/remove/reorder/resize modules and replace projections, without changing operational collections or BB runtime code.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        rationale: z.string().min(1).max(2000),
        mutations: z.array(presentationMutationSchema).min(1).max(24),
      })
      .strict(),
    async execute({ workspaceId, rationale, mutations }) {
      const updated = await updateWorkspace(workspaceId, (workspace) => {
        const state = autonomy(workspace);
        if (!state.policy.enabled) {
          throw new Error("generated-tool autonomy is disabled");
        }
        if (
          !generatedToolCapabilityAllowed(state.policy.permissions, {
            capability: "evolve-presentation",
          })
        ) {
          throw new Error(
            "operator has recommend-only or disabled presentation permission; surface a recommendation instead",
          );
        }
        for (const mutation of mutations) {
          if (mutation.workspaceId !== workspaceId)
            throw new Error("mutation workspaceId mismatch");
          if (!applyMutation(workspace, mutation as Mutation)) {
            throw new Error(
              `presentation mutation could not be applied: ${mutation.op}`,
            );
          }
        }
        if (workspace.views.length > 24)
          throw new Error("generated tool exceeds the 24-module limit");
        if (!workspace.views.some((view) => view.visible !== false)) {
          throw new Error(
            "generated tool must retain at least one visible module",
          );
        }
        state.attentionItems.unshift({
          id: newId("att"),
          kind: "information",
          title: "Presentation evolved",
          rationale,
          evidence: ["generated-tool-definition"],
          status: "resolved",
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
      });
      return JSON.stringify(toJson(updated));
    },
  });

  bb.agents.registerTool({
    name: "generated_tool_report_attention",
    description:
      "Surface a semantic attention item. Use `action-proposal` kind for external side effects (requires a linked proposed external action via generated_operations_propose_external_action), `decision` kind for genuine options (supply options), `exception` kind for errors (supply error/retryAction), or `information` kind for items the human may dismiss.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        kind: z.enum([
          "action-proposal",
          "decision",
          "exception",
          "information",
        ]),
        title: z.string().min(1).max(200),
        rationale: z.string().min(1).max(2000),
        evidence: z.array(z.string().max(1000)).min(1).max(20),
        options: z
          .array(
            z
              .object({
                id: z.string().min(1),
                label: z.string().min(1).max(200),
                description: z.string().max(500).optional(),
              })
              .strict(),
          )
          .max(8)
          .optional(),
        error: z.string().max(2000).optional(),
        retryAction: z.string().max(1000).optional(),
      })
      .strict(),
    async execute(input) {
      return JSON.stringify(
        toJson(
          await updateWorkspace(input.workspaceId, (workspace) => {
            autonomy(workspace).attentionItems.unshift({
              id: newId("att"),
              kind: input.kind,
              title: input.title,
              rationale: input.rationale,
              evidence: input.evidence,
              externalActionId: undefined,
              options: input.options,
              error: input.error,
              retryAction: input.retryAction,
              status: "open",
              createdAt: new Date().toISOString(),
            });
            autonomy(workspace).attentionItems = autonomy(
              workspace,
            ).attentionItems.slice(0, 100);
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
      "generated_operations_set_goal",
      "generated_operations_upsert_entity",
      "generated_operations_upsert_opportunity",
      "generated_operations_propose_external_action",
      "generated_operations_claim_approved_action",
      "generated_operations_record_action_outcome",
      "google_work_execute_claimed_action",
      "generated_tool_report_attention",
      "generated_tool_evolve_presentation",
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
          autonomy(workspace).capabilities = [
            ...input.capabilityBindings,
            ...input.sourceBindings
              .filter(
                (source) =>
                  !input.capabilityBindings.some(
                    (binding) => binding.id === source.id,
                  ),
              )
              .map((source) => ({ ...source, role: "source" as const })),
          ];
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
    async resolveAttentionItem({ workspaceId, itemId, decision }) {
      const workspaceBefore = await getWorkspace(workspaceId);
      const itemBefore = autonomy(workspaceBefore).attentionItems.find(
        (candidate) => candidate.id === itemId,
      );
      if (itemBefore) {
        void emitSelfOpsObservation(bb, {
          id: `attn-${workspaceId}-${itemId}-${decision}`,
          kind: "approval-decision",
          observedAt: new Date().toISOString(),
          subject: `surface:${workspaceId}`,
          attributes: { itemId, itemKind: itemBefore.kind, decision },
        });
      }
      return toJson(
        await updateWorkspace(workspaceId, (workspace) => {
          const item = autonomy(workspace).attentionItems.find(
            (candidate) => candidate.id === itemId,
          );
          if (!item) throw new Error(`attention item not found: ${itemId}`);
          const now = new Date().toISOString();
          if (item.kind === "action-proposal" && decision === "approved") {
            item.status = "approved";
            item.resolvedAt = now;
            if (item.externalActionId) {
              const action = autonomy(workspace).externalActions.find(
                (candidate) => candidate.id === item.externalActionId,
              );
              if (!action) {
                throw new Error(
                  `external action not found: ${item.externalActionId}`,
                );
              }
              if (action.status !== "proposed") {
                throw new Error(
                  `external action cannot be decided from status ${action.status}`,
                );
              }
              action.status = "approved";
              action.approvedAt = now;
            }
          } else if (
            item.kind === "action-proposal" &&
            decision === "rejected"
          ) {
            item.status = "rejected";
            item.resolvedAt = now;
            if (item.externalActionId) {
              const action = autonomy(workspace).externalActions.find(
                (candidate) => candidate.id === item.externalActionId,
              );
              if (action && action.status === "proposed") {
                action.status = "rejected";
                action.completedAt = now;
              }
            }
          } else if (decision === "dismissed") {
            item.status = "dismissed";
            item.resolvedAt = now;
          } else if (decision === "resolved") {
            item.status = "resolved";
            item.resolvedAt = now;
          } else {
            throw new Error(
              `decision "${decision}" is not valid for attention item kind "${item.kind}"`,
            );
          }
        }),
      );
    },
  });
}
