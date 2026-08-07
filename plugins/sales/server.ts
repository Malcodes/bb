// bb-plugin-sales — server side. Owns persistent workspaces: collections of
// rows are the source of truth, views are interactive projections. The UI and
// the agent mutate state through the SAME applyMutation() path; every change
// persists to plugin storage and publishes a realtime signal so open panels
// re-render immediately.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  applyMutation,
  newId,
  type Mutation,
  type Workspace,
} from "./src/model.js";
import {
  createWorkspaceInputSchema,
  mutationSchema,
  rowSchema,
  rowValueSchema,
  workspaceSchema,
  workspaceSummarySchema,
} from "./src/schemas.js";
import { SALES_AGENT_INSTRUCTIONS } from "./src/instructions.js";

const WORKSPACES_KEY = "workspaces";
const THREAD_KEY = "workspace-thread-id";
const SIGNAL_CHANNEL = "workspaces-changed";

/** RPC results must be plain JSON — strip undefined optional fields. */
function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function summarize(ws: Workspace) {
  return {
    id: ws.id,
    title: ws.title,
    icon: ws.icon,
    updatedAt: ws.updatedAt,
    viewCount: ws.views.length,
    rowCount: ws.collections.reduce((n, c) => n + c.rows.length, 0),
  };
}

export const salesRpcContract = defineRpcContract({
  listWorkspaces: {
    input: z.object({}).strict(),
    output: z.object({ workspaces: z.array(workspaceSummarySchema) }).strict(),
  },
  getWorkspace: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: workspaceSchema.strict(),
  },
  createWorkspace: {
    input: createWorkspaceInputSchema.strict(),
    output: workspaceSchema.strict(),
  },
  deleteWorkspace: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  mutate: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
  command: {
    input: z
      .object({
        text: z.string().trim().min(1),
        workspaceId: z.string().min(1).optional(),
      })
      .strict(),
    output: z
      .object({
        reply: z.string(),
        workspaceId: z.string().optional(),
        status: z.enum(["ok", "error"]),
      })
      .strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  async function loadAll(): Promise<Workspace[]> {
    return (await bb.storage.kv.get<Workspace[]>(WORKSPACES_KEY)) ?? [];
  }

  async function saveAll(workspaces: Workspace[]): Promise<void> {
    await bb.storage.kv.set(WORKSPACES_KEY, workspaces);
  }

  async function getWorkspace(workspaceId: string): Promise<Workspace> {
    const ws = (await loadAll()).find((w) => w.id === workspaceId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    return ws;
  }

  function changed(): void {
    bb.realtime.publish(SIGNAL_CHANNEL, { at: Date.now() });
  }

  /** The ONE write path — UI RPC and agent tools both go through here. */
  async function applyMutations(
    workspaceId: string,
    mutations: Mutation[],
  ): Promise<Workspace> {
    const all = await loadAll();
    const ws = all.find((w) => w.id === workspaceId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    let touched = false;
    for (const m of mutations) {
      touched = applyMutation(ws, m) || touched;
    }
    ws.updatedAt = new Date().toISOString();
    await saveAll(all);
    if (touched) changed();
    return ws;
  }

  async function createWorkspace(
    input: z.infer<typeof createWorkspaceInputSchema>,
  ): Promise<Workspace> {
    const all = await loadAll();
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: newId("ws"),
      title: input.title,
      icon: input.icon,
      createdAt: now,
      updatedAt: now,
      collections: input.collections,
      views: input.views.map((v) => ({ ...v, id: v.id ?? newId("view") })),
    };
    all.push(ws);
    await saveAll(all);
    changed();
    bb.log.info(`workspace created: "${ws.title}" (${ws.id})`);
    return ws;
  }

  // ------------------------------------------------------------------
  // Agent wiring: one persistent hidden thread does the composing. It is
  // taught the object model via dynamic instructions and given native tools
  // that read/mutate the SAME state store the UI uses.
  // ------------------------------------------------------------------

  let workspaceThreadId: string | null =
    (await bb.storage.kv.get<string>(THREAD_KEY)) ?? null;

  bb.agents.registerTool({
    name: "sales_list_workspaces",
    description:
      "List the user's sales workspaces (id, title, view/row counts).",
    parameters: z.object({}).strict(),
    async execute() {
      const all = await loadAll();
      return JSON.stringify(all.map(summarize));
    },
  });

  bb.agents.registerTool({
    name: "sales_read_workspace",
    description:
      "Read a workspace's full current state: collections (every row) and views. Always read before mutating.",
    parameters: z.object({ workspaceId: z.string().min(1) }).strict(),
    async execute({ workspaceId }) {
      return JSON.stringify(toJson(await getWorkspace(workspaceId)));
    },
  });

  bb.agents.registerTool({
    name: "sales_create_workspace",
    description:
      "Create a new persistent workspace with collections (seeded rows) and views. Returns the created workspace including its id.",
    parameters: createWorkspaceInputSchema.strict(),
    async execute(input) {
      return JSON.stringify(toJson(await createWorkspace(input)));
    },
  });

  bb.agents.registerTool({
    name: "sales_mutate_workspace",
    description:
      "Apply mutations to a workspace (moveRow/patchRow/addRow/removeRow/reorderViews/renameWorkspace). The same mutations the UI produces.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    async execute({ workspaceId, mutations }) {
      return JSON.stringify(
        toJson(await applyMutations(workspaceId, mutations as Mutation[])),
      );
    },
  });

  bb.agents.configure(({ origin }) =>
    origin.pluginId === "sales"
      ? {
          tools: [
            "sales_list_workspaces",
            "sales_read_workspace",
            "sales_create_workspace",
            "sales_mutate_workspace",
          ],
          skills: [],
          instructions: SALES_AGENT_INSTRUCTIONS,
        }
      : { tools: [], skills: [] },
  );

  function buildPrompt(text: string, workspaceId?: string): string {
    return [
      'The user typed into the app command bar:',
      '',
      `"${text}"`,
      '',
      workspaceId
        ? `They currently have workspace "${workspaceId}" open. If the request is about it, read it first and mutate it; if they want something new, create a new workspace.`
        : "They have no workspace open. If the request describes something to work on, create a new workspace for it; list existing workspaces first if they may be referring to one.",
      '',
      "Follow your instructions: use the tools, then reply with one or two sentences for the user. If you created a workspace, end your reply with its id in the form [ws:<id>].",
    ].join("\n");
  }

  async function ensureWorkspaceThread(): Promise<string> {
    if (workspaceThreadId !== null) {
      try {
        const existing = await bb.sdk.threads.get({
          threadId: workspaceThreadId,
        });
        // A thread stuck in error will never accept turns; respawn instead.
        const status =
          existing && typeof existing === "object" && "status" in existing
            ? String((existing as { status: unknown }).status)
            : "unknown";
        if (
          existing &&
          typeof existing === "object" &&
          "id" in existing &&
          status !== "error" &&
          status !== "failed"
        ) {
          return workspaceThreadId;
        }
      } catch {
        /* fall through to respawn */
      }
      bb.log.info("stored workspace thread is gone or errored; spawning a new one");
      workspaceThreadId = null;
    }

    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find(
      (p: { kind: string }) => p.kind === "personal",
    );
    if (!personal) {
      throw new Error("no personal project available for the workspace thread");
    }

    const thread = await bb.sdk.threads.spawn({
      projectId: personal.id,
      environment: { type: "project-default" },
      title: "Sales Surface agent",
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: "You are starting as the persistent sales work-surface agent. Acknowledge briefly and wait for the user's first command.",
          mentions: [],
        },
      ],
    });
    workspaceThreadId = thread.id;
    await bb.storage.kv.set(THREAD_KEY, thread.id);
    bb.log.info(`spawned workspace thread ${thread.id}`);
    await bb.sdk.threads.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: 180_000,
      pollIntervalMs: 500,
    });
    return thread.id;
  }

  bb.rpc.register(salesRpcContract, {
    async listWorkspaces() {
      return toJson({ workspaces: (await loadAll()).map(summarize) });
    },
    async getWorkspace({ workspaceId }) {
      return toJson(await getWorkspace(workspaceId));
    },
    async createWorkspace(input) {
      return toJson(await createWorkspace(input));
    },
    async deleteWorkspace({ workspaceId }) {
      const all = await loadAll();
      await saveAll(all.filter((w) => w.id !== workspaceId));
      changed();
      return { ok: true as const };
    },
    async mutate({ workspaceId, mutations }) {
      return toJson(await applyMutations(workspaceId, mutations as Mutation[]));
    },

    async command({ text, workspaceId: openWorkspaceId }) {
      try {
        const beforeIds = new Set((await loadAll()).map((ws) => ws.id));
        const threadId = await ensureWorkspaceThread();
        await bb.sdk.threads.wait({
          threadId,
          status: "idle",
          timeoutMs: 180_000,
          pollIntervalMs: 500,
        });
        await bb.sdk.threads.send({
          threadId,
          input: [
            {
              type: "text",
              text: buildPrompt(text, openWorkspaceId),
              mentions: [],
            },
          ],
          mode: "auto",
        });
        await bb.sdk.threads.wait({
          threadId,
          status: "idle",
          timeoutMs: 180_000,
          pollIntervalMs: 500,
        });
        const { output } = await bb.sdk.threads.output({ threadId });
        const reply = output?.trim() || "Done.";
        const match = /\[ws:([a-z0-9_]+)\]/i.exec(reply);
        const created = (await loadAll())
          .filter((ws) => !beforeIds.has(ws.id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return toJson({
          reply: reply.replace(/\s*\[ws:[a-z0-9_]+\]\s*/i, " ").trim(),
          workspaceId: match?.[1] ?? created?.id,
          status: "ok" as const,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.info(`agent command failed: ${message}`);
        return {
          reply: `I couldn't do that — ${message}. Try rephrasing, or ask again in a moment.`,
          status: "error" as const,
        };
      }
    },
  });
}
