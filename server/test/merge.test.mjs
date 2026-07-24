import { describe, expect, it, vi } from "vitest";

import { createRunCoordinator } from "../claude.mjs";
import {
  confirmedConflict,
  createMergeService,
  mergeFailureArguments,
  validateMergeInput,
} from "../merge.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

function fresh(overrides = {}) {
  return {
    available: true,
    complete: true,
    viewerLogin: "viewer",
    repository: "owner/repo",
    repositoryUrl: "https://github.com/owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    authorLogin: "viewer",
    authored: true,
    state: "OPEN",
    open: true,
    headRefOid: SHA,
    pull: {
      repository: "owner/repo",
      repositoryUrl: "https://github.com/owner/repo",
      number: 7,
      title: "Ready change",
      url: "https://github.com/owner/repo/pull/7",
      updatedAt: "2026-07-21T00:00:00Z",
      headRefOid: SHA,
      ci: {
        checks: [],
        complete: true,
        failed: 0,
        passed: 0,
        running: 0,
        state: "none",
        total: 0,
        unknown: 0,
      },
      reviewThreads: [],
      unresolvedThreads: [],
      comments: [
        {
          author: "greptile-apps",
          body: `Confidence Score: 5/5\nLast reviewed commit: ${SHA}`,
          createdAt: "2026-07-21T00:00:00Z",
          updatedAt: "2026-07-21T00:00:00Z",
          url: "https://github.com/owner/repo/pull/7#issuecomment-1",
        },
      ],
      threadsComplete: true,
      commentsComplete: true,
    },
    ...overrides,
  };
}

const input = {
  agent: "claude",
  repository: "owner/repo",
  number: 7,
  expectedHeadRefOid: SHA,
};

function conflict(overrides = {}) {
  return {
    baseRefName: "main",
    baseRefOid: "1234567890abcdef1234567890abcdef12345678",
    headRefName: "feature",
    headRefOid: SHA,
    headRepository: { nameWithOwner: "owner/repo" },
    headRepositoryOwner: { login: "owner" },
    isCrossRepository: false,
    maintainerCanModify: true,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    number: 7,
    state: "OPEN",
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
    url: "https://github.com/owner/repo/pull/7",
    ...overrides,
  };
}

