// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render as renderBase,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setAgentPreference } from "../agent";

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
  getPullCommitDiff: vi.fn(),
  getPullCommits: vi.fn(),
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

import {
  getPullCommitDiff,
  getPullCommits,
  getPullDiff,
  mergePull,
  PullDiffHttpError,
} from "../api";
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
  PullRowContinuityProvider,
  usePullRowContinuity,
} from "../row-continuity";
import {
  IDLE_RUN_STATE,
  type PullRuns,
  type RunHistoryEntry,
  type RunStartOutcome,
  type RunState,
} from "../runs";
import { createPendingPull, createPullsResponse } from "../test/fixtures";
import type {
  PullCommit,
  PullCommitDiff,
  PullCommits,
  PullDiff,
  PullReadiness,
} from "../types";
import PullRow, { useDiffDisclosure } from "./PullRow";
import ReadinessSection from "./ReadinessSection";

const render = (ui: ReactElement) =>
  renderBase(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PullRowContinuityProvider>{children}</PullRowContinuityProvider>
    ),
  });

type Controls = Pick<
  PullRuns,
  | "cancel"
  | "clearReviewRetry"
  | "loadTranscript"
  | "observeRepair"
  | "setMessage"
  | "start"
>;

const getBlockedPull = (): PullReadiness => createPullsResponse().notReady[0]!;
const getReadyPull = (): PullReadiness => createPullsResponse().ready[0]!;
const VIEWER_LOGIN = "jake";
const ARTIFACT_EPOCH = 1;
const transcripts = new Map<string, string>();

const createRun = (change: Partial<RunState> = {}): RunState => ({
  ...IDLE_RUN_STATE,
  ...change,
});

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const createHistoryEntry = ({
  transcriptText = "Checked the affected path.\nValidation passed.",
  ...change
}: Partial<RunHistoryEntry> & {
  transcriptText?: string;
} = {}): RunHistoryEntry => {
  const entry: RunHistoryEntry = {
    agent: "claude",
    finishedAt: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    id: "previous-fix",
    instructions: {
      kind: "manual",
      text: "Fix the stale readiness evidence.",
    },
    source: "manual",
    status: "completed",
    transcript: {
      availability: "available",
      bytes: new TextEncoder().encode(transcriptText).byteLength,
      key: `transcript:${change.id ?? "previous-fix"}`,
    },
    ...change,
  };
  if (entry.transcript.availability === "available") {
    transcripts.set(entry.transcript.key, transcriptText);
  }
  return entry;
};

