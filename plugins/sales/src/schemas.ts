import { z } from "zod";

export const rowValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const rowSchema = z
  .object({ id: z.string().min(1) })
  .catchall(rowValueSchema);

const semanticToneSchema = z.enum([
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
]);
const fieldMetadataSchema = z
  .object({
    label: z.string().optional(),
    type: z
      .enum([
        "text",
        "multiline",
        "number",
        "currency",
        "date",
        "datetime",
        "select",
        "multi-select",
        "boolean",
        "url",
        "email",
        "person",
        "image",
        "badge",
      ])
      .optional(),
    icon: z.string().optional(),
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
    options: z.array(z.string()).optional(),
    toneMap: z.record(z.string(), semanticToneSchema).optional(),
  })
  .strict();

const kanbanPresentationSchema = z
  .object({
    density: z.enum(["compact", "comfortable"]).optional(),
    card: z
      .object({
        titleField: z.string().optional(),
        subtitleField: z.string().optional(),
        eyebrowField: z.string().optional(),
        avatar: z
          .object({
            imageField: z.string().optional(),
            fallbackField: z.string().optional(),
            shape: z.enum(["circle", "rounded"]).optional(),
          })
          .strict()
          .optional(),
        metadata: z
          .array(
            z
              .object({
                field: z.string(),
                icon: z.string().optional(),
                format: z
                  .enum(["text", "relative-date", "date", "currency"])
                  .optional(),
              })
              .strict(),
          )
          .max(3)
          .optional(),
        badges: z
          .array(
            z
              .object({
                field: z.string(),
                icon: z.string().optional(),
                tone: semanticToneSchema.optional(),
                toneMap: z.record(z.string(), semanticToneSchema).optional(),
              })
              .strict(),
          )
          .max(3)
          .optional(),
      })
      .strict()
      .optional(),
    lanes: z
      .object({
        iconMap: z.record(z.string(), z.string()).optional(),
        toneMap: z.record(z.string(), semanticToneSchema).optional(),
      })
      .strict()
      .optional(),
    create: z
      .object({ fields: z.array(z.string()).min(1).max(6) })
      .strict()
      .optional(),
    detail: z
      .object({
        sections: z
          .array(
            z
              .object({
                title: z.string(),
                fields: z.array(z.string()).min(1),
              })
              .strict(),
          )
          .max(5),
      })
      .strict()
      .optional(),
    filters: z.array(z.string()).max(6).optional(),
  })
  .strict();

export const collectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(z.string().min(1)),
  fieldMeta: z.record(z.string(), fieldMetadataSchema).optional(),
  rows: z.array(rowSchema),
});

const metricFilterSchema = z
  .object({
    field: z.string().min(1),
    operator: z
      .enum(["equals", "notEquals", "in", "notIn", "truthy"])
      .optional(),
    value: rowValueSchema.optional(),
    values: z.array(rowValueSchema).optional(),
  })
  .strict();

const metricComputationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    operation: z.enum(["count", "sum", "average"]),
    field: z.string().optional(),
    where: z.array(metricFilterSchema).max(8).optional(),
    format: z.enum(["number", "currency", "percent"]).optional(),
    hint: z.string().optional(),
  })
  .strict();

export const viewConfigSchema = z
  .object({
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
    presentation: kanbanPresentationSchema.optional(),
    metrics: z.array(metricComputationSchema).max(12).optional(),
    items: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          hint: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strict();

export const viewSchema = z.object({
  id: z.string().min(1),
  primitive: z.enum([
    "kanban",
    "table",
    "cards",
    "list",
    "timeline",
    "metrics",
  ]),
  title: z.string().min(1),
  visible: z.boolean().optional(),
  layout: z
    .object({ height: z.number().int().min(280).max(720).optional() })
    .strict()
    .optional(),
  collectionId: z.string().optional(),
  config: viewConfigSchema,
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  originThreadId: z.string().min(1),
  pinnedAt: z.string().nullable(),
  navOrder: z.number().int(),
  revision: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().max(180).optional(),
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

const wsRef = {
  workspaceId: z.string().min(1),
  collectionId: z.string().min(1),
};

export const mutationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("moveRow"),
      ...wsRef,
      rowId: z.string().min(1),
      field: z.string().min(1),
      value: rowValueSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("patchRow"),
      ...wsRef,
      rowId: z.string().min(1),
      patch: z.record(z.string(), rowValueSchema),
    })
    .strict(),
  z.object({ op: z.literal("addRow"), ...wsRef, row: rowSchema }).strict(),
  z
    .object({ op: z.literal("removeRow"), ...wsRef, rowId: z.string().min(1) })
    .strict(),
  z
    .object({
      op: z.literal("reorderViews"),
      workspaceId: z.string().min(1),
      viewIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      op: z.literal("setViewVisibility"),
      workspaceId: z.string().min(1),
      viewId: z.string().min(1),
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeView"),
      workspaceId: z.string().min(1),
      viewId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("setViewLayout"),
      workspaceId: z.string().min(1),
      viewId: z.string().min(1),
      height: z.number().min(280).max(720).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("renameWorkspace"),
      workspaceId: z.string().min(1),
      title: z.string().min(1),
    })
    .strict(),
]);

export const createWorkspaceInputSchema = z.object({
  title: z.string().min(1).max(60),
  description: z.string().max(180).optional(),
  icon: z.string().optional(),
  collections: z.array(collectionSchema).min(1),
  views: z
    .array(
      viewSchema
        .omit({ id: true })
        .extend({ id: z.string().min(1).optional() }),
    )
    .min(1),
});
