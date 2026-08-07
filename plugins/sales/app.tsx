import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";
import type { Mutation, Workspace } from "./src/model.js";
import { ViewRenderer } from "./src/views.js";
import type { salesRpcContract } from "./server.js";

function SalesWorkspaceDirective({
  attributes,
  message,
  source,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof salesRpcContract>();
  const workspaceId = attributes.workspaceId?.trim() ?? "";
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!workspaceId) {
      setError("sales-workspace requires a workspaceId attribute.");
      return;
    }
    rpc
      .call("getWorkspace", { workspaceId, threadId: message.threadId })
      .then((next) => {
        setWorkspace(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [message.threadId, rpc, workspaceId]);

  useEffect(() => refresh(), [refresh]);
  useRealtime("workspaces-changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  const mutate = useCallback(
    (mutations: Mutation[]) => {
      if (!workspace) return;
      rpc
        .call("mutate", {
          workspaceId: workspace.id,
          threadId: message.threadId,
          mutations,
        })
        .then(setWorkspace)
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [message.threadId, rpc, workspace],
  );

  if (error) {
    return (
      <div
        role="alert"
        title={source}
        className="my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        Could not load interactive workspace: {error}
      </div>
    );
  }
  if (!workspace) {
    return (
      <div
        className="my-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
        aria-busy="true"
      >
        Loading interactive workspace…
      </div>
    );
  }

  return (
    <section className="my-3 overflow-hidden rounded-xl border bg-background shadow-sm">
      <header className="border-b bg-muted/20 px-4 py-3">
        <h3 className="text-sm font-semibold tracking-tight">
          {workspace.title}
        </h3>
      </header>
      <div className="flex flex-col gap-5 overflow-x-auto p-4">
        {workspace.views.map((view) => (
          <ViewRenderer
            key={view.id}
            view={view}
            workspace={workspace}
            mutate={mutate}
          />
        ))}
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({
    id: "sales-workspace",
    component: SalesWorkspaceDirective,
  });
});