describe("merge service", () => {
  it("validates immutable identity fields", () => {
    expect(validateMergeInput(input)).toEqual(input);
    expect(() =>
      validateMergeInput({ ...input, repository: "../repo" }),
    ).toThrow("repository");
    expect(() => validateMergeInput({ ...input, number: 0 })).toThrow("number");
    expect(() =>
      validateMergeInput({ ...input, expectedHeadRefOid: "short" }),
    ).toThrow("head");
  });

  it("freshly revalidates every gate before using exact admin merge arguments", async () => {
    const executor = { action: vi.fn(async () => undefined) };
    const loadPull = vi.fn(async () => fresh());
    const invalidate = vi.fn();
    const refetch = vi.fn();
    const service = createMergeService({
      executor,
      loadPull,
      invalidate,
      refetch,
    });

    await expect(service.merge({ ...input, agent: "codex" })).resolves.toEqual({
      mergeCommitOid: null,
      merged: true,
      number: 7,
      repository: "owner/repo",
      url: "https://github.com/owner/repo/pull/7",
    });
    expect(loadPull).toHaveBeenCalledWith({
      repository: "owner/repo",
      number: 7,
      refresh: true,
    });
    expect(executor.action).toHaveBeenCalledWith([
      "pr",
      "merge",
      "https://github.com/owner/repo/pull/7",
      "--admin",
      "--merge",
      "--match-head-commit",
      SHA,
    ]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("resolves the merge while the best-effort snapshot refetch is still pending", async () => {
    let finishRefetch;
    const refetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRefetch = resolve;
        }),
    );
    const invalidate = vi.fn();
    const service = createMergeService({
      executor: { action: vi.fn(async () => undefined) },
      invalidate,
      loadPull: async () => fresh(),
      refetch,
    });
    let result;
    const merging = service.merge(input).then((value) => {
      result = value;
      return value;
    });

    await vi.waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(result).toEqual({
        mergeCommitOid: null,
        merged: true,
        number: 7,
        repository: "owner/repo",
        url: "https://github.com/owner/repo/pull/7",
      });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(service.activeCount()).toBe(0);
    } finally {
      finishRefetch();
    }
    await merging;
  });

  it("contains a rejected background snapshot refetch after a successful merge", async () => {
    const refetch = vi.fn(async () => {
      throw new Error("temporary refresh failure");
    });
    const service = createMergeService({
      executor: { action: vi.fn(async () => undefined) },
      loadPull: async () => fresh(),
      refetch,
    });

    await expect(service.merge(input)).resolves.toMatchObject({ merged: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(refetch).toHaveBeenCalledOnce();
    expect(service.activeCount()).toBe(0);
  });

  it("accepts a delegated author when fresh authored-search membership is proven", async () => {
    const executor = { action: vi.fn(async () => undefined) };
    const service = createMergeService({
      executor,
      loadPull: async () =>
        fresh({ authorLogin: "copilot-swe-agent", authored: true }),
    });

    await expect(service.merge(input)).resolves.toMatchObject({ merged: true });
    expect(executor.action).toHaveBeenCalledOnce();
  });

  it.each([
    ["incomplete evidence", { complete: false }, "pull_unavailable"],
    ["wrong author", { authorLogin: "other", authored: false }, "pull_changed"],
    ["closed state", { state: "CLOSED", open: false }, "pull_changed"],
    [
      "changed head",
      { headRefOid: "1234567890abcdef1234567890abcdef12345678" },
      "head_changed",
    ],
  ])("refuses %s before invoking GitHub", async (_name, changes, code) => {
    const executor = { action: vi.fn() };
    const service = createMergeService({
      executor,
      loadPull: async () => fresh(changes),
    });
    await expect(service.merge(input)).rejects.toMatchObject({ code });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("refuses a readiness regression before invoking GitHub", async () => {
    const evidence = fresh();
    evidence.pull.ci = {
      checks: [
        { detailsUrl: null, name: "tests", state: "pending", workflow: null },
      ],
      complete: true,
      failed: 0,
      passed: 0,
      running: 1,
      state: "pending",
      total: 1,
      unknown: 0,
    };
    const executor = { action: vi.fn() };
    const service = createMergeService({
      executor,
      loadPull: async () => evidence,
    });
    await expect(service.merge(input)).rejects.toMatchObject({
      code: "pull_not_ready",
    });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("deduplicates atomically before the first fresh-load await", async () => {
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const service = createMergeService({
      executor: { action: vi.fn(async () => undefined) },
      loadPull: vi.fn(async () => {
        await waiting;
        return fresh();
      }),
    });
    const first = service.merge(input);
    await expect(service.merge(input)).rejects.toMatchObject({
      code: "merge_running",
    });
    release();
    await first;
  });

  it("refuses a merge while a Claude run owns the pull request key", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const run = coordinator.reserveRun({
      duplicateCode: "pull_running",
      duplicateMessage: "Run active.",
      key: "fix:owner/repo#7",
    });
    const loadPull = vi.fn(async () => fresh());
    const service = createMergeService({
      coordinator,
      executor: { action: vi.fn() },
      loadPull,
    });

    await expect(service.merge(input)).rejects.toMatchObject({
      code: "pull_running",
    });
    expect(loadPull).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(1);
    run.release();
  });

  it("atomically excludes a new Claude run without consuming run parallelism while merging", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    let releaseLoad;
    const waiting = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    const service = createMergeService({
      coordinator,
      executor: { action: vi.fn(async () => undefined) },
      loadPull: vi.fn(async () => {
        await waiting;
        return fresh();
      }),
    });

    const merging = service.merge(input);
    await vi.waitFor(() => expect(service.activeCount()).toBe(1));
    expect(coordinator.activeCount()).toBe(0);
    expect(() =>
      coordinator.reserveRun({
        duplicateCode: "pull_running",
        duplicateMessage: "Run active.",
        key: "fix:owner/repo#7",
      }),
    ).toThrowError(expect.objectContaining({ code: "pull_running" }));

    const unrelated = coordinator.reserveRun({
      duplicateCode: "pull_running",
      duplicateMessage: "Run active.",
      key: "fix:owner/other#8",
    });
    expect(coordinator.activeCount()).toBe(1);
    unrelated.release();
    releaseLoad();
    await merging;

    const retry = coordinator.reserveRun({
      duplicateCode: "pull_running",
      duplicateMessage: "Run active.",
      key: "fix:owner/repo#7",
    });
    retry.release();
  });

  it("classifies only a fresh exact-identity conflict with green checks", () => {
    expect(confirmedConflict(conflict(), input)).toMatchObject({
      baseRefName: "main",
      expectedHeadRefOid: SHA,
      headRepository: "owner/repo",
      isCrossRepository: false,
    });
    expect(
      confirmedConflict(
        conflict({ headRefOid: "1234567890abcdef1234567890abcdef12345678" }),
        input,
      ),
    ).toBeNull();
    expect(
      confirmedConflict(
        conflict({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
        input,
      ),
    ).toBeNull();
    expect(
      confirmedConflict(
        conflict({
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              conclusion: "FAILURE",
              status: "COMPLETED",
            },
          ],
        }),
        input,
      ),
    ).toBeNull();
  });

  it("queues a dedicated repair only after the admin merge fails with a confirmed conflict", async () => {
    const failure = new Error("unsafe github stderr");
    const executor = {
      action: vi.fn(async () => {
        throw failure;
      }),
      json: vi.fn(async () => conflict()),
    };
    const repairManager = {
      enqueue: vi.fn(() => ({
        accepted: true,
        agent: "claude",
        deduplicated: false,
        id: "repair-1",
        state: "repair_queued",
        token: "A".repeat(43),
      })),
    };
    const service = createMergeService({
      executor,
      loadPull: async () => fresh(),
      repairManager,
    });

    await expect(service.merge({ ...input, agent: "codex" })).resolves.toEqual({
      action: {
        agent: "claude",
        deduplicated: false,
        id: "repair-1",
        state: "repair_queued",
        token: "A".repeat(43),
        type: "repair_queued",
      },
      headRefOid: SHA,
      merged: false,
      number: 7,
      repository: "owner/repo",
      url: "https://github.com/owner/repo/pull/7",
    });
    expect(executor.json).toHaveBeenCalledWith(
      mergeFailureArguments("owner/repo", 7),
    );
    expect(repairManager.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        expectedHeadRefOid: SHA,
        headRepository: "owner/repo",
        isCrossRepository: false,
      }),
    );
  });

  it.each([
    [
      "ordinary merge failure",
      conflict({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    ],
    [
      "stale head",
      conflict({ headRefOid: "1234567890abcdef1234567890abcdef12345678" }),
    ],
    [
      "failed checks",
      conflict({
        statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }],
      }),
    ],
  ])("keeps %s generic and never queues repair", async (_name, result) => {
    const executor = {
      action: vi.fn(async () => {
        throw new Error("/private/tmp secret=bad");
      }),
      json: vi.fn(async () => result),
    };
    const repairManager = { enqueue: vi.fn() };
    const service = createMergeService({
      executor,
      loadPull: async () => fresh(),
      repairManager,
    });

    await expect(service.merge(input)).rejects.toMatchObject({
      code: "merge_failed",
      message: "GitHub could not merge the pull request.",
    });
    expect(repairManager.enqueue).not.toHaveBeenCalled();
  });
});
