import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { ScrollArea } from "@bb/shared-ui/scroll-area";
import { cn } from "@bb/shared-ui/lib/utils";
import type { Mutation, Workspace } from "./src/model.js";
import { ViewRenderer } from "./src/views.js";
import type { salesRpcContract } from "./server.js";

type Summary = {
  id: string;
  title: string;
  updatedAt: string;
  viewCount: number;
  rowCount: number;
};

function SalesSurfacePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof salesRpcContract>();
  const navigate = useBbNavigate();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Route: /plugins/sales/sales/ws/<id>
  const selectedId = useMemo(() => {
    const m = /^ws\/(.+)$/.exec(subPath);
    return m?.[1] ?? null;
  }, [subPath]);

  const refreshList = useCallback(() => {
    rpc
      .call("listWorkspaces", {})
      .then((r) => setSummaries(r.workspaces))
      .catch(() => {});
  }, [rpc]);

  const refreshWorkspace = useCallback(
    (id: string) => {
      rpc
        .call("getWorkspace", { workspaceId: id })
        .then(setWorkspace)
        .catch(() => setWorkspace(null));
    },
    [rpc],
  );

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (selectedId) refreshWorkspace(selectedId);
    else setWorkspace(null);
  }, [selectedId, refreshWorkspace]);

  // Live updates: any mutation (ours, another panel, or the agent) repaints.
  useRealtime("workspaces-changed", () => {
    refreshList();
    if (selectedId) refreshWorkspace(selectedId);
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection !== "connected") return;
    refreshList();
    if (selectedId) refreshWorkspace(selectedId);
  }, [connection, refreshList, refreshWorkspace, selectedId]);

  const mutate = useCallback(
    (mutations: Mutation[]) => {
      if (!workspace) return;
      rpc
        .call("mutate", { workspaceId: workspace.id, mutations })
        .then(setWorkspace)
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
        );
    },
    [rpc, workspace],
  );

  const submit = useCallback(
    async (text: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await rpc.call("command", {
          text,
          workspaceId: workspace?.id,
        });
        setReply(r.reply);
        refreshList();
        if (r.workspaceId) {
          navigate.toPluginPanel("sales", { subPath: `ws/${r.workspaceId}` });
        } else if (workspace) {
          refreshWorkspace(workspace.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [rpc, workspace, navigate, refreshList, refreshWorkspace],
  );

  return (
    <div className="flex h-full bg-background">
      {/* Workspace switcher */}
      <div className="flex w-52 shrink-0 flex-col border-r bg-muted/30">
        <div className="border-b px-3 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Workspaces
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 p-2">
            {summaries.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  navigate.toPluginPanel("sales", { subPath: `ws/${s.id}` })
                }
                className={cn(
                  "rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  s.id === selectedId
                    ? "bg-accent font-medium"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <div className="truncate">{s.title}</div>
                <div className="text-[10px] text-muted-foreground/70">
                  {s.viewCount} views · {s.rowCount} rows
                </div>
              </button>
            ))}
            {summaries.length === 0 && (
              <div className="px-2.5 py-4 text-xs text-muted-foreground">
                No workspaces yet. Describe what you want to work on below.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main surface */}
      <div className="flex min-w-0 flex-1 flex-col">
        {workspace ? (
          <>
            <header className="border-b px-6 py-4">
              <h1 className="text-lg font-semibold tracking-tight">{workspace.title}</h1>
            </header>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-5 p-6">
                {busy && (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">agent working</Badge>
                    Working on it…
                  </div>
                )}
                {!busy && reply && (
                  <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
                    {reply}
                  </div>
                )}
                {error && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm">
                    {error}
                  </div>
                )}
                {workspace.views.map((v) => (
                  <ViewRenderer key={v.id} view={v} workspace={workspace} mutate={mutate} />
                ))}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md text-center">
              <div className="text-lg font-semibold tracking-tight">What are you working on?</div>
              <p className="mt-2 text-sm text-muted-foreground">
                Describe a sales workflow — a pipeline, a job search, a forecast,
                meeting prep, target accounts — and I'll build a workspace for it.
              </p>
              {busy && (
                <div className="mt-4 text-sm text-muted-foreground">Working on it…</div>
              )}
              {reply && !busy && (
                <div className="mt-4 rounded-lg border bg-muted/40 px-4 py-2.5 text-left text-sm text-muted-foreground">
                  {reply}
                </div>
              )}
              {error && (
                <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-left text-sm">
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        {/* App-level command bar */}
        <form
          className="flex items-center gap-2 border-t bg-background p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text || busy) return;
            setDraft("");
            void submit(text);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              workspace
                ? `Ask about or change "${workspace.title}" — or describe something new…`
                : "Describe what you want to work on…"
            }
            className="h-10 flex-1"
            autoFocus
          />
          <Button type="submit" className="h-10" disabled={busy}>
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sales",
    title: "Sales Surface",
    icon: "ChartLineData01",
    path: "sales",
    component: SalesSurfacePanel,
  });
});
