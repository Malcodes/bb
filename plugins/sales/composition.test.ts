import { describe, expect, it } from "vitest";
import { createWorkspaceInputSchema } from "./src/schemas.js";

const collection = {
  id: "records",
  name: "Records",
  fields: ["title", "status"],
  rows: [{ id: "r1", title: "Alpha", status: "Active" }],
};
const view = (
  id: string,
  primitive: "cards" | "kanban" | "table" | "metrics",
) => ({
  id,
  primitive,
  title: id,
  collectionId: "records",
  config:
    primitive === "metrics"
      ? {
          metrics: [
            { id: "count", label: "Count", operation: "count" as const },
          ],
        }
      : primitive === "kanban"
        ? { groupBy: "status", lanes: ["Active"] }
        : primitive === "table"
          ? { columns: ["title", "status"] }
          : { titleField: "title", subField: "status" },
});

describe("low-level native composition grammar", () => {
  it("expresses five distinct information architectures without HTML", () => {
    const cases = [
      {
        title: "Relationship manager",
        views: [view("people", "cards"), view("history", "table")],
        composition: {
          id: "relationship-split",
          type: "split" as const,
          ratio: "1:2" as const,
          children: [
            {
              id: "people-leaf",
              type: "view" as const,
              viewId: "people",
              chrome: "none" as const,
            },
            {
              id: "relationship-context",
              type: "tabs" as const,
              tabs: [
                {
                  id: "history-tab",
                  label: "History",
                  child: {
                    id: "history-leaf",
                    type: "view" as const,
                    viewId: "history",
                  },
                },
              ],
            },
          ],
        },
      },
      {
        title: "Sales pipeline",
        views: [view("pipeline", "kanban")],
        composition: {
          id: "pipeline-stack",
          type: "stack" as const,
          children: [
            {
              id: "pipeline-leaf",
              type: "view" as const,
              viewId: "pipeline",
              emphasis: "primary" as const,
            },
          ],
        },
      },
      {
        title: "Job search",
        views: [view("summary", "metrics"), view("applications", "kanban")],
        composition: {
          id: "job-grid",
          type: "grid" as const,
          columns: 12,
          children: [
            {
              id: "summary-leaf",
              type: "view" as const,
              viewId: "summary",
              span: { lg: 4 },
            },
            {
              id: "applications-leaf",
              type: "view" as const,
              viewId: "applications",
              span: { lg: 8 },
            },
          ],
        },
      },
      {
        title: "Project command center",
        views: [view("status", "metrics"), view("work", "table")],
        composition: {
          id: "command-sections",
          type: "section" as const,
          title: "Execution",
          tone: "accent" as const,
          children: [
            {
              id: "status-leaf",
              type: "view" as const,
              viewId: "status",
              chrome: "none" as const,
            },
            { id: "work-leaf", type: "view" as const, viewId: "work" },
          ],
        },
      },
      {
        title: "Research workspace",
        views: [view("evidence", "table"), view("synthesis", "cards")],
        composition: {
          id: "research-tabs",
          type: "tabs" as const,
          tabs: [
            {
              id: "evidence-tab",
              label: "Evidence",
              child: {
                id: "evidence-leaf",
                type: "view" as const,
                viewId: "evidence",
              },
            },
            {
              id: "synthesis-tab",
              label: "Synthesis",
              child: {
                id: "synthesis-leaf",
                type: "view" as const,
                viewId: "synthesis",
              },
            },
          ],
        },
      },
    ];

    for (const candidate of cases) {
      expect(
        createWorkspaceInputSchema.safeParse({
          ...candidate,
          collections: [collection],
        }).success,
        candidate.title,
      ).toBe(true);
    }
    expect(
      new Set(cases.map((candidate) => candidate.composition.type)).size,
    ).toBe(5);
    expect(
      cases.every((candidate) => !JSON.stringify(candidate).includes("html")),
    ).toBe(true);
  });
});
