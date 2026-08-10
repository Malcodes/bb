/**
 * DRAFTS surface + revision loop acceptance:
 * approve → executes once; reject → never executes; comment → revision →
 * old revision cannot execute → new revision needs fresh approval; multiple
 * revision cycles; stale approvals rejected; duplicate execution prevented;
 * drafting preferences recorded without changing autonomy policy.
 */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

const WS = { workspaceId: "" };

async function makeHost() {
  const host = createFakePluginHost({
    pluginId: "sales",
    sdk: {
      plugins: {
        callRpc: async () => {
          throw new Error("google-workspace not connected in this test");
        },
      },
    },
  });
  await plugin(host.bb, { now: () => new Date("2026-08-09T20:00:00Z") });
  const created = JSON.parse(
    String(
      await host.harness.callAgentTool("sales_create_workspace", {
        title: "Opportunity System",
        collections: [
          {
            id: "attention",
            name: "Attention",
            fields: ["item"],
            rows: [{ id: "seed", item: "seed" }],
          },
        ],
        views: [
          {
            id: "attention",
            primitive: "cards",
            title: "Attention",
            collectionId: "attention",
            config: {},
          },
        ],
      }),
    ),
  );
  WS.workspaceId = created.workspaceId;
  // Enable autonomy with the default require-approval policy.
  const configured = JSON.parse(
    String(
      await host.harness.callAgentTool("generated_tool_configure_autonomy", {
        workspaceId: created.workspaceId,
        enabled: true,
        goal: "Advance qualified opportunities",
        constraints: [],
        cadenceMinutes: 30,
        sourceBindings: [
          {
            id: "gmail",
            kind: "email",
            label: "Gmail",
            enabled: true,
            scopes: [],
          },
        ],
        capabilityBindings: [
          {
            id: "google:gmail",
            role: "action-channel",
            kind: "google-work",
            label: "Gmail",
            enabled: true,
            scopes: [],
          },
        ],
        permissions: {
          observe: { sourceIds: ["gmail"] },
          internalState: "automatic",
          evolvePresentation: "automatic",
          prepareExternalActions: "automatic",
          executeConsequentialActions: "require-approval",
        },
      }),
    ),
  );
  return { host, workspace: configured };
}

let proposalCounter = 0;
function proposePayload(body: string) {
  proposalCounter += 1;
  return {
    title: "Reply to Justin",
    actionType: "gmail.send-reply",
    channelBindingId: "google:gmail",
    target: "thread-justin",
    payloadSummary: `Reply: ${body.slice(0, 40)}`,
    payload: {
      threadId: "thread-justin",
      inReplyToMessageId: "m1",
      to: JSON.stringify(["justin@x.com"]),
      cc: "[]",
      subject: "Re: Catch up",
      body,
    },
    rationale: "Justin asked for timing; reply keeps the thread warm.",
    evidence: ["gmail-message:m1"],
    idempotencyKey: `gmail-reply:thread-justin:v1:${proposalCounter}:${body.slice(0, 20)}`,
  };
}

async function propose(host: any, body: string) {
  return JSON.parse(
    String(
      await host.harness.callAgentTool(
        "generated_operations_propose_external_action",
        { workspaceId: WS.workspaceId, ...proposePayload(body) },
      ),
    ),
  );
}

async function getWorkspace(host: any) {
  return (await host.harness.callRpc("getWorkspace", {
    workspaceId: WS.workspaceId,
  })) as any;
}

function attentionItemFor(workspace: any, actionId: string) {
  return workspace.autonomy.attentionItems.find(
    (item: any) => item.externalActionId === actionId,
  );
}

