import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY,
  buildGeneratedOperationsBrief,
  buildGeneratedToolAutonomyPrompt,
  generatedToolCapabilityAllowed,
} from "./generated-tool-autonomy.js";

describe("generated operations autonomy contract", () => {
  it("is domain-neutral, consumes shared bindings, and preserves four permission boundaries", () => {
    const prompt = buildGeneratedToolAutonomyPrompt({
      workspaceId: "ws1",
      title: "Research tracker",
      capabilities: [
        {
          id: "send-channel",
          role: "action-channel",
          kind: "messaging",
          label: "Messaging",
          enabled: true,
          scopes: ["send"],
        },
      ],
      sources: [
        {
          id: "meetings",
          kind: "meeting-transcript",
          label: "Meeting notes",
          enabled: true,
          scopes: ["read"],
        },
      ],
      policy: {
        ...DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY,
        enabled: true,
        goal: "Keep evidence current",
        permissions: {
          observe: { sourceIds: ["meetings"] },
          internalState: "automatic",
          evolvePresentation: "automatic",
          prepareExternalActions: "automatic",
          executeConsequentialActions: "require-approval",
        },
      },
    });
    expect(prompt).toContain("meeting-transcript");
    expect(prompt).toContain("action-channel/messaging");
    expect(prompt).toContain("Observation does not imply mutation");
    expect(prompt).toContain("Preparing a draft does not authorize execution");
    expect(prompt).toContain("never modify BB platform/runtime infrastructure");
    expect(prompt).toContain("individual proposal has explicit human approval");
    expect(prompt).toContain("atomically claim the approved action");
    expect(prompt).toContain("evaluate outcomes against goal success criteria");
    expect(prompt).not.toMatch(/sales|job search/i);
  });

  it("makes connector and side-effect adapters enforce every capability boundary", () => {
    const permissions = {
      observe: { sourceIds: ["calendar"] },
      internalState: "recommend-only" as const,
      evolvePresentation: "automatic" as const,
      prepareExternalActions: "automatic" as const,
      executeConsequentialActions: "require-approval" as const,
    };
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "observe",
        sourceId: "calendar",
      }),
    ).toBe(true);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "observe",
        sourceId: "email",
      }),
    ).toBe(false);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "modify-internal-state",
      }),
    ).toBe(false);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "evolve-presentation",
      }),
    ).toBe(true);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "prepare-external-action",
      }),
    ).toBe(true);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "execute-consequential-action",
        proposalStatus: "open",
      }),
    ).toBe(false);
    expect(
      generatedToolCapabilityAllowed(permissions, {
        capability: "execute-consequential-action",
        proposalStatus: "approved",
      }),
    ).toBe(true);
  });

  it("rolls handled work and open decisions up across workspace projections", () => {
    const brief = buildGeneratedOperationsBrief([
      {
        workspaceId: "fractional-ae",
        autonomy: {
          policy: DEFAULT_GENERATED_TOOL_AUTONOMY_POLICY,
          capabilities: [],
          goals: [
            {
              id: "goal1",
              objective: "Create qualified opportunities",
              successCriteria: ["Three qualified"],
              status: "active",
              progress: 0.33,
              assessment: "One of three qualified.",
            },
          ],
          entities: [],
          opportunities: [],
          externalActions: [],
          outcomes: [
            {
              id: "outcome1",
              observedAt: "2026-08-09T00:02:00Z",
              result: "positive",
              assessment: "Verified outreach was delivered.",
              evidence: ["receipt:1"],
            },
          ],
          sources: [],
          signals: [],
          runs: [
            {
              id: "run1",
              status: "completed",
              startedAt: "2026-08-09T00:00:00Z",
              completedAt: "2026-08-09T00:01:00Z",
              summary: "Verified two accounts.",
            },
          ],
          recommendations: [
            {
              id: "rec1",
              kind: "external-action",
              title: "Send proposal",
              rationale: "Terms are ready.",
              evidence: ["meeting:42"],
              status: "open",
              createdAt: "2026-08-09T00:01:00Z",
            },
          ],
        },
      },
      { workspaceId: "job-search" },
    ]);
    expect(brief.changedWorkspaceIds).toEqual(["fractional-ae"]);
    expect(brief.goals[0]).toMatchObject({
      objective: "Create qualified opportunities",
      progress: 0.33,
    });
    expect(brief.handled[0]?.summary).toBe("Verified two accounts.");
    expect(brief.outcomes[0]).toMatchObject({
      result: "positive",
      assessment: "Verified outreach was delivered.",
    });
    expect(brief.attention[0]).toMatchObject({
      workspaceId: "fractional-ae",
      kind: "external-action",
      status: "open",
    });
  });
});
