import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { ScrollArea } from "@bb/shared-ui/scroll-area";
import { BlockRenderer } from "./src/components.js";
import type { salesRpcContract } from "./server.js";
import type { WorkspaceState } from "./src/workspace.js";

function SalesSurfacePanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof salesRpcContract>();
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("getState", {})
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection !== "connected") return;
    rpc
      .call("getState", {})
      .then(setState)
      .catch(() => {});
  }, [connection, rpc]);

  const submit = useCallback(
    async (text: string) => {
      setBusy(true);
      setError(null);
      try {
        setState(await rpc.call("command", { text }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {error ?? "Assembling your surface…"}
      </div>
    );
  }

  const lastAgent = [...state.turns].reverse().find((t) => t.role === "agent");

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">{state.spec.title}</h1>
        <p className="text-sm text-muted-foreground">{state.spec.subtitle}</p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-6">
          {lastAgent && (
            <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
              {lastAgent.text}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm">
              {error}
            </div>
          )}
          {state.spec.blocks.map((b, i) => (
            <BlockRenderer key={`${state.spec.id}-${i}`} block={b} />
          ))}
        </div>
      </ScrollArea>
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
          placeholder="Describe how you want to work…"
          className="h-10 flex-1"
          autoFocus
        />
        <Button type="submit" className="h-10" disabled={busy}>
          Send
        </Button>
      </form>
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
