// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EntityAvatar,
  FieldControl,
  SemanticBadge,
} from "./src/generated-app.js";
import { computeMetricValues, ViewRenderer } from "./src/views.js";
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
    const company = screen.getByText("Token Company");
    expect(company).toBeDefined();
    const draggableCard = company.closest('[role="button"]');
    expect(draggableCard).toBeTruthy();
    expect(draggableCard?.className).toContain("cursor-grab");
    fireEvent.click(draggableCard!);
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Founding AE")).toBeDefined();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Add card to Contacted" }),
    ).toBeDefined();
    expect(screen.getByText("Closed")).toBeDefined();
    const lane = screen.getByText("Contacted").closest("section");
    expect(lane?.className).toContain("min-h-36");
    expect(lane?.className).toContain("self-start");
    expect(lane?.className).toContain("max-h-[min(54vh,500px,100%)]");
    expect(lane?.className).not.toContain("flex-1");
  });
});

it("recomputes declarative metrics from the current persistent collection rows", () => {
  const collection = {
    id: "opportunities",
    name: "Opportunities",
    fields: ["company", "stage", "priority"],
    rows: [
      { id: "r1", company: "A", stage: "Offer", priority: "High" },
      { id: "r2", company: "B", stage: "Interviewing", priority: "Medium" },
      { id: "r3", company: "C", stage: "Contacted", priority: "High" },
    ],
  };
  const view = {
    id: "metrics",
    primitive: "metrics" as const,
    title: "Summary",
    collectionId: "opportunities",
    config: {
      metrics: [
        {
          id: "offer",
          label: "Offer",
          operation: "count" as const,
          where: [
            { field: "stage", operator: "equals" as const, value: "Offer" },
          ],
        },
        {
          id: "late",
          label: "Late Stage",
          operation: "count" as const,
          where: [
            {
              field: "stage",
              operator: "in" as const,
              values: ["Interviewing", "Offer"],
            },
          ],
        },
        {
          id: "high",
          label: "High Priority",
          operation: "count" as const,
          where: [
            { field: "priority", operator: "equals" as const, value: "High" },
          ],
        },
      ],
    },
  };

  expect(
    computeMetricValues(view, collection).map((metric) => metric.value),
  ).toEqual(["1", "2", "2"]);
  collection.rows[1]!.stage = "Offer";
  collection.rows[2]!.stage = "Offer";
  expect(
    computeMetricValues(view, collection).map((metric) => metric.value),
  ).toEqual(["3", "3", "2"]);
});
