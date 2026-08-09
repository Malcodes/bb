import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin, { type SelfOpsOptions } from "./server.js";
import { DEFAULT_THRESHOLDS } from "./src/model.js";
import type { SystemObservation } from "./src/model.js";

/**
 * Acceptance: introduce five realistic problems and verify BB detects each,
 * diagnoses it, proposes/performs the appropriate bounded improvement, tests
 * the result, records the outcome, and never weakens a safety boundary.
 */

const NOW = "2026-08-09T20:00:00.000Z";

function evidence(): SystemObservation[] {
  return [
    // 1. Oversized prompt/context
    {
      id: "obs-ctx-1",
      kind: "agent-trace",
      observedAt: NOW,
      subject: "thread:opportunity-research",
      attributes: { contextTokens: 61_000, model: "frontier-a" },
    },
    // 2. Failing scheduled run (consecutive, same signature)
    {
      id: "obs-run-1",
      kind: "run-outcome",
      observedAt: NOW,
      subject: "schedule:nightly-enrichment",
      attributes: {
        status: "failed",
        errorSignature: "timeout",
        retryCount: 4,
      },
    },
    {
      id: "obs-run-2",
      kind: "run-outcome",
      observedAt: NOW,
      subject: "schedule:nightly-enrichment",
      attributes: {
        status: "failed",
        errorSignature: "timeout",
        retryCount: 5,
      },
    },
    // 3. Redundant tool calls
    ...[1, 2, 3, 4].map((n) => ({
      id: `obs-tool-${n}`,
      kind: "tool-call" as const,
      observedAt: NOW,
      subject: "thread:opportunity-research",
      attributes: {
        tool: "web_fetch",
        argsHash: "same-url",
        stateChanged: false,
      },
    })),
    // 4. Expensive model for trivial classification
    ...[1, 2].map((n) => ({
      id: `obs-model-${n}`,
      kind: "model-usage" as const,
      observedAt: NOW,
      subject: "agent:email-triage",
      attributes: {
        taskClass: "classification",
        modelTier: "frontier",
        cost: 0.42,
        provider: "p1",
      },
    })),
    // 5. Low-value generated surface
    {
      id: "obs-surface-1",
      kind: "surface-usage",
      observedAt: NOW,
      subject: "surface:pipeline-raw-log",
      attributes: { zeroValueCycles: 5, decisionsProduced: 0 },
    },
    // Human corrections/approvals for the optimizer to learn from
    ...[1, 2, 3].map((n) => ({
      id: `obs-decision-${n}`,
      kind: "approval-decision" as const,
      observedAt: NOW,
      subject: "surface:pipeline-raw-log",
      attributes: {
        preferenceKey: "surface:pipeline-raw-log",
        decision: "dismissed",
      },
    })),
  ];
}

function harness(extra?: Partial<SelfOpsOptions>) {
  const host = createFakePluginHost({ pluginId: "selfops" });
  return {
    host,
    options: {
      now: () => NOW,
      hooks: {
        runExperiment: async ({ proposal, heldOut }: any) => ({
          baseline: heldOut.map((t: any) => ({
            taskId: t.id,
            passed: true,
            cost: 1.0,
            latencyMs: 900,
          })),
          candidate: heldOut.map((t: any) => ({
            taskId: t.id,
            passed: true,
            cost: proposal.expectedMetric === "cost" ? 0.3 : 1.0,
            latencyMs: proposal.expectedMetric === "latency" ? 300 : 900,
          })),
        }),
        applyAutonomousFix: async (proposal: any) =>
          `fixed:${proposal.change.kind}:${proposal.change.payload.subject}`,
      },
      ...extra,
    } satisfies SelfOpsOptions,
  };
}

