// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeRunHttpError,
  DEFAULT_FIX_INSTRUCTIONS,
  type AgentRunRequest,
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
  type StartRunOptions,
  usePullRuns,
} from "./runs";
import {
  createMemoryRunTranscriptStore,
  RunTranscriptStoreError,
  type RunTranscriptStore,
} from "./run-transcripts";
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
  cancelAgentRun: fixes.cancel,
  streamAgentRun: fixes.stream,
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

const renderPullRuns = (
  currentPulls: readonly PullReadiness[],
  onRepairReady: (pull: PullReadiness) => void = () => undefined,
) => {
  const transcriptStore = createMemoryRunTranscriptStore();
  return {
    transcriptStore,
    ...renderHook(() =>
      usePullRuns(currentPulls, onRepairReady, { transcriptStore }),
    ),
  };
};

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

  it("keeps a preparing review fix in its current section until the server accepts it", () => {
    const response = createPullsResponse();
    const ready = response.ready[0]!;
    const blocked = response.notReady[0]!;
    const reviewPreparing: RunState = {
      ...state("preparing"),
      source: "review",
    };
    const preparing = groupPulls(
      [ready, blocked],
      new Map([
        [ready.url, reviewPreparing],
        [blocked.url, reviewPreparing],
      ]),
    );

    expect(preparing.ready).toEqual([ready]);
    expect(preparing.blocked).toEqual([blocked]);
    expect(preparing.progress).toEqual([]);

    const running = groupPulls(
      [ready],
      new Map([[ready.url, { ...reviewPreparing, status: "running" }]]),
    );
    expect(running.progress).toEqual([ready]);
    expect(running.ready).toEqual([]);
  });

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
  it("snapshots the selected agent for active and historic runs while future runs follow a changed preference", async () => {
    const pull = pulls()[0];
    const first = createDeferred<void>();
    fixes.stream.mockImplementation(async function* (request: AgentRunRequest) {
      yield {
        agent: request.agent,
        number: request.number,
        repository: request.repository,
        runId: `${request.agent}-run`,
        type: "start",
      };
      if (request.agent === "claude") await first.promise;
      yield { exitCode: 0, type: "complete" };
    });
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ agent }: { agent: "claude" | "codex" | "grok" }) =>
        usePullRuns([pull], undefined, { agent, transcriptStore }),
      { initialProps: { agent: "claude" as "claude" | "codex" | "grok" } },
    );

    let claude!: RunStartOutcome;
    await act(async () => {
      claude = await view.result.current.start(pull);
    });
    expect(view.result.current.states.get(pull.url)?.agent).toBe("claude");

    view.rerender({ agent: "codex" });
    expect(view.result.current.states.get(pull.url)?.agent).toBe("claude");

    await act(async () => {
      first.resolve();
      if (claude.kind !== "accepted") throw new Error("Run was not accepted.");
      await claude.completion;
    });
    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    expect(fixes.stream.mock.calls.map(([request]) => request.agent)).toEqual([
      "claude",
      "codex",
    ]);
    expect(
      view.result.current.states
        .get(pull.url)
        ?.history.map((entry) => entry.agent),
    ).toEqual(["codex", "claude"]);
  });

  it("sends shepherd-bar instructions for every manual run", async () => {
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
    const view = renderPullRuns([pull]);
    act(() =>
      view.result.current.setMessage(pull.url, "  Resolve every blocker.  \n"),
    );

    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    expect(fixes.stream).toHaveBeenCalledWith(
      {
        agent: "claude",
        expectedHeadRefOid: pull.headRefOid,
        message: "",
        number: pull.number,
        repository: pull.repository,
        source: "manual",
      },
      expect.any(AbortSignal),
    );
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      message: "",
      output: "",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    expect(history).toMatchObject({
      headRefOid: pull.headRefOid,
      id: "run-instructions",
      instructions: {
        kind: "manual",
        text: DEFAULT_FIX_INSTRUCTIONS,
      },
      source: "manual",
      status: "completed",
    });
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Working.",
    );
    expect(Object.isFrozen(history)).toBe(true);
    expect(
      Object.isFrozen(view.result.current.states.get(pull.url)?.history ?? []),
    ).toBe(true);
  });

  it("keeps a rate-limit failure on the idle run after the transcript is archived", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "rate-limit-run",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        code: "rate_limit",
        message: "You've hit your weekly limit.",
        type: "error",
      } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);

    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    expect(view.result.current.states.get(pull.url)).toMatchObject({
      rateLimit: {
        agent: "claude",
        message: "You've hit your weekly limit.",
      },
      status: "idle",
    });
  });

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
    const view = renderPullRuns([pull]);
    act(() =>
      view.result.current.setMessage(pull.url, "Keep my manual draft."),
    );

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        agent: "claude",
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
        agent: "claude",
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
      output: "",
      source: "manual",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    expect(history).toMatchObject({
      id: "auto-run",
      instructions: {
        kind: "auto",
        message: "Fix the newly failed check.",
        triggers: [trigger],
      },
      source: "auto",
      status: "failed",
    });
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "[error] The accepted run failed later.\n",
    );
  });

  it("uses the validated Auto agent override instead of the current selector", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (request: AgentRunRequest) {
      yield {
        agent: request.agent,
        number: request.number,
        repository: request.repository,
        runId: "captured-auto-agent",
        type: "start",
      };
      yield { exitCode: 0, type: "complete" };
    });
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(() =>
      usePullRuns([pull], undefined, { agent: "codex", transcriptStore }),
    );

    await act(async () => {
      await finishRun(
        view.result.current.start(pull, {
          agent: "claude",
          parallelism: 1,
          source: "auto",
          triggers: [automaticTrigger(pull)],
        }),
      );
    });
    expect(fixes.stream).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "claude", source: "auto" }),
      expect.any(AbortSignal),
    );

    let invalid!: RunStartOutcome;
    await act(async () => {
      invalid = await view.result.current.start(pull, {
        agent: "invalid",
        parallelism: 1,
        source: "auto",
        triggers: [automaticTrigger(pull)],
      } as unknown as StartRunOptions);
    });
    expect(invalid).toMatchObject({
      code: "agent_invalid",
      kind: "failed",
      source: "auto",
    });
    expect(fixes.stream).toHaveBeenCalledOnce();
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
    const view = renderPullRuns([pull]);
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
        agent: "claude",
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
      message: "Keep my manual draft.",
      output: "",
      source: "manual",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    expect(history).toMatchObject({
      id: "review-fix",
      instructions: {
        feedback,
        kind: "review",
        message: "",
      },
      source: "review",
      status: "completed",
    });
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Editing the retry path.",
    );
  });

  it.each([
    {
      status: "failed",
      terminal: {
        message: "The review worker failed.",
        type: "error",
      } satisfies ClaudeRunEvent,
    },
    {
      status: "cancelled",
      terminal: { type: "cancelled" } satisfies ClaudeRunEvent,
    },
    {
      status: "limited",
      terminal: {
        message: "Review capacity reached.",
        type: "limit",
      } satisfies ClaudeRunEvent,
    },
  ] as const)(
    "preserves the exact review draft and coordinates after a $status run",
    async ({ status, terminal }) => {
      const pull = createPullsResponse().ready[0]!;
      const draft = "  Keep this exact retry draft.\n  Including spacing.  ";
      const feedback = {
        body: "Keep this exact retry draft.\n  Including spacing.",
        line: 88,
        path: "src/Retry.php",
        side: "LEFT",
        startLine: 84,
        startSide: "LEFT",
      } satisfies ReviewFeedback;
      fixes.stream.mockImplementation(async function* (
        request: ClaudeRunRequest,
      ) {
        yield {
          number: request.number,
          repository: request.repository,
          runId: `review-${status}`,
          type: "start",
        } satisfies ClaudeRunEvent;
        yield terminal;
      });
      const view = renderPullRuns([pull]);

      await act(async () => {
        const outcome = await view.result.current.start(pull, {
          draft,
          expectedBaseRefOid: pull.baseRefOid,
          feedback,
          source: "review",
        });
        if (outcome.kind !== "accepted") {
          throw new Error("Review fix was not accepted.");
        }
        await expect(outcome.completion).resolves.toBe(status);
      });

      const retry = view.result.current.states.get(pull.url)?.reviewRetry;
      expect(retry).toEqual({
        attemptToken: expect.any(String),
        baseRefOid: pull.baseRefOid,
        draft,
        feedback,
        headRefOid: pull.headRefOid,
        runId: `review-${status}`,
        status,
      });
      expect(Object.isFrozen(retry)).toBe(true);
      expect(
        view.result.current.states.get(pull.url)?.reviewAttemptToken,
      ).toBeNull();

      act(() =>
        view.result.current.clearReviewRetry(pull.url, "stale-attempt-token"),
      );
      expect(view.result.current.states.get(pull.url)?.reviewRetry).toBe(retry);
      act(() =>
        view.result.current.clearReviewRetry(pull.url, retry!.attemptToken),
      );
      expect(view.result.current.states.get(pull.url)?.reviewRetry).toBeNull();
    },
  );

  it("clears an old review retry when a newer attempt is accepted and keeps it cleared after success", async () => {
    const gate = createDeferred<void>();
    const pull = createPullsResponse().ready[0]!;
    const feedback = {
      body: "Retry the exact selected line.",
      line: 17,
      path: "src/Retry.php",
      side: "RIGHT",
    } satisfies ReviewFeedback;
    let invocation = 0;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      invocation += 1;
      yield {
        number: request.number,
        repository: request.repository,
        runId: `review-attempt-${invocation}`,
        type: "start",
      } satisfies ClaudeRunEvent;
      if (invocation === 1) {
        yield {
          message: "First attempt failed.",
          type: "error",
        } satisfies ClaudeRunEvent;
        return;
      }
      await gate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);

    await act(async () => {
      await finishRun(
        view.result.current.start(pull, {
          draft: "First exact draft.",
          expectedBaseRefOid: pull.baseRefOid,
          feedback,
          source: "review",
        }),
      );
    });
    const oldRetry = view.result.current.states.get(pull.url)?.reviewRetry;
    expect(oldRetry?.status).toBe("failed");

    let newer!: RunStartOutcome;
    await act(async () => {
      newer = await view.result.current.start(pull, {
        draft: "Second exact draft.",
        expectedBaseRefOid: pull.baseRefOid,
        feedback,
        source: "review",
      });
    });
    expect(newer.kind).toBe("accepted");
    expect(view.result.current.states.get(pull.url)?.reviewRetry).toBeNull();
    expect(
      view.result.current.states.get(pull.url)?.reviewAttemptToken,
    ).not.toBe(oldRetry?.attemptToken);

    await act(async () => {
      gate.resolve();
      if (newer.kind !== "accepted") {
        throw new Error("New review fix was not accepted.");
      }
      await expect(newer.completion).resolves.toBe("completed");
    });
    expect(view.result.current.states.get(pull.url)?.reviewRetry).toBeNull();
    expect(
      view.result.current.states.get(pull.url)?.reviewAttemptToken,
    ).toBeNull();
  });

  it("retains retry state during non-authoritative omission, clears it on a new head, and purges transcript bytes on removal", async () => {
    const pull = createPullsResponse().ready[0]!;
    const feedback = {
      body: "Preserve this retry.",
      line: 17,
      path: "src/Retry.php",
      side: "RIGHT",
    } satisfies ReviewFeedback;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "review-authority",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        message: "Review failed.",
        type: "error",
      } satisfies ClaudeRunEvent;
    });
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({
        authoritative,
        items,
      }: {
        authoritative: boolean;
        items: PullReadiness[];
      }) =>
        usePullRuns(items, undefined, {
          authoritative,
          transcriptStore,
        }),
      {
        initialProps: {
          authoritative: true,
          items: [pull],
        },
      },
    );

    await act(async () => {
      await finishRun(
        view.result.current.start(pull, {
          draft: "  Preserve this exact draft.  ",
          expectedBaseRefOid: pull.baseRefOid,
          feedback,
          source: "review",
        }),
      );
    });
    const stateBefore = view.result.current.states.get(pull.url);
    const [history] = stateBefore?.history ?? [];
    expect(stateBefore?.reviewRetry).not.toBeNull();
    expect(history).toBeDefined();

    view.rerender({ authoritative: false, items: [] });
    expect(view.result.current.states.get(pull.url)).toBe(stateBefore);

    const changed = {
      ...pull,
      headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
    };
    view.rerender({ authoritative: true, items: [changed] });
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)?.reviewRetry).toBeNull(),
    );
    expect(view.result.current.states.get(pull.url)?.history).toHaveLength(1);

    view.rerender({ authoritative: true, items: [] });
    await waitFor(() =>
      expect(view.result.current.states.has(pull.url)).toBe(false),
    );
    if (!history) throw new Error("Run history was not archived.");
    await waitFor(async () =>
      expect(await view.result.current.loadTranscript(history)).toBeNull(),
    );
  });

  it("archives transcript metadata and resets the composer even when browser storage fails", async () => {
    const [pull] = pulls();
    const transcriptStore: RunTranscriptStore = {
      retriesFailedDeletes: false,
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      initialize: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new RunTranscriptStoreError(
          "indexeddb_write_failed",
          "Browser storage rejected the transcript.",
        );
      }),
    };
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "storage-failure",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { text: "Exact output.", type: "text" } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() =>
      usePullRuns([pull], undefined, { transcriptStore }),
    );

    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    const current = view.result.current.states.get(pull.url);
    const [history] = current?.history ?? [];
    expect(current).toMatchObject({
      output: "",
      status: "idle",
    });
    expect(history).toMatchObject({
      id: "storage-failure",
      transcript: {
        availability: "unavailable",
        bytes: new TextEncoder().encode("Exact output.").byteLength,
        code: "indexeddb_write_failed",
        message: "Browser storage rejected the transcript.",
      },
    });
    expect(history).not.toHaveProperty("output");
    if (!history) throw new Error("Run history was not archived.");
    await expect(
      view.result.current.loadTranscript(history),
    ).rejects.toMatchObject({
      code: "indexeddb_write_failed",
      message: "Browser storage rejected the transcript.",
    });
  });

  it("resets the composer and performs no durable write when transcript storage initialization fails", async () => {
    const [pull] = pulls();
    const initialize = vi.fn(async () => {
      throw new RunTranscriptStoreError(
        "indexeddb_initialize_failed",
        "Browser transcript cleanup could not be completed.",
      );
    });
    const put = vi.fn(async () => undefined);
    const transcriptStore: RunTranscriptStore = {
      retriesFailedDeletes: true,
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      initialize,
      put,
    };
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "storage-initialization-failure",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: "Output must not enter durable storage.",
        type: "text",
      } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(() =>
      usePullRuns([pull], undefined, { transcriptStore }),
    );
    act(() => view.result.current.setMessage(pull.url, "Fix this pull."));

    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    const current = view.result.current.states.get(pull.url);
    const [history] = current?.history ?? [];
    expect(current).toMatchObject({
      message: "",
      output: "",
      status: "idle",
    });
    expect(history).toMatchObject({
      id: "storage-initialization-failure",
      transcript: {
        availability: "unavailable",
        code: "indexeddb_initialize_failed",
        message: "Browser transcript cleanup could not be completed.",
      },
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("compensates for a transcript write that finishes after authoritative removal", async () => {
    const [pull] = pulls();
    const putGate = createDeferred<void>();
    const stored = new Map<string, string>();
    const deleted: string[][] = [];
    const transcriptStore: RunTranscriptStore = {
      retriesFailedDeletes: false,
      async delete(keys) {
        deleted.push([...keys]);
        for (const key of keys) stored.delete(key);
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
      async initialize() {},
      async put(key, transcript) {
        await putGate.promise;
        stored.set(key, transcript);
      },
    };
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "removed-during-write",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { text: "Must be purged.", type: "text" } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderHook(
      ({ items }) =>
        usePullRuns(items, undefined, {
          authoritative: true,
          transcriptStore,
        }),
      { initialProps: { items: [pull] } },
    );

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
    });
    expect(outcome.kind).toBe("accepted");

    view.rerender({ items: [] });
    await waitFor(() =>
      expect(view.result.current.states.has(pull.url)).toBe(false),
    );

    await act(async () => {
      putGate.resolve();
      if (outcome.kind !== "accepted") {
        throw new Error("Run was not accepted.");
      }
      await expect(outcome.completion).resolves.toBe("completed");
    });

    expect(view.result.current.states.has(pull.url)).toBe(false);
    expect(stored.size).toBe(0);
    expect(
      deleted.flat().some((key) => key.includes("removed-during-write")),
    ).toBe(true);
  });

  it("does not cap history metadata and keeps transcript bytes out of React state", async () => {
    const [pull] = pulls();
    let invocation = 0;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      invocation += 1;
      yield {
        number: request.number,
        repository: request.repository,
        runId: `history-${invocation}`,
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: `transcript-${invocation}`,
        type: "text",
      } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);

    for (let index = 0; index < 25; index += 1) {
      await act(async () => {
        await finishRun(view.result.current.start(pull));
      });
    }

    const history = view.result.current.states.get(pull.url)?.history ?? [];
    expect(history).toHaveLength(25);
    expect(history.every((entry) => !("output" in entry))).toBe(true);
    expect(history[0]?.id).toBe("history-25");
    expect(history.at(-1)?.id).toBe("history-1");
    await expect(view.result.current.loadTranscript(history[0]!)).resolves.toBe(
      "transcript-25",
    );
    await expect(
      view.result.current.loadTranscript(history.at(-1)!),
    ).resolves.toBe("transcript-1");
  });

  it("archives successive accepted runs newest first without sharing mutable history", async () => {
    const [pull] = pulls();
    let invocation = 0;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      invocation += 1;
      yield {
        number: request.number,
        repository: request.repository,
        runId: `successive-${invocation}`,
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: `output-${invocation}`,
        type: "text",
      } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);

    act(() => view.result.current.setMessage(pull.url, "First instructions."));
    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });
    const firstHistory = view.result.current.states.get(pull.url)?.history;
    expect(firstHistory).toEqual([
      expect.objectContaining({
        id: "successive-1",
        instructions: {
          kind: "manual",
          text: DEFAULT_FIX_INSTRUCTIONS,
        },
      }),
    ]);
    if (!firstHistory?.[0]) throw new Error("First run was not archived.");
    await expect(
      view.result.current.loadTranscript(firstHistory[0]),
    ).resolves.toBe("output-1");

    act(() => view.result.current.setMessage(pull.url, "Second instructions."));
    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    const state = view.result.current.states.get(pull.url);
    expect(state).toMatchObject({
      message: "",
      output: "",
      status: "idle",
    });
    expect(state?.history).toEqual([
      expect.objectContaining({
        id: "successive-2",
        instructions: {
          kind: "manual",
          text: DEFAULT_FIX_INSTRUCTIONS,
        },
      }),
      expect.objectContaining({
        id: "successive-1",
        instructions: {
          kind: "manual",
          text: DEFAULT_FIX_INSTRUCTIONS,
        },
      }),
    ]);
    await expect(
      view.result.current.loadTranscript(state!.history[0]!),
    ).resolves.toBe("output-2");
    await expect(
      view.result.current.loadTranscript(state!.history[1]!),
    ).resolves.toBe("output-1");
    expect(state?.history).not.toBe(firstHistory);
    expect(firstHistory).toHaveLength(1);
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
    const view = renderPullRuns([pull]);

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
    ["pull_missing", "prune", "pull_missing"],
    ["unexpected_code", "failed", "unexpected_code"],
  ] as const)(
    "classifies a pre-acceptance %s response as %s",
    async (code, kind, expectedCode) => {
      const [pull] = pulls();
      fixes.stream.mockImplementation(() => {
        throw new ClaudeRunHttpError(409, code, `Service response: ${code}`);
      });
      const view = renderPullRuns([pull]);

      let outcome!: RunStartOutcome;
      await act(async () => {
        outcome = await view.result.current.start(pull, {
          agent: "claude",
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
      expect(view.result.current.states.get(pull.url)).toMatchObject({
        history: [],
        output: `[error] Service response: ${code}\n`,
        status: "failed",
      });
    },
  );

  it.each([
    ["head_changed", "head_changed"],
    ["pull_ready", "pull_ready"],
    ["auto_trigger_stale", "auto_trigger_stale"],
    ["auto_triggers_stale", "auto_trigger_stale"],
  ] as const)(
    "classifies an automatic pre-acceptance %s response as %s without leaving a transient run row",
    async (code, expectedCode) => {
      const [pull] = pulls();
      fixes.stream.mockImplementation(() => {
        throw new ClaudeRunHttpError(409, code, `Service response: ${code}`);
      });
      const view = renderPullRuns([pull]);

      let outcome!: RunStartOutcome;
      await act(async () => {
        outcome = await view.result.current.start(pull, {
          agent: "claude",
          parallelism: 2,
          source: "auto",
          triggers: [automaticTrigger(pull)],
        });
      });

      expect(outcome).toEqual({
        code: expectedCode,
        kind: "rebaseline",
        message: `Service response: ${code}`,
        source: "auto",
      });
      expect(view.result.current.states.has(pull.url)).toBe(false);
    },
  );

  it("restores an existing manual failure and draft after an automatic stale-head preflight", async () => {
    const [pull] = pulls();
    fixes.stream
      .mockImplementationOnce(() => {
        throw new ClaudeRunHttpError(
          500,
          "manual_rejected",
          "Keep this manual failure visible.",
        );
      })
      .mockImplementationOnce(() => {
        throw new ClaudeRunHttpError(
          409,
          "head_changed",
          "The pull request head changed.",
        );
      });
    const view = renderPullRuns([pull]);

    act(() => view.result.current.setMessage(pull.url, "Keep this draft."));
    await act(async () => {
      await view.result.current.start(pull);
    });
    const manual = view.result.current.states.get(pull.url);
    expect(manual).toMatchObject({
      message: "Keep this draft.",
      output: "[error] Keep this manual failure visible.\n",
      source: "manual",
      status: "failed",
    });

    await act(async () => {
      await view.result.current.start(pull, {
        agent: "claude",
        parallelism: 1,
        source: "auto",
        triggers: [automaticTrigger(pull)],
      });
    });

    expect(view.result.current.states.get(pull.url)).toEqual(manual);
  });

  it("keeps a manual stale-head preflight visible", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(() => {
      throw new ClaudeRunHttpError(
        409,
        "head_changed",
        "Refresh before running this manual fix.",
      );
    });
    const view = renderPullRuns([pull]);

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
    });

    expect(outcome).toMatchObject({
      code: "head_changed",
      kind: "rebaseline",
      source: "manual",
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      output: "[error] Refresh before running this manual fix.\n",
      source: "manual",
      status: "failed",
    });
  });

  it("classifies transport failure before acceptance as retryable", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(() => {
      throw new TypeError("Network connection failed.");
    });
    const view = renderPullRuns([pull]);

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull, {
        agent: "claude",
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
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [],
      output: "[error] Network connection failed.\n",
      status: "failed",
    });
  });

  it("keeps a terminal event before acceptance visible without archiving it", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* () {
      yield {
        message: "The request was rejected before it started.",
        type: "error",
      } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      source: "manual",
    });
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [],
      output: "[error] The request was rejected before it started.\n",
      status: "failed",
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
    const view = renderPullRuns([pull]);

    let first!: RunStartOutcome;
    await act(async () => {
      first = await view.result.current.start(pull, {
        agent: "claude",
        parallelism: 1,
        source: "auto",
        triggers: [firstTrigger, secondTrigger],
      });
    });
    let duplicate!: RunStartOutcome;
    await act(async () => {
      duplicate = await view.result.current.start(pull, {
        agent: "claude",
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
          agent: "claude",
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
        agent: "claude",
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
    const view = renderPullRuns([pull], refresh);
    act(() =>
      view.result.current.setMessage(pull.url, "Keep this repair draft."),
    );

    await act(async () => {
      await view.result.current.observeRepair(pull, {
        action: {
          agent: "claude",
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

  it("resets only stale repair state when the head changes and preserves fix history and the manual draft", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "history-before-repair",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { text: "Archived fix.", type: "text" } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    let repairSignal!: AbortSignal;
    repairs.stream.mockImplementation(async function* (
      _action,
      _pull,
      signal: AbortSignal,
    ) {
      repairSignal = signal;
      yield {
        actionId: "repair-head-change",
        headRefOid: pull.headRefOid,
        number: pull.number,
        output: "Repairing old head.",
        repository: pull.repository,
        state: "repair_running",
        terminal: false,
        type: "snapshot",
        updatedAt: "2026-07-23T00:00:00.000Z",
      };
      await waitForAbort(signal);
    });
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [pull] },
      },
    );
    act(() => view.result.current.setMessage(pull.url, "Create history."));
    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });
    act(() =>
      view.result.current.setMessage(
        pull.url,
        "Keep this draft across repair reconciliation.",
      ),
    );

    let observation!: Promise<void>;
    act(() => {
      observation = view.result.current.observeRepair(pull, {
        action: {
          agent: "claude",
          deduplicated: false,
          id: "repair-head-change",
          state: "repair_running",
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
    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)).toMatchObject({
        kind: "repair",
        status: "running",
      }),
    );

    const changed = {
      ...pull,
      headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
    };
    view.rerender({ items: [changed] });

    await waitFor(() =>
      expect(view.result.current.states.get(pull.url)).toMatchObject({
        history: [
          expect.objectContaining({
            id: "history-before-repair",
          }),
        ],
        kind: "fix",
        message: "Keep this draft across repair reconciliation.",
        output: "",
        repairState: null,
        status: "idle",
      }),
    );
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Archived fix.",
    );
    expect(repairSignal.aborted).toBe(true);
    await act(async () => observation);
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
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [first, second] },
      },
    );

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
    expect(view.result.current.states.get(first.url)).toMatchObject({
      history: [expect.objectContaining({ status: "completed" })],
      message: "",
      status: "idle",
    });
  });

  it("archives an accepted disconnect once and resets before resolving completion", async () => {
    const [pull] = pulls();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-disconnect",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { text: "Partial output.", type: "text" } satisfies ClaudeRunEvent;
    });
    const view = renderPullRuns([pull]);
    act(() => view.result.current.setMessage(pull.url, "Disconnect safely."));

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("failed");
    });

    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [
        expect.objectContaining({
          id: "run-disconnect",
          status: "failed",
        }),
      ],
      message: "Disconnect safely.",
      output: "",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Partial output.\n[error] Claude disconnected before reporting completion.\n",
    );
  });

  it("archives an accepted stream exception and suppresses every later event", async () => {
    const [pull] = pulls();
    let lateEventPulled = false;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-exception",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { text: "Before failure.", type: "text" } satisfies ClaudeRunEvent;
      throw new Error("Stream parser failed.");
    });
    const view = renderPullRuns([pull]);

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("failed");
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    expect(history).toMatchObject({
      id: "run-exception",
      status: "failed",
    });
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Before failure.\n[error] Stream parser failed.\n",
    );

    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: "run-terminal-late",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
      lateEventPulled = true;
      yield {
        text: "must never appear",
        type: "text",
      } satisfies ClaudeRunEvent;
    });
    await act(async () => {
      await finishRun(view.result.current.start(pull));
    });

    expect(lateEventPulled).toBe(false);
    expect(view.result.current.states.get(pull.url)?.history).toHaveLength(2);
    expect(
      view.result.current.states.get(pull.url)?.history[0]?.transcript.bytes,
    ).toBe(0);
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
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [pull] },
      },
    );
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
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [pull] },
      },
    );
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
    const view = renderPullRuns([pull]);
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
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [pull] },
      },
    );
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
    view.rerender({ items: [pull] });
    act(() => view.result.current.setMessage(pull.url, "Fresh state."));
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [],
      message: "Fresh state.",
      output: "",
      status: "idle",
    });
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
    const transcriptStore = createMemoryRunTranscriptStore();
    const view = renderHook(
      ({ items }) => usePullRuns(items, undefined, { transcriptStore }),
      {
        initialProps: { items: [pull] },
      },
    );
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
      history: [
        expect.objectContaining({
          id: "run-2",
          status: "completed",
        }),
      ],
      output: "",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "new output",
    );
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
    const view = renderPullRuns([pull]);
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
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [
        expect.objectContaining({
          id: "run-race",
          status: "completed",
        }),
      ],
      status: "idle",
    });
    await act(async () => {
      cancelGate.resolve();
      await cancelTask;
    });

    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [expect.objectContaining({ status: "completed" })],
      status: "idle",
    });
  });

  it("successful cancellation wins once when it precedes stream completion", async () => {
    const completionGate = createDeferred<void>();
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
        runId: "cancel-wins",
        type: "start",
      } satisfies ClaudeRunEvent;
      yield {
        text: "Before cancellation.",
        type: "text",
      } satisfies ClaudeRunEvent;
      await completionGate.promise;
      yield { exitCode: 0, type: "complete" } satisfies ClaudeRunEvent;
    });
    fixes.cancel.mockResolvedValue(undefined);
    const view = renderPullRuns([pull]);
    act(() => view.result.current.setMessage(pull.url, "Cancel this run."));

    let outcome!: RunStartOutcome;
    await act(async () => {
      outcome = await view.result.current.start(pull);
    });
    await act(async () => {
      await view.result.current.cancel(pull.url);
      if (outcome.kind !== "accepted") throw new Error("Run was not accepted.");
      await expect(outcome.completion).resolves.toBe("cancelled");
    });

    expect(signal.aborted).toBe(true);
    expect(view.result.current.states.get(pull.url)).toMatchObject({
      history: [
        expect.objectContaining({
          id: "cancel-wins",
          status: "cancelled",
        }),
      ],
      message: "Cancel this run.",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Before cancellation.",
    );

    await act(async () => {
      completionGate.resolve();
      await Promise.resolve();
    });
    expect(view.result.current.states.get(pull.url)?.history).toHaveLength(1);
    expect(view.result.current.states.get(pull.url)?.history[0]?.status).toBe(
      "cancelled",
    );
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
    const view = renderPullRuns([pull]);
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
    const view = renderPullRuns([pull]);
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
    const view = renderPullRuns([pull]);

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
      history: [
        expect.objectContaining({
          id: "review-to-cancel",
          instructions: {
            feedback: {
              body: "Keep the original error attached.",
              line: 17,
              path: "src/Error.php",
              side: "RIGHT",
            },
            kind: "review",
            message: "",
          },
          status: "cancelled",
        }),
      ],
      output: "",
      source: "manual",
      status: "idle",
    });
    const [history] = view.result.current.states.get(pull.url)?.history ?? [];
    if (!history) throw new Error("Run history was not archived.");
    await expect(view.result.current.loadTranscript(history)).resolves.toBe(
      "Review fix started.",
    );
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
    const view = renderPullRuns([pull]);
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

  it.each<[ClaudeRunEvent, RunStatus, string, string]>([
    [{ exitCode: 0, type: "complete" }, "completed", "", ""],
    [{ exitCode: 1, type: "complete" }, "failed", "", "Finish this run."],
    [
      { message: "The worker failed.", type: "error" },
      "failed",
      "[error] The worker failed.\n",
      "Finish this run.",
    ],
    [
      { message: "Run capacity reached.", type: "limit" },
      "limited",
      "[limit] Run capacity reached.\n",
      "Finish this run.",
    ],
    [{ type: "cancelled" }, "cancelled", "", "Finish this run."],
  ])(
    "terminal event $type maps to $1 and leaves the expected retry draft",
    async (terminal, expected, output, message) => {
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
      const view = renderPullRuns([pull]);
      act(() => view.result.current.setMessage(pull.url, "Finish this run."));

      await act(async () => {
        await finishRun(view.result.current.start(pull));
      });

      expect(view.result.current.states.get(pull.url)).toMatchObject({
        history: [
          expect.objectContaining({
            id: "run-terminal",
            status: expected,
          }),
        ],
        message,
        output: "",
        status: "idle",
      });
      const [history] = view.result.current.states.get(pull.url)?.history ?? [];
      if (!history) throw new Error("Run history was not archived.");
      await expect(view.result.current.loadTranscript(history)).resolves.toBe(
        output,
      );
    },
  );
});
