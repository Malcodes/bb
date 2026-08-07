import { describe, expect, it } from "vitest";
import { applyMutation, newId, type Workspace } from "./src/model.js";

function sample(): Workspace {
  return {
    id: "ws1",
    threadId: "thr1",
    title: "Sales Job Search",
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
    collections: [
      {
        id: "prospects",
        name: "Prospects",
        fields: ["company", "contact", "stage", "lastTouch"],
        rows: [
          {
            id: "r1",
            company: "Token Co",
            contact: "Ada",
            stage: "Priority outreach",
            lastTouch: "—",
          },
          {
            id: "r2",
            company: "Globex",
            contact: "Raj",
            stage: "Contacted",
            lastTouch: "Aug 5",
          },
        ],
      },
    ],
    views: [
      {
        id: "v1",
        primitive: "kanban",
        title: "Pipeline",
        collectionId: "prospects",
        config: {
          groupBy: "stage",
          lanes: ["Priority outreach", "Contacted", "Interviewing"],
          titleField: "company",
          subField: "contact",
        },
      },
    ],
  };
}

describe("applyMutation", () => {
  it("moves a row's group field (kanban drag == agent moveRow)", () => {
    const ws = sample();
    const ok = applyMutation(ws, {
      op: "moveRow",
      workspaceId: "ws1",
      collectionId: "prospects",
      rowId: "r1",
      field: "stage",
      value: "Contacted",
    });
    expect(ok).toBe(true);
    expect(ws.collections[0].rows[0].stage).toBe("Contacted");
  });

  it("patches arbitrary fields and learns new fields", () => {
    const ws = sample();
    applyMutation(ws, {
      op: "patchRow",
      workspaceId: "ws1",
      collectionId: "prospects",
      rowId: "r1",
      patch: { lastTouch: "Aug 7", emailed: true },
    });
    expect(ws.collections[0].rows[0].lastTouch).toBe("Aug 7");
    expect(ws.collections[0].fields).toContain("emailed");
  });

  it("adds and removes rows", () => {
    const ws = sample();
    applyMutation(ws, {
      op: "addRow",
      workspaceId: "ws1",
      collectionId: "prospects",
      row: {
        id: "r3",
        company: "New Co",
        stage: "Priority outreach",
        contact: "Sam",
        lastTouch: "—",
      },
    });
    expect(ws.collections[0].rows).toHaveLength(3);
    applyMutation(ws, {
      op: "removeRow",
      workspaceId: "ws1",
      collectionId: "prospects",
      rowId: "r2",
    });
    expect(ws.collections[0].rows.map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("rejects wrong workspace / unknown rows", () => {
    const ws = sample();
    expect(
      applyMutation(ws, {
        op: "moveRow",
        workspaceId: "nope",
        collectionId: "prospects",
        rowId: "r1",
        field: "stage",
        value: "X",
      }),
    ).toBe(false);
    expect(
      applyMutation(ws, {
        op: "moveRow",
        workspaceId: "ws1",
        collectionId: "prospects",
        rowId: "nope",
        field: "stage",
        value: "X",
      }),
    ).toBe(false);
  });

  it("newId generates unique ids", () => {
    expect(newId("ws")).not.toBe(newId("ws"));
  });
});
