import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type {
  GmailMessage,
  GoogleCalendarEvent,
  GoogleWorkTransport,
} from "@bb/plugin-sdk";
import plugin from "./server.js";

const person = (email: string) => ({ email });

describe("unattended Gmail + Calendar operating loop", () => {
  it("maintains context for hours, starts analysis, gates execution, and records the real channel outcome", async () => {
    let now = new Date("2026-08-09T12:00:00Z");
    const sent: string[] = [];
    const incoming: GmailMessage = {
      id: "mail-1",
      threadId: "thread-1",
      historyId: "h1",
      internalDate: "2026-08-09T11:30:00Z",
      from: person("ada@acme.com"),
      to: [person("me@example.com")],
      cc: [],
      subject: "Launch approval",
      text: "Could you approve option B? I'll hold the slot until tomorrow.",
      labels: ["IMPORTANT"],
    };
    const event: GoogleCalendarEvent = {
      id: "event-1",
      calendarId: "primary",
      updated: "2026-08-09T11:00:00Z",
      status: "confirmed",
      summary: "Acme launch review",
      description: "Next step: confirm rollout owner",
      start: "2026-08-09T15:00:00Z",
      end: "2026-08-09T15:30:00Z",
      organizer: person("ada@acme.com"),
      attendees: [
        { email: "me@example.com", responseStatus: "accepted" },
        { email: "ada@acme.com", responseStatus: "accepted" },
      ],
    };
    const transport: GoogleWorkTransport = {
      async readGmailChanges({ historyId }) {
        return historyId
          ? { messages: [], historyId: "h2" }
          : { messages: [incoming], historyId: "h1" };
      },
      async readGmailThread() {
        return [incoming];
      },
      async readCalendarChanges({ syncToken }) {
        return syncToken
          ? { events: [], nextSyncToken: "cal-2" }
          : { events: [event], nextSyncToken: "cal-1" };
      },
      async sendGmailReply(input) {
        sent.push(`${input.idempotencyKey}:${input.threadId}:${input.body}`);
        return { messageId: "sent-1", threadId: input.threadId };
      },
      async updateCalendarEvent(input) {
        sent.push(`${input.idempotencyKey}:${input.eventId}`);
        return { eventId: input.eventId, updated: now.toISOString() };
      },
    };
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
            permissionMode: "auto",
          }),
          spawn: () => ({ id: "google-worker" }),
        },
      },
    });
    await plugin(host.bb, {
      googleTransport: transport,
      googleUserEmail: "me@example.com",
      googleCalendarIds: ["primary"],
      now: () => now,
    });
    const created = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "sales_create_workspace",
          {
            title: "Personal operating context",
            collections: [
              {
                id: "attention",
                name: "Attention",
                fields: ["item"],
                rows: [{ id: "seed", item: "Agent maintained" }],
              },
            ],
            views: [
              {
                id: "attention",
                primitive: "cards",
                title: "Attention",
                collectionId: "attention",
                config: { titleField: "item" },
              },
            ],
          },
          { threadId: "origin", projectId: "project-1" },
        ),
      ),
    ) as { workspaceId: string };
    const workspaceId = created.workspaceId;
    await host.harness.callAgentTool("generated_tool_configure_autonomy", {
      workspaceId,
      enabled: true,
      goal: "Keep commitments and meetings handled",
      constraints: ["Do not send or update without approval"],
      cadenceMinutes: 30,
      sourceBindings: [
        {
          id: "gmail-main",
          kind: "email",
          label: "Gmail",
          enabled: true,
          scopes: ["read"],
        },
        {
          id: "calendar-main",
          kind: "calendar",
          label: "Calendar",
          enabled: true,
          scopes: ["read"],
        },
      ],
      capabilityBindings: [
        {
          id: "google-actions",
          role: "action-channel",
          kind: "google-work",
          label: "Google Work",
          enabled: true,
          scopes: ["gmail.send", "calendar.events"],
        },
      ],
      permissions: {
        observe: { sourceIds: ["gmail-main", "calendar-main"] },
        internalState: "automatic",
        evolvePresentation: "recommend-only",
        prepareExternalActions: "automatic",
        executeConsequentialActions: "require-approval",
      },
    });

    await host.harness.runSchedule("google-work-capability-poll");
    let workspace = (await host.harness.callRpc("getWorkspace", {
      workspaceId,
    })) as any;
    expect(workspace.autonomy.signals).toHaveLength(2);
    expect(
      workspace.autonomy.entities.map((entity: any) => entity.ref),
    ).toEqual(
      expect.arrayContaining([
        "person:ada@acme.com",
        "company-domain:acme.com",
      ]),
    );
    expect(workspace.autonomy.attentionItems).toEqual([]);
    expect(
      workspace.autonomy.signals.find(
        (signal: any) => signal.attention === "response-needed",
      ).context,
    ).toContain("approve option B");

    await host.harness.runSchedule("generated-tool-operator-sweep");
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      visibility: "hidden",
      permissionMode: "auto",
    });

    now = new Date("2026-08-09T16:00:00Z");
    await host.harness.runSchedule("google-work-capability-poll");
    workspace = (await host.harness.callRpc("getWorkspace", {
      workspaceId,
    })) as any;
    expect(workspace.autonomy.signals).toHaveLength(2);

    const action = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "generated_operations_propose_external_action",
          {
            workspaceId,
            idempotencyKey: "gmail-reply:thread-1:v1",
            title: "Reply to Ada",
            actionType: "gmail.send-reply",
            channelBindingId: "google-actions",
            target: "thread:thread-1",
            payloadSummary: "Approve option B and confirm follow-up",
            payload: {
              threadId: "thread-1",
              inReplyToMessageId: "mail-1",
              to: JSON.stringify(["ada@acme.com"]),
              subject: "Re: Launch approval",
              body: "Option B is approved. I'll send the owner confirmation tomorrow.",
            },
            rationale: "The full thread asks for a launch decision.",
            evidence: ["gmail-message:mail-1"],
          },
        ),
      ),
    ) as { id: string };
    await expect(
      host.harness.callAgentTool("google_work_execute_claimed_action", {
        workspaceId,
        actionId: action.id,
      }),
    ).rejects.toThrow(/approved and claimed/);

    workspace = (await host.harness.callRpc("getWorkspace", {
      workspaceId,
    })) as any;
    const approval = workspace.autonomy.attentionItems.find(
      (item: any) => item.externalActionId === action.id,
    );
    await host.harness.callRpc("resolveAttentionItem", {
      workspaceId,
      itemId: approval.id,
      decision: "approved",
    });
    await host.harness.callAgentTool(
      "generated_operations_claim_approved_action",
      {
        workspaceId,
        actionId: action.id,
      },
    );
    const completed = JSON.parse(
      String(
        await host.harness.callAgentTool("google_work_execute_claimed_action", {
          workspaceId,
          actionId: action.id,
        }),
      ),
    ) as any;
    expect(sent).toEqual([
      "gmail-reply:thread-1:v1:thread-1:Option B is approved. I'll send the owner confirmation tomorrow.",
    ]);
    expect(completed.autonomy.externalActions[0]).toMatchObject({
      status: "succeeded",
      outcome: "Gmail reply sent in thread thread-1.",
    });
    expect(completed.autonomy.outcomes[0]).toMatchObject({
      result: "positive",
      evidence: ["gmail-message:sent-1"],
    });
    await host.harness.dispose();
  });
});
