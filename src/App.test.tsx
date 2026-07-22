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
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { countActiveLocalWork } from "./App";
import { getPullDiff, getPulls, getRecentReleases } from "./api";
import type { ClaudeRunEvent, ClaudeRunRequest } from "./fixes";
import type { RunState } from "./runs";
import type { TaskState } from "./tasks";
import {
  createDegradedPullDiff,
  createPendingPull,
  createPullsResponse,
} from "./test/fixtures";
import type {
  PullDiff,
  PullReadiness,
  PullsResponse,
  RecentRelease,
  RecentReleasesResponse,
  Task,
  TaskEvent,
} from "./types";

const fixes = vi.hoisted(() => ({
  cancel: vi.fn(),
  stream: vi.fn(),
}));

const actions = vi.hoisted(() => ({
  cancelReleaseVerification: vi.fn(),
  cancelRepair: vi.fn(),
  merge: vi.fn(),
  streamReleaseVerification: vi.fn(),
  streamRepair: vi.fn(),
}));

const taskActions = vi.hoisted(() => ({
  cancel: vi.fn(),
  list: vi.fn(),
  options: vi.fn(),
  start: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("./api", () => ({
  createRelease: vi.fn(),
  getCheckLog: vi.fn(),
  getPullDiff: vi.fn(),
  getPulls: vi.fn(),
  getRecentReleases: vi.fn(),
  getReleaseOptions: vi.fn(),
  getTaskOptions: taskActions.options,
  getTasks: taskActions.list,
  mergePull: actions.merge,
  parseGitHubActionsJobUrl: vi.fn(() => null),
  cancelVerification: vi.fn(),
  cancelReleaseVerification: actions.cancelReleaseVerification,
  cancelRepair: actions.cancelRepair,
  streamReleaseVerification: actions.streamReleaseVerification,
  streamRepair: actions.streamRepair,
  streamVerification: vi.fn(),
  startTask: taskActions.start,
  TaskStartError: class TaskStartError extends Error {},
  cancelTask: taskActions.cancel,
  streamTaskEvents: taskActions.stream,
}));

vi.mock("./fixes", () => ({
  cancelClaudeRun: fixes.cancel,
  streamClaudeRun: fixes.stream,
}));

const REFRESH_INTERVAL = 10_000;
const getPullDiffMock = vi.mocked(getPullDiff);
const getPullsMock = vi.mocked(getPulls);
const getRecentReleasesMock = vi.mocked(getRecentReleases);
const originalVisibility = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
const originalLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

type LockCallback = (lock: Lock) => unknown | Promise<unknown>;

class LockHarness {
  private active = false;
  private readonly waiters: Array<{
    callback: LockCallback;
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  readonly manager = {
    query: async () => ({ held: [], pending: [] }),
    request: (
      _name: string,
      options: LockOptions,
      callback: LockCallback,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const waiter = { callback, reject, resolve, signal: options.signal };
        if (options.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        this.waiters.push(waiter);
        options.signal?.addEventListener(
          "abort",
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index < 0 || this.active) return;
            this.waiters.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        this.drain();
      }),
  } as unknown as LockManager;

  private drain(): void {
    if (this.active) return;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      waiter.reject(new DOMException("Aborted", "AbortError"));
      this.drain();
      return;
    }
    this.active = true;
    void Promise.resolve(
      waiter.callback({ mode: "exclusive", name: "puller:auto" } as Lock),
    )
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        this.active = false;
        this.drain();
      });
  }
}

const installWebLocks = (): LockHarness => {
  const locks = new LockHarness();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks.manager,
  });
  return locks;
};

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const emptyReleases = (): RecentReleasesResponse => ({
  generatedAt: "2026-07-17T10:43:11.000Z",
  partial: false,
  releases: [],
  warnings: [],
});

const createRecentRelease = (id: string, numbers: number[]): RecentRelease => ({
  complete: true,
  id,
  name: `Release ${id}`,
  publishedAt: "2026-07-21T07:00:00.000Z",
  pulls: numbers.map((number) => ({
    headSha: `${number}`.padStart(40, "a").slice(-40),
    mergedAt: "2026-07-21T06:00:00.000Z",
    number,
    repository: "appwrite/cloud",
    title: `Released pull ${number}`,
    url: `https://github.com/appwrite/cloud/pull/${number}`,
  })),
  repository: "appwrite/cloud",
  repositoryUrl: "https://github.com/appwrite/cloud",
  source: "comparison",
  tag: `v1.0.${id === "one" ? 1 : 2}`,
  url: `https://github.com/appwrite/cloud/releases/tag/${id}`,
  warning: null,
});

const releaseResponse = (
  releases: RecentRelease[],
  partial = false,
): RecentReleasesResponse => ({
  generatedAt: partial
    ? "2026-07-21T08:01:00.000Z"
    : "2026-07-21T08:00:00.000Z",
  partial,
  releases,
  warnings: partial ? ["Some releases were omitted."] : [],
});

const createDeferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
};

const setVisibility = (visibility: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visibility,
  });
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );

const getSection = (
  name: "Ready" | "In progress" | "Not ready",
): HTMLElement => {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!section) {
    throw new Error(`${name} section is missing.`);
  }

  return section;
};

const getPullRow = (title: string): HTMLElement => {
  const item = screen.getByText(title).closest("li");
  if (!item) throw new Error(`Row for ${title} is missing.`);
  return item;
};

const getPullActionsTrigger = (title: string): HTMLElement => {
  const trigger = getPullRow(title).querySelector<HTMLElement>(
    "[data-slot='pull-actions-trigger']",
  );
  if (!trigger) throw new Error(`Action trigger for ${title} is missing.`);
  return trigger;
};

const openPullActions = (title: string): void => {
  fireEvent.contextMenu(getPullActionsTrigger(title), {
    clientX: 20,
    clientY: 24,
  });
};

const openHiddenPulls = (count: number): void => {
  const noun = count === 1 ? "pull request" : "pull requests";
  fireEvent.pointerDown(
    screen.getByRole("button", {
      name: `Manage ${count} hidden ${noun}`,
    }),
    { button: 0, ctrlKey: false },
  );
};

const responseWith = (
  ready: PullReadiness[],
  notReady: PullReadiness[],
): PullsResponse => ({
  ...createPullsResponse(),
  counts: {
    notReady: notReady.length,
    ready: ready.length,
    total: ready.length + notReady.length,
  },
  notReady,
  ready,
});

const withNewComment = (pull: PullReadiness): PullReadiness => ({
  ...pull,
  issueComments: [
    ...pull.issueComments,
    {
      author: "reviewer",
      body: "Please fix this new issue.",
      createdAt: "2026-07-22T02:00:00.000Z",
      id: "new-auto-comment",
      updatedAt: "2026-07-22T02:00:00.000Z",
      url: `${pull.url}#issuecomment-new-auto-comment`,
    },
  ],
});

const restoredTask = (pull?: PullReadiness): Task => ({
  base: "main",
  branch: "puller/new-task-12345678",
  createdAt: "2026-07-22T00:00:00.000Z",
  id: "12345678-task",
  phase: "running",
  ...(pull
    ? { pullRequest: { number: pull.number, url: pull.url } }
    : {
        pullRequest: {
          number: 912,
          url: "https://github.com/appwrite/cloud/pull/912",
        },
      }),
  repository: pull?.repository ?? "appwrite/cloud",
  title: "Build a new task feature",
  updatedAt: "2026-07-22T00:01:00.000Z",
});

const diffFor = (
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
): PullDiff => {
  const diff = createDegradedPullDiff();

  return {
    ...diff,
    complete: true,
    files: diff.files.map((file) => ({
      ...file,
      blobUrl: `https://github.com/${pull.repository}/blob/${pull.headRefOid}/${file.path}`,
      rawUrl: `https://github.com/${pull.repository}/raw/${pull.headRefOid}/${file.path}`,
    })),
    headRefOid: pull.headRefOid,
    number: pull.number,
    repository: pull.repository,
    warning: null,
  };
};

const reviewDiffFor = (pull: PullReadiness): PullDiff => ({
  baseRefOid: pull.baseRefOid,
  complete: true,
  files: [
    {
      additions: 1,
      binary: false,
      blobUrl: `https://github.com/${pull.repository}/blob/${pull.headRefOid}/src/readiness.ts`,
      changes: 2,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@ readiness",
          lines: [
            { content: "keep()", kind: "context", newLine: 1, oldLine: 1 },
            {
              content: "before()",
              kind: "deletion",
              newLine: null,
              oldLine: 2,
            },
            {
              content: "after()",
              kind: "addition",
              newLine: 2,
              oldLine: null,
            },
          ],
          newLines: 2,
          newStart: 1,
          oldLines: 2,
          oldStart: 1,
        },
      ],
      path: "src/readiness.ts",
      previousPath: null,
      rawUrl: `https://github.com/${pull.repository}/raw/${pull.headRefOid}/src/readiness.ts`,
      status: "modified",
      truncated: false,
    },
  ],
  headRefOid: pull.headRefOid,
  number: pull.number,
  repository: pull.repository,
  warning: null,
});

