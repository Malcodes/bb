import { describe, expect, it } from "vitest";
import { GENERATED_APP_AGENT_PRINCIPLES } from "./generated-app-principles.js";

describe("generated-app agent principles", () => {
  it("defines human orchestration, agent operation, and hidden-data preservation as general guidance", () => {
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain(
      "the human is the orchestrator, not the operator",
    );
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain(
      "Prefer agent-maintained state over human data entry",
    );
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain(
      "underlying structured data available to agents even when hidden",
    );
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain(
      "human capability amplification",
    );
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain("domain-independent");
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain("capability adapters");
    expect(GENERATED_APP_AGENT_PRINCIPLES).toContain(
      "Do not recreate a database, dashboard, workflow editor, CRM, inbox, or calendar",
    );
    expect(GENERATED_APP_AGENT_PRINCIPLES).not.toMatch(/job search/i);
  });
});
