// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type MouseEvent, useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const motionSettings = vi.hoisted(() => ({ reduced: false }));

vi.mock("motion/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("motion/react")>();
  return {
    ...original,
    useReducedMotion: () => motionSettings.reduced,
  };
});

vi.mock("../api", () => ({
  getCheckLog: vi.fn(),
  getPullDiff: vi.fn(),
  mergePull: vi.fn(),
  parseGitHubActionsJobUrl: vi.fn(() => null),
  PullDiffHttpError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "PullDiffHttpError";
    }
  },
}));

import { getPullDiff, mergePull, PullDiffHttpError } from "../api";
import {
  EMPTY_VIEWED_FILES,
  EMPTY_VIEWED_FILES_BY_PULL,
  getPullDiffKey,
  type ToggleViewedFile,
  type ViewedFilesByPull,
} from "../diffs";
import { getPullKey, type PullSectionItem } from "../preferences";
import type { PullMovement } from "../movements";
import {
  IDLE_RUN_STATE,
  type PullRuns,
  type RunStartOutcome,
  type RunState,
} from "../runs";
import { createPendingPull, createPullsResponse } from "../test/fixtures";
import type { PullDiff, PullReadiness } from "../types";
import PullRow, { useDiffDisclosure } from "./PullRow";
import ReadinessSection from "./ReadinessSection";

type Controls = Pick<
  PullRuns,
  "cancel" | "observeRepair" | "setMessage" | "start"
>;

const getBlockedPull = (): PullReadiness => createPullsResponse().notReady[0]!;
const getReadyPull = (): PullReadiness => createPullsResponse().ready[0]!;
const VIEWER_LOGIN = "jake";
const ARTIFACT_EPOCH = 1;

const createRun = (change: Partial<RunState> = {}): RunState => ({
  ...IDLE_RUN_STATE,
  ...change,
});

const createControls = (): Controls => ({
  cancel: vi.fn(async (_key: string) => undefined),
  observeRepair: vi.fn(async () => undefined),
  setMessage: vi.fn((_key: string, _message: string) => undefined),
  start: vi.fn(
    async (_pull: PullReadiness): Promise<RunStartOutcome> => ({
      code: "auto_triggers_running",
      kind: "accepted-equivalent",
      message: "A matching automatic trigger run is already active.",
      source: "auto",
    }),
  ),
});

const createRuns = (
  states: ReadonlyMap<string, RunState>,
  controls: Controls,
): PullRuns => ({ ...controls, states });

const sectionViewing = {
  artifactEpoch: ARTIFACT_EPOCH,
  onToggleViewed: (() => undefined) as ToggleViewedFile,
  visibleItemKeys: new Set<string>(),
  viewerLogin: VIEWER_LOGIN,
  viewedFiles: EMPTY_VIEWED_FILES_BY_PULL,
};

type ControlledRowProps = {
  controls: Controls;
  favorite?: boolean;
  hidePull?: (key: string) => void;
  movement?: PullMovement | null;
  onMutationComplete?: () => void;
  pull: PullReadiness;
  run: RunState;
  setFavorite?: (key: string, favorite: boolean) => void;
  variant: "ready" | "progress" | "blocked";
  viewerLogin?: string | null;
};

function ControlledRow({
  controls,
  favorite,
  hidePull,
  movement,
  onMutationComplete,
  pull,
  run,
  setFavorite,
  variant,
  viewerLogin = VIEWER_LOGIN,
}: ControlledRowProps) {
  const [viewedFiles, setViewedFiles] = useState<ViewedFilesByPull>(
    () => EMPTY_VIEWED_FILES_BY_PULL,
  );
  const onToggleViewed = useCallback<ToggleViewedFile>(
    (current, path) => {
      if (viewerLogin === null) return;
      const key = getPullDiffKey(current, viewerLogin, ARTIFACT_EPOCH);

      setViewedFiles((existing) => {
        const files = new Set(existing.get(key) ?? EMPTY_VIEWED_FILES);
        if (files.has(path)) files.delete(path);
        else files.add(path);

        const next = new Map(existing);
        if (files.size === 0) next.delete(key);
        else next.set(key, files);
        return next;
      });
    },
    [viewerLogin],
  );

  return (
    <ul>
      <PullRow
        artifactEpoch={ARTIFACT_EPOCH}
        cancelRun={controls.cancel}
        favorite={favorite}
        hidePull={hidePull}
        movement={movement}
        onMutationComplete={onMutationComplete}
        onToggleViewed={onToggleViewed}
        pull={pull}
        run={run}
        setFavorite={setFavorite}
        setRunMessage={controls.setMessage}
        startRun={controls.start}
        variant={variant}
        viewerLogin={viewerLogin}
        viewedFiles={
          viewerLogin === null
            ? EMPTY_VIEWED_FILES
            : (viewedFiles.get(
                getPullDiffKey(pull, viewerLogin, ARTIFACT_EPOCH),
              ) ?? EMPTY_VIEWED_FILES)
        }
      />
    </ul>
  );
}

