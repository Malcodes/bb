/**
 * Interactive view renderers. Each view is a projection of a collection; user
 * interactions emit Mutations (the same ones the agent's tools emit).
 */
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bb/shared-ui/card";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bb/shared-ui/table";
import type { Collection, Mutation, Row, RowValue, View } from "./model.js";
import {
  EntityAvatar,
  FieldControl,
  GeneratedAppToolbar,
  MetadataItem,
  SemanticBadge,
  fieldLabel,
  recordDraft,
  resolveTone,
  safeIcon,
  valueText,
} from "./generated-app.js";

export type Mutate = (mutations: Mutation[]) => void;

function str(v: RowValue | undefined): string {
  return v == null ? "" : String(v);
}

function fieldFor(
  collection: Collection | undefined,
  preferred: string | undefined,
  fallback: string[],
): string {
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

function displayMetadata(
  value: string,
  format?: "text" | "relative-date" | "date" | "currency",
): string {
  if (!value) return "";
  if (format === "currency") {
    const amount = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount)
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(amount)
      : value;
  }
  if (format === "date" || format === "relative-date") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      if (format === "date")
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(date);
      const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
      if (days === 0) return "Today";
      if (days === -1) return "Yesterday";
      if (days === 1) return "Tomorrow";
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        days,
        "day",
      );
    }
  }
  return value;
}

