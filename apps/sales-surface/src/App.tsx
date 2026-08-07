import { useState } from "react";
import { ScrollArea } from "@bb/shared-ui/scroll-area";
import { CommandBar } from "./components/CommandBar";
import { Sidebar } from "./components/Sidebar";
import { BlockRenderer } from "./components/primitives";
import { runCommand } from "./lib/agent";
import { defaultSpec, type WorkspaceSpec } from "./lib/spec";

type Turn = { role: "user" | "agent"; text: string };

export function App() {
  const [spec, setSpec] = useState<WorkspaceSpec>(defaultSpec());
  const [turns, setTurns] = useState<Turn[]>([]);

  function handleCommand(text: string) {
    const reply = runCommand(text, spec);
    setSpec(reply.spec);
    setTurns((t) => [...t.slice(-3), { role: "user", text }, { role: "agent", text: reply.message }]);
  }

  const lastAgent = [...turns].reverse().find((t) => t.role === "agent");

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">{spec.title}</h1>
          <p className="text-sm text-muted-foreground">{spec.subtitle}</p>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 p-6">
            {lastAgent && (
              <div className="rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
                {lastAgent.text}
              </div>
            )}
            {spec.blocks.map((b, i) => (
              <BlockRenderer key={`${spec.id}-${i}`} block={b} />
            ))}
          </div>
        </ScrollArea>
        <CommandBar onSubmit={handleCommand} />
      </main>
    </div>
  );
}
