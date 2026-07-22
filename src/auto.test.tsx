// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_SETTINGS_STORAGE_KEY,
  getAutoEvidenceStorageKey,
  useAuto,
  type AutoInput,
} from "./auto";
import type { AutoParallelism, AutoTrigger } from "./fixes";
import {
  IDLE_RUN_STATE,
  type RunStartOutcome,
  type StartRunOptions,
} from "./runs";
import type { TaskState } from "./tasks";
import { createPendingPull, createPullsResponse } from "./test/fixtures";
import type { PullReadiness } from "./types";

type LockCallback = (lock: Lock) => unknown | Promise<unknown>;

type LockWaiter = {
  callback: LockCallback;
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  signal?: AbortSignal;
};

class LockHarness {
  readonly calls: string[] = [];
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, LockWaiter[]>();

  readonly manager = {
    query: async () => ({ held: [], pending: [] }),
    request: (
      name: string,
      options: LockOptions,
      callback: LockCallback,
    ): Promise<unknown> => {
      this.calls.push(name);
      return new Promise((resolve, reject) => {
        const waiter: LockWaiter = {
          callback,
          reject,
          resolve,
          signal: options.signal,
        };
        if (options.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const queue = this.waiters.get(name) ?? [];
        queue.push(waiter);
        this.waiters.set(name, queue);
        options.signal?.addEventListener(
          "abort",
          () => {
            const current = this.waiters.get(name);
            if (!current || !current.includes(waiter) || this.active.has(name)) {
              return;
            }
            this.waiters.set(
              name,
              current.filter((item) => item !== waiter),
            );
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        this.drain(name);
      });
    },
  } as unknown as LockManager;

  private drain(name: string): void {
    if (this.active.has(name)) return;
    const queue = this.waiters.get(name);
    const waiter = queue?.shift();
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      waiter.reject(new DOMException("Aborted", "AbortError"));
      this.drain(name);
      return;
    }
    this.active.add(name);
    void Promise.resolve(
      waiter.callback({ mode: "exclusive", name } as Lock),
    ).then(waiter.resolve, waiter.reject).finally(() => {
      this.active.delete(name);
      this.drain(name);
    });
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
const originalVisibility = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

const settings = (
  epoch = "test-epoch",
  parallelism: AutoParallelism = 1,
): void => {
  window.localStorage.setItem(
    AUTO_SETTINGS_STORAGE_KEY,
    JSON.stringify({ enabled: true, epoch, parallelism, version: 2 }),
  );
};

const acceptedEquivalent = (): RunStartOutcome => ({
  code: "auto_triggers_running",
  kind: "accepted-equivalent",
  message: "Accepted by the existing automatic run.",
  source: "auto",
});

const runInput = (
  start: AutoInput["runs"]["start"] = vi.fn(async () => acceptedEquivalent()),
): AutoInput["runs"] => ({ states: new Map(), start });

const input = (
  pulls: readonly PullReadiness[],
  overrides: Partial<AutoInput> = {},
): AutoInput => ({
  authoritative: true,
  pulls,
  runs: runInput(),
  tasks: [],
  viewerLogin: "jake",
  ...overrides,
});

const addIssue = (
  pull: PullReadiness,
  id = "ordinary-comment",
  updatedAt = "2026-07-22T01:00:00.000Z",
): PullReadiness => ({
  ...pull,
  issueComments: [
    ...pull.issueComments,
    {
      author: "reviewer",
      body: "Please fix this.",
      createdAt: updatedAt,
      id,
      updatedAt,
      url: `${pull.url}#issuecomment-${id}`,
    },
  ],
});

const failed = (pull: PullReadiness): PullReadiness => ({
  ...pull,
  ci: {
    ...pull.ci,
    checks: (pull.ci.checks ?? []).map((check, index) =>
      index === 0 ? { ...check, state: "failure" as const } : check,
    ),
    failed: 1,
    running: 0,
    state: "failure",
  },
  ready: false,
});

const setVisibility = (value: "hidden" | "visible"): void => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const distinctPulls = (count: number): PullReadiness[] => {
  const first = createPullsResponse().ready[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...first,
    number: first.number + index,
    rank: index + 1,
    title: `${first.title} ${index + 1}`,
    url: `${first.repositoryUrl}/pull/${first.number + index}`,
  }));
};

beforeEach(() => {
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
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  const locks = new LockHarness();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks.manager,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else delete (navigator as unknown as { locks?: LockManager }).locks;
  if (originalVisibility) {
    Object.defineProperty(document, "visibilityState", originalVisibility);
  }
});

describe("useAuto", () => {
  it("reports unavailable and never dispatches without Web Locks", async () => {
    delete (navigator as unknown as { locks?: LockManager }).locks;
    settings();
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const view = renderHook(() =>
      useAuto(input([createPullsResponse().ready[0]!], { runs: runInput(start) })),
    );

    expect(view.result.current.available).toBe(false);
    expect(view.result.current.status).toBe("unavailable");
    expect(view.result.current.description).toMatch(/Web Locks/);
    expect(start).not.toHaveBeenCalled();
  });

  it("baselines existing blockers, then coalesces new comments, replies, Greptile, and CI evidence", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));
    expect(start).not.toHaveBeenCalled();

    const updatedAt = "2026-07-22T02:00:00.000Z";
    const changed: PullReadiness = failed({
      ...addIssue(baseline),
      checks: { commentsComplete: true, threadsComplete: true },
      greptile: {
        ...baseline.greptile,
        body: "Confidence: 3/5",
        confidence: 3,
        current: true,
        reviewedSha: baseline.headRefOid,
        updatedAt,
      },
      issueComments: [
        ...addIssue(baseline).issueComments.filter(
          (comment) => comment.id !== baseline.greptile.commentId,
        ),
        {
          ...baseline.issueComments[0]!,
          body: "Confidence: 3/5",
          updatedAt,
        },
      ],
      unresolved: 1,
      unresolvedThreads: [
        {
          author: "reviewer",
          body: "Please cover this.",
          comments: [
            {
              author: "reviewer",
              body: "Please cover this.",
              createdAt: updatedAt,
              id: "review-new",
              line: 4,
              outdated: false,
              path: "src/auto.ts",
              updatedAt,
              url: `${baseline.url}#discussion-new`,
            },
          ],
          createdAt: updatedAt,
          id: "thread-new",
          line: 4,
          outdated: false,
          path: "src/auto.ts",
          url: `${baseline.url}#discussion-new`,
        },
      ],
    });
    view.rerender({ ...initial, pulls: [changed] });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const options = start.mock.calls[0]![1];
    expect(options).toMatchObject({ message: "", source: "auto" });
    const triggers = options?.triggers as readonly AutoTrigger[];
    expect(triggers.map((trigger) => trigger.kind).sort()).toEqual([
      "failed_check",
      "greptile",
      "issue_comment",
      "review_comment",
    ]);
    expect(
      triggers.some(
        (trigger) =>
          trigger.kind === "issue_comment" &&
          trigger.id === baseline.greptile.commentId,
      ),
    ).toBe(false);
  });

