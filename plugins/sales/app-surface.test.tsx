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

it("updates inline and pinned surfaces immediately when an agent hides or removes views", async () => {
  let current = {
    ...workspace,
    revision: 3,
    views: [
      ...workspace.views,
      {
        id: "all-opportunities",
        primitive: "table" as const,
        title: "All Opportunities",
        collectionId: "prospects",
        config: { columns: ["company", "stage"] },
      },
      {
        id: "activity",
        primitive: "timeline" as const,
        title: "Activity",
        collectionId: "prospects",
        config: {
          timeField: "stage",
          titleField: "company",
          subField: "stage",
        },
      },
    ],
  };
  const liveRpc = {
    ...rpc,
    getWorkspace: () => current,
    mutate: () => current,
    setPinned: () => current,
  };
  const inline = renderSlot(
    app.messageDirectives[0]!,
    {
      attributes: { workspaceId: "ws_1" },
      source: '::sales-workspace{workspaceId="ws_1"}',
      message: {
        id: "m2",
        threadId: "thr_1",
        turnId: "turn_2",
        projectId: "p1",
      },
      openWorkspaceFile: null,
    },
    { rpc: liveRpc },
  );
  const application = renderSlot(
    app.navPanels[0]!,
    { subPath: "ws_1" },
    { rpc: liveRpc },
  );

  await waitFor(() => {
    expect(
      within(inline.container).getAllByText("All Opportunities")[0],
    ).toBeDefined();
    expect(
      within(application.container).getAllByText("Activity")[0],
    ).toBeDefined();
  });

  current = {
    ...current,
    revision: 4,
    views: current.views
      .filter((view) => view.id !== "activity")
      .map((view) =>
        view.id === "all-opportunities" ? { ...view, visible: false } : view,
      ),
  };
  await inline.emitRealtime("workspaces-changed", { workspaceId: "ws_1" });
  await application.emitRealtime("workspaces-changed", {
    workspaceId: "ws_1",
  });

  await waitFor(() => {
    expect(
      within(inline.container).queryByText("All Opportunities"),
    ).toBeNull();
    expect(within(inline.container).queryByText("Activity")).toBeNull();
    expect(
      within(application.container).queryByText("All Opportunities"),
    ).toBeNull();
    expect(within(application.container).queryByText("Activity")).toBeNull();
    expect(within(inline.container).getByText("Token Company")).toBeDefined();
    expect(
      within(application.container).getByText("Token Company"),
    ).toBeDefined();
  });
});

it("renders a nested native composition with asymmetric split, chrome-free leaves, and accessible tabs", async () => {
  const composed = {
    ...workspace,
    id: "ws_composed",
    collections: [
      ...workspace.collections,
      {
        id: "research",
        name: "Research",
        fields: ["title", "status"],
        rows: [{ id: "e1", title: "Verified evidence", status: "Ready" }],
      },
    ],
    views: [
      {
        id: "relationships",
        primitive: "cards" as const,
        title: "Relationships",
        collectionId: "prospects",
        config: { titleField: "company", subField: "stage" },
      },
      {
        id: "evidence",
        primitive: "table" as const,
        title: "Evidence",
        collectionId: "research",
        config: { columns: ["title", "status"] },
      },
      {
        id: "synthesis",
        primitive: "cards" as const,
        title: "Synthesis",
        collectionId: "research",
        config: { titleField: "title", subField: "status" },
      },
    ],
    composition: {
      id: "relationship-workbench",
      type: "split" as const,
      ratio: "1:2" as const,
      gap: "spacious" as const,
      children: [
        {
          id: "relationship-list",
          type: "view" as const,
          viewId: "relationships",
          chrome: "none" as const,
          density: "compact" as const,
        },
        {
          id: "research-context",
          type: "tabs" as const,
          tabs: [
            {
              id: "evidence-tab",
              label: "Evidence",
              child: {
                id: "evidence-view",
                type: "view" as const,
                viewId: "evidence",
                emphasis: "primary" as const,
              },
            },
            {
              id: "synthesis-tab",
              label: "Synthesis",
              child: {
                id: "synthesis-view",
                type: "view" as const,
                viewId: "synthesis",
                chrome: "subtle" as const,
              },
            },
          ],
        },
      ],
    },
  };
  const composedRpc = {
    ...rpc,
    getWorkspace: () => composed,
    mutate: () => composed,
    setPinned: () => composed,
  };
  const surface = renderSlot(
    app.navPanels[0]!,
    { subPath: "ws_composed" },
    { rpc: composedRpc },
  );

  await waitFor(() =>
    expect(
      surface.container.querySelector(
        '[data-composition-node="relationship-workbench"]',
      ),
    ).toBeTruthy(),
  );
  const scope = within(surface.container);
  expect(scope.getByRole("tab", { name: "Evidence" })).toBeDefined();
  expect(scope.getByRole("tab", { name: "Synthesis" })).toBeDefined();
  expect(scope.getByText("Verified evidence")).toBeDefined();
  expect(
    surface.container.querySelector(
      '[data-composition-node="relationship-list"]',
    ),
  ).toBeTruthy();
});
