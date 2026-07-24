// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyReleasePipelineSnapshot,
  reconcileRecentReleasePipeline,
  RELEASE_PIPELINE_REFRESH_INTERVAL,
  releasePipelineFingerprint,
  useReleasePipelinePolling,
} from "./release-pipelines";
import type {
  RecentRelease,
  RecentReleasesResponse,
  ReleasePipeline,
  ReleasePipelineRun,
  ReleasePipelinesResponse,
} from "./types";

const api = vi.hoisted(() => ({
  getReleasePipelines: vi.fn(),
}));

vi.mock("./api", () => ({
  getReleasePipelines: api.getReleasePipelines,
}));

const originalVisibility = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

const setVisibility = (visibility: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visibility,
  });
};

const createDeferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const run = (
  state: ReleasePipelineRun["state"],
  change: Partial<ReleasePipelineRun> = {},
): ReleasePipelineRun => ({
  attempt: 1,
  createdAt: "2026-07-24T01:00:00.000Z",
  id: "123",
  name: "Production Deployment",
  path: ".github/workflows/production.yml",
  startedAt: "2026-07-24T01:01:00.000Z",
  state,
  updatedAt: "2026-07-24T01:02:00.000Z",
  url: "https://github.com/appwrite/cloud/actions/runs/123",
  workflowId: "456",
  ...change,
});

const pipeline = (
  lookup: ReleasePipeline["lookup"],
  runs: ReleasePipelineRun[] = [],
  checkedAt = "2026-07-24T01:03:00.000Z",
): ReleasePipeline => ({ checkedAt, lookup, runs });

const release = (
  id: string,
  releasePipeline: ReleasePipeline,
  change: Partial<RecentRelease> = {},
): RecentRelease => ({
  complete: true,
  id,
  name: `Release ${id}`,
  pipeline: releasePipeline,
  publishedAt: "2026-07-24T00:30:00.000Z",
  pulls: [],
  repository: "appwrite/cloud",
  repositoryUrl: "https://github.com/appwrite/cloud",
  source: "comparison",
  tag: `v1.0.${id}`,
  url: `https://github.com/appwrite/cloud/releases/tag/v1.0.${id}`,
  warning: null,
  ...change,
});

const snapshot = (
  item: RecentRelease,
  releasePipeline: ReleasePipeline,
): ReleasePipelinesResponse => ({
  generatedAt: "2026-07-24T01:04:00.000Z",
  releases: [
    {
      id: item.id,
      pipeline: releasePipeline,
      publishedAt: item.publishedAt,
      repository: item.repository,
      tag: item.tag,
    },
  ],
});

const catalog = (releases: RecentRelease[]): RecentReleasesResponse => ({
  generatedAt: "2026-07-24T01:04:00.000Z",
  partial: false,
  releases,
  warnings: [],
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  if (originalVisibility) {
    Object.defineProperty(document, "visibilityState", originalVisibility);
  }
});

beforeEach(() => {
  setVisibility("visible");
});

