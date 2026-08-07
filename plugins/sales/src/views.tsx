/**
 * Interactive view renderers. Each view is a projection of a collection; user
 * interactions emit Mutations (the same ones the agent's tools emit).
 */
import { useMemo, useState, type DragEvent } from "react";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bb/shared-ui/card";
import { Input } from "@bb/shared-ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bb/shared-ui/table";
import type { Collection, Mutation, Row, RowValue, View } from "./model.js";

export type Mutate = (mutations: Mutation[]) => void;

function str(v: RowValue | undefined): string {
  return v == null ? "" : String(v);
}

function fieldFor(collection: Collection | undefined, preferred: string | undefined, fallback: string[]): string {
  if (preferred) return preferred;
  if (collection) {
    for (const f of fallback) {
      const hit = collection.fields.find((x) => x.toLowerCase() === f);
      if (hit) return hit;
    }
    return collection.fields[0] ?? "id";
  }
  return fallback[0] ?? "id";
}

function AddRowForm({ onAdd }: { onAdd: (title: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = draft.trim();
        if (!t) return;
        setDraft("");
        onAdd(t);
      }}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="+ Add"
        className="h-8 text-xs"
      />
    </form>
  );
}

function KanbanView({ view, collection, mutate, workspaceId }: {
  view: View; collection: Collection; mutate: Mutate; workspaceId: string;
}) {
  const { config } = view;
  const groupBy = config.groupBy ?? "stage";
  const titleField = fieldFor(collection, config.titleField, ["company", "name", "title", "account"]);
  const subField = config.subField ?? collection.fields.find((f) => f !== titleField && f !== groupBy) ?? titleField;
  const flagField = config.flagField;
  const lanes = useMemo(() => {
    const explicit = config.lanes ?? [];
    const seen = new Set(explicit);
    const rest = collection.rows.map((r) => str(r[groupBy])).filter((v) => v && !seen.has(v));
    return [...explicit, ...Array.from(new Set(rest))];
  }, [config.lanes, collection.rows, groupBy]);
  const [dragOver, setDragOver] = useState<string | null>(null);

  function onDrop(e: DragEvent, lane: string) {
    e.preventDefault();
    setDragOver(null);
    const rowId = e.dataTransfer.getData("text/plain");
    if (!rowId) return;
    const row = collection.rows.find((r) => r.id === rowId);
    if (!row || str(row[groupBy]) === lane) return;
    mutate([{ op: "moveRow", workspaceId, collectionId: collection.id, rowId, field: groupBy, value: lane }]);
  }

  return (
    <div>
      <div className="mb-2 text-sm font-medium">{view.title}</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {lanes.map((lane) => {
          const cards = collection.rows.filter((r) => str(r[groupBy]) === lane);
          return (
            <div
              key={lane}
              onDragOver={(e) => { e.preventDefault(); setDragOver(lane); }}
              onDragLeave={() => setDragOver((d) => (d === lane ? null : d))}
              onDrop={(e) => onDrop(e, lane)}
              className={`rounded-lg p-2 transition-colors ${dragOver === lane ? "bg-accent" : "bg-muted/50"}`}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-muted-foreground">{lane || "(none)"}</span>
                <Badge variant="secondary" className="text-[10px]">{cards.length}</Badge>
              </div>
              <div className="flex flex-col gap-2">
                {cards.map((r) => (
                  <Card
                    key={r.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
                    className="cursor-grab p-3 active:cursor-grabbing"
                  >
                    <div className="text-sm font-medium leading-tight">{str(r[titleField])}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{str(r[subField])}</div>
                    {flagField && r[flagField] ? (
                      <Badge variant="destructive" className="mt-2 text-[10px]">{str(r[flagField])}</Badge>
                    ) : null}
                  </Card>
                ))}
                {cards.length === 0 && (
                  <div className="px-1 py-3 text-center text-xs text-muted-foreground/60">—</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableView({ view, collection, mutate, workspaceId }: {
  view: View; collection: Collection; mutate: Mutate; workspaceId: string;
}) {
  const { config } = view;
  const columns = config.columns ?? collection.fields;
  const [sortBy, setSortBy] = useState(config.sortBy ?? columns[0]);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(config.sortDir ?? "asc");
  const [filter, setFilter] = useState(config.filter ?? "");
  const [editing, setEditing] = useState<{ rowId: string; field: string } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const titleField = fieldFor(collection, config.titleField, ["company", "name", "title", "account"]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? collection.rows.filter((r) => Object.values(r).some((v) => str(v).toLowerCase().includes(f)))
      : [...collection.rows];
    filtered.sort((a, b) => {
      const av = str(a[sortBy]); const bv = str(b[sortBy]);
      const an = Number(av.replace(/[^0-9.-]/g, "")); const bn = Number(bv.replace(/[^0-9.-]/g, ""));
      const cmp = !Number.isNaN(an) && !Number.isNaN(bn) && av.match(/[0-9]/) && bv.match(/[0-9]/)
        ? an - bn
        : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return filtered;
  }, [collection.rows, filter, sortBy, sortDir]);

  function commitEdit(row: Row, field: string) {
    setEditing(null);
    const value = editDraft;
    if (value === str(row[field])) return;
    mutate([{ op: "patchRow", workspaceId, collectionId: collection.id, rowId: row.id, patch: { [field]: value } }]);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-sm font-medium">{view.title}</CardTitle>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="h-8 w-48 text-xs"
        />
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c}
                  className="cursor-pointer select-none"
                  onClick={() => {
                    if (sortBy === c) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else { setSortBy(c); setSortDir("asc"); }
                  }}
                >
                  {c}{sortBy === c ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </TableHead>
              ))}
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                {columns.map((c, j) => (
                  <TableCell
                    key={c}
                    className={j === 0 ? "font-medium" : "text-muted-foreground"}
                    onDoubleClick={() => { setEditing({ rowId: r.id, field: c }); setEditDraft(str(r[c])); }}
                  >
                    {editing?.rowId === r.id && editing.field === c ? (
                      <Input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onBlur={() => commitEdit(r, c)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(r, c);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="h-7 text-xs"
                      />
                    ) : (
                      str(r[c])
                    )}
                  </TableCell>
                ))}
                <TableCell>
                  <button
                    aria-label="Remove row"
                    className="text-muted-foreground/50 hover:text-destructive"
                    onClick={() => mutate([{ op: "removeRow", workspaceId, collectionId: collection.id, rowId: r.id }])}
                  >
                    ×
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="px-4">
          <AddRowForm
            onAdd={(title) =>
              mutate([{
                op: "addRow", workspaceId, collectionId: collection.id,
                row: { id: `r_${Date.now().toString(36)}`, [titleField]: title },
              }])
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CardsView({ view, collection, mutate, workspaceId }: {
  view: View; collection: Collection; mutate: Mutate; workspaceId: string;
}) {
  const { config } = view;
  const titleField = fieldFor(collection, config.titleField, ["company", "name", "title", "account"]);
  const subField = config.subField ?? collection.fields.find((f) => f !== titleField) ?? titleField;
  const bodyField = collection.fields.find((f) => /notes|body|summary|brief/i.test(f))
    ?? collection.fields.find((f) => f !== titleField && f !== subField && f !== config.flagField);
  const flagField = config.flagField;
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{view.title}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {collection.rows.map((r) => (
          <Card key={r.id}>
            <CardHeader className="p-4 pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm font-medium leading-tight">{str(r[titleField])}</CardTitle>
                <div className="flex items-center gap-2">
                  {flagField && r[flagField] ? (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">{str(r[flagField])}</Badge>
                  ) : null}
                  <button
                    aria-label="Remove"
                    className="text-muted-foreground/50 hover:text-destructive"
                    onClick={() => mutate([{ op: "removeRow", workspaceId, collectionId: collection.id, rowId: r.id }])}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">{str(r[subField])}</div>
            </CardHeader>
            {bodyField ? (
              <CardContent className="p-4 pt-0">
                {str(r[bodyField]).split("\n").map((line, j) => (
                  <p key={j} className="text-sm text-muted-foreground">{line}</p>
                ))}
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>
      <AddRowForm
        onAdd={(title) =>
          mutate([{
            op: "addRow", workspaceId, collectionId: collection.id,
            row: { id: `r_${Date.now().toString(36)}`, [titleField]: title },
          }])
        }
      />
    </div>
  );
}

function ListView({ view, collection, mutate, workspaceId }: {
  view: View; collection: Collection; mutate: Mutate; workspaceId: string;
}) {
  const titleField = fieldFor(collection, view.config.titleField, ["company", "name", "title", "account"]);
  const subField = view.config.subField ?? collection.fields.find((f) => f !== titleField) ?? titleField;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{view.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {collection.rows.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
            <div>
              <div className="text-sm font-medium">{str(r[titleField])}</div>
              <div className="text-xs text-muted-foreground">{str(r[subField])}</div>
            </div>
            <button
              aria-label="Remove"
              className="text-muted-foreground/50 hover:text-destructive"
              onClick={() => mutate([{ op: "removeRow", workspaceId, collectionId: collection.id, rowId: r.id }])}
            >
              ×
            </button>
          </div>
        ))}
        <AddRowForm
          onAdd={(title) =>
            mutate([{
              op: "addRow", workspaceId, collectionId: collection.id,
              row: { id: `r_${Date.now().toString(36)}`, [titleField]: title },
            }])
          }
        />
      </CardContent>
    </Card>
  );
}

function TimelineView({ view, collection }: { view: View; collection: Collection }) {
  const timeField = view.config.timeField ?? collection.fields.find((f) => /time|date|when/i.test(f)) ?? collection.fields[0];
  const titleField = fieldFor(collection, view.config.titleField, ["title", "company", "name"]);
  const subField = view.config.subField ?? collection.fields.find((f) => f !== titleField && f !== timeField) ?? titleField;
  const rows = [...collection.rows].sort((a, b) => str(a[timeField]).localeCompare(str(b[timeField])));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{view.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="flex gap-3">
            <div className="w-16 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">{str(r[timeField])}</div>
            <div className="border-l-2 border-primary/30 pl-3">
              <div className="text-sm font-medium">{str(r[titleField])}</div>
              <div className="text-xs text-muted-foreground">{str(r[subField])}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MetricsView({ view }: { view: View }) {
  const items = view.config.items ?? [];
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

export function ViewRenderer({ view, workspace, mutate }: {
  view: View; workspace: { id: string; collections: Collection[] }; mutate: Mutate;
}) {
  if (view.primitive === "metrics") return <MetricsView view={view} />;
  const collection = workspace.collections.find((c) => c.id === view.collectionId)
    ?? workspace.collections[0];
  if (!collection) return null;
  switch (view.primitive) {
    case "kanban":
      return <KanbanView view={view} collection={collection} mutate={mutate} workspaceId={workspace.id} />;
    case "table":
      return <TableView view={view} collection={collection} mutate={mutate} workspaceId={workspace.id} />;
    case "cards":
      return <CardsView view={view} collection={collection} mutate={mutate} workspaceId={workspace.id} />;
    case "list":
      return <ListView view={view} collection={collection} mutate={mutate} workspaceId={workspace.id} />;
    case "timeline":
      return <TimelineView view={view} collection={collection} />;
  }
}
