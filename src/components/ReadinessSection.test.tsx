// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PullMovement } from "@/movements";
import { getPullKey, type PullSectionItem } from "@/preferences";
import type { PullRuns } from "@/runs";
import { createPullsResponse } from "@/test/fixtures";

import ReadinessSection, {
  type ReadinessSectionProps,
} from "./ReadinessSection";

vi.mock("./PullRow", () => ({
  default: ({
    movement,
    pull,
    setFavorite,
  }: {
    movement?: PullMovement | null;
    pull: { number: number; repository: string; title: string };
    setFavorite?: (key: string, favorite: boolean) => void;
  }) => (
    <li data-pull-number={pull.number}>
      <span>{pull.title}</span>
      {movement && <span data-movement="">{movement.label}</span>}
      <button
        onClick={() =>
          setFavorite?.(`${pull.repository.toLowerCase()}#${pull.number}`, true)
        }
        type="button"
      >
        Favourite pull {pull.number}
      </button>
    </li>
  ),
}));

vi.mock("./TaskRow", () => ({
  default: () => <li>Local task</li>,
}));

const pullItems = (count: number): PullSectionItem[] => {
  const template = createPullsResponse().ready[0]!;
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const pull = {
      ...template,
      number,
      rank: number,
      title: `Pull ${number}`,
      url: `https://github.com/appwrite/cloud/pull/${number}`,
    };
    const identity = getPullKey(pull);
    return {
      favorite: false,
      identity,
      key: `pull:${pull.url}`,
      kind: "pull" as const,
      pull,
    };
  });
};

const runs = {
  cancel: vi.fn(),
  observeRepair: vi.fn(),
  setMessage: vi.fn(),
  start: vi.fn(),
  states: new Map(),
} as unknown as PullRuns;

const props = (
  items: readonly PullSectionItem[],
  overrides: Partial<ReadinessSectionProps> = {},
): ReadinessSectionProps => ({
  artifactEpoch: 1,
  emptyMessage: "Nothing ready.",
  items,
  onToggleViewed: vi.fn(),
  runs,
  title: "Ready",
  variant: "ready",
  visibleItemKeys: new Set(items.map((item) => item.key)),
  viewerLogin: "jake",
  viewedFiles: new Map(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReadinessSection", () => {
  it("keeps its sticky header contained and does not paginate 20 rows", () => {
    const view = render(<ReadinessSection {...props(pullItems(20))} />);

    const section = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"]',
    );
    const header = view.container.querySelector<HTMLElement>(
      "[data-readiness-section-header]",
    );
    const body = view.container.querySelector<HTMLElement>(
      "[data-readiness-section-body]",
    );

    expect(section).toHaveClass("readiness-section", "relative");
    expect(header).toHaveClass("readiness-section-header", "sticky");
    expect(body).toHaveClass("readiness-section-body");
    expect(section).toContainElement(header);
    expect(section).toContainElement(body);
    expect(screen.getAllByText(/^Pull \d+$/)).toHaveLength(20);
    expect(
      screen.queryByRole("navigation", { name: "Ready pagination" }),
    ).not.toBeInTheDocument();
  });

  it("paginates 21 fully sorted rows before rendering the second page", () => {
    render(<ReadinessSection {...props(pullItems(21))} />);

    expect(screen.getAllByText(/^Pull \d+$/)).toHaveLength(20);
    expect(screen.getByText("Pull 1")).toBeVisible();
    expect(screen.queryByText("Pull 21")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next ready page" }));
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByText("Pull 21")).toBeVisible();
    expect(screen.queryByText("Pull 1")).not.toBeInTheDocument();
  });

  it("paginates 41 rows independently across three pages", () => {
    render(<ReadinessSection {...props(pullItems(41))} />);

    const next = screen.getByRole("button", { name: "Next ready page" });
    fireEvent.click(next);
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByText("Pull 21")).toBeVisible();
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
    expect(screen.getByText("Pull 41")).toBeVisible();
    expect(screen.getAllByText(/^Pull \d+$/)).toHaveLength(1);
  });

  it("keeps ready, in progress, and not ready page state independent", () => {
    const items = pullItems(21);
    const view = render(
      <>
        <ReadinessSection {...props(items)} />
        <ReadinessSection
          {...props(items, { title: "In progress", variant: "progress" })}
        />
        <ReadinessSection
          {...props(items, { title: "Not ready", variant: "blocked" })}
        />
      </>,
    );
    const ready = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"]',
    )!;
    const progress = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"]',
    )!;
    const blocked = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="blocked"]',
    )!;

    fireEvent.click(
      within(ready).getByRole("button", { name: "Next ready page" }),
    );

    expect(within(ready).getByText("Page 2 of 2")).toBeVisible();
    expect(within(progress).getByText("Page 1 of 2")).toBeVisible();
    expect(within(blocked).getByText("Page 1 of 2")).toBeVisible();
  });

  it("keeps its page on a silent refresh and clamps after removal", async () => {
    const view = render(<ReadinessSection {...props(pullItems(41))} />);
    const next = screen.getByRole("button", { name: "Next ready page" });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();

    view.rerender(<ReadinessSection {...props(pullItems(41))} />);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
    expect(screen.getByText("Pull 41")).toBeVisible();

    view.rerender(<ReadinessSection {...props(pullItems(21))} />);
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByText("Pull 21")).toBeVisible();
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-readiness-section-body]"),
      ).toHaveAttribute("data-section-page", "2"),
    );

    view.rerender(<ReadinessSection {...props(pullItems(20))} />);
    expect(
      screen.queryByRole("navigation", { name: "Ready pagination" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-readiness-section-body]"),
      ).toHaveAttribute("data-section-page", "1"),
    );
  });

  it("returns to page one when a row is favourited so the reordered row stays visible", async () => {
    function FavoriteHarness() {
      const [items, setItems] = useState(() => pullItems(21));
      const setFavorite = (key: string, favorite: boolean): void => {
        setItems((current) => {
          const updated = current.map((item) =>
            item.identity === key ? { ...item, favorite } : item,
          );
          return [
            ...updated.filter((item) => item.favorite),
            ...updated.filter((item) => !item.favorite),
          ];
        });
      };

      return (
        <ReadinessSection
          {...props(items, { setFavorite })}
          visibleItemKeys={new Set(items.map((item) => item.key))}
        />
      );
    }

    render(<FavoriteHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Next ready page" }));
    expect(screen.getByText("Pull 21")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Favourite pull 21" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeVisible());
    expect(screen.getByText("Pull 21")).toBeVisible();
  });

  it("passes movement metadata without changing the current page", () => {
    const items = pullItems(21);
    const movement: PullMovement = {
      direction: "up",
      from: "blocked",
      label: "Moved up from Not ready to Ready",
      movedAt: 1_000,
      to: "ready",
    };
    const view = render(<ReadinessSection {...props(items)} />);
    fireEvent.click(screen.getByRole("button", { name: "Next ready page" }));
    expect(screen.getByText("Page 2 of 2")).toBeVisible();

    view.rerender(
      <ReadinessSection
        {...props(items, {
          movements: new Map([[items[0]!.identity!, movement]]),
        })}
      />,
    );

    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByText("Pull 21")).toBeVisible();
    expect(screen.queryByText(movement.label)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Previous ready page" }),
    );
    expect(screen.getByText(movement.label)).toBeVisible();
  });
});
