// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import plugin from "./server.js";
import { workspaceIdFromDirective } from "./src/workspace-directive.js";

const app = await loadPluginApp(() => import("./app"));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(cleanup);

describe("fresh-instance generated workspace lifecycle", () => {
  it("creates from empty state, emits the returned id, renders inline, pins, and opens standalone", async () => {
    const host = createFakePluginHost({ pluginId: "sales" });
    await plugin(host.bb);
    expect(await host.harness.behavior.callRpc("listPinned", {})).toEqual({
      items: [],
    });

    const raw = await host.harness.behavior.callAgentTool(
      "sales_create_workspace",
      {
        title: "Sales Leadership Workspace",
        description: "Leadership pipeline decisions",
        collections: [
          {
            id: "opportunities",
            name: "Opportunities",
            fields: ["company", "stage", "priority"],
            rows: [
              {
                id: "opp-1",
                company: "Acme",
                stage: "Interviewing",
                priority: "High",
              },
            ],
          },
        ],
        views: [
          {
            id: "pipeline",
            primitive: "kanban",
            title: "Pipeline",
            collectionId: "opportunities",
            config: {
              groupBy: "stage",
              lanes: ["Sourced", "Interviewing", "Offer"],
            },
          },
        ],
      },
      { threadId: "fresh-thread", projectId: "fresh-project" },
    );
    const created = JSON.parse(String(raw)) as {
      workspaceId: string;
      renderDirective: string;
      workspace: { id: string };
    };
    expect(created.workspaceId).toBe(created.workspace.id);
    expect(created.renderDirective).toBe(
      `::sales-workspace{id="${created.workspaceId}"}`,
    );

    // This is the same parsed attribute payload the assistant's exact returned
    // directive produces; no prompt-specific reconstruction or fallback.
    const idMatch = created.renderDirective.match(
      /^::sales-workspace\{id="([^"]+)"\}$/,
    );
    expect(idMatch?.[1]).toBe(created.workspaceId);
    const attributes = { id: idMatch?.[1] ?? "" };
    expect(workspaceIdFromDirective(attributes)).toBe(created.workspaceId);

    const rpc = {
      getWorkspace: (input: unknown) =>
        host.harness.behavior.callRpc("getWorkspace", input),
      mutate: (input: unknown) =>
        host.harness.behavior.callRpc("mutate", input),
      setPinned: (input: unknown) =>
        host.harness.behavior.callRpc("setPinned", input),
      listPinned: (input: unknown) =>
        host.harness.behavior.callRpc("listPinned", input),
      reorderPinned: (input: unknown) =>
        host.harness.behavior.callRpc("reorderPinned", input),
    };
    const inline = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes,
        source: created.renderDirective,
        message: {
          id: "fresh-message",
          threadId: "fresh-thread",
          turnId: "fresh-turn",
          projectId: "fresh-project",
        },
        openWorkspaceFile: null,
      },
      { rpc },
    );
    await waitFor(() => {
      expect(
        inline.container.querySelector('[data-generated-app-surface="inline"]'),
      ).toBeTruthy();
      expect(
        within(inline.container).getByText("Sales Leadership Workspace"),
      ).toBeDefined();
      expect(within(inline.container).getByText("Acme")).toBeDefined();
    });

    fireEvent.click(
      within(inline.container).getByRole("button", { name: "Add to sidebar" }),
    );
    await waitFor(async () => {
      const pinned = (await host.harness.behavior.callRpc(
        "listPinned",
        {},
      )) as {
        items: { subPath: string }[];
      };
      expect(pinned.items[0]?.subPath).toBe(created.workspaceId);
    });

    const standalone = renderSlot(
      app.navPanels[0]!,
      { subPath: created.workspaceId },
      { rpc },
    );
    await waitFor(() => {
      expect(
        standalone.container.querySelector(
          '[data-generated-app-surface="application"]',
        ),
      ).toBeTruthy();
      expect(
        within(standalone.container).getByText("Sales Leadership Workspace"),
      ).toBeDefined();
      expect(within(standalone.container).getByText("Acme")).toBeDefined();
    });

    await host.harness.lifecycle.dispose();
  });
});
