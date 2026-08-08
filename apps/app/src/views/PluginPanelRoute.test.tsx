// @vitest-environment jsdom

import { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import PluginPanelRoute from "./PluginPanelRoute";
import { PluginDynamicSidebarNavItems } from "@/components/plugin/PluginDynamicSidebarNavItems";
import SplitWorkspaceRoute from "./SplitWorkspaceRoute";

const lifecycle = vi.hoisted(() => ({ threadMounts: 0, threadUnmounts: 0 }));

vi.mock("./SplitWorkspaceRoute", () => ({
  default: () => {
    useEffect(() => {
      lifecycle.threadMounts += 1;
      return () => {
        lifecycle.threadUnmounts += 1;
      };
    }, []);
    return <div data-testid="thread-workspace">Thread workspace</div>;
  },
}));

vi.mock("./PluginPanelView", () => ({
  PluginPanelView: ({ pluginId, panelPath, subPath }: any) => (
    <main data-testid="standalone-generated-app" data-workspace-id={subPath}>
      {`${pluginId}/${panelPath}/${subPath}`}
    </main>
  ),
}));

function GeneratedToolsProvider({
  setState,
}: {
  setState: (state: any) => void;
}) {
  useEffect(() => {
    setState({
      items: [
        {
          id: "ws_1",
          title: "Job Search",
          icon: "Kanban",
          subPath: "ws_1",
        },
      ],
    });
  }, [setState]);
  return null;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-pathname">{location.pathname}</output>;
}

describe("production plugin panel route", () => {
  beforeEach(() => {
    lifecycle.threadMounts = 0;
    lifecycle.threadUnmounts = 0;
    resetPluginSlotStoreForTest();
    setPluginSlotRegistrations("sales", {
      homepageSections: [],
      settingsSections: [],
      navPanels: [
        {
          id: "generated-tool",
          title: "Generated tool",
          icon: "Kanban",
          path: "tool",
          sidebar: false,
          surface: "application",
          component: () => null,
        },
      ],
      sidebarNavItems: [
        {
          id: "generated-tools",
          title: "Generated tools",
          targetPanelId: "generated-tool",
          provider: GeneratedToolsProvider,
        },
      ],
      threadPanelActions: [],
      sidebarFooterActions: [],
      fileOpeners: [],
      messageDirectives: [],
    });
  });

  afterEach(() => {
    cleanup();
    resetPluginSlotStoreForTest();
  });

  it("unmounts the real thread route when a sidebar navigation enters an application panel", async () => {
    render(
      <MemoryRouter initialEntries={["/threads/thr_1"]}>
        <PluginDynamicSidebarNavItems />
        <LocationProbe />
        <Routes>
          <Route
            path="/plugins/:pluginId/:panelPath/*"
            element={<PluginPanelRoute />}
          />
          <Route
            path="*"
            element={
              <div data-testid="thread-owner">
                <SplitWorkspaceRoute />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("thread-workspace")).toBeTruthy();
    const row = screen.getByRole("button", { name: "Job Search" });
    // Full pointer sequence: this regresses the bug where dnd-kit's default
    // zero-distance sensor claimed pointer-down and swallowed row activation.
    await userEvent.click(row);

    expect(screen.getByTestId("location-pathname").textContent).toBe(
      "/plugins/sales/tool/ws_1",
    );
    expect(screen.queryByTestId("thread-workspace")).toBeNull();
    expect(screen.queryByText(/thread timeline/i)).toBeNull();
    expect(screen.queryByText(/message composer/i)).toBeNull();
    const application = screen.getByTestId("standalone-generated-app");
    expect(application.textContent).toBe("sales/tool/ws_1");
    expect(application.getAttribute("data-workspace-id")).toBe("ws_1");
    expect(lifecycle).toEqual({ threadMounts: 1, threadUnmounts: 1 });
  });
});
