import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type PluginSidebarNavItemsProviderProps,
} from "@bb/plugin-sdk/app";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  applyMutation,
  type Mutation,
  type NativeCompositionNode,
  type View,
  type Workspace,
} from "./src/model.js";
import { ViewRenderer } from "./src/views.js";
import { safeIcon } from "./src/generated-app.js";
import { deriveAttentionSummary } from "./src/orchestration.js";
import { workspaceIdFromDirective } from "./src/workspace-directive.js";
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

  const resolveRecommendation = useCallback(
    (
      recommendationId: string,
      decision: "approved" | "rejected" | "resolved",
    ) => {
      if (!workspace) return;
      rpc
        .call("resolveRecommendation", {
          workspaceId,
          recommendationId,
          decision,
        })
        .then((next) => {
          setWorkspace(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [rpc, workspace, workspaceId],
  );

  return { workspace, error, mutate, setPinned, resolveRecommendation };
}

const MODULE_MIN_HEIGHT = 280;
const MODULE_MAX_HEIGHT = 720;

function AttentionSummary({ workspace }: { workspace: Workspace }) {
  return (
    <aside
      className="flex items-start gap-2.5 rounded-md border border-amber-500/15 bg-amber-500/[0.055] px-3 py-2.5"
      aria-label="Attention summary"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-amber-500/10 text-amber-700 dark:text-amber-300">
        <Icon name="AlertCircle" className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.065em] text-amber-800/80 dark:text-amber-200/80">
          Attention
        </div>
        <p className="mt-0.5 text-xs leading-[1.45] text-foreground/80">
          {deriveAttentionSummary(workspace)}
        </p>
      </div>
    </aside>
  );
}

function WorkspaceModule({
  view,
  children,
  onResize,
}: {
  view: View;
  children: ReactNode;
  onResize(height?: number): void;
}) {
  const sortable = useSortable({ id: view.id });
  const [draftHeight, setDraftHeight] = useState<number | undefined>(
    view.layout?.height,
  );
  const draftRef = useRef(draftHeight);
  useEffect(() => {
    setDraftHeight(view.layout?.height);
    draftRef.current = view.layout?.height;
  }, [view.layout?.height]);
  const resizable = view.primitive !== "metrics";
  const style = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    height: resizable ? draftHeight : undefined,
    zIndex: sortable.isDragging ? 20 : undefined,
    opacity: sortable.isDragging ? 0.72 : undefined,
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const module = event.currentTarget.closest<HTMLElement>(
      "[data-workspace-module]",
    );
    const startHeight = module?.getBoundingClientRect().height ?? 360;
    const move = (pointer: PointerEvent) => {
      const next = Math.max(
        MODULE_MIN_HEIGHT,
        Math.min(
          MODULE_MAX_HEIGHT,
          Math.round(startHeight + pointer.clientY - startY),
        ),
      );
      draftRef.current = next;
      setDraftHeight(next);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (draftRef.current !== view.layout?.height) onResize(draftRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  return (
    <section
      ref={sortable.setNodeRef}
      style={style}
      data-workspace-module={view.id}
      className="relative flex min-h-0 min-w-0 flex-col rounded-lg border border-border/75 bg-background shadow-[0_1px_2px_hsl(var(--foreground)/0.025)]"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          className="flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
          aria-label={`Reorder ${view.title} module`}
        >
          <Icon name="DragDropVertical" className="size-3.5" />
        </button>
        <span className="truncate text-[11px] font-semibold text-foreground/75">
          {view.title}
        </span>
        {resizable && view.layout?.height ? (
          <button
            type="button"
            onClick={() => onResize(undefined)}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
          >
            Fit content
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {resizable ? (
        <button
          type="button"
          onPointerDown={beginResize}
          className="absolute inset-x-0 bottom-0 z-10 h-2 cursor-row-resize touch-none opacity-0 transition-opacity hover:opacity-100 focus:opacity-100"
          aria-label={`Resize ${view.title} module vertically`}
        >
          <span className="mx-auto block h-px w-10 bg-border" />
        </button>
      ) : null}
    </section>
  );
}

function AutonomyPanel({
  workspace,
  onResolve,
}: {
  workspace: Workspace;
  onResolve(id: string, decision: "approved" | "rejected" | "resolved"): void;
}) {
  const state = workspace.autonomy;
  if (!state?.policy.enabled && !state?.recommendations.length) return null;
  const open = (state?.recommendations ?? []).filter(
    (item) => item.status === "open",
  );
  const lastRun = state?.runs[0];
  return (
    <aside
      className="rounded-lg border border-border/75 bg-background"
      aria-label="Agent operator"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="relative flex size-5 items-center justify-center rounded bg-blue-500/10 text-blue-700 dark:text-blue-300">
          <Icon name="AiContentGenerator01" className="size-3.5" />
          {lastRun?.status === "running" ? (
            <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-blue-500" />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold">Agent operator</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {state?.policy.goal || "Monitoring workspace state"}
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {lastRun?.status === "running"
            ? "Working now"
            : lastRun?.completedAt
              ? `Last run ${new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((Date.parse(lastRun.completedAt) - Date.now()) / 60_000), "minute")}`
              : `Every ${state?.policy.cadenceMinutes ?? 30}m`}
        </span>
      </header>
      {open.length ? (
        <div className="divide-y divide-border/60">
          {open.slice(0, 5).map((item) => (
            <section
              key={item.id}
              className="flex items-start gap-2.5 px-3 py-2.5"
            >
              <Icon
                name={safeIcon(
                  item.kind === "exception"
                    ? "AlertTriangle"
                    : item.kind === "external-action"
                      ? "ShieldCheck"
                      : "Lightbulb",
                  "AlertCircle",
                )}
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{item.title}</div>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {item.rationale}
                </p>
                {item.evidence.length ? (
                  <p className="mt-1 truncate text-[10px] text-muted-foreground/80">
                    Evidence: {item.evidence.join(" · ")}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                {item.kind === "external-action" ? (
                  <>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => onResolve(item.id, "approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => onResolve(item.id, "rejected")}
                    >
                      Reject
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => onResolve(item.id, "resolved")}
                  >
                    Resolve
                  </Button>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">
          No open exceptions or decisions.
        </p>
      )}
    </aside>
  );
}

const compositionGap = {
  none: "gap-0",
  compact: "gap-2",
  normal: "gap-3",
  spacious: "gap-6",
} as const;
const compositionColumns = {
  1: "grid-cols-1",
  2: "grid-cols-1 md:grid-cols-2",
  3: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5",
  6: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6",
  7: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7",
  8: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8",
  9: "grid-cols-1 sm:grid-cols-3 xl:grid-cols-6 2xl:grid-cols-9",
  10: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 2xl:grid-cols-10",
  11: "grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-11",
  12: "grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-12",
} as const;
const compositionSpan = {
  1: "col-span-1",
  2: "col-span-1 md:col-span-2",
  3: "col-span-1 md:col-span-2 xl:col-span-3",
  4: "col-span-1 md:col-span-2 xl:col-span-4",
  5: "col-span-1 md:col-span-2 xl:col-span-5",
  6: "col-span-1 md:col-span-2 xl:col-span-6",
  7: "col-span-1 md:col-span-2 xl:col-span-7",
  8: "col-span-1 md:col-span-2 xl:col-span-8",
  9: "col-span-1 md:col-span-2 xl:col-span-9",
  10: "col-span-1 md:col-span-2 xl:col-span-10",
  11: "col-span-1 md:col-span-2 xl:col-span-11",
  12: "col-span-full",
} as const;

function NativeFrame({
  node,
  title,
  children,
  height,
}: {
  node: Extract<NativeCompositionNode, { type: "view" | "surface" }>;
  title?: string;
  children: ReactNode;
  height?: number;
}) {
  const chrome = node.chrome ?? "card";
  const density = node.density ?? "comfortable";
  const emphasis = node.emphasis ?? "normal";
  const padding =
    density === "compact" ? "p-0" : density === "spacious" ? "p-3" : "p-1.5";
  const span = node.span?.lg ?? node.span?.md ?? node.span?.base ?? 12;
  if (chrome === "none") {
    return (
      <div
        data-composition-node={node.id}
        className={`min-h-0 min-w-0 ${compositionSpan[span as keyof typeof compositionSpan]}`}
        style={{ height }}
      >
        {children}
      </div>
    );
  }
  return (
    <section
      data-composition-node={node.id}
      className={`min-h-0 min-w-0 overflow-hidden rounded-lg border ${
        emphasis === "primary"
          ? "border-primary/25 bg-primary/[0.025] shadow-sm"
          : emphasis === "quiet" || chrome === "subtle"
            ? "border-border/50 bg-muted/20"
            : "border-border/75 bg-background shadow-[0_1px_2px_hsl(var(--foreground)/0.025)]"
      } ${compositionSpan[span as keyof typeof compositionSpan]}`}
      style={{ height }}
    >
      {title ? (
        <header
          className={`border-b border-border/50 px-3 ${density === "compact" ? "py-1.5" : "py-2"}`}
        >
          <h2 className="text-[11px] font-semibold text-foreground/75">
            {title}
          </h2>
        </header>
      ) : null}
      <div
        className={`min-h-0 ${height ? "h-[calc(100%-2rem)] overflow-hidden" : ""} ${padding}`}
      >
        {children}
      </div>
    </section>
  );
}

function CompositionTabs({
  node,
  render,
}: {
  node: Extract<NativeCompositionNode, { type: "tabs" }>;
  render(node: NativeCompositionNode): ReactNode;
}) {
  const [active, setActive] = useState(node.tabs[0]?.id ?? "");
  useEffect(() => {
    if (!node.tabs.some((tab) => tab.id === active))
      setActive(node.tabs[0]?.id ?? "");
  }, [active, node.tabs]);
  const selected = node.tabs.find((tab) => tab.id === active) ?? node.tabs[0];
  return (
    <section
      data-composition-node={node.id}
      className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background"
    >
      <div
        role="tablist"
        className="flex gap-1 border-b border-border/60 px-2 pt-1.5"
      >
        {node.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === selected?.id}
            onClick={() => setActive(tab.id)}
            className={`rounded-t px-2.5 py-1.5 text-[11px] font-medium ${
              tab.id === selected?.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="p-2.5">
        {selected ? render(selected.child) : null}
      </div>
    </section>
  );
}

function NativeComposition({
  workspace,
  mutate,
  resolveRecommendation,
}: {
  workspace: Workspace;
  mutate(mutations: Mutation[]): void;
  resolveRecommendation(
    id: string,
    decision: "approved" | "rejected" | "resolved",
  ): void;
}) {
  const render = (node: NativeCompositionNode): ReactNode => {
    if (node.type === "view") {
      const view = workspace.views.find(
        (candidate) =>
          candidate.id === node.viewId && candidate.visible !== false,
      );
      if (!view) return null;
      return (
        <NativeFrame
          key={node.id}
          node={node}
          title={node.chrome === "none" ? undefined : view.title}
          height={
            view.primitive === "metrics" ? undefined : view.layout?.height
          }
        >
          <ViewRenderer view={view} workspace={workspace} mutate={mutate} />
        </NativeFrame>
      );
    }
    if (node.type === "surface") {
      return (
        <NativeFrame key={node.id} node={node}>
          {node.surface === "attention" ? (
            <AttentionSummary workspace={workspace} />
          ) : (
            <AutonomyPanel
              workspace={workspace}
              onResolve={resolveRecommendation}
            />
          )}
        </NativeFrame>
      );
    }
    if (node.type === "tabs")
      return <CompositionTabs key={node.id} node={node} render={render} />;
    const gap = compositionGap[node.gap ?? "normal"];
    if (node.type === "stack") {
      return (
        <div
          key={node.id}
          data-composition-node={node.id}
          className={`flex min-w-0 flex-col ${gap}`}
        >
          {node.children.map(render)}
        </div>
      );
    }
    if (node.type === "grid") {
      const columns =
        compositionColumns[
          (node.columns ?? 12) as keyof typeof compositionColumns
        ];
      return (
        <div
          key={node.id}
          data-composition-node={node.id}
          className={`grid min-w-0 ${columns} ${gap}`}
        >
          {node.children.map(render)}
        </div>
      );
    }
    if (node.type === "split") {
      const ratio = node.ratio ?? "1:1";
      const template = {
        "1:1": "md:grid-cols-2",
        "1:2": "md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
        "2:1": "md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
        "1:3": "md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]",
        "3:1": "md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]",
      }[ratio];
      return (
        <div
          key={node.id}
          data-composition-node={node.id}
          className={`grid min-w-0 grid-cols-1 ${template} ${gap}`}
        >
          {node.children.map(render)}
        </div>
      );
    }
    return (
      <section
        key={node.id}
        data-composition-node={node.id}
        className={`min-w-0 rounded-xl ${
          node.tone === "accent"
            ? "border border-primary/15 bg-primary/[0.025] p-3"
            : node.tone === "subtle"
              ? "bg-muted/25 p-3"
              : ""
        }`}
      >
        {node.title ? (
          <h2 className="text-sm font-semibold tracking-[-0.01em]">
            {node.title}
          </h2>
        ) : null}
        {node.description ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {node.description}
          </p>
        ) : null}
        <div
          className={`${node.title || node.description ? "mt-2.5" : ""} flex min-w-0 flex-col ${gap}`}
        >
          {node.children.map(render)}
        </div>
      </section>
    );
  };
  return <>{render(workspace.composition!)}</>;
}

function WorkspaceSurface({
  workspaceId,
  fullWidth = false,
}: {
  workspaceId: string;
  fullWidth?: boolean;
}) {
  const { workspace, error, mutate, setPinned, resolveRecommendation } =
    useWorkspace(workspaceId);
  const moduleSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
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
  const rowCount = workspace.collections.reduce(
    (total, collection) => total + collection.rows.length,
    0,
  );
  const updated = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(workspace.updatedAt));
  const visibleViews = workspace.views.filter((view) => view.visible !== false);
  const handleModuleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = workspace.views.findIndex(
      (view) => view.id === event.active.id,
    );
    const to = workspace.views.findIndex((view) => view.id === event.over?.id);
    if (from < 0 || to < 0) return;
    const reordered = [...workspace.views];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    mutate([
      {
        op: "reorderViews",
        workspaceId: workspace.id,
        viewIds: reordered.map((view) => view.id),
      },
    ]);
  };
  return (
    <section
      className={
        fullWidth
          ? "flex h-full min-h-0 flex-col bg-background"
          : "overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_2px_8px_hsl(var(--foreground)/0.045)]"
      }
      data-generated-app-surface={fullWidth ? "application" : "inline"}
    >
      <header
        className={
          fullWidth
            ? "flex min-h-[68px] shrink-0 items-center justify-between gap-5 border-b bg-background px-6"
            : "flex items-center justify-between gap-3 border-b bg-muted/15 px-4 py-3"
        }
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={
              fullWidth
                ? "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]"
                : "flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
            }
          >
            <Icon
              name={safeIcon(workspace.icon, "AppWindow")}
              className={fullWidth ? "size-4.5" : "size-3.5"}
            />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1
                className={
                  fullWidth
                    ? "truncate text-[15px] font-semibold tracking-[-0.012em]"
                    : "truncate text-sm font-semibold tracking-[-0.01em]"
                }
              >
                {workspace.title}
              </h1>
              {fullWidth ? (
                <span className="hidden items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 sm:inline-flex">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  Synced
                </span>
              ) : null}
            </div>
            {fullWidth ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {workspace.description ??
                  `${rowCount} records · Updated ${updated}`}
              </p>
            ) : null}
            {error ? (
              <div className="mt-1 text-xs text-destructive">{error}</div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant={workspace.pinnedAt ? "ghost" : "default"}
            className="h-8 rounded-md px-2.5 text-xs"
            onClick={() => setPinned(workspace.pinnedAt === null)}
          >
            <Icon
              name={workspace.pinnedAt ? "PinOff" : "Pin"}
              className="mr-1.5 size-3.5"
            />
            {workspace.pinnedAt ? "Unpin" : "Add to sidebar"}
          </Button>
        </div>
      </header>
      <div
        className={
          fullWidth
            ? "min-h-0 flex-1 overflow-auto bg-muted/[0.12] p-3.5 lg:p-4"
            : "overflow-x-auto p-3"
        }
      >
        {workspace.composition ? (
          <NativeComposition
            workspace={workspace}
            mutate={mutate}
            resolveRecommendation={resolveRecommendation}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-2.5">
            <AttentionSummary workspace={workspace} />
            <AutonomyPanel
              workspace={workspace}
              onResolve={resolveRecommendation}
            />
            <DndContext
              sensors={moduleSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleModuleDragEnd}
            >
              <SortableContext
                items={visibleViews.map((view) => view.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex min-w-0 flex-col gap-2.5">
                  {visibleViews.map((view) => (
                    <WorkspaceModule
                      key={view.id}
                      view={view}
                      onResize={(height) =>
                        mutate([
                          {
                            op: "setViewLayout",
                            workspaceId: workspace.id,
                            viewId: view.id,
                            height,
                          },
                        ])
                      }
                    >
                      <ViewRenderer
                        view={view}
                        workspace={workspace}
                        mutate={mutate}
                      />
                    </WorkspaceModule>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>
    </section>
  );
}

function SalesWorkspaceDirective({
  attributes,
  source,
}: PluginMessageDirectiveProps) {
  const workspaceId = workspaceIdFromDirective(attributes);
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
    surface: "application",
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
