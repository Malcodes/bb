// bb-plugin-sales — server side. Owns the sales workspace state: a layout
// spec rendered by the plugin's navPanel, plus the recent command/agent
// turns. Phase 1 keeps command handling scripted (see src/agent.ts); the
// state plumbing is what the real agent loop will write through later.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { defaultSpec, type Block, type WorkspaceSpec } from "./src/spec.js";
import { SALES_AGENT_INSTRUCTIONS } from "./src/instructions.js";
import type { WorkspaceState } from "./src/workspace.js";

const STATE_KEY = "workspace-state";

export const blockSchema: z.ZodType<Block> = z.lazy(() =>
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

export const specSchema = z.object({
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

const commandResultSchema = stateSchema.extend({
  status: z.enum(["ok", "working", "error"]).optional(),
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
    output: commandResultSchema.strict(),
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

  // ------------------------------------------------------------------
  // Agent wiring: a persistent bb thread does the composing. The plugin
  // teaches that thread the data + output contract (dynamic instructions)
  // and gives it one native tool that writes the workspace state — the
  // same write path the RPC command handler uses, so the surface,
  // persistence, and any future agent all share one state store.
  // ------------------------------------------------------------------

  const THREAD_KEY = "workspace-thread-id";
  const pendingReplies = new Map<string, string>();

  bb.agents.registerTool({
    name: "sales_update_workspace",
    description:
      "Replace the Sales Surface workspace with a new layout spec. Call exactly once per user request, with the complete spec.",
    parameters: z
      .object({
        spec: specSchema,
        reply: z.string().min(1),
      })
      .strict(),
    async execute({ spec, reply }, ctx) {
      // specSchema validates structure; cast through JSON to the typed spec.
      const nextSpec = JSON.parse(JSON.stringify(spec)) as WorkspaceSpec;
      const current = await loadState();
      await saveState({ ...current, spec: nextSpec });
      pendingReplies.set(ctx.threadId, reply);
      bb.log.info(
        `workspace updated by thread ${ctx.threadId}: "${nextSpec.title}" (${nextSpec.blocks.length} blocks)`,
      );
      return "Workspace updated and persisted. It is now visible in Sales Surface.";
    },
  });

  bb.agents.contributeInstructions(({ threadId }) =>
    threadId === workspaceThreadId ? SALES_AGENT_INSTRUCTIONS : null,
  );

  let workspaceThreadId: string | null =
    (await bb.storage.kv.get<string>(THREAD_KEY)) ?? null;

  function buildPrompt(text: string, spec: WorkspaceSpec): string {
    return [
      "The user typed into the Sales Surface command bar:",
      "",
      `"${text}"`,
      "",
      "The CURRENT workspace spec is:",
      "",
      "```json",
      JSON.stringify(spec, null, 2),
      "```",
      "",
      "Follow your Sales Surface instructions: decide what interface best serves this request, then call sales_update_workspace once with the complete new spec and a short reply for the user.",
    ].join("\n");
  }

  async function ensureWorkspaceThread(): Promise<string> {
    if (workspaceThreadId !== null) {
      try {
        const existing = await bb.sdk.threads.get({
          threadId: workspaceThreadId,
        });
        if (existing && typeof existing === "object" && "id" in existing) {
          return workspaceThreadId;
        }
      } catch {
        bb.log.info("stored workspace thread is gone; spawning a new one");
      }
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
          text: "You are starting as the persistent Sales Surface agent. Acknowledge briefly and wait for the user's first command.",
          mentions: [],
        },
      ],
    });
    workspaceThreadId = thread.id;
    await bb.storage.kv.set(THREAD_KEY, thread.id);
    bb.log.info(`spawned workspace thread ${thread.id}`);
    // The first turn boots the provider session; wait for it to finish so
    // later sends never race the "starting" state.
    await bb.sdk.threads.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: 180_000,
      pollIntervalMs: 500,
    });
    return thread.id;
  }

  async function runAgentCommand(text: string, current: WorkspaceState) {
    const threadId = await ensureWorkspaceThread();
    pendingReplies.delete(threadId);
    // Ensure any previous turn has fully settled before sending.
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
          text: buildPrompt(text, current.spec),
          mentions: [],
        },
      ],
      mode: "auto",
    });
    const wait = await bb.sdk.threads.wait({
      threadId,
      status: "idle",
      timeoutMs: 180_000,
      pollIntervalMs: 500,
    });
    if (!("status" in wait) && !wait.matched) {
      throw new Error("the agent did not finish in time");
    }
  }

  bb.rpc.register(salesRpcContract, {
    async getState() {
      return toJson(await loadState());
    },

    async command({ text }) {
      const current = await loadState();
      const withUser: WorkspaceState = {
        ...current,
        turns: [...current.turns.slice(-3), { role: "user", text }],
      };
      await saveState(withUser);

      try {
        const threadId = await ensureWorkspaceThread();
        await runAgentCommand(text, withUser);
        const replyText =
          pendingReplies.get(threadId) ??
          "Done — I updated the surface.";
        pendingReplies.delete(threadId);
        const after = await loadState();
        const next: WorkspaceState = {
          ...after,
          turns: [...after.turns, { role: "agent", text: replyText }],
        };
        await saveState(next);
        return toJson({ ...next, status: "ok" as const });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        bb.log.info(`agent command failed: ${message}`);
        const after = await loadState();
        const next: WorkspaceState = {
          ...after,
          turns: [
            ...after.turns,
            {
              role: "agent",
              text: `I couldn't assemble that — ${message}. Try rephrasing, or ask again in a moment.`,
            },
          ],
        };
        await saveState(next);
        return toJson({ ...next, status: "error" as const });
      }
    },
  });
}
