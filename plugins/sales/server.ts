// bb-plugin-sales — server side. Owns the sales workspace state: a layout
// spec rendered by the plugin's navPanel, plus the recent command/agent
// turns. Phase 1 keeps command handling scripted (see src/agent.ts); the
// state plumbing is what the real agent loop will write through later.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { runCommand } from "./src/agent.js";
import { defaultSpec, type Block } from "./src/spec.js";
import type { WorkspaceState } from "./src/workspace.js";

const STATE_KEY = "workspace-state";

const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("metrics"),
      items: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          hint: z.string().optional(),
        }),
      ),
    }),
    z.object({
      kind: z.literal("table"),
      title: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      badges: z.array(z.number().nullable()).optional(),
    }),
    z.object({
      kind: z.literal("kanban"),
      title: z.string(),
      lanes: z.array(
        z.object({
          name: z.string(),
          cards: z.array(
            z.object({
              title: z.string(),
              sub: z.string(),
              flag: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
    z.object({
      kind: z.literal("timeline"),
      title: z.string(),
      items: z.array(
        z.object({ time: z.string(), title: z.string(), sub: z.string() }),
      ),
    }),
    z.object({
      kind: z.literal("cards"),
      title: z.string(),
      cards: z.array(
        z.object({
          title: z.string(),
          sub: z.string(),
          body: z.string(),
          flag: z.string().optional(),
        }),
      ),
    }),
    z.object({
      kind: z.literal("list"),
      title: z.string(),
      items: z.array(z.object({ title: z.string(), sub: z.string() })),
    }),
  ]),
);

const specSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  blocks: z.array(blockSchema),
});

const stateSchema = z.object({
  spec: specSchema,
  turns: z.array(
    z.object({ role: z.enum(["user", "agent"]), text: z.string() }),
  ),
});


/** RPC results must be plain JSON — strip undefined optional fields. */
function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const salesRpcContract = defineRpcContract({
  getState: {
    input: z.object({}).strict(),
    output: stateSchema.strict(),
  },
  command: {
    input: z.object({ text: z.string().trim().min(1) }).strict(),
    output: stateSchema.strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  async function loadState(): Promise<WorkspaceState> {
    const stored = await bb.storage.kv.get<WorkspaceState>(STATE_KEY);
    if (stored && stored.spec) return stored;
    const fresh: WorkspaceState = { spec: defaultSpec(), turns: [] };
    await bb.storage.kv.set(STATE_KEY, fresh);
    return fresh;
  }

  async function saveState(state: WorkspaceState): Promise<void> {
    await bb.storage.kv.set(STATE_KEY, state);
  }

  bb.rpc.register(salesRpcContract, {
    async getState() {
      return toJson(await loadState());
    },

    async command({ text }) {
      const current = await loadState();
      const reply = runCommand(text, current.spec);
      const next: WorkspaceState = {
        spec: reply.spec,
        turns: [
          ...current.turns.slice(-3),
          { role: "user", text },
          { role: "agent", text: reply.message },
        ],
      };
      await saveState(next);
      return toJson(next);
    },
  });
}
