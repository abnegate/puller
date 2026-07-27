// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canVerifyEntireRelease,
  canVerifyRelease,
  isVerificationActive,
  reconcileRecentReleases,
  releaseVerificationKey,
  useReleaseVerificationBatches,
  useVerificationRuns,
  verificationKey,
  type VerificationRunState,
} from "./verifications";
import type {
  RecentRelease,
  RecentReleasesResponse,
  ReleaseVerificationEvent,
  ReleasedPull,
  VerificationRunEvent,
  VerificationRunRequest,
} from "./types";

const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelBatch: vi.fn(),
  stream: vi.fn(),
  streamBatch: vi.fn(),
}));

vi.mock("./api", () => ({
  cancelReleaseVerification: api.cancelBatch,
  cancelVerification: api.cancel,
  streamReleaseVerification: api.streamBatch,
  streamVerification: api.stream,
}));

const createDeferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );

const release = (id: string, number: number): RecentRelease => ({
  complete: true,
  id,
  name: `Release ${id}`,
  pipeline: {
    checkedAt: "2026-07-17T10:00:00.000Z",
    lookup: "complete",
    runs: [],
  },
  publishedAt: "2026-07-17T10:00:00.000Z",
  pulls: [
    {
      headSha:
        number === 1
          ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergedAt: "2026-07-17T09:00:00.000Z",
      number,
      repository: "appwrite/cloud",
      title: `Released pull ${number}`,
      url: `https://github.com/appwrite/cloud/pull/${number}`,
    },
  ],
  repository: "appwrite/cloud",
  repositoryUrl: "https://github.com/appwrite/cloud",
  source: "comparison",
  tag: `v1.0.${number}`,
  url: `https://github.com/appwrite/cloud/releases/tag/v1.0.${number}`,
  warning: null,
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("useVerificationRuns", () => {
  it("captures Codex for an individual verification", async () => {
    const item = release("release-codex", 1);
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "codex-verification", type: "start" };
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });
    const view = renderHook(() => useVerificationRuns([item], true, "codex"));

    await act(async () => {
      await view.result.current.start(item, item.pulls[0]!);
    });

    expect(api.stream).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
      expect.any(AbortSignal),
    );
    expect(
      view.result.current.states.get(verificationKey(item, item.pulls[0]!)),
    ).toMatchObject({ agent: "codex", outcome: "verified" });
  });

  it("preserves a safe direct preflight failure as a retryable error", async () => {
    const item = release("release-preflight", 1);
    const message =
      "GitHub and local Git cannot prove the exact target pull request delta.";
    api.stream.mockImplementation(async function* () {
      throw new Error(message);
    });
    const view = renderHook(() => useVerificationRuns([item]));
    const key = verificationKey(item, item.pulls[0]!);

    await act(async () => {
      await view.result.current.start(item, item.pulls[0]!);
    });

    expect(view.result.current.states.get(key)).toMatchObject({
      outcome: null,
      output: `[error] ${message}\n`,
      status: "failed",
    });
    expect(isVerificationActive(view.result.current.states.get(key))).toBe(
      false,
    );

    await act(async () => {
      await view.result.current.start(item, item.pulls[0]!);
    });
    expect(api.stream).toHaveBeenCalledTimes(2);
  });

  it("streams concurrent release verifications independently", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const releases = [release("release-1", 1), release("release-2", 2)];
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: `run-${request.pullNumber}`, type: "start" };
      yield { text: `output-${request.pullNumber}\n`, type: "text" };
      await (request.pullNumber === 1 ? firstGate.promise : secondGate.promise);
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });
    const view = renderHook(() => useVerificationRuns(releases));
    const firstKey = verificationKey(releases[0]!, releases[0]!.pulls[0]!);
    const secondKey = verificationKey(releases[1]!, releases[1]!.pulls[0]!);

    act(() => {
      void view.result.current.start(releases[0]!, releases[0]!.pulls[0]!);
      void view.result.current.start(releases[1]!, releases[1]!.pulls[0]!);
    });

    await waitFor(() => {
      expect(view.result.current.states.get(firstKey)).toMatchObject({
        output: "output-1\n",
        runId: "run-1",
        status: "running",
      });
      expect(view.result.current.states.get(secondKey)).toMatchObject({
        output: "output-2\n",
        runId: "run-2",
        status: "running",
      });
    });

    await act(async () => {
      firstGate.resolve();
      await firstGate.promise;
    });
    await waitFor(() =>
      expect(view.result.current.states.get(firstKey)?.status).toBe(
        "completed",
      ),
    );
    expect(view.result.current.states.get(secondKey)?.status).toBe("running");

    await act(async () => {
      secondGate.resolve();
      await secondGate.promise;
    });
  });

  it("preserves a present run across authoritative release object refreshes", async () => {
    const item = release("release-1", 1);
    const gate = createDeferred<void>();
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "run-preserved", type: "start" };
      yield { text: "still running\n", type: "text" };
      await gate.promise;
      yield { exitCode: 0, outcome: "verified", type: "complete" };
    });
    const view = renderHook(({ releases }) => useVerificationRuns(releases), {
      initialProps: { releases: [item] },
    });
    const key = verificationKey(item, item.pulls[0]!);

    act(() => {
      void view.result.current.start(item, item.pulls[0]!);
    });
    await waitFor(() =>
      expect(view.result.current.states.get(key)?.status).toBe("running"),
    );

    view.rerender({ releases: [{ ...item, pulls: [{ ...item.pulls[0]! }] }] });
    expect(view.result.current.states.get(key)).toMatchObject({
      output: "still running\n",
      runId: "run-preserved",
      status: "running",
    });
    expect(api.cancel).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it("cancels a running verification without affecting another row", async () => {
    const releases = [release("release-1", 1), release("release-2", 2)];
    api.cancel.mockResolvedValue(undefined);
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
      signal: AbortSignal,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: `run-${request.pullNumber}`, type: "start" };
      await waitForAbort(signal);
    });
    const view = renderHook(() => useVerificationRuns(releases));
    const firstKey = verificationKey(releases[0]!, releases[0]!.pulls[0]!);
    const secondKey = verificationKey(releases[1]!, releases[1]!.pulls[0]!);

    act(() => {
      void view.result.current.start(releases[0]!, releases[0]!.pulls[0]!);
      void view.result.current.start(releases[1]!, releases[1]!.pulls[0]!);
    });
    await waitFor(() => {
      expect(view.result.current.states.get(firstKey)?.status).toBe("running");
      expect(view.result.current.states.get(secondKey)?.status).toBe("running");
    });
    await act(async () => {
      await view.result.current.cancel(firstKey);
    });

    expect(api.cancel).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
    expect(view.result.current.states.get(firstKey)?.status).toBe("cancelled");
    expect(view.result.current.states.get(secondKey)?.status).toBe("running");
  });

  it("detaches and purges a removed active verification", async () => {
    const item = release("release-1", 1);
    let streamSignal!: AbortSignal;
    api.cancel.mockResolvedValue(undefined);
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
      signal: AbortSignal,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      streamSignal = signal;
      yield { ...request, runId: "run-removed", type: "start" };
      await waitForAbort(signal);
    });
    const view = renderHook(({ releases }) => useVerificationRuns(releases), {
      initialProps: { releases: [item] },
    });
    const key = verificationKey(item, item.pulls[0]!);

    act(() => {
      void view.result.current.start(item, item.pulls[0]!);
    });
    await waitFor(() =>
      expect(view.result.current.states.get(key)?.status).toBe("running"),
    );
    view.rerender({ releases: [] });

    await waitFor(() => expect(streamSignal.aborted).toBe(true));
    expect(api.cancel).toHaveBeenCalledWith(
      "run-removed",
      expect.any(AbortSignal),
    );
    expect(view.result.current.states.has(key)).toBe(false);
  });

  it("retains an omitted active stream for a partial catalog and cancels it after a complete catalog", async () => {
    const item = release("release-1", 1);
    let streamSignal!: AbortSignal;
    api.cancel.mockResolvedValue(undefined);
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
      signal: AbortSignal,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      streamSignal = signal;
      yield { ...request, runId: "run-partial", type: "start" };
      await waitForAbort(signal);
    });
    const view = renderHook(
      ({ authoritative, releases }) =>
        useVerificationRuns(releases, authoritative),
      {
        initialProps: { authoritative: true, releases: [item] },
      },
    );
    const key = verificationKey(item, item.pulls[0]!);

    act(() => {
      void view.result.current.start(item, item.pulls[0]!);
    });
    await waitFor(() =>
      expect(view.result.current.states.get(key)?.status).toBe("running"),
    );

    view.rerender({ authoritative: false, releases: [] });
    expect(streamSignal.aborted).toBe(false);
    expect(view.result.current.states.get(key)?.status).toBe("running");
    expect(api.cancel).not.toHaveBeenCalled();

    view.rerender({ authoritative: true, releases: [] });
    await waitFor(() => expect(streamSignal.aborted).toBe(true));
    await waitFor(() =>
      expect(api.cancel).toHaveBeenCalledWith(
        "run-partial",
        expect.any(AbortSignal),
      ),
    );
    expect(view.result.current.states.has(key)).toBe(false);
  });

  it("allows a listed pull discovered from release notes to reach the server guard", async () => {
    const item = {
      ...release("release-1", 1),
      complete: false,
      source: "notes-fallback" as const,
    };
    api.stream.mockImplementation(async function* (
      request: VerificationRunRequest,
    ): AsyncGenerator<VerificationRunEvent, void, undefined> {
      yield { ...request, runId: "run-notes", type: "start" };
      yield { exitCode: 0, outcome: "not_verified", type: "complete" };
    });
    const view = renderHook(() => useVerificationRuns([item]));

    expect(canVerifyRelease(item, item.pulls[0]!)).toBe(true);
    await act(async () => {
      await view.result.current.start(item, item.pulls[0]!);
    });

    expect(api.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        pullNumber: item.pulls[0]!.number,
        releaseId: item.id,
        tag: item.tag,
      }),
      expect.any(AbortSignal),
    );
  });

  it("refuses verification for unavailable membership or an unlisted pull", () => {
    const item = release("release-1", 1);
    const unavailable = {
      ...item,
      complete: false,
      source: "unavailable" as const,
    };
    const unlisted = {
      ...item.pulls[0]!,
      number: 99,
      url: "https://github.com/appwrite/cloud/pull/99",
    };
    const view = renderHook(() => useVerificationRuns([item, unavailable]));

    expect(canVerifyRelease(unavailable, unavailable.pulls[0]!)).toBe(false);
    expect(canVerifyRelease(item, unlisted)).toBe(false);
    act(() => {
      void view.result.current.start(unavailable, unavailable.pulls[0]!);
      void view.result.current.start(item, unlisted);
    });

    expect(api.stream).not.toHaveBeenCalled();
    expect(view.result.current.states.size).toBe(0);
  });
});

