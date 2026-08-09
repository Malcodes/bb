/**
 * Core data model: workspaces are persistent objects holding collections of
 * plain rows; views are interactive projections over a collection. Both the
 * UI and the agent mutate state exclusively through Mutations.
 */

import type { GeneratedToolAutonomyState } from "@bb/plugin-sdk";

export type RowValue = string | number | boolean | null;
export type Row = { id: string; [key: string]: RowValue };

export type FieldType =
  | "text"
  | "multiline"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "select"
  | "multi-select"
  | "boolean"
  | "url"
  | "email"
  | "person"
  | "image"
  | "badge";

export type FieldMetadata = {
  label?: string;
  type?: FieldType;
  icon?: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  /** Semantic tone per stored value. */
  toneMap?: Record<
    string,
    "neutral" | "info" | "success" | "warning" | "danger"
  >;
};

export type Collection = {
  id: string;
  name: string;
  /** Field names in display order; every row should carry these keys. */
  fields: string[];
  /** Reusable native formatting/editing metadata, keyed by field name. */
  fieldMeta?: Record<string, FieldMetadata>;
  rows: Row[];
};

export type CardMetadataItem = {
  field: string;
  icon?: string;
  format?: "text" | "relative-date" | "date" | "currency";
};

export type CardBadgeItem = {
  field: string;
  icon?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  toneMap?: Record<
    string,
    "neutral" | "info" | "success" | "warning" | "danger"
  >;
};

export type KanbanPresentation = {
  density?: "compact" | "comfortable";
  card?: {
    titleField?: string;
    subtitleField?: string;
    eyebrowField?: string;
    avatar?: {
      imageField?: string;
      fallbackField?: string;
      shape?: "circle" | "rounded";
    };
    metadata?: CardMetadataItem[];
    badges?: CardBadgeItem[];
  };
  lanes?: {
    iconMap?: Record<string, string>;
    toneMap?: Record<
      string,
      "neutral" | "info" | "success" | "warning" | "danger"
    >;
  };
  create?: { fields: string[] };
  detail?: { sections: { title: string; fields: string[] }[] };
  filters?: string[];
};

export type MetricFilter = {
  field: string;
  operator?: "equals" | "notEquals" | "in" | "notIn" | "truthy";
  value?: RowValue;
  values?: RowValue[];
};

export type MetricComputation = {
  id: string;
  label: string;
  operation: "count" | "sum" | "average";
  field?: string;
  where?: MetricFilter[];
  format?: "number" | "currency" | "percent";
  hint?: string;
};

export type ViewConfig = {
  /** kanban: field whose distinct values define lanes. */
  groupBy?: string;
  /** kanban: explicit lane order. */
  lanes?: string[];
  /** table: columns to show. */
  columns?: string[];
  /** table: field to sort by. */
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** table: case-insensitive substring filter across all fields. */
  filter?: string;
  /** field treated as the row's title in cards/kanban/list/timeline. */
  titleField?: string;
  /** field treated as the row's subtitle. */
  subField?: string;
  /** field treated as a risk/highlight flag (kanban/card badge). */
  flagField?: string;
  /** timeline: field used for the time/ordering column. */
  timeField?: string;
  /** Legacy static metrics; prefer live computations below. */
  items?: { label: string; value: string; hint?: string }[];
  /** Declarative metrics recomputed from collection rows on every render. */
  metrics?: MetricComputation[];
  /** Reusable native presentation vocabulary; currently richest for Kanban. */
  presentation?: KanbanPresentation;
};

export type ViewLayout = {
  /** Persisted module height in CSS pixels. Omit for content-sized. */
  height?: number;
};

export type View = {
  id: string;
  primitive: "kanban" | "table" | "cards" | "list" | "timeline" | "metrics";
  title: string;
  /** Presentation visibility only; hidden views keep collections and history. */
  visible?: boolean;
  /** Human-controlled module layout; independent from underlying data. */
  layout?: ViewLayout;
  /** Collection this view projects; metrics views may omit it. */
  collectionId?: string;
  config: ViewConfig;
};

export type Workspace = {
  id: string;
  /** Creation/configuration provenance; not an access or containment boundary. */
  originThreadId: string;
  pinnedAt: string | null;
  navOrder: number;
  /** Monotonic optimistic-concurrency revision. */
  revision: number;
  title: string;
  description?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  collections: Collection[];
  views: View[];
  /** Generic generated-tool operator policy and run/decision state. */
  autonomy?: GeneratedToolAutonomyState;
};

export type Mutation =
  | {
      op: "moveRow";
      workspaceId: string;
      collectionId: string;
      rowId: string;
      field: string;
      value: RowValue;
    }
  | {
      op: "patchRow";
      workspaceId: string;
      collectionId: string;
      rowId: string;
      patch: Record<string, RowValue>;
    }
  | { op: "addRow"; workspaceId: string; collectionId: string; row: Row }
  | {
      op: "removeRow";
      workspaceId: string;
      collectionId: string;
      rowId: string;
    }
  | { op: "reorderViews"; workspaceId: string; viewIds: string[] }
  | {
      op: "setViewVisibility";
      workspaceId: string;
      viewId: string;
      visible: boolean;
    }
  | { op: "removeView"; workspaceId: string; viewId: string }
  | {
      op: "setViewLayout";
      workspaceId: string;
      viewId: string;
      height?: number;
    }
  | { op: "renameWorkspace"; workspaceId: string; title: string };

/**
 * Upgrade the known snapshot metric vocabulary emitted by the earlier agent
 * contract. New workspaces must author explicit computations; this keeps
 * existing accepted tools live without deleting or recreating them.
 */
