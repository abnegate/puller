// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeRunHttpError,
  type AutoTrigger,
  type ClaudeRunEvent,
  type ClaudeRunRequest,
  type ReviewFeedback,
} from "./fixes";
import {
  groupPulls,
  IDLE_RUN_STATE,
  reconcilePulls,
  type RunStartOutcome,
  type RunState,
  type RunStatus,
  usePullRuns,
} from "./runs";
import { createPullsResponse } from "./test/fixtures";
import type { PullReadiness } from "./types";

const fixes = vi.hoisted(() => ({
  cancel: vi.fn(),
  stream: vi.fn(),
}));

const repairs = vi.hoisted(() => ({
  cancel: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("./fixes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fixes")>()),
  cancelClaudeRun: fixes.cancel,
  streamClaudeRun: fixes.stream,
}));

vi.mock("./api", () => ({
  cancelRepair: repairs.cancel,
  streamRepair: repairs.stream,
}));

const createDeferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );

const finishRun = async (
  start: Promise<RunStartOutcome>,
): Promise<RunStartOutcome> => {
  const outcome = await start;
  if (outcome.kind === "accepted") {
    await outcome.completion;
  }
  return outcome;
};

const pulls = (): [PullReadiness, PullReadiness] => {
  const response = createPullsResponse();
  const first = response.notReady[0]!;
  return [
    first,
    {
      ...first,
      number: 103,
      rank: 3,
      title: "Repair an independent pull request",
      url: "https://github.com/appwrite/cloud/pull/103",
    },
  ];
};

const automaticTrigger = (pull: PullReadiness): AutoTrigger => ({
  detailsUrl: null,
  headRefOid: pull.headRefOid,
  id: "failed-check",
  kind: "failed_check",
});

const state = (status: RunStatus): RunState => ({
  ...IDLE_RUN_STATE,
  status,
});

afterEach(() => {
  cleanup();
  fixes.cancel.mockReset();
  fixes.stream.mockReset();
  repairs.cancel.mockReset();
  repairs.stream.mockReset();
});