const batchRelease = (): RecentRelease => {
  const item = release("10", 1);
  const second = {
    ...item.pulls[0]!,
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    number: 2,
    title: "Released pull 2",
    url: "https://github.com/appwrite/cloud/pull/2",
  };
  const third = {
    ...item.pulls[0]!,
    headSha: "cccccccccccccccccccccccccccccccccccccccc",
    number: 3,
    title: "Released pull 3",
    url: "https://github.com/appwrite/cloud/pull/3",
  };

  return {
    ...item,
    complete: false,
    pulls: [item.pulls[0]!, second, third],
    source: "notes-fallback",
    tag: "v1.2.4",
    warning:
      "Release membership was discovered from release notes and will be rechecked before verification.",
  };
};

const batchStart = (
  item: RecentRelease,
  pulls: readonly ReleasedPull[] = item.pulls,
): Extract<ReleaseVerificationEvent, { type: "batch-start" }> => ({
  agent: "claude",
  batchId: "batch-1",
  pulls: pulls.map((pull) => ({
    agent: "claude",
    headSha: pull.headSha,
    pullNumber: pull.number,
    pullUrl: pull.url,
    releaseId: item.id,
    repository: item.repository,
    tag: item.tag,
  })),
  releaseId: item.id,
  repository: item.repository,
  tag: item.tag,
  type: "batch-start",
});

