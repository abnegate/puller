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
            if (
              !current ||
              !current.includes(waiter) ||
              this.active.has(name)
            ) {
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
    void Promise.resolve(waiter.callback({ mode: "exclusive", name } as Lock))
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
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
  agent: "claude",
  authoritative: true,
  pulls,
  refresh: vi.fn(async () => undefined),
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
  blockers: ["1 unresolved comment"],
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
  ready: false,
});

const failed = (pull: PullReadiness): PullReadiness => ({
  ...pull,
  ci: {
    ...pull.ci,
    checks: (pull.ci.checks ?? []).map((check, index) => ({
      ...check,
      state: index === 0 ? ("failure" as const) : ("success" as const),
    })),
    failed: 1,
    passed: Math.max(0, (pull.ci.checks?.length ?? 1) - 1),
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
      useAuto(
        input([createPullsResponse().ready[0]!], { runs: runInput(start) }),
      ),
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

  it("dispatches newly appearing blocked pulls and later edits to known pulls", async () => {
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
      {
        ...baseline,
        number: 999,
        rank: 2,
        url: `${baseline.repositoryUrl}/pull/999`,
      },
      "appeared",
    );
    view.rerender({ ...first, pulls: [baseline, appeared] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![0].number).toBe(999);

    const edited = addIssue(baseline, "edited", "2026-07-22T03:00:00.000Z");
    view.rerender({ ...first, pulls: [edited, appeared] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![0].number).toBe(baseline.number);
  });

  it("persists a newly appearing blocked pull across remount without duplicate dispatch", async () => {
    settings("appeared-remount");
    const baseline = createPullsResponse().ready[0]!;
    const appeared = addIssue(
      {
        ...baseline,
        number: 998,
        rank: 2,
        url: `${baseline.repositoryUrl}/pull/998`,
      },
      "appeared-remount",
    );
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const first = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: input([baseline], { runs: runInput(start) }),
    });
    await waitFor(() => expect(first.result.current.leader).toBe(true));
    first.rerender(
      input([baseline, appeared], {
        runs: runInput(start),
      }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    first.unmount();

    const resumed = renderHook(() =>
      useAuto(
        input([baseline, appeared], {
          runs: runInput(start),
        }),
      ),
    );
    await waitFor(() => expect(resumed.result.current.leader).toBe(true));
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
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
    const start = vi.fn(async (): Promise<RunStartOutcome> =>
      acceptedEquivalent(),
    );
    const initial = input(
      [
        {
          ...baseline,
          issueComments: [...baseline.issueComments, olderGreptile],
        },
      ],
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
    const start = vi.fn(async (): Promise<RunStartOutcome> =>
      acceptedEquivalent(),
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

    const cleared: PullReadiness = {
      ...failure,
      blockers: [],
      ci: {
        ...failure.ci,
        checks: (failure.ci.checks ?? []).map((check) => ({
          ...check,
          state: "success" as const,
        })),
        failed: 0,
        passed: failure.ci.total,
        state: "success",
      },
      ready: true,
    };
    view.rerender({ ...first, pulls: [cleared] });
    await act(async () => Promise.resolve());
    view.rerender({ ...first, pulls: [failure] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("waits for every CI check to settle before dispatching a failed check", async () => {
    settings("pending-failure");
    const baseline = createPullsResponse().ready[0]!;
    const firstCheck = baseline.ci.checks![0]!;
    const progress: PullReadiness = {
      ...baseline,
      blockers: ["CI checks pending"],
      ci: {
        checks: [
          { ...firstCheck, state: "failure" },
          {
            ...firstCheck,
            id: "check-still-running",
            name: "Integration tests",
            state: "pending",
          },
        ],
        complete: true,
        failed: 1,
        passed: 0,
        running: 1,
        state: "pending",
        total: 2,
        unknown: 0,
      },
      ready: false,
    };
    const blocked: PullReadiness = {
      ...progress,
      blockers: ["CI checks failed"],
      ci: {
        ...progress.ci,
        checks: progress.ci.checks!.map((check) =>
          check.id === "check-still-running"
            ? { ...check, state: "success" as const }
            : check,
        ),
        passed: 1,
        running: 0,
        state: "failure",
      },
    };
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));

    view.rerender({ ...initial, pulls: [progress] });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();

    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: firstCheck.id,
        kind: "failed_check",
      }),
    ]);
  });

  it("admits blockers when an initially in-progress pull settles not ready", async () => {
    settings("initial-progress");
    const baseline = createPullsResponse().ready[0]!;
    const firstCheck = baseline.ci.checks![0]!;
    const progress: PullReadiness = {
      ...baseline,
      blockers: ["CI checks pending"],
      ci: {
        checks: [
          { ...firstCheck, state: "failure" },
          {
            ...firstCheck,
            id: "initial-running-check",
            name: "Integration tests",
            state: "pending",
          },
        ],
        complete: true,
        failed: 1,
        passed: 0,
        running: 1,
        state: "pending",
        total: 2,
        unknown: 0,
      },
      ready: false,
    };
    const blocked: PullReadiness = {
      ...progress,
      blockers: ["CI checks failed"],
      ci: {
        ...progress.ci,
        checks: progress.ci.checks!.map((check) =>
          check.id === "initial-running-check"
            ? { ...check, state: "success" as const }
            : check,
        ),
        passed: 1,
        running: 0,
        state: "failure",
      },
    };
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([progress], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));
    expect(start).not.toHaveBeenCalled();

    view.rerender({ ...initial, pulls: [blocked] });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: firstCheck.id,
        kind: "failed_check",
      }),
    ]);
  });

  it("persists incomplete progress without observing it, then admits the blocker once complete", async () => {
    settings("incomplete-progress");
    const baseline = createPullsResponse().ready[0]!;
    const changed = addIssue(
      baseline,
      "incomplete-comment",
      "2026-07-22T04:00:00.000Z",
    );
    const progress: PullReadiness = {
      ...changed,
      checks: { commentsComplete: false, threadsComplete: true },
      ci: {
        ...changed.ci,
        checks: changed.ci.checks!.map((check) => ({
          ...check,
          state: "pending" as const,
        })),
        complete: false,
        running: 1,
        state: "pending",
      },
    };
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({ ...initial, pulls: [progress] });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
      ).observed[baseline.url],
    ).toMatchObject({
      issues: {},
      phase: "progress",
    });

    view.rerender({
      ...initial,
      pulls: [
        {
          ...changed,
          checks: { commentsComplete: true, threadsComplete: true },
        },
      ],
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: "incomplete-comment",
        kind: "issue_comment",
      }),
    ]);
  });

  it("does not loop an accepted Auto identity after progress, but admits a new identity", async () => {
    settings("auto-loop");
    const baseline = createPullsResponse().ready[0]!;
    const blocked = addIssue(
      baseline,
      "first-identity",
      "2026-07-22T05:00:00.000Z",
    );
    const completion = deferred<"completed">();
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        completion: completion.promise,
        kind: "accepted",
        runId: "accepted-auto",
        source: "auto",
        status: "running",
      })
      .mockResolvedValue(acceptedEquivalent());
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    const running = new Map([
      [
        blocked.url,
        {
          ...IDLE_RUN_STATE,
          source: "auto" as const,
          status: "running" as const,
        },
      ],
    ]);
    view.rerender({
      ...initial,
      pulls: [blocked],
      runs: { start, states: running },
    });
    await act(async () => completion.resolve("completed"));
    view.rerender({ ...initial, pulls: [blocked] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();

    view.rerender({
      ...initial,
      pulls: [addIssue(blocked, "second-identity", "2026-07-22T06:00:00.000Z")],
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: "second-identity",
        kind: "issue_comment",
      }),
    ]);
  });

  it("does not relaunch an active Auto incident after disable and re-enable creates a new epoch", async () => {
    settings("disable-active-auto");
    const baseline = createPullsResponse().ready[0]!;
    const blocked = addIssue(
      baseline,
      "owned-auto-identity",
      "2026-07-22T06:30:00.000Z",
    );
    const completion = deferred<"completed">();
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      completion: completion.promise,
      kind: "accepted",
      runId: "owned-auto-run",
      source: "auto",
      status: "running",
    }));
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    const activeRuns = new Map([
      [
        blocked.url,
        {
          ...IDLE_RUN_STATE,
          source: "auto" as const,
          status: "running" as const,
        },
      ],
    ]);
    view.rerender({
      ...initial,
      pulls: [blocked],
      runs: { start, states: activeRuns },
    });
    act(() => view.result.current.setEnabled(false));
    await waitFor(() => expect(view.result.current.enabled).toBe(false));
    act(() => view.result.current.setEnabled(true));
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    expect(start).toHaveBeenCalledOnce();

    await act(async () => completion.resolve("completed"));
    view.rerender({ ...initial, pulls: [blocked] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
  });

  it("admits a new identity observed during an active Auto run after an epoch change", async () => {
    settings("disable-active-auto-new-identity");
    const baseline = createPullsResponse().ready[0]!;
    const blocked = addIssue(
      baseline,
      "owned-auto-identity",
      "2026-07-22T06:30:00.000Z",
    );
    const changed = addIssue(
      blocked,
      "new-during-auto",
      "2026-07-22T06:45:00.000Z",
    );
    const completion = deferred<"completed">();
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        completion: completion.promise,
        kind: "accepted",
        runId: "owned-auto-run",
        source: "auto",
        status: "running",
      })
      .mockResolvedValue(acceptedEquivalent());
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    const activeRuns = new Map([
      [
        blocked.url,
        {
          ...IDLE_RUN_STATE,
          source: "auto" as const,
          status: "running" as const,
        },
      ],
    ]);
    view.rerender({
      ...initial,
      pulls: [blocked],
      runs: { start, states: activeRuns },
    });
    act(() => view.result.current.setEnabled(false));
    await waitFor(() => expect(view.result.current.enabled).toBe(false));
    act(() => view.result.current.setEnabled(true));
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({
      ...initial,
      pulls: [changed],
      runs: { start, states: activeRuns },
    });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();

    await act(async () => completion.resolve("completed"));
    view.rerender({ ...initial, pulls: [changed] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: "new-during-auto",
        kind: "issue_comment",
      }),
    ]);
  });

  it("preserves incidents queued beyond the active Auto launch across an epoch change", async () => {
    settings("active-auto-queued-identity");
    const baseline = createPullsResponse().ready[0]!;
    const comments = Array.from({ length: 65 }, (_, index) => {
      const suffix = `${index}`.padStart(2, "0");
      const updatedAt = new Date(
        Date.parse("2026-07-22T10:00:00.000Z") + index * 1_000,
      ).toISOString();
      return {
        author: "reviewer",
        body: `Please fix queued issue ${suffix}.`,
        createdAt: updatedAt,
        id: `queued-${suffix}`,
        updatedAt,
        url: `${baseline.url}#issuecomment-queued-${suffix}`,
      };
    });
    const blocked: PullReadiness = {
      ...baseline,
      blockers: ["65 unresolved comments"],
      issueComments: [...baseline.issueComments, ...comments],
      ready: false,
    };
    const completion = deferred<"completed">();
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        completion: completion.promise,
        kind: "accepted",
        runId: "active-auto-batch",
        source: "auto",
        status: "running",
      })
      .mockResolvedValue(acceptedEquivalent());
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const launched = new Set(
      (start.mock.calls[0]![1]?.triggers ?? []).flatMap((trigger) =>
        trigger.kind === "issue_comment" ? [trigger.id] : [],
      ),
    );
    expect(launched.size).toBe(64);
    const queued = comments.find((comment) => !launched.has(comment.id));
    expect(queued).toBeDefined();

    const activeRuns = new Map([
      [
        blocked.url,
        {
          ...IDLE_RUN_STATE,
          source: "auto" as const,
          status: "running" as const,
        },
      ],
    ]);
    view.rerender({
      ...initial,
      pulls: [blocked],
      runs: { start, states: activeRuns },
    });
    act(() => view.result.current.setEnabled(false));
    await waitFor(() => expect(view.result.current.enabled).toBe(false));
    act(() => view.result.current.setEnabled(true));
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    expect(start).toHaveBeenCalledOnce();
    expect(view.result.current.queued).toBe(1);

    await act(async () => completion.resolve("completed"));
    view.rerender({ ...initial, pulls: [blocked] });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]![1]?.triggers).toEqual([
      expect.objectContaining({
        id: queued!.id,
        kind: "issue_comment",
      }),
    ]);
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("freezes evidence and dispatch while the global snapshot is untrusted", async () => {
    settings("trust-freeze");
    const baseline = createPullsResponse().ready[0]!;
    const changed = addIssue(
      baseline,
      "frozen-comment",
      "2026-07-22T07:00:00.000Z",
    );
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    const key = getAutoEvidenceStorageKey("jake");
    const trustedEvidence = window.localStorage.getItem(key);

    view.rerender({
      ...initial,
      authoritative: false,
      pulls: [changed],
    });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe(trustedEvidence);

    view.rerender({ ...initial, authoritative: false, pulls: [] });
    await act(async () => Promise.resolve());
    expect(window.localStorage.getItem(key)).toBe(trustedEvidence);

    view.rerender({ ...initial, pulls: [changed] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
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
    const start = vi.fn<AutoInput["runs"]["start"]>(
      async (): Promise<RunStartOutcome> => {
        const completion = completions[launchIndex]!;
        launchIndex += 1;
        return {
          completion: completion.promise,
          kind: "accepted",
          runId: `auto-${launchIndex}`,
          source: "auto",
          status: "running",
        };
      },
    );
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
    const start = vi.fn<AutoInput["runs"]["start"]>(
      async (): Promise<RunStartOutcome> => {
        const index = launchIndex;
        launchIndex += 1;
        return {
          completion: completions[index]!.promise,
          kind: "accepted",
          runId: `auto-${index}`,
          source: "auto",
          status: "running",
        };
      },
    );
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
    expect(
      start.mock.calls.slice(0, 2).map(([, options]) => options?.parallelism),
    ).toEqual([2, 2]);
    expect(
      start.mock.calls.slice(2).map(([, options]) => options?.parallelism),
    ).toEqual([4, 4]);

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

  it("defers observation while a manual run or linked New Task is active", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(
      async (
        _pull: PullReadiness,
        _options?: StartRunOptions,
      ): Promise<RunStartOutcome> => acceptedEquivalent(),
    );
    const states = new Map([
      [baseline.url, { ...IDLE_RUN_STATE, status: "running" as const }],
    ]);
    const first = input([baseline], { runs: { start, states } });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: first,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));
    const changed = addIssue(baseline);
    view.rerender({ ...first, pulls: [changed] });
    await waitFor(() => expect(view.result.current.status).toBe("watching"));
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

  it("resumes a persisted progress phase and dispatches once only after it settles blocked", async () => {
    settings("persisted-progress");
    const baseline = createPullsResponse().ready[0]!;
    const firstCheck = baseline.ci.checks![0]!;
    const progress: PullReadiness = {
      ...baseline,
      blockers: ["CI checks pending"],
      ci: {
        checks: [
          { ...firstCheck, state: "failure" },
          {
            ...firstCheck,
            id: "persisted-running-check",
            state: "pending",
          },
        ],
        complete: true,
        failed: 1,
        passed: 0,
        running: 1,
        state: "pending",
        total: 2,
        unknown: 0,
      },
      ready: false,
    };
    const blocked: PullReadiness = {
      ...progress,
      blockers: ["CI checks failed"],
      ci: {
        ...progress.ci,
        checks: progress.ci.checks!.map((check) =>
          check.id === "persisted-running-check"
            ? { ...check, state: "success" as const }
            : check,
        ),
        passed: 1,
        running: 0,
        state: "failure",
      },
    };
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const first = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: input([baseline], { runs: runInput(start) }),
    });
    await waitFor(() => expect(first.result.current.leader).toBe(true));
    first.rerender(input([progress], { runs: runInput(start) }));
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();
    first.unmount();

    const resumed = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: input([progress], { runs: runInput(start) }),
    });
    await waitFor(() => expect(resumed.result.current.leader).toBe(true));
    expect(start).not.toHaveBeenCalled();
    resumed.rerender(input([blocked], { runs: runInput(start) }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it.each([
    ["manual", { kind: "fix" as const, source: "manual" as const }],
    ["review", { kind: "fix" as const, source: "review" as const }],
    ["repair", { kind: "repair" as const, source: "manual" as const }],
  ])("defers new incidents during an active %s run", async (_name, run) => {
    settings(`active-${_name}`);
    const baseline = createPullsResponse().ready[0]!;
    const changed = addIssue(
      baseline,
      `${_name}-comment`,
      "2026-07-22T09:00:00.000Z",
    );
    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const initial = input([baseline], { runs: runInput(start) });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...initial,
      pulls: [changed],
      runs: {
        start,
        states: new Map([
          [
            changed.url,
            {
              ...IDLE_RUN_STATE,
              ...run,
              status: "running" as const,
            },
          ],
        ]),
      },
    });
    await act(async () => Promise.resolve());
    expect(start).not.toHaveBeenCalled();

    view.rerender({ ...initial, pulls: [changed] });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("keeps a queued incident on its captured agent across retries, migration, reload, and selector changes", async () => {
    vi.useFakeTimers();
    settings("agent-snapshot");
    const baseline = createPullsResponse().ready[0]!;
    const firstIncident = addIssue(
      baseline,
      "claude-comment",
      "2026-07-22T02:00:00.000Z",
    );
    const firstStart = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      code: "workspace_running",
      kind: "retryable",
      message: "Busy",
      source: "auto",
    }));
    const initial = input([baseline], {
      agent: "claude",
      runs: runInput(firstStart),
    });
    const first = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());
    first.rerender({ ...initial, pulls: [firstIncident] });
    await act(async () => Promise.resolve());
    expect(firstStart).toHaveBeenCalledOnce();
    expect(firstStart.mock.calls[0]?.[1]).toMatchObject({ agent: "claude" });

    first.rerender({ ...initial, agent: "codex", pulls: [firstIncident] });
    await act(async () => Promise.resolve());
    expect(firstStart).toHaveBeenCalledOnce();

    const evidenceKey = getAutoEvidenceStorageKey("jake");
    const legacy = JSON.parse(window.localStorage.getItem(evidenceKey)!);
    expect(legacy).toMatchObject({
      pending: {
        [baseline.url]: [expect.objectContaining({ agent: "claude" })],
      },
      retry: {
        [baseline.url]: expect.objectContaining({ agent: "claude" }),
      },
      version: 3,
    });
    legacy.version = 1;
    for (const observed of Object.values(legacy.observed) as Array<
      Record<string, unknown>
    >) {
      delete observed.phase;
    }
    for (const incidents of Object.values(legacy.pending) as Array<
      Array<Record<string, unknown>>
    >) {
      for (const incident of incidents) delete incident.agent;
    }
    for (const retry of Object.values(legacy.retry) as Array<
      Record<string, unknown>
    >) {
      delete retry.agent;
    }
    window.localStorage.setItem(evidenceKey, JSON.stringify(legacy));
    first.unmount();

    const resumedStart = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValue(acceptedEquivalent());
    const resumedInput = input([firstIncident], {
      agent: "codex",
      runs: runInput(resumedStart),
    });
    const resumed = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: resumedInput,
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(resumedStart).toHaveBeenCalledOnce();
    expect(resumedStart.mock.calls[0]?.[1]).toMatchObject({ agent: "claude" });
    expect(JSON.parse(window.localStorage.getItem(evidenceKey)!)).toMatchObject(
      {
        version: 3,
      },
    );

    const secondIncident = addIssue(
      firstIncident,
      "codex-comment",
      "2026-07-22T03:00:00.000Z",
    );
    resumed.rerender({ ...resumedInput, pulls: [secondIncident] });
    await act(async () => Promise.resolve());
    expect(resumedStart).toHaveBeenCalledTimes(2);
    expect(resumedStart.mock.calls[1]?.[1]).toMatchObject({ agent: "codex" });
  });

  it("migrates v2 evidence without inventing a transition or changing queued agents", async () => {
    settings("v2-evidence");
    const baseline = createPullsResponse().ready[0]!;
    const updatedAt = "2026-07-22T08:00:00.000Z";
    const blocked = addIssue(baseline, "v2-comment", updatedAt);
    const first = renderHook(() => useAuto(input([baseline])));
    await waitFor(() => expect(first.result.current.leader).toBe(true));
    first.unmount();

    const key = getAutoEvidenceStorageKey("jake");
    const evidence = JSON.parse(window.localStorage.getItem(key)!);
    const incidentIdentity = JSON.stringify(["issue", "v2-comment", updatedAt]);
    evidence.version = 2;
    for (const observed of Object.values(evidence.observed) as Array<
      Record<string, unknown>
    >) {
      delete observed.phase;
    }
    evidence.pending[baseline.url] = [
      {
        agent: "codex",
        identity: incidentIdentity,
        trigger: {
          id: "v2-comment",
          kind: "issue_comment",
          updatedAt,
        },
      },
    ];
    evidence.retry[baseline.url] = {
      agent: "codex",
      attempt: 1,
      identities: [incidentIdentity],
      notBefore: 0,
    };
    window.localStorage.setItem(key, JSON.stringify(evidence));

    const start = vi.fn<AutoInput["runs"]["start"]>(async () =>
      acceptedEquivalent(),
    );
    const resumed = renderHook(() =>
      useAuto(
        input([blocked], {
          agent: "claude",
          runs: runInput(start),
        }),
      ),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![1]).toMatchObject({
      agent: "codex",
      triggers: [
        expect.objectContaining({
          id: "v2-comment",
          kind: "issue_comment",
        }),
      ],
    });
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({
      observed: {
        [baseline.url]: expect.objectContaining({ phase: "blocked" }),
      },
      version: 3,
    });
    resumed.unmount();
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
    expect(
      JSON.parse(window.localStorage.getItem(AUTO_SETTINGS_STORAGE_KEY)!),
    ).toEqual({
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
    expect(
      window.localStorage.getItem(getAutoEvidenceStorageKey("jake")),
    ).not.toBeNull();

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

  it("settles a failed start outcome without looping", async () => {
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const start = vi.fn(async (): Promise<RunStartOutcome> => ({
      code: "invalid",
      kind: "failed",
      message: "Rejected",
      source: "auto",
    }));
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

  it("coalesces a stale-head refresh and retries once with the latest pull and fresh trigger identities", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const refresh = deferred<void>();
    const requestRefresh = vi.fn(async () => refresh.promise);
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        code: "head_changed",
        kind: "rebaseline",
        message: "The pull request head changed.",
        source: "auto",
      })
      .mockResolvedValueOnce(acceptedEquivalent());
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
      wrapper: StrictMode,
    });
    await act(async () => Promise.resolve());

    const stale = failed(baseline);
    view.rerender({ ...initial, pulls: [stale] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
    expect(requestRefresh).toHaveBeenCalledOnce();

    const latest = failed({
      ...baseline,
      headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      updatedAt: "2026-07-22T03:00:00.000Z",
    });
    view.rerender({ ...initial, pulls: [latest] });
    await act(async () => refresh.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]![0].headRefOid).toBe(stale.headRefOid);
    expect(start.mock.calls[1]![0].headRefOid).toBe(latest.headRefOid);
    const firstTriggers = start.mock.calls[0]![1]?.triggers ?? [];
    const latestTriggers = start.mock.calls[1]![1]?.triggers ?? [];
    expect(latestTriggers).not.toEqual(firstTriggers);
    expect(latestTriggers).toContainEqual(
      expect.objectContaining({
        headRefOid: latest.headRefOid,
        kind: "failed_check",
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(start).toHaveBeenCalledTimes(2);
    expect(requestRefresh).toHaveBeenCalledOnce();
  });

  it("coalesces simultaneous stale preflights into one authoritative refresh", async () => {
    settings("coalesced-stale-refresh", 2);
    const baselines = distinctPulls(2);
    const refresh = deferred<void>();
    const requestRefresh = vi.fn(async () => refresh.promise);
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      code: "head_changed",
      kind: "rebaseline",
      message: "The pull request head changed.",
      source: "auto",
    }));
    const initial = input(baselines, {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(view.result.current.leader).toBe(true));

    view.rerender({
      ...initial,
      pulls: baselines.map((pull) => failed(pull)),
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(requestRefresh).toHaveBeenCalledOnce();

    await act(async () => refresh.resolve());
  });

  it("holds cross-tab leadership through an in-flight stale refresh", async () => {
    const locks = new LockHarness();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks.manager,
    });
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const refresh = deferred<void>();
    const requestRefresh = vi.fn(async () => refresh.promise);
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      code: "head_changed",
      kind: "rebaseline",
      message: "The pull request head changed.",
      source: "auto",
    }));
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const first = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    const second = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await waitFor(() => expect(first.result.current.leader).toBe(true));

    first.rerender({ ...initial, pulls: [failed(baseline)] });
    second.rerender({ ...initial, pulls: [failed(baseline)] });
    await waitFor(() => expect(requestRefresh).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => Promise.resolve());
    expect(second.result.current.leader).toBe(false);

    await act(async () => refresh.resolve());
    await waitFor(() => expect(second.result.current.leader).toBe(true));
    expect(requestRefresh).toHaveBeenCalledOnce();
  });

  it("never replays a stale payload while authoritative refreshes return the same head and incidents", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const requestRefresh = vi.fn(async () => undefined);
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      code: "head_changed",
      kind: "rebaseline",
      message: "The pull request head changed.",
      source: "auto",
    }));
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());

    view.rerender({ ...initial, pulls: [failed(baseline)] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();
    expect(requestRefresh).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(requestRefresh).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(requestRefresh).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenCalledOnce();
  });

  it("rebuilds same-head stale triggers from updated authoritative incident context", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const refresh = deferred<void>();
    const requestRefresh = vi.fn(async () => refresh.promise);
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        code: "auto_trigger_stale",
        kind: "rebaseline",
        message: "The Auto incident is no longer current.",
        source: "auto",
      })
      .mockResolvedValueOnce(acceptedEquivalent());
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());

    const stale = addIssue(
      baseline,
      "edited-comment",
      "2026-07-22T01:00:00.000Z",
    );
    view.rerender({ ...initial, pulls: [stale] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();

    const latest = addIssue(
      baseline,
      "edited-comment",
      "2026-07-22T02:00:00.000Z",
    );
    view.rerender({ ...initial, pulls: [latest] });
    await act(async () => refresh.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![1]?.triggers).toContainEqual({
      id: "edited-comment",
      kind: "issue_comment",
      updatedAt: "2026-07-22T02:00:00.000Z",
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps a stale incident pending after a manual owner is %s, revalidates, then dispatches it",
    async (status) => {
      settings();
      const baseline = createPullsResponse().ready[0]!;
      const staleRefresh = deferred<void>();
      const ownerRefresh = deferred<void>();
      const requestRefresh = vi
        .fn<AutoInput["refresh"]>()
        .mockImplementationOnce(async () => staleRefresh.promise)
        .mockImplementationOnce(async () => ownerRefresh.promise);
      const start = vi
        .fn<AutoInput["runs"]["start"]>()
        .mockResolvedValueOnce({
          code: "head_changed",
          kind: "rebaseline",
          message: "The pull request head changed.",
          source: "auto",
        })
        .mockResolvedValueOnce(acceptedEquivalent());
      const initial = input([baseline], {
        refresh: requestRefresh,
        runs: runInput(start),
      });
      const view = renderHook((props: AutoInput) => useAuto(props), {
        initialProps: initial,
      });
      await waitFor(() => expect(view.result.current.leader).toBe(true));

      view.rerender({ ...initial, pulls: [failed(baseline)] });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());

      const latest = failed({
        ...baseline,
        headRefOid: "ffffffffffffffffffffffffffffffffffffffff",
      });
      const running = new Map([
        [
          baseline.url,
          {
            ...IDLE_RUN_STATE,
            source: "manual" as const,
            status: "running" as const,
          },
        ],
      ]);
      view.rerender({
        ...initial,
        pulls: [latest],
        runs: { start, states: running },
      });
      await act(async () => staleRefresh.resolve());

      let evidence = JSON.parse(
        window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
      );
      expect(evidence.pending[baseline.url]).toHaveLength(1);
      expect(start).toHaveBeenCalledOnce();

      const terminal = new Map([
        [
          baseline.url,
          {
            ...IDLE_RUN_STATE,
            source: "manual" as const,
            status,
          },
        ],
      ]);
      view.rerender({
        ...initial,
        pulls: [latest],
        runs: { start, states: terminal },
      });
      await waitFor(() => expect(requestRefresh).toHaveBeenCalledTimes(2));
      expect(start).toHaveBeenCalledOnce();

      await act(async () => ownerRefresh.resolve());
      await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      expect(start.mock.calls[1]![0].headRefOid).toBe(latest.headRefOid);
      evidence = JSON.parse(
        window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
      );
      expect(evidence.pending[baseline.url]).toBeUndefined();
    },
  );

  it("revalidates after a remote pull owner settles instead of replaying the payload after pull_running", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const staleRefresh = deferred<void>();
    const ownerRefresh = deferred<void>();
    const requestRefresh = vi
      .fn<AutoInput["refresh"]>()
      .mockImplementationOnce(async () => staleRefresh.promise)
      .mockImplementationOnce(async () => ownerRefresh.promise);
    const start = vi
      .fn<AutoInput["runs"]["start"]>()
      .mockResolvedValueOnce({
        code: "head_changed",
        kind: "rebaseline",
        message: "The pull request head changed.",
        source: "auto",
      })
      .mockResolvedValueOnce({
        code: "pull_running",
        kind: "retryable",
        message: "Another run owns this pull request.",
        source: "auto",
      })
      .mockResolvedValueOnce(acceptedEquivalent());
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());

    view.rerender({ ...initial, pulls: [failed(baseline)] });
    await act(async () => Promise.resolve());
    const latest = failed({
      ...baseline,
      headRefOid: "9999999999999999999999999999999999999999",
    });
    view.rerender({ ...initial, pulls: [latest] });
    await act(async () => staleRefresh.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(start).toHaveBeenCalledTimes(2);
    expect(requestRefresh).toHaveBeenCalledTimes(2);

    view.rerender({ ...initial, pulls: [{ ...latest }] });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(start).toHaveBeenCalledTimes(2);
    expect(requestRefresh).toHaveBeenCalledTimes(2);

    await act(async () => ownerRefresh.resolve());
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2]![0].headRefOid).toBe(latest.headRefOid);
    expect(start.mock.calls[2]![1]?.triggers).toContainEqual(
      expect.objectContaining({
        headRefOid: latest.headRefOid,
        kind: "failed_check",
      }),
    );
  });

  it("backs off rejected external-owner refreshes and reconciles once after recovery", async () => {
    vi.useFakeTimers();
    settings("external-owner-refresh-backoff", 2);
    const pulls = distinctPulls(2);
    const refreshTimes: number[] = [];
    const requestRefresh = vi.fn<AutoInput["refresh"]>(async () => {
      refreshTimes.push(Date.now());
      if (refreshTimes.length <= 6) {
        throw new Error("The authoritative refresh failed.");
      }
    });
    let starts = 0;
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => {
      starts += 1;
      return starts <= pulls.length
        ? {
            code: "pull_running",
            kind: "retryable",
            message: "Another run owns this pull request.",
            source: "auto",
          }
        : acceptedEquivalent();
    });
    const initial = input(pulls, {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    view.rerender({ ...initial, pulls: pulls.map(failed) });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(start).toHaveBeenCalledTimes(2);
    expect(requestRefresh).toHaveBeenCalledOnce();

    for (const [index, delay] of [
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ].entries()) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(requestRefresh).toHaveBeenCalledTimes(index + 1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(requestRefresh).toHaveBeenCalledTimes(index + 2);
    }

    expect(refreshTimes.map((time) => time - refreshTimes[0]!)).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000, 47_000,
    ]);
    expect(start).toHaveBeenCalledTimes(4);
    const evidence = JSON.parse(
      window.localStorage.getItem(getAutoEvidenceStorageKey("jake"))!,
    );
    for (const pull of pulls) {
      expect(evidence.pending[pull.url]).toBeUndefined();
    }

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(requestRefresh).toHaveBeenCalledTimes(7);
    expect(start).toHaveBeenCalledTimes(4);
  });

  it("drops pull-ready rebaseline work after the authoritative snapshot is ready", async () => {
    vi.useFakeTimers();
    settings();
    const baseline = createPullsResponse().ready[0]!;
    const refresh = deferred<void>();
    const requestRefresh = vi.fn(async () => refresh.promise);
    const start = vi.fn<AutoInput["runs"]["start"]>(async () => ({
      code: "pull_ready",
      kind: "rebaseline",
      message: "The pull request is already ready.",
      source: "auto",
    }));
    const initial = input([baseline], {
      refresh: requestRefresh,
      runs: runInput(start),
    });
    const view = renderHook((props: AutoInput) => useAuto(props), {
      initialProps: initial,
    });
    await act(async () => Promise.resolve());

    view.rerender({ ...initial, pulls: [addIssue(baseline)] });
    await act(async () => Promise.resolve());
    expect(start).toHaveBeenCalledOnce();

    view.rerender({ ...initial, pulls: [baseline] });
    await act(async () => refresh.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(start).toHaveBeenCalledOnce();
    expect(requestRefresh).toHaveBeenCalledOnce();
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
