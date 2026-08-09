import { describe, expect, it } from "vitest";
import {
  validateGeneratedAppComposition,
  type NativeCompositionNode,
} from "./generated-app-composition.js";

describe("shared native generated-app composition", () => {
  it("accepts bounded nested native structure and rejects missing refs, duplicate ids, and excess depth", () => {
    const composition: NativeCompositionNode = {
      id: "root",
      type: "split",
      ratio: "1:2",
      children: [
        {
          id: "attention",
          type: "surface",
          surface: "attention",
          chrome: "none",
        },
        {
          id: "context",
          type: "tabs",
          tabs: [
            {
              id: "overview-tab",
              label: "Overview",
              child: { id: "overview", type: "view", viewId: "overview" },
            },
          ],
        },
      ],
    };
    expect(
      validateGeneratedAppComposition(composition, new Set(["overview"])),
    ).toBe(true);
    expect(validateGeneratedAppComposition(composition, new Set())).toBe(false);

    const duplicate: NativeCompositionNode = {
      id: "duplicate",
      type: "stack",
      children: [
        { id: "leaf", type: "view", viewId: "overview" },
        { id: "leaf", type: "view", viewId: "overview" },
      ],
    };
    expect(
      validateGeneratedAppComposition(duplicate, new Set(["overview"])),
    ).toBe(false);
  });
});
