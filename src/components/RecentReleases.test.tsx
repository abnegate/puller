// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RecentRelease,
  RecentReleasesResponse,
  ReleasePipeline,
  ReleasePipelineRun,
  ReleasePipelineRunState,
  ReleaseVerificationEvent,
  VerificationRunEvent,
  VerificationRunRequest,
} from "@/types";
import { RELEASE_FOCUS_REQUEST, type ReleaseFocusRequest } from "@/keyboard";
import RecentReleases, { groupReleasesByDate } from "./RecentReleases";

const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelBatch: vi.fn(),
  streamBatch: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@/api", () => ({
  cancelVerification: api.cancel,
  cancelReleaseVerification: api.cancelBatch,
  streamReleaseVerification: api.streamBatch,
  streamVerification: api.stream,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

const release = (
  id: string,
  source: RecentRelease["source"] = "comparison",
): RecentRelease => ({
  complete: source === "comparison",
  id,
  name: `Release ${id}`,
  pipeline: {
    checkedAt: "2026-07-21T08:00:00.000Z",
    lookup: "complete",
    runs: [],
  },
  publishedAt: "2026-07-21T07:00:00.000Z",
  pulls:
    source === "unavailable"
      ? []
      : [
          {
            headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            mergedAt: "2026-07-21T06:00:00.000Z",
            number: id === "one" ? 41 : 42,
            repository: "appwrite/cloud",
            title: `Released change ${id}`,
            url: `https://github.com/appwrite/cloud/pull/${id === "one" ? 41 : 42}`,
          },
        ],
  repository: "appwrite/cloud",
  repositoryUrl: "https://github.com/appwrite/cloud",
  source,
  tag: id === "one" ? "v1.2.3" : `v1.2.${id === "two" ? 4 : 5}`,
  url: `https://github.com/appwrite/cloud/releases/tag/${id}`,
  warning:
    source === "notes-fallback"
      ? "Adjacent tags could not be compared."
      : source === "unavailable"
        ? "Membership could not be verified."
        : null,
});

const withPipeline = (
  item: RecentRelease,
  pipeline: Partial<ReleasePipeline>,
): RecentRelease =>
  ({
    ...item,
    pipeline: {
      checkedAt: "2026-07-21T08:00:00.000Z",
      lookup: "complete",
      runs: [],
      ...pipeline,
    },
  }) satisfies RecentRelease;

const pipelineRun = (
  state: ReleasePipelineRunState,
  change: Partial<ReleasePipelineRun> = {},
): ReleasePipelineRun => ({
  attempt: 2,
  createdAt: "2026-07-21T07:20:00.000Z",
  id: "123",
  name: "Deploy Edge",
  path: ".github/workflows/deploy-edge.yml",
  startedAt: "2026-07-21T07:25:00.000Z",
  state,
  updatedAt: "2026-07-21T07:30:00.000Z",
  url: "https://github.com/appwrite/cloud/actions/runs/123",
  workflowId: "deploy-edge",
  ...change,
});

const response = (releases: RecentRelease[]): RecentReleasesResponse => ({
  generatedAt: "2026-07-21T08:00:00.000Z",
  partial: releases.some((item) => !item.complete),
  releases,
  warnings: [],
});

const releaseHistory = (count: number): RecentRelease[] =>
  Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const item = release(String(number));

    return {
      ...item,
      name: `Release ${number}`,
      pulls: item.pulls.map((pull) => ({
        ...pull,
        number,
        title: `Released change ${number}`,
        url: `https://github.com/appwrite/cloud/pull/${number}`,
      })),
      tag: `v1.2.${number}`,
      url: `https://github.com/appwrite/cloud/releases/tag/v1.2.${number}`,
    };
  });

const expandRelease = (tag: string): HTMLElement => {
  const toggle = screen.getByRole("button", {
    name: new RegExp(
      `^Show \\d+ pull requests? in ${tag.replaceAll(".", "\\.")}$`,
    ),
  });
  fireEvent.click(toggle);
  return toggle;
};