const row = (
  pull: PullReadiness,
  variant: "ready" | "progress" | "blocked",
  run: RunState,
  controls: Controls,
  onMutationComplete?: () => void,
) => (
  <ControlledRow
    controls={controls}
    onMutationComplete={onMutationComplete}
    pull={pull}
    run={run}
    variant={variant}
  />
);

const renderRow = (
  pull: PullReadiness,
  variant: "ready" | "progress" | "blocked",
  run = createRun(),
  controls = createControls(),
  onMutationComplete?: () => void,
) => ({
  controls,
  ...render(row(pull, variant, run, controls, onMutationComplete)),
});

const pullDiff = (pull: PullReadiness): PullDiff => ({
  baseRefOid: pull.baseRefOid,
  complete: true,
  files: [
    {
      additions: 1,
      binary: false,
      blobUrl: `https://github.com/${pull.repository}/blob/${pull.headRefOid}/src/ready.ts`,
      changes: 2,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1 +1 @@",
          lines: [
            { content: "before", kind: "deletion", newLine: null, oldLine: 1 },
            { content: "after", kind: "addition", newLine: 1, oldLine: null },
          ],
          newLines: 1,
          newStart: 1,
          oldLines: 1,
          oldStart: 1,
        },
      ],
      path: "src/ready.ts",
      previousPath: null,
      rawUrl: `https://github.com/${pull.repository}/raw/${pull.headRefOid}/src/ready.ts`,
      status: "modified",
      truncated: false,
    },
  ],
  headRefOid: pull.headRefOid,
  number: pull.number,
  repository: pull.repository,
  warning: null,
});

const pullItem = (pull: PullReadiness, favorite = false): PullSectionItem => ({
  favorite,
  identity: getPullKey(pull),
  key: `pull:${pull.url}`,
  kind: "pull",
  pull,
});

afterEach(() => {
  cleanup();
  motionSettings.reduced = false;
  vi.mocked(getPullDiff).mockReset();
  vi.mocked(mergePull).mockReset();
  vi.restoreAllMocks();
});