const createControls = (): Controls => ({
  cancel: vi.fn(async (_key: string) => undefined),
  clearReviewRetry: vi.fn(),
  loadTranscript: vi.fn(async (entry) =>
    entry.transcript.availability === "available"
      ? (transcripts.get(entry.transcript.key) ?? null)
      : null,
  ),
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
        clearReviewRetry={controls.clearReviewRetry}
        favorite={favorite}
        hidePull={hidePull}
        loadTranscript={controls.loadTranscript}
        movement={movement}
        onMutationComplete={onMutationComplete}
        onToggleViewed={onToggleViewed}
        pull={pull}
        run={run}
        setFavorite={setFavorite}
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

function SeededCommitsRow({
  persistence,
  pull,
}: {
  persistence: unknown;
  pull: PullReadiness;
}) {
  const { ensureDiffKey, update } = usePullRowContinuity(getPullKey(pull));
  const [seeded, setSeeded] = useState(false);
  const diffKey = getPullDiffKey(pull, VIEWER_LOGIN, ARTIFACT_EPOCH);

  useLayoutEffect(() => {
    ensureDiffKey(diffKey, "ready");
    update({
      commits: { persistence },
      commitsExpanded: true,
    });
    setSeeded(true);
  }, [diffKey, ensureDiffKey, persistence, update]);

  return seeded ? (
    <ControlledRow
      controls={createControls()}
      pull={pull}
      run={createRun()}
      variant="ready"
    />
  ) : null;
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

const pullCommit = (
  pull: PullReadiness,
  sha = "1111111111111111111111111111111111111111",
): PullCommit => ({
  authorLogin: "jake",
  authorName: "Jake",
  authoredAt: "2026-07-17T10:00:00.000Z",
  message: "Keep commit history visible",
  sha,
  url: `https://github.com/${pull.repository}/commit/${sha}`,
});

const pullCommits = (
  pull: PullReadiness,
  commits = [pullCommit(pull)],
): PullCommits => {
  return {
    baseRefOid: pull.baseRefOid,
    commits,
    complete: true,
    count: commits.length,
    headRefOid: pull.headRefOid,
    number: pull.number,
    repository: pull.repository,
    warning: null,
  };
};

const pullCommitDiff = (
  pull: PullReadiness,
  commit = pullCommit(pull),
): PullCommitDiff => ({
  ...pullDiff(pull),
  commitSha: commit.sha,
});

const pullItem = (pull: PullReadiness, favorite = false): PullSectionItem => ({
  favorite,
  identity: getPullKey(pull),
  key: `pull:${pull.url}`,
  kind: "pull",
  pull,
});

function ContinuitySections({
  blocked = [],
  progress = [],
  ready = [],
  runs,
}: {
  blocked?: readonly PullSectionItem[];
  progress?: readonly PullSectionItem[];
  ready?: readonly PullSectionItem[];
  runs: PullRuns;
}) {
  const visibleItemKeys = new Set(
    [...ready, ...progress, ...blocked].map(({ key }) => key),
  );

  return (
    <>
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing ready"
        items={ready}
        runs={runs}
        title="Ready"
        variant="ready"
        visibleItemKeys={visibleItemKeys}
      />
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing running"
        items={progress}
        runs={runs}
        title="In progress"
        variant="progress"
        visibleItemKeys={visibleItemKeys}
      />
      <ReadinessSection
        {...sectionViewing}
        emptyMessage="Nothing blocked"
        items={blocked}
        runs={runs}
        title="Not ready"
        variant="blocked"
        visibleItemKeys={visibleItemKeys}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  transcripts.clear();
  motionSettings.reduced = false;
  setAgentPreference("claude");
  vi.mocked(getPullCommitDiff).mockReset();
  vi.mocked(getPullCommits).mockReset();
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
    const commits = screen.getByRole("button", { name: "Commits" });
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
    expect(trigger).not.toContainElement(commits);
    expect(trigger).not.toContainElement(merge);
    expect(controls).toHaveClass(
      "sm:self-stretch",
      "sm:flex-col",
      "sm:items-end",
      "sm:justify-between",
    );
    expect(controls).toContainElement(screen.getByText("All checks passed"));
    expect(actions).toContainElement(commits);
    expect(actions).toContainElement(files);
    expect(actions).toContainElement(merge);
    expect(
      commits.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      files.compareDocumentPosition(merge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.querySelector("[data-ready-diff-content]"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Favourite pull request")).toBeInTheDocument();

    fireEvent.contextMenu(commits);
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
    expect(screen.getByRole("button", { name: "Commits" })).toBeEnabled();
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

  it.each([
    ["ready", getReadyPull()],
    ["progress", createPendingPull()],
    ["blocked", getBlockedPull()],
  ] as const)(
    "shows independently controlled commit and file panels for %s rows",
    async (variant, pull) => {
      vi.mocked(getPullCommits).mockResolvedValue(pullCommits(pull));
      vi.mocked(getPullCommitDiff).mockResolvedValue(pullCommitDiff(pull));
      vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
      renderRow(pull, variant);

      const commits = screen.getByRole("button", { name: "Commits" });
      const files = screen.getByRole("button", { name: "Files changed" });
      expect(commits).toHaveAttribute("aria-expanded", "false");
      expect(files).toHaveAttribute("aria-expanded", "false");
      expect(getPullCommits).not.toHaveBeenCalled();

      fireEvent.click(commits);
      expect(commits).toHaveAttribute("aria-expanded", "true");
      expect(files).toHaveAttribute("aria-expanded", "false");
      expect(
        await screen.findByRole("region", {
          name: `Commits for ${pull.repository} pull request ${pull.number}`,
        }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(getPullCommitDiff).toHaveBeenCalledWith(
          expect.objectContaining({
            headRefOid: pull.headRefOid,
            number: pull.number,
            repository: pull.repository,
          }),
          "1111111111111111111111111111111111111111",
          expect.any(AbortSignal),
        ),
      );

      fireEvent.click(files);
      expect(
        await screen.findByRole("region", {
          name: `Files changed for ${pull.repository} pull request ${pull.number}`,
        }),
      ).toBeInTheDocument();
      expect(commits).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(commits);
      expect(commits).toHaveAttribute("aria-expanded", "false");
      expect(files).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.queryByRole("region", {
          name: `Commits for ${pull.repository} pull request ${pull.number}`,
        }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    ["missing visibility", undefined, "first"],
    ["boolean visibility", false, "first"],
    ["invalid visibility", "false", "second"],
  ] as const)(
    "accepts commit continuity with %s only when the visibility value is boolean",
    async (_case, listVisible, expected) => {
      const pull = getReadyPull();
      const first = pullCommit(
        pull,
        "1111111111111111111111111111111111111111",
      );
      const second = pullCommit(
        pull,
        "2222222222222222222222222222222222222222",
      );
      vi.mocked(getPullCommits).mockResolvedValue(
        pullCommits(pull, [first, second]),
      );
      vi.mocked(getPullCommitDiff).mockImplementation(async (_identity, sha) =>
        pullCommitDiff(pull, sha === first.sha ? first : second),
      );
      const persistence = {
        diffs: {},
        selectedSha: first.sha,
        viewed: {},
        ...(listVisible === undefined ? {} : { listVisible }),
      };

      render(<SeededCommitsRow persistence={persistence} pull={pull} />);

      const selected = expected === "first" ? first : second;
      expect(
        await screen.findByRole("region", {
          name: `Files changed for ${pull.repository} pull request ${pull.number}`,
        }),
      ).toHaveTextContent(selected.sha.slice(0, 7));
      await waitFor(() =>
        expect(
          screen.getByRole("list", { name: "Pull request commits" }),
        ).toBeVisible(),
      );
      expect(
        screen.queryByRole("button", { name: /^(Hide|Show) commits$/ }),
      ).not.toBeInTheDocument();
      expect(getPullCommitDiff).toHaveBeenLastCalledWith(
        expect.any(Object),
        selected.sha,
        expect.any(AbortSignal),
      );
    },
  );

  it("shows review preparation truthfully and disables merge until the run is accepted", () => {
    const pull = getReadyPull();
    renderRow(
      pull,
      "ready",
      createRun({ source: "review", status: "preparing" }),
    );

    expect(screen.getByText("Review fix preparing")).toBeInTheDocument();
    expect(screen.queryByText("All checks passed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
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

  it("keeps native navigation keys inside active fix output without weakening row shortcuts", async () => {
    const pull = createPendingPull();
    const controls = createControls();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const { container } = renderRow(
      pull,
      "progress",
      createRun({
        output: "Long active fix output.",
        status: "running",
      }),
      controls,
    );
    const terminal = screen.getByRole("log", {
      name: `Claude output for ${pull.repository} pull request ${pull.number}`,
    });
    terminal.focus();

    expect(terminal).toHaveAttribute("data-keyboard-scroll-region", "");
    for (const key of [
      "Home",
      "End",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "j",
      "k",
    ]) {
      expect(fireEvent.keyDown(terminal, { key })).toBe(true);
      expect(terminal).toHaveFocus();
    }
    expect(getPullDiff).not.toHaveBeenCalled();
    expect(getPullCommits).not.toHaveBeenCalled();
    expect(mergePull).not.toHaveBeenCalled();
    expect(controls.start).not.toHaveBeenCalled();

    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;
    row.focus();
    fireEvent.keyDown(row, { key: "f" });

    await waitFor(() => expect(getPullDiff).toHaveBeenCalledOnce());
    expect(document.activeElement).toHaveAttribute(
      "data-pull-focus-token",
      "file:src/ready.ts",
    );
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
    expect(screen.getByText("src/ready.ts")).toBeInTheDocument();
    expect(screen.getByText("ready.ts")).toBeInTheDocument();
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

  it("preserves viewed files while releasing the raw diff on collapse", async () => {
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

  it("preserves compact diff feedback while refetching raw diff data", async () => {
    const pull = getReadyPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    renderRow(pull, "ready");
    const disclosure = screen.getByRole("button", { name: "Files changed" });
    fireEvent.click(disclosure);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Claude feedback on new line 1",
      }),
      { target: { value: "Keep this compact draft." } },
    );

    fireEvent.click(disclosure);
    fireEvent.click(disclosure);

    expect(
      await screen.findByRole("textbox", {
        name: "Claude feedback on new line 1",
      }),
    ).toHaveValue("Keep this compact draft.");
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
    ["repository", { repository: "appwrite-labs/cloud" }, true],
    ["number", { number: 4242 }, true],
    ["base", { baseRefOid: "ffffffffffffffffffffffffffffffffffffffff" }, false],
    ["head", { headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, false],
  ] as const)(
    "resets viewed files atomically when the pull %s changes",
    async (_field, change, identityChanged) => {
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
      if (identityChanged) {
        expect(
          screen.getByRole("button", { name: "Files changed" }),
        ).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
      }
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
    fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
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
    expect(panel).not.toHaveClass("z-20");
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
          agent: "claude",
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
  it("runs a shepherd-bar fix without a free-text composer", () => {
    const pull = getBlockedPull();
    const controls = createControls();
    const view = renderRow(pull, "blocked", createRun(), controls);
    const start = screen.getByRole("button", { name: "Run fix" });

    expect(
      screen.getByText(
        "Run fix drives this pull request to the shepherd bar. Select lines in Files changed to give specific instructions.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(controls.start).toHaveBeenCalledWith(pull);

    view.rerender(
      row(pull, "progress", createRun({ status: "running" }), controls),
    );
    expect(screen.getByRole("button", { name: "Run fix" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(controls.cancel).toHaveBeenCalledWith(pull.url);
  });

  it("shows a rate-limit notice with a control to switch agents", () => {
    const pull = getBlockedPull();
    renderRow(
      pull,
      "blocked",
      createRun({
        agent: "claude",
        rateLimit: {
          agent: "claude",
          message: "You've hit your weekly limit.",
        },
        status: "idle",
      }),
    );

    const notice = screen.getByRole("status", { name: /rate limit/i });
    expect(notice).toHaveTextContent("You've hit your weekly limit.");
    const swap = screen.getByRole("button", { name: "Switch to Grok" });
    fireEvent.click(swap);
    expect(
      screen.getByText("Using Grok. Run fix to continue."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Switch to Grok" }),
    ).not.toBeInTheDocument();
  });

  it("keeps compact desktop controls and 44px mobile targets", () => {
    renderRow(getBlockedPull(), "blocked");
    const start = screen.getByRole("button", { name: "Run fix" });

    expect(start).toHaveClass("min-h-11", "sm:min-h-8");
  });
});

describe("PullRow previous fixes", () => {
  it.each([
    ["Ready", "ready", getReadyPull],
    ["In progress", "progress", createPendingPull],
    ["Not ready", "blocked", getBlockedPull],
  ] as const)(
    "keeps %s history collapsed and inert until its accessible disclosure opens",
    async (_section, variant, getPull) => {
      const pull = getPull();
      const entry = createHistoryEntry();
      const controls = createControls();
      const { container } = renderRow(
        pull,
        variant,
        createRun({ history: [entry] }),
        controls,
      );
      const disclosure = screen.getByRole("button", {
        name: "Previous fixes, 1 run",
      });
      const contentId = disclosure.getAttribute("aria-controls");

      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(contentId).toBeTruthy();
      expect(within(disclosure).getByText("1")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(
        container.querySelector("[data-run-history-entry]"),
      ).not.toBeInTheDocument();
      expect(
        container.querySelector("[data-run-history-transcript]"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Fix the stale readiness evidence."),
      ).not.toBeInTheDocument();

      fireEvent.click(disclosure);

      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      const region = screen.getByRole("region", {
        name: `Previous fixes for ${pull.repository} pull request ${pull.number}`,
      });
      expect(region).toHaveAttribute("id", contentId);
      expect(within(region).getByText("Claude manual fix")).toBeInTheDocument();
      expect(within(region).getByText("Completed")).toBeInTheDocument();
      expect(within(region).getByText("5 mins ago")).toHaveAttribute(
        "dateTime",
        entry.finishedAt,
      );
      expect(region).toHaveTextContent("Fix the stale readiness evidence.");
      expect(controls.loadTranscript).not.toHaveBeenCalled();
      expect(
        region.querySelector("[data-run-history-transcript]"),
      ).not.toBeInTheDocument();

      fireEvent.click(
        within(region).getByRole("button", {
          name: "Show transcript for Claude manual fix completed from 5 mins ago",
        }),
      );

      expect(controls.loadTranscript).toHaveBeenCalledOnce();
      const transcript = await within(region).findByLabelText(
        "Claude manual fix transcript from 5 mins ago",
      );
      expect(transcript).toHaveTextContent(
        "Checked the affected path. Validation passed.",
      );
      expect(transcript).toHaveClass(
        "max-h-56",
        "max-w-full",
        "overflow-auto",
        "whitespace-pre-wrap",
      );
      expect(transcript).not.toHaveAttribute("aria-live");
      expect(region.querySelector("[aria-live]")).toBeNull();
    },
  );

  it("renders immutable history order newest first with exact transcripts and effective instructions", () => {
    const pull = getBlockedPull();
    const newer = createHistoryEntry({
      finishedAt: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
      id: "newer-review",
      instructions: {
        feedback: {
          body: "Keep retries bounded.",
          line: 42,
          path: "src/retry.ts",
          side: "RIGHT",
        },
        kind: "review",
        message: "Cover the timeout branch too.",
      },
      transcriptText: "newer line one\n  newer indented line\n",
      source: "review",
      status: "failed",
    });
    const older = createHistoryEntry({
      finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
      id: "older-auto",
      instructions: {
        kind: "auto",
        message: "",
        triggers: [],
      },
      transcriptText: "older transcript",
      source: "auto",
      status: "cancelled",
    });
    const { container } = renderRow(
      pull,
      "blocked",
      createRun({ history: [newer, older] }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Previous fixes, 2 runs",
      }),
    );

    const entries = container.querySelectorAll("[data-run-history-entry]");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveAttribute("data-run-history-entry", newer.id);
    expect(entries[1]).toHaveAttribute("data-run-history-entry", older.id);
    expect(
      within(entries[0] as HTMLElement).getByText("Claude review fix"),
    ).toBeInTheDocument();
    expect(
      within(entries[0] as HTMLElement).getByText("Failed"),
    ).toBeInTheDocument();
    expect(entries[0]).toHaveTextContent(
      "Keep retries bounded. Additional context: Cover the timeout branch too.",
    );
    expect(
      transcripts.get(
        newer.transcript.availability === "available"
          ? newer.transcript.key
          : "",
      ),
    ).toBe("newer line one\n  newer indented line\n");
    expect(
      within(entries[1] as HTMLElement).getByText("Claude auto fix"),
    ).toBeInTheDocument();
    expect(
      within(entries[1] as HTMLElement).getByText("Cancelled"),
    ).toBeInTheDocument();
    expect(entries[1]).toHaveTextContent("The target is the shepherd bar.");
    expect(
      transcripts.get(
        older.transcript.availability === "available"
          ? older.transcript.key
          : "",
      ),
    ).toBe("older transcript");
  });

  it("suppresses a stale transcript response after collapse and loads the newest request", async () => {
    const pull = getBlockedPull();
    const entry = createHistoryEntry({ transcriptText: "Stored transcript." });
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const controls = createControls();
    vi.mocked(controls.loadTranscript)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderRow(pull, "blocked", createRun({ history: [entry] }), controls);

    fireEvent.click(
      screen.getByRole("button", { name: "Previous fixes, 1 run" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show transcript for Claude manual fix completed from 5 mins ago",
      }),
    );
    expect(screen.getByText("Loading transcript…")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide transcript for Claude manual fix completed from 5 mins ago",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show transcript for Claude manual fix completed from 5 mins ago",
      }),
    );

    await act(async () => first.resolve("Stale transcript."));
    expect(screen.queryByText("Stale transcript.")).not.toBeInTheDocument();
    expect(screen.getByText("Loading transcript…")).toBeInTheDocument();

    await act(async () => second.resolve("Fresh transcript."));
    expect(await screen.findByText("Fresh transcript.")).toBeInTheDocument();
    expect(controls.loadTranscript).toHaveBeenCalledTimes(2);
  });

  it("renders explicit unavailable transcript metadata without attempting a load", () => {
    const pull = getBlockedPull();
    const controls = createControls();
    const entry = createHistoryEntry({
      transcript: {
        availability: "unavailable",
        bytes: 42,
        code: "indexeddb_write_failed",
        message: "Browser storage rejected this transcript.",
      },
    });
    renderRow(pull, "blocked", createRun({ history: [entry] }), controls);

    fireEvent.click(
      screen.getByRole("button", { name: "Previous fixes, 1 run" }),
    );

    expect(screen.getByText("Transcript unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Browser storage rejected this transcript."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /transcript for/ })).toBeNull();
    expect(controls.loadTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ["progress", createPendingPull],
    ["blocked", getBlockedPull],
  ] as const)(
    "keeps %s history below Run fix and outside row action boundaries",
    (variant, getPull) => {
      const pull = getPull();
      const { container } = render(
        <ControlledRow
          controls={createControls()}
          hidePull={vi.fn()}
          pull={pull}
          run={createRun({ history: [createHistoryEntry()] })}
          setFavorite={vi.fn()}
          variant={variant}
        />,
      );
      const actionBoundary = container.querySelector<HTMLElement>(
        "[data-slot='pull-actions-trigger']",
      );
      const controls = container.querySelector<HTMLElement>(
        "[data-pull-controls]",
      );
      const start = screen.getByRole("button", { name: "Run fix" });
      const history = screen.getByRole("button", { name: /Previous fixes/ });

      expect(actionBoundary).not.toContainElement(history);
      expect(controls).not.toContainElement(history);
      expect(
        start.compareDocumentPosition(history) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      fireEvent.contextMenu(history);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("keeps ready history outside the row link, context menu, and action controls", () => {
    const pull = getReadyPull();
    const { container } = render(
      <ControlledRow
        controls={createControls()}
        hidePull={vi.fn()}
        pull={pull}
        run={createRun({ history: [createHistoryEntry()] })}
        setFavorite={vi.fn()}
        variant="ready"
      />,
    );
    const history = screen.getByRole("button", { name: /Previous fixes/ });
    const contextBoundary = container.querySelector<HTMLElement>(
      "[data-slot='pull-actions-trigger']",
    );
    const link = container.querySelector<HTMLElement>("[data-row-link]");
    const controls = container.querySelector<HTMLElement>(
      "[data-ready-controls]",
    );

    expect(contextBoundary).not.toContainElement(history);
    expect(link).not.toContainElement(history);
    expect(controls).not.toContainElement(history);
    fireEvent.contextMenu(history);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps active output live and separate from non-live historical transcripts", async () => {
    const pull = createPendingPull();
    const entry = createHistoryEntry({
      transcriptText: "Archived output only.",
    });
    const controls = createControls();
    renderRow(
      pull,
      "progress",
      createRun({
        history: [entry],
        output: "Current output only.",
        status: "running",
      }),
      controls,
    );

    const current = screen.getByRole("log", {
      name: `Claude output for ${pull.repository} pull request ${pull.number}`,
    });
    expect(current).toHaveAttribute("aria-live", "polite");
    expect(current).toHaveTextContent("Current output only.");
    expect(current).not.toHaveTextContent("Archived output only.");

    const disclosure = screen.getByRole("button", {
      name: /Previous fixes/,
    });
    expect(disclosure.querySelector("svg")).toHaveClass(
      "motion-reduce:transition-none",
    );
    fireEvent.click(disclosure);
    expect(controls.loadTranscript).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show transcript for Claude manual fix completed from 5 mins ago",
      }),
    );
    const transcript = await screen.findByLabelText(
      "Claude manual fix transcript from 5 mins ago",
    );
    expect(transcript).toHaveTextContent("Archived output only.");
    expect(transcript).not.toHaveTextContent("Current output only.");
    expect(transcript).not.toHaveAttribute("aria-live");
    expect(transcript).not.toHaveAttribute("role", "log");
  });

  it("keeps native navigation keys inside a saved transcript without invoking row actions", async () => {
    const pull = getBlockedPull();
    const entry = createHistoryEntry({ transcriptText: "Saved output." });
    const controls = createControls();
    const { container } = renderRow(
      pull,
      "blocked",
      createRun({ history: [entry] }),
      controls,
    );
    fireEvent.click(screen.getByRole("button", { name: /Previous fixes/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show transcript for Claude manual fix completed from 5 mins ago",
      }),
    );
    const transcript = await screen.findByLabelText(
      "Claude manual fix transcript from 5 mins ago",
    );
    transcript.focus();

    expect(transcript).toHaveAttribute("data-keyboard-scroll-region", "");
    for (const key of [
      "Home",
      "End",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "j",
      "k",
    ]) {
      expect(fireEvent.keyDown(transcript, { key })).toBe(true);
      expect(transcript).toHaveFocus();
    }
    expect(controls.loadTranscript).toHaveBeenCalledOnce();
    expect(getPullDiff).not.toHaveBeenCalled();
    expect(getPullCommits).not.toHaveBeenCalled();
    expect(mergePull).not.toHaveBeenCalled();
    expect(controls.start).not.toHaveBeenCalled();

    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;
    row.focus();
    fireEvent.keyDown(row, { key: "b" });

    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-blocker-key",
        "failed-checks",
      ),
    );
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
    const start = screen.getByRole("button", { name: "Run fix" });
    const terminal = screen.getByRole("log");
    const files = screen.getByRole("button", { name: "Files changed" });
    const commits = screen.getByRole("button", { name: "Commits" });

    expect(trigger).not.toBeNull();
    expect(trigger).not.toContainElement(details);
    expect(trigger).not.toContainElement(commits);
    expect(trigger).not.toContainElement(files);
    expect(trigger).not.toContainElement(start);
    expect(trigger).not.toContainElement(terminal);

    fireEvent.contextMenu(commits);
    fireEvent.contextMenu(files);
    fireEvent.contextMenu(details);
    fireEvent.contextMenu(start);
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
      const panel = await screen.findByRole("region", {
        name: `Files changed for ${pull.repository} pull request ${pull.number}`,
      });
      const card = panel.closest<HTMLElement>("[data-slot='card']");
      expect(panel).toBeInTheDocument();
      expect(card).toHaveClass("overflow-visible");
      expect(card).not.toHaveClass("overflow-hidden");

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

  it("disables artifact controls when the viewer identity is unavailable", () => {
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
    expect(screen.getByRole("button", { name: "Commits" })).toBeDisabled();
    expect(getPullDiff).not.toHaveBeenCalled();
    expect(getPullCommits).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "Run fix" })).toBeEnabled();
    expect(getPullDiff).toHaveBeenCalledTimes(2);
  });

  it("shows a centered spinning yellow progress icon and muted CI counts", () => {
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
    const overview = container.querySelector("[data-ci-progress]");
    expect(overview).toHaveTextContent(
      "0 in progress · 1 queued · 1 successful · 0 failed",
    );
    expect(overview).toHaveClass("text-muted-foreground");
    expect(
      overview?.querySelector('[data-ci-count="successful"]'),
    ).not.toHaveAttribute("class");
    expect(
      overview?.querySelector('[data-ci-count="failed"]'),
    ).not.toHaveAttribute("class");
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
    expect(container.querySelector("[data-ci-progress]")).toHaveTextContent(
      "0 in progress · 1 queued · 1 successful · 0 failed · Claude running",
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

  it("uses the server's in-progress, queued, successful, failed, and incomplete counts", () => {
    const current = createPendingPull();
    const pull = {
      ...current,
      ci: {
        ...current.ci,
        complete: false,
        failed: 1,
        inProgress: 2,
        passed: 4,
        queued: 3,
        total: 12,
        unknown: 2,
      },
    };
    const { container } = renderRow(pull, "progress");

    expect(container.querySelector("[data-ci-progress]")).toHaveTextContent(
      "2 in progress · 3 queued · 4 successful · 1 failed · 2 unknown",
    );
  });

  it("shows subdued CI counts including failures on blocked rows", () => {
    const pull = getBlockedPull();
    const { container } = renderRow(pull, "blocked");

    const overview = container.querySelector("[data-ci-progress]");
    expect(overview).toHaveTextContent(
      "0 in progress · 0 queued · 1 successful · 1 failed",
    );
    expect(overview).toHaveClass("text-muted-foreground");
    expect(overview).not.toHaveClass(
      "text-amber-800",
      "dark:text-amber-300",
      "text-destructive",
    );
    expect(
      overview?.querySelector('[data-ci-count="successful"]'),
    ).not.toHaveAttribute("class");
    expect(
      overview?.querySelector('[data-ci-count="failed"]'),
    ).not.toHaveAttribute("class");
    expect(screen.getByRole("list", { name: "Blockers" })).toHaveTextContent(
      "CI checks failed",
    );
  });

  it("uses authoritative incomplete CI counts on blocked rows", () => {
    const current = getBlockedPull();
    const pull = {
      ...current,
      ci: {
        ...current.ci,
        complete: false,
        failed: 1,
        inProgress: 2,
        passed: 4,
        queued: 3,
        total: 12,
        unknown: 2,
      },
    };
    const { container } = renderRow(pull, "blocked");

    const overview = container.querySelector("[data-ci-progress]");
    expect(overview).toHaveTextContent(
      "2 in progress · 3 queued · 4 successful · 1 failed · 2 unknown",
    );
    expect(overview).toHaveClass("text-muted-foreground");
  });

  it("shows the no-checks message on blocked rows", () => {
    const current = getBlockedPull();
    const pull = {
      ...current,
      ci: {
        ...current.ci,
        checks: [],
        complete: true,
        failed: 0,
        inProgress: 0,
        passed: 0,
        queued: 0,
        running: 0,
        state: "none" as const,
        total: 0,
        unknown: 0,
      },
    };
    renderRow(pull, "blocked");

    expect(screen.getByText("No CI checks reported")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("keeps active-run CI semantics on progress rows and hides the overview on ready rows", () => {
    const run = createRun({
      message: "Finish the active run.",
      status: "running",
    });
    const progress = renderRow(createPendingPull(), "progress", run);

    expect(progress.container.querySelector("[data-ci-progress]")).toHaveClass(
      "text-muted-foreground",
    );
    expect(
      progress.container.querySelector("[data-ci-progress]"),
    ).toHaveTextContent(
      "0 in progress · 1 queued · 1 successful · 0 failed · Claude running",
    );
    expect(screen.getByText("Claude is active")).toHaveAttribute(
      "role",
      "status",
    );

    progress.unmount();
    const ready = renderRow(getReadyPull(), "ready", run);
    expect(ready.container.querySelector("[data-ci-progress]")).toBeNull();
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

    expect(
      screen.getAllByText("Claude auto fix running").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("log", {
        name: `Claude auto fix output for ${pull.repository} pull request ${pull.number}`,
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

    expect(
      screen.getAllByText("Claude review fix running").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("log", {
        name: `Claude review fix output for ${pull.repository} pull request ${pull.number}`,
      }),
    ).toHaveTextContent("Addressing selected diff feedback.");
    expect(
      screen.getByText("Claude review fix", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("labels review preflight as preparation while CI is already in progress", () => {
    const pull = createPendingPull();
    const { container } = renderRow(
      pull,
      "progress",
      createRun({ source: "review", status: "preparing" }),
    );

    expect(
      screen.getAllByText("Claude review fix preparing").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Claude review fix is preparing")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.getByRole("button", { name: "Preparing review fix" }),
    ).toBeDisabled();
    expect(
      container.querySelector('[data-status-icon="progress"]'),
    ).toHaveAttribute("data-status-active", "true");
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
      const commits = screen.getByRole("button", { name: "Commits" });
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
      expect(actions).toContainElement(commits);
      expect(actions).toContainElement(files);
      const first = variant === "progress" ? commits : details;
      const second = variant === "progress" ? details : commits;
      expect(
        first.compareDocumentPosition(second) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        second.compareDocumentPosition(files) &
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

  it.each([
    ["progress", "Commits"],
    ["blocked", "Show blocker details"],
    ["ready", "Commits"],
  ] as const)(
    "focuses the first %s row disclosure with ArrowRight",
    (variant, expected) => {
      const pull =
        variant === "ready"
          ? getReadyPull()
          : variant === "progress"
            ? createPendingPull()
            : getBlockedPull();
      const { container } = renderRow(pull, variant);
      const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;

      row.focus();
      fireEvent.keyDown(row, { key: "ArrowRight" });

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: expected }),
      );
      expect(getPullDiff).not.toHaveBeenCalled();
      expect(getPullCommits).not.toHaveBeenCalled();
    },
  );

  it("opens each disclosure from the focused row and enters its safe first item", async () => {
    const pull = getBlockedPull();
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    vi.mocked(getPullCommits).mockResolvedValue(pullCommits(pull));
    vi.mocked(getPullCommitDiff).mockResolvedValue(pullCommitDiff(pull));
    const { container } = renderRow(pull, "blocked");
    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;
    const files = screen.getByRole("button", { name: "Files changed" });
    const blockers = screen.getByRole("button", {
      name: "Show blocker details",
    });
    const commits = screen.getByRole("button", { name: "Commits" });

    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveAttribute(
      "aria-label",
      `${pull.repository} pull request ${pull.number}: ${pull.title}`,
    );
    expect(files).toHaveAttribute("aria-keyshortcuts", "f");
    expect(blockers).toHaveAttribute("aria-keyshortcuts", "b");
    expect(commits).toHaveAttribute("aria-keyshortcuts", "c");

    row.focus();
    fireEvent.keyDown(row, { key: "b" });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-blocker-key",
        "failed-checks",
      ),
    );

    row.focus();
    fireEvent.keyDown(row, { key: "c" });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-focus-token",
        expect.stringMatching(/^commit:/),
      ),
    );

    row.focus();
    fireEvent.keyDown(row, { key: "f" });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-focus-token",
        "file:src/ready.ts",
      ),
    );
    expect(getPullCommits).toHaveBeenCalledOnce();
    expect(getPullDiff).toHaveBeenCalledOnce();
  });

  it("collapses open panels with ArrowLeft and escapes panel, trigger, then row", async () => {
    const pull = getBlockedPull();
    const { container } = renderRow(pull, "blocked");
    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;
    const blockers = screen.getByRole("button", {
      name: "Show blocker details",
    });

    row.focus();
    fireEvent.keyDown(row, { key: "b" });
    const item = await waitFor(() => {
      const current = container.querySelector<HTMLElement>(
        "[data-blocker-item][tabindex='0']",
      );
      expect(current).not.toBeNull();
      return current!;
    });
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
    expect(document.activeElement).toBe(blockers);

    fireEvent.keyDown(blockers, { key: "Escape" });
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(blockers).toHaveAttribute("aria-expanded", "false");
    expect(getPullDiff).not.toHaveBeenCalled();
    expect(getPullCommits).not.toHaveBeenCalled();
  });

  it("does not move focus to a retry action when keyboard-opened files fail", async () => {
    const pull = getBlockedPull();
    vi.mocked(getPullDiff).mockRejectedValue(new Error("Diff unavailable"));
    const { container } = renderRow(pull, "blocked");
    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;

    row.focus();
    fireEvent.keyDown(row, { key: "f" });
    await screen.findByRole("alert");

    expect(document.activeElement).toBe(row);
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Retry" }),
    );
    expect(getPullDiff).toHaveBeenCalledOnce();
  });

  it("cancels stale async entry focus when the panel closes before loading", async () => {
    const pull = getBlockedPull();
    const pending = deferred<PullDiff>();
    vi.mocked(getPullDiff).mockReturnValue(pending.promise);
    const { container } = renderRow(pull, "blocked");
    const row = container.querySelector<HTMLElement>("[data-pull-identity]")!;
    const outside = document.createElement("button");
    document.body.append(outside);

    try {
      row.focus();
      fireEvent.keyDown(row, { key: "f" });
      expect(
        screen.getByRole("button", { name: "Files changed" }),
      ).toHaveAttribute("aria-expanded", "true");
      row.focus();
      fireEvent.keyDown(row, { key: "f" });
      outside.focus();

      await act(async () => pending.resolve(pullDiff(pull)));

      expect(document.activeElement).toBe(outside);
      expect(
        screen.getByRole("button", { name: "Files changed" }),
      ).toHaveAttribute("aria-expanded", "false");
    } finally {
      outside.remove();
    }
  });

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
  it("keeps blocker details open and restores exact internal focus while the exiting row is inert", async () => {
    const pull = getBlockedPull();
    const target = pullItem(pull);
    const unrelatedPull = {
      ...createPendingPull(),
      number: pull.number + 1,
      title: "Unrelated in-progress pull",
      url: `https://github.com/${pull.repository}/pull/${pull.number + 1}`,
    };
    const unrelated = pullItem(unrelatedPull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const view = render(
      <ContinuitySections
        blocked={[target]}
        progress={[unrelated]}
        runs={runs}
      />,
    );
    const blocked = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="blocked"]',
    )!;
    const source = blocked.querySelector<HTMLElement>(
      `[data-pull-identity="${target.identity}"]`,
    )!;
    const details = within(source).getByRole("button", {
      name: "Show blocker details",
    });

    fireEvent.click(details);
    const thread = within(source).getAllByRole("link", {
      name: "Open thread",
    })[0]!;
    thread.focus();
    expect(thread).toHaveFocus();
    expect(details).toHaveAttribute("aria-expanded", "true");

    view.rerender(
      <ContinuitySections progress={[unrelated, target]} runs={runs} />,
    );

    const progress = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"]',
    )!;
    const destination = progress.querySelector<HTMLElement>(
      `[data-pull-identity="${target.identity}"]`,
    )!;
    const restored = within(destination).getAllByRole("link", {
      name: "Open thread",
    })[0]!;
    const unrelatedRow = progress.querySelector<HTMLElement>(
      `[data-pull-identity="${unrelated.identity}"]`,
    )!;

    expect(destination).not.toHaveAttribute("aria-hidden");
    expect(destination).not.toHaveAttribute("inert");
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored).toBeEnabled();
    expect(
      within(destination).getByRole("button", {
        name: "Hide blocker details",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      destination.querySelector("[data-blocker-panel]"),
    ).toBeInTheDocument();
    expect(unrelatedRow.contains(document.activeElement)).toBe(false);
  });

  it("makes an overlapping source row inert while its destination stays interactive", async () => {
    const pull = getBlockedPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const visibleItemKeys = new Set([item.key]);
    const view = render(
      <>
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing blocked"
          items={[item]}
          runs={runs}
          title="Not ready"
          variant="blocked"
          visibleItemKeys={visibleItemKeys}
        />
        <ReadinessSection
          {...sectionViewing}
          emptyMessage="Nothing running"
          items={[item]}
          runs={runs}
          title="In progress"
          variant="progress"
          visibleItemKeys={visibleItemKeys}
        />
      </>,
    );
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="blocked"] [data-pull-identity]',
    )!;
    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;

    expect(
      view.container.querySelectorAll(
        `[data-pull-identity="${item.identity}"]`,
      ),
    ).toHaveLength(2);
    await waitFor(() => expect(source).toHaveAttribute("inert"));
    expect(source).toHaveAttribute("aria-hidden", "true");
    expect(destination).not.toHaveAttribute("inert");
    expect(destination).not.toHaveAttribute("aria-hidden");
    expect(
      within(destination).getByRole("button", { name: "Files changed" }),
    ).toBeEnabled();
  });

  it("falls back from a removed blocker control to the blocker trigger after a move", async () => {
    const pull = getBlockedPull();
    const sourceItem = pullItem(pull);
    const destinationItem = pullItem({
      ...pull,
      unresolvedThreads: [],
    });
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const view = render(
      <ContinuitySections blocked={[sourceItem]} runs={runs} />,
    );
    const source = view.container.querySelector<HTMLElement>(
      `[data-pull-identity="${sourceItem.identity}"]`,
    )!;
    fireEvent.click(
      within(source).getByRole("button", { name: "Show blocker details" }),
    );
    const thread = within(source).getAllByRole("link", {
      name: "Open thread",
    })[0]!;
    thread.focus();
    expect(thread).toHaveFocus();

    view.rerender(
      <ContinuitySections progress={[destinationItem]} runs={runs} />,
    );

    const progress = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"]',
    )!;
    const destination = progress.querySelector<HTMLElement>(
      `[data-pull-identity="${destinationItem.identity}"]`,
    )!;
    const fallback = within(destination).getByRole("button", {
      name: "Hide blocker details",
    });
    await waitFor(() => expect(fallback).toHaveFocus());
    expect(
      within(destination).queryByRole("link", { name: "Open thread" }),
    ).not.toBeInTheDocument();
  });

  it("does not steal focus after focus leaves a pull before it moves", async () => {
    const pull = getBlockedPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const view = render(
      <>
        <button type="button">Outside pull</button>
        <ContinuitySections blocked={[item]} runs={runs} />
      </>,
    );
    const source = view.container.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;
    fireEvent.click(
      within(source).getByRole("button", { name: "Show blocker details" }),
    );
    const thread = within(source).getAllByRole("link", {
      name: "Open thread",
    })[0]!;
    thread.focus();
    const outside = screen.getByRole("button", { name: "Outside pull" });
    outside.focus();
    await act(async () => Promise.resolve());
    expect(outside).toHaveFocus();

    view.rerender(
      <>
        <button type="button">Outside pull</button>
        <ContinuitySections progress={[item]} runs={runs} />
      </>,
    );

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    await act(async () => Promise.resolve());
    expect(outside).toHaveFocus();
    expect(destination.contains(document.activeElement)).toBe(false);
  });

  it("keeps an open diff, selection, draft, and exact focus through progress and blocked moves", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const ready = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"]',
    )!;
    const source = ready.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;

    fireEvent.click(
      within(source).getByRole("button", { name: "Files changed" }),
    );
    const composer = await within(source).findByRole("button", {
      name: "Give Claude feedback on new line 1",
    });
    fireEvent.click(composer);
    const input = within(source).getByRole("textbox", {
      name: "Claude feedback on new line 1",
    });
    fireEvent.change(input, {
      target: { value: "Keep this exact unsaved diff feedback." },
    });
    input.focus();
    expect(input).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const progress = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"]',
    )!;
    const progressRow = progress.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;
    const progressInput = within(progressRow).getByRole("textbox", {
      name: "Claude feedback on new line 1",
    });
    await waitFor(() => expect(progressInput).toHaveFocus());
    expect(progressInput).toHaveValue("Keep this exact unsaved diff feedback.");
    expect(
      within(progressRow).getByRole("button", { name: "Files changed" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      progressRow.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(1);

    view.rerender(<ContinuitySections blocked={[item]} runs={runs} />);

    const blocked = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="blocked"]',
    )!;
    const blockedRow = blocked.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;
    const blockedInput = within(blockedRow).getByRole("textbox", {
      name: "Claude feedback on new line 1",
    });
    await waitFor(() => expect(blockedInput).toHaveFocus());
    expect(blockedInput).toHaveValue("Keep this exact unsaved diff feedback.");
    expect(
      within(blockedRow).getByRole("button", { name: "Files changed" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(blockedRow.querySelectorAll("[data-comment-selected]")).toHaveLength(
      1,
    );
    expect(getPullDiff).toHaveBeenCalledOnce();
  });

  it("keeps the selected commit panel and exact commit focus through a section move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const first = pullCommit(pull, "1111111111111111111111111111111111111111");
    const second = {
      ...pullCommit(pull, "2222222222222222222222222222222222222222"),
      message: "Keep exact commit focus",
    };
    vi.mocked(getPullCommits).mockResolvedValue(
      pullCommits(pull, [first, second]),
    );
    vi.mocked(getPullCommitDiff).mockImplementation(async (_identity, sha) =>
      pullCommitDiff(pull, sha === first.sha ? first : second),
    );
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const ready = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"]',
    )!;
    const source = ready.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;

    fireEvent.click(within(source).getByRole("button", { name: "Commits" }));
    const selected = await within(source).findByRole("button", {
      name: /Keep exact commit focus, commit 2222222/,
    });
    selected.focus();
    expect(selected).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const progress = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"]',
    )!;
    const destination = progress.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    )!;
    const restored = await within(destination).findByRole("button", {
      name: /Keep exact commit focus, commit 2222222/,
    });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored).toHaveAttribute("aria-pressed", "true");
    expect(
      within(destination).getByRole("button", { name: "Commits" }),
    ).toHaveAttribute("aria-expanded", "true");

    const outgoing = ready.querySelector<HTMLElement>(
      `[data-pull-identity="${item.identity}"]`,
    );
    if (outgoing) {
      expect(outgoing).toHaveAttribute("inert");
      expect(outgoing).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("keeps the selected commit focused and the rail visible after a section move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const commit = pullCommit(pull);
    vi.mocked(getPullCommits).mockResolvedValue(pullCommits(pull, [commit]));
    vi.mocked(getPullCommitDiff).mockResolvedValue(
      pullCommitDiff(pull, commit),
    );
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"] [data-pull-identity]',
    )!;

    fireEvent.click(within(source).getByRole("button", { name: "Commits" }));
    const selected = await within(source).findByRole("button", {
      name: /Keep commit history visible, commit 1111111/,
    });
    selected.focus();
    expect(selected).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    const restored = await within(destination).findByRole("button", {
      name: /Keep commit history visible, commit 1111111/,
    });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(
      within(destination).getByRole("list", {
        name: "Pull request commits",
      }),
    ).toBeVisible();
    expect(
      within(destination).queryByRole("button", {
        name: /^(Hide|Show) commits$/,
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the selected file focused and the tree visible after a section move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"] [data-pull-identity]',
    )!;

    fireEvent.click(
      within(source).getByRole("button", { name: "Files changed" }),
    );
    const selected = await within(source).findByRole("button", {
      name: /^ready\.ts/,
    });
    selected.focus();
    expect(selected).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    const restored = await within(destination).findByRole("button", {
      name: /^ready\.ts/,
    });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(
      within(destination).getByRole("navigation", {
        name: "Changed files",
      }),
    ).toBeVisible();
    expect(
      within(destination).queryByRole("button", {
        name: /^(Hide|Show) files$/,
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the changed-file search query and exact input focus after a section move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"] [data-pull-identity]',
    )!;

    fireEvent.click(
      within(source).getByRole("button", { name: "Files changed" }),
    );
    const search = await within(source).findByRole("searchbox", {
      name: "Search changed files",
    });
    fireEvent.change(search, { target: { value: "READY.TS" } });
    search.focus();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("data-pull-focus-token", "file-search");

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    const restored = await within(destination).findByRole("searchbox", {
      name: "Search changed files",
    });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored).toHaveValue("READY.TS");
    expect(
      within(destination).getByRole("button", { name: /^ready\.ts/ }),
    ).toBeInTheDocument();
    expect(getPullDiff).toHaveBeenCalledOnce();
  });

  it("keeps the selected commit and visible rail through outer collapse and a section move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const first = pullCommit(pull, "1111111111111111111111111111111111111111");
    const second = pullCommit(pull, "2222222222222222222222222222222222222222");
    vi.mocked(getPullCommits).mockResolvedValue(
      pullCommits(pull, [first, second]),
    );
    vi.mocked(getPullCommitDiff).mockImplementation(async (_identity, sha) =>
      pullCommitDiff(pull, sha === first.sha ? first : second),
    );
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"] [data-pull-identity]',
    )!;
    const outer = within(source).getByRole("button", { name: "Commits" });

    fireEvent.click(outer);
    await within(source).findByTitle(second.sha);
    const firstCommit = within(source).getByRole("button", {
      name: /Keep commit history visible, commit 1111111/,
    });
    firstCommit.focus();
    fireEvent.click(firstCommit);
    expect(firstCommit).toHaveFocus();
    expect(await within(source).findByTitle(first.sha)).toHaveAttribute(
      "data-diff-revision",
      "",
    );

    fireEvent.click(outer);
    expect(outer).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(outer);
    const reopened = await within(source).findByRole("button", {
      name: /Keep commit history visible, commit 1111111/,
    });
    expect(outer).toHaveAttribute("aria-expanded", "true");
    expect(reopened).toHaveAttribute("aria-pressed", "true");
    expect(await within(source).findByTitle(first.sha)).toHaveAttribute(
      "data-diff-revision",
      "",
    );
    reopened.focus();
    expect(reopened).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    const restored = await within(destination).findByRole("button", {
      name: /Keep commit history visible, commit 1111111/,
    });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored).toHaveAttribute("aria-pressed", "true");
    expect(
      within(destination).getByRole("list", {
        name: "Pull request commits",
      }),
    ).toBeVisible();
    expect(
      within(destination).queryByRole("button", {
        name: /^(Hide|Show) commits$/,
      }),
    ).not.toBeInTheDocument();
    expect(await within(destination).findByTitle(first.sha)).toHaveAttribute(
      "data-diff-revision",
      "",
    );
    expect(
      within(destination).getByRole("button", { name: "Commits" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("restores a commit-diff control instead of the matching main-diff control after a move", async () => {
    const pull = getReadyPull();
    const item = pullItem(pull);
    const controls = createControls();
    const runs = createRuns(new Map(), controls);
    const commit = pullCommit(pull);
    vi.mocked(getPullCommits).mockResolvedValue(pullCommits(pull, [commit]));
    vi.mocked(getPullCommitDiff).mockResolvedValue(
      pullCommitDiff(pull, commit),
    );
    vi.mocked(getPullDiff).mockResolvedValue(pullDiff(pull));
    const view = render(<ContinuitySections ready={[item]} runs={runs} />);
    const source = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="ready"] [data-pull-identity]',
    )!;

    fireEvent.click(within(source).getByRole("button", { name: "Commits" }));
    const commitsPanel = source.querySelector<HTMLElement>(
      "[data-commits-panel]",
    )!;
    const commitViewed = await within(commitsPanel).findByRole("checkbox", {
      name: "Viewed src/ready.ts",
    });
    fireEvent.click(
      within(source).getByRole("button", { name: "Files changed" }),
    );
    const diffPanel = source.querySelector<HTMLElement>("[data-diff-panel]")!;
    await within(diffPanel).findByRole("checkbox", {
      name: "Viewed src/ready.ts",
    });
    commitViewed.focus();
    expect(commitViewed).toHaveFocus();

    view.rerender(<ContinuitySections progress={[item]} runs={runs} />);

    const destination = view.container.querySelector<HTMLElement>(
      '[data-readiness-section="progress"] [data-pull-identity]',
    )!;
    const destinationCommits = destination.querySelector<HTMLElement>(
      "[data-commits-panel]",
    )!;
    const destinationDiff =
      destination.querySelector<HTMLElement>("[data-diff-panel]")!;
    const restored = await within(destinationCommits).findByRole("checkbox", {
      name: "Viewed src/ready.ts",
    });
    const collision = await within(destinationDiff).findByRole("checkbox", {
      name: "Viewed src/ready.ts",
    });

    await waitFor(() => expect(restored).toHaveFocus());
    expect(collision).not.toHaveFocus();
    expect(
      within(destination).getByRole("button", { name: "Commits" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(destination).getByRole("button", { name: "Files changed" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

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
    expect(screen.getByRole("button", { name: "Run fix" })).toBeEnabled();

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