const requestReleaseFocus = (generation: number): void => {
  document.dispatchEvent(
    new CustomEvent<ReleaseFocusRequest>(RELEASE_FOCUS_REQUEST, {
      detail: { generation },
    }),
  );
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("RecentReleases", () => {
  it("groups local calendar dates in first-seen order without sorting releases", () => {
    const now = new Date(2026, 6, 21, 12, 0, 0);
    const todayOne = {
      ...release("one"),
      publishedAt: new Date(2026, 6, 21, 8, 0, 0).toISOString(),
    };
    const yesterday = {
      ...release("two"),
      publishedAt: new Date(2026, 6, 20, 19, 0, 0).toISOString(),
    };
    const todayTwo = {
      ...release("three"),
      publishedAt: new Date(2026, 6, 21, 7, 0, 0).toISOString(),
    };

    const groups = groupReleasesByDate([todayOne, yesterday, todayTwo], now);

    expect(groups.map((group) => group.date)).toEqual([
      "2026-07-21",
      "2026-07-20",
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.releases.map((item) => item.id)).toEqual([
      todayOne.id,
      todayTwo.id,
    ]);
  });

  it("starts each release collapsed with its actions right-aligned in card action order", () => {
    const item = release("one");
    const view = render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Show 1 pull request in v1.2.3",
    });
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
    const controls = toggle.getAttribute("aria-controls")!;
    const card = screen
      .getByRole("link", { name: /Release one/ })
      .closest("[data-slot='card']");
    const wrapper = card?.closest("[data-slot='collapsible']");
    const action = card?.querySelector<HTMLElement>(
      "[data-slot='card-action']",
    );
    const count = screen.getByLabelText("1 authored pull request");
    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });

    expect(wrapper).toHaveClass("min-w-0", "w-full");
    expect(card).toHaveClass("min-w-0", "w-full");
    expect(action).toHaveClass("justify-end");
    expect(action).toContainElement(count);
    expect(action).toContainElement(verifyAll);
    expect(action).toContainElement(toggle);
    expect(count.compareDocumentPosition(verifyAll)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(verifyAll.compareDocumentPosition(toggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release one" }),
    ).not.toBeInTheDocument();
    const closedContent = document.getElementById(controls);
    expect(closedContent).toHaveAttribute("aria-hidden", "true");
    expect(closedContent).toHaveAttribute("inert");
    expect(closedContent).toHaveClass(
      "data-[state=closed]:h-0",
      "data-[state=closed]:pointer-events-none",
    );
    expect(
      within(closedContent!).getByRole("list", { hidden: true }),
    ).toHaveAccessibleName("Pull requests in Release one");
    expect(toggle.querySelector("svg")).not.toHaveClass("rotate-180");
    expect(view.container.querySelector("[data-release-date]")).toBeVisible();

    fireEvent.click(toggle);

    const close = screen.getByRole("button", {
      name: "Hide 1 pull request in v1.2.3",
    });
    const content = document.getElementById(controls);
    expect(close).toHaveAttribute("aria-expanded", "true");
    expect(close).toHaveAttribute("aria-controls", controls);
    expect(content).toContainElement(
      screen.getByRole("list", { name: "Pull requests in Release one" }),
    );
    expect(content).not.toHaveAttribute("inert");
    expect(content).toHaveClass("release-pulls-content");
    expect(content).toHaveClass("min-w-0", "w-full");
    expect(
      screen.getByRole("list", { name: "Pull requests in Release one" }),
    ).toHaveClass("min-w-0", "w-full");
    expect(content).toHaveClass("motion-reduce:animate-none");
    expect(close.querySelector("svg")).toHaveClass(
      "rotate-180",
      "motion-reduce:transition-none",
    );

    fireEvent.click(close);

    const reopen = screen.getByRole("button", {
      name: "Show 1 pull request in v1.2.3",
    });
    expect(reopen).toHaveAttribute("aria-expanded", "false");
    expect(reopen).toHaveAttribute("aria-controls", controls);
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release one" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Release one/ })).toBeVisible();
    expect(screen.getByRole("link", { name: "appwrite/cloud" })).toBeVisible();
    expect(screen.getByText("v1.2.3")).toBeVisible();
    expect(count).toBeVisible();
    expect(verifyAll).toBeVisible();
    expect(
      view.container
        .querySelector("[data-slot='separator']")
        ?.closest("[data-slot='collapsible-content']"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(reopen.querySelector("svg")).not.toHaveClass("rotate-180");
  });

  it.each([
    ["running", "Deploying", "text-amber-700", true],
    ["queued", "Queued", "text-amber-700", false],
    ["failed", "Failed", "text-destructive", false],
    ["timed-out", "Timed out", "text-destructive", false],
    ["action-required", "Action required", "text-destructive", false],
    ["stale", "Stale", "text-muted-foreground", false],
    ["cancelled", "Cancelled", "text-muted-foreground", false],
    ["skipped", "Skipped", "text-muted-foreground", false],
    ["neutral", "Neutral", "text-muted-foreground", false],
    ["unknown", "Unknown", "text-muted-foreground", false],
  ] as const)(
    "renders the %s pipeline state textually without relying on color",
    (state, label, tone, spins) => {
      const item = withPipeline(release("one"), {
        runs: [pipelineRun(state)],
      });
      const view = render(
        <RecentReleases
          data={response([item])}
          error={null}
          loading={false}
          onRefresh={vi.fn()}
        />,
      );

      const link = view.container.querySelector<HTMLAnchorElement>(
        `[data-pipeline-state="${state}"]`,
      )!;
      const precise = new Date("2026-07-21T07:30:00.000Z").toLocaleString();
      expect(link).toHaveTextContent(`Deploy Edge${label}`);
      expect(link).toHaveClass(tone);
      expect(link).toHaveAttribute(
        "aria-label",
        `Deploy Edge: ${label}, attempt 2, updated ${precise}`,
      );
      expect(link).toHaveAttribute(
        "title",
        `Deploy Edge: ${label}, attempt 2, updated ${precise}`,
      );
      expect(link).toHaveAttribute(
        "href",
        "https://github.com/appwrite/cloud/actions/runs/123",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link.querySelector("svg")).toHaveClass(
        ...(spins
          ? ["animate-spin", "motion-reduce:animate-none"]
          : ["size-3"]),
      );
      if (state === "skipped" || state === "neutral") {
        expect(link).not.toHaveClass("text-destructive");
      }
      expect(link.closest("[aria-live='polite']")).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "Show 1 pull request in v1.2.3",
        }),
      ).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("renders a successful workflow as deployed with its humanized update time", () => {
    const item = withPipeline(release("one"), {
      runs: [pipelineRun("succeeded")],
    });
    const view = render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const link = view.container.querySelector<HTMLAnchorElement>(
      '[data-pipeline-state="succeeded"]',
    )!;
    expect(link).toHaveClass("text-emerald-700");
    expect(link).toHaveTextContent(/^Deploy EdgeDeployed /);
    expect(link).toHaveAccessibleName(
      /^Deploy Edge: Deployed .+, attempt 2, updated /,
    );
    expect(link.querySelector("svg")).not.toHaveClass("animate-spin");
  });

  it("labels a successful non-deployment release workflow as succeeded", () => {
    const item = withPipeline(release("one"), {
      runs: [
        pipelineRun("succeeded", {
          name: "Publish packages",
          path: ".github/workflows/publish.yml",
        }),
      ],
    });
    const view = render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      view.container.querySelector('[data-pipeline-state="succeeded"]'),
    ).toHaveTextContent(/^Publish packagesSucceeded /);
  });

  it("keeps empty pipeline lookup states quiet and omits a complete empty lookup", () => {
    const view = render(
      <RecentReleases
        data={response([withPipeline(release("one"), {})])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      view.container.querySelector("[data-release-pipeline]"),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector("[data-release-pipeline-empty]"),
    ).not.toBeInTheDocument();

    view.rerender(
      <RecentReleases
        data={response([withPipeline(release("one"), { lookup: "pending" })])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const pending = screen.getByText("Waiting for pipeline");
    expect(pending).toHaveClass("text-amber-700");
    expect(pending).toHaveAttribute("aria-live", "polite");

    view.rerender(
      <RecentReleases
        data={response([
          withPipeline(release("one"), { lookup: "unavailable" }),
        ])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const unavailable = screen.getByText("Pipeline status unavailable");
    expect(unavailable).toHaveClass("text-muted-foreground");
    expect(unavailable).toHaveAttribute("aria-live", "polite");
  });

  it("keeps distinct workflow links compact, stale-aware, and independent of release expansion", () => {
    const item = withPipeline(release("one"), {
      lookup: "unavailable",
      runs: [
        pipelineRun("succeeded"),
        pipelineRun("running", {
          attempt: 4,
          name: "Deploy Edge Database",
          path: ".github/workflows/deploy-edge-database.yml",
          url: "https://github.com/appwrite/cloud/actions/runs/456",
        }),
      ],
    });
    const view = render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "Show 1 pull request in v1.2.3",
    });
    const pipeline = view.container.querySelector<HTMLElement>(
      "[data-release-pipeline]",
    )!;
    const links = pipeline.querySelectorAll<HTMLAnchorElement>(
      ".release-pipeline-chip",
    );

    expect(pipeline).toHaveClass("min-w-0", "max-w-full", "flex-wrap");
    expect(pipeline.closest("[data-slot='card-header']")).toHaveClass("py-2.5");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("Deploy Edge");
    expect(links[1]).toHaveTextContent("Deploy Edge Database");
    expect(links[0]).toHaveClass(
      "release-pipeline-chip",
      "min-w-0",
      "max-w-full",
    );
    expect(links[1]?.querySelector("span.min-w-0")).toHaveClass("truncate");
    expect(screen.getByText("Status unavailable")).toHaveAttribute(
      "data-release-pipeline-stale",
    );

    fireEvent.click(links[0]!);
    fireEvent.click(links[1]!);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release one" }),
    ).not.toBeInTheDocument();
  });

  it("expands releases independently and preserves each state across reorder", () => {
    const first = release("one");
    const second = release("two");
    const view = render(
      <RecentReleases
        data={response([first, second])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.3",
      }),
    );

    expect(
      screen.getByRole("list", { name: "Pull requests in Release one" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release two" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Hide 1 pull request in v1.2.3",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.4",
      }),
    ).toBeInTheDocument();

    view.rerender(
      <RecentReleases
        data={response([{ ...second }, { ...first }])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const firstCard = screen
      .getByRole("link", { name: /Release one/ })
      .closest("[data-slot='card']") as HTMLElement;
    const secondCard = screen
      .getByRole("link", { name: /Release two/ })
      .closest("[data-slot='card']") as HTMLElement;
    expect(
      within(firstCard).getByRole("button", {
        name: "Hide 1 pull request in v1.2.3",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(secondCard).getByRole("button", {
        name: "Show 1 pull request in v1.2.4",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("does not paginate exactly 20 releases and exposes the desktop scroll structure", () => {
    const view = render(
      <RecentReleases
        data={response(releaseHistory(20))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const toggles = screen.getAllByRole("button", {
      name: /^Show 1 pull request in v1\.2\.\d+$/,
    });
    const panel = view.container.querySelector<HTMLElement>(
      "[data-recent-releases]",
    );
    const header = view.container.querySelector<HTMLElement>(
      "[data-release-header]",
    );
    const body = view.container.querySelector<HTMLElement>(
      "[data-release-scroll-body]",
    );
    const dateHeading = view.container.querySelector<HTMLElement>(
      "[data-release-date-heading]",
    );

    expect(toggles).toHaveLength(20);
    expect(
      screen.queryByRole("navigation", {
        name: "Recent releases pagination",
      }),
    ).not.toBeInTheDocument();
    expect(panel).toHaveClass("recent-releases");
    expect(header).toHaveClass("recent-releases-header");
    expect(body).toHaveClass("recent-releases-body", "lg:overflow-y-auto");
    expect(body).toHaveAttribute("data-release-page", "1");
    expect(header?.compareDocumentPosition(body!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(body).not.toContainElement(header);
    expect(dateHeading).toHaveClass("release-date-heading", "sticky");
    expect(dateHeading?.nextElementSibling).toHaveClass("pl-1");
  });

  it("paginates 21 releases after slicing and retains the date heading at the boundary", () => {
    const view = render(
      <RecentReleases
        data={response(releaseHistory(21))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getAllByRole("button", {
        name: /^Show 1 pull request in v1\.2\.\d+$/,
      }),
    ).toHaveLength(20);
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(screen.queryByText("Release 21")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next releases page" }));

    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByText("Release 21")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.21",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    const boundary = view.container.querySelector<HTMLElement>(
      '[data-release-date="2026-07-21"]',
    );
    expect(boundary).toBeVisible();
    expect(
      boundary?.querySelector("[data-release-date-heading]"),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.21",
      }),
    );
    expect(
      screen.getByRole("list", { name: "Pull requests in Release 21" }),
    ).toBeVisible();
  });

  it("paginates 41 releases across three top-level pages", () => {
    render(
      <RecentReleases
        data={response(releaseHistory(41))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const next = screen.getByRole("button", { name: "Next releases page" });
    expect(screen.getByText("Page 1 of 3")).toBeVisible();
    fireEvent.click(next);
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByText("Release 21")).toBeVisible();
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
    expect(screen.getByText("Release 41")).toBeVisible();
    expect(
      screen.getAllByRole("button", {
        name: /^Show 1 pull request in v1\.2\.\d+$/,
      }),
    ).toHaveLength(1);
    expect(next).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous releases page" }),
    ).toBeEnabled();
  });

  it("clamps the local page immediately after releases are removed", async () => {
    const view = render(
      <RecentReleases
        data={response(releaseHistory(41))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const next = screen.getByRole("button", { name: "Next releases page" });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();

    view.rerender(
      <RecentReleases
        data={response(releaseHistory(21))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByText("Release 21")).toBeVisible();
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-release-scroll-body]"),
      ).toHaveAttribute("data-release-page", "2"),
    );

    view.rerender(
      <RecentReleases
        data={response(releaseHistory(20))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("navigation", {
        name: "Recent releases pagination",
      }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-release-scroll-body]"),
      ).toHaveAttribute("data-release-page", "1"),
    );
  });

  it("keeps the current release page stable across a refresh", () => {
    const initial = releaseHistory(41);
    const view = render(
      <RecentReleases
        data={response(initial)}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next releases page" }));
    expect(screen.getByText("Page 2 of 3")).toBeVisible();

    view.rerender(
      <RecentReleases
        data={response(
          initial.map((item) => ({ ...item, name: `${item.name} refreshed` })),
        )}
        error={null}
        loading
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByText("Release 21 refreshed")).toBeVisible();

    const toggles = screen.getAllByRole("button", {
      name: /^Show 1 pull request in v1\.2\.\d+$/,
    });
    const controls = toggles.map((toggle) =>
      toggle.getAttribute("aria-controls"),
    );
    const ids = [...view.container.querySelectorAll<HTMLElement>("[id]")].map(
      (element) => element.id,
    );

    expect(toggles).toHaveLength(20);
    expect(new Set(controls).size).toBe(20);
    expect(controls.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    fireEvent.click(toggles[0]!);
    expect(document.getElementById(controls[0]!)).toBeInTheDocument();
  });

  it("preserves collapse state for the same release identity and resets it when identity changes", () => {
    const item = release("one");
    const view = render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.3",
      }),
    );

    view.rerender(
      <RecentReleases
        data={response([{ ...item, name: "Renamed release" }])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Hide 1 pull request in v1.2.3",
      }),
    ).toHaveAttribute("aria-expanded", "true");

    const retagged = { ...item, name: "Retagged release", tag: "v2.0.0" };
    view.rerender(
      <RecentReleases
        data={response([retagged])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Show 1 pull request in v2.0.0",
      }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 pull request in v2.0.0",
      }),
    );
    const moved = {
      ...retagged,
      name: "Moved release",
      pulls: retagged.pulls.map((pull) => ({
        ...pull,
        repository: "appwrite/edge",
        url: `https://github.com/appwrite/edge/pull/${pull.number}`,
      })),
      repository: "appwrite/edge",
      repositoryUrl: "https://github.com/appwrite/edge",
    };
    view.rerender(
      <RecentReleases
        data={response([moved])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Show 1 pull request in v2.0.0",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("focuses the first or last-active release disclosure and rejects stale focus requests", async () => {
    const view = render(
      <RecentReleases
        data={response(releaseHistory(3))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    act(() => requestReleaseFocus(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Show 1 pull request in v1.2.1",
        }),
      ),
    );

    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.2",
      }),
    );

    const refresh = screen.getByRole("button", {
      name: "Refresh recent releases",
    });
    refresh.focus();
    act(() => requestReleaseFocus(1));
    expect(document.activeElement).toBe(refresh);

    act(() => requestReleaseFocus(2));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Show 1 pull request in v1.2.2",
        }),
      ),
    );
    expect(view.container.querySelector("[data-release-page]")).toHaveAttribute(
      "data-release-page",
      "1",
    );
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])(
    "toggles a release disclosure with %s without starting verification",
    async (_label, key) => {
      render(
        <RecentReleases
          data={response([release("one")])}
          error={null}
          loading={false}
          onRefresh={vi.fn()}
        />,
      );

      act(() => requestReleaseFocus(1));
      const disclosure = await screen.findByRole("button", {
        name: "Show 1 pull request in v1.2.3",
      });
      expect(document.activeElement).toBe(disclosure);

      fireEvent.keyDown(disclosure, { key });
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(document.activeElement).toBe(disclosure);

      fireEvent.keyDown(disclosure, { key });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toBe(disclosure);
      expect(api.stream).not.toHaveBeenCalled();
      expect(api.streamBatch).not.toHaveBeenCalled();
    },
  );

  it("does not intercept release disclosure shortcuts from nested targets", () => {
    render(
      <RecentReleases
        data={response([release("one")])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const disclosure = screen.getByRole("button", {
      name: "Show 1 pull request in v1.2.3",
    });
    const icon = disclosure.querySelector("svg");
    expect(icon).not.toBeNull();

    fireEvent.keyDown(icon!, { key: "Enter" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("traverses release disclosures across pages and retains open state", async () => {
    render(
      <RecentReleases
        data={response(releaseHistory(21))}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    act(() => requestReleaseFocus(1));
    const first = await screen.findByRole("button", {
      name: "Show 1 pull request in v1.2.1",
    });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", {
        name: "Hide 1 pull request in v1.2.1",
      }),
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Show 1 pull request in v1.2.21",
        }),
      ),
    );
    expect(screen.getByText("Page 2 of 2")).toBeVisible();

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Hide 1 pull request in v1.2.1",
        }),
      ),
    );
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "Pull requests in Release 1" }),
    ).toBeVisible();
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("navigates released pull targets without activating nested actions", async () => {
    const first = release("one");
    const secondPull = {
      ...first.pulls[0]!,
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      number: 42,
      title: "Second released change",
      url: "https://github.com/appwrite/cloud/pull/42",
    };
    const firstWithTwo = { ...first, pulls: [first.pulls[0]!, secondPull] };
    const second = release("two");
    render(
      <RecentReleases
        data={response([firstWithTwo, second])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    act(() => requestReleaseFocus(1));
    const disclosure = await screen.findByRole("button", {
      name: "Show 2 pull requests in v1.2.3",
    });
    expect(disclosure).toHaveAttribute(
      "aria-keyshortcuts",
      "Enter Space ArrowRight ArrowLeft ArrowDown j k Home End",
    );
    fireEvent.keyDown(disclosure, { key: "Enter" });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(disclosure, { key: "ArrowDown" });

    const firstPull = document.querySelector<HTMLElement>(
      '[data-release-pull="0"]',
    )!;
    const secondPullRow = document.querySelector<HTMLElement>(
      '[data-release-pull="1"]',
    )!;
    expect(document.activeElement).toBe(firstPull);
    expect(firstPull).toHaveAccessibleName(
      "appwrite/cloud #41: Released change one",
    );
    expect(firstPull).toHaveAttribute("tabindex", "-1");
    expect(within(firstPull).getByRole("link")).not.toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(
      within(firstPull).getByRole("button", { name: "Verify" }),
    ).not.toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(firstPull, { key: "Enter" });
    expect(document.activeElement).toBe(firstPull);
    expect(api.stream).not.toHaveBeenCalled();

    fireEvent.keyDown(within(firstPull).getByRole("link"), {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(secondPullRow);
    fireEvent.keyDown(secondPullRow, { key: "ArrowUp" });
    expect(document.activeElement).toBe(firstPull);
    fireEvent.keyDown(firstPull, { key: "ArrowUp" });
    expect(document.activeElement).toBe(disclosure);

    fireEvent.keyDown(disclosure, { key: "ArrowDown" });
    fireEvent.keyDown(firstPull, { key: "ArrowDown" });
    fireEvent.keyDown(secondPullRow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.4",
      }),
    );

    disclosure.focus();
    fireEvent.keyDown(disclosure, { key: "ArrowDown" });
    expect(document.activeElement).toBe(firstPull);
    fireEvent.keyDown(firstPull, { key: "Escape" });
    expect(document.activeElement).toBe(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("preserves a focused release across refresh and falls forward then backward when removed", async () => {
    const first = releaseHistory(3);
    const view = render(
      <RecentReleases
        data={response(first)}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    act(() => requestReleaseFocus(1));
    await screen.findByRole("button", {
      name: "Show 1 pull request in v1.2.1",
    });
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(document.activeElement).toHaveAccessibleName(
      "Show 1 pull request in v1.2.2",
    );

    view.rerender(
      <RecentReleases
        data={response([
          first[2]!,
          { ...first[1]!, name: "Refreshed" },
          first[0]!,
        ])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(
        "Show 1 pull request in v1.2.2",
      ),
    );

    view.rerender(
      <RecentReleases
        data={response([first[2]!, first[0]!])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(
        "Show 1 pull request in v1.2.1",
      ),
    );

    view.rerender(
      <RecentReleases
        data={response([first[2]!])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(
        "Show 1 pull request in v1.2.3",
      ),
    );
  });

  it("keeps verification streaming while its pull list is collapsed", async () => {
    const item = release("one");
    let resume!: () => void;
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "run-hidden", type: "start" };
      yield { text: "First result.\n", type: "text" };
      await paused;
      yield { text: "Latest result.\n", type: "text" };
      yield { exitCode: 0, outcome: "verified", type: "complete" };
      finish();
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease("v1.2.3");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("log")).toHaveTextContent("First result.");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide 1 pull request in v1.2.3",
      }),
    );
    expect(screen.queryByRole("log")).not.toBeInTheDocument();

    await act(async () => {
      resume();
      await finished;
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 pull request in v1.2.3",
      }),
    );

    const log = await screen.findByRole("log");
    expect(log).toHaveTextContent("First result.");
    expect(log).toHaveTextContent("Latest result.");
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
  });

  it("keeps batch progress and cancellation visible while pull rows are collapsed", async () => {
    const item = { ...release("one"), id: "10" };
    api.cancelBatch.mockResolvedValue(undefined);
    api.streamBatch.mockImplementation(async function* (
      _request: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      const pull = item.pulls[0]!;
      yield {
        agent: "claude",
        batchId: "batch-hidden",
        pulls: [
          {
            agent: "claude",
            headSha: pull.headSha,
            pullNumber: pull.number,
            pullUrl: pull.url,
            releaseId: item.id,
            repository: item.repository,
            tag: item.tag,
          },
        ],
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      yield {
        batchId: "batch-hidden",
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "running",
        type: "verification",
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );
    await screen.findByText("Verifying release");

    expect(screen.getByText("Verifying release")).toBeVisible();
    expect(screen.getByText("0/1")).toBeVisible();
    expect(screen.getByText(/0\/1 settled/)).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Cancel verification of all pull requests in Release one",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release one" }),
    ).not.toBeInTheDocument();
  });

  it("keeps zero-pull release messaging visible without a collapse control", () => {
    const item = { ...release("one"), pulls: [] };
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No authored pull requests were found in this release."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: /^(?:Hide|Show) \d+ pull requests? in /,
      }),
    ).not.toBeInTheDocument();
  });

  it("verifies every pull in a release with one server batch request", async () => {
    const item = {
      ...release("one"),
      id: "123",
      pulls: [
        release("one").pulls[0]!,
        {
          ...release("one").pulls[0]!,
          headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          number: 43,
          title: "Another released change",
          url: "https://github.com/appwrite/cloud/pull/43",
        },
      ],
    };
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      const pulls = item.pulls.map((pull) => ({
        agent: "claude" as const,
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
      }));
      yield {
        agent: "claude",
        batchId: "batch-1",
        pulls,
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      for (const pull of pulls) {
        yield {
          batchId: "batch-1",
          headSha: pull.headSha,
          pullNumber: pull.pullNumber,
          pullUrl: pull.pullUrl,
          state: "complete",
          type: "verification",
          event: { exitCode: 0, outcome: "verified", type: "complete" },
        };
      }
      yield {
        batchId: "batch-1",
        totals: { complete: 2, error: 0, existing: 0, total: 2 },
        type: "complete",
      };
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Show 2 pull requests in v1.2.3",
      }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );

    await waitFor(() => expect(api.streamBatch).toHaveBeenCalledTimes(1));
    expect(api.streamBatch).toHaveBeenCalledWith(
      {
        agent: "claude",
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
      },
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(screen.getByText("Release verified")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "2/2 settled · 2 verified · 0 not verified · 0 unavailable · 0 failed",
      ),
    ).toBeInTheDocument();
    expect(api.stream).not.toHaveBeenCalled();
  });

  it("presents mixed batch outcomes and safe child errors without false completion", async () => {
    const base = { ...release("one"), id: "123" };
    const pulls = [
      base.pulls[0]!,
      ...(["b", "c", "d"] as const).map((character, index) => ({
        ...base.pulls[0]!,
        headSha: character.repeat(40),
        number: 42 + index,
        title: `Released change ${42 + index}`,
        url: `https://github.com/appwrite/cloud/pull/${42 + index}`,
      })),
    ];
    const item = { ...base, pulls };
    const identities = pulls.map((pull) => ({
      agent: "claude" as const,
      headSha: pull.headSha,
      pullNumber: pull.number,
      pullUrl: pull.url,
      releaseId: item.id,
      repository: item.repository,
      tag: item.tag,
    }));
    const message =
      "GitHub and local Git cannot prove the exact target pull request delta.";
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield {
        agent: "claude",
        batchId: "batch-mixed",
        pulls: identities,
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      for (const [index, pull] of identities.entries()) {
        yield {
          batchId: "batch-mixed",
          headSha: pull.headSha,
          pullNumber: pull.pullNumber,
          pullUrl: pull.pullUrl,
          state: "queued",
          type: "verification",
        };
        if (index === 0) {
          yield {
            batchId: "batch-mixed",
            code: "verification_delta_unavailable",
            headSha: pull.headSha,
            message,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "error",
            type: "verification",
          };
          continue;
        }
        if (index === 3) {
          yield {
            batchId: "batch-mixed",
            event: {
              text: "$ pnpm test\nConnection refused by the local service.\n",
              type: "text",
            },
            headSha: pull.headSha,
            message: "Executing the repository verification recipe.",
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "running",
            type: "verification",
          };
        }
        yield {
          batchId: "batch-mixed",
          event: {
            exitCode: 0,
            outcome:
              index === 1
                ? "verified"
                : index === 2
                  ? "not_verified"
                  : "unavailable",
            type: "complete",
          },
          headSha: pull.headSha,
          pullNumber: pull.pullNumber,
          pullUrl: pull.pullUrl,
          state: "complete",
          type: "verification",
        };
      }
      yield {
        batchId: "batch-mixed",
        totals: { complete: 3, error: 1, existing: 0, total: 4 },
        type: "complete",
      };
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );

    expect(
      await screen.findByText("Release verification finished with errors"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "4/4 settled · 1 verified · 1 not verified · 1 unavailable · 1 failed",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Release verification complete"),
    ).not.toBeInTheDocument();

    expandRelease(item.tag);
    const failed = screen.getByRole("log", {
      name: "Claude verification output for appwrite/cloud #41",
    });
    expect(failed).toHaveTextContent(message);
    expect(failed).not.toHaveTextContent("Waiting for output");
    const unavailable = screen.getByRole("log", {
      name: "Claude verification output for appwrite/cloud #44",
    });
    expect(unavailable).toHaveTextContent(
      "Executing the repository verification recipe.",
    );
    expect(unavailable).toHaveTextContent("$ pnpm test");
    expect(unavailable).toHaveTextContent(
      "Connection refused by the local service.",
    );
    expect(unavailable).not.toHaveTextContent("Waiting for output");
    expect(
      screen.getAllByRole("button", { name: "Verify again" }),
    ).toHaveLength(4);
    for (const retry of screen.getAllByRole("button", {
      name: "Verify again",
    })) {
      expect(retry).toBeEnabled();
    }
  });

  it("clears every stale row terminal as soon as Verify all again starts", async () => {
    const base = { ...release("one"), id: "123" };
    const secondPull = {
      ...base.pulls[0]!,
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      number: 42,
      title: "Second released change",
      url: "https://github.com/appwrite/cloud/pull/42",
    };
    const item = { ...base, pulls: [base.pulls[0]!, secondPull] };
    const pulls = item.pulls.map((pull) => ({
      agent: "claude" as const,
      headSha: pull.headSha,
      pullNumber: pull.number,
      pullUrl: pull.url,
      releaseId: item.id,
      repository: item.repository,
      tag: item.tag,
    }));
    let resumeRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      resumeRetry = resolve;
    });
    api.streamBatch
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        yield {
          agent: "claude",
          batchId: "old-batch",
          pulls,
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
          type: "batch-start",
        };
        for (const [index, pull] of pulls.entries()) {
          yield {
            batchId: "old-batch",
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "queued",
            type: "verification",
          };
          yield {
            batchId: "old-batch",
            event: {
              text: `Stale output for pull ${pull.pullNumber}.\n`,
              type: "text",
            },
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "running",
            type: "verification",
          };
          yield {
            batchId: "old-batch",
            event: {
              exitCode: index,
              outcome: index === 0 ? "verified" : "unavailable",
              type: "complete",
            },
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "complete",
            type: "verification",
          };
        }
        yield {
          batchId: "old-batch",
          totals: { complete: 2, error: 0, existing: 0, total: 2 },
          type: "complete",
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        await retryGate;
        yield {
          agent: "claude",
          batchId: "fresh-batch",
          pulls,
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
          type: "batch-start",
        };
        for (const pull of pulls) {
          yield {
            batchId: "fresh-batch",
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "queued",
            type: "verification",
          };
          yield {
            batchId: "fresh-batch",
            event: {
              text: `Fresh output for pull ${pull.pullNumber}.\n`,
              type: "text",
            },
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "running",
            type: "verification",
          };
          yield {
            batchId: "fresh-batch",
            event: {
              exitCode: 0,
              outcome: "verified",
              type: "complete",
            },
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            pullUrl: pull.pullUrl,
            state: "complete",
            type: "verification",
          };
        }
        yield {
          batchId: "fresh-batch",
          totals: { complete: 2, error: 0, existing: 0, total: 2 },
          type: "complete",
        };
      });

    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expandRelease(item.tag);
    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });
    fireEvent.click(verifyAll);
    await screen.findByText("Release verification finished");
    expect(
      screen.getByRole("log", {
        name: "Claude verification output for appwrite/cloud #41",
      }),
    ).toHaveTextContent("Stale output for pull 41.");
    expect(
      screen.getByRole("log", {
        name: "Claude verification output for appwrite/cloud #42",
      }),
    ).toHaveTextContent("Stale output for pull 42.");

    fireEvent.click(verifyAll);
    await waitFor(() => expect(api.streamBatch).toHaveBeenCalledTimes(2));

    for (const number of [41, 42]) {
      const terminal = screen.getByRole("log", {
        name: `Claude verification output for appwrite/cloud #${number}`,
      });
      expect(terminal).toHaveTextContent("Starting Claude verification");
      expect(terminal).not.toHaveTextContent("Stale output");
      expect(terminal).not.toHaveTextContent("Fresh output");
    }

    await act(async () => resumeRetry());
    await screen.findByText("Release verified");
    for (const number of [41, 42]) {
      const terminal = screen.getByRole("log", {
        name: `Claude verification output for appwrite/cloud #${number}`,
      });
      expect(terminal).toHaveTextContent(`Fresh output for pull ${number}.`);
      expect(terminal).not.toHaveTextContent("Stale output");
    }
  });

  it("shows a newer row verification after a completed Verify all batch", async () => {
    const item = { ...release("one"), id: "123" };
    api.cancel.mockResolvedValue(undefined);
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      const pull = item.pulls[0]!;
      yield {
        agent: "claude",
        batchId: "batch-then-row",
        pulls: [
          {
            agent: "claude",
            headSha: pull.headSha,
            pullNumber: pull.number,
            pullUrl: pull.url,
            releaseId: item.id,
            repository: item.repository,
            tag: item.tag,
          },
        ],
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      yield {
        batchId: "batch-then-row",
        event: { exitCode: 0, outcome: "verified", type: "complete" },
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "complete",
        type: "verification",
      };
      yield {
        batchId: "batch-then-row",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      };
    });
    let releaseRow: (() => void) | undefined;
    const rowGate = new Promise<void>((resolve) => {
      releaseRow = resolve;
    });
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "row-after-batch", type: "start" };
      yield { text: "Running the newer row verification.\n", type: "text" };
      await rowGate;
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });

    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );
    await screen.findByText("Release verified");
    expandRelease(item.tag);
    fireEvent.click(screen.getByRole("button", { name: "Verify again" }));

    expect(
      await screen.findByRole("button", { name: "Verifying…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("log", {
        name: "Claude verification output for appwrite/cloud #41",
      }),
    ).toHaveTextContent("Running the newer row verification.");
    expect(
      screen.getByRole("button", {
        name: "Cancel verification for appwrite/cloud #41",
      }),
    ).toBeEnabled();

    await act(async () => releaseRow?.());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Verify again" }),
      ).toBeEnabled(),
    );
  });

  it("keeps an active direct verification authoritative and blocks Verify all until it finishes", async () => {
    const item = { ...release("one"), id: "123" };
    api.cancel.mockResolvedValue(undefined);
    let finishDirect!: () => void;
    const directGate = new Promise<void>((resolve) => {
      finishDirect = resolve;
    });
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "direct-claude", type: "start" };
      yield { text: "Claude direct output.\n", type: "text" };
      await directGate;
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });
    api.streamBatch.mockImplementation(async function* (request: {
      agent: "claude" | "codex" | "grok";
      releaseId: string;
      repository: string;
      tag: string;
    }): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      const pull = item.pulls[0]!;
      yield {
        ...request,
        batchId: "codex-after-direct",
        pulls: [
          {
            ...request,
            headSha: pull.headSha,
            pullNumber: pull.number,
            pullUrl: pull.url,
          },
        ],
        type: "batch-start",
      };
      yield {
        batchId: "codex-after-direct",
        event: { exitCode: 0, outcome: "verified", type: "complete" },
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "complete",
        type: "verification",
      };
      yield {
        batchId: "codex-after-direct",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      };
    });
    const view = render(
      <RecentReleases
        agent="claude"
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expandRelease(item.tag);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByRole("log", {
        name: "Claude verification output for appwrite/cloud #41",
      }),
    ).toHaveTextContent("Claude direct output.");

    view.rerender(
      <RecentReleases
        agent="codex"
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });
    expect(verifyAll).toBeDisabled();
    fireEvent.click(verifyAll);
    expect(api.streamBatch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("log", {
        name: "Claude verification output for appwrite/cloud #41",
      }),
    ).toHaveTextContent("Claude direct output.");
    expect(
      screen.getByRole("button", {
        name: "Cancel verification for appwrite/cloud #41",
      }),
    ).toBeEnabled();

    await act(async () => finishDirect());
    await waitFor(() => expect(verifyAll).toBeEnabled());
    fireEvent.click(verifyAll);

    await waitFor(() => expect(api.streamBatch).toHaveBeenCalledTimes(1));
    expect(api.streamBatch).toHaveBeenCalledWith(
      {
        agent: "codex",
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
      },
      expect.any(AbortSignal),
    );
  });

  it("enables one guarded batch request for the real notes-fallback release shape", async () => {
    const item: RecentRelease = {
      ...release("one", "notes-fallback"),
      complete: false,
      id: "10",
      name: "v1.2.4",
      tag: "v1.2.4",
      url: "https://github.com/appwrite/cloud/releases/tag/v1.2.4",
      warning:
        "Release membership was discovered from release notes and will be rechecked before verification.",
    };
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      const pull = item.pulls[0]!;
      yield {
        agent: "claude",
        batchId: "batch-notes",
        pulls: [
          {
            agent: "claude",
            headSha: pull.headSha,
            pullNumber: pull.number,
            pullUrl: pull.url,
            releaseId: item.id,
            repository: item.repository,
            tag: item.tag,
          },
        ],
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      yield {
        batchId: "batch-notes",
        event: { exitCode: 0, outcome: "verified", type: "complete" },
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "complete",
        type: "verification",
      };
      yield {
        batchId: "batch-notes",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      };
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in v1.2.4",
    });
    expect(verifyAll).toBeEnabled();
    fireEvent.click(verifyAll);

    await waitFor(() => expect(api.streamBatch).toHaveBeenCalledTimes(1));
    expect(api.streamBatch).toHaveBeenCalledWith(
      {
        agent: "claude",
        releaseId: "10",
        repository: "appwrite/cloud",
        tag: "v1.2.4",
      },
      expect.any(AbortSignal),
    );
    expect(api.stream).not.toHaveBeenCalled();
    await screen.findByText("Release verified");
  });

  it("keeps active release controls on batch cancellation semantics", async () => {
    const item = { ...release("one"), id: "10" };
    api.cancelBatch.mockResolvedValue(undefined);
    api.streamBatch.mockImplementation(async function* (
      _request: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      const pull = item.pulls[0]!;
      yield {
        agent: "claude",
        batchId: "batch-controls",
        pulls: [
          {
            agent: "claude",
            headSha: pull.headSha,
            pullNumber: pull.number,
            pullUrl: pull.url,
            releaseId: item.id,
            repository: item.repository,
            tag: item.tag,
          },
        ],
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
        type: "batch-start",
      };
      yield {
        batchId: "batch-controls",
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "queued",
        type: "verification",
      };
      yield {
        batchId: "batch-controls",
        headSha: pull.headSha,
        pullNumber: pull.number,
        pullUrl: pull.url,
        state: "running",
        type: "verification",
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );
    const cancelAll = await screen.findByRole("button", {
      name: "Cancel verification of all pull requests in Release one",
    });
    expect(
      screen.queryByRole("button", {
        name: "Cancel verification for appwrite/cloud #41",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(cancelAll);

    await waitFor(() =>
      expect(api.cancelBatch).toHaveBeenCalledWith(
        "batch-controls",
        expect.any(AbortSignal),
      ),
    );
    expect(api.cancel).not.toHaveBeenCalled();
    await screen.findByText("Release verification cancelled");
    expandRelease("v1.2.3");
    expect(await screen.findByRole("log")).toHaveTextContent(
      "Release verification cancelled.",
    );
  });

  it("groups authored pulls by release and labels fallback and unavailable provenance honestly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    const releases = [
      release("one"),
      release("two", "notes-fallback"),
      release("three", "unavailable"),
    ];
    render(
      <RecentReleases
        data={response(releases)}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Recently released" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("3 recent releases")).toHaveTextContent("3");
    expect(
      screen.getByRole("button", { name: "Release notes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Adjacent tags could not be compared\./),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Membership could not be verified\./),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Authored pull request membership could not be verified for this release.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("5 hrs ago")).toHaveLength(3);
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release one" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Pull requests in Release two" }),
    ).not.toBeInTheDocument();
    expandRelease("v1.2.4");
    const fallbackVerify = within(
      screen.getByRole("list", { name: "Pull requests in Release two" }),
    ).getByRole("button", { name: "Verify" });
    expect(fallbackVerify).toBeEnabled();
  });

  it("hides authored-search completeness warnings without exposing a partial-history disclosure", () => {
    const item = {
      ...release("two", "notes-fallback"),
      warning: "Release detail warning should remain card metadata.",
    };
    const partial = {
      ...response([item]),
      partial: true,
      warnings: [
        "GitHub truncated the authored merged pull request search.",
        "GitHub truncated the authored merged pull request search.",
        "Some authored merged pull requests could not be loaded for release membership.",
      ],
    };

    render(
      <RecentReleases
        data={partial}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Partial history" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("History may be incomplete."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "GitHub truncated the authored merged pull request search.",
      ),
    ).not.toBeInTheDocument();

    expect(
      screen.queryByText(
        "GitHub truncated the authored merged pull request search.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Some authored merged pull requests could not be loaded for release membership.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Release detail warning should remain card metadata."),
    ).not.toBeInTheDocument();
  });

  it("keeps actionable partial-history warnings while filtering authored-search noise", () => {
    render(
      <RecentReleases
        data={{
          ...response([release("one")]),
          partial: true,
          warnings: [
            "GitHub truncated the authored merged pull request search.",
            "A repository release page could not be loaded.",
            "Some authored merged pull requests could not be loaded for release membership.",
          ],
        }}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const disclosure = screen.getByRole("button", { name: "Partial history" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);

    expect(screen.getByText("History may be incomplete.")).toBeInTheDocument();
    expect(
      screen.getByText("A repository release page could not be loaded."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "GitHub truncated the authored merged pull request search.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Some authored merged pull requests could not be loaded for release membership.",
      ),
    ).not.toBeInTheDocument();
  });

  it("still discloses a genuinely partial response with no warning text", () => {
    render(
      <RecentReleases
        data={{ ...response([release("one")]), partial: true, warnings: [] }}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const disclosure = screen.getByRole("button", { name: "Partial history" });
    fireEvent.click(disclosure);
    expect(screen.getByText("History may be incomplete.")).toBeInTheDocument();
  });

  it("explains compact provenance badges on keyboard focus", async () => {
    render(
      <RecentReleases
        data={response([release("two", "notes-fallback")])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const badge = screen.getByRole("button", { name: "Release notes" });
    badge.focus();

    expect(badge).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Pull requests were discovered from GitHub release notes",
    );
  });

  it("keeps a partial comparison release verifiable and labels it compactly", () => {
    const item = {
      ...release("one"),
      complete: false,
      id: "11",
      warning: "Only part of the comparison was available.",
    };
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Partial" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Only part of the comparison was available."),
    ).not.toBeInTheDocument();
  });

  it("starts verification immediately and streams the terminal in only that released row", async () => {
    const first = release("one");
    const second = release("two");
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: `run-${request.pullNumber}`, type: "start" };
      yield { text: `Verified pull ${request.pullNumber}.\n`, type: "text" };
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });
    render(
      <RecentReleases
        data={response([first, second])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease("v1.2.3");
    expandRelease("v1.2.4");
    const firstList = screen.getByRole("list", {
      name: "Pull requests in Release one",
    });
    fireEvent.click(within(firstList).getByRole("button", { name: "Verify" }));

    expect(api.stream).toHaveBeenCalledWith(
      {
        agent: "claude",
        headSha: first.pulls[0]!.headSha,
        pullNumber: first.pulls[0]!.number,
        pullUrl: first.pulls[0]!.url,
        releaseId: first.id,
        repository: first.repository,
        tag: first.tag,
      },
      expect.any(AbortSignal),
    );
    const log = await within(firstList).findByRole("log");
    expect(log).toHaveTextContent("Verified pull 41.");
    expect(log).toHaveAttribute("data-keyboard-scroll-region", "");
    log.focus();
    for (const key of ["Home", "End", "ArrowDown", "j"]) {
      expect(fireEvent.keyDown(log, { key })).toBe(true);
      expect(log).toHaveFocus();
    }
    expect(api.stream).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", {
        name: "Hide 1 pull request in v1.2.3",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(within(firstList).getAllByText("Verified").length).toBeGreaterThan(
        0,
      ),
    );
    const secondList = screen.getByRole("list", {
      name: "Pull requests in Release two",
    });
    expect(within(secondList).queryByRole("log")).not.toBeInTheDocument();
    expect(
      within(secondList).getByRole("button", { name: "Verify" }),
    ).toBeEnabled();
  });

  it("shows a safe direct preflight reason and leaves the row retryable", async () => {
    const item = release("one");
    const message =
      "GitHub and local Git cannot prove the exact target pull request delta.";
    api.stream.mockImplementation(async function* () {
      throw new Error(message);
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease(item.tag);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const terminal = await screen.findByRole("log", {
      name: "Claude verification output for appwrite/cloud #41",
    });
    expect(terminal).toHaveTextContent(message);
    expect(terminal).not.toHaveTextContent("Waiting for output");
    expect(screen.getByText("Failed")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Verify again" });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    await waitFor(() => expect(api.stream).toHaveBeenCalledTimes(2));
  });

  it("starts server-guarded verification for a pull discovered in release notes", async () => {
    const item = release("notes", "notes-fallback");
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "run-notes", type: "start" };
      yield { exitCode: 0, outcome: "unavailable", type: "complete" };
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease(item.tag);
    const verify = screen.getByRole("button", { name: "Verify" });
    expect(verify).toBeEnabled();
    fireEvent.click(verify);

    await waitFor(() =>
      expect(api.stream).toHaveBeenCalledWith(
        {
          agent: "claude",
          headSha: item.pulls[0]!.headSha,
          pullNumber: item.pulls[0]!.number,
          pullUrl: item.pulls[0]!.url,
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findAllByText("Unavailable")).not.toHaveLength(0);
    const terminal = screen.getByRole("log", {
      name: "Claude verification output for appwrite/cloud #42",
    });
    expect(terminal).toHaveTextContent(
      "Behavioral verification could not exercise this released change safely.",
    );
    expect(terminal).not.toHaveTextContent("Waiting for output");
  });

  it("does not start verification when release membership is unavailable and explains why", () => {
    const item = release("unavailable", "unavailable");
    item.pulls = [release("one").pulls[0]!];
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease(item.tag);
    const verify = screen.getByRole("button", { name: "Verify" });
    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release unavailable",
    });
    expect(verify).toBeDisabled();
    expect(verifyAll).toBeDisabled();
    expect(verifyAll).toHaveAccessibleDescription(
      "Verify all is unavailable because release membership could not be established.",
    );
    fireEvent.click(verify);
    fireEvent.click(verifyAll);
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("disables Verify all without authored pulls and exposes the exact reason", () => {
    const item = { ...release("one"), pulls: [] };
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });
    expect(verifyAll).toBeDisabled();
    expect(verifyAll).toHaveAccessibleDescription(
      "Verify all is unavailable because this release has no authored pull requests.",
    );
    fireEvent.click(verifyAll);
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("disables Verify all for an invalid release identity and explains why", () => {
    const item = { ...release("one"), id: "not-a-github-id" };
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    const verifyAll = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });
    expect(verifyAll).toBeDisabled();
    expect(verifyAll).toHaveAccessibleDescription(
      "Verify all is unavailable because this release has an invalid repository, tag, or pull request identity.",
    );
    fireEvent.click(verifyAll);
    expect(api.streamBatch).not.toHaveBeenCalled();
  });

  it("keeps a real batch error prominent and retryable", async () => {
    const item = { ...release("one"), id: "10" };
    api.streamBatch
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        throw new Error("Claude verification is unavailable");
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        yield {
          agent: "claude",
          batchId: "batch-retry",
          pulls: [],
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
          type: "batch-start",
        };
        yield {
          batchId: "batch-retry",
          totals: { complete: 0, error: 0, existing: 0, total: 0 },
          type: "complete",
        };
      });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Verify all pull requests in Release one",
      }),
    );

    expect(
      await screen.findByText("Release verification failed"),
    ).toBeInTheDocument();
    expect(screen.getByText("Claude verification is unavailable")).toHaveClass(
      "text-destructive",
    );
    const retry = screen.getByRole("button", {
      name: "Verify all pull requests in Release one",
    });
    expect(retry).toHaveTextContent("Verify all again");
    fireEvent.click(retry);

    await waitFor(() => expect(api.streamBatch).toHaveBeenCalledTimes(2));
  });

  it("keeps an empty or failed recent-release state independent and retryable", () => {
    const refresh = vi.fn();
    const view = render(
      <RecentReleases
        data={response([])}
        error={null}
        loading={false}
        onRefresh={refresh}
      />,
    );

    expect(
      screen.getByText(
        "No authored pull requests were found in recent releases.",
      ),
    ).toBeInTheDocument();

    view.rerender(
      <RecentReleases
        data={null}
        error="GitHub is unavailable"
        loading={false}
        onRefresh={refresh}
      />,
    );
    expect(
      screen.getByText(/Recent releases could not be loaded/),
    ).toHaveTextContent("GitHub is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers cancellation while a verification is active", async () => {
    const item = release("one");
    let streamSignal!: AbortSignal;
    api.cancel.mockResolvedValue(undefined);
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
      signal: AbortSignal,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      streamSignal = signal;
      yield { ...request, runId: "run-cancel", type: "start" };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    render(
      <RecentReleases
        data={response([item])}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expandRelease("v1.2.3");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    const cancel = await screen.findByRole("button", {
      name: "Cancel verification for appwrite/cloud #41",
    });
    fireEvent.click(cancel);

    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    expect(api.cancel).toHaveBeenCalledWith(
      "run-cancel",
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(streamSignal.aborted).toBe(true));
  });
});