describe("DRAFTS surface: approval + revision loop", () => {
  it("approve → claimable exactly once; double claim rejected", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "I'll call you tomorrow.");
    expect(action.revision).toBe(1);
    expect(action.revisions).toHaveLength(1);

    let workspace = await getWorkspace(host);
    const item = attentionItemFor(workspace, action.id);
    expect(item.status).toBe("open");

    // Approve via the surface decision path.
    workspace = await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: item.id,
      decision: "approved",
    });
    const approved = workspace.autonomy.externalActions[0];
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeTruthy();

    // Claim once → executing; second claim fails (no duplicate execution).
    await host.harness.callAgentTool(
      "generated_operations_claim_approved_action",
      { workspaceId: WS.workspaceId, actionId: action.id },
    );
    await expect(
      host.harness.callAgentTool(
        "generated_operations_claim_approved_action",
        { workspaceId: WS.workspaceId, actionId: action.id },
      ),
    ).rejects.toThrow(/not explicitly approved|cannot be claimed|executing/);
  });

  it("reject → never claimable, never executes", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "Rejected body.");
    const workspace = await getWorkspace(host);
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: attentionItemFor(workspace, action.id).id,
      decision: "rejected",
    });
    await expect(
      host.harness.callAgentTool(
        "generated_operations_claim_approved_action",
        { workspaceId: WS.workspaceId, actionId: action.id },
      ),
    ).rejects.toThrow();
    const after = await getWorkspace(host);
    expect(after.autonomy.externalActions[0].status).toBe("rejected");
  });

  it("comment → revision → old revision unclaimable → fresh approval required", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "Long body mentioning pricing.");
    expect(action.revision).toBe(1);
    expect(action.title).toBe("Reply to Justin");

    // Approve v1…
    let workspace = await getWorkspace(host);
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: attentionItemFor(workspace, action.id).id,
      decision: "approved",
    });

    // …then comment: "Shorter, warmer, and don't mention pricing yet."
    workspace = await host.harness.callRpc("commentOnExternalAction", {
      workspaceId: WS.workspaceId,
      actionId: action.id,
      comment: "Shorter, warmer, and don't mention pricing yet.",
    });
    let live = workspace.autonomy.externalActions[0];
    // Comment invalidates the approval and re-queues the draft.
    expect(live.status).toBe("proposed");
    expect(live.approvedAt).toBeUndefined();
    expect(live.comments).toHaveLength(1);
    expect(live.comments[0].text).toContain("Shorter, warmer");
    // A revision-request signal went to the agent.
    expect(
      workspace.autonomy.signals.some((signal: any) =>
        signal.fingerprint.startsWith(`draft-feedback:${action.id}`),
      ),
    ).toBe(true);
    // Prior approval no longer authorizes a claim.
    await expect(
      host.harness.callAgentTool(
        "generated_operations_claim_approved_action",
        { workspaceId: WS.workspaceId, actionId: action.id },
      ),
    ).rejects.toThrow(/not explicitly approved|cannot be claimed/);

    // Agent revises → v2.
    await host.harness.callAgentTool(
      "generated_operations_revise_external_action",
      {
        workspaceId: WS.workspaceId,
        actionId: action.id,
        payload: { ...proposePayload("x").payload, body: "Talk soon — warm note, no pricing." },
        payloadSummary: "Reply: shorter, warmer, no pricing",
        rationale: "Addressed Malcolm's feedback.",
        respondingTo: "Shorter, warmer, and don't mention pricing yet.",
      },
    );
    const revised = (await getWorkspace(host)).autonomy.externalActions.find(
      (candidate: any) => candidate.id === action.id,
    );
    expect(revised.revision).toBe(2);
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions[0].payload.body).toContain("pricing");
    expect(revised.status).toBe("proposed");
    expect(revised.revisions[1].comment).toContain("Shorter, warmer");

    // v2 still unclaimable until freshly approved.
    await expect(
      host.harness.callAgentTool(
        "generated_operations_claim_approved_action",
        { workspaceId: WS.workspaceId, actionId: action.id },
      ),
    ).rejects.toThrow();

    // Fresh approval of v2 → claimable; execution payload is the REVISED one.
    workspace = await getWorkspace(host);
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: attentionItemFor(workspace, action.id).id,
      decision: "approved",
    });
    const claimed = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_claim_approved_action",
          { workspaceId: WS.workspaceId, actionId: action.id },
        ),
      ),
    );
    expect(claimed.payload.body).toContain("no pricing");
    expect(claimed.revision).toBe(2);
  });

  it("supports multiple revision cycles with full provenance", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "v1 body");
    for (const [index, comment] of ["First pass feedback.", "Second pass feedback."].entries()) {
      await host.harness.callRpc("commentOnExternalAction", {
        workspaceId: WS.workspaceId,
        actionId: action.id,
        comment,
      });
      await host.harness.callAgentTool(
        "generated_operations_revise_external_action",
        {
          workspaceId: WS.workspaceId,
          actionId: action.id,
          payload: { ...proposePayload("x").payload, body: `v${index + 2} body` },
          payloadSummary: `revision ${index + 2}`,
          rationale: `Addressing: ${comment}`,
          respondingTo: comment,
        },
      );
    }
    const workspace = await getWorkspace(host);
    const live = workspace.autonomy.externalActions[0];
    expect(live.revision).toBe(3);
    expect(live.revisions).toHaveLength(3);
    expect(live.comments).toHaveLength(2);
    expect(live.comments[0].text).toBe("First pass feedback.");
    expect(live.comments[1].onRevision).toBe(2);
    expect(live.revisions.map((r: any) => r.revisedBy)).toEqual([
      "agent",
      "agent",
      "agent",
    ]);
  });

  it("comment never executes and reject after comment still blocks", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "body");
    await host.harness.callRpc("commentOnExternalAction", {
      workspaceId: WS.workspaceId,
      actionId: action.id,
      comment: "Needs work.",
    });
    // Reject after comment → terminal rejected, never claimable.
    const workspace = await getWorkspace(host);
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: attentionItemFor(workspace, action.id).id,
      decision: "rejected",
    });
    await expect(
      host.harness.callAgentTool(
        "generated_operations_claim_approved_action",
        { workspaceId: WS.workspaceId, actionId: action.id },
      ),
    ).rejects.toThrow();
  });

  it("drafting preferences are recorded without touching autonomy policy", async () => {
    const { host } = await makeHost();
    const before = await getWorkspace(host);
    const policyBefore = JSON.stringify(before.autonomy.policy);
    await host.harness.callAgentTool(
      "generated_operations_record_drafting_preference",
      {
        workspaceId: WS.workspaceId,
        guidance: "Keep replies short and warm; avoid pricing in first replies.",
        actionType: "gmail.send-reply",
        sourceComment: "Shorter, warmer, and don't mention pricing yet.",
      },
    );
    const after = await getWorkspace(host);
    expect(after.autonomy.draftingPreferences).toHaveLength(1);
    expect(after.autonomy.draftingPreferences[0].guidance).toContain("short");
    // Approval requirements unchanged.
    expect(JSON.stringify(after.autonomy.policy)).toBe(policyBefore);
    expect(
      after.autonomy.policy.permissions.executeConsequentialActions,
    ).toBe("require-approval");
  });

  it("terminal actions are immutable: no comment or revision after execution", async () => {
    const { host } = await makeHost();
    const action = await propose(host, "body");
    let workspace = await getWorkspace(host);
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId: WS.workspaceId,
      itemId: attentionItemFor(workspace, action.id).id,
      decision: "approved",
    });
    await host.harness.callAgentTool(
      "generated_operations_claim_approved_action",
      { workspaceId: WS.workspaceId, actionId: action.id },
    );
    await expect(
      host.harness.callRpc("commentOnExternalAction", {
        workspaceId: WS.workspaceId,
        actionId: action.id,
        comment: "too late",
      }),
    ).rejects.toThrow(/status/);
    await expect(
      host.harness.callAgentTool("generated_operations_revise_external_action", {
        workspaceId: WS.workspaceId,
        actionId: action.id,
        payload: {},
        payloadSummary: "x",
        rationale: "x",
      }),
    ).rejects.toThrow(/immutable|status/);
  });
});