  it("dispatches edited comments and newly appearing pulls after the baseline", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const first = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: first,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    const appeared = addIssue(
      { ...baseline, number: 999, rank: 2, url: `${baseline.repositoryUrl}/pull/999` },
      "appeared",
    );
    view.rerender({ ...first, pulls: [baseline, appeared] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![0].number).toBe(999);

    const edited = addIssue(
      baseline,
      "edited",
      "2026-07-22T03:00:00.000Z",
    );
    view.rerender({ ...first, pulls: [edited, appeared] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![0].number).toBe(baseline.number);
  });

  it("never treats any Greptile-authored issue comment as an ordinary comment", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const olderGreptile = {
      author: "greptile-apps",
      body: "Review queued.",
      createdAt: "2026-07-21T01:00:00.000Z",
      id: "older-greptile-comment",
      updatedAt: "2026-07-21T01:00:00.000Z",
      url: `${baseline.url}#issuecomment-older-greptile-comment`,
    };
    const start = vi.fn(
      async (): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const initial = input(
      [{ ...baseline, issueComments: [...baseline.issueComments, olderGreptile] }],
      { runs: runInput(start) },
    );
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...initial,
      pulls: [
        {
          ...initial.pulls[0]!,
          issueComments: [
            ...baseline.issueComments,
            {
              ...olderGreptile,
              body: "Review still queued.",
              updatedAt: "2026-07-22T01:00:00.000Z",
            },
          ],
        },
      ],
    });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();
  });

  it("never treats Greptile-authored review replies as generic review incidents", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    const updatedAt = "2026-07-22T01:00:00.000Z";
    view.rerender({
      ...initial,
      pulls: [
        {
          ...baseline,
          ready: false,
          unresolved: 1,
          unresolvedThreads: [
            {
              author: "GREPTILE-APPS",
              body: "Automated review status.",
              comments: [
                {
                  author: "GREPTILE-APPS",
                  body: "Automated review status.",
                  createdAt: updatedAt,
                  id: "greptile-review-reply",
                  line: 3,
                  outdated: false,
                  path: "src/auto.ts",
                  updatedAt,
                  url: `${baseline.url}#discussion-greptile`,
                },
              ],
              createdAt: updatedAt,
              id: "greptile-thread",
              line: 3,
              outdated: false,
              path: "src/auto.ts",
              url: `${baseline.url}#discussion-greptile`,
            },
          ],
        },
      ],
    });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();
  });

  it("uses CI failure sequences so unchanged failures do not loop and clear-to-failure retriggers", async () => {
    settings();
    const pending = createPendingPull();
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const first = input([pending], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: first,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    const failure = failed(pending);
    view.rerender({ ...first, pulls: [failure] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    view.rerender({ ...first, pulls: [{ ...failure }] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();

    view.rerender({ ...first, pulls: [pending] });
    await act(async () => Promise.resolve());
    view.rerender({ ...first, pulls: [failure] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("queues by canonical rank and waits for an accepted run to finish", async () => {
    settings();
    const response = createPullsResponse();
    const firstPull = response.ready[0]!;
    const secondPull = {
      ...firstPull,
      number: 202,
      rank: 2,
      url: `${firstPull.repositoryUrl}/pull/202`,
    };
    let complete!: (status: "completed") => void;
    const completion = new Promise<"completed">((resolve) => {
      complete = resolve;
    });
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        completion,
        kind: "accepted",
        runId: "auto-1",
        source: "auto",
        status: "running",
      })
      .mockResolvedValue(acceptedEquivalent());
    const first = input([firstPull, secondPull], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: first,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...first,
      pulls: [addIssue(secondPull, "second"), addIssue(firstPull, "first")],
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![0].number).toBe(firstPull.number);
    expect(view.result.current.status).toBe("running");

    await act(async () => complete("completed"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![0].number).toBe(secondPull.number);
  });

  it("launches four distinct pulls concurrently and holds the fifth until capacity opens", async () => {
    settings("parallel-four", 4);
    const pulls = distinctPulls(5);
    const completions = pulls.map(() => deferred<"completed">());
    let launchIndex = 0;
    const start = vi.fn<AutoInput["runs"]["start"]>(async (): Promise<RunStartOutcome> => {
      const completion = completions[launchIndex]!;
      launchIndex += 1;
      return {
        completion: completion.promise,
        kind: "accepted",
        runId: `auto-${launchIndex}`,
        source: "auto",
        status: "running",
      };
    });
    const initial = input(pulls, { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));

    view.rerender({
      ...initial,
      pulls: pulls.map((pull, index) => addIssue(pull, `parallel-${index}`)),
    });

    await waitFor(() => expect(start).toHaveBeenCalledTimes(4));
    expect(start.mock.calls.map(([pull]) => pull.url)).toEqual(
      pulls.slice(0, 4).map((pull) => pull.url),
    );
    expect(new Set(start.mock.calls.map(([pull]) => pull.url)).size).toBe(4);
    expect(
      start.mock.calls.every(([, options]) => options?.parallelism === 4),
    ).toBe(true);
    expect(view.result.current.description).toBe(
      "Auto is fixing 4 pull requests.",
    );

    await act(async () => completions[0]!.resolve("completed"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(5));
    expect(start.mock.calls[4]![0].url).toBe(pulls[4]!.url);
  });

  it("counts rendered Auto runs together with local claims before admitting more work", async () => {
    settings("active-union", 2);
    const pulls = distinctPulls(3);
    const completion = deferred<"completed">();
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      completion: completion.promise,
      kind: "accepted",
      runId: "new-auto-run",
      source: "auto",
      status: "running",
    }));
    const states = new Map([
      [
        pulls[0]!.url,
        {
          ...IDLE_RUN_STATE,
          source: "auto" as const,
          status: "running" as const,
        },
      ],
    ]);
    const initial = input(pulls, { runs: { start, states } });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...initial,
      pulls: pulls.map((pull, index) => addIssue(pull, `union-${index}`)),
    });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![0].url).toBe(pulls[1]!.url);
    expect(view.result.current.description).toBe(
      "Auto is fixing 2 pull requests.",
    );
  });

  it("fills immediately when parallelism increases and does not cancel work when it decreases", async () => {
    settings("live-parallelism", 2);
    const pulls = distinctPulls(5);
    const completions = pulls.map(() => deferred<"completed">());
    let launchIndex = 0;
    const start = vi.fn<AutoInput["runs"]["start"]>(async (): Promise<RunStartOutcome> => {
      const index = launchIndex;
      launchIndex += 1;
      return {
        completion: completions[index]!.promise,
        kind: "accepted",
        runId: `auto-${index}`,
        source: "auto",
        status: "running",
      };
    });
    const initial = input(pulls, { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));
    view.rerender({
      ...initial,
      pulls: pulls.map((pull, index) => addIssue(pull, `live-${index}`)),
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    act(() => view.result.current.setParallelism(4));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(4));
    expect(start.mock.calls.slice(0, 2).map(([, options]) => options?.parallelism)).toEqual([
      2,
      2,
    ]);
    expect(start.mock.calls.slice(2).map(([, options]) => options?.parallelism)).toEqual([
      4,
      4,
    ]);

    act(() => view.result.current.setParallelism(1));
    expect(view.result.current.parallelism).toBe(1);
    for (const completion of completions.slice(0, 3)) {
      await act(async () => completion.resolve("completed"));
    }
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledTimes(4);

    await act(async () => completions[3]!.resolve("completed"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(5));
    expect(start.mock.calls[4]![1]?.parallelism).toBe(1);
  });

  it("continues through every queued pull after an equivalent run acceptance", async () => {
    settings();
    const firstPull = createPullsResponse().ready[0]!;
    const secondPull = {
      ...firstPull,
      number: 203,
      rank: 2,
      url: `${firstPull.repositoryUrl}/pull/203`,
    };
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([firstPull, secondPull], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...initial,
      pulls: [addIssue(firstPull, "first"), addIssue(secondPull, "second")],
    });

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls.map(([pull]) => pull.number)).toEqual([
      firstPull.number,
      secondPull.number,
    ]);
  });

  it("suppresses a pull while a manual, repair, or New Task run is active", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const states = new Map([[baseline.url, { ...IDLE_RUN_STATE, status: "running" as const }]]);
    const first = input([baseline], { runs: { start, states } });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: first,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    const changed = addIssue(baseline);
    view.rerender({ ...first, pulls: [changed] });
    await waitFor(() => expect(view.result.current.paused).toBe(true));
    expect(start).not.toHaveBeenCalled();

    const task: TaskState = {
      cancelling: false,
      connectionError: null,
      output: "",
      sequence: 0,
      task: {
        base: "main",
        createdAt: "2026-07-22T01:00:00.000Z",
        id: "task-1",
        phase: "running",
        pullRequest: { number: baseline.number, url: baseline.url },
        repository: baseline.repository,
        title: "New task",
        updatedAt: "2026-07-22T01:00:00.000Z",
      },
    };
    view.rerender({
      ...first,
      pulls: [changed],
      runs: { start, states: new Map() },
      tasks: [task],
    });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();

    view.rerender({
      ...first,
      pulls: [changed],
      runs: { start, states: new Map() },
      tasks: [],
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("resumes persisted evidence after reload but rebaselines after disable and re-enable", async () => {
    settings("persisted");
    const baseline = createPullsResponse().ready[0]!;
    const changed = addIssue(baseline);
    const firstStart = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => ({
        code: "workspace_running",
        kind: "retryable",
        message: "Busy",
        source: "auto",
      }),
    );
    const first = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: input([baseline], { runs: runInput(firstStart) }),
    });
    await waitFor(() => expect(first.result.current.leader).toBe(true));
    first.rerender(input([changed], { runs: runInput(firstStart) }));
    await waitFor(() => expect(firstStart).toHaveBeenCalledOnce());
    first.unmount();

    const resumedStart = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const resumed = renderHook(() =>
      useAuto(input([changed], { runs: runInput(resumedStart) })),
    );
    await waitFor(() => expect(resumedStart).toHaveBeenCalledOnce(), {
      timeout: 2_500,
    });
    resumed.result.current.setEnabled(false);
    await waitFor(() => expect(resumed.result.current.enabled).toBe(false));
    resumed.result.current.setEnabled(true);
    await waitFor(() => expect(resumed.result.current.status).toBe("watching"));
    expect(resumedStart).toHaveBeenCalledOnce();
  });

  it("migrates v1 settings and keeps parallelism in sync across reloads and storage events", async () => {
    window.localStorage.setItem(
      AUTO_SETTINGS_STORAGE_KEY,
      JSON.stringify({ enabled: true, epoch: "legacy-epoch", version: 1 }),
    );
    const pull = createPullsResponse().ready[0]!;
    const first = renderHook(() => useAuto(input([pull])));

    await waitFor(() => expect(first.result.current.leader).toBe(true));
    expect(first.result.current.parallelism).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(AUTO_SETTINGS_STORAGE_KEY)!)).toEqual({
      enabled: true,
      epoch: "legacy-epoch",
      parallelism: 1,
      version: 2,
    });

    act(() => first.result.current.setParallelism(3));
    expect(first.result.current.parallelism).toBe(3);
    const persisted = JSON.parse(
      window.localStorage.getItem(AUTO_SETTINGS_STORAGE_KEY)!,
    );
    expect(persisted).toMatchObject({
      enabled: true,
      epoch: "legacy-epoch",
      parallelism: 3,
      version: 2,
    });
    first.unmount();

    const reloaded = renderHook(() => useAuto(input([pull])));
    expect(reloaded.result.current.parallelism).toBe(3);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTO_SETTINGS_STORAGE_KEY,
          newValue: JSON.stringify({
            enabled: true,
            epoch: "legacy-epoch",
            parallelism: 4,
            version: 2,
          }),
        }),
      );
    });
    expect(reloaded.result.current.parallelism).toBe(4);
    expect(reloaded.result.current.enabled).toBe(true);
  });

  it("keeps valid migrated v1 settings in memory when persistence fails", () => {
    window.localStorage.setItem(
      AUTO_SETTINGS_STORAGE_KEY,
      JSON.stringify({ enabled: true, epoch: "legacy-epoch", version: 1 }),
    );
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage is unavailable.");
      });

    const view = renderHook(() => useAuto(input([])));

    expect(view.result.current.enabled).toBe(true);
    expect(view.result.current.parallelism).toBe(1);
    expect(setItem).toHaveBeenCalledWith(
      AUTO_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        enabled: true,
        epoch: "legacy-epoch",
        parallelism: 1,
        version: 2,
      }),
    );
    setItem.mockRestore();
  });

  it("ignores completion callbacks from a generation that lost leadership", async () => {
    settings("leader-loss", 1);
    const pulls = distinctPulls(2);
    const completion = deferred<"completed">();
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      completion: completion.promise,
      kind: "accepted",
      runId: "old-generation",
      source: "auto",
      status: "running",
    }));
    const initial = input(pulls, { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({
      ...initial,
      pulls: pulls.map((pull, index) => addIssue(pull, `loss-${index}`)),
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    act(() => setVisibility("hidden"));
    await waitFor(() => expect(view.result.current.leader).toBe(false));
    await act(async () => completion.resolve("completed"));
    await act(async () => Promise.resolve());

    expect(start).toHaveBeenCalledOnce();
    expect(view.result.current.status).toBe("paused");
  });

  it("hands leadership to one waiting hook and releases it when the page hides", async () => {
    const locks = new LockHarness();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks.manager,
    });
    settings();
    const pull = createPullsResponse().ready[0]!;
    const first = renderHook(() => useAuto(input([pull])));
    const second = renderHook(() => useAuto(input([pull])));
    await waitFor(() => expect(first.result.current.leader).toBe(true));
    expect(second.result.current.leader).toBe(false);
    first.unmount();
    await waitFor(() => expect(second.result.current.leader).toBe(true));

    act(() => setVisibility("hidden"));
    await waitFor(() => expect(second.result.current.status).toBe("paused"));
    expect(second.result.current.leader).toBe(false);
  });

  it("isolates viewer evidence and only prunes missing pulls from authoritative snapshots", async () => {
    settings();
    const pull = createPullsResponse().ready[0]!;
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: input([pull]),
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    expect(window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))).not.toBeNull();

    view.rerender(input([], { authoritative: false }));
    await act(async () => Promise.resolve());
    expect(
      JSON.parse(
        window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
      ).observed[pull.url],
    ).toBeDefined();

    view.rerender(input([], { authoritative: true }));
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
        ).observed[pull.url],
      ).toBeUndefined(),
    );

    view.rerender(input([pull], { viewerLogin: "octocat" }));
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    expect(
      window.localStorage.getItem(getAutoEvidenceStorageKey("octocat")),
    ).not.toBeNull();
  });

  it("keeps newer incidents pending while another run is busy, then retries with bounded backoff", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        code: "pull_running",
        kind: "retryable",
        message: "The pull already has an active run.",
        source: "auto",
      })
      .mockResolvedValueOnce(acceptedEquivalent());
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());
    view.rerender({ ...initial, pulls: [addIssue(baseline)] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
      ).pending[baseline.url],
    ).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(start).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each(["pull_running", "auto_running"] as const)(
    "keeps an incident queued beyond five %s responses and drains it only after acceptance",
    async (code) => {
      vi.useFakeTimers();
      settings();
      const baseline = createPullsResponse().ready[0]!;
      let attempts = 0;
      const start = vi.fn<AutoInput["runs"]["start"]>(async () => {
        attempts += 1;
        return attempts <= 6
          ? {
              code,
              kind: "retryable",
              message: "Another run still owns the execution lane.",
              source: "auto",
            }
          : acceptedEquivalent();
      });
      const initial = input([baseline], { runs: runInput(start) });
      const view = renderHook((props: AutoInput) => useAuto(props), {
        initialProps: initial,
      });
      await act(async () => Promise.resolve());
      view.rerender({ ...initial, pulls: [addIssue(baseline)] });
      await act(async () => Promise.resolve());
      expect(start).toHaveBeenCalledOnce();

      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      expect(start).toHaveBeenCalledTimes(6);
      expect(
        JSON.parse(
          window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
        ).pending[baseline.url],
      ).toHaveLength(1);

      await act(async () => vi.advanceTimersByTimeAsync(16_000));
      expect(start).toHaveBeenCalledTimes(7);
      expect(
        JSON.parse(
          window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
        ).pending[baseline.url],
      ).toBeUndefined();
    },
  );

  it.each([
    ["rebaseline", { code: "head_changed", kind: "rebaseline", message: "Moved", source: "auto" }],
    ["failed", { code: "invalid", kind: "failed", message: "Rejected", source: "auto" }],
  ] as const)("settles a %s start outcome without looping", async (_name, outcome) => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(async (): Promise<RunStartOutcome> => outcome);
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    const changed = addIssue(baseline);
    view.rerender({ ...initial, pulls: [changed] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    view.rerender({ ...initial, pulls: [{ ...changed }] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
  });

  it("is StrictMode-safe and dispatches one request for one incident", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
      wrapper: StrictMode,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({ ...initial, pulls: [addIssue(baseline)] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });
});
