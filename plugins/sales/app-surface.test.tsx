// @vitest-environment jsdom
import { cleanup, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

const workspace = {
  id: "ws_1",
  originThreadId: "thr_1",
  pinnedAt: "2026-08-08T00:00:00Z",
  navOrder: 0,
  revision: 2,
  title: "Job Search",
  description: "A focused pipeline for active opportunities.",
  icon: "Target",
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  collections: [
    {
      id: "prospects",
      name: "Prospects",
      fields: ["company", "stage"],
      rows: [{ id: "r1", company: "Token Company", stage: "Contacted" }],
    },
  ],
  views: [
    {
      id: "board",
      primitive: "kanban" as const,
      title: "Pipeline",
      collectionId: "prospects",
      config: { groupBy: "stage", lanes: ["Contacted"] },
    },
  ],
};

const rpc = {
  getWorkspace: () => workspace,
  mutate: () => workspace,
  setPinned: () => workspace,
  listPinned: () => ({ items: [] }),
  reorderPinned: () => ({ ok: true as const }),
};

describe("shared generated workspace surface", () => {
  it("renders compact inline and standalone application variants from the same workspace", async () => {
    const inline = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { workspaceId: "ws_1" },
        source: '::sales-workspace{workspaceId="ws_1"}',
        message: {
          id: "m1",
          threadId: "thr_1",
          turnId: "turn_1",
          projectId: "p1",
        },
        openWorkspaceFile: null,
      },
      { rpc },
    );
    await waitFor(() =>
      expect(
        inline.container.querySelector('[data-generated-app-surface="inline"]'),
      ).toBeTruthy(),
    );

    const application = renderSlot(
      app.navPanels[0]!,
      { subPath: "ws_1" },
      { rpc },
    );
    await waitFor(() =>
      expect(
        application.container.querySelector(
          '[data-generated-app-surface="application"]',
        ),
      ).toBeTruthy(),
    );
    const appSurface = within(application.container);
    expect(appSurface.getByText("Job Search")).toBeDefined();
    expect(
      appSurface.getByText("A focused pipeline for active opportunities."),
    ).toBeDefined();
    expect(appSurface.queryByText(/thread/i)).toBeNull();
  });
});
