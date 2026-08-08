import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

describe("generated Sales tool registrations", () => {
  it("keeps inline rendering and exposes a route-only panel plus dynamic sidebar provider", () => {
    expect(app.messageDirectives.map((slot) => slot.id)).toEqual([
      "sales-workspace",
    ]);
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({
      id: "generated-tool",
      path: "tool",
      sidebar: false,
      surface: "application",
    });
    expect(app.sidebarNavItems).toHaveLength(1);
    expect(app.sidebarNavItems[0]).toMatchObject({
      id: "generated-tools",
      targetPanelId: "generated-tool",
    });
  });
});
