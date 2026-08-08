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
  async function loadAll(): Promise<Workspace[]> {
    const raw =
      (await bb.storage.kv.get<Array<Partial<Workspace> & { id: string }>>(
        WORKSPACES_KEY,
      )) ?? [];
    // Non-destructive migration from the thread-contained prototype.
    return raw.map((ws, index) => ({
      ...ws,
      originThreadId:
        ws.originThreadId ?? (ws as { threadId?: string }).threadId ?? "legacy",
      pinnedAt: ws.pinnedAt ?? null,
      navOrder: ws.navOrder ?? index,
      revision: ws.revision ?? 0,
    })) as Workspace[];
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
      return JSON.stringify(
        toJson(await createWorkspace(context.threadId, input)),
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
    async execute({ workspaceId, expectedRevision, mutations }) {
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
  });
}
