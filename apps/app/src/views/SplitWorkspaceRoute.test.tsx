// @vitest-environment jsdom

import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneContent } from "@/lib/split-layout";
import SplitWorkspaceRoute from "./SplitWorkspaceRoute";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";

const workspaceLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("./thread-detail/SplitThreadArea", () => ({
  SplitThreadArea: ({ routeContent }: { routeContent: PaneContent }) => {
    useEffect(() => {
      workspaceLifecycle.mounts += 1;
      return () => {
        workspaceLifecycle.unmounts += 1;
      };
    }, []);
    return <output data-testid="route-content">{routeContent.kind}</output>;
  },
}));

vi.mock("./PluginPanelView", () => ({
  PluginPanelView: ({ pluginId, panelPath, subPath }: any) => (
    <output data-testid="application-panel">{`${pluginId}/${panelPath}/${subPath}`}</output>
  ),
}));

vi.mock("./RootComposeView", () => ({
  LegacyProjectComposeRedirect: () => <div>legacy redirect</div>,
}));

function NavigationControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/")}>compose</button>
      <button onClick={() => navigate("/plugins/docs/docs/work/today.md")}>
        plugin
      </button>
      <button onClick={() => navigate("/threads/thread-1")}>thread</button>
    </>
  );
}

describe("SplitWorkspaceRoute", () => {
  afterEach(cleanup);
  beforeEach(() => {
    workspaceLifecycle.mounts = 0;
    workspaceLifecycle.unmounts = 0;
    resetPluginSlotStoreForTest();
  });

  it("preserves the workspace mount across focus-driven page URL changes", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <NavigationControls />
        <Routes>
          <Route path="*" element={<SplitWorkspaceRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("route-content").textContent).toBe("new-thread");

    fireEvent.click(screen.getByRole("button", { name: "plugin" }));
    expect(screen.getByTestId("route-content").textContent).toBe(
      "plugin-panel",
    );

    fireEvent.click(screen.getByRole("button", { name: "thread" }));
    expect(screen.getByTestId("route-content").textContent).toBe("thread");
    expect(workspaceLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });
  it("bypasses the thread split workspace for application panels", () => {
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
      threadPanelActions: [],
      sidebarFooterActions: [],
      fileOpeners: [],
      messageDirectives: [],
    });

    render(
      <MemoryRouter initialEntries={["/plugins/sales/tool/ws_1"]}>
        <Routes>
          <Route path="*" element={<SplitWorkspaceRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("application-panel").textContent).toBe(
      "sales/tool/ws_1",
    );
    expect(screen.queryByTestId("route-content")).toBeNull();
    expect(workspaceLifecycle.mounts).toBe(0);
  });
});
