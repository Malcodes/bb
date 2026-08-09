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
    decision: z
      .object({
        promptField: z.string().min(1),
        contextFields: z.array(z.string().min(1)).max(6).optional(),
        statusField: z.string().min(1),
        commentField: z.string().min(1).optional(),
        options: z
          .array(
            z
              .object({
                label: z.string().min(1),
                value: z.string().min(1),
                tone: z
                  .enum(["default", "success", "danger", "warning"])
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(6),
      })
      .strict()
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
    "decision",
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

const sourceKindSchema = z.enum([
  "email",
  "calendar",
  "meeting-transcript",
  "contacts",
  "files",
  "web",
  "custom",
]);
const sourceBindingSchema = z.object({
  id: z.string(),
  kind: sourceKindSchema,
  label: z.string(),
  enabled: z.boolean(),
  resource: z.string().optional(),
  scopes: z.array(z.string()),
});
const capabilityBindingSchema = z.object({
  id: z.string(),
  role: z.enum(["source", "infrastructure", "action-channel"]),
  kind: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  resource: z.string().optional(),
  scopes: z.array(z.string()),
});
const permissionModelSchema = z.object({
  observe: z.object({ sourceIds: z.array(z.string()) }),
  internalState: z.enum(["automatic", "recommend-only"]),
  evolvePresentation: z.enum(["automatic", "recommend-only", "disabled"]),
  prepareExternalActions: z.enum(["automatic", "recommend-only", "disabled"]),
  executeConsequentialActions: z.enum(["require-approval", "disabled"]),
});
const autonomyPolicySchema = z.object({
  enabled: z.boolean(),
  goal: z.string(),
  constraints: z.array(z.string()),
  cadenceMinutes: z.number().int().min(5).max(1440),
  permissions: permissionModelSchema,
});
const autonomyGoalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  successCriteria: z.array(z.string()),
  status: z.enum(["active", "paused", "achieved", "blocked"]),
  progress: z.number().min(0).max(1),
  lastEvaluatedAt: z.string().optional(),
  assessment: z.string().optional(),
});
const entityFactSchema = z.object({
  key: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  observedAt: z.string(),
});
const entityMemorySchema = z.object({
  ref: z.string(),
  kind: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  facts: z.array(entityFactSchema),
  updatedAt: z.string(),
});
const opportunitySchema = z.object({
  id: z.string(),
  entityRefs: z.array(z.string()),
  title: z.string(),
  hypothesis: z.string(),
  evidence: z.array(z.string()),
  score: z.number().min(0).max(1),
  status: z.enum([
    "discovered",
    "researching",
    "qualified",
    "advanced",
    "dismissed",
    "completed",
  ]),
  nextAction: z.string().optional(),
  discoveredAt: z.string(),
  updatedAt: z.string(),
});
const externalActionSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  title: z.string(),
  actionType: z.string(),
  channelBindingId: z.string(),
  target: z.string(),
  payloadSummary: z.string(),
  rationale: z.string(),
  evidence: z.array(z.string()),
  status: z.enum([
    "proposed",
    "approved",
    "rejected",
    "executing",
    "succeeded",
    "failed",
  ]),
  createdAt: z.string(),
  approvedAt: z.string().optional(),
  executionStartedAt: z.string().optional(),
  completedAt: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  outcome: z.string().optional(),
});
const outcomeSchema = z.object({
  id: z.string(),
  goalId: z.string().optional(),
  actionId: z.string().optional(),
  observedAt: z.string(),
  result: z.enum(["positive", "negative", "neutral", "unknown"]),
  assessment: z.string(),
  evidence: z.array(z.string()),
  followUp: z.string().optional(),
});
const autonomySignalSchema = z.object({
  id: z.string(),
  targetWorkspaceIds: z.array(z.string()),
  entityRefs: z.array(z.string()),
  sourceBindingId: z.string(),
  sourceKind: sourceKindSchema,
  fingerprint: z.string(),
  observedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  reconciledAt: z.string().optional(),
});
const autonomyRunSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  workerThreadId: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
});
const autonomyRecommendationSchema = z.object({
  id: z.string(),
  kind: z.enum(["recommendation", "exception", "external-action"]),
  title: z.string(),
  rationale: z.string(),
  evidence: z.array(z.string()),
  proposedAction: z.string().optional(),
  externalActionId: z.string().optional(),
  status: z.enum(["open", "approved", "rejected", "resolved"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
const autonomyStateSchema = z.object({
  policy: autonomyPolicySchema,
  capabilities: z.array(capabilityBindingSchema),
  goals: z.array(autonomyGoalSchema),
  entities: z.array(entityMemorySchema),
  opportunities: z.array(opportunitySchema),
  externalActions: z.array(externalActionSchema),
  outcomes: z.array(outcomeSchema),
  sources: z.array(sourceBindingSchema),
  signals: z.array(autonomySignalSchema),
  runs: z.array(autonomyRunSchema),
  recommendations: z.array(autonomyRecommendationSchema),
});

export const nativeCompositionNodeSchema: z.ZodType<
  import("./model.js").NativeCompositionNode
> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: z.string().min(1),
        type: z.literal("view"),
        viewId: z.string().min(1),
        chrome: z.enum(["card", "subtle", "none"]).optional(),
        density: z.enum(["compact", "comfortable", "spacious"]).optional(),
        emphasis: z.enum(["primary", "normal", "quiet"]).optional(),
        span: z
          .object({
            base: z.number().int().min(1).max(12).optional(),
            md: z.number().int().min(1).max(12).optional(),
            lg: z.number().int().min(1).max(12).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        type: z.enum(["stack", "grid", "split", "section"]),
        title: z.string().max(120).optional(),
        description: z.string().max(300).optional(),
        gap: z.enum(["none", "compact", "normal", "spacious"]).optional(),
        columns: z.number().int().min(1).max(12).optional(),
        ratio: z.enum(["1:1", "1:2", "2:1", "1:3", "3:1"]).optional(),
        tone: z.enum(["plain", "subtle", "accent"]).optional(),
        children: z.array(nativeCompositionNodeSchema).min(1).max(24),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        type: z.literal("tabs"),
        tabs: z
          .array(
            z
              .object({
                id: z.string().min(1),
                label: z.string().min(1).max(80),
                child: nativeCompositionNodeSchema,
              })
              .strict(),
          )
          .min(1)
          .max(8),
      })
      .strict(),
  ]),
);

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
  composition: nativeCompositionNodeSchema.optional(),
  autonomy: autonomyStateSchema.optional(),
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

export const presentationMutationSchema = z.discriminatedUnion("op", [
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
      op: z.literal("setViewDefinition"),
      workspaceId: z.string().min(1),
      view: viewSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("setWorkspaceComposition"),
      workspaceId: z.string().min(1),
      composition: nativeCompositionNodeSchema.optional(),
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
]);

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
      op: z.literal("setViewDefinition"),
      workspaceId: z.string().min(1),
      view: viewSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("setWorkspaceComposition"),
      workspaceId: z.string().min(1),
      composition: nativeCompositionNodeSchema.optional(),
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
  composition: nativeCompositionNodeSchema.optional(),
});
