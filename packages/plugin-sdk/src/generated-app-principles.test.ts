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
    expect(GENERATED_APP_AGENT_PRINCIPLES).not.toMatch(/sales|job search/i);
  });
});
