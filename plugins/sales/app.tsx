import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type PluginSidebarNavItemsProviderProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { applyMutation, type Mutation, type Workspace } from "./src/model.js";
import { ViewRenderer } from "./src/views.js";
import type { salesRpcContract } from "./server.js";

function useWorkspace(workspaceId: string) {
  const rpc = useRpc<typeof salesRpcContract>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!workspaceId) return;
    rpc
      .call("getWorkspace", { workspaceId })
      .then((next) => {
        setWorkspace(next);
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [rpc, workspaceId]);
  useEffect(refresh, [refresh]);
  useRealtime("workspaces-changed", (payload) => {
    const changedId =
      payload && typeof payload === "object" && "workspaceId" in payload
        ? (payload as { workspaceId?: unknown }).workspaceId
        : undefined;
    if (!changedId || changedId === workspaceId) refresh();
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  const mutate = useCallback(
    (mutations: Mutation[]) => {
      if (!workspace) return;
      const expectedRevision = workspace.revision;
      const optimistic: Workspace = structuredClone(workspace);
      for (const mutation of mutations) applyMutation(optimistic, mutation);
      optimistic.revision += 1;
      setWorkspace(optimistic);
      rpc
        .call("mutate", { workspaceId, expectedRevision, mutations })
        .then((next) => {
          setWorkspace(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          refresh();
        });
    },
    [refresh, rpc, workspace, workspaceId],
  );

  const setPinned = useCallback(
    (pinned: boolean) => {
      if (!workspace) return;
      const previous = workspace;
      setWorkspace({
        ...workspace,
        pinnedAt: pinned ? new Date().toISOString() : null,
      });
      rpc
        .call("setPinned", { workspaceId, pinned })
        .then((next) => {
          setWorkspace(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          setWorkspace(previous);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [rpc, workspace, workspaceId],
  );

  return { workspace, error, mutate, setPinned };
}

function WorkspaceSurface({
  workspaceId,
  fullWidth = false,
}: {
  workspaceId: string;
  fullWidth?: boolean;
}) {
  const { workspace, error, mutate, setPinned } = useWorkspace(workspaceId);
  if (error && !workspace) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }
  if (!workspace) {
    return (
      <div
        className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground"
        aria-busy
      >
        Loading interactive workspace…
      </div>
    );
  }
  return (
    <section
      className={
        fullWidth
          ? "flex h-full min-h-0 flex-col bg-background"
          : "overflow-hidden rounded-xl border bg-background shadow-sm"
      }
    >
      <header className="flex items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
        <div>
          <h3
            className={
              fullWidth
                ? "text-lg font-semibold tracking-tight"
                : "text-sm font-semibold tracking-tight"
            }
          >
            {workspace.title}
          </h3>
          {error ? (
            <div className="mt-1 text-xs text-destructive">{error}</div>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={workspace.pinnedAt ? "secondary" : "default"}
          onClick={() => setPinned(workspace.pinnedAt === null)}
        >
          {workspace.pinnedAt ? "Remove from sidebar" : "Add to sidebar"}
        </Button>
      </header>
      <div
        className={
          fullWidth ? "min-h-0 flex-1 overflow-auto p-5" : "overflow-x-auto p-4"
        }
      >
        <div className="flex flex-col gap-5">
          {workspace.views.map((view) => (
            <ViewRenderer
              key={view.id}
              view={view}
              workspace={workspace}
              mutate={mutate}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function SalesWorkspaceDirective({
  attributes,
  source,
}: PluginMessageDirectiveProps) {
  const workspaceId = attributes.workspaceId?.trim() ?? "";
  if (!workspaceId) {
    return (
      <div
        role="alert"
        title={source}
        className="my-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        sales-workspace requires workspaceId.
      </div>
    );
  }
  return (
    <div className="my-3">
      <WorkspaceSurface workspaceId={workspaceId} />
    </div>
  );
}

function GeneratedToolPanel({ subPath }: PluginNavPanelProps) {
  const workspaceId = useMemo(
    () => subPath.split("/").filter(Boolean)[0] ?? "",
    [subPath],
  );
  if (!workspaceId)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This generated tool is unavailable.
      </div>
    );
  return <WorkspaceSurface workspaceId={workspaceId} fullWidth />;
}

function PinnedToolsProvider({ setState }: PluginSidebarNavItemsProviderProps) {
  const rpc = useRpc<typeof salesRpcContract>();
  const refresh = useCallback(() => {
    rpc
      .call("listPinned", {})
      .then(({ items }) => {
        setState({
          items,
          remove: async (workspaceId) => {
            await rpc.call("setPinned", { workspaceId, pinned: false });
            refresh();
          },
          reorder: async (workspaceIds) => {
            await rpc.call("reorderPinned", {
              workspaceIds: [...workspaceIds],
            });
            refresh();
          },
        });
      })
      .catch(() => setState({ items: [] }));
  }, [rpc, setState]);
  useEffect(refresh, [refresh]);
  useRealtime("workspaces-changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "generated-tool",
    title: "Generated tool",
    icon: "Kanban",
    path: "tool",
    sidebar: false,
    component: GeneratedToolPanel,
  });
  app.slots.sidebarNavItems({
    id: "generated-tools",
    title: "Generated tools",
    targetPanelId: "generated-tool",
    provider: PinnedToolsProvider,
  });
  app.slots.messageDirective({
    id: "sales-workspace",
    component: SalesWorkspaceDirective,
  });
});
