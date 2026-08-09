import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

async function expectFailure(work: Promise<unknown>, text: RegExp) {
  await expect(work).rejects.toThrow(text);
}

describe("persistent autonomous capability loop", () => {
  it("maintains goals/entities/opportunities and executes an external action only through approval, claim, and outcome", async () => {
    const host = createFakePluginHost({ pluginId: "sales" });
    await plugin(host.bb);
    const created = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "sales_create_workspace",
          {
            title: "Goal Operating Environment",
            collections: [
              {
                id: "state",
                name: "State",
                fields: ["name"],
                rows: [{ id: "s1", name: "Agent maintained" }],
              },
            ],
            views: [
              {
                id: "attention",
                primitive: "cards",
                title: "Attention",
                collectionId: "state",
                config: { titleField: "name" },
              },
            ],
          },
          { threadId: "origin", projectId: "project" },
        ),
      ),
    ) as { workspaceId: string };
    const workspaceId = created.workspaceId;

    await host.harness.callAgentTool("generated_tool_configure_autonomy", {
      workspaceId,
      enabled: true,
      goal: "Create qualified opportunities",
      constraints: ["Use verified evidence"],
      cadenceMinutes: 30,
      sourceBindings: [],
      capabilityBindings: [
        {
          id: "message-channel",
          role: "action-channel",
          kind: "messaging",
          label: "Verified messaging channel",
          enabled: true,
          scopes: ["send"],
        },
      ],
      permissions: {
        observe: { sourceIds: [] },
        internalState: "automatic",
        evolvePresentation: "recommend-only",
        prepareExternalActions: "automatic",
        executeConsequentialActions: "require-approval",
      },
    });
    const goalWorkspace = JSON.parse(
      String(
        await host.harness.callAgentTool("generated_operations_set_goal", {
          workspaceId,
          objective: "Create three qualified opportunities",
          successCriteria: ["3 opportunities reach qualified"],
          status: "active",
          progress: 0.33,
          assessment: "One of three qualified.",
        }),
      ),
    ) as any;
    const goalId = goalWorkspace.autonomy.goals[0].id as string;

    await host.harness.callAgentTool("generated_operations_upsert_entity", {
      workspaceId,
      ref: "company:acme",
      kind: "company",
      label: "Acme",
      aliases: ["Acme Inc."],
      facts: [
        {
          key: "fit",
          value: "Strong",
          confidence: 0.9,
          evidence: ["web:acme-about"],
          observedAt: "2026-08-09T10:00:00Z",
        },
      ],
    });
    await host.harness.callAgentTool(
      "generated_operations_upsert_opportunity",
      {
        workspaceId,
        entityRefs: ["company:acme"],
        title: "Acme expansion",
        hypothesis: "Acme has a verified need and suitable timing.",
        evidence: ["web:acme-about", "meeting:42"],
        score: 0.91,
        status: "qualified",
        nextAction: "Prepare a concise introduction",
      },
    );

    const action = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_propose_external_action",
          {
            workspaceId,
            idempotencyKey: "intro:company-acme:v1",
            channelBindingId: "message-channel",
            title: "Send Acme introduction",
            actionType: "send-message",
            target: "contact:acme-champion",
            payloadSummary: "A concise, evidence-backed introduction",
            rationale: "This is the highest-scoring qualified opportunity.",
            evidence: ["meeting:42"],
          },
        ),
      ),
    ) as { id: string };

    await expectFailure(
      host.harness.callAgentTool("generated_operations_claim_approved_action", {
        workspaceId,
        actionId: action.id,
      }),
      /not explicitly approved/,
    );

    let workspace = (await host.harness.callRpc("getWorkspace", {
      workspaceId,
    })) as any;
    const recommendation = workspace.autonomy.recommendations.find(
      (item: any) => item.externalActionId === action.id,
    );
    expect(recommendation.externalActionId).toBe(action.id);
    workspace = await host.harness.callRpc("resolveRecommendation", {
      workspaceId,
      recommendationId: recommendation.id,
      decision: "approved",
    });
    expect((workspace as any).autonomy.externalActions[0].status).toBe(
      "approved",
    );

    const claimed = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_claim_approved_action",
          { workspaceId, actionId: action.id },
        ),
      ),
    );
    expect(claimed).toMatchObject({
      status: "executing",
      attempts: 1,
      idempotencyKey: "intro:company-acme:v1",
      channelBindingId: "message-channel",
    });
    await expectFailure(
      host.harness.callAgentTool("generated_operations_claim_approved_action", {
        workspaceId,
        actionId: action.id,
      }),
      /not explicitly approved|cannot be claimed/,
    );

    workspace = await host.harness.callAgentTool(
      "generated_operations_record_action_outcome",
      {
        workspaceId,
        actionId: action.id,
        succeeded: true,
        outcome: "Message accepted by the action channel.",
        result: "positive",
        assessment: "The action completed; await response before advancing.",
        evidence: ["channel-receipt:abc"],
        goalId,
        followUp: "Observe for a reply",
      },
    );
    const final = JSON.parse(String(workspace)) as any;
    expect(final.autonomy.entities[0]).toMatchObject({
      ref: "company:acme",
      facts: [expect.objectContaining({ key: "fit", confidence: 0.9 })],
    });
    expect(final.autonomy.opportunities[0]).toMatchObject({
      title: "Acme expansion",
      status: "qualified",
      score: 0.91,
    });
    expect(final.autonomy.externalActions[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(final.autonomy.outcomes[0]).toMatchObject({
      goalId,
      actionId: action.id,
      result: "positive",
    });
    await host.harness.dispose();
  });
});
