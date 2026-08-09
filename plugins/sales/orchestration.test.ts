import { describe, expect, it } from "vitest";
import {
  deriveAttentionSummary,
  resolveKanbanLanes,
} from "./src/orchestration.js";
import type { Workspace } from "./src/model.js";

function workspace(): Workspace {
  return {
    id: "ws1",
    originThreadId: "t1",
    pinnedAt: null,
    navOrder: 0,
    revision: 1,
    title: "Revenue Leadership Search",
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    collections: [
      {
        id: "opportunities",
        name: "Opportunities",
        fields: ["company", "stage", "priority", "outcome"],
        fieldMeta: {
          stage: {
            type: "select",
            options: ["Sourced", "Interviewing", "Offer", "Won", "Lost"],
          },
        },
        rows: [
          {
            id: "1",
            company: "Acme",
            stage: "Interviewing",
            priority: "High",
            outcome: "",
          },
          {
            id: "2",
            company: "Globex",
            stage: "Offer",
            priority: "Normal",
            outcome: "",
          },
        ],
      },
    ],
    views: [
      {
        id: "board",
        primitive: "kanban",
        title: "Pipeline",
        collectionId: "opportunities",
        config: {
          groupBy: "stage",
          lanes: ["Sourced", "Interviewing", "Offer"],
        },
      },
    ],
  };
}

describe("orchestration intelligence", () => {
  it("summarizes actionable exceptions and decisions instead of metric labels", () => {
    const summary = deriveAttentionSummary(workspace());
    expect(summary).toContain("Review Acme");
    expect(summary).toContain("Decide the next action for Globex");
    expect(summary).not.toMatch(/active pipeline|late stage|offer: \d/i);
    expect(summary.split(/[.!?]+/).filter(Boolean)).toHaveLength(2);
  });

  it("adds explicit Won and Lost when field options support them", () => {
    const ws = workspace();
    expect(
      resolveKanbanLanes(ws.views[0]!, ws.collections[0]!, "stage"),
    ).toEqual(["Sourced", "Interviewing", "Offer", "Won", "Lost"]);
  });

  it("keeps a visible Closed destination when split outcomes are unsupported", () => {
    const ws = workspace();
    ws.collections[0]!.fieldMeta = undefined;
    expect(
      resolveKanbanLanes(ws.views[0]!, ws.collections[0]!, "stage"),
    ).toEqual(["Sourced", "Interviewing", "Offer", "Closed"]);
  });
});
