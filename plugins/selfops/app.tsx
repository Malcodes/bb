/**
 * SelfOps status surface — hidden by default.
 *
 * The sidebar row exists ONLY while there is something worth Malcolm's
 * attention: a material system failure, an improvement awaiting approval, a
 * meaningful adopted improvement, or a significant cost/reliability
 * regression. When there is nothing, no row is published at all.
 */
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
  type PluginSidebarNavItemsProviderProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import type { selfopsRpcContract } from "./server.js";

type Notice = {
  id: string;
  category:
    | "material-failure"
    | "approval-required"
    | "adopted-improvement"
    | "regression";
  title: string;
  detail: string;
  attentionId?: string;
};

const CATEGORY_LABEL: Record<Notice["category"], string> = {
  "material-failure": "Needs attention",
  "approval-required": "Approval required",
  "adopted-improvement": "Improvement adopted",
  regression: "Regression",
};

function StatusProvider({ setState }: PluginSidebarNavItemsProviderProps) {
  const rpc = useRpc<typeof selfopsRpcContract>();
  const refresh = useCallback(() => {
    rpc
      .call("readBrief", {})
      .then(({ notices }) => {
        setState({
          items:
            notices.length === 0
              ? []
              : [
                  {
                    id: "selfops-status",
                    title: `SelfOps — ${notices.length} notice${notices.length === 1 ? "" : "s"}`,
                  },
                ],
        });
      })
      .catch(() => setState({ items: [] }));
  }, [rpc, setState]);
  useEffect(refresh, [refresh]);
  useRealtime("selfops-changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);
  return null;
}

function StatusPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof selfopsRpcContract>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const refresh = useCallback(() => {
    rpc
      .call("readBrief", {})
      .then((brief) => setNotices(brief.notices as Notice[]))
      .catch(() => setNotices([]));
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("selfops-changed", refresh);

  const decide = (attentionId: string, decision: "approved" | "rejected") => {
    rpc
      .call("resolveAttention", { attentionId, decision })
      .then(refresh)
      .catch(() => undefined);
  };

  if (notices.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Nothing needs your attention.
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-2 p-4">
      {notices.map((notice) => (
        <section
          key={notice.id}
          className="rounded-md border border-border/70 px-3 py-2.5"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABEL[notice.category]}
          </div>
          <div className="mt-0.5 text-xs font-medium">{notice.title}</div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {notice.detail}
          </p>
          {notice.attentionId ? (
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                className="h-7 px-2 text-[10px]"
                onClick={() =>
                  notice.attentionId && decide(notice.attentionId, "approved")
                }
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[10px]"
                onClick={() =>
                  notice.attentionId && decide(notice.attentionId, "rejected")
                }
              >
                Reject
              </Button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "selfops-status",
    title: "SelfOps",
    icon: "Toolbox",
    path: "status",
    sidebar: false,
    surface: "application",
    component: StatusPanel,
  });
  app.slots.sidebarNavItems({
    id: "selfops",
    title: "System",
    targetPanelId: "selfops-status",
    provider: StatusProvider,
  });
});