describe("groupPulls", () => {
  it("merges incomplete snapshots by URL without duplicates in deterministic rank order", () => {
    const response = createPullsResponse();
    const ready = { ...response.ready[0]!, rank: 3 };
    const blocked = { ...response.notReady[0]!, rank: 2 };
    const updated = {
      ...blocked,
      rank: 1,
      title: "Updated by the partial snapshot",
    };
    const pending: PullReadiness = {
      ...blocked,
      ci: { state: "pending" },
      number: 103,
      rank: 1,
      url: "https://github.com/appwrite/cloud/pull/103",
    };

    const merged = reconcilePulls(
      [ready, blocked],
      [pending, updated, { ...updated }],
      false,
    );

    expect(merged.map((pull) => pull.url)).toEqual([
      updated.url,
      pending.url,
      ready.url,
    ]);
    expect(merged.find((pull) => pull.url === updated.url)?.title).toBe(
      updated.title,
    );
    expect(new Set(merged.map((pull) => pull.url)).size).toBe(merged.length);
  });

  it("allows only an authoritative snapshot to remove a known URL", () => {
    const response = createPullsResponse();
    const previous = [...response.ready, ...response.notReady];
    const incoming = [response.ready[0]!];

    expect(reconcilePulls(previous, incoming, false)).toHaveLength(2);
    expect(reconcilePulls(previous, incoming, true)).toEqual(incoming);
  });

  it("rank ordering and section membership are globally exclusive", () => {
    const response = createPullsResponse();
    const blocked = response.notReady[0]!;
    const pending: PullReadiness = {
      ...blocked,
      ci: { state: "pending" },
      number: 103,
      rank: 3,
      url: "https://github.com/appwrite/cloud/pull/103",
    };
    const activeReady: PullReadiness = {
      ...response.ready[0]!,
      number: 104,
      rank: 4,
      url: "https://github.com/appwrite/cloud/pull/104",
    };
    const states = new Map<string, RunState>([
      [pending.url, state("completed")],
      [activeReady.url, state("running")],
    ]);

    const groups = groupPulls(
      [activeReady, pending, blocked, response.ready[0]!, { ...pending }],
      states,
    );

    expect(groups.ready.map((pull) => pull.rank)).toEqual([1]);
    expect(groups.blocked.map((pull) => pull.rank)).toEqual([2]);
    expect(groups.progress.map((pull) => pull.rank)).toEqual([3, 4]);
    const urls = [...groups.ready, ...groups.progress, ...groups.blocked].map(
      (pull) => pull.url,
    );
    expect(urls).toHaveLength(4);
    expect(new Set(urls).size).toBe(4);
  });

  it.each(["starting", "running"] as const)(
    "%s is active and overrides a Ready snapshot",
    (status) => {
      const ready = createPullsResponse().ready[0]!;
      const groups = groupPulls([ready], new Map([[ready.url, state(status)]]));

      expect(groups.progress).toEqual([ready]);
      expect(groups.ready).toEqual([]);
      expect(groups.blocked).toEqual([]);
    },
  );

  it.each(["idle", "completed", "failed", "cancelled", "limited"] as const)(
    "%s is terminal and does not override a Ready snapshot",
    (status) => {
      const ready = createPullsResponse().ready[0]!;
      const groups = groupPulls([ready], new Map([[ready.url, state(status)]]));

      expect(groups.ready).toEqual([ready]);
      expect(groups.progress).toEqual([]);
    },
  );

  it.each(["completed", "failed", "cancelled", "limited"] as const)(
    "terminal %s with pending CI remains In progress",
    (status) => {
      const pending = createPullsResponse().notReady[0]!;
      pending.ci.state = "pending";

      expect(
        groupPulls([pending], new Map([[pending.url, state(status)]])).progress,
      ).toEqual([pending]);
    },
  );

  it.each(["failure", "unknown"] as const)(
    "keeps a %s aggregate in progress while any enriched CI check is running",
    (state) => {
      const pull = createPullsResponse().notReady[0]!;
      pull.ci = {
        checks: [
          {
            detailsUrl: null,
            id: "failed-check",
            name: "Already failed",
            state: "failure",
            workflow: "CI",
          },
          {
            detailsUrl: null,
            id: "pending-check",
            name: "Still running",
            state: "pending",
            workflow: "CI",
          },
        ],
        complete: state === "failure",
        failed: 1,
        passed: 0,
        running: 1,
        state,
        total: state === "unknown" ? 3 : 2,
        unknown: state === "unknown" ? 1 : 0,
      };

      const groups = groupPulls([pull], new Map());

      expect(groups.progress).toEqual([pull]);
      expect(groups.blocked).toEqual([]);
    },
  );
});