describe("release pipeline reconciliation", () => {
  it("matches only the full release identity", () => {
    const item = release("1", pipeline("complete"));
    const changedPublishedAt = snapshot(
      { ...item, publishedAt: "2026-07-24T00:31:00.000Z" },
      pipeline("pending"),
    );

    expect(
      applyReleasePipelineSnapshot(catalog([item]), changedPublishedAt),
    ).toEqual(catalog([item]));
    expect(releasePipelineFingerprint([item])).not.toBe(
      releasePipelineFingerprint([
        { ...item, publishedAt: "2026-07-24T00:31:00.000Z" },
      ]),
    );
    expect(releasePipelineFingerprint([item])).not.toBe(
      releasePipelineFingerprint([
        { ...item, repository: "Appwrite/cloud" },
      ]),
    );
  });

  it("does not apply pipeline evidence from a case-variant repository", () => {
    const item = release("1", pipeline("complete", [run("succeeded")]));
    const caseVariant = snapshot(
      { ...item, repository: "Appwrite/cloud" },
      pipeline("complete", [run("running")]),
    );
    const current = catalog([item]);

    expect(applyReleasePipelineSnapshot(current, caseVariant)).toBe(current);
  });

  it("prevents older snapshots from overwriting newer pipeline evidence", () => {
    const current = release(
      "1",
      pipeline("complete", [run("succeeded")], "2026-07-24T01:03:00.000Z"),
    );
    const stale = {
      ...current,
      pipeline: pipeline(
        "pending",
        [run("running")],
        "2026-07-24T01:02:00.000Z",
      ),
    };
    const differentIdentity = {
      ...stale,
      publishedAt: "2026-07-24T00:31:00.000Z",
    };

    expect(
      reconcileRecentReleasePipeline(current, differentIdentity),
    ).toBe(differentIdentity);
    expect(
      reconcileRecentReleasePipeline(current, stale).pipeline,
    ).toBe(current.pipeline);
  });

  it("retains exact prior runs when a newer lookup is unavailable", () => {
    const previous = release(
      "1",
      pipeline("complete", [run("succeeded")], "2026-07-24T01:03:00.000Z"),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "unavailable",
        [],
        "2026-07-24T01:05:00.000Z",
      ),
    };

    const reconciled = reconcileRecentReleasePipeline(previous, incoming);
    expect(reconciled.pipeline).toEqual({
      checkedAt: "2026-07-24T01:05:00.000Z",
      lookup: "unavailable",
      runs: previous.pipeline.runs,
    });
  });

  it("keeps a pending lookup active across a transient unavailable refresh", () => {
    const previous = release(
      "1",
      pipeline("pending", [], "2026-07-24T01:03:00.000Z"),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "unavailable",
        [],
        "2026-07-24T01:05:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline,
    ).toEqual({
      checkedAt: "2026-07-24T01:05:00.000Z",
      lookup: "pending",
      runs: [],
    });
  });

  it("does not regress a deployed attempt two to a later-checked attempt one", () => {
    const deployed = run("succeeded", {
      attempt: 2,
      updatedAt: "2026-07-24T01:04:00.000Z",
    });
    const previous = release(
      "1",
      pipeline(
        "complete",
        [deployed],
        "2026-07-24T01:05:00.000Z",
      ),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [
          run("running", {
            attempt: 1,
            updatedAt: "2026-07-24T01:08:00.000Z",
          }),
        ],
        "2026-07-24T01:09:00.000Z",
      ),
    };

    const reconciled = reconcileRecentReleasePipeline(previous, incoming);
    expect(reconciled.pipeline.checkedAt).toBe(incoming.pipeline.checkedAt);
    expect(reconciled.pipeline.runs).toEqual([deployed]);
  });

  it("does not regress the same attempt to an older update", () => {
    const current = run("succeeded", {
      attempt: 2,
      updatedAt: "2026-07-24T01:07:00.000Z",
    });
    const previous = release(
      "1",
      pipeline("complete", [current], "2026-07-24T01:08:00.000Z"),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [
          run("running", {
            attempt: 2,
            updatedAt: "2026-07-24T01:06:00.000Z",
          }),
        ],
        "2026-07-24T01:09:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([current]);
  });

  it("accepts a later update for the same run attempt", () => {
    const previous = release(
      "1",
      pipeline(
        "complete",
        [
          run("running", {
            attempt: 2,
            updatedAt: "2026-07-24T01:06:00.000Z",
          }),
        ],
        "2026-07-24T01:07:00.000Z",
      ),
    );
    const completed = run("succeeded", {
      attempt: 2,
      updatedAt: "2026-07-24T01:08:00.000Z",
    });
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [completed],
        "2026-07-24T01:09:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([completed]);
  });

  it("retains a workflow temporarily missing from a later lookup", () => {
    const production = run("succeeded", {
      id: "123",
      workflowId: "456",
    });
    const images = run("succeeded", {
      createdAt: "2026-07-24T00:58:00.000Z",
      id: "789",
      name: "Publish Images",
      updatedAt: "2026-07-24T01:01:00.000Z",
      url: "https://github.com/appwrite/cloud/actions/runs/789",
      workflowId: "999",
    });
    const previous = release(
      "1",
      pipeline(
        "complete",
        [production, images],
        "2026-07-24T01:03:00.000Z",
      ),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [production],
        "2026-07-24T01:04:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([production, images]);
  });

  it("accepts a genuinely newer attempt even when it is still running", () => {
    const previous = release(
      "1",
      pipeline(
        "complete",
        [run("succeeded", { attempt: 2 })],
        "2026-07-24T01:03:00.000Z",
      ),
    );
    const attempt = run("running", {
      attempt: 3,
      updatedAt: "2026-07-24T01:04:00.000Z",
    });
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [attempt],
        "2026-07-24T01:05:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([attempt]);
  });

  it("accepts a genuinely newer run for the same workflow", () => {
    const previousRun = run("succeeded", {
      createdAt: "2026-07-24T01:00:00.000Z",
      id: "123",
    });
    const previous = release(
      "1",
      pipeline(
        "complete",
        [previousRun],
        "2026-07-24T01:03:00.000Z",
      ),
    );
    const rerun = run("running", {
      createdAt: "2026-07-24T01:04:00.000Z",
      id: "124",
      updatedAt: "2026-07-24T01:05:00.000Z",
      url: "https://github.com/appwrite/cloud/actions/runs/124",
    });
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [rerun],
        "2026-07-24T01:06:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([rerun]);

    const tied = {
      ...incoming,
      pipeline: pipeline(
        "complete",
        [
          {
            ...rerun,
            createdAt: rerun.createdAt,
            id: "125",
            url: "https://github.com/appwrite/cloud/actions/runs/125",
          },
        ],
        "2026-07-24T01:07:00.000Z",
      ),
    };
    expect(
      reconcileRecentReleasePipeline(incoming, tied).pipeline.runs[0]!.id,
    ).toBe("125");
  });

  it("preserves distinct workflows in deterministic newest-first order", () => {
    const older = run("succeeded", {
      createdAt: "2026-07-24T01:00:00.000Z",
      id: "123",
      workflowId: "456",
    });
    const previous = release(
      "1",
      pipeline("complete", [older], "2026-07-24T01:03:00.000Z"),
    );
    const newer = run("running", {
      createdAt: "2026-07-24T01:04:00.000Z",
      id: "789",
      name: "Publish Images",
      updatedAt: "2026-07-24T01:05:00.000Z",
      url: "https://github.com/appwrite/cloud/actions/runs/789",
      workflowId: "999",
    });
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "complete",
        [newer],
        "2026-07-24T01:06:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline.runs,
    ).toEqual([newer, older]);
  });

  it("does not regress a confirmed lookup to pending when runs are omitted", () => {
    const confirmed = run("succeeded");
    const previous = release(
      "1",
      pipeline(
        "complete",
        [confirmed],
        "2026-07-24T01:03:00.000Z",
      ),
    );
    const incoming = {
      ...previous,
      pipeline: pipeline(
        "pending",
        [],
        "2026-07-24T01:04:00.000Z",
      ),
    };

    expect(
      reconcileRecentReleasePipeline(previous, incoming).pipeline,
    ).toEqual({
      checkedAt: incoming.pipeline.checkedAt,
      lookup: "complete",
      runs: [confirmed],
    });
  });
});

