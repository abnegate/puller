// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  getPullCommitDiff: vi.fn(),
  getPullCommits: vi.fn(),
  PullCommitsHttpError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "PullCommitsHttpError";
    }
  },
}));

vi.mock("./PullDiff", () => ({
  default: ({
    diff,
    onKeyboardExit,
    onPersistenceChange,
    readOnly,
    toggleViewed,
    viewed,
  }: {
    diff: PullCommitDiff;
    onKeyboardExit?: () => void;
    onPersistenceChange?: (persistence: PullDiffPersistence) => void;
    readOnly?: boolean;
    toggleViewed: (path: string) => void;
    viewed: ReadonlySet<string>;
  }) => (
    <div
      aria-label={`Commit diff ${diff.commitSha}`}
      data-pull-diff=""
      data-read-only={readOnly ? "true" : "false"}
      role="region"
    >
      {diff.files.map((file) => file.path).join(", ")}
      <button
        data-tree-item=""
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onKeyboardExit?.();
        }}
        tabIndex={0}
        type="button"
      >
        Commit file
      </button>
      {!readOnly && <button type="button">Give feedback</button>}
      <button
        aria-pressed={viewed.has(diff.files[0]!.path)}
        onClick={() => toggleViewed(diff.files[0]!.path)}
        type="button"
      >
        Viewed {diff.files[0]!.path}
      </button>
      <button
        onClick={() =>
          onPersistenceChange?.({
            collapsedDirectories: [],
            draft: "",
            navigationScrollLeft: 0,
            navigationScrollTop: 0,
            navigationVisible: false,
            navigationWidth: 224,
            patchScrollLeft: {},
            selectedPath: diff.files[0]?.path ?? null,
            selection: null,
            visibleCount: diff.files.length,
          })
        }
        type="button"
      >
        Remember commit view
      </button>
    </div>
  ),
}));

import { getPullCommitDiff, getPullCommits } from "../api";
import { IDLE_RUN_STATE, type PullRuns } from "../runs";
import { createPullsResponse } from "../test/fixtures";
import type {
  PullCommit,
  PullCommitDiff,
  PullCommits as PullCommitsData,
  PullReadiness,
} from "../types";
import PullCommits, {
  normalizePullCommitsPersistence,
  type PullCommitsPersistence,
} from "./PullCommits";
import type { PullDiffPersistence } from "./PullDiff";

const viewerLogin = "jake";
const pull = createPullsResponse().ready[0]!;
const firstSha = "1111111111111111111111111111111111111111";
const secondSha = "2222222222222222222222222222222222222222";

const commit = (
  sha: string,
  message: string,
  authoredAt: string,
): PullCommit => ({
  authorLogin: "jake",
  authorName: "Jake Barnby",
  authoredAt,
  message,
  sha,
  url: `https://github.com/${pull.repository}/commit/${sha}`,
});

const first = commit(
  firstSha,
  "Create the commit viewer\n\nLong body",
  "2026-07-17T09:00:00.000Z",
);
const second = commit(
  secondSha,
  "Polish commit selection",
  "2026-07-17T10:00:00.000Z",
);

const commits = (change: Partial<PullCommitsData> = {}): PullCommitsData => ({
  baseRefOid: pull.baseRefOid,
  commits: [first, second],
  complete: true,
  count: 2,
  headRefOid: pull.headRefOid,
  number: pull.number,
  repository: pull.repository,
  warning: null,
  ...change,
});

const diff = (
  selected: PullCommit,
  path = `src/${selected.sha.slice(0, 7)}.ts`,
): PullCommitDiff => ({
  baseRefOid: pull.baseRefOid,
  commitSha: selected.sha,
  complete: true,
  files: [
    {
      additions: 1,
      binary: false,
      blobUrl: `https://github.com/${pull.repository}/blob/${selected.sha}/${path}`,
      changes: 1,
      deletions: 0,
      hunks: [],
      path,
      previousPath: null,
      rawUrl: `https://github.com/${pull.repository}/raw/${selected.sha}/${path}`,
      status: "modified",
      truncated: false,
    },
  ],
  headRefOid: pull.headRefOid,
  number: pull.number,
  repository: pull.repository,
  warning: null,
});

const startRun = vi.fn<PullRuns["start"]>(async () => ({
  code: "auto_triggers_running",
  kind: "accepted-equivalent",
  message: "A matching run is active.",
  source: "auto",
}));

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

type CommitsView = {
  onPersistenceChange?: (persistence: PullCommitsPersistence) => void;
  persistence?: PullCommitsPersistence;
  pull?: PullReadiness;
};