const batchVerification = (
  item: RecentRelease,
  index: number,
  state: Extract<ReleaseVerificationEvent, { type: "verification" }>["state"],
  event?: VerificationRunEvent,
): Extract<ReleaseVerificationEvent, { type: "verification" }> => {
  const pull = item.pulls[index]!;
  return {
    batchId: "batch-1",
    event,
    headSha: pull.headSha,
    pullNumber: pull.number,
    pullUrl: pull.url,
    state,
    type: "verification",
  };
};

describe("useReleaseVerificationBatches", () => {
  it("refuses a batch while a direct run is active and allows the selected agent after it settles", async () => {
    const item = release("10", 1);
    const pull = item.pulls[0]!;
    const key = verificationKey(item, pull);
    const active = new Map<string, VerificationRunState>([
      [
        key,
        {
          agent: "claude" as const,
          cancelling: false,
          outcome: null,
          output: "Direct output.",
          runId: "direct-run",
          status: "running" as const,
        },
      ],
    ]);
    api.streamBatch.mockImplementation(async function* (request: {
      agent: "claude" | "codex";
      releaseId: string;
      repository: string;
      tag: string;
    }): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      yield {
        ...batchStart(item),
        agent: request.agent,
        pulls: [
          {
            ...batchStart(item).pulls[0]!,
            agent: request.agent,
          },
        ],
      };
      yield batchVerification(item, 0, "complete", {
        exitCode: 0,
        outcome: "verified",
        type: "complete",
      });
      yield {
        batchId: "batch-1",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      };
    });
    const view = renderHook(
      ({ direct }) =>
        useReleaseVerificationBatches([item], true, "codex", direct),
      { initialProps: { direct: active } },
    );

    await act(async () => {
      await view.result.current.start(item);
    });
    expect(api.streamBatch).not.toHaveBeenCalled();

    view.rerender({
      direct: new Map([
        [
          key,
          {
            ...active.get(key)!,
            status: "completed" as const,
          },
        ],
      ]),
    });
    await act(async () => {
      await view.result.current.start(item);
    });

    expect(api.streamBatch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
      expect.any(AbortSignal),
    );
  });

  it("captures Codex for Verify all and every batch member", async () => {
    const item = batchRelease();
    api.streamBatch.mockImplementation(async function* (request: {
      agent: "claude" | "codex";
      releaseId: string;
      repository: string;
      tag: string;
    }): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      yield {
        ...batchStart(item),
        agent: request.agent,
        pulls: item.pulls.map((pull) => ({
          agent: request.agent,
          headSha: pull.headSha,
          pullNumber: pull.number,
          pullUrl: pull.url,
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
        })),
      };
      for (const pull of item.pulls) {
        yield batchVerification(item, item.pulls.indexOf(pull), "queued");
        yield batchVerification(item, item.pulls.indexOf(pull), "complete", {
          exitCode: 0,
          outcome: "verified",
          type: "complete",
        });
      }
      yield {
        batchId: "batch-1",
        totals: {
          complete: item.pulls.length,
          error: 0,
          existing: 0,
          total: item.pulls.length,
        },
        type: "complete",
      };
    });
    const view = renderHook(() =>
      useReleaseVerificationBatches([item], true, "codex"),
    );

    await act(async () => {
      await view.result.current.start(item);
    });

    expect(api.streamBatch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
      expect.any(AbortSignal),
    );
    expect(
      [...view.result.current.pullStates.values()].every(
        (state) => state.agent === "codex",
      ),
    ).toBe(true);
  });

  it("keeps child preflight errors separate from every behavioral outcome", async () => {
    const item = batchRelease();
    const fourth = {
      ...item.pulls[0]!,
      headSha: "dddddddddddddddddddddddddddddddddddddddd",
      number: 4,
      title: "Released pull 4",
      url: "https://github.com/appwrite/cloud/pull/4",
    };
    const mixed = { ...item, pulls: [...item.pulls, fourth] };
    const message =
      "GitHub and local Git cannot prove the exact target pull request delta.";
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(mixed);
      yield batchVerification(mixed, 0, "queued");
      yield {
        ...batchVerification(mixed, 0, "error"),
        code: "verification_delta_unavailable",
        message,
      };
      yield batchVerification(mixed, 1, "queued");
      yield batchVerification(mixed, 1, "complete", {
        exitCode: 0,
        outcome: "verified",
        type: "complete",
      });
      yield batchVerification(mixed, 2, "queued");
      yield batchVerification(mixed, 2, "complete", {
        exitCode: 0,
        outcome: "not_verified",
        type: "complete",
      });
      yield batchVerification(mixed, 3, "queued");
      yield batchVerification(mixed, 3, "complete", {
        exitCode: 0,
        outcome: "unavailable",
        type: "complete",
      });
      yield {
        batchId: "batch-1",
        totals: { complete: 3, error: 1, existing: 0, total: 4 },
        type: "complete",
      };
    });
    const view = renderHook(() => useReleaseVerificationBatches([mixed]));

    await act(async () => {
      await view.result.current.start(mixed);
    });

    expect(
      view.result.current.states.get(releaseVerificationKey(mixed)),
    ).toMatchObject({
      errors: 1,
      existing: 0,
      notVerified: 1,
      settled: 4,
      status: "completed",
      total: 4,
      unavailable: 1,
      verified: 1,
    });
    expect(
      view.result.current.pullStates.get(
        verificationKey(mixed, mixed.pulls[0]!),
      ),
    ).toMatchObject({
      outcome: null,
      output: `[error] ${message}\n`,
      status: "failed",
    });
    expect(
      view.result.current.pullStates.get(
        verificationKey(mixed, mixed.pulls[3]!),
      ),
    ).toMatchObject({ outcome: "unavailable", status: "completed" });
  });

  it("keeps a batch execution reason and streamed command output on an unavailable row", async () => {
    const item = release("11", 1);
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(item);
      yield batchVerification(item, 0, "queued");
      yield {
        ...batchVerification(item, 0, "running", {
          text: "$ pnpm test\nTests could not connect to the service.\n",
          type: "text",
        }),
        message: "Executing the repository verification recipe.",
      };
      yield batchVerification(item, 0, "complete", {
        exitCode: 1,
        outcome: "unavailable",
        type: "complete",
      });
      yield {
        batchId: "batch-1",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      };
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    expect(
      view.result.current.pullStates.get(verificationKey(item, item.pulls[0]!)),
    ).toMatchObject({
      outcome: "unavailable",
      output:
        "[diagnostic] Executing the repository verification recipe.\n$ pnpm test\nTests could not connect to the service.\n",
      status: "completed",
    });
  });

  it("reconciles an authoritative subset, keeps omitted rows settled, and supports newly returned members", async () => {
    const item = batchRelease();
    const added = {
      ...item.pulls[0]!,
      headSha: "dddddddddddddddddddddddddddddddddddddddd",
      number: 4,
      title: "Newly discovered released pull",
      url: "https://github.com/appwrite/cloud/pull/4",
    };
    const authoritative = {
      ...item,
      pulls: [item.pulls[0]!, added],
    };
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(authoritative);
      yield batchVerification(authoritative, 0, "queued");
      yield batchVerification(authoritative, 0, "complete", {
        exitCode: 0,
        outcome: "verified",
        type: "complete",
      });
      yield batchVerification(authoritative, 1, "queued");
      yield batchVerification(authoritative, 1, "existing");
      yield {
        batchId: "batch-1",
        totals: { complete: 1, error: 0, existing: 1, total: 2 },
        type: "complete",
      };
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    expect(
      view.result.current.pullStates.get(verificationKey(item, item.pulls[0]!))
        ?.status,
    ).toBe("completed");
    for (const pull of item.pulls.slice(1)) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state).toMatchObject({
        cancelling: false,
        status: "membership-changed",
      });
      expect(state?.output).toContain("Release membership changed on GitHub");
      expect(isVerificationActive(state)).toBe(false);
    }
    expect(
      view.result.current.pullStates.get(verificationKey(item, added)),
    ).toMatchObject({ status: "existing" });
    expect(
      view.result.current.states.get(releaseVerificationKey(item)),
    ).toMatchObject({
      existing: 1,
      settled: 2,
      status: "completed",
      total: 2,
    });
    expect(api.streamBatch).toHaveBeenCalledWith(
      {
        agent: "claude",
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
      },
      expect.any(AbortSignal),
    );
    expect(api.streamBatch).toHaveBeenCalledTimes(1);
    expect(api.stream).not.toHaveBeenCalled();
  });

  it("settles every optimistic row when the authoritative batch has no members without per-pull fanout", async () => {
    const item = batchRelease();
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(item, []);
      yield {
        batchId: "batch-1",
        totals: { complete: 0, error: 0, existing: 0, total: 0 },
        type: "complete",
      };
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    for (const pull of item.pulls) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state).toMatchObject({
        cancelling: false,
        status: "membership-changed",
      });
      expect(state?.output).toContain(
        "this pull request is no longer included in this release",
      );
      expect(isVerificationActive(state)).toBe(false);
    }
    expect(
      view.result.current.states.get(releaseVerificationKey(item)),
    ).toMatchObject({ settled: 0, status: "completed", total: 0 });
    expect(api.streamBatch).toHaveBeenCalledWith(
      {
        agent: "claude",
        releaseId: item.id,
        repository: item.repository,
        tag: item.tag,
      },
      expect.any(AbortSignal),
    );
    expect(api.streamBatch).toHaveBeenCalledTimes(1);
    expect(api.stream).not.toHaveBeenCalled();
  });

  it("clears every previous result before retrying Verify all and marks omitted members", async () => {
    const item = batchRelease();
    const retryStarted = createDeferred<void>();
    const finishRetry = createDeferred<void>();
    api.streamBatch
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        yield batchStart(item);
        yield batchVerification(item, 0, "queued");
        yield batchVerification(item, 0, "running", {
          agent: "claude",
          headSha: item.pulls[0]!.headSha,
          pullNumber: item.pulls[0]!.number,
          pullUrl: item.pulls[0]!.url,
          releaseId: item.id,
          repository: item.repository,
          runId: "old-run",
          tag: item.tag,
          type: "start",
        });
        yield batchVerification(item, 0, "running", {
          text: "Old verified output.\n",
          type: "text",
        });
        yield batchVerification(item, 0, "complete", {
          exitCode: 0,
          outcome: "verified",
          type: "complete",
        });
        yield batchVerification(item, 1, "queued");
        yield batchVerification(item, 1, "existing");
        yield batchVerification(item, 2, "queued");
        yield batchVerification(item, 2, "error", {
          message: "Verification failed.",
          type: "error",
        });
        yield {
          batchId: "batch-1",
          totals: { complete: 1, error: 1, existing: 1, total: 3 },
          type: "complete",
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        ReleaseVerificationEvent,
        void,
        undefined
      > {
        retryStarted.resolve();
        await finishRetry.promise;
        yield batchStart(item, []);
        yield {
          batchId: "batch-1",
          totals: { complete: 0, error: 0, existing: 0, total: 0 },
          type: "complete",
        };
      });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    const firstKey = verificationKey(item, item.pulls[0]!);
    const secondKey = verificationKey(item, item.pulls[1]!);
    const thirdKey = verificationKey(item, item.pulls[2]!);
    expect(view.result.current.pullStates.get(firstKey)).toMatchObject({
      outcome: "verified",
      output: "Old verified output.\n",
      runId: "old-run",
      status: "completed",
    });
    expect(view.result.current.pullStates.get(secondKey)).toMatchObject({
      status: "existing",
    });
    expect(view.result.current.pullStates.get(thirdKey)).toMatchObject({
      output: "[error] Verification failed.\n",
      status: "failed",
    });

    act(() => {
      void view.result.current.start(item);
    });
    await retryStarted.promise;

    for (const pull of item.pulls) {
      expect(
        view.result.current.pullStates.get(verificationKey(item, pull)),
      ).toEqual({
        agent: "claude",
        cancelling: false,
        outcome: null,
        output: "",
        runId: null,
        status: "starting",
      });
    }

    await act(async () => finishRetry.resolve());

    for (const pull of item.pulls) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state).toMatchObject({
        cancelling: false,
        outcome: null,
        runId: null,
        status: "membership-changed",
      });
      expect(state?.output).toBe(
        "[diagnostic] Release membership changed on GitHub; this pull request is no longer included in this release.\n",
      );
    }
    expect(api.streamBatch).toHaveBeenCalledTimes(2);
    expect(api.stream).not.toHaveBeenCalled();
  });

  it("fails every active member atomically when the batch stream fails and preserves settled members", async () => {
    const item = batchRelease();
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(item);
      yield batchVerification(item, 0, "queued");
      yield batchVerification(item, 0, "running", {
        ...{
          agent: "claude",
          headSha: item.pulls[0]!.headSha,
          pullNumber: item.pulls[0]!.number,
          pullUrl: item.pulls[0]!.url,
          releaseId: item.id,
          repository: item.repository,
          tag: item.tag,
        },
        runId: "run-1",
        type: "start",
      });
      yield batchVerification(item, 0, "complete", {
        exitCode: 0,
        outcome: "verified",
        type: "complete",
      });
      yield batchVerification(item, 1, "queued");
      yield batchVerification(item, 1, "existing", undefined);
      yield batchVerification(item, 2, "queued");
      yield batchVerification(item, 2, "running");
      throw new Error("Batch connection dropped.");
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    const batch = view.result.current.states.get(releaseVerificationKey(item));
    const first = view.result.current.pullStates.get(
      verificationKey(item, item.pulls[0]!),
    );
    const second = view.result.current.pullStates.get(
      verificationKey(item, item.pulls[1]!),
    );
    const third = view.result.current.pullStates.get(
      verificationKey(item, item.pulls[2]!),
    );
    expect(batch).toMatchObject({
      errors: 1,
      settled: 3,
      status: "failed",
      total: 3,
    });
    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("existing");
    expect(third).toMatchObject({
      cancelling: false,
      status: "failed",
    });
    expect(third?.output).toContain(
      "[error] Release verification failed: Batch connection dropped.",
    );
    expect(isVerificationActive(third)).toBe(false);
    expect(api.streamBatch).toHaveBeenCalledTimes(1);
    expect(api.stream).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.start(item);
    });
    expect(api.streamBatch).toHaveBeenCalledTimes(2);
    expect(api.stream).not.toHaveBeenCalled();
  });

  it("cancels every starting member before the server assigns a batch identity", async () => {
    const item = batchRelease();
    api.streamBatch.mockImplementation(async function* (
      _request: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      await waitForAbort(signal);
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    act(() => {
      void view.result.current.start(item);
    });
    await waitFor(() =>
      expect(
        view.result.current.states.get(releaseVerificationKey(item))?.status,
      ).toBe("starting"),
    );
    await act(async () => {
      await view.result.current.cancel(item);
    });

    expect(api.cancelBatch).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(
      view.result.current.states.get(releaseVerificationKey(item)),
    ).toMatchObject({ settled: 3, status: "cancelled" });
    for (const pull of item.pulls) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state).toMatchObject({ cancelling: false, status: "cancelled" });
      expect(state?.output).toContain(
        "[diagnostic] Release verification cancelled before it started.",
      );
      expect(isVerificationActive(state)).toBe(false);
    }
  });

  it("uses the batch cancellation endpoint and settles every running member after cancellation succeeds", async () => {
    const item = batchRelease();
    api.cancelBatch.mockResolvedValue(undefined);
    api.streamBatch.mockImplementation(async function* (
      _request: unknown,
      signal: AbortSignal,
    ): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
      yield batchStart(item);
      for (let index = 0; index < item.pulls.length; index += 1) {
        yield batchVerification(item, index, "queued");
        yield batchVerification(item, index, "running");
      }
      await waitForAbort(signal);
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    act(() => {
      void view.result.current.start(item);
    });
    await waitFor(() =>
      expect(
        view.result.current.states.get(releaseVerificationKey(item))?.status,
      ).toBe("running"),
    );
    await act(async () => {
      await view.result.current.cancel(item);
    });

    expect(api.cancelBatch).toHaveBeenCalledWith(
      "batch-1",
      expect.any(AbortSignal),
    );
    expect(api.cancel).not.toHaveBeenCalled();
    expect(
      view.result.current.states.get(releaseVerificationKey(item)),
    ).toMatchObject({ settled: 3, status: "cancelled" });
    for (const pull of item.pulls) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state?.status).toBe("cancelled");
      expect(state?.output).toContain(
        "[diagnostic] Release verification cancelled.",
      );
      expect(isVerificationActive(state)).toBe(false);
    }
  });

  it("settles every active member when the server terminates the batch as cancelled", async () => {
    const item = batchRelease();
    api.streamBatch.mockImplementation(async function* (): AsyncGenerator<
      ReleaseVerificationEvent,
      void,
      undefined
    > {
      yield batchStart(item);
      for (let index = 0; index < item.pulls.length; index += 1) {
        yield batchVerification(item, index, "queued");
        yield batchVerification(item, index, "running");
      }
      yield {
        batchId: "batch-1",
        message: "The server stopped this release verification.",
        type: "cancelled",
      };
    });
    const view = renderHook(() => useReleaseVerificationBatches([item]));

    await act(async () => {
      await view.result.current.start(item);
    });

    expect(
      view.result.current.states.get(releaseVerificationKey(item)),
    ).toMatchObject({ settled: 3, status: "cancelled" });
    for (const pull of item.pulls) {
      const state = view.result.current.pullStates.get(
        verificationKey(item, pull),
      );
      expect(state?.status).toBe("cancelled");
      expect(state?.output).toContain(
        "[diagnostic] The server stopped this release verification.",
      );
      expect(isVerificationActive(state)).toBe(false);
    }
  });

  it("accepts the real notes-fallback release shape and rejects only incomplete identities", () => {
    const item = batchRelease();

    expect(canVerifyEntireRelease(item)).toBe(true);
    expect(canVerifyEntireRelease({ ...item, id: "" })).toBe(false);
    expect(canVerifyEntireRelease({ ...item, repository: "" })).toBe(false);
    expect(canVerifyEntireRelease({ ...item, tag: "" })).toBe(false);
    expect(canVerifyEntireRelease({ ...item, pulls: [] })).toBe(false);
    expect(canVerifyEntireRelease({ ...item, source: "unavailable" })).toBe(
      false,
    );
  });
});

