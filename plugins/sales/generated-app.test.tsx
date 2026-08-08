// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EntityAvatar,
  FieldControl,
  SemanticBadge,
} from "./src/generated-app.js";
import { ViewRenderer } from "./src/views.js";
import type { Workspace } from "./src/model.js";

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

describe("native generated-app vocabulary", () => {
  it("renders deterministic entity identity and restrained semantic status", () => {
    render(
      <div>
        <EntityAvatar fallback="Token Company" shape="rounded" />
        <SemanticBadge value="High" tone="danger" icon="AlertTriangle" />
      </div>,
    );
    expect(screen.getByText("TC")).toBeDefined();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
  });

  it("uses field metadata for concise contextual controls", () => {
    const change = vi.fn();
    render(
      <FieldControl
        field="stage"
        meta={{
          label: "Pipeline stage",
          type: "select",
          options: ["Contacted", "Interviewing"],
        }}
        value="Contacted"
        onChange={change}
      />,
    );
    fireEvent.change(screen.getByLabelText("Pipeline stage"), {
      target: { value: "Interviewing" },
    });
    expect(change).toHaveBeenCalledWith("Interviewing");
  });

  it("renders a presentation-configured Kanban with native toolbar, lanes, identity, metadata, and contextual add", () => {
    const workspace: Workspace = {
      id: "ws_1",
      originThreadId: "thr_1",
      pinnedAt: "2026-08-08T00:00:00Z",
      navOrder: 0,
      revision: 1,
      title: "Job Search",
      createdAt: "2026-08-08T00:00:00Z",
      updatedAt: "2026-08-08T00:00:00Z",
      collections: [
        {
          id: "prospects",
          name: "Prospects",
          fields: ["company", "role", "stage", "priority", "lastTouch"],
          fieldMeta: {
            stage: { type: "select", options: ["Contacted", "Interviewing"] },
            priority: { type: "badge", toneMap: { High: "danger" } },
            lastTouch: { type: "date" },
          },
          rows: [
            {
              id: "r1",
              company: "Token Company",
              role: "Founding AE",
              stage: "Contacted",
              priority: "High",
              lastTouch: "2026-08-07",
            },
          ],
        },
      ],
      views: [
        {
          id: "board",
          primitive: "kanban",
          title: "Pipeline",
          collectionId: "prospects",
          config: {
            groupBy: "stage",
            lanes: ["Contacted", "Interviewing"],
            presentation: {
              card: {
                titleField: "company",
                subtitleField: "role",
                avatar: { fallbackField: "company", shape: "rounded" },
                metadata: [
                  { field: "lastTouch", icon: "Clock", format: "date" },
                ],
                badges: [{ field: "priority", toneMap: { High: "danger" } }],
              },
              create: { fields: ["company", "role"] },
              detail: {
                sections: [
                  {
                    title: "Opportunity",
                    fields: ["company", "role", "priority"],
                  },
                ],
              },
              filters: ["priority"],
            },
          },
        },
      ],
    };
    render(
      <ViewRenderer
        view={workspace.views[0]!}
        workspace={workspace}
        mutate={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText("Search prospects…")).toBeDefined();
    expect(screen.getByText("Token Company")).toBeDefined();
    expect(screen.getByText("Founding AE")).toBeDefined();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Add card to Contacted" }),
    ).toBeDefined();
  });
});
