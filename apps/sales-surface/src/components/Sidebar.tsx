import { Badge } from "@bb/shared-ui/badge";
import { Separator } from "@bb/shared-ui/separator";

const agents = [
  { name: "Pipeline agent", active: true },
  { name: "Meeting prep agent", active: false },
  { name: "Research agent", active: false },
];

const workspaces = ["Pipeline", "Meeting prep", "Q3 review"];

const tasks = [
  { name: "Assembled pipeline workspace", time: "9:41 AM" },
  { name: "Filtered deals < $25K", time: "9:43 AM" },
  { name: "Built meeting briefs", time: "9:45 AM" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-5 border-r bg-muted/30 p-3">
      <div className="px-3 pt-2 text-sm font-semibold tracking-tight">Sales Surface</div>
      <Section title="Agents">
        {agents.map((a) => (
          <div key={a.name} className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm hover:bg-muted">
            <span>{a.name}</span>
            {a.active && <Badge variant="secondary" className="text-[10px]">active</Badge>}
          </div>
        ))}
      </Section>
      <Separator />
      <Section title="Workspaces">
        {workspaces.map((w) => (
          <div key={w} className="rounded-md px-3 py-1.5 text-sm hover:bg-muted">{w}</div>
        ))}
      </Section>
      <Separator />
      <Section title="Recent tasks">
        {tasks.map((t) => (
          <div key={t.name} className="rounded-md px-3 py-1.5 hover:bg-muted">
            <div className="text-sm">{t.name}</div>
            <div className="text-xs text-muted-foreground">{t.time}</div>
          </div>
        ))}
      </Section>
    </aside>
  );
}
