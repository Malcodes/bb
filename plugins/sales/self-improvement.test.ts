import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

describe("agent-maintained generated-tool definition", () => {
  it("compacts the human surface, hides agent detail, and upgrades a decision queue without deleting operational state", async () => {
    const host = createFakePluginHost({ pluginId: "sales" });
    await plugin(host.bb);
    const created = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "sales_create_workspace",
          {
            title: "Revenue Leadership Search",
            collections: [
              {
                id: "opportunities",
                name: "Opportunities",
                fields: ["company", "stage"],
                rows: [{ id: "o1", company: "Acme", stage: "Interviewing" }],
              },
              {
                id: "agent-activity",
                name: "Agent Activity",
                fields: ["event", "evidence"],
                rows: [
                  { id: "a1", event: "Verified Acme", evidence: "source:1" },
                ],
              },
              {
                id: "decisions",
                name: "Decisions",
                fields: ["question", "context", "decision", "comment"],
                rows: [
                  {
                    id: "d1",
                    question: "Advance Acme to final diligence?",
                    context: "Evidence verified; one risk remains.",
                    decision: "",
                    comment: "",
                  },
                ],
              },
            ],
            views: [
              {
                id: "metrics",
                primitive: "metrics",
                title: "Metrics",
                layout: { height: 600 },
                collectionId: "opportunities",
                config: {
                  metrics: [
                    { id: "active", label: "Active", operation: "count" },
                  ],
                },
              },
              {
                id: "ranked-targets",
                primitive: "table",
                title: "Ranked Targets",
                collectionId: "opportunities",
                config: { columns: ["company", "stage"] },
              },
              {
                id: "agent-activity",
                primitive: "list",
                title: "Agent Activity",
                collectionId: "agent-activity",
                config: { titleField: "event", subField: "evidence" },
              },
              {
                id: "decision-queue",
                primitive: "list",
                title: "Decision Queue",
                collectionId: "decisions",
                config: { titleField: "question", subField: "context" },
              },
            ],
          },
          { threadId: "thread-1", projectId: "project-1" },
        ),
      ),
    ) as { workspaceId: string };

    await host.harness.callAgentTool("generated_tool_configure_autonomy", {
      workspaceId: created.workspaceId,
      enabled: true,
      goal: "Keep the human surface decision-ready",
      constraints: ["Preserve all operational evidence"],
      cadenceMinutes: 30,
      sourceBindings: [],
      permissions: {
        observe: { sourceIds: [] },
        internalState: "automatic",
        evolvePresentation: "automatic",
        prepareExternalActions: "automatic",
        executeConsequentialActions: "require-approval",
      },
    });

    const before = (await host.harness.callRpc("getWorkspace", {
      workspaceId: created.workspaceId,
    })) as any;
    const collectionsBefore = structuredClone(before.collections);
    const decisionView = before.views.find(
      (view: any) => view.id === "decision-queue",
    );

    await host.harness.callAgentTool("generated_tool_evolve_presentation", {
      workspaceId: created.workspaceId,
      rationale:
        "Remove empty space and agent-oriented detail; make the human decision executable in place.",
      mutations: [
        {
          op: "setViewDefinition",
          workspaceId: created.workspaceId,
          view: {
            ...before.views.find((view: any) => view.id === "metrics"),
            layout: undefined,
          },
        },
        {
          op: "setViewVisibility",
          workspaceId: created.workspaceId,
          viewId: "ranked-targets",
          visible: false,
        },
        {
          op: "setViewVisibility",
          workspaceId: created.workspaceId,
          viewId: "agent-activity",
          visible: false,
        },
        {
          op: "setViewDefinition",
          workspaceId: created.workspaceId,
          view: {
            ...decisionView,
            primitive: "decision",
            config: {
              decision: {
                promptField: "question",
                contextFields: ["context"],
                statusField: "decision",
                commentField: "comment",
                options: [
                  { label: "Yes", value: "yes", tone: "success" },
                  { label: "No", value: "no", tone: "danger" },
                ],
              },
            },
          },
        },
        {
          op: "reorderViews",
          workspaceId: created.workspaceId,
          viewIds: [
            "metrics",
            "decision-queue",
            "ranked-targets",
            "agent-activity",
          ],
        },
      ],
    });

    const after = (await host.harness.callRpc("getWorkspace", {
      workspaceId: created.workspaceId,
    })) as any;
    expect(after.collections).toEqual(collectionsBefore);
    expect(
      after.views.find((view: any) => view.id === "metrics").layout,
    ).toBeUndefined();
    expect(
      after.views.find((view: any) => view.id === "ranked-targets").visible,
    ).toBe(false);
    expect(
      after.views.find((view: any) => view.id === "agent-activity").visible,
    ).toBe(false);
    expect(
      after.views.find((view: any) => view.id === "decision-queue"),
    ).toMatchObject({
      primitive: "decision",
      config: {
        decision: { promptField: "question", statusField: "decision" },
      },
    });
    expect(after.autonomy.recommendations[0]).toMatchObject({
      title: "Presentation evolved",
      status: "resolved",
    });
    await host.harness.dispose();
  });
});