describe("usePullRuns", () => {
  it.each([
    { expected: "", instructions: "", label: "empty" },
    { expected: "", instructions: "  \n\t ", label: "whitespace-only" },
    {
      expected: "Resolve every blocker.",
      instructions: "  Resolve every blocker.  \n",
      label: "custom",
    },
  ])(
    "sends trimmed $label instructions through the normal stream lifecycle",
    async ({ expected, instructions }) => {
      const [pull] = pulls();
      fixes.stream.mockImplementation(async function* (
        request: ClaudeRunRequest,
      ) {
        yield {
          number: request.number,
          repository: request.repository,
          runId: "run-instructions",
          type: "start",
        } satisfies ClaudeRunEvent;
        yield { text: "Working.", type: "text" } satisfies ClaudeRunEvent;
        yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
      });
      const view = renderHook(() => usePullRuns([pull]));
      act(() => view.result.current.setMessage(pull.url, instructions));

      await act(async () => {
        await finishRun(view.result.current.start(pull));
      });

      expect(fixes.stream).toHaveBeenCalledWith(
        {
          expectedHeadRefOid: pull.headRefOid,
          message: expected,
          number: pull.number,
          repository: pull.repository,
          source: "manual",
        },
        expect.any(AbortSignal),
      );
      expect(view.result.current.states.get(pull.url)).toMatchObject({
        message: instructions,
        output: "Working.",
        status: "completed",
      });
    },
  );

  it("accepts an automatic run before completion and preserves the manual draft", async () => {
    const gate = createDeferred<void>();
    const [pull] = pulls();
    const trigger = {
      detailsUrl: "https://github.com/appwrite/cloud/actions/runs/22",
      headRefOid: pull.headRefOid,
      id: "check-22",
      kind: "failed_check",
    } satisfies AutoTrigger;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "auto-run",
        type: "start",
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield {
        message: "The accepted run failed later.",
        type: "error",
      } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() => usePullRuns([pull]));
    act(() =>
      view.result.current.setMessage(pull.url, "Keep my manual draft."),
    );

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        message: "Fix the newly failed check.",
        parallelism: 4,
        source: "auto",
        triggers: [trigger],
      });
    });

    expect(outcome).toMatchObject({
      kind: "accepted",
      runId: "auto-run",
      source: "auto",
      status: "running",
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "Keep my manual draft.",
      source: "auto",
      status: "running",
    });
    expect(fixes.stream).toHaveBeenCalledWith(
      {
        expectedHeadRefOid: pull.headRefOid,
        message: "Fix the newly failed check.",
        number: pull.number,
        parallelism: 4,
        repository: pull.repository,
        source: "auto",
        triggers: [trigger],
      },
      expect.any(AbortSignal),
    );

    await act(async () => {
      gate.resolve();
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("failed");
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "Keep my manual draft.",
      source: "auto",
      status: "failed",
    });
  });

  it("accepts a review fix, moves a Ready pull into progress, and streams output without replacing the manual draft", async () => {
    const gate = createDeferred<void>();
    const pull = createPullsResponse().ready[0]!;
    const feedback = {
      body: "Keep the retry bounded and cover the timeout path.",
      line: 88,
      path: "src/Retry.php",
      side: "RIGHT",
      startLine: 84,
      startSide: "RIGHT",
    } satisfies ReviewFeedback;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "review-fix",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: "Editing the retry path.",
        type: "text",
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() => usePullRuns([pull]));
    act(() =>
      view.result.current.setMessage(pull.url, "Keep my manual draft."),
    );

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        expectedBaseRefOid: pull.baseRefOid,
        feedback,
        source: "review",
      });
    });

    expect(outcome).toMatchObject({
      kind: "accepted",
      runId: "review-fix",
      source: "review",
      status: "running",
    });
    expect(fixes.stream).toHaveBeenCalledWith(
      {
        expectedBaseRefOid: pull.baseRefOid,
        expectedHeadRefOid: pull.headRefOid,
        feedback,
        message: "",
        number: pull.number,
        repository: pull.repository,
        source: "review",
      },
      expect.any(AbortSignal),
    );
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "Keep my manual draft.",
      output: "Editing the retry path.",
      source: "review",
      status: "running",
    });
    expect(groupPulls([pull], view.result.current.states)).toMatchObject({
      blocked: [],
      progress: [pull],
      ready: [],
    });

    await act(async () => {
      gate.resolve();
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("completed");
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      output: "Editing the retry path.",
      source: "review",
      status: "completed",
    });
  });

  it("deduplicates an active review fix through the existing per-pull run guard", async () => {
    const gate = createDeferred<void>();
    const [pull] = pulls();
    const feedback = {
      body: "Use the shared validator here.",
      line: 12,
      path: "src/Input.php",
      side: "RIGHT",
    } satisfies ReviewFeedback;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "active-review-fix",
        type: "start",
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() => usePullRuns([pull]));

    let first!: RunStartOutcome;
    await act(async () => {
      first = await view.result.current.start(pull, {
        expectedBaseRefOid: pull.baseRefOid,
        feedback,
        source: "review",
      });
    });
    let duplicate!: RunStartOutcome;
    await act(async () => {
      duplicate = await view.result.current.start(pull, {
        expectedBaseRefOid: pull.baseRefOid,
        feedback,
        source: "review",
      });
    });

    expect(duplicate).toEqual({
      code: "pull_running",
      kind: "retryable",
      message: "A Claude Code run is already active for this pull request.",
      source: "review",
    });
    expect(fixes.stream).toHaveBeenCalledOnce();

    await act(async () => {
      gate.resolve();
      if (first.kind !== "accepted") throw new Error("Run was not accepted.");
      await first.completion;
    });
  });

  it.each([
    ["auto_triggers_running", "accepted-equivalent", "auto_triggers_running"],
    ["pull_running", "retryable", "pull_running"],
    ["auto_running", "retryable", "auto_running"],
    ["run_limit", "retryable", "run_limit"],
    ["workspace_running", "retryable", "workspace_running"],
    ["snapshot_incomplete", "retryable", "snapshot_incomplete"],
    ["snapshot_unavailable", "retryable", "snapshot_unavailable"],
    ["head_changed", "rebaseline", "head_changed"],
    ["pull_ready", "rebaseline", "pull_ready"],
    ["auto_trigger_stale", "rebaseline", "auto_trigger_stale"],
    ["auto_triggers_stale", "rebaseline", "auto_trigger_stale"],
    ["pull_missing", "prune", "pull_missing"],
    ["unexpected_code", "failed", "unexpected_code"],
  ] as const)(
    "classifies a pre-acceptance %s response as %s",
    async (code, kind, expectedCode) => {
      const [pull] = pulls();
      fixes.stream.mockImplementation(() => {
        throw new ClaudeRunHttpError(409, code, `Service response: ${code}`);
      });
      const view = renderHook(() => usePullRuns([pull]));

      let outcome!: RunStartOutcome;
      await act(async () => {
        outcome = await view.result.current.start(pull, {
          parallelism: 2,
          source: "auto",
          triggers: [automaticTrigger(pull)],
        });
      });

      expect(outcome).toMatchObject({
        code: expectedCode,
        kind,
        message: `Service response: ${code}`,
        source: "auto",
      });
      expect(view.result.current.states.get(pull.url)?.status).toBe("failed");
    },
  );

  it("classifies transport failure before acceptance as retryable", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(() => {
      throw new TypeError("Network connection failed.");
    });
    const view = renderHook(() => usePullRuns([pull]));

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        parallelism: 3,
        source: "auto",
        triggers: [automaticTrigger(pull)],
      });
    });

    expect(outcome).toEqual({
      code: "transport",
      kind: "retryable",
      message: "Network connection failed.",
      source: "auto",
    });
  });

  it("accepts equivalence only for the exact automatic trigger set", async () => {
    const gate = createDeferred<void>();
    const [pull] = pulls();
    const firstTrigger = automaticTrigger(pull);
    const secondTrigger = {
      id: "review-comment",
      kind: "review_comment",
      threadId: "review-thread",
      updatedAt: "2026-07-22T01:00:00.000Z",
    } satisfies AutoTrigger;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "existing-auto-run",
        type: "start",
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() => usePullRuns([pull]));

    let first!: RunStartOutcome;
    await act(async () => {
      first = await view.result.current.start(pull, {
        parallelism: 1,
        source: "auto",
        triggers: [firstTrigger, secondTrigger],
      });
    });
    let duplicate!: RunStartOutcome;
    await act(async () => {
      duplicate = await view.result.current.start(pull, {
        parallelism: 4,
        source: "auto",
        triggers: [secondTrigger, firstTrigger],
      });
    });

    expect(duplicate).toEqual({
      code: "auto_triggers_running",
      kind: "accepted-equivalent",
      message: "These Auto incidents are already assigned to the active run.",
      source: "auto",
    });
    for (const triggers of [
      [firstTrigger],
      [
        firstTrigger,
        secondTrigger,
        {
          detailsUrl: null,
          headRefOid: pull.headRefOid,
          id: "additional-check-failure",
          kind: "failed_check",
        } satisfies AutoTrigger,
      ],
    ]) {
      let changedSet!: RunStartOutcome;
      await act(async () => {
        changedSet = await view.result.current.start(pull, {
          parallelism: 2,
          source: "auto",
          triggers,
        });
      });
      expect(changedSet).toEqual({
        code: "pull_running",
        kind: "retryable",
        message: "A Claude Code run is already active for this pull request.",
        source: "auto",
      });
    }
    let newer!: RunStartOutcome;
    await act(async () => {
      newer = await view.result.current.start(pull, {
        parallelism: 2,
        source: "auto",
        triggers: [
          {
            detailsUrl: null,
            headRefOid: pull.headRefOid,
            id: "newer-check-failure",
            kind: "failed_check",
          },
        ],
      });
    });
    expect(newer).toEqual({
      code: "pull_running",
      kind: "retryable",
      message: "A Claude Code run is already active for this pull request.",
      source: "auto",
    });
    expect(fixes.stream).toHaveBeenCalledOnce();

    await act(async () => {
      gate.resolve();
      if (first.kind !== "accepted") throw new Error("Run was not accepted.");
      await first.completion;
    });
  });

  it("requests a background refresh only after repair reports terminal ready", async () => {
    const [pull] = pulls();
    const refresh = vi.fn();
    repairs.stream.mockImplementation(async function* () {
      yield {
        actionId: "repair-1",
        headRefOid: pull.headRefOid,
        number: pull.number,
        output: "",
        repository: pull.repository,
        state: "repair_running",
        terminal: false,
        type: "snapshot",
        updatedAt: "2026-07-21T00:00:00.000Z",
      };
      yield {
        actionId: "repair-1",
        commit: "1234567890abcdef1234567890abcdef12345678",
        headRefOid: pull.headRefOid,
        number: pull.number,
        repository: pull.repository,
        state: "ready",
        terminal: true,
        type: "state",
        updatedAt: "2026-07-21T00:01:00.000Z",
      };
    });
    const view = renderHook(() => usePullRuns([pull], refresh));
    act(() =>
      view.result.current.setMessage(pull.url, "Keep this repair draft."),
    );

    await act(async () => {
      await view.result.current.observeRepair(pull, {
        action: {
          deduplicated: false,
          id: "repair-1",
          state: "repair_queued",
          token: "A".repeat(43),
          type: "repair_queued",
        },
        headRefOid: pull.headRefOid,
        merged: false,
        number: pull.number,
        repository: pull.repository,
        url: pull.url,
      });
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(pull);
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "Keep this repair draft.",
      repairState: "ready",
      source: "auto",
      status: "completed",
    });
  });

  it("starting publishes before the stream yields and per-PR state stays independent", async () => {
    const gate = createDeferred<void>();
    const [first, second] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      await gate.promise;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-starting",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(({ items }) => usePullRuns(items), {
      initialProps: { items: [first, second] },
    });

    act(() => {
      view.result.current.setMessage(first.url, "Fix the first pull.");
      view.result.current.setMessage(second.url, "Leave this draft alone.");
    });
    let task!: Promise<RunStartOutcome>;
    act(() => {
      task = finishRun(view.result.current.start(first));
    });

    expect(view.result.current.states.get(first.url)).toMatchObject({
      message: "Fix the first pull.",
      status: "starting",
    });
    expect(view.result.current.states.get(second.url)).toMatchObject({
      message: "Leave this draft alone.",
      status: "idle",
    });

    await act(async () => {
      gate.resolve();
      await task;
    });
    expect(view.result.current.states.get(first.url)?.status).toBe("completed");
  });

  it("removal while starting invalidates purges and aborts without DELETE", async () => {
    const [pull] = pulls();
    let signal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      _request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      await waitForAbort(runSignal);
    });
    const view = renderHook(({ items }) => usePullRuns(items), {
      initialProps: { items: [pull] },
    });
    act(() => view.result.current.setMessage(pull.url, "Start this fix."));
    let task!: Promise<RunStartOutcome>;
    act(() => {
      task = finishRun(view.result.current.start(pull));
    });
    expect(view.result.current.states.get(pull.url)?.status).toBe("starting");

    view.rerender({ items: [] });
    await waitFor(() => expect(signal.aborted).toBe(true));
    await task;

    expect(view.result.current.states.has(pull.url)).toBe(false);
    expect(fixes.cancel).not.toHaveBeenCalled();
  });

  it("removal while running aborts before best-effort DELETE", async () => {
    const [pull] = pulls();
    let streamSignal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      streamSignal = runSignal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-removed",
        type: "start",
      } satisfies ClaudeRunEvent;
      await waitForAbort(runSignal);
    });
    fixes.cancel.mockImplementation(
      async (_runId: string, cancellationSignal: AbortSignal) => {
        expect(streamSignal.aborted).toBe(true);
        expect(cancellationSignal).not.toBe(streamSignal);
      },
    );
    const view = renderHook(({ items }) => usePullRuns(items), {
      initialProps: { items: [pull] },
    });
    act(() => view.result.current.setMessage(pull.url, "Run then remove."));
    let task!: Promise<RunStartOutcome>;
    act(() => {
      task = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    view.rerender({ items: [] });
    await waitFor(() => expect(fixes.cancel).toHaveBeenCalledTimes(1));
    await task;

    expect(fixes.cancel).toHaveBeenCalledWith(
      "run-removed",
      expect.any(AbortSignal),
    );
    expect(view.result.current.states.has(pull.url)).toBe(false);
  });

  it("unmount invalidates every generation before cleanup requests", async () => {
    const [pull] = pulls();
    let streamSignal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      streamSignal = runSignal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-unmount",
        type: "start",
      } satisfies ClaudeRunEvent;
      await waitForAbort(runSignal);
    });
    fixes.cancel.mockImplementation(async () => {
      expect(streamSignal.aborted).toBe(true);
    });
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "Unmount this run."));
    act(() => {
      void view.result.current.start(pull);
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    view.unmount();

    expect(streamSignal.aborted).toBe(true);
    expect(fixes.cancel).toHaveBeenCalledWith(
      "run-unmount",
      expect.any(AbortSignal),
    );
  });

  it("late events after purge cannot recreate run state", async () => {
    const gate = createDeferred<void>();
    const [pull] = pulls();
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-late",
        type: "start",
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { text: "late output", type: "text" } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(({ items }) => usePullRuns(items), {
      initialProps: { items: [pull] },
    });
    act(() => view.result.current.setMessage(pull.url, "Purge this run."));
    let task!: Promise<RunStartOutcome>;
    act(() => {
      task = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    view.rerender({ items: [] });
    await waitFor(() =>
      expect(view.result.current.states.has(pull.url)).toBe(false),
    );
    await act(async () => {
      gate.resolve();
      await task;
    });

    expect(view.result.current.states.has(pull.url)).toBe(false);
  });

  it("old generation cannot overwrite a newly started run", async () => {
    const oldGate = createDeferred<void>();
    const newGate = createDeferred<void>();
    const [pull] = pulls();
    let invocation = 0;
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      invocation += 1;
      const currentInvocation = invocation;
      yield {
        number: request.number,
        repository: request.repository,
        runId: `run-${currentInvocation}`,
        type: "start",
      } satisfies ClaudeRunEvent;
      if (currentInvocation === 1) {
        await oldGate.promise;
        yield { text: "old output", type: "text" } satisfies ClaudeRunEvent;
      } else {
        await newGate.promise;
        yield { text: "new output", type: "text" } satisfies ClaudeRunEvent;
      }
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(({ items }) => usePullRuns(items), {
      initialProps: { items: [pull] },
    });
    act(() => view.result.current.setMessage(pull.url, "Old generation."));
    let oldTask!: Promise<RunStartOutcome>;
    act(() => {
      oldTask = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );
    view.rerender({ items: [] });
    await waitFor(() =>
      expect(view.result.current.states.has(pull.url)).toBe(false),
    );
    view.rerender({ items: [pull] });
    act(() => view.result.current.setMessage(pull.url, "New generation."));
    let newTask!: Promise<RunStartOutcome>;
    act(() => {
      newTask = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    await act(async () => {
      oldGate.resolve();
      await oldTask;
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "New generation.",
      output: "",
      status: "running",
    });

    await act(async () => {
      newGate.resolve();
      await newTask;
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      output: "new output",
      status: "completed",
    });
  });

  it("manual cancel losing to completion preserves Completed", async () => {
    const completeGate = createDeferred<void>();
    const cancelGate = createDeferred<void>();
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-race",
        type: "start",
      } satisfies ClaudeRunEvent;
      await completeGate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    fixes.cancel.mockReturnValue(cancelGate.promise);
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "Race completion."));
    let runTask!: Promise<RunStartOutcome>;
    act(() => {
      runTask = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );
    let cancelTask!: Promise<void>;
    act(() => {
      cancelTask = view.result.current.cancel(pull.url);
    });
    expect(view.result.current.states.get(pull.url)?.cancelling).toBe(true);

    await act(async () => {
      completeGate.resolve();
      await runTask;
    });
    expect(view.result.current.states.get(pull.url)?.status).toBe("completed");
    await act(async () => {
      cancelGate.resolve();
      await cancelTask;
    });

    expect(view.result.current.states.get(pull.url)?.status).toBe("completed");
  });

  it("manual cancel response cannot overwrite a newer run", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const cancelGate = createDeferred<void>();
    const [pull] = pulls();
    let invocation = 0;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      invocation += 1;
      const currentInvocation = invocation;
      yield {
        number: request.number,
        repository: request.repository,
        runId: `run-cancel-${currentInvocation}`,
        type: "start",
      } satisfies ClaudeRunEvent;
      await (currentInvocation === 1 ? firstGate.promise : secondGate.promise);
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    fixes.cancel.mockReturnValue(cancelGate.promise);
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "First run."));
    let firstTask!: Promise<RunStartOutcome>;
    act(() => {
      firstTask = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );
    let cancelTask!: Promise<void>;
    act(() => {
      cancelTask = view.result.current.cancel(pull.url);
    });
    await act(async () => {
      firstGate.resolve();
      await firstTask;
    });
    act(() => view.result.current.setMessage(pull.url, "Second run."));
    let secondTask!: Promise<RunStartOutcome>;
    act(() => {
      secondTask = finishRun(view.result.current.start(pull));
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    await act(async () => {
      cancelGate.resolve();
      await cancelTask;
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "Second run.",
      status: "running",
    });

    await act(async () => {
      secondGate.resolve();
      await secondTask;
    });
  });

  it("cancel failure mutates only the current active generation", async () => {
    const [pull] = pulls();
    let signal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-cancel-failure",
        type: "start",
      } satisfies ClaudeRunEvent;
      await waitForAbort(runSignal);
    });
    fixes.cancel.mockRejectedValue(new Error("Cancellation service failed."));
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "Keep running."));
    act(() => {
      void view.result.current.start(pull);
    });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.status).toBe("running"),
    );

    await act(async () => {
      await view.result.current.cancel(pull.url);
    });

    expect(signal.aborted).toBe(false);
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      cancelling: false,
      output: "[diagnostic] Cancellation service failed.\n",
      status: "running",
    });
  });

  it("cancels an accepted review fix through the shared run endpoint and retains its terminal output", async () => {
    const [pull] = pulls();
    let streamSignal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      signal: AbortSignal,
    ) {
      streamSignal = signal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: "review-to-cancel",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: "Review fix started.",
        type: "text",
      } satisfies ClaudeRunEvent;
      await waitForAbort(signal);
      throw new DOMException("Review fix cancelled.", "AbortError");
    });
    fixes.cancel.mockResolvedValue(undefined);
    const view = renderHook(() => usePullRuns([pull]));

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        expectedBaseRefOid: pull.baseRefOid,
        feedback: {
          body: "Keep the original error attached.",
          line: 17,
          path: "src/Error.php",
          side: "RIGHT",
        },
        source: "review",
      });
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      output: "Review fix started.",
      source: "review",
      status: "running",
    });

    await act(async () => {
      await view.result.current.cancel(pull.url);
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("cancelled");
    });

    expect(fixes.cancel).toHaveBeenCalledWith(
      "review-to-cancel",
      expect.any(AbortSignal),
    );
    expect(streamSignal.aborted).toBe(true);
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      cancelling: false,
      output: "Review fix started.",
      source: "review",
      status: "cancelled",
    });
  });

  it("manual cancellation while starting aborts without DELETE", async () => {
    const [pull] = pulls();
    let signal!: AbortSignal;
    fixes.stream.mockImplementation(async function* (
      _request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      await waitForAbort(runSignal);
    });
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "Cancel startup."));
    let runTask!: Promise<RunStartOutcome>;
    act(() => {
      runTask = finishRun(view.result.current.start(pull));
    });

    await act(async () => {
      await view.result.current.cancel(pull.url);
      await runTask;
    });

    expect(signal.aborted).toBe(true);
    expect(fixes.cancel).not.toHaveBeenCalled();
    expect(view.result.current.states.get(pull.url)?.status).toBe("cancelled");
  });

  it.each<[ClaudeRunEvent, RunStatus, string]>([
    [{ exitCode: 0, type: "complete" }, "completed", ""],
    [{ exitCode: 1, type: "complete" }, "failed", ""],
    [
      { message: "The worker failed.", type: "error" },
      "failed",
      "[error] The worker failed.\n",
    ],
    [
      { message: "Run capacity reached.", type: "limit" },
      "limited",
      "[limit] Run capacity reached.\n",
    ],
    [{ type: "cancelled" }, "cancelled", ""],
  ])("terminal event $type maps to $1", async (terminal, expected, output) => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-terminal",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield terminal;
    });
    const view = renderHook(() => usePullRuns([pull]));
    act(() => view.result.current.setMessage(pull.url, "Finish this run."));

    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    expect(view.result.current.states.get(pull.url)).toMatchObject({
      output,
      status: expected,
    });
  });
});
