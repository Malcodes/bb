import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

describe("thread-native Sales UI registration", () => {
  it("registers one inline workspace directive and no standalone navigation", () => {
    expect(app.messageDirectives.map((slot) => slot.id)).toEqual([
      "sales-workspace",
    ]);
    expect(app.navPanels).toEqual([]);
  });
});
