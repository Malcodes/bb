import { Badge } from "@bb/shared-ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@bb/shared-ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bb/shared-ui/table";
import type { Block } from "../lib/spec";

function Metrics({ items }: Extract<Block, { kind: "metrics" }>) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((m) => (
        <Card key={m.label}>
          <CardHeader className="p-4 pb-1">
            <div className="text-xs text-muted-foreground">{m.label}</div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-semibold tracking-tight">{m.value}</div>
            {m.hint && <div className="mt-0.5 text-xs text-muted-foreground">{m.hint}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TableBlock({ title, columns, rows }: Extract<Block, { kind: "table" }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((cell, j) => (
                  <TableCell key={j} className={j === 0 ? "font-medium" : "text-muted-foreground"}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Kanban({ title, lanes }: Extract<Block, { kind: "kanban" }>) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {lanes.map((lane) => (
          <div key={lane.name} className="rounded-lg bg-muted/50 p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-muted-foreground">{lane.name}</span>
              <Badge variant="secondary" className="text-[10px]">{lane.cards.length}</Badge>
            </div>
            <div className="flex flex-col gap-2">
              {lane.cards.map((c, i) => (
                <Card key={i} className="p-3">
                  <div className="text-sm font-medium leading-tight">{c.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{c.sub}</div>
                  {c.flag && (
                    <Badge variant="destructive" className="mt-2 text-[10px]">{c.flag}</Badge>
                  )}
                </Card>
              ))}
              {lane.cards.length === 0 && (
                <div className="px-1 py-3 text-center text-xs text-muted-foreground/60">—</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ title, items }: Extract<Block, { kind: "timeline" }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {items.map((it, i) => (
          <div key={i} className="flex gap-3">
            <div className="w-16 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">{it.time}</div>
            <div className="border-l-2 border-primary/30 pl-3">
              <div className="text-sm font-medium">{it.title}</div>
              <div className="text-xs text-muted-foreground">{it.sub}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Cards({ title, cards }: Extract<Block, { kind: "cards" }>) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {cards.map((c, i) => (
          <Card key={i}>
            <CardHeader className="p-4 pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm font-medium leading-tight">{c.title}</CardTitle>
                {c.flag && <Badge variant="destructive" className="shrink-0 text-[10px]">{c.flag}</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">{c.sub}</div>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {c.body.split("\n").map((line, j) => (
                <p key={j} className="text-sm text-muted-foreground">{line}</p>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ListBlock({ title, items }: Extract<Block, { kind: "list" }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {items.map((it, i) => (
          <div key={i} className="py-2.5 first:pt-0 last:pb-0">
            <div className="text-sm font-medium">{it.title}</div>
            <div className="text-xs text-muted-foreground">{it.sub}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function BlockRenderer({ block }: { block: Block }) {
  switch (block.kind) {
    case "metrics": return <Metrics {...block} />;
    case "table": return <TableBlock {...block} />;
    case "kanban": return <Kanban {...block} />;
    case "timeline": return <Timeline {...block} />;
    case "cards": return <Cards {...block} />;
    case "list": return <ListBlock {...block} />;
  }
}
