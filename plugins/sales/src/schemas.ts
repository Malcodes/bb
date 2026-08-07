import { z } from "zod";

export const rowValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const rowSchema = z.object({ id: z.string().min(1) }).catchall(rowValueSchema);

export const collectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(z.string().min(1)),
  rows: z.array(rowSchema),
});

export const viewConfigSchema = z.object({
  groupBy: z.string().optional(),
  lanes: z.array(z.string()).optional(),
  columns: z.array(z.string()).optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  filter: z.string().optional(),
  titleField: z.string().optional(),
  subField: z.string().optional(),
  flagField: z.string().optional(),
  timeField: z.string().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        hint: z.string().optional(),
      }),
    )
    .optional(),
}).strict();

export const viewSchema = z.object({
  id: z.string().min(1),
  primitive: z.enum(["kanban", "table", "cards", "list", "timeline", "metrics"]),
  title: z.string().min(1),
  collectionId: z.string().optional(),
  config: viewConfigSchema,
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  collections: z.array(collectionSchema),
  views: z.array(viewSchema),
});

export const workspaceSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  updatedAt: z.string(),
  viewCount: z.number(),
  rowCount: z.number(),
});

const wsRef = { workspaceId: z.string().min(1), collectionId: z.string().min(1) };

export const mutationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("moveRow"), ...wsRef, rowId: z.string().min(1), field: z.string().min(1), value: rowValueSchema }).strict(),
  z.object({ op: z.literal("patchRow"), ...wsRef, rowId: z.string().min(1), patch: z.record(z.string(), rowValueSchema) }).strict(),
  z.object({ op: z.literal("addRow"), ...wsRef, row: rowSchema }).strict(),
  z.object({ op: z.literal("removeRow"), ...wsRef, rowId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("reorderViews"), workspaceId: z.string().min(1), viewIds: z.array(z.string()) }).strict(),
  z.object({ op: z.literal("renameWorkspace"), workspaceId: z.string().min(1), title: z.string().min(1) }).strict(),
]);

export const createWorkspaceInputSchema = z.object({
  title: z.string().min(1).max(60),
  icon: z.string().optional(),
  collections: z.array(collectionSchema).min(1),
  views: z.array(viewSchema.omit({ id: true }).extend({ id: z.string().min(1).optional() })).min(1),
});