const commitsView = (change: CommitsView = {}) => (
  <div data-pull-identity="appwrite/cloud#101">
    <button data-pull-focus-token="commits" type="button">
      Commits
    </button>
    <PullCommits
      clearReviewRetry={vi.fn()}
      onPersistenceChange={change.onPersistenceChange}
      persistence={change.persistence}
      pull={change.pull ?? pull}
      run={IDLE_RUN_STATE}
      startRun={startRun}
      viewerLogin={viewerLogin}
    />
  </div>
);

const renderCommits = (change: CommitsView = {}) => render(commitsView(change));

beforeEach(() => {
  vi.mocked(getPullCommits).mockResolvedValue(commits());
  vi.mocked(getPullCommitDiff).mockImplementation(async (_pull, sha) =>
    diff(sha === firstSha ? first : second),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PullCommits", () => {
  it("loads commits, selects the latest commit, and renders only its read-only diff", async () => {
    renderCommits();

    expect(screen.getByRole("status")).toHaveTextContent("Loading commits");
    const region = await screen.findByRole("region", {
      name: `Commits for ${pull.repository} pull request ${pull.number}`,
    });
    expect(region).toHaveClass("w-full", "min-w-0");
    expect(region).not.toHaveClass("overflow-hidden");
    expect(region.querySelector(":scope > header")).toHaveClass("rounded-t-xl");
    const layout = region.querySelector<HTMLElement>("[data-commit-layout]")!;
    expect(layout).toHaveClass("grid", "min-w-0");
    expect(layout).toHaveAttribute("data-list-visible", "true");
    expect(layout).toHaveStyle({ "--commit-list-width": "240px" });
    expect(region.querySelector("[data-commit-list-pane]")).toHaveClass(
      "lg:sticky",
      "lg:max-h-[calc(100vh-3rem)]",
      "lg:overflow-auto",
    );
    const separator = screen.getByRole("separator", {
      name: "Resize commits pane",
    });
    const pane = separator.previousElementSibling as HTMLElement;
    const list = screen.getByRole("list", { name: "Pull request commits" });
    expect(pane).toHaveAttribute("data-commit-list-pane");
    expect(
      screen.queryByRole("button", { name: /^(Hide|Show) commits$/ }),
    ).not.toBeInTheDocument();
    expect(
      region.querySelector("[data-commit-list-mobile-toggle]"),
    ).not.toBeInTheDocument();
    expect(list).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    const selected = screen.getByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });
    expect(selected).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    expect(selected.parentElement).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    );
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Create the commit viewer")).toBeInTheDocument();
    expect(screen.queryByText("Long body")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(getPullCommitDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          baseRefOid: pull.baseRefOid,
          headRefOid: pull.headRefOid,
          number: pull.number,
          repository: pull.repository,
          viewerLogin,
        }),
        secondSha,
        expect.any(AbortSignal),
      ),
    );
    const commitDiff = await screen.findByRole("region", {
      name: `Commit diff ${secondSha}`,
    });
    expect(commitDiff).toHaveAttribute("data-read-only", "true");
    expect(commitDiff).toHaveTextContent("src/2222222.ts");
    expect(screen.queryByRole("button", { name: "Give feedback" })).toBeNull();
  });

  it("keeps long commit titles on one ellipsized line with the full title accessible", async () => {
    const title =
      "Keep every exceptionally long commit title constrained inside the narrow commit rail without stretching the diff";
    vi.mocked(getPullCommits).mockResolvedValue(
      commits({
        commits: [{ ...second, message: `${title}\n\nHidden body` }],
        count: 1,
      }),
    );
    renderCommits();

    const button = await screen.findByRole("button", {
      name: `${title}, commit 2222222`,
    });
    const label = screen.getByTitle(title);
    expect(label).toHaveTextContent(title);
    expect(label).toHaveClass("max-w-full", "truncate");
    expect(label.parentElement).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    );
    expect(button).toHaveAttribute("aria-label", `${title}, commit 2222222`);
    expect(screen.queryByText("Hidden body")).not.toBeInTheDocument();
  });

  it("keeps the list visible and focus on the selected commit", async () => {
    renderCommits();
    await screen.findByRole("region", { name: `Commit diff ${secondSha}` });

    const current = screen.getByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });
    current.focus();
    fireEvent.click(current);

    expect(current).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Show commits" })).toBeNull();
    expect(
      screen.getByRole("list", { name: "Pull request commits" }),
    ).toBeVisible();
    expect(document.querySelector("[data-commit-selection-status]")).toBeNull();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();

    const firstCommit = screen.getByRole("button", {
      name: /Create the commit viewer, commit 1111111/,
    });
    firstCommit.focus();
    fireEvent.click(firstCommit);

    expect(firstCommit).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Show commits" })).toBeNull();
    expect(
      screen.getByRole("list", { name: "Pull request commits" }),
    ).toBeVisible();
    expect(document.querySelector("[data-commit-selection-status]")).toBeNull();
    expect(
      await screen.findByRole("region", { name: `Commit diff ${firstSha}` }),
    ).toBeInTheDocument();
    expect(getPullCommitDiff).toHaveBeenCalledTimes(2);
  });

  it("moves a separate roving commit cursor without loading diffs until activation", async () => {
    renderCommits();
    await screen.findByRole("region", { name: `Commit diff ${secondSha}` });
    vi.mocked(getPullCommitDiff).mockClear();
    const latest = screen.getByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });
    const firstCommit = screen.getByRole("button", {
      name: /Create the commit viewer, commit 1111111/,
    });

    latest.focus();
    fireEvent.keyDown(latest, { key: "ArrowDown" });
    expect(firstCommit).toHaveFocus();
    expect(firstCommit).toHaveAttribute("tabindex", "0");
    expect(firstCommit).not.toHaveAttribute("aria-current");
    expect(latest).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(firstCommit, { key: "Home" });
    expect(latest).toHaveFocus();
    fireEvent.keyDown(latest, { key: "End" });
    expect(firstCommit).toHaveFocus();
    expect(getPullCommitDiff).not.toHaveBeenCalled();

    fireEvent.keyDown(firstCommit, { key: "Enter" });
    expect(
      await screen.findByRole("region", { name: `Commit diff ${firstSha}` }),
    ).toBeInTheDocument();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();

    latest.focus();
    fireEvent.keyDown(latest, { key: " " });
    expect(
      await screen.findByRole("region", { name: `Commit diff ${secondSha}` }),
    ).toBeInTheDocument();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
  });

  it("enters a loaded commit tree and returns through commit and disclosure focus levels", async () => {
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    renderCommits();
    const commitDiff = await screen.findByRole("region", {
      name: `Commit diff ${secondSha}`,
    });
    const selected = screen.getByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });

    selected.focus();
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    const treeItem = commitDiff.querySelector<HTMLElement>("[data-tree-item]")!;
    expect(treeItem).toHaveFocus();
    fireEvent.keyDown(treeItem, { key: "Escape" });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Commits" })).toHaveFocus();
    expect(leaked).not.toHaveBeenCalled();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", leaked);
  });

  it("waits for an already-running selected diff before entering it without another request", async () => {
    const pending = deferred<PullCommitDiff>();
    vi.mocked(getPullCommitDiff).mockReturnValueOnce(pending.promise);
    renderCommits();
    const selected = await screen.findByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });

    selected.focus();
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(diff(second));
      await pending.promise;
    });

    expect(
      (
        await screen.findByRole("region", {
          name: `Commit diff ${secondSha}`,
        })
      ).querySelector("[data-tree-item]"),
    ).toHaveFocus();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
  });

  it("keeps commit focus safe when pending keyboard entry fails", async () => {
    const pending = deferred<PullCommitDiff>();
    vi.mocked(getPullCommitDiff).mockReturnValueOnce(pending.promise);
    renderCommits();
    const selected = await screen.findByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });

    selected.focus();
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    await act(async () => {
      pending.reject(new Error("Commit patch unavailable."));
      await pending.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Commit patch unavailable.",
    );
    expect(selected).toHaveFocus();
    expect(screen.getByRole("button", { name: "Retry" })).not.toHaveFocus();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
  });

  it("does not let a stale pending diff enter the refreshed pull identity", async () => {
    const nextHead = "dddddddddddddddddddddddddddddddddddddddd";
    const nextPull = { ...pull, headRefOid: nextHead };
    const oldDiff = deferred<PullCommitDiff>();
    const nextDiff = deferred<PullCommitDiff>();
    vi.mocked(getPullCommits)
      .mockResolvedValueOnce(commits())
      .mockResolvedValueOnce(commits({ headRefOid: nextHead }));
    vi.mocked(getPullCommitDiff)
      .mockReturnValueOnce(oldDiff.promise)
      .mockReturnValueOnce(nextDiff.promise);
    const view = renderCommits();
    const oldSelected = await screen.findByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });
    oldSelected.focus();
    fireEvent.keyDown(oldSelected, { key: "ArrowRight" });

    view.rerender(commitsView({ pull: nextPull }));
    const nextSelected = await screen.findByRole("button", {
      name: /Polish commit selection, commit 2222222/,
    });
    nextSelected.focus();
    await waitFor(() => expect(getPullCommitDiff).toHaveBeenCalledTimes(2));
    await act(async () => {
      oldDiff.resolve(diff(second, "src/stale.ts"));
      await oldDiff.promise;
    });
    expect(screen.queryByText("src/stale.ts")).not.toBeInTheDocument();
    expect(nextSelected).toHaveFocus();

    await act(async () => {
      nextDiff.resolve({
        ...diff(second, "src/current.ts"),
        headRefOid: nextHead,
      });
      await nextDiff.promise;
    });
    expect(
      await screen.findByRole("region", { name: `Commit diff ${secondSha}` }),
    ).toHaveTextContent("src/current.ts");
  });

  it("keeps the commit rail visible without visibility controls", async () => {
    renderCommits({
      persistence: {
        diffs: {},
        listVisible: false,
        listWidth: 240,
        selectedSha: secondSha,
        viewed: {},
      },
    });
    const commitDiff = await screen.findByRole("region", {
      name: `Commit diff ${secondSha}`,
    });
    const separator = screen.getByRole("separator", {
      name: "Resize commits pane",
    });
    expect(
      screen.getByRole("list", { name: "Pull request commits" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^(Hide|Show) commits$/ }),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector("[data-commit-list-mobile-toggle]"),
    ).toBeNull();
    expect(document.querySelector("[data-commit-layout]")).toHaveAttribute(
      "data-list-visible",
      "true",
    );

    separator.focus();
    fireEvent.keyDown(separator, { key: "Enter" });
    fireEvent.keyDown(separator, { key: " " });
    expect(
      screen.getByRole("region", { name: `Commit diff ${secondSha}` }),
    ).toBe(commitDiff);
    expect(
      screen.getByRole("list", { name: "Pull request commits" }),
    ).toBeVisible();
    expect(separator).toHaveFocus();
    expect(getPullCommits).toHaveBeenCalledOnce();
    expect(getPullCommitDiff).toHaveBeenCalledOnce();
  });

  it("normalizes legacy visibility and width without recreating persisted maps", () => {
    const diffs = {};
    const viewed = {};
    const legacy = {
      diffs,
      selectedSha: secondSha,
      viewed,
    } as unknown as PullCommitsPersistence;

    const normalized = normalizePullCommitsPersistence(legacy);
    expect(normalized).toEqual({
      diffs,
      listVisible: true,
      listWidth: 240,
      selectedSha: secondSha,
      viewed,
    });
    expect(normalized.diffs).toBe(diffs);
    expect(normalized.viewed).toBe(viewed);

    expect(
      normalizePullCommitsPersistence({
        ...normalized,
        listWidth: Number.POSITIVE_INFINITY,
      }).listWidth,
    ).toBe(240);
    expect(
      normalizePullCommitsPersistence({ ...normalized, listWidth: 80 })
        .listWidth,
    ).toBe(176);
    expect(
      normalizePullCommitsPersistence({ ...normalized, listWidth: 900 })
        .listWidth,
    ).toBe(420);

    const current = { ...normalized, listVisible: false, listWidth: 280 };
    const reopened = normalizePullCommitsPersistence(current);
    expect(reopened).toEqual({ ...current, listVisible: true });
    expect(reopened.diffs).toBe(diffs);
    expect(reopened.viewed).toBe(viewed);
  });

  it("persists pointer and keyboard resizing and clamps to the layout", async () => {
    let layoutWidth = 700;
    const rectangle = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: layoutWidth,
          toJSON: () => ({}),
          top: 0,
          width: this.hasAttribute("data-commit-layout") ? layoutWidth : 0,
          x: 0,
          y: 0,
        };
      });
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    const onPersistenceChange = vi.fn();
    renderCommits({ onPersistenceChange });
    await screen.findByRole("region", { name: `Commit diff ${secondSha}` });

    const separator = screen.getByRole("separator", {
      name: "Resize commits pane",
    });
    const capture = vi.fn();
    const release = vi.fn();
    Object.defineProperties(separator, {
      releasePointerCapture: { configurable: true, value: release },
      setPointerCapture: { configurable: true, value: capture },
    });

    fireEvent.pointerDown(separator, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 180, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 180, pointerId: 7 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledWith(7);
    expect(separator).toHaveAttribute("aria-valuenow", "320");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "304");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "380");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "176");
    const calls = onPersistenceChange.mock.calls.length;
    fireEvent.keyDown(separator, { key: "Home" });
    expect(onPersistenceChange).toHaveBeenCalledTimes(calls);

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "380");
    expect(resize).toBeTypeOf("function");
    layoutWidth = 500;
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "180");
    layoutWidth = 450;
    act(() => resize?.([], {} as ResizeObserver));
    expect(separator).toHaveAttribute("aria-valuenow", "176");
    expect(onPersistenceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ listWidth: 176 }),
    );
    rectangle.mockRestore();
  });

  it("preserves the preferred desktop commit width while the split layout is inactive", async () => {
    let splitLayout = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(
        (query: string): MediaQueryList =>
          ({
            addEventListener: vi.fn(),
            addListener: vi.fn(),
            dispatchEvent: vi.fn(),
            matches: query === "(min-width: 64rem)" && splitLayout,
            media: query,
            onchange: null,
            removeEventListener: vi.fn(),
            removeListener: vi.fn(),
          }) as MediaQueryList,
      ),
    );
    let layoutWidth = 420;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: layoutWidth,
          toJSON: () => ({}),
          top: 0,
          width: this.hasAttribute("data-commit-layout") ? layoutWidth : 0,
          x: 0,
          y: 0,
        };
      },
    );
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    const onPersistenceChange = vi.fn();
    renderCommits({
      onPersistenceChange,
      persistence: {
        diffs: {},
        listVisible: true,
        listWidth: 360,
        selectedSha: secondSha,
        viewed: {},
      },
    });
    await screen.findByRole("region", { name: `Commit diff ${secondSha}` });
    onPersistenceChange.mockClear();

    const separator = screen.getByRole("separator", {
      name: "Resize commits pane",
    });
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    act(() => resize?.([], {} as ResizeObserver));
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(onPersistenceChange).not.toHaveBeenCalled();

    splitLayout = true;
    layoutWidth = 900;
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(onPersistenceChange).not.toHaveBeenCalled();
  });

  it("loads only the selected commit's files and preserves compact diff persistence", async () => {
    const onPersistenceChange = vi.fn();
    renderCommits({ onPersistenceChange });
    await screen.findByRole("region", { name: `Commit diff ${secondSha}` });

    fireEvent.click(
      screen.getByRole("button", {
        name: /Create the commit viewer, commit 1111111/,
      }),
    );

    const firstDiff = await screen.findByRole("region", {
      name: `Commit diff ${firstSha}`,
    });
    expect(firstDiff).toHaveTextContent("src/1111111.ts");
    expect(firstDiff).not.toHaveTextContent("src/2222222.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "Remember commit view" }),
    );

    const persisted = onPersistenceChange.mock.calls.at(-1)?.[0] as
      | PullCommitsPersistence
      | undefined;
    expect(persisted).toMatchObject({
      diffs: {
        [firstSha]: {
          navigationVisible: false,
          selectedPath: "src/1111111.ts",
        },
      },
      listVisible: true,
      listWidth: 240,
      selectedSha: firstSha,
      viewed: {},
    });
    expect(persisted).not.toHaveProperty("commits");
    expect(persisted).not.toHaveProperty("diff");

    fireEvent.click(
      screen.getByRole("button", { name: "Viewed src/1111111.ts" }),
    );
    const viewed = onPersistenceChange.mock.calls.at(-1)?.[0] as
      | PullCommitsPersistence
      | undefined;
    expect(viewed?.viewed).toEqual({
      [firstSha]: ["src/1111111.ts"],
    });
  });

  it("shows honest incomplete history without implying omitted commits are absent", async () => {
    vi.mocked(getPullCommits).mockResolvedValue(
      commits({
        complete: false,
        count: 300,
        warning: "GitHub returned the first 250 of 300 commits.",
      }),
    );
    renderCommits();

    expect(
      await screen.findByText("GitHub returned the first 250 of 300 commits."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 shown")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("retries commit-list and selected-diff failures independently", async () => {
    vi.mocked(getPullCommits)
      .mockRejectedValueOnce(new Error("Commit list unavailable."))
      .mockResolvedValueOnce(commits());
    vi.mocked(getPullCommitDiff)
      .mockRejectedValueOnce(new Error("Commit patch unavailable."))
      .mockResolvedValueOnce(diff(second));
    renderCommits();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Commit list unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Commit patch unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("region", { name: `Commit diff ${secondSha}` }),
    ).toBeInTheDocument();
    expect(getPullCommits).toHaveBeenCalledTimes(2);
    expect(getPullCommitDiff).toHaveBeenCalledTimes(2);
  });
});