const mockGatedRun = (
  gate: Promise<void>,
  runId = "run-1",
  output = "Working on the pull request.\n",
) => {
  let signal: AbortSignal | undefined;

  fixes.stream.mockImplementation(async function* (
    request: ClaudeRunRequest,
    streamSignal?: AbortSignal,
  ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
    signal = streamSignal;
    yield {
      number: request.number,
      repository: request.repository,
      runId,
      type: "start",
    };
    yield { text: output, type: "text" };
    await gate;
    yield { exitCode: 0, type: "complete" };
  });

  return () => signal;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();

  if (originalVisibility) {
    Object.defineProperty(document, "visibilityState", originalVisibility);
  }
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else delete (navigator as unknown as { locks?: LockManager }).locks;
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  const values = new Map<string, string>();
  const storage: Storage = {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  getRecentReleasesMock.mockResolvedValue(emptyReleases());
  fixes.cancel.mockResolvedValue(undefined);
  taskActions.options.mockResolvedValue({
    repositories: [],
    updatedAt: "2026-07-22T00:00:00.000Z",
  });
  taskActions.list.mockResolvedValue([]);
});

describe("App", () => {
  it("counts distinct active local work without treating CI-only progress as active", () => {
    const pull = createPullsResponse().ready[0]!;
    const ciOnly = createPendingPull(301);
    const run: RunState = {
      actionId: "run-one",
      cancelling: false,
      headRefOid: pull.headRefOid,
      kind: "fix",
      message: "",
      output: "",
      repairState: null,
      source: "manual",
      status: "running",
    };
    const linked: TaskState = {
      cancelling: false,
      connectionError: null,
      output: "",
      sequence: 0,
      task: restoredTask(pull),
    };
    const { pullRequest: _pullRequest, ...standaloneTask } = restoredTask();
    const standalone: TaskState = {
      cancelling: false,
      connectionError: null,
      output: "",
      sequence: 0,
      task: { ...standaloneTask, id: "standalone-task" },
    };

    expect(
      countActiveLocalWork([pull, ciOnly], new Map([[pull.url, run]]), [
        linked,
        standalone,
      ]),
    ).toBe(2);
  });

  it("renders the compact shadcn header with exact snapshot controls and metadata", async () => {
    const response = createPullsResponse();
    getPullsMock.mockResolvedValue(response);

    render(<App />);

    const title = await screen.findByRole("heading", {
      level: 1,
      name: "Pull readiness",
    });
    const toolbar = title.closest("header");
    const card = title.closest('[data-slot="card"]');

    expect(toolbar).not.toBeNull();
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-size", "sm");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const stats = (toolbar as HTMLElement).querySelector<HTMLElement>(
      "[data-dashboard-stats]",
    )!;
    expect(within(stats).getByLabelText("Open 2")).toHaveTextContent("Open2");
    expect(within(stats).getByLabelText("Ready 1")).toHaveTextContent("Ready1");
    expect(within(stats).getByLabelText("Blocked 1")).toHaveTextContent(
      "Blocked1",
    );
    expect(within(stats).getByLabelText("Active 0")).toHaveTextContent(
      "Active0",
    );
    expect(
      within(toolbar as HTMLElement).queryByText(response.query),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Query"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Sort"),
    ).not.toBeInTheDocument();
    expect(
      within(card as HTMLElement).getByRole("form", { name: "New task" }),
    ).toBeInTheDocument();
    const autoGroup = within(toolbar as HTMLElement).getByRole("group", {
      name: "Auto fix controls",
    });
    expect(autoGroup).toHaveAttribute("data-auto-control");
    expect(autoGroup).toContainElement(
      within(toolbar as HTMLElement).getByRole("combobox", {
        name: "Auto maximum parallelism",
      }),
    );
    expect(
      within(toolbar as HTMLElement).getByText(/Updated/),
    ).toBeInTheDocument();
    expect(toolbar?.querySelector("time")).toHaveAttribute(
      "datetime",
      response.generatedAt,
    );
    const refresh = within(toolbar as HTMLElement).getByRole("button", {
      name: "Refresh",
    });
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveClass("min-h-11", "sm:min-h-7");
    expect(refresh).not.toHaveClass("rounded-md");
    expect(refresh).toHaveAttribute("data-slot", "button");
    expect(refresh.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps Auto unavailable or disabled until a trustworthy snapshot loads, then baselines without dispatching", async () => {
    installWebLocks();
    const deferred = createDeferred<PullsResponse>();
    const response = createPullsResponse();
    getPullsMock.mockReturnValueOnce(deferred.promise);

    render(<App />);

    const auto = screen.getByRole("button", { name: "Auto" });
    expect(auto).toBeDisabled();
    expect(auto).toHaveAttribute("aria-pressed", "false");
    expect(auto).toHaveAttribute("data-auto-status", "disabled");
    const descriptionId = auto.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "complete, current pull request snapshot",
    );

    await act(async () => deferred.resolve(response));
    await waitFor(() => expect(auto).toBeEnabled());
    fireEvent.click(auto);

    await waitFor(() => {
      expect(auto).toHaveAttribute("aria-pressed", "true");
      expect(auto).toHaveAttribute("data-auto-status", "watching");
    });
    expect(auto).toHaveClass("bg-emerald-500/10");
    expect(auto.querySelector("[data-auto-indicator]")).toBeInTheDocument();
    const parallelism = screen.getByRole("combobox", {
      name: "Auto maximum parallelism",
    });
    expect(parallelism).toBeEnabled();
    expect(parallelism).toHaveTextContent("1×");
    expect(parallelism).toHaveClass(
      "bg-emerald-500/10",
      "dark:bg-emerald-400/10",
    );
    fireEvent.click(parallelism);
    fireEvent.click(await screen.findByRole("option", { name: "4×" }));
    await waitFor(() => expect(parallelism).toHaveTextContent("4×"));
    expect(auto).toHaveAttribute("aria-pressed", "true");
    expect(
      JSON.parse(window.localStorage.getItem("puller-auto-settings")!),
    ).toMatchObject({
      enabled: true,
      parallelism: 4,
      version: 2,
    });
    expect(fixes.stream).not.toHaveBeenCalled();
  });

  it("disables Auto when Web Locks or complete current evidence are unavailable", async () => {
    delete (navigator as unknown as { locks?: LockManager }).locks;
    const response = createPullsResponse();
    getPullsMock.mockResolvedValue(response);

    const view = render(<App />);

    const unavailable = await screen.findByRole("button", { name: "Auto" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("data-auto-status", "unavailable");
    expect(
      document.getElementById(unavailable.getAttribute("aria-describedby")!),
    ).toHaveTextContent("does not support Web Locks");

    view.unmount();
    installWebLocks();
    getPullsMock.mockResolvedValue({
      ...response,
      partial: true,
      warnings: ["Some pull requests could not be fully evaluated."],
    });
    render(<App />);

    const incomplete = await screen.findByRole("button", { name: "Auto" });
    expect(incomplete).toBeDisabled();
    expect(
      document.getElementById(incomplete.getAttribute("aria-describedby")!),
    ).toHaveTextContent("complete, current pull request snapshot");
  });

  it("dispatches a new blocker as an Auto fix and immediately moves the canonical row into progress", async () => {
    installWebLocks();
    const ready = createPullsResponse().ready[0]!;
    const changed = withNewComment(ready);
    const gate = createDeferred<void>();
    mockGatedRun(gate.promise, "auto-run", "Fixing the new blocker.\n");
    getPullsMock
      .mockResolvedValueOnce(responseWith([ready], []))
      .mockResolvedValueOnce(responseWith([changed], []));

    render(<App />);

    await screen.findByText(ready.title);
    const auto = screen.getByRole("button", { name: "Auto" });
    fireEvent.click(auto);
    await waitFor(() =>
      expect(auto).toHaveAttribute("data-auto-status", "watching"),
    );
    expect(fixes.stream).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await within(getSection("In progress")).findByText(ready.title),
    ).toBeInTheDocument();
    expect(fixes.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        number: ready.number,
        parallelism: 1,
        repository: ready.repository,
        source: "auto",
        triggers: [
          expect.objectContaining({
            id: "new-auto-comment",
            kind: "issue_comment",
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(
      (await screen.findAllByText("Auto fix running")).length,
    ).toBeGreaterThan(0);
    expect(
      within(getSection("In progress")).getByRole("log", {
        name: `Auto fix output for ${ready.repository} pull request ${ready.number}`,
      }),
    ).toHaveTextContent("Fixing the new blocker.");

    await act(async () => gate.resolve(undefined));
  });

  it("continues watching hidden canonical pull requests", async () => {
    installWebLocks();
    const ready = createPullsResponse().ready[0]!;
    const changed = withNewComment(ready);
    const gate = createDeferred<void>();
    mockGatedRun(gate.promise, "hidden-auto-run");
    getPullsMock
      .mockResolvedValueOnce(responseWith([ready], []))
      .mockResolvedValueOnce(responseWith([changed], []));

    render(<App />);

    await screen.findByText(ready.title);
    const auto = screen.getByRole("button", { name: "Auto" });
    fireEvent.click(auto);
    await waitFor(() =>
      expect(auto).toHaveAttribute("data-auto-status", "watching"),
    );
    openPullActions(ready.title);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(ready.title)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fixes.stream).toHaveBeenCalledOnce());
    expect(fixes.stream.mock.calls[0]![0]).toMatchObject({
      number: ready.number,
      source: "auto",
    });
    expect(screen.queryByText(ready.title)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage 1 hidden pull request" }),
    ).toBeInTheDocument();

    await act(async () => gate.resolve(undefined));
  });

  it("exposes a queued Auto issue as an accessible paused status while a manual fix is active", async () => {
    installWebLocks();
    const blocked = createPullsResponse().notReady[0]!;
    const changed = withNewComment(blocked);
    const gate = createDeferred<void>();
    mockGatedRun(gate.promise, "manual-run");
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(responseWith([], [changed]));

    render(<App />);

    await screen.findByText(blocked.title);
    const auto = screen.getByRole("button", { name: "Auto" });
    fireEvent.click(auto);
    await waitFor(() =>
      expect(auto).toHaveAttribute("data-auto-status", "watching"),
    );
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", {
        name: "Run fix",
      }),
    );
    await within(getSection("In progress")).findByText(blocked.title);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(auto).toHaveAttribute("data-auto-status", "paused"),
    );
    expect(auto.querySelector("[data-auto-indicator]")).toHaveClass(
      "bg-amber-500",
    );
    expect(
      document.getElementById(auto.getAttribute("aria-describedby")!),
    ).toHaveTextContent("1 Auto issue is waiting for an active task or retry.");
    expect(fixes.stream).toHaveBeenCalledOnce();
    expect(fixes.stream.mock.calls[0]![0]).toMatchObject({ source: "manual" });

    await act(async () => gate.resolve(undefined));
  });

  it("renders exclusive groups in fixed order with global ranks and accurate counts", async () => {
    const response = createPullsResponse();
    const pending = createPendingPull(1);
    const firstBlocked = {
      ...response.notReady[0]!,
      rank: 4,
    };
    const secondBlocked = {
      ...response.notReady[0]!,
      number: 104,
      rank: 2,
      title: "Resolve another blocked pull",
      url: "https://github.com/appwrite/cloud/pull/104",
    };
    const ready = { ...response.ready[0]!, rank: 3 };
    getPullsMock.mockResolvedValue(
      responseWith([ready], [firstBlocked, pending, secondBlocked]),
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Ready" });
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Ready", "In progress", "Not ready", "Recently released"]);

    const readySection = getSection("Ready");
    const progressSection = getSection("In progress");
    const blockedSection = getSection("Not ready");
    const readyCount = within(readySection).getByLabelText("1 pull request");
    expect(readyCount).toHaveTextContent("1");
    expect(readyCount).toHaveAttribute("data-slot", "badge");
    expect(
      within(progressSection).getByLabelText("1 pull request"),
    ).toHaveTextContent("1");
    expect(
      within(blockedSection).getByLabelText("2 pull requests"),
    ).toHaveTextContent("2");
    expect(
      within(readySection).getByRole("list", {
        name: "Ready pull requests",
      }),
    ).toBeInTheDocument();
    expect(
      within(progressSection).getByRole("list", {
        name: "In progress pull requests",
      }),
    ).toBeInTheDocument();
    const blockedList = within(blockedSection).getByRole("list", {
      name: "Not ready pull requests",
    });
    expect(blockedList).toBeInTheDocument();
    expect(within(readySection).getByText(ready.title)).toBeInTheDocument();
    expect(
      within(progressSection).getByText(pending.title),
    ).toBeInTheDocument();
    expect(
      within(blockedSection).queryByText(pending.title),
    ).not.toBeInTheDocument();
    const blockedLinks = within(blockedList).getAllByRole("link");
    expect(blockedLinks.map((link) => link.textContent)).toEqual([
      secondBlocked.title,
      firstBlocked.title,
    ]);
    expect(screen.getAllByText(ready.title)).toHaveLength(1);
    expect(screen.getAllByText(pending.title)).toHaveLength(1);
    expect(screen.getAllByText(secondBlocked.title)).toHaveLength(1);
    expect(screen.getAllByText(firstBlocked.title)).toHaveLength(1);
    expect(screen.getAllByText("CI checks failed")).toHaveLength(2);
  });

  it("favourites a pull from its context menu and stably moves the same row to the top", async () => {
    const template = createPullsResponse().ready[0]!;
    const first: PullReadiness = {
      ...template,
      number: 201,
      rank: 1,
      title: "First ready pull",
      url: "https://github.com/appwrite/cloud/pull/201",
    };
    const second: PullReadiness = {
      ...template,
      number: 202,
      rank: 2,
      title: "Second ready pull",
      url: "https://github.com/appwrite/cloud/pull/202",
    };
    getPullsMock.mockResolvedValue(responseWith([first, second], []));

    render(<App />);

    await screen.findByRole("heading", { name: "Ready" });
    const list = await within(getSection("Ready")).findByRole("list", {
      name: "Ready pull requests",
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining(first.title),
      expect.stringContaining(second.title),
    ]);
    const originalSecondRow = getPullRow(second.title);

    openPullActions(second.title);
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Favourite" }),
    );

    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
        second.title,
      ),
    );
    expect(getPullRow(second.title)).toBe(originalSecondRow);
    expect(
      within(getPullRow(second.title)).getByLabelText("Favourite pull request"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Open 2")).toHaveTextContent("Open2");
  });

  it("hides immediately, survives polling, and restores a pull without changing the open count", async () => {
    const pull = createPullsResponse().ready[0]!;
    const response = responseWith([pull], []);
    getPullsMock.mockResolvedValue(response);

    render(<App />);

    await screen.findByText(pull.title);
    openPullActions(pull.title);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "All open pull requests are hidden.",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(pull.title)).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", {
        name: "Manage 1 hidden pull request",
      }),
    ).toHaveTextContent("Hidden 1");
    expect(screen.getByLabelText("Open 1")).toHaveTextContent("Open1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(pull.title)).not.toBeInTheDocument();

    openHiddenPulls(1);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `Show ${pull.repository} #${pull.number}`,
      }),
    );

    expect(await screen.findByText(pull.title)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", {
          name: "All open pull requests are hidden.",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("restores every current hidden pull through Show all", async () => {
    const template = createPullsResponse().ready[0]!;
    const first: PullReadiness = {
      ...template,
      number: 301,
      rank: 1,
      title: "Hidden pull one",
      url: "https://github.com/appwrite/cloud/pull/301",
    };
    const second: PullReadiness = {
      ...template,
      number: 302,
      rank: 2,
      title: "Hidden pull two",
      url: "https://github.com/appwrite/cloud/pull/302",
    };
    getPullsMock.mockResolvedValue(responseWith([first, second], []));
    render(<App />);

    await screen.findByText(first.title);
    openPullActions(first.title);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(first.title)).not.toBeInTheDocument(),
    );

    openPullActions(second.title);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(second.title)).not.toBeInTheDocument(),
    );

    openHiddenPulls(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all" }));

    expect(await screen.findByText(first.title)).toBeInTheDocument();
    expect(await screen.findByText(second.title)).toBeInTheDocument();
    expect(
      within(getSection("Ready")).getByLabelText("2 pull requests"),
    ).toHaveTextContent("2");
    expect(
      screen.queryByRole("button", { name: /hidden pull requests/i }),
    ).not.toBeInTheDocument();
  });

  it("renders restored tasks in progress even when there are no authored pulls", async () => {
    const task = restoredTask();
    getPullsMock.mockResolvedValue(responseWith([], []));
    taskActions.list.mockResolvedValue([task]);
    taskActions.stream.mockImplementation(async function* (
      _id: string,
      _after: number,
      signal?: AbortSignal,
    ): AsyncGenerator<TaskEvent, void, undefined> {
      yield {
        id: task.id,
        sequence: 1,
        stream: "stdout",
        text: "Streaming from Claude.\n",
        type: "output",
      };
      await waitForAbort(signal as AbortSignal);
    });

    render(<App />);

    const progress = await screen.findByRole("heading", {
      name: "In progress",
    });
    const section = progress.closest("section") as HTMLElement;
    expect(within(section).getByText(task.title)).toBeInTheDocument();
    expect(within(section).getByRole("log")).toHaveTextContent(
      "Streaming from Claude.",
    );
    expect(
      within(section).getByRole("link", { name: /Build a new task feature/ }),
    ).toHaveAttribute("href", task.pullRequest?.url);
    expect(
      screen.queryByRole("heading", {
        name: "No open authored pull requests.",
      }),
    ).not.toBeInTheDocument();
  });

  it.each(["pending", "failed"] as const)(
    "keeps restored tasks actionable when the pull snapshot is %s",
    async (outcome) => {
      const task = restoredTask();
      if (outcome === "pending") {
        getPullsMock.mockReturnValue(
          new Promise<PullsResponse>(() => undefined),
        );
      } else {
        getPullsMock.mockRejectedValue(new Error("GitHub is unavailable"));
      }
      taskActions.list.mockResolvedValue([task]);
      taskActions.stream.mockImplementation(async function* (
        _id: string,
        _after: number,
        signal?: AbortSignal,
      ): AsyncGenerator<TaskEvent, void, undefined> {
        yield {
          id: task.id,
          sequence: 1,
          stream: "stdout",
          text: "Still running after reload.\n",
          type: "output",
        };
        await waitForAbort(signal as AbortSignal);
      });

      render(<App />);

      const section = (
        await screen.findByRole("heading", { name: "In progress" })
      ).closest("section") as HTMLElement;
      expect(within(section).getByText(task.title)).toBeInTheDocument();
      expect(within(section).getByRole("log")).toHaveTextContent(
        "Still running after reload.",
      );
      expect(
        within(section).getByRole("button", { name: "Cancel task" }),
      ).toBeEnabled();
      if (outcome === "failed") {
        expect(
          await screen.findByRole("heading", {
            name: "The pull request snapshot is unavailable.",
          }),
        ).toBeInTheDocument();
      }
    },
  );

  it("deduplicates an authored task PR without losing task output or cancellation", async () => {
    const ready = createPullsResponse().ready[0]!;
    const task = restoredTask(ready);
    getPullsMock.mockResolvedValue(responseWith([ready], []));
    taskActions.list.mockResolvedValue([task]);
    taskActions.stream.mockImplementation(async function* (
      _id: string,
      _after: number,
      signal?: AbortSignal,
    ): AsyncGenerator<TaskEvent, void, undefined> {
      await waitForAbort(signal as AbortSignal);
    });

    render(<App />);

    await waitFor(() =>
      expect(
        within(getSection("In progress")).getByText(task.title),
      ).toBeInTheDocument(),
    );
    expect(
      within(getSection("Ready")).queryByText(ready.title),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(ready.title)).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent(
      "Waiting for Claude Code…",
    );
    expect(
      screen.getByRole("button", { name: "Cancel task" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run fix" }),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-task-id]")).toHaveLength(1);
  });

  it("applies preferences to task-backed PRs while leaving pre-PR tasks visible and untouched", async () => {
    const ready = createPullsResponse().ready[0]!;
    const backed: Task = {
      ...restoredTask(ready),
      createdAt: "2026-07-22T00:00:00.000Z",
      id: "backed-task",
      title: "Task with an open pull request",
    };
    const withoutPull: Task = {
      ...restoredTask(),
      createdAt: "2026-07-22T01:00:00.000Z",
      id: "pre-pr-task",
      title: "Task still opening its pull request",
    };
    delete withoutPull.pullRequest;
    getPullsMock.mockResolvedValue(responseWith([ready], []));
    taskActions.list.mockResolvedValue([backed, withoutPull]);
    taskActions.stream.mockImplementation(async function* (
      id: string,
      _after: number,
      signal?: AbortSignal,
    ): AsyncGenerator<TaskEvent, void, undefined> {
      yield {
        id,
        sequence: 1,
        stream: "stdout",
        text: `${id} output remains attached.\n`,
        type: "output",
      };
      await waitForAbort(signal as AbortSignal);
    });

    render(<App />);

    await screen.findByRole("heading", { name: "In progress" });
    const list = await within(getSection("In progress")).findByRole("list", {
      name: "In progress items",
    });
    await within(list).findByText(backed.title);
    await within(list).findByText(withoutPull.title);
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
      withoutPull.title,
    );
    expect(
      getPullRow(withoutPull.title).querySelector(
        "[data-slot='pull-actions-trigger']",
      ),
    ).not.toBeInTheDocument();
    const originalBackedRow = getPullRow(backed.title);

    openPullActions(backed.title);
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Favourite" }),
    );
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
        backed.title,
      ),
    );
    expect(getPullRow(backed.title)).toBe(originalBackedRow);

    openPullActions(backed.title);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(backed.title)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(withoutPull.title)).toBeInTheDocument();
    expect(taskActions.cancel).not.toHaveBeenCalled();

    openHiddenPulls(1);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `Show ${backed.repository} #${backed.pullRequest?.number}`,
      }),
    );

    const restored = await screen.findByText(backed.title);
    expect(
      within(restored.closest("li") as HTMLElement).getByRole("log"),
    ).toHaveTextContent("backed-task output remains attached.");
    expect(
      within(restored.closest("li") as HTMLElement).getByLabelText(
        "Favourite pull request",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    {
      phase: "completed" as const,
      pull: createPullsResponse().ready[0]!,
      section: "Ready" as const,
    },
    {
      phase: "failed" as const,
      pull: createPullsResponse().notReady[0]!,
      section: "Not ready" as const,
    },
    {
      phase: "cancelled" as const,
      pull: createPendingPull(1),
      section: "In progress" as const,
    },
  ])(
    "returns a matching $phase task PR to its GitHub-derived $section row",
    async ({ phase, pull, section }) => {
      const task: Task = {
        ...restoredTask(pull),
        ...(phase === "completed" ? {} : { error: `Task ${phase}.` }),
        phase,
      };
      getPullsMock.mockResolvedValue(
        pull.ready ? responseWith([pull], []) : responseWith([], [pull]),
      );
      taskActions.list.mockResolvedValue([task]);
      taskActions.stream.mockImplementation(async function* (): AsyncGenerator<
        TaskEvent,
        void,
        undefined
      > {});

      render(<App />);

      await waitFor(() =>
        expect(
          within(getSection(section)).getByText(pull.title),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByText(task.title)).not.toBeInTheDocument();
      expect(document.querySelector("[data-task-id]")).not.toBeInTheDocument();
      expect(screen.getAllByText(pull.title)).toHaveLength(1);
    },
  );

  it("uses a wider pull column and a date-grouped release column on desktop", async () => {
    getPullsMock.mockResolvedValue(createPullsResponse());
    getRecentReleasesMock.mockResolvedValue(
      releaseResponse([createRecentRelease("one", [41])]),
    );
    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "Recently released" });
    const columns = container.querySelector<HTMLElement>(
      "[data-dashboard-columns]",
    );
    const pulls = container.querySelector<HTMLElement>("[data-pull-column]");
    const releases = container.querySelector<HTMLElement>(
      "[data-release-column]",
    );

    expect(columns).toHaveClass(
      "grid",
      "lg:grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.8fr)]",
    );
    expect(columns).toContainElement(pulls);
    expect(columns).toContainElement(releases);
    expect(
      container.querySelector('[data-release-date="2026-07-21"]'),
    ).toBeInTheDocument();
  });

  it("removes an exactly merged pull before the background refresh resolves", async () => {
    const response = responseWith([createPullsResponse().ready[0]!], []);
    const refresh = createDeferred<PullsResponse>();
    getPullsMock
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(() => refresh.promise);
    actions.merge.mockResolvedValue({
      mergeCommitOid: "dddddddddddddddddddddddddddddddddddddddd",
      merged: true,
      number: response.ready[0]!.number,
      repository: response.ready[0]!.repository,
      url: response.ready[0]!.url,
    });
    render(<App />);

    await screen.findByText(response.ready[0]!.title);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Admin merge" }));

    await waitFor(() =>
      expect(
        screen.queryByText(response.ready[0]!.title),
      ).not.toBeInTheDocument(),
    );
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    refresh.resolve(response);
    await flushPromises();
    expect(
      screen.queryByText(response.ready[0]!.title),
    ).not.toBeInTheDocument();
  });

  it("keeps an exact merge tombstone for stale later snapshots while allowing a new head", async () => {
    const merged = createPullsResponse().ready[0]!;
    const initial = responseWith([merged], []);
    const omitted = responseWith([], []);
    const stale = { ...initial, stale: true };
    const replacement: PullReadiness = {
      ...merged,
      headRefOid: "dddddddddddddddddddddddddddddddddddddddd",
      title: "Updated pull after the merge",
    };
    getPullsMock
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(omitted)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(responseWith([replacement], []));
    actions.merge.mockResolvedValue({
      mergeCommitOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      merged: true,
      number: merged.number,
      repository: merged.repository,
      url: merged.url,
    });
    render(<App />);

    await screen.findByText(merged.title);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Admin merge" }));

    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(merged.title)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(merged.title)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(4));
    expect(
      await screen.findByText("Updated pull after the merge"),
    ).toBeInTheDocument();
    expect(screen.queryByText(merged.title)).not.toBeInTheDocument();
  });

  it("moves a conflicted Ready pull into In progress as repair observation starts", async () => {
    const response = responseWith([createPullsResponse().ready[0]!], []);
    getPullsMock.mockResolvedValue(response);
    actions.merge.mockResolvedValue({
      action: {
        deduplicated: false,
        id: "repair-1",
        state: "repair_queued",
        token: "a".repeat(43),
        type: "repair_queued",
      },
      headRefOid: response.ready[0]!.headRefOid,
      merged: false,
      number: response.ready[0]!.number,
      repository: response.ready[0]!.repository,
      url: response.ready[0]!.url,
    });
    actions.streamRepair.mockImplementation(async function* () {
      yield {
        actionId: "repair-1",
        headRefOid: response.ready[0]!.headRefOid,
        number: response.ready[0]!.number,
        output: "Repair queued.\n",
        repository: response.ready[0]!.repository,
        state: "repair_queued",
        terminal: false,
        type: "snapshot",
        updatedAt: "2026-07-21T08:00:00.000Z",
      };
    });
    render(<App />);

    await screen.findByText(response.ready[0]!.title);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Admin merge" }));

    await waitFor(() =>
      expect(
        within(getSection("In progress")).getByText(response.ready[0]!.title),
      ).toBeInTheDocument(),
    );
    expect(
      within(getSection("Ready")).queryByText(response.ready[0]!.title),
    ).not.toBeInTheDocument();
    expect(actions.streamRepair).toHaveBeenCalledWith(
      expect.objectContaining({ id: "repair-1", token: "a".repeat(43) }),
      expect.objectContaining({ headRefOid: response.ready[0]!.headRefOid }),
      expect.any(AbortSignal),
    );
  });

  it("does not rerender an unrelated pull for streamed run output", async () => {
    const first = createPullsResponse().notReady[0]!;
    const second: PullReadiness = {
      ...first,
      number: first.number + 1,
      rank: first.rank + 1,
      url: `${first.url}-unrelated`,
    };
    let titleReads = 0;
    Object.defineProperty(second, "title", {
      configurable: true,
      enumerable: true,
      get: () => {
        titleReads += 1;
        return "Unrelated blocked pull";
      },
    });
    const nextChunk = createDeferred<void>();
    const finish = createDeferred<void>();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "render-stability",
        type: "start",
      };
      await nextChunk.promise;
      yield { text: "A later streamed chunk.\n", type: "text" };
      await finish.promise;
      yield { exitCode: 0, type: "complete" };
    });
    getPullsMock.mockResolvedValue(responseWith([], [first, second]));

    render(<App />);

    await screen.findByText("Unrelated blocked pull");
    const firstRow = screen.getByText(first.title).closest("li");
    expect(firstRow).not.toBeNull();
    fireEvent.click(
      within(firstRow as HTMLElement).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(first.title);
    const readsAfterReparent = titleReads;

    await act(async () => {
      nextChunk.resolve(undefined);
      await nextChunk.promise;
    });
    await waitFor(() =>
      expect(
        within(getSection("In progress")).getByRole("log"),
      ).toHaveTextContent("A later streamed chunk."),
    );

    expect(titleReads).toBe(readsAfterReparent);
    await act(async () => {
      finish.resolve(undefined);
      await finish.promise;
    });
  });

  it("preserves viewed files across section moves and resets them for a new head or removed pull", async () => {
    const ready = createPullsResponse().ready[0]!;
    const progress: PullReadiness = {
      ...ready,
      blockers: ["CI checks pending"],
      ci: {
        ...ready.ci,
        failed: 0,
        passed: 0,
        running: 1,
        state: "pending",
        total: 1,
      },
      ready: false,
    };
    const changed: PullReadiness = {
      ...ready,
      greptile: {
        ...ready.greptile,
        reviewedSha: "dddddddddddddddddddddddddddddddddddddddd",
      },
      headRefOid: "dddddddddddddddddddddddddddddddddddddddd",
    };
    const blocked: PullReadiness = {
      ...ready,
      blockers: ["CI checks failed"],
      ci: {
        ...ready.ci,
        failed: 1,
        passed: 0,
        running: 0,
        state: "failure",
        total: 1,
      },
      ready: false,
    };
    getPullsMock
      .mockResolvedValueOnce(responseWith([ready], []))
      .mockResolvedValueOnce(responseWith([], [progress]))
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(responseWith([ready], []))
      .mockResolvedValueOnce(responseWith([changed], []))
      .mockResolvedValueOnce(responseWith([], []))
      .mockResolvedValueOnce(responseWith([changed], []));
    getPullDiffMock.mockImplementation(async (pull) => diffFor(pull));

    render(<App />);

    await screen.findByRole("heading", { name: "Ready" });
    expect(
      within(getSection("Ready")).getByText(ready.title),
    ).toBeInTheDocument();
    fireEvent.click(
      within(getSection("Ready")).getByRole("button", {
        name: "Files changed",
      }),
    );
    fireEvent.click(
      await within(getSection("Ready")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    );
    expect(
      within(getSection("Ready")).getByText("1 of 1 files viewed"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await within(getSection("In progress")).findByText(progress.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("In progress")).getByRole("button", {
        name: "Files changed",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(getSection("In progress")).getByRole("button", {
        name: "Files changed",
      }),
    );
    expect(
      await within(getSection("In progress")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(getSection("In progress")).getByText("1 of 1 files viewed"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await within(getSection("Not ready")).findByText(blocked.title);
    expect(
      within(getSection("Not ready")).getByRole("button", {
        name: "Files changed",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", {
        name: "Files changed",
      }),
    );
    expect(
      await within(getSection("Not ready")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(getSection("Not ready")).getByRole("button", {
        name: "Show blocker details",
      }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await within(getSection("Ready")).findByText(ready.title);
    expect(
      within(getSection("Ready")).getByRole("button", {
        name: "Files changed",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(getSection("Ready")).getByRole("button", {
        name: "Files changed",
      }),
    );
    expect(
      await within(getSection("Ready")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(getSection("Ready")).getByText("1 of 1 files viewed"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullDiffMock).toHaveBeenCalledTimes(5));
    expect(
      await within(getSection("Ready")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      within(getSection("Ready")).getByText("0 of 1 files viewed"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(getSection("Ready")).getByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("heading", {
        name: "No open authored pull requests.",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(changed.title)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(
      within(getSection("Ready")).getByText(changed.title),
    ).toBeInTheDocument();
    fireEvent.click(
      within(getSection("Ready")).getByRole("button", {
        name: "Files changed",
      }),
    );
    expect(
      await within(getSection("Ready")).findByRole("checkbox", {
        name: "Viewed public/logo.png",
      }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      within(getSection("Ready")).getByText("0 of 1 files viewed"),
    ).toBeInTheDocument();
  });

  it("renders accessible skeleton cards while the initial snapshot is loading", async () => {
    const pending = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock.mockReturnValue(pending.promise);

    const { container } = render(<App />);

    const loading = await screen.findByRole("heading", {
      name: "Loading pull requests…",
    });
    const section = loading.closest("section");
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByText(
        "Checking review threads, CI checks, and Greptile confidence.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "is:pr author:@me state:open archived:false sort:updated-desc",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
    expect(
      [...container.querySelectorAll("[data-loading-section]")].map((item) =>
        item.getAttribute("data-loading-section"),
      ),
    ).toEqual(["Ready", "In progress", "Not ready"]);
    skeletons.forEach((skeleton) => {
      expect(skeleton.closest('[aria-hidden="true"]')).not.toBeNull();
    });

    await act(async () => {
      pending.resolve(createPullsResponse());
      await pending.promise;
    });
    expect(
      await screen.findByRole("heading", { name: "Ready" }),
    ).toBeInTheDocument();
  });

  it("retains the last good snapshot and reports every warning when a manual refresh fails", async () => {
    getPullsMock
      .mockResolvedValueOnce({
        ...createPullsResponse(),
        partial: true,
        stale: true,
        warnings: ["One repository could not be evaluated."],
      })
      .mockRejectedValueOnce(new Error("network down"));

    render(<App />);

    expect(
      await screen.findByText("Make readiness signals explicit"),
    ).toBeInTheDocument();
    const initialNotice = screen
      .getByText("This snapshot is stale.")
      .closest('[role="status"]');
    expect(initialNotice).not.toBeNull();
    expect(
      within(initialNotice as HTMLElement).getByText(
        "Some pull requests could not be fully evaluated.",
      ),
    ).toBeInTheDocument();
    expect(
      within(initialNotice as HTMLElement).getByText(
        "One repository could not be evaluated.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Refresh failed: network down/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Make readiness signals explicit"),
    ).toBeInTheDocument();
  });

  it("hides passive refresh and revalidation notices while retaining actionable warnings", async () => {
    const hidden = [
      "GitHub returned incomplete evidence for appwrite-labs/cloud#4908; the pull request was not updated.",
      "GitHub returned incomplete evidence for appwrite-labs/cloud#4908.",
      "GitHub changed CI while refreshing appwrite-labs/cloud#4908; readiness was marked incomplete.",
      "GitHub returned conflicting CI state for appwrite-labs/cloud#4908; readiness was marked incomplete.",
      "GitHub could not refresh appwrite-labs/cloud#4908; readiness was marked incomplete.",
      "GitHub could not completely revalidate this pull request.",
      "GitHub could not completely revalidate appwrite-labs/cloud#4908; readiness was not updated.",
    ];
    const neighboring = [
      "GitHub changed CI while refreshing appwrite-labs/cloud#4908; readiness was marked incomplete. Please retry.",
      "GitHub changed CI while refreshing appwrite_labs/cloud#4908; readiness was marked incomplete.",
      "GitHub changed CI while refreshing appwrite-labs/cloud#0; readiness was marked incomplete.",
      "A repository could not be evaluated.",
    ];
    getPullsMock.mockResolvedValue({
      ...createPullsResponse(),
      warnings: [...hidden, ...neighboring],
    });

    render(<App />);
    await screen.findByText("Make readiness signals explicit");

    for (const warning of hidden) {
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
    }
    for (const warning of neighboring) {
      expect(screen.getByText(warning)).toBeInTheDocument();
    }
  });

  it.each(["network-error", "stale", "partial", "viewer-unavailable"] as const)(
    "unmounts a loaded artifact after an untrusted %s readiness observation",
    async (outcome) => {
      const pull = createPullsResponse().ready[0]!;
      const initial = responseWith([pull], []);
      getPullsMock.mockResolvedValueOnce(initial);
      if (outcome === "network-error") {
        getPullsMock.mockRejectedValueOnce(
          new Error("readiness network failed"),
        );
      } else {
        getPullsMock.mockResolvedValueOnce({
          ...initial,
          partial: outcome === "partial",
          stale: outcome === "stale",
          viewerLogin:
            outcome === "viewer-unavailable" ? null : initial.viewerLogin,
        });
      }
      getPullDiffMock.mockResolvedValue(diffFor(pull));

      render(<App />);

      await screen.findByText(pull.title);
      fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
      expect(
        await screen.findByRole("checkbox", { name: "Viewed public/logo.png" }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      if (outcome === "network-error") {
        await screen.findByText(/Refresh failed: readiness network failed/);
      } else if (outcome === "stale") {
        await screen.findByText("This snapshot is stale.");
      } else if (outcome === "partial") {
        await screen.findByText(
          "Some pull requests could not be fully evaluated.",
        );
      } else {
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Files changed" }),
          ).toBeDisabled(),
        );
      }

      expect(
        screen.queryByRole("checkbox", { name: "Viewed public/logo.png" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Files changed" }),
      ).toBeDisabled();
      expect(getPullDiffMock).toHaveBeenCalledOnce();
    },
  );

  it("renders the initial error with an alert and a manual retry action", async () => {
    getPullsMock.mockRejectedValue(new Error("GitHub is unavailable"));

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("heading", {
        name: "The pull request snapshot is unavailable.",
      }),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText("GitHub is unavailable"),
    ).toBeInTheDocument();
    const retry = within(alert).getByRole("button", { name: "Try again" });
    expect(retry).toHaveClass("min-h-11", "sm:min-h-7");
    expect(retry).not.toHaveClass("rounded-md");
    fireEvent.click(retry);
    expect(getPullsMock).toHaveBeenNthCalledWith(
      2,
      true,
      expect.any(AbortSignal),
    );
  });

  it("renders global and per-section empty states without losing section semantics", async () => {
    const empty = createPullsResponse();
    getPullsMock.mockResolvedValueOnce({
      ...empty,
      counts: { notReady: 0, ready: 0, total: 0 },
      notReady: [],
      ready: [],
    });

    const view = render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "No open authored pull requests.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The current GitHub query returned no results."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Ready" }),
    ).not.toBeInTheDocument();

    view.unmount();
    getPullsMock.mockResolvedValueOnce({
      ...empty,
      counts: { ...empty.counts, ready: 0 },
      ready: [],
    });
    const sections = render(<App />);

    const readyHeading = await screen.findByRole("heading", { name: "Ready" });
    const readySection = readyHeading.closest("section");
    expect(readySection).not.toBeNull();
    expect(
      within(readySection as HTMLElement).getByText(
        "No pulls meet every readiness check.",
      ),
    ).toBeInTheDocument();
    expect(
      within(readySection as HTMLElement).queryByRole("list", {
        name: "Ready pull requests",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(getSection("In progress")).getByText(
        "No CI checks or local fixes are in progress.",
      ),
    ).toBeInTheDocument();

    sections.unmount();
    getPullsMock.mockResolvedValueOnce(responseWith(empty.ready, []));
    render(<App />);

    await screen.findByRole("heading", { name: "Ready" });
    expect(
      within(getSection("Not ready")).getByText(
        "No pull requests are waiting on fixes.",
      ),
    ).toBeInTheDocument();
  });

  it("moves a started fix into progress without aborting and retains its prompt, output, and terminal logs", async () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    const gate = createDeferred<void>();
    const getSignal = mockGatedRun(gate.promise);
    getPullsMock.mockResolvedValue(response);

    render(<App />);

    await screen.findByRole("heading", { name: "Not ready" });
    const prompt = "Resolve every unresolved review thread.";
    fireEvent.change(
      within(getSection("Not ready")).getByRole("textbox", {
        name: `Fix instructions for ${blocked.repository} #${blocked.number}`,
      }),
      { target: { value: prompt } },
    );
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );

    expect(
      await within(getSection("In progress")).findByText(blocked.title),
    ).toBeInTheDocument();
    expect(getSignal()?.aborted).toBe(false);
    expect(
      within(getSection("In progress")).getByRole("textbox", {
        name: `Fix instructions for ${blocked.repository} #${blocked.number}`,
      }),
    ).toHaveValue(prompt);
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("Working on the pull request.");
    expect(
      within(getSection("Not ready")).queryByText(blocked.title),
    ).not.toBeInTheDocument();

    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });

    expect(
      await within(getSection("Not ready")).findByText(blocked.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("Not ready")).getByText("Completed"),
    ).toBeInTheDocument();
    expect(within(getSection("Not ready")).getByRole("log")).toHaveTextContent(
      "Working on the pull request.",
    );
    expect(
      within(getSection("Not ready")).getByRole("textbox", {
        name: `Fix instructions for ${blocked.repository} #${blocked.number}`,
      }),
    ).toHaveValue(prompt);
  });

  it("moves a Ready pull into progress and streams diff feedback as a Review fix", async () => {
    const ready = createPullsResponse().ready[0]!;
    const gate = createDeferred<void>();
    mockGatedRun(
      gate.promise,
      "review-run",
      "Applying the selected diff feedback.\n",
    );
    getPullsMock.mockResolvedValue(responseWith([ready], []));
    getPullDiffMock.mockResolvedValue(reviewDiffFor(ready));

    render(<App />);

    await screen.findByRole("heading", { name: "Ready" });
    await within(getSection("Ready")).findByText(ready.title);
    fireEvent.click(
      within(getSection("Ready")).getByRole("button", {
        name: "Files changed",
      }),
    );
    fireEvent.click(
      await within(getSection("Ready")).findByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(
      within(getSection("Ready")).getByRole("textbox", {
        name: "Claude feedback on new line 2",
      }),
      { target: { value: "Keep the new readiness transition covered." } },
    );
    fireEvent.click(
      within(getSection("Ready")).getByRole("button", {
        name: "Run review fix",
      }),
    );

    const progress = getSection("In progress");
    expect(await within(progress).findByText(ready.title)).toBeInTheDocument();
    expect(fixes.stream).toHaveBeenCalledWith(
      {
        expectedBaseRefOid: ready.baseRefOid,
        expectedHeadRefOid: ready.headRefOid,
        feedback: {
          body: "Keep the new readiness transition covered.",
          line: 2,
          path: "src/readiness.ts",
          side: "RIGHT",
        },
        message: "",
        number: ready.number,
        repository: ready.repository,
        source: "review",
      },
      expect.any(AbortSignal),
    );
    expect(
      within(progress).getAllByText(/Review fix (starting|running)/).length,
    ).toBeGreaterThan(0);
    expect(
      within(progress).getByRole("log", {
        name: `Review fix output for ${ready.repository} pull request ${ready.number}`,
      }),
    ).toHaveTextContent("Applying the selected diff feedback.");
    expect(within(getSection("Ready")).queryByText(ready.title)).toBeNull();

    await act(async () => gate.resolve(undefined));
  });

  it("keeps a CI-pending pull in progress after its local run completes", async () => {
    const pending = createPendingPull(1);
    getPullsMock.mockResolvedValue(responseWith([], [pending]));
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-pending",
        type: "start",
      };
      yield { text: "CI should remain pending.\n", type: "text" };
      yield { exitCode: 0, type: "complete" };
    });

    render(<App />);

    await screen.findByText(pending.title);
    expect(
      within(getSection("In progress")).getByText(pending.title),
    ).toBeInTheDocument();
    fireEvent.change(within(getSection("In progress")).getByRole("textbox"), {
      target: { value: "Prepare the pull while CI finishes." },
    });
    fireEvent.click(
      within(getSection("In progress")).getByRole("button", {
        name: "Run fix",
      }),
    );

    expect(
      await within(getSection("In progress")).findByText("Completed"),
    ).toBeInTheDocument();
    expect(
      within(getSection("In progress")).getByText(pending.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("Not ready")).queryByText(pending.title),
    ).not.toBeInTheDocument();
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("CI should remain pending.");
  });

  it("keeps an active refreshed pull in progress and moves it to Ready on completion", async () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    const readyTemplate = response.ready[0]!;
    const ready: PullReadiness = {
      ...readyTemplate,
      headRefOid: blocked.headRefOid,
      number: blocked.number,
      rank: blocked.rank,
      title: blocked.title,
      url: blocked.url,
    };
    const gate = createDeferred<void>();
    const getSignal = mockGatedRun(gate.promise, "run-ready");
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(responseWith([ready], []));

    render(<App />);

    await screen.findByText(blocked.title);
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: "Finish the readiness work." },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    expect(
      await within(getSection("In progress")).findByText(blocked.title),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(2));
    expect(
      within(getSection("In progress")).getByText(blocked.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("Ready")).queryByText(blocked.title),
    ).not.toBeInTheDocument();
    expect(getSignal()?.aborted).toBe(false);

    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });

    expect(
      await within(getSection("Ready")).findByText(blocked.title),
    ).toBeInTheDocument();
    expect(within(getSection("Ready")).getByRole("log")).toHaveTextContent(
      "Working on the pull request.",
    );
    expect(
      within(getSection("In progress")).queryByText(blocked.title),
    ).not.toBeInTheDocument();
  });

  it("preserves an active run across a refreshed head SHA for the same pull URL", async () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    const changed: PullReadiness = {
      ...blocked,
      headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
      title: "Keep the updated deployment head synchronized",
    };
    const gate = createDeferred<void>();
    const getSignal = mockGatedRun(
      gate.promise,
      "run-new-head",
      "Head work persists.\n",
    );
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(responseWith([], [changed]));

    render(<App />);

    await screen.findByText(blocked.title);
    const prompt = "Keep this run attached by pull URL.";
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: prompt },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(blocked.title);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await within(getSection("In progress")).findByText(changed.title),
    ).toBeInTheDocument();
    expect(getSignal()?.aborted).toBe(false);
    expect(within(getSection("In progress")).getByRole("textbox")).toHaveValue(
      prompt,
    );
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("Head work persists.");
    expect(fixes.stream).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadRefOid: blocked.headRefOid }),
      expect.any(AbortSignal),
    );

    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    expect(
      await within(getSection("Not ready")).findByText(changed.title),
    ).toBeInTheDocument();
    expect(within(getSection("Not ready")).getByRole("log")).toHaveTextContent(
      "Head work persists.",
    );
  });

  it("aborts and purges a removed run without rendering a ghost when the pull returns", async () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    let streamSignal: AbortSignal | undefined;
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
      streamSignal = signal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-removed",
        type: "start",
      };
      yield { text: "This output must be purged.\n", type: "text" };
      if (signal) {
        await waitForAbort(signal);
      }
    });
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(responseWith([], []))
      .mockResolvedValueOnce(responseWith([], [blocked]));

    render(<App />);

    await screen.findByText(blocked.title);
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: "This prompt must be purged too." },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(blocked.title);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByRole("heading", {
        name: "No open authored pull requests.",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(fixes.cancel).toHaveBeenCalledWith(
        "run-removed",
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(blocked.title)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(blocked.title)).toBeInTheDocument();
    expect(within(getSection("Not ready")).getByRole("textbox")).toHaveValue(
      "",
    );
    expect(
      within(getSection("Not ready")).queryByRole("log"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("This output must be purged."),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(blocked.title)).toHaveLength(1);
  });

  it("reconciles runs only after successful replacement snapshots", async () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    const gate = createDeferred<void>();
    const getSignal = mockGatedRun(
      gate.promise,
      "run-failed-refresh",
      "Keep this output after refresh failure.\n",
    );
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockRejectedValueOnce(new Error("temporary refresh failure"));

    render(<App />);

    await screen.findByText(blocked.title);
    const prompt = "Keep this prompt after refresh failure.";
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: prompt },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(blocked.title);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Refresh failed: temporary refresh failure/),
    ).toBeInTheDocument();
    expect(getSignal()?.aborted).toBe(false);
    expect(within(getSection("In progress")).getByRole("textbox")).toHaveValue(
      prompt,
    );
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("Keep this output after refresh failure.");

    await act(async () => {
      gate.resolve(undefined);
      await gate.promise;
    });
    expect(
      await within(getSection("Not ready")).findByText(blocked.title),
    ).toBeInTheDocument();
  });

  it("retains an active run through a partial omission until a complete snapshot removes it", async () => {
    const blocked = createPullsResponse().notReady[0]!;
    const prompt = "Keep this active run through incomplete snapshots.";
    const partial = {
      ...responseWith([], []),
      partial: true,
      warnings: ["The partial snapshot omitted some pull requests."],
    };
    let streamSignal: AbortSignal | undefined;
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
      streamSignal = signal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-partial-omission",
        type: "start",
      };
      yield { text: "State retained across partial data.\n", type: "text" };
      if (signal) {
        await waitForAbort(signal);
      }
    });
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(responseWith([], []))
      .mockResolvedValueOnce(responseWith([], [blocked]));

    render(<App />);

    await screen.findByText(blocked.title);
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: prompt },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(blocked.title);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(
        "The partial snapshot omitted some pull requests.",
      ),
    ).toBeInTheDocument();
    expect(streamSignal?.aborted).toBe(false);
    expect(fixes.cancel).not.toHaveBeenCalled();
    expect(within(getSection("In progress")).getByRole("textbox")).toHaveValue(
      prompt,
    );
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("State retained across partial data.");
    expect(screen.getAllByText(blocked.title)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByRole("heading", {
        name: "No open authored pull requests.",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    await waitFor(() => expect(fixes.cancel).toHaveBeenCalledTimes(1));
    expect(fixes.cancel).toHaveBeenCalledWith(
      "run-partial-omission",
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(screen.queryByText(blocked.title)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(blocked.title)).toBeInTheDocument();
    expect(within(getSection("Not ready")).getByRole("textbox")).toHaveValue(
      "",
    );
    expect(
      within(getSection("Not ready")).queryByRole("log"),
    ).not.toBeInTheDocument();
    expect(fixes.cancel).toHaveBeenCalledTimes(1);
  });

  it("retains an active row, signal, prompt, and output through a stale omission", async () => {
    const blocked = createPullsResponse().notReady[0]!;
    const stale = {
      ...responseWith([], []),
      stale: true,
      warnings: ["The stale snapshot omitted a known pull request."],
    };
    let streamSignal: AbortSignal | undefined;
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<ClaudeRunEvent, void, undefined> {
      streamSignal = signal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-stale-omission",
        type: "start",
      };
      yield { text: "State retained across stale data.\n", type: "text" };
      if (signal) {
        await waitForAbort(signal);
      }
    });
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce(stale);
    const view = render(<App />);

    await screen.findByText(blocked.title);
    fireEvent.change(within(getSection("Not ready")).getByRole("textbox"), {
      target: { value: "Keep this prompt through stale data." },
    });
    fireEvent.click(
      within(getSection("Not ready")).getByRole("button", { name: "Run fix" }),
    );
    await within(getSection("In progress")).findByText(blocked.title);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("This snapshot is stale."),
    ).toBeInTheDocument();
    expect(streamSignal?.aborted).toBe(false);
    expect(fixes.cancel).not.toHaveBeenCalled();
    expect(within(getSection("In progress")).getByRole("textbox")).toHaveValue(
      "Keep this prompt through stale data.",
    );
    expect(
      within(getSection("In progress")).getByRole("log"),
    ).toHaveTextContent("State retained across stale data.");
    expect(screen.getAllByText(blocked.title)).toHaveLength(1);

    view.unmount();
  });

  it("updates present partial records while retaining omitted known pulls without duplicates", async () => {
    const response = createPullsResponse();
    const present = { ...response.notReady[0]!, rank: 2 };
    const omitted: PullReadiness = {
      ...response.notReady[0]!,
      number: 104,
      rank: 4,
      title: "Retain this omitted pull request",
      url: "https://github.com/appwrite/cloud/pull/104",
    };
    const ready = { ...response.ready[0]!, rank: 3 };
    const changed: PullReadiness = {
      ...present,
      blockers: ["CI checks pending"],
      ci: { state: "pending" },
      rank: 1,
      title: "Use the title and CI from the partial snapshot",
    };
    getPullsMock
      .mockResolvedValueOnce(responseWith([ready], [present, omitted]))
      .mockResolvedValueOnce({
        ...responseWith([], [changed]),
        partial: true,
        warnings: ["Some records were omitted."],
      });

    render(<App />);

    await screen.findByText(present.title);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(changed.title)).toBeInTheDocument();
    expect(
      within(getSection("In progress")).getByText(changed.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("Ready")).getByText(ready.title),
    ).toBeInTheDocument();
    expect(
      within(getSection("Not ready")).getByText(omitted.title),
    ).toBeInTheDocument();
    expect(screen.getAllByText(changed.title)).toHaveLength(1);
    expect(screen.getAllByText(ready.title)).toHaveLength(1);
    expect(screen.getAllByText(omitted.title)).toHaveLength(1);
    expect(screen.getByLabelText("Open 3")).toHaveTextContent("Open3");
  });

  it("shows trusted readiness movement for one minute without changing pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T04:00:00.000Z"));
    const source = createPullsResponse();
    const blocked = source.notReady[0]!;
    const promoted: PullReadiness = {
      ...blocked,
      blockers: [],
      ci: source.ready[0]!.ci,
      ready: true,
      unresolved: 0,
    };
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValue(responseWith([promoted], []));

    render(<App />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flushPromises();

    expect(
      screen.getByLabelText("Moved up from Not ready to Ready"),
    ).toHaveAttribute("data-movement-direction", "up");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(
      screen.getByLabelText("Moved up from Not ready to Ready"),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      screen.queryByLabelText("Moved up from Not ready to Ready"),
    ).not.toBeInTheDocument();
  });

  it("does not invent movement from an incomplete snapshot or its next baseline", async () => {
    const source = createPullsResponse();
    const blocked = source.notReady[0]!;
    const promoted: PullReadiness = {
      ...blocked,
      blockers: [],
      ci: source.ready[0]!.ci,
      ready: true,
      unresolved: 0,
    };
    getPullsMock
      .mockResolvedValueOnce(responseWith([], [blocked]))
      .mockResolvedValueOnce({
        ...responseWith([promoted], []),
        partial: true,
      })
      .mockResolvedValueOnce(responseWith([promoted], []));

    render(<App />);
    await screen.findByText(blocked.title);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(promoted.title);
    expect(
      document.querySelector("[data-pull-movement]"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getPullsMock).toHaveBeenCalledTimes(3));
    expect(
      document.querySelector("[data-pull-movement]"),
    ).not.toBeInTheDocument();
  });

  it("reconciles partial release identities and pulls until a complete catalog removes them", async () => {
    const first = createRecentRelease("one", [11, 12]);
    const second = createRecentRelease("two", [21]);
    const incoming = { ...first, pulls: [first.pulls[0]!] };
    getPullsMock.mockResolvedValue(createPullsResponse());
    getRecentReleasesMock
      .mockResolvedValueOnce(releaseResponse([first, second]))
      .mockResolvedValueOnce(releaseResponse([incoming], true))
      .mockResolvedValueOnce(releaseResponse([incoming]));

    render(<App />);

    expect(await screen.findByText("Released pull 12")).toBeInTheDocument();
    expect(screen.getByText("Released pull 21")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getRecentReleasesMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Released pull 12")).toBeInTheDocument();
    expect(screen.getByText("Released pull 21")).toBeInTheDocument();
    const partialHistory = screen.getByRole("button", {
      name: "Partial history",
    });
    expect(partialHistory).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText(
        /partial refresh omitted previously known pull requests/,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/release was omitted from the partial refresh/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getRecentReleasesMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryByText("Released pull 12")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Released pull 21")).not.toBeInTheDocument();
    expect(screen.getByText("Released pull 11")).toBeInTheDocument();
  });

  it("keeps ten-second polling visually silent while retaining the current rows", async () => {
    vi.useFakeTimers();
    const background = createDeferred<ReturnType<typeof createPullsResponse>>();
    const passive = [
      "GitHub returned incomplete evidence for appwrite-labs/cloud#4908; the pull request was not updated.",
      "GitHub changed CI while refreshing appwrite-labs/cloud#4908; readiness was marked incomplete.",
      "GitHub could not completely revalidate this pull request.",
    ];
    getPullsMock
      .mockResolvedValueOnce(createPullsResponse())
      .mockReturnValueOnce(background.promise);

    const { container } = render(<App />);
    await flushPromises();
    expect(
      screen.getByText("Make readiness signals explicit"),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL);
    });

    expect(getPullsMock).toHaveBeenCalledTimes(2);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toBeEnabled();
    expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin");
    expect(
      screen.queryByRole("button", { name: "Refreshing" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Make readiness signals explicit"),
    ).toBeInTheDocument();

    await act(async () => {
      background.resolve({ ...createPullsResponse(), warnings: passive });
      await background.promise;
    });
    expect(
      container.querySelector("[data-dashboard-notices]"),
    ).not.toBeInTheDocument();
    for (const warning of passive) {
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
    }
  });

  it("shows refresh activity only for an explicit manual request", async () => {
    const manual = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock
      .mockResolvedValueOnce(createPullsResponse())
      .mockReturnValueOnce(manual.promise);

    render(<App />);
    await screen.findByText("Make readiness signals explicit");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const refreshing = screen.getByRole("button", { name: "Refreshing" });
    expect(refreshing).toBeDisabled();
    expect(refreshing.querySelector("svg")).toHaveClass("animate-spin");

    await act(async () => {
      manual.resolve(createPullsResponse());
      await manual.promise;
    });
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("bypasses the cache manually and restarts the ten-second deadline on completion", async () => {
    vi.useFakeTimers();
    getPullsMock.mockResolvedValue(createPullsResponse());

    render(<App />);
    await flushPromises();
    expect(getPullsMock).toHaveBeenNthCalledWith(
      1,
      false,
      expect.any(AbortSignal),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL / 2);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flushPromises();
    expect(getPullsMock).toHaveBeenNthCalledWith(
      2,
      true,
      expect.any(AbortSignal),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL - 1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getPullsMock).toHaveBeenNthCalledWith(
      3,
      true,
      expect.any(AbortSignal),
    );
  });

  it("schedules from completion and never overlaps requests", async () => {
    vi.useFakeTimers();
    const first = createDeferred<ReturnType<typeof createPullsResponse>>();
    const second = createDeferred<ReturnType<typeof createPullsResponse>>();
    const third = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    render(<App />);
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(createPullsResponse());
      await first.promise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL - 1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(createPullsResponse());
      await second.promise;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(3);
  });

  it("pauses hidden-tab work and refreshes when an overdue tab becomes visible", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    getPullsMock.mockResolvedValue(createPullsResponse());

    render(<App />);
    await flushPromises();
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the StrictMode lifecycle and leaves no timer after unmount", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock.mockReturnValue(pending.promise);

    const { unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(getPullsMock).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      pending.resolve(createPullsResponse());
      await pending.promise;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);
  });
});