describe("reconcileRecentReleases", () => {
  const response = (
    releases: RecentRelease[],
    partial: boolean,
    generatedAt = partial
      ? "2026-07-17T11:00:00.000Z"
      : "2026-07-17T10:00:00.000Z",
  ): RecentReleasesResponse => ({
    generatedAt,
    partial,
    releases,
    warnings: partial ? ["Some releases were omitted."] : [],
  });

  it("merges release identities and pull memberships only for a partial catalog", () => {
    const first = release("release-1", 1);
    const second = release("release-2", 2);
    const extraPull = {
      ...first.pulls[0]!,
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      number: 3,
      title: "Released pull 3",
      url: "https://github.com/appwrite/cloud/pull/3",
    };
    const previous = response(
      [{ ...first, pulls: [first.pulls[0]!, extraPull] }, second],
      false,
    );
    const incomingRelease = { ...first, pulls: [first.pulls[0]!] };
    const partial = response([incomingRelease], true);

    const merged = reconcileRecentReleases(previous, partial);

    expect(merged.releases).toHaveLength(2);
    expect(merged.releases[0]!.pulls.map((pull) => pull.url)).toEqual([
      first.pulls[0]!.url,
      extraPull.url,
    ]);
    expect(merged.releases[0]).toMatchObject({
      complete: false,
      warning: expect.stringContaining("partial refresh omitted"),
    });
    expect(merged.releases[1]).toMatchObject({
      complete: false,
      id: second.id,
      warning: expect.stringContaining("omitted from the partial refresh"),
    });

    const authoritative = response([incomingRelease], false);
    expect(reconcileRecentReleases(merged, authoritative)).toBe(authoritative);
  });

  it("keeps the exact one-week boundary and removes older incoming releases", () => {
    const generated = new Date(2026, 6, 21, 12, 0, 0);
    const boundary = new Date(generated.getTime() - 7 * 24 * 60 * 60 * 1000);
    const inside = {
      ...release("release-boundary", 1),
      publishedAt: boundary.toISOString(),
    };
    const outside = {
      ...release("release-outside", 2),
      publishedAt: new Date(boundary.getTime() - 1).toISOString(),
    };
    const incoming = response(
      [inside, outside],
      false,
      generated.toISOString(),
    );

    const reconciled = reconcileRecentReleases(null, incoming);

    expect(reconciled.releases).toEqual([inside]);
  });

  it("prunes old incoming and retained releases while preserving in-window pulls during a partial refresh", () => {
    const generated = new Date(2026, 6, 21, 12, 0, 0);
    const withinWindow = new Date(2026, 6, 20, 9, 0, 0).toISOString();
    const outsideWindow = new Date(2026, 6, 14, 11, 59, 59).toISOString();
    const current = {
      ...release("release-current", 1),
      publishedAt: withinWindow,
    };
    const retainedPull = {
      ...current.pulls[0]!,
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      number: 3,
      title: "Retained pull",
      url: "https://github.com/appwrite/cloud/pull/3",
    };
    const old = {
      ...release("release-old", 2),
      publishedAt: outsideWindow,
    };
    const previous = response(
      [{ ...current, pulls: [current.pulls[0]!, retainedPull] }, old],
      false,
      new Date(2026, 6, 21, 11, 0, 0).toISOString(),
    );
    const incoming = response([current, old], true, generated.toISOString());

    const reconciled = reconcileRecentReleases(previous, incoming);

    expect(reconciled.releases).toHaveLength(1);
    expect(reconciled.releases[0]!.id).toBe(current.id);
    expect(reconciled.releases[0]!.pulls.map((pull) => pull.url)).toEqual([
      current.pulls[0]!.url,
      retainedPull.url,
    ]);
  });

  it("places a newer retained release before an older incoming release after a partial refresh", () => {
    const retained = {
      ...release("release-retained", 1),
      publishedAt: "2026-07-17T10:00:00.000Z",
    };
    const incomingRelease = {
      ...release("release-incoming", 2),
      publishedAt: "2026-07-16T10:00:00.000Z",
    };
    const previous = response([retained], false);
    const incoming = response([incomingRelease], true);

    const reconciled = reconcileRecentReleases(previous, incoming);

    expect(reconciled.releases.map(({ id }) => id)).toEqual([
      retained.id,
      incomingRelease.id,
    ]);
  });

  it("does not let an older complete membership response regress pipeline evidence", () => {
    const item = release("release-pipeline", 1);
    const run = {
      attempt: 1,
      createdAt: "2026-07-17T10:01:00.000Z",
      id: "123",
      name: "Production Deployment",
      path: ".github/workflows/production.yml",
      startedAt: "2026-07-17T10:02:00.000Z",
      state: "succeeded" as const,
      updatedAt: "2026-07-17T10:03:00.000Z",
      url: "https://github.com/appwrite/cloud/actions/runs/123",
      workflowId: "456",
    };
    const previousRelease = {
      ...item,
      pipeline: {
        checkedAt: "2026-07-17T10:05:00.000Z",
        lookup: "complete" as const,
        runs: [run],
      },
    };
    const incomingRelease = {
      ...item,
      pipeline: {
        checkedAt: "2026-07-17T10:04:00.000Z",
        lookup: "pending" as const,
        runs: [{ ...run, state: "running" as const }],
      },
    };

    const reconciled = reconcileRecentReleases(
      response([previousRelease], false),
      response([incomingRelease], false),
    );

    expect(reconciled.releases[0]!.pipeline).toBe(previousRelease.pipeline);
  });

  it("retains exact runs while recording a newer unavailable lookup", () => {
    const item = release("release-pipeline", 1);
    const previousRelease = {
      ...item,
      pipeline: {
        checkedAt: "2026-07-17T10:04:00.000Z",
        lookup: "complete" as const,
        runs: [
          {
            attempt: 1,
            createdAt: "2026-07-17T10:01:00.000Z",
            id: "123",
            name: "Production Deployment",
            path: ".github/workflows/production.yml",
            startedAt: "2026-07-17T10:02:00.000Z",
            state: "succeeded" as const,
            updatedAt: "2026-07-17T10:03:00.000Z",
            url: "https://github.com/appwrite/cloud/actions/runs/123",
            workflowId: "456",
          },
        ],
      },
    };
    const incomingRelease = {
      ...item,
      pipeline: {
        checkedAt: "2026-07-17T10:05:00.000Z",
        lookup: "unavailable" as const,
        runs: [],
      },
    };

    const reconciled = reconcileRecentReleases(
      response([previousRelease], false),
      response([incomingRelease], false),
    );

    expect(reconciled.releases[0]!.pipeline).toEqual({
      checkedAt: incomingRelease.pipeline.checkedAt,
      lookup: "unavailable",
      runs: previousRelease.pipeline.runs,
    });
  });

  it("does not carry pipeline evidence across a changed publication identity", () => {
    const previousRelease = {
      ...release("release-reused", 1),
      pipeline: {
        checkedAt: "2026-07-17T10:05:00.000Z",
        lookup: "complete" as const,
        runs: [],
      },
    };
    const incomingRelease = {
      ...previousRelease,
      pipeline: {
        checkedAt: "2026-07-17T10:01:00.000Z",
        lookup: "pending" as const,
        runs: [],
      },
      publishedAt: "2026-07-17T10:00:01.000Z",
    };

    const reconciled = reconcileRecentReleases(
      response([previousRelease], false),
      response([incomingRelease], false),
    );

    expect(reconciled.releases[0]).toBe(incomingRelease);
  });
});
