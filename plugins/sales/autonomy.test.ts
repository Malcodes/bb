import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

const createInput = {
  title: "Generated Research Tool",
  collections: [
    {
      id: "records",
      name: "Records",
      fields: ["name", "stage"],
      rows: [{ id: "r1", name: "Acme", stage: "New" }],
    },
  ],
  views: [
    {
      id: "board",
      primitive: "kanban",
      title: "Board",
      collectionId: "records",
      config: { groupBy: "stage", lanes: ["New"] },
    },
  ],
};

describe("generated-tool proactive operator", () => {
  it("persists policy, spawns a hidden safe worker, and gates external actions for approval", async () => {
    const host = createFakePluginHost({
      pluginId: "sales",
      sdk: {
        threads: {
          get: () => ({
            id: "origin",
            projectId: "project-1",
            environmentId: "env-1",
            providerId: "provider-1",
          }),
          defaultExecutionOptions: () => ({
            model: "model-1",
            reasoningLevel: "high",
            permissionMode: "full",
          }),
          spawn: () => ({ id: "worker-1" }),
        },
      },
    });
    await plugin(host.bb);
    const created = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "sales_create_workspace",
          createInput,
          { threadId: "origin", projectId: "project-1" },
        ),
      ),
    );
    const workspaceId = created.workspaceId as string;

    await host.harness.callAgentTool("generated_tool_configure_autonomy", {
      workspaceId,
      enabled: true,
      goal: "Keep records verified and decision-ready",
      constraints: ["Cite evidence", "Do not contact anyone"],
      cadenceMinutes: 5,
      sourceBindings: [
        {
          id: "mail-main",
          kind: "email",
          label: "Inbox",
          enabled: true,
          scopes: ["read"],
        },
      ],
      permissions: {
        observe: { sourceIds: ["mail-main"] },
        internalState: "automatic",
        evolvePresentation: "automatic",
        prepareExternalActions: "automatic",
        executeConsequentialActions: "require-approval",
      },
    });
    await host.harness.runSchedule("generated-tool-operator-sweep");

    const spawn = host.harness.sdk.callsTo("threads.spawn")[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(spawn.visibility).toBe("hidden");
    expect(spawn.permissionMode).toBe("auto");
    expect(String(spawn.prompt)).toContain(
      "Never perform a consequential external action",
    );
    expect(String(spawn.prompt)).toContain(
      "Keep records verified and decision-ready",
    );

    await host.harness.callAgentTool(
      "generated_tool_report_attention",
      {
        workspaceId,
        kind: "exception",
        title: "Verified outreach is blocked",
        rationale: "A response would unblock the record.",
        evidence: ["Verified contact page"],
      },
      { threadId: "worker-1", projectId: "project-1" },
    );
    let workspace = (await host.harness.callRpc("getWorkspace", {
      workspaceId,
    })) as any;
    expect(workspace.autonomy.runs[0]).toMatchObject({
      status: "running",
      workerThreadId: "worker-1",
    });
    expect(workspace.autonomy.attentionItems[0]).toMatchObject({
      kind: "exception",
      status: "open",
    });
    expect(
      workspace.autonomy.policy.permissions.executeConsequentialActions,
    ).toBe("require-approval");

    const firstSignal = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_ingest_signal",
          {
            targetWorkspaceIds: [workspaceId],
            sourceBindingId: "mail-main",
            sourceKind: "email",
            entityRefs: ["company:acme"],
            fingerprint: "message-123",
            observedAt: "2026-08-09T00:00:00Z",
            title: "Relevant reply",
            summary: "The contact confirmed availability.",
            evidence: ["email:message-123"],
            reconciled: true,
          },
          { threadId: "worker-1", projectId: "project-1" },
        ),
      ),
    );
    const secondSignal = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_ingest_signal",
          {
            targetWorkspaceIds: [workspaceId],
            sourceBindingId: "mail-main",
            sourceKind: "email",
            entityRefs: ["company:acme"],
            fingerprint: "message-123",
            observedAt: "2026-08-09T00:01:00Z",
            title: "Relevant reply",
            summary: "Updated normalized content.",
            evidence: ["email:message-123"],
            reconciled: true,
          },
          { threadId: "worker-1", projectId: "project-1" },
        ),
      ),
    );
    expect(secondSignal.id).toBe(firstSignal.id);
    expect(secondSignal.targetWorkspaceIds).toEqual([workspaceId]);
    expect(secondSignal.entityRefs).toEqual(["company:acme"]);
    expect(secondSignal.summary).toBe("Updated normalized content.");

    workspace = await host.harness.callRpc("resolveAttentionItem", {
      workspaceId,
      itemId: workspace.autonomy.attentionItems[0].id,
      decision: "resolved",
    });
    expect((workspace as any).autonomy.attentionItems[0].status).toBe(
      "resolved",
    );
    await host.harness.dispose();
  });
});