export function upgradeLegacyMetrics(workspace: Workspace): boolean {
  let changed = false;
  for (const view of workspace.views) {
    if (
      view.primitive !== "metrics" ||
      view.config.metrics?.length ||
      !view.config.items?.length
    ) {
      continue;
    }
    const collection =
      workspace.collections.find(
        (candidate) => candidate.id === view.collectionId,
      ) ?? workspace.collections[0];
    if (!collection) continue;
    const field = (names: string[]) =>
      collection.fields.find((candidate) =>
        names.includes(candidate.toLowerCase().replace(/[ _-]/g, "")),
      );
    const stageField = field([
      "stage",
      "status",
      "pipeline stage".replace(/ /g, ""),
    ]);
    const priorityField = field(["priority", "tier"]);
    const stageValues = stageField
      ? Array.from(
          new Set(
            collection.rows
              .map((row) => row[stageField])
              .filter((value): value is string => typeof value === "string"),
          ),
        )
      : [];
    const actual = (wanted: string) =>
      stageValues.find(
        (value) => value.toLowerCase() === wanted.toLowerCase(),
      ) ?? wanted;
    const computations: MetricComputation[] = [];
    for (const item of view.config.items) {
      const label = item.label.trim().toLowerCase();
      if (label.includes("offer") && stageField) {
        computations.push({
          id: "offer",
          label: item.label,
          operation: "count",
          where: [
            {
              field: stageField,
              operator: "equals",
              value: actual("Offer"),
            },
          ],
          hint: item.hint,
        });
      } else if (label.includes("late stage") && stageField) {
        computations.push({
          id: "late-stage",
          label: item.label,
          operation: "count",
          where: [
            {
              field: stageField,
              operator: "in",
              values: [actual("Interviewing"), actual("Offer")],
            },
          ],
          hint: item.hint,
        });
      } else if (label.includes("high priority") && priorityField) {
        computations.push({
          id: "high-priority",
          label: item.label,
          operation: "count",
          where: [
            {
              field: priorityField,
              operator: "equals",
              value:
                collection.rows
                  .map((row) => row[priorityField])
                  .find(
                    (value) =>
                      typeof value === "string" &&
                      value.toLowerCase() === "high",
                  ) ?? "High",
            },
          ],
          hint: item.hint,
        });
      } else if (label.includes("active pipeline") && stageField) {
        computations.push({
          id: "active-pipeline",
          label: item.label,
          operation: "count",
          where: [
            {
              field: stageField,
              operator: "notIn",
              values: [
                actual("Closed won"),
                actual("Closed lost"),
                actual("Rejected"),
                actual("Withdrawn"),
              ],
            },
          ],
          hint: item.hint,
        });
      }
    }
    if (computations.length === view.config.items.length) {
      view.config.metrics = computations;
      delete view.config.items;
      if (!view.collectionId) view.collectionId = collection.id;
      changed = true;
    }
  }
  return changed;
}

/** Apply one mutation to a workspace in place. Returns false if no-op. */
export function applyMutation(ws: Workspace, m: Mutation): boolean {
  if (m.op === "renameWorkspace") {
    if (m.workspaceId !== ws.id) return false;
    ws.title = m.title;
    return true;
  }
  if (m.op === "reorderViews") {
    if (m.workspaceId !== ws.id) return false;
    const order = new Map(m.viewIds.map((id, i) => [id, i]));
    ws.views.sort(
      (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999),
    );
    return true;
  }
  if (m.op === "setViewVisibility") {
    if (m.workspaceId !== ws.id) return false;
    const view = ws.views.find((candidate) => candidate.id === m.viewId);
    if (!view) return false;
    if ((view.visible !== false) === m.visible) return false;
    view.visible = m.visible;
    return true;
  }
  if (m.op === "removeView") {
    if (m.workspaceId !== ws.id) return false;
    const index = ws.views.findIndex((candidate) => candidate.id === m.viewId);
    if (index === -1) return false;
    ws.views.splice(index, 1);
    return true;
  }
  if (m.op === "setViewLayout") {
    if (m.workspaceId !== ws.id) return false;
    const view = ws.views.find((candidate) => candidate.id === m.viewId);
    if (!view) return false;
    const height =
      m.height === undefined
        ? undefined
        : Math.max(280, Math.min(720, Math.round(m.height)));
    if (view.layout?.height === height) return false;
    view.layout = height === undefined ? undefined : { ...view.layout, height };
    return true;
  }
  if (m.workspaceId !== ws.id) return false;
  const col = ws.collections.find((c) => c.id === m.collectionId);
  if (!col) return false;
  switch (m.op) {
    case "moveRow":
    case "patchRow": {
      const row = col.rows.find((r) => r.id === m.rowId);
      if (!row) return false;
      if (m.op === "moveRow") {
        row[m.field] = m.value;
      } else {
        for (const [k, v] of Object.entries(m.patch)) row[k] = v;
        for (const k of Object.keys(m.patch)) {
          if (!col.fields.includes(k)) col.fields.push(k);
        }
      }
      return true;
    }
    case "addRow": {
      if (col.rows.some((r) => r.id === m.row.id)) return false;
      col.rows.push(m.row);
      for (const k of Object.keys(m.row)) {
        if (k !== "id" && !col.fields.includes(k)) col.fields.push(k);
      }
      return true;
    }
    case "removeRow": {
      const i = col.rows.findIndex((r) => r.id === m.rowId);
      if (i === -1) return false;
      col.rows.splice(i, 1);
      return true;
    }
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 10000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