describe("self-maintaining and self-improving layer", () => {
  it("detects, diagnoses, fixes/tests/measures all five problems and learns from corrections", async () => {
    const { host, options } = harness();
    await plugin(host.bb, options);

    const result = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_observe",
          { observations: evidence() },
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;

    const classes = result.diagnoses.map((d: any) => d.class).sort();
    expect(classes).toEqual(
      [
        "expensive-model-for-trivial-task",
        "failing-scheduled-run",
        "bad-retry-loop",
        "low-value-surface",
        "oversized-context",
        "redundant-tool-calls",
      ].sort(),
    );

    // Maintainer: routine safe fixes ran autonomously (schedule repair + retry cap).
    const fixedKinds = result.autoFixed.map((f: any) => f.receipt).join("|");
    expect(fixedKinds).toContain("schedule-repair:schedule:nightly-enrichment");
    expect(fixedKinds).toContain(
      "config-adjustment:schedule:nightly-enrichment",
    );

    // Tested changes: measured against held-out tasks and adopted (cheaper at equal reliability).
    expect(result.tested.length).toBe(4);
    expect(result.tested.every((e: any) => e.adopted)).toBe(true);

    // Idempotent: same evidence again produces nothing new.
    const second = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_observe",
          { observations: evidence() },
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    expect(second.diagnoses).toEqual([]);

    // Optimizer learned from the dismissal pattern.
    const brief = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_read_brief",
          {},
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    expect(
      brief.preferences.some(
        (p: any) =>
          p.key === "surface:pipeline-raw-log" &&
          p.choice === "reduce-surface-frequency",
      ),
    ).toBe(true);
    // Cheapest-reliable model routing was learned from the adopted experiment.
    expect(
      brief.preferences.some(
        (p: any) =>
          p.key === "model-routing:agent:email-triage" && p.choice === "cheap",
      ),
    ).toBe(true);
    expect(brief.adopted.length).toBeGreaterThanOrEqual(5);

    await host.harness.dispose();
  });

  it("keeps trust-boundary and unprovable changes behind approval and never adopts them silently", async () => {
    const { host, options } = harness({
      hooks: {
        runExperiment: async () => ({ baseline: [], candidate: [] }),
        applyAutonomousFix: async () => "fixed",
      },
    });
    await plugin(host.bb, options);

    // Unknown/broken connector class → approval-required escalation.
    const result = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_observe",
          {
            observations: [
              {
                id: "obs-conn-1",
                kind: "error",
                observedAt: NOW,
                subject: "connector:gmail",
                attributes: { error: "auth revoked", consecutive: 3 },
              },
            ],
          },
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    expect(result.escalated.length).toBeGreaterThan(0);

    const brief = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_read_brief",
          {},
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    const open = brief.openAttention[0];
    expect(open.status).toBe("open");

    // Without approval, the linked proposal must not be adopted.
    const proposal = brief.adopted.find((title: string) =>
      title.includes("connector"),
    );
    expect(proposal).toBeUndefined();

    // Explicit approval adopts exactly that bounded change.
    await host.harness.callAgentTool(
      "selfops_resolve_attention",
      { attentionId: open.id, decision: "approved" },
      { threadId: "t", projectId: "p" },
    );
    const after = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_read_brief",
          {},
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    expect(after.openAttention).toEqual([]);
    expect(after.adopted.some((t: string) => t.includes("connector"))).toBe(
      true,
    );

    await host.harness.dispose();
  });

  it("reverts changes that fail the reliability gate even when cheaper", async () => {
    const { host, options } = harness({
      hooks: {
        runExperiment: async ({ proposal, heldOut }: any) => ({
          baseline: heldOut.map((t: any) => ({
            taskId: t.id,
            passed: true,
            cost: 1,
            latencyMs: 900,
          })),
          // Cheaper but unreliable — must not be adopted.
          candidate: heldOut.map((t: any, i: number) => ({
            taskId: t.id,
            passed: i === 0,
            cost: 0.1,
            latencyMs: 100,
          })),
        }),
        applyAutonomousFix: async () => "fixed",
      },
    });
    await plugin(host.bb, options);
    const result = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "selfops_observe",
          {
            observations: [
              {
                id: "obs-model-x",
                kind: "model-usage",
                observedAt: NOW,
                subject: "agent:triage",
                attributes: {
                  taskClass: "classification",
                  modelTier: "frontier",
                  cost: 0.5,
                },
              },
            ],
          },
          { threadId: "t", projectId: "p" },
        ),
      ),
    ) as any;
    expect(result.tested[0].adopted).toBe(false);
    expect(result.tested[0].summary).toContain("Reverted");
    await host.harness.dispose();
  });

  it("threshold defaults keep optimization aimed at goal attainment, not token minimalism", () => {
    expect(DEFAULT_THRESHOLDS.minReliability).toBeGreaterThanOrEqual(0.9);
  });
});