describe("PullRow ready presentation", () => {
  it("limits the context menu to the ready summary and keeps diff and merge controls outside", async () => {
    const pull = getReadyPull();
    const hidePull = vi.fn();
    const setFavorite = vi.fn();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const { container } = render(
      <ControlledRow
        controls={createControls()}
        favorite
        hidePull={hidePull}
        pull={pull}
        run={createRun()}
        setFavorite={setFavorite}
        variant="ready"
      />,
    );
    const trigger = container.querySelector<HTMLElement>(
      "[data-slot='pull-actions-trigger']",
    );
    const files = screen.getByRole("button", { name: "Files changed" });
    const merge = screen.getByRole("button", { name: "Merge" });
    const controls = container.querySelector<HTMLElement>(
      "[data-ready-controls]",
    );
    const actions = container.querySelector<HTMLElement>(
      "[data-ready-actions]",
    );

    expect(trigger).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(trigger).toContainElement(
      screen.getByRole("link", { name: /Open Greptile review/ }),
    );
    expect(trigger).not.toContainElement(files);
    expect(trigger).not.toContainElement(merge);
    expect(controls).toHaveClass(
      "sm:self-stretch",
      "sm:flex-col",
      "sm:items-end",
      "sm:justify-between",
    );
    expect(controls).toContainElement(screen.getByText("All checks passed"));
    expect(actions).toContainElement(files);
    expect(actions).toContainElement(merge);
    expect(
      container.querySelector("[data-ready-diff-content]"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Favourite pull request")).toBeInTheDocument();

    fireEvent.contextMenu(files);
    fireEvent.contextMenu(merge);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(files);
    const panel = await screen.findByRole("region", {
      name: `Files changed for ${pull.repository} pull request ${pull.number}`,
    });
    expect(
      container.querySelector("[data-ready-diff-content]"),
    ).toContainElement(panel);
    expect(trigger).not.toContainElement(panel);
    fireEvent.contextMenu(panel);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(trigger as HTMLElement);
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
  });

  it("uses a semantic whole-row Greptile link with independent controls", () => {
    const pull = getReadyPull();
    const { container } = renderRow(pull, "ready");
    const anchor = screen.getByRole("link", {
      name: new RegExp(`Open Greptile review.*${pull.title}`),
    });
    const item = anchor.closest("li");

    expect(item).not.toBeNull();
    expect(anchor).toHaveAttribute("href", pull.greptile.commentUrl);
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    expect(anchor).toBeEmptyDOMElement();
    expect(
      container.querySelector("[data-ready-summary]")?.querySelectorAll("svg"),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Files changed" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector('[data-status-icon="ready"]')).toHaveClass(
      "self-center",
      "text-emerald-600",
      "dark:text-emerald-400",
    );
    expect(screen.getByText(/Ready evidence:/).closest("p")).toHaveTextContent(
      "Ready evidence: 0 unresolved comments · Greptile 5/5 · CI passed",
    );
    expect(screen.getByText(/Updated/).closest("time")).toHaveAttribute(
      "dateTime",
      pull.updatedAt,
    );
  });

  it("keeps completed Fix output outside the ready review link", () => {
    const pull = getReadyPull();
    const run = createRun({
      message: "Finish the review.",
      output: "All review work is complete.",
      status: "completed",
    });
    renderRow(pull, "ready", run);
    const anchor = screen.getByRole("link", { name: /Open Greptile review/ });
    const terminal = screen.getByRole("log");

    expect(anchor).not.toContainElement(terminal);
    expect(terminal).toHaveTextContent("All review work is complete.");
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("loads the diff only on expansion and aborts an in-flight load on collapse", async () => {
    const pull = getReadyPull();
    let signal: AbortSignal | undefined;
    vi.mocked(getPullDiff).mockImplementation((_pull, receivedSignal) => {
      signal = receivedSignal;
      return new Promise(() => undefined);
    });
    renderRow(pull, "ready");

    expect(getPullDiff).not.toHaveBeenCalled();
    const disclosure = screen.getByRole("button", { name: "Files changed" });
    const anchor = screen.getByRole("link", { name: /Open Greptile review/ });
    const navigate = vi.fn();
    anchor.addEventListener("click", navigate);

    fireEvent.click(disclosure);
    expect(navigate).not.toHaveBeenCalled();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(getPullDiff).toHaveBeenCalledWith(
      {
        baseRefOid: pull.baseRefOid,
        headRefOid: pull.headRefOid,
        number: pull.number,
        repository: pull.repository,
        viewerLogin: VIEWER_LOGIN,
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading files changed",
    );

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(signal?.aborted).toBe(true);
  });

  it("renders a lazy diff and retries a failed request", async () => {
    const pull = getReadyPull();
    vi.mocked(getPullDiff)
      .mockRejectedValueOnce(
        new PullDiffHttpError(
          409,
          "stale_head",
          "The pull request changed. Refresh before opening its diff.",
        ),
      )
      .mockResolvedValueOnce(pullDiff(pull));
    renderRow(pull, "ready");

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The pull request changed. Refresh before opening its diff.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("src/ready.ts")).toHaveLength(2);
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("quietly collapses an incomplete diff and allows a manual reopen", async () => {
    const pull = getReadyPull();
    const message = "GitHub could not completely revalidate this pull request.";
    vi.mocked(getPullDiff)
      .mockRejectedValueOnce(
        new PullDiffHttpError(503, "pull_incomplete", message),
      )
      .mockResolvedValueOnce(pullDiff(pull));
    const { container } = renderRow(pull, "ready");
    const disclosure = screen.getByRole("button", { name: "Files changed" });

    fireEvent.click(disclosure);
    await waitFor(() =>
      expect(disclosure).toHaveAttribute("aria-expanded", "false"),
    );
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelector("[data-diff-panel]")).toBeNull();
    expect(getPullDiff).toHaveBeenCalledOnce();

    fireEvent.click(disclosure);
    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toBeInTheDocument();
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("keeps a message-only incomplete lookalike visible and retryable", async () => {
    const pull = getReadyPull();
    const message = "GitHub could not completely revalidate this pull request.";
    vi.mocked(getPullDiff)
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce(pullDiff(pull));
    renderRow(pull, "ready");

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toBeInTheDocument();
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("preserves viewed files when the same diff is collapsed and reopened", async () => {
    const pull = getReadyPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    renderRow(pull, "ready");

    const disclosure = screen.getByRole("button", { name: "Files changed" });
    fireEvent.click(disclosure);
    const viewed = await screen.findByRole("checkbox", {
      name: "Viewed src/ready.ts",
    });
    fireEvent.click(viewed);
    expect(screen.getByText("1 of 1 files viewed")).toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(
      screen.queryByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(
      await screen.findByRole("checkbox", { name: "Viewed src/ready.ts" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1 of 1 files viewed")).toBeInTheDocument();
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("releases the rendered diff on collapse and reopens through the API cache", async () => {
    const pull = getReadyPull();
    const event = {
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent<HTMLElement>;
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const disclosure = renderHook(() =>
      useDiffDisclosure(
        pull,
        VIEWER_LOGIN,
        ARTIFACT_EPOCH,
        EMPTY_VIEWED_FILES,
        vi.fn(),
      ),
    );

    act(() => disclosure.result.current.toggle(event));
    await waitFor(() =>
      expect(disclosure.result.current.state.status).toBe("success"),
    );
    act(() => disclosure.result.current.toggle(event));
    expect(disclosure.result.current.state.status).toBe("idle");

    act(() => disclosure.result.current.toggle(event));

    expect(disclosure.result.current.expanded).toBe(true);
    await waitFor(() =>
      expect(disclosure.result.current.state.status).toBe("success"),
    );
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["repository", { repository: "appwrite-labs/cloud" }],
    ["number", { number: 4242 }],
    ["base", { baseRefOid: "ffffffffffffffffffffffffffffffffffffffff" }],
    ["head", { headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
  ] as const)(
    "resets viewed files atomically when the pull %s changes",
    async (_field, change) => {
      const pull = getReadyPull();
      const changed = { ...pull, ...change };
      vi.mocked(getPullDiff)
        .mockResolvedValueOnce(pullDiff(pull))
        .mockResolvedValueOnce(pullDiff(changed));
      const view = renderRow(pull, "ready");

      fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Viewed src/ready.ts" }),
      );
      expect(screen.getByText("1 of 1 files viewed")).toBeInTheDocument();

      view.rerender(row(changed, "ready", createRun(), view.controls));

      expect(screen.queryByText("1 of 1 files viewed")).not.toBeInTheDocument();
      expect(
        await screen.findByRole("region", {
          name: `Files changed for ${changed.repository} pull request ${changed.number}`,
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("0 of 1 files viewed")).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "Viewed src/ready.ts" }),
      ).toHaveAttribute("aria-checked", "false");
    },
  );

  it("ignores an incomplete rejection from a previous pull identity", async () => {
    const pull = getReadyPull();
    const changed = {
      ...pull,
      headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      number: 4242,
    };
    let rejectOld!: (reason: unknown) => void;
    let resolveNew!: (diff: PullDiff) => void;
    const oldRequest = new Promise<PullDiff>((_resolve, reject) => {
      rejectOld = reject;
    });
    const newRequest = new Promise<PullDiff>((resolve) => {
      resolveNew = resolve;
    });
    vi.mocked(getPullDiff)
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(newRequest);
    const view = renderRow(pull, "ready");

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    await waitFor(() => expect(getPullDiff).toHaveBeenCalledOnce());

    view.rerender(row(changed, "ready", createRun(), view.controls));
    await waitFor(() => expect(getPullDiff).toHaveBeenCalledTimes(2));

    await act(async () => {
      rejectOld(
        new PullDiffHttpError(
          503,
          "pull_incomplete",
          "GitHub could not completely revalidate the old pull request.",
        ),
      );
      await Promise.resolve();
    });

    const disclosure = screen.getByRole("button", { name: "Files changed" });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading files changed",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => resolveNew(pullDiff(changed)));
    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${changed.repository} pull request ${changed.number}`,
      }),
    ).toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the centered status, summary, and controls above a full-width diff", async () => {
    const pull = getReadyPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const { container } = renderRow(pull, "ready");

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    await screen.findByRole("region", {
      name: `Files changed for ${pull.repository} pull request ${pull.number}`,
    });

    const summary = container.querySelector("[data-ready-summary]");
    const controls = container.querySelector("[data-ready-controls]");
    const panel = container.querySelector("[data-diff-panel]");
    const icon = container.querySelector('[data-status-icon="ready"]');
    const merge = screen.getByRole("button", { name: "Merge" });

    expect(summary).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(summary).toContainElement(icon as HTMLElement);
    expect(summary).not.toContainElement(controls as HTMLElement);
    expect(controls).toContainElement(
      screen.getByRole("button", { name: "Files changed" }),
    );
    expect(controls).toContainElement(merge);
    expect(summary).not.toContainElement(panel as HTMLElement);
    expect(
      merge.compareDocumentPosition(panel as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(controls).toHaveClass("flex-wrap");
    expect(controls).toHaveClass("relative", "z-20", "ml-auto", "justify-end");
    expect(panel).toHaveClass("w-full", "min-w-0");
    expect(icon).toHaveClass("self-center", "text-emerald-600");
  });

  it("requires explicit confirmation before admin merge and refreshes on success", async () => {
    const pull = getReadyPull();
    const onMutationComplete = vi.fn();
    vi.mocked(mergePull).mockResolvedValue({
      mergeCommitOid: "dddddddddddddddddddddddddddddddddddddddd",
      merged: true,
      number: pull.number,
      repository: pull.repository,
      url: pull.url,
    });
    renderRow(pull, "ready", createRun(), createControls(), onMutationComplete);
    const anchor = screen.getByRole("link", { name: /Open Greptile review/ });
    const navigate = vi.fn();
    anchor.addEventListener("click", navigate);

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(mergePull).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "Admin merge this pull request?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/server will re-check/)).toHaveTextContent(
      `${pull.repository} #${pull.number}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Admin merge" }));

    await waitFor(() => {
      expect(mergePull).toHaveBeenCalledWith(
        {
          expectedHeadRefOid: pull.headRefOid,
          number: pull.number,
          repository: pull.repository,
        },
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => expect(onMutationComplete).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Merged" })).toBeDisabled();
  });

  it("keeps a sanitized merge failure in the confirmation dialog", async () => {
    vi.mocked(mergePull).mockRejectedValue(
      new Error("  Head changed.\n\nRefresh before merging.  "),
    );
    renderRow(getReadyPull(), "ready");

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Admin merge" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Head changed. Refresh before merging.",
    );
    expect(screen.getByRole("button", { name: "Admin merge" })).toBeEnabled();
  });
});

describe("PullRow controlled Fix presentation", () => {
  it("runs the default fix with empty instructions and delegates controlled actions", () => {
    const pull = getBlockedPull();
    const controls = createControls();
    const view = renderRow(pull, "blocked", createRun(), controls);
    const input = screen.getByRole("textbox", {
      name: `Fix instructions for ${pull.repository} #${pull.number}`,
    });
    const start = screen.getByRole("button", { name: "Run fix" });

    expect(input).toHaveValue("");
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(input).toHaveAttribute(
      "placeholder",
      "Leave blank to fix every readiness blocker.",
    );
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(controls.start).toHaveBeenCalledWith(pull);

    fireEvent.change(input, { target: { value: "Resolve every blocker." } });
    expect(controls.setMessage).toHaveBeenCalledWith(
      pull.url,
      "Resolve every blocker.",
    );

    view.rerender(
      row(
        pull,
        "progress",
        createRun({ message: "Resolve every blocker.", status: "running" }),
        controls,
      ),
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run fix" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(controls.cancel).toHaveBeenCalledWith(pull.url);
  });

  it("keeps compact desktop controls and 44px mobile targets", () => {
    renderRow(getBlockedPull(), "blocked");
    const input = screen.getByRole("textbox");
    const start = screen.getByRole("button", { name: "Run fix" });

    expect(input).toHaveAttribute("rows", "1");
    expect(input).toHaveClass(
      "field-sizing-content",
      "min-h-11",
      "max-h-32",
      "resize-none",
      "overflow-y-auto",
      "sm:min-h-8",
    );
    expect(start).toHaveClass("min-h-11", "sm:min-h-8");
  });
});

describe("PullRow progress and blocker presentation", () => {
  it("keeps diff controls and content, details, fix input, and terminal output outside the action boundary", async () => {
    const pull = getBlockedPull();
    const hidePull = vi.fn();
    const setFavorite = vi.fn();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const { container } = render(
      <ControlledRow
        controls={createControls()}
        hidePull={hidePull}
        pull={pull}
        run={createRun({ output: "Finished fixing.", status: "completed" })}
        setFavorite={setFavorite}
        variant="blocked"
      />,
    );
    const trigger = container.querySelector<HTMLElement>(
      "[data-slot='pull-actions-trigger']",
    );
    const details = screen.getByRole("button", {
      name: "Show blocker details",
    });
    const input = screen.getByRole("textbox");
    const terminal = screen.getByRole("log");
    const files = screen.getByRole("button", { name: "Files changed" });

    expect(trigger).not.toBeNull();
    expect(trigger).not.toContainElement(details);
    expect(trigger).not.toContainElement(files);
    expect(trigger).not.toContainElement(input);
    expect(trigger).not.toContainElement(terminal);

    fireEvent.contextMenu(files);
    fireEvent.contextMenu(details);
    fireEvent.contextMenu(input);
    fireEvent.contextMenu(terminal);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(files);
    const panel = await screen.findByRole("region", {
      name: `Files changed for ${pull.repository} pull request ${pull.number}`,
    });
    expect(trigger).not.toContainElement(panel);
    fireEvent.contextMenu(panel);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(trigger as HTMLElement);
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["progress", createPendingPull()],
    ["blocked", getBlockedPull()],
  ] as const)(
    "lazily loads and collapses the diff for a %s pull request",
    async (variant, pull) => {
      vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
      renderRow(pull, variant);

      const disclosure = screen.getByRole("button", {
        name: "Files changed",
      });
      expect(disclosure).toBeEnabled();
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(getPullDiff).not.toHaveBeenCalled();

      fireEvent.click(disclosure);

      expect(getPullDiff).toHaveBeenCalledWith(
        {
          baseRefOid: pull.baseRefOid,
          headRefOid: pull.headRefOid,
          number: pull.number,
          repository: pull.repository,
          viewerLogin: VIEWER_LOGIN,
        },
        expect.any(AbortSignal),
      );
      expect(
        await screen.findByRole("region", {
          name: `Files changed for ${pull.repository} pull request ${pull.number}`,
        }),
      ).toBeInTheDocument();

      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByRole("region", {
          name: `Files changed for ${pull.repository} pull request ${pull.number}`,
        }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps non-ready titles linked without a redundant external-link icon", () => {
    const pull = createPendingPull();
    renderRow(pull, "progress");

    const title = screen.getByRole("link", { name: pull.title });
    expect(title).toHaveAttribute("href", pull.url);
    expect(title.querySelector("svg")).toBeNull();
  });

  it("shows a disabled diff control when the viewer identity is unavailable", () => {
    const pull = createPendingPull();
    render(
      <ControlledRow
        controls={createControls()}
        pull={pull}
        run={createRun()}
        variant="progress"
        viewerLogin={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Files changed" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Show blocker details" }),
    ).toBeDisabled();
    expect(getPullDiff).not.toHaveBeenCalled();
  });

  it("keeps an expanded diff and viewed state when the same row changes variant", async () => {
    const pull = getReadyPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const controls = createControls();
    const view = renderRow(pull, "progress", createRun(), controls);

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Viewed src/ready.ts" }),
    );

    view.rerender(row(pull, "blocked", createRun(), controls));

    expect(
      screen.getByRole("button", { name: "Files changed" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("checkbox", { name: "Viewed src/ready.ts" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1 of 1 files viewed")).toBeInTheDocument();
    expect(getPullDiff).toHaveBeenCalledOnce();
  });

  it("retries a blocked pull diff without disturbing blocker and fix controls", async () => {
    const pull = getBlockedPull();
    vi.mocked(getPullDiff)
      .mockRejectedValueOnce(new Error("Diff unavailable."))
      .mockResolvedValueOnce(pullDiff(pull));
    renderRow(pull, "blocked");

    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diff unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show blocker details" }),
    ).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Run fix" })).toBeEnabled();
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("shows a centered spinning yellow progress icon and passed/total CI counts", () => {
    const pull = createPendingPull();
    const { container } = renderRow(pull, "progress");

    const icon = container.querySelector('[data-status-icon="progress"]');
    expect(icon).toHaveClass(
      "lucide-loader-circle",
      "self-center",
      "text-amber-600",
      "motion-safe:animate-spin",
      "dark:text-amber-400",
    );
    expect(icon).toHaveAttribute("data-status-active", "false");
    expect(screen.getByText("CI running")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 checks passed")).toBeInTheDocument();
    const blockerList = screen.getByRole("list", { name: "Blockers" });
    expect(blockerList.querySelector("svg")).toHaveClass("text-amber-600");
    expect(
      container.querySelector(".text-destructive"),
    ).not.toBeInTheDocument();
  });

  it("shows both CI progress and an active Claude task", () => {
    const pull = createPendingPull();
    const { container } = renderRow(
      pull,
      "progress",
      createRun({
        message: "Finish the active run.",
        output: "Still working.",
        status: "running",
      }),
    );

    expect(screen.getAllByText("Claude running").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 of 2 checks passed/)).toHaveTextContent(
      "1 of 2 checks passed · Claude running",
    );
    expect(screen.getByRole("log")).toHaveTextContent("Still working.");
    expect(
      container.querySelector('[data-status-icon="progress"]'),
    ).toHaveClass(
      "lucide-loader-circle",
      "motion-safe:animate-spin",
      "text-amber-600",
    );
    expect(
      container.querySelector('[data-status-icon="progress"]'),
    ).toHaveAttribute("data-status-active", "true");
    expect(screen.getByText("Claude is active")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("labels an automatic run as Auto fix without changing manual terminology", () => {
    const pull = createPendingPull();
    renderRow(
      pull,
      "progress",
      createRun({
        output: "Addressing the automatic trigger.",
        source: "auto",
        status: "running",
      }),
    );

    expect(screen.getAllByText("Auto fix running").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("log", {
        name: `Auto fix output for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toHaveTextContent("Addressing the automatic trigger.");
    expect(screen.queryByText("Claude running")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude output")).not.toBeInTheDocument();
  });

  it("labels diff feedback runs as Review fix in the badge and terminal", () => {
    const pull = createPendingPull();
    renderRow(
      pull,
      "progress",
      createRun({
        output: "Addressing selected diff feedback.",
        source: "review",
        status: "running",
      }),
    );

    expect(screen.getAllByText("Review fix running").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("log", {
        name: `Review fix output for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toHaveTextContent("Addressing selected diff feedback.");
    expect(
      screen.getByText("Review fix", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("spins the primary progress icon for an active conflict repair", () => {
    const pull = createPendingPull();
    const { container } = renderRow(
      pull,
      "progress",
      createRun({
        kind: "repair",
        output: "Resolving conflicts.",
        repairState: "repair_running",
        status: "running",
      }),
    );

    expect(
      container.querySelector('[data-status-icon="progress"]'),
    ).toHaveClass("lucide-loader-circle", "motion-safe:animate-spin");
    expect(screen.getByText("Conflict repair is active")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it.each(["progress", "blocked"] as const)(
    "keeps the badge top-right and ordered row actions bottom-right for %s rows",
    (variant) => {
      const pull =
        variant === "progress" ? createPendingPull() : getBlockedPull();
      const { container } = renderRow(pull, variant);
      const controls = container.querySelector("[data-pull-controls]");
      const actions = container.querySelector("[data-pull-actions]");
      const header = container.querySelector("[data-pull-header]");
      const details = screen.getByRole("button", {
        name: "Show blocker details",
      });
      const files = screen.getByRole("button", { name: "Files changed" });
      const badge =
        variant === "progress"
          ? screen.getByText("CI running")
          : screen.getByText(`${pull.blockers.length} blockers`);

      expect(header).toHaveClass("sm:items-stretch");
      expect(controls).toHaveClass(
        "relative",
        "z-20",
        "ml-auto",
        "sm:self-stretch",
        "sm:flex-col",
        "sm:items-end",
        "sm:justify-between",
      );
      expect(controls).toContainElement(badge);
      expect(controls).toContainElement(actions as HTMLElement);
      expect(actions).toContainElement(details);
      expect(actions).toContainElement(files);
      expect(
        details.compareDocumentPosition(files) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        badge.compareDocumentPosition(actions as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        container.querySelector("[data-pull-summary]"),
      ).not.toContainElement(badge);
      expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    },
  );

  it("shows semantic movement direction without relying on animation", () => {
    const movement: PullMovement = {
      direction: "up",
      from: "blocked",
      label: "Moved up from Not ready to In progress",
      movedAt: Date.now(),
      to: "progress",
    };
    const view = render(
      <ControlledRow
        controls={createControls()}
        movement={movement}
        pull={createPendingPull()}
        run={createRun()}
        variant="progress"
      />,
    );
    const up = screen.getByRole("status", { name: movement.label });
    const progressIcon = view.container.querySelector(
      '[data-status-icon="progress"]',
    );
    const progressRail = view.container.querySelector("[data-status-rail]");

    expect(up).toHaveAttribute("data-movement-direction", "up");
    expect(up).toHaveAttribute("title", movement.label);
    expect(up).toHaveClass("text-emerald-600", "motion-safe:animate-in");
    expect(progressRail).toHaveClass(
      "flex-col",
      "items-center",
      "justify-center",
    );
    expect(progressRail).toContainElement(progressIcon as HTMLElement);
    expect(progressRail).toContainElement(up);
    expect(
      up.compareDocumentPosition(progressIcon as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    view.rerender(
      <ControlledRow
        controls={createControls()}
        movement={{
          direction: "down",
          from: "ready",
          label: "Moved down from Ready to Not ready",
          movedAt: Date.now(),
          to: "blocked",
        }}
        pull={getBlockedPull()}
        run={createRun()}
        variant="blocked"
      />,
    );
    const down = screen.getByRole("status", {
      name: "Moved down from Ready to Not ready",
    });
    const blockedRail = view.container.querySelector("[data-status-rail]");
    expect(down).toHaveClass("text-red-500/80");
    expect(blockedRail).toContainElement(
      view.container.querySelector('[data-status-icon="blocked"]'),
    );
    expect(blockedRail).toContainElement(down);
    expect(
      (
        view.container.querySelector('[data-status-icon="blocked"]') as Node
      ).compareDocumentPosition(down) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const readyMovement: PullMovement = {
      direction: "up",
      from: "progress",
      label: "Moved up from In progress to Ready",
      movedAt: Date.now(),
      to: "ready",
    };
    view.rerender(
      <ControlledRow
        controls={createControls()}
        movement={readyMovement}
        pull={getReadyPull()}
        run={createRun()}
        variant="ready"
      />,
    );
    const readyMovementIcon = screen.getByRole("status", {
      name: readyMovement.label,
    });
    const readyRail = view.container.querySelector("[data-status-rail]");
    expect(readyRail).toContainElement(
      view.container.querySelector('[data-status-icon="ready"]'),
    );
    expect(readyRail).toContainElement(readyMovementIcon);
    expect(
      readyMovementIcon.compareDocumentPosition(
        view.container.querySelector('[data-status-icon="ready"]') as Node,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("controls blocker details independently before the files disclosure", async () => {
    const pull = getBlockedPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    renderRow(pull, "blocked");
    const details = screen.getByRole("button", {
      name: "Show blocker details",
    });
    const files = screen.getByRole("button", { name: "Files changed" });

    expect(screen.getByRole("list", { name: "Blockers" })).toHaveTextContent(
      "CI checks failed",
    );
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(files).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Integration tests")).not.toBeInTheDocument();
    fireEvent.click(details);

    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(files).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Integration tests")).toBeInTheDocument();
    expect(
      screen.getByText("Please cover the retry path."),
    ).toBeInTheDocument();

    fireEvent.click(files);
    expect(
      await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toBeInTheDocument();
    expect(details).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(files).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Integration tests")).not.toBeInTheDocument();
  });

  it("renders without entrance movement when reduced motion is requested", () => {
    motionSettings.reduced = true;
    const { container } = renderRow(createPendingPull(), "progress");

    expect(container.querySelector("li")).toBeInTheDocument();
    expect(
      container.querySelector('[data-status-icon="progress"]'),
    ).toBeVisible();
  });
});

describe("ReadinessSection controlled reparenting", () => {
  it("preserves message and output when a row moves into progress", () => {
    const pull = getBlockedPull();
    const item = pullItem(pull);
    const visibleItemKeys = new Set([item.key]);
    const controls = createControls();
    const idle = createRuns(
      new Map([[pull.url, createRun({ message: "Keep this draft." })]]),
      controls,
    );
    const view = render(
      <>
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing blocked"
          items={[item]}
          runs={idle}
          title="Not ready"
          variant="blocked"
          visibleItemKeys={visibleItemKeys}
        />
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing running"
          items={[]}
          runs={idle}
          title="In progress"
          variant="progress"
          visibleItemKeys={visibleItemKeys}
        />
      </>,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft.");

    const running = createRuns(
      new Map([
        [
          pull.url,
          createRun({
            message: "Keep this draft.",
            output: "Streaming after reparent.",
            status: "running",
          }),
        ],
      ]),
      controls,
    );
    view.rerender(
      <>
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing blocked"
          items={[]}
          runs={running}
          title="Not ready"
          variant="blocked"
          visibleItemKeys={visibleItemKeys}
        />
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing running"
          items={[item]}
          runs={running}
          title="In progress"
          variant="progress"
          visibleItemKeys={visibleItemKeys}
        />
      </>,
    );

    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft.");
    expect(screen.getByRole("log")).toHaveTextContent(
      "Streaming after reparent.",
    );
    expect(controls.cancel).not.toHaveBeenCalled();
  });

  it("keeps the final row mounted long enough to animate out when it is removed", () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const view = render(
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing ready"
        items={[item]}
        runs={createRuns(new Map(), controls)}
        title="Ready"
        variant="ready"
        visibleItemKeys={new Set([item.key])}
      />,
    );

    view.rerender(
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing ready"
        items={[]}
        runs={createRuns(new Map(), controls)}
        title="Ready"
        variant="ready"
        visibleItemKeys={new Set()}
      />,
    );

    expect(
      screen.getByRole("list", { name: "Ready pull requests" }),
    ).toContainElement(screen.getByText(pull.title).closest("li"));
    expect(screen.queryByText("Nothing ready")).not.toBeInTheDocument();
  });

  it("keeps section list semantics with animated rows", () => {
    const pull = getReadyPull();
    const controls = createControls();
    render(
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing ready"
        items={[pullItem(pull)]}
        runs={createRuns(new Map(), controls)}
        title="Ready"
        variant="ready"
      />,
    );

    const list = screen.getByRole("list", { name: "Ready pull requests" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });
});
