/**
 * Shared workspace state model: what the surface is currently showing. The
 * server owns this state (plugin KV), so it survives reloads and will later
 * be mutated by the real agent loop; the navPanel subscribes via RPC.
 */
import type { WorkspaceSpec } from "./spec.js";

export type Turn = { role: "user" | "agent"; text: string };

export type WorkspaceState = {
  spec: WorkspaceSpec;
  turns: Turn[];
};
