/**
 * Core data model: workspaces are persistent objects holding collections of
 * plain rows; views are interactive projections over a collection. Both the
 * UI and the agent mutate state exclusively through Mutations.
 */

export type RowValue = string | number | boolean | null;
export type Row = { id: string; [key: string]: RowValue };

export type Collection = {
  id: string;
  name: string;
  /** Field names in display order; every row should carry these keys. */
  fields: string[];
  rows: Row[];
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
  /** metrics: headline numbers computed by the agent. */
  items?: { label: string; value: string; hint?: string }[];
};

export type View = {
  id: string;
  primitive: "kanban" | "table" | "cards" | "list" | "timeline" | "metrics";
  title: string;
  /** Collection this view projects; metrics views may omit it. */
  collectionId?: string;
  config: ViewConfig;
};

export type Workspace = {
  id: string;
  /** Normal bb thread that owns and renders this interactive artifact. */
  threadId: string;
  title: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  collections: Collection[];
  views: View[];
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
  | { op: "renameWorkspace"; workspaceId: string; title: string };

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
