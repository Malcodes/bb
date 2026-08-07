// Thread-native persistent work surfaces. The normal bb thread is the
// container; assistant message directives render native primitives inline.
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
  workspaceSchema,
} from "./src/schemas.js";
import { SALES_AGENT_INSTRUCTIONS } from "./src/instructions.js";

const WORKSPACES_KEY = "workspaces";
const SIGNAL_CHANNEL = "workspaces-changed";

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const salesRpcContract = defineRpcContract({
  getWorkspace: {
    input: z
      .object({ workspaceId: z.string().min(1), threadId: z.string().min(1) })
      .strict(),
    output: workspaceSchema.strict(),
  },
  mutate: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        threadId: z.string().min(1),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    output: workspaceSchema.strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  async function loadAll(): Promise<Workspace[]> {
    const stored = (await bb.storage.kv.get<Workspace[]>(WORKSPACES_KEY)) ?? [];
    // Pre-thread-container artifacts are intentionally not exposed in normal
    // threads; retaining them here avoids destructive migration.
    return stored;
  }

  async function saveAll(workspaces: Workspace[]): Promise<void> {
    await bb.storage.kv.set(WORKSPACES_KEY, workspaces);
  }

  async function getWorkspace(
    workspaceId: string,
    threadId: string,
  ): Promise<Workspace> {
    const ws = (await loadAll()).find(
      (w) => w.id === workspaceId && w.threadId === threadId,
    );
    if (!ws)
      throw new Error(`workspace not found in this thread: ${workspaceId}`);
    return ws;
  }

  function changed(workspaceId: string, threadId: string): void {
    bb.realtime.publish(SIGNAL_CHANNEL, {
      workspaceId,
      threadId,
      at: Date.now(),
    });
  }

  // Single write path shared by native UI interactions and agent tools.
  async function applyMutations(
    workspaceId: string,
    threadId: string,
    mutations: Mutation[],
  ): Promise<Workspace> {
    const all = await loadAll();
    const ws = all.find((w) => w.id === workspaceId && w.threadId === threadId);
    if (!ws)
      throw new Error(`workspace not found in this thread: ${workspaceId}`);
    for (const mutation of mutations) {
      if (mutation.workspaceId !== workspaceId) {
        throw new Error("mutation workspaceId does not match target workspace");
      }
      applyMutation(ws, mutation);
    }
    ws.updatedAt = new Date().toISOString();
    await saveAll(all);
    changed(workspaceId, threadId);
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
      threadId,
      title: input.title,
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
    changed(ws.id, threadId);
    return ws;
  }

  bb.agents.registerTool({
    name: "sales_list_workspaces",
    description:
      "List persistent native interactive work surfaces in this bb thread.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const rows = (await loadAll())
        .filter((ws) => ws.threadId === context.threadId)
        .map((ws) => ({
          id: ws.id,
          title: ws.title,
          updatedAt: ws.updatedAt,
          viewCount: ws.views.length,
          rowCount: ws.collections.reduce((n, c) => n + c.rows.length, 0),
        }));
      return JSON.stringify(rows);
    },
  });

  bb.agents.registerTool({
    name: "sales_read_workspace",
    description:
      "Read a native work surface's current collections and views. It must belong to this thread.",
    parameters: z.object({ workspaceId: z.string().min(1) }).strict(),
    async execute({ workspaceId }, context) {
      return JSON.stringify(
        toJson(await getWorkspace(workspaceId, context.threadId)),
      );
    },
  });

  bb.agents.registerTool({
    name: "sales_create_workspace",
    description:
      "Create a persistent native interactive surface in this thread, bound to collections and rendered with native primitives.",
    parameters: createWorkspaceInputSchema.strict(),
    async execute(input, context) {
      return JSON.stringify(
        toJson(await createWorkspace(context.threadId, input)),
      );
    },
  });

  bb.agents.registerTool({
    name: "sales_mutate_workspace",
    description:
      "Mutate a thread-native work surface through the same move/patch/add/remove path used by its interactive UI.",
    parameters: z
      .object({
        workspaceId: z.string().min(1),
        mutations: z.array(mutationSchema).min(1),
      })
      .strict(),
    async execute({ workspaceId, mutations }, context) {
      return JSON.stringify(
        toJson(
          await applyMutations(
            workspaceId,
            context.threadId,
            mutations as Mutation[],
          ),
        ),
      );
    },
  });

  // Normal bb threads receive the capability. The instructions make it
  // conditional on relevant workflow requests rather than hijacking chat.
  bb.agents.configure(() => ({
    tools: [
      "sales_list_workspaces",
      "sales_read_workspace",
      "sales_create_workspace",
      "sales_mutate_workspace",
    ],
    skills: [],
    instructions: SALES_AGENT_INSTRUCTIONS,
  }));

  bb.rpc.register(salesRpcContract, {
    async getWorkspace({ workspaceId, threadId }) {
      return toJson(await getWorkspace(workspaceId, threadId));
    },
    async mutate({ workspaceId, threadId, mutations }) {
      return toJson(
        await applyMutations(workspaceId, threadId, mutations as Mutation[]),
      );
    },
  });
}