describe("useReleasePipelinePolling", () => {
  it("chains active polls five seconds after the previous request settles", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    api.getReleasePipelines.mockResolvedValue(
      snapshot(item, pipeline("pending", [run("running")])),
    );
    const onSnapshot = vi.fn();
    renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL - 1,
      );
    });
    expect(api.getReleasePipelines).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);
    expect(api.getReleasePipelines).toHaveBeenNthCalledWith(
      1,
      expect.any(AbortSignal),
      false,
    );
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);
  });

  it("confirms an active-to-terminal transition once before stopping", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    api.getReleasePipelines
      .mockResolvedValueOnce(
        snapshot(
          item,
          pipeline(
            "complete",
            [run("succeeded")],
            "2026-07-24T01:04:00.000Z",
          ),
        ),
      )
      .mockResolvedValue(
        snapshot(
          item,
          pipeline(
            "complete",
            [run("succeeded")],
            "2026-07-24T01:04:00.000Z",
          ),
        ),
      );
    const view = renderHook(
      ({ releases }) =>
        useReleasePipelinePolling({
          enabled: true,
          onSnapshot: () => undefined,
          refreshRevision: 0,
          releases,
        }),
      { initialProps: { releases: [item] } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    view.rerender({
      releases: [
        release(
          "1",
          pipeline(
            "complete",
            [run("succeeded")],
            "2026-07-24T01:04:00.000Z",
          ),
        ),
      ],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL * 3,
      );
    });

    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);
    expect(api.getReleasePipelines.mock.calls).toEqual([
      [expect.any(AbortSignal), false],
      [expect.any(AbortSignal), false],
    ]);
  });

  it("forces explicit and recent-revision refreshes", async () => {
    const item = release("1", pipeline("complete"));
    api.getReleasePipelines.mockResolvedValue(
      snapshot(item, pipeline("complete")),
    );
    const view = renderHook(
      ({ refreshRevision }) =>
        useReleasePipelinePolling({
          enabled: true,
          onSnapshot: () => undefined,
          refreshRevision,
          releases: [item],
        }),
      { initialProps: { refreshRevision: 0 } },
    );

    await act(async () => {
      await view.result.current.refresh();
    });
    expect(api.getReleasePipelines).toHaveBeenNthCalledWith(
      1,
      expect.any(AbortSignal),
      true,
    );

    await act(async () => {
      view.rerender({ refreshRevision: 1 });
      await Promise.resolve();
    });
    expect(api.getReleasePipelines).toHaveBeenNthCalledWith(
      2,
      expect.any(AbortSignal),
      true,
    );
  });

  it("never overlaps active requests", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    const first = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(snapshot(item, pipeline("pending")));
    renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot: () => undefined,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL * 4,
      );
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(snapshot(item, pipeline("pending")));
      await first.promise;
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL - 1,
      );
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);
  });

  it("aborts on collapse and refreshes immediately when expanded", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    const pending = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(item, pipeline("complete")));
    const view = renderHook(
      ({ enabled }) =>
        useReleasePipelinePolling({
          enabled,
          onSnapshot: () => undefined,
          refreshRevision: 0,
          releases: [item],
        }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    const firstSignal = api.getReleasePipelines.mock.calls[0]?.[0];
    view.rerender({ enabled: false });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL * 2,
      );
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);

    view.rerender({ enabled: true });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);
  });

  it("aborts identity-stale work and ignores its late response", async () => {
    vi.useFakeTimers();
    const firstItem = release("1", pipeline("pending"));
    const secondItem = release("2", pipeline("complete"));
    const first = createDeferred<ReleasePipelinesResponse>();
    const second = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSnapshot = vi.fn();
    const view = renderHook(
      ({ releases }) =>
        useReleasePipelinePolling({
          enabled: true,
          onSnapshot,
          refreshRevision: 0,
          releases,
        }),
      { initialProps: { releases: [firstItem] } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    const firstSignal = api.getReleasePipelines.mock.calls[0]?.[0];
    view.rerender({ releases: [secondItem] });
    expect(firstSignal?.aborted).toBe(true);
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(snapshot(firstItem, pipeline("pending")));
      await first.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(snapshot(secondItem, pipeline("complete")));
      await second.promise;
    });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(
      snapshot(secondItem, pipeline("complete")),
    );
  });

  it("aborts in-flight work when only repository casing changes", async () => {
    vi.useFakeTimers();
    const firstItem = release("1", pipeline("pending"));
    const secondItem = {
      ...firstItem,
      pipeline: pipeline("complete"),
      repository: "Appwrite/cloud",
    };
    const first = createDeferred<ReleasePipelinesResponse>();
    const second = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSnapshot = vi.fn();
    const view = renderHook(
      ({ releases }) =>
        useReleasePipelinePolling({
          enabled: true,
          onSnapshot,
          refreshRevision: 0,
          releases,
        }),
      { initialProps: { releases: [firstItem] } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    const firstSignal = api.getReleasePipelines.mock.calls[0]?.[0];
    view.rerender({ releases: [secondItem] });

    expect(firstSignal?.aborted).toBe(true);
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(snapshot(firstItem, pipeline("pending")));
      second.resolve(snapshot(secondItem, pipeline("complete")));
      await Promise.all([first.promise, second.promise]);
    });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(
      snapshot(secondItem, pipeline("complete")),
    );
  });

  it("aborts an active request on unmount", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    const pending = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines.mockReturnValue(pending.promise);
    const onSnapshot = vi.fn();
    const view = renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    const signal = api.getReleasePipelines.mock.calls[0]?.[0];
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.resolve(snapshot(item, pipeline("complete")));
      await pending.promise;
    });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("pauses while hidden and refreshes terminal snapshots on resume", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("complete"));
    api.getReleasePipelines.mockResolvedValue(
      snapshot(item, pipeline("complete")),
    );
    renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot: () => undefined,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RELEASE_PIPELINE_REFRESH_INTERVAL * 2,
      );
    });
    expect(api.getReleasePipelines).not.toHaveBeenCalled();

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);
  });

  it("refreshes terminal snapshots on focus without overlapping work", async () => {
    const item = release("1", pipeline("complete", [run("succeeded")]));
    const pending = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines.mockReturnValue(pending.promise);
    renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot: () => undefined,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(snapshot(item, pipeline("complete", [run("succeeded")])));
      await pending.promise;
    });
  });

  it("aborts active work on visibility loss and restarts on resume", async () => {
    vi.useFakeTimers();
    const item = release("1", pipeline("pending"));
    const pending = createDeferred<ReleasePipelinesResponse>();
    api.getReleasePipelines
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(item, pipeline("complete")));
    renderHook(() =>
      useReleasePipelinePolling({
        enabled: true,
        onSnapshot: () => undefined,
        refreshRevision: 0,
        releases: [item],
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    const signal = api.getReleasePipelines.mock.calls[0]?.[0];
    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(signal?.aborted).toBe(true);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);
  });

  it("retries active failures silently and refreshes terminal data on demand", async () => {
    vi.useFakeTimers();
    const active = release("1", pipeline("pending"));
    api.getReleasePipelines
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(snapshot(active, pipeline("complete")));
    const view = renderHook(
      ({ refreshRevision, releases }) =>
        useReleasePipelinePolling({
          enabled: true,
          onSnapshot: () => undefined,
          refreshRevision,
          releases,
        }),
      {
        initialProps: {
          refreshRevision: 0,
          releases: [active],
        },
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEASE_PIPELINE_REFRESH_INTERVAL);
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(2);

    view.rerender({
      refreshRevision: 1,
      releases: [release("1", pipeline("complete"))],
    });
    expect(api.getReleasePipelines).toHaveBeenCalledTimes(3);
  });
});