function KanbanCardContent({
  row,
  collection,
  view,
}: {
  row: Row;
  collection: Collection;
  view: View;
}) {
  const presentation = view.config.presentation;
  const card = presentation?.card;
  const titleField = fieldFor(
    collection,
    card?.titleField ?? view.config.titleField,
    ["company", "name", "title", "account"],
  );
  const subtitleField = card?.subtitleField ?? view.config.subField;
  const eyebrow = card?.eyebrowField ? valueText(row[card.eyebrowField]) : "";
  const avatar = card?.avatar;
  const fallback = valueText(row[avatar?.fallbackField ?? titleField]);
  const image = avatar?.imageField ? valueText(row[avatar.imageField]) : "";
  const metadata = card?.metadata ?? [];
  const badges =
    card?.badges ??
    (view.config.flagField ? [{ field: view.config.flagField }] : []);
  return (
    <>
      {eyebrow ? (
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {eyebrow}
        </div>
      ) : null}
      <div className="flex min-w-0 items-start gap-2.5">
        {avatar ? (
          <EntityAvatar
            image={image || undefined}
            fallback={fallback}
            shape={avatar.shape}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
            {valueText(row[titleField]) || "Untitled"}
          </div>
          {subtitleField && valueText(row[subtitleField]) ? (
            <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
              {valueText(row[subtitleField])}
            </div>
          ) : null}
        </div>
      </div>
      {metadata.length ? (
        <div className="mt-3 grid gap-1.5 border-t border-border/60 pt-2.5">
          {metadata.map((item) => {
            const value = displayMetadata(
              valueText(row[item.field]),
              item.format,
            );
            return value ? (
              <MetadataItem key={item.field} icon={item.icon}>
                {value}
              </MetadataItem>
            ) : null;
          })}
        </div>
      ) : null}
      {badges.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {badges.map((badge) => {
            const value = valueText(row[badge.field]);
            return (
              <SemanticBadge
                key={badge.field}
                value={value}
                icon={badge.icon}
                tone={resolveTone(
                  collection,
                  badge.field,
                  value,
                  badge.tone,
                  badge.toneMap,
                )}
              />
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function KanbanCard({
  row,
  collection,
  view,
  onOpen,
}: {
  row: Row;
  collection: Collection;
  view: View;
  onOpen(): void;
}) {
  const drag = useDraggable({ id: row.id });
  return (
    <Card
      ref={drag.setNodeRef}
      style={{
        transform: drag.transform
          ? `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`
          : undefined,
      }}
      onClick={onOpen}
      className={`group relative rounded-lg border-border/80 bg-card p-3 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow,opacity] duration-150 hover:border-border hover:shadow-[0_3px_10px_hsl(var(--foreground)/0.07)] focus-within:ring-2 focus-within:ring-ring/30 ${drag.isDragging ? "opacity-25" : ""}`}
    >
      <button
        type="button"
        aria-label="Drag card"
        {...drag.listeners}
        {...drag.attributes}
        onClick={(event) => event.stopPropagation()}
        className="absolute right-2 top-2 flex size-6 cursor-grab items-center justify-center rounded opacity-0 text-muted-foreground transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing"
      >
        <Icon name="DragDropVertical" className="size-3.5" />
      </button>
      <KanbanCardContent row={row} collection={collection} view={view} />
    </Card>
  );
}

function KanbanLane({
  lane,
  rows,
  collection,
  view,
  onOpen,
  onRequestAdd,
}: {
  lane: string;
  rows: Row[];
  collection: Collection;
  view: View;
  onOpen(row: Row): void;
  onRequestAdd(): void;
}) {
  const drop = useDroppable({ id: `lane:${lane}` });
  const lanePresentation = view.config.presentation?.lanes;
  const tone = lanePresentation?.toneMap?.[lane] ?? "neutral";
  const toneClass = {
    neutral: "bg-muted-foreground/50",
    info: "bg-blue-500",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
  }[tone];
  const icon = lanePresentation?.iconMap?.[lane]
    ? safeIcon(lanePresentation.iconMap[lane])
    : undefined;
  return (
    <section
      ref={drop.setNodeRef}
      className={`flex w-[292px] min-w-[292px] flex-col rounded-lg border border-transparent bg-muted/35 transition-[background-color,border-color] duration-150 ${drop.isOver ? "border-primary/25 bg-primary/[0.045]" : ""}`}
    >
      <header className="sticky top-0 z-10 flex h-11 items-center gap-2 rounded-t-lg bg-muted/90 px-3 supports-[backdrop-filter]:backdrop-blur-sm">
        <span className={`size-1.5 rounded-full ${toneClass}`} />
        {icon ? (
          <Icon name={icon} className="size-3.5 text-muted-foreground" />
        ) : null}
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/90">
          {lane || "Unassigned"}
        </h3>
        <span className="min-w-5 rounded bg-background/70 px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums text-muted-foreground">
          {rows.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRequestAdd}
          className="size-6 rounded-md text-muted-foreground"
          aria-label={`Add card to ${lane}`}
        >
          <Icon name="Plus" className="size-3.5" />
        </Button>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {rows.map((row) => (
          <KanbanCard
            key={row.id}
            row={row}
            collection={collection}
            view={view}
            onOpen={() => onOpen(row)}
          />
        ))}
        {rows.length === 0 ? (
          <button
            type="button"
            onClick={onRequestAdd}
            className="flex min-h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-background/50"
          >
            Add first card
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RecordFormDialog({
  open,
  title,
  description,
  collection,
  fields,
  sections,
  initial,
  submitLabel,
  onOpenChange,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  title: string;
  description: string;
  collection: Collection;
  fields: string[];
  sections?: { title: string; fields: string[] }[];
  initial: Record<string, string>;
  submitLabel: string;
  onOpenChange(open: boolean): void;
  onSubmit(values: Record<string, string>): void;
  onDelete?: () => void;
}) {
  const [values, setValues] = useState(initial);
  useEffect(() => setValues(initial), [initial, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[58vh] gap-5 overflow-y-auto py-1 pr-1">
          {(sections?.length ? sections : [{ title: "Details", fields }]).map(
            (section) => (
              <section key={section.title} className="grid gap-3">
                {sections?.length ? (
                  <div className="border-b pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {section.title}
                  </div>
                ) : null}
                {section.fields.map((field) => (
                  <FieldControl
                    key={field}
                    field={field}
                    meta={collection.fieldMeta?.[field]}
                    value={values[field] ?? ""}
                    onChange={(value) =>
                      setValues((current) => ({ ...current, [field]: value }))
                    }
                  />
                ))}
              </section>
            ),
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {onDelete ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onDelete}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Icon name="Trash2" className="mr-1.5 size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={() => onSubmit(values)}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KanbanView({
  view,
  collection,
  mutate,
  workspaceId,
}: {
  view: View;
  collection: Collection;
  mutate: Mutate;
  workspaceId: string;
}) {
  const { config } = view;
  const presentation = config.presentation;
  const groupBy = config.groupBy ?? "stage";
  const titleField = fieldFor(
    collection,
    presentation?.card?.titleField ?? config.titleField,
    ["company", "name", "title", "account"],
  );
  const lanes = useMemo(() => {
    const explicit = config.lanes ?? [];
    const seen = new Set(explicit);
    const rest = collection.rows
      .map((row) => valueText(row[groupBy]))
      .filter((value) => value && !seen.has(value));
    return [...explicit, ...Array.from(new Set(rest))];
  }, [config.lanes, collection.rows, groupBy]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createLane, setCreateLane] = useState<string | null>(null);
  const selected = collection.rows.find((row) => row.id === selectedId) ?? null;
  const active = collection.rows.find((row) => row.id === activeId) ?? null;
  const createFields = (presentation?.create?.fields ?? [titleField]).filter(
    (field) => field !== groupBy && collection.fields.includes(field),
  );
  const detailFields =
    presentation?.detail?.sections.flatMap((section) => section.fields) ??
    collection.fields.slice(0, 6);
  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return collection.rows.filter((row) => {
      if (
        normalized &&
        !Object.values(row).some((value) =>
          valueText(value).toLowerCase().includes(normalized),
        )
      )
        return false;
      return Object.entries(filters).every(
        ([field, value]) => !value || valueText(row[field]) === value,
      );
    });
  }, [collection.rows, filters, query]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }
  function handleDragEnd(event: DragEndEvent) {
    const rowId = String(event.active.id);
    const over = event.over ? String(event.over.id) : "";
    setActiveId(null);
    if (!over.startsWith("lane:")) return;
    const lane = over.slice(5);
    const row = collection.rows.find((item) => item.id === rowId);
    if (!row || valueText(row[groupBy]) === lane) return;
    mutate([
      {
        op: "moveRow",
        workspaceId,
        collectionId: collection.id,
        rowId,
        field: groupBy,
        value: lane,
      },
    ]);
  }

  const filterControls = (presentation?.filters ?? []).map((field) => {
    const options =
      collection.fieldMeta?.[field]?.options ??
      Array.from(
        new Set(
          collection.rows.map((row) => valueText(row[field])).filter(Boolean),
        ),
      );
    return (
      <select
        key={field}
        value={filters[field] ?? ""}
        onChange={(event) =>
          setFilters((current) => ({ ...current, [field]: event.target.value }))
        }
        className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
        aria-label={`Filter by ${fieldLabel(field, collection.fieldMeta?.[field])}`}
      >
        <option value="">
          All {fieldLabel(field, collection.fieldMeta?.[field]).toLowerCase()}
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  });

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_1px_2px_hsl(var(--foreground)/0.025)]">
      <GeneratedAppToolbar
        query={query}
        onQueryChange={setQuery}
        placeholder={`Search ${collection.name.toLowerCase()}…`}
        filters={<>{filterControls}</>}
        trailing={
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {visibleRows.length} records
          </span>
        }
      />
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex min-h-[420px] gap-3 overflow-x-auto bg-muted/10 p-3">
          {lanes.map((lane) => (
            <KanbanLane
              key={lane}
              lane={lane}
              rows={visibleRows.filter(
                (row) => valueText(row[groupBy]) === lane,
              )}
              collection={collection}
              view={view}
              onOpen={(row) => setSelectedId(row.id)}
              onRequestAdd={() => setCreateLane(lane)}
            />
          ))}
        </div>
        <DragOverlay
          dropAnimation={{
            duration: 160,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
          }}
        >
          {active ? (
            <Card className="w-[276px] rotate-[0.3deg] rounded-lg border-primary/20 bg-card p-3 shadow-xl">
              <KanbanCardContent
                row={active}
                collection={collection}
                view={view}
              />
            </Card>
          ) : null}
        </DragOverlay>
      </DndContext>
      <RecordFormDialog
        open={createLane !== null}
        title={`Add to ${createLane ?? "lane"}`}
        description={`Create a concise ${collection.name.toLowerCase()} record. You can add more detail later.`}
        collection={collection}
        fields={createFields}
        initial={recordDraft(collection, null, createFields)}
        submitLabel="Add card"
        onOpenChange={(open) => {
          if (!open) setCreateLane(null);
        }}
        onSubmit={(values) => {
          if (!createLane) return;
          mutate([
            {
              op: "addRow",
              workspaceId,
              collectionId: collection.id,
              row: {
                id: `r_${Date.now().toString(36)}`,
                ...values,
                [groupBy]: createLane,
              },
            },
          ]);
          setCreateLane(null);
        }}
      />
      <RecordFormDialog
        open={selected !== null}
        title={
          selected
            ? valueText(selected[titleField]) || "Card details"
            : "Card details"
        }
        description="Edit the fields that matter for this workflow. Changes synchronize everywhere."
        collection={collection}
        fields={detailFields}
        sections={presentation?.detail?.sections}
        initial={recordDraft(collection, selected, detailFields)}
        submitLabel="Save changes"
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onSubmit={(values) => {
          if (!selected) return;
          mutate([
            {
              op: "patchRow",
              workspaceId,
              collectionId: collection.id,
              rowId: selected.id,
              patch: values,
            },
          ]);
          setSelectedId(null);
        }}
        onDelete={
          selected
            ? () => {
                mutate([
                  {
                    op: "removeRow",
                    workspaceId,
                    collectionId: collection.id,
                    rowId: selected.id,
                  },
                ]);
                setSelectedId(null);
              }
            : undefined
        }
      />
    </div>
  );
}

function TableView({
  view,
  collection,
  mutate,
  workspaceId,
}: {
  view: View;
  collection: Collection;
  mutate: Mutate;
  workspaceId: string;
}) {
  const { config } = view;
  const columns = config.columns ?? collection.fields;
  const [sortBy, setSortBy] = useState(config.sortBy ?? columns[0]);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    config.sortDir ?? "asc",
  );
  const [filter, setFilter] = useState(config.filter ?? "");
  const [editing, setEditing] = useState<{
    rowId: string;
    field: string;
  } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const titleField = fieldFor(collection, config.titleField, [
    "company",
    "name",
    "title",
    "account",
  ]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? collection.rows.filter((r) =>
          Object.values(r).some((v) => str(v).toLowerCase().includes(f)),
        )
      : [...collection.rows];
    filtered.sort((a, b) => {
      const av = str(a[sortBy]);
      const bv = str(b[sortBy]);
      const an = Number(av.replace(/[^0-9.-]/g, ""));
      const bn = Number(bv.replace(/[^0-9.-]/g, ""));
      const cmp =
        !Number.isNaN(an) &&
        !Number.isNaN(bn) &&
        av.match(/[0-9]/) &&
        bv.match(/[0-9]/)
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
    mutate([
      {
        op: "patchRow",
        workspaceId,
        collectionId: collection.id,
        rowId: row.id,
        patch: { [field]: value },
      },
    ]);
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
                    if (sortBy === c)
                      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortBy(c);
                      setSortDir("asc");
                    }
                  }}
                >
                  {c}
                  {sortBy === c ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
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
                    className={
                      j === 0 ? "font-medium" : "text-muted-foreground"
                    }
                    onDoubleClick={() => {
                      setEditing({ rowId: r.id, field: c });
                      setEditDraft(str(r[c]));
                    }}
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
                    onClick={() =>
                      mutate([
                        {
                          op: "removeRow",
                          workspaceId,
                          collectionId: collection.id,
                          rowId: r.id,
                        },
                      ])
                    }
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
              mutate([
                {
                  op: "addRow",
                  workspaceId,
                  collectionId: collection.id,
                  row: {
                    id: `r_${Date.now().toString(36)}`,
                    [titleField]: title,
                  },
                },
              ])
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CardsView({
  view,
  collection,
  mutate,
  workspaceId,
}: {
  view: View;
  collection: Collection;
  mutate: Mutate;
  workspaceId: string;
}) {
  const { config } = view;
  const titleField = fieldFor(collection, config.titleField, [
    "company",
    "name",
    "title",
    "account",
  ]);
  const subField =
    config.subField ??
    collection.fields.find((f) => f !== titleField) ??
    titleField;
  const bodyField =
    collection.fields.find((f) => /notes|body|summary|brief/i.test(f)) ??
    collection.fields.find(
      (f) => f !== titleField && f !== subField && f !== config.flagField,
    );
  const flagField = config.flagField;
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{view.title}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {collection.rows.map((r) => (
          <Card key={r.id}>
            <CardHeader className="p-4 pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm font-medium leading-tight">
                  {str(r[titleField])}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {flagField && r[flagField] ? (
                    <Badge
                      variant="destructive"
                      className="shrink-0 text-[10px]"
                    >
                      {str(r[flagField])}
                    </Badge>
                  ) : null}
                  <button
                    aria-label="Remove"
                    className="text-muted-foreground/50 hover:text-destructive"
                    onClick={() =>
                      mutate([
                        {
                          op: "removeRow",
                          workspaceId,
                          collectionId: collection.id,
                          rowId: r.id,
                        },
                      ])
                    }
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {str(r[subField])}
              </div>
            </CardHeader>
            {bodyField ? (
              <CardContent className="p-4 pt-0">
                {str(r[bodyField])
                  .split("\n")
                  .map((line, j) => (
                    <p key={j} className="text-sm text-muted-foreground">
                      {line}
                    </p>
                  ))}
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>
      <AddRowForm
        onAdd={(title) =>
          mutate([
            {
              op: "addRow",
              workspaceId,
              collectionId: collection.id,
              row: { id: `r_${Date.now().toString(36)}`, [titleField]: title },
            },
          ])
        }
      />
    </div>
  );
}

function ListView({
  view,
  collection,
  mutate,
  workspaceId,
}: {
  view: View;
  collection: Collection;
  mutate: Mutate;
  workspaceId: string;
}) {
  const titleField = fieldFor(collection, view.config.titleField, [
    "company",
    "name",
    "title",
    "account",
  ]);
  const subField =
    view.config.subField ??
    collection.fields.find((f) => f !== titleField) ??
    titleField;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{view.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {collection.rows.map((r) => (
          <div
            key={r.id}
            className="flex items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
          >
            <div>
              <div className="text-sm font-medium">{str(r[titleField])}</div>
              <div className="text-xs text-muted-foreground">
                {str(r[subField])}
              </div>
            </div>
            <button
              aria-label="Remove"
              className="text-muted-foreground/50 hover:text-destructive"
              onClick={() =>
                mutate([
                  {
                    op: "removeRow",
                    workspaceId,
                    collectionId: collection.id,
                    rowId: r.id,
                  },
                ])
              }
            >
              ×
            </button>
          </div>
        ))}
        <AddRowForm
          onAdd={(title) =>
            mutate([
              {
                op: "addRow",
                workspaceId,
                collectionId: collection.id,
                row: {
                  id: `r_${Date.now().toString(36)}`,
                  [titleField]: title,
                },
              },
            ])
          }
        />
      </CardContent>
    </Card>
  );
}

function TimelineView({
  view,
  collection,
}: {
  view: View;
  collection: Collection;
}) {
  const timeField =
    view.config.timeField ??
    collection.fields.find((f) => /time|date|when/i.test(f)) ??
    collection.fields[0];
  const titleField = fieldFor(collection, view.config.titleField, [
    "title",
    "company",
    "name",
  ]);
  const subField =
    view.config.subField ??
    collection.fields.find((f) => f !== titleField && f !== timeField) ??
    titleField;
  const rows = [...collection.rows].sort((a, b) =>
    str(a[timeField]).localeCompare(str(b[timeField])),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{view.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="flex gap-3">
            <div className="w-16 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground">
              {str(r[timeField])}
            </div>
            <div className="border-l-2 border-primary/30 pl-3">
              <div className="text-sm font-medium">{str(r[titleField])}</div>
              <div className="text-xs text-muted-foreground">
                {str(r[subField])}
              </div>
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
            <div className="text-2xl font-semibold tracking-tight">
              {m.value}
            </div>
            {m.hint && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {m.hint}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ViewRenderer({
  view,
  workspace,
  mutate,
}: {
  view: View;
  workspace: { id: string; collections: Collection[] };
  mutate: Mutate;
}) {
  if (view.primitive === "metrics") return <MetricsView view={view} />;
  const collection =
    workspace.collections.find((c) => c.id === view.collectionId) ??
    workspace.collections[0];
  if (!collection) return null;
  switch (view.primitive) {
    case "kanban":
      return (
        <KanbanView
          view={view}
          collection={collection}
          mutate={mutate}
          workspaceId={workspace.id}
        />
      );
    case "table":
      return (
        <TableView
          view={view}
          collection={collection}
          mutate={mutate}
          workspaceId={workspace.id}
        />
      );
    case "cards":
      return (
        <CardsView
          view={view}
          collection={collection}
          mutate={mutate}
          workspaceId={workspace.id}
        />
      );
    case "list":
      return (
        <ListView
          view={view}
          collection={collection}
          mutate={mutate}
          workspaceId={workspace.id}
        />
      );
    case "timeline":
      return <TimelineView view={view} collection={collection} />;
  }
}
