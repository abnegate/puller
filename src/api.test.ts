import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCheckLog,
  getPullDiff,
  getPullRequestCacheStatsForTests,
  getPulls,
  getReleaseOptions,
  isCheckLog,
  isPullDiff,
  isPullsResponse,
  isReleaseOptions,
  mergePull,
  parseGitHubActionsJobUrl,
  PullDiffHttpError,
  resetApiActionTokenForTests,
  resetCheckLogCacheForTests,
  streamReleaseVerification,
} from "./api";
import {
  createDegradedPullDiff,
  createDegradedPullsResponse,
  createPullsResponse,
} from "./test/fixtures";
import type {
  CheckLog,
  PullDiff,
  PullsResponse,
  ReleaseOptions,
} from "./types";

const BASE_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const VIEWER_LOGIN = "jake";

const createCheckLog = (overrides: Partial<CheckLog> = {}): CheckLog => ({
  cached: false,
  fetchedAt: "2026-07-21T08:04:00.000Z",
  headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  jobId: "987654321",
  log: "Run pnpm test\nTests passed",
  number: 102,
  repository: "appwrite/cloud",
  runId: "123456789",
  ...overrides,
});

const createDeferred = <Value>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });

  return { promise, reject, resolve };
};

const createCheckRequest = (index = 0) => {
  const log = createCheckLog({
    jobId: String(987_654_321 + index),
    runId: String(123_456_789 + index),
  });

  return {
    job: { jobId: log.jobId, runId: log.runId },
    log,
    pull: {
      baseRefOid: BASE_SHA,
      headRefOid: log.headRefOid,
      number: log.number,
      repository: log.repository,
      viewerLogin: VIEWER_LOGIN,
    },
  };
};

const checkLogResponse = (input: RequestInfo | URL): Response => {
  const match = /\/checks\/([1-9][0-9]*)\/jobs\/([1-9][0-9]*)\/logs/.exec(
    String(input),
  );
  if (!match) throw new Error(`Unexpected check-log URL: ${String(input)}`);

  return new Response(
    JSON.stringify(
      createCheckLog({
        jobId: match[2],
        runId: match[1],
      }),
    ),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
    },
  );
};

const createReleaseOptions = (): ReleaseOptions => ({
  generatedAt: "2026-07-21T08:02:00.000Z",
  repositories: [
    {
      latestTag: "v1.2.3",
      nextTag: "v1.2.4",
      previousTags: ["v1.2.3", "v1.2.2"],
      repository: "appwrite/cloud",
      repositoryUrl: "https://github.com/appwrite/cloud",
    },
  ],
  repositoriesUpdatedAt: "2026-07-21T08:00:00.000Z",
  tagsUpdatedAt: "2026-07-21T08:01:00.000Z",
  viewerLogin: "jake",
  warnings: [],
});

afterEach(() => {
  resetApiActionTokenForTests();
  resetCheckLogCacheForTests();
  vi.unstubAllGlobals();
});

describe("streamReleaseVerification", () => {
  it("uses one server-owned batch request and validates its terminal totals", async () => {
    const request = {
      releaseId: "123",
      repository: "appwrite/cloud",
      tag: "v1.2.3",
    };
    const pull = {
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pullNumber: 41,
      pullUrl: "https://github.com/appwrite/cloud/pull/41",
      ...request,
    };
    const events = [
      { batchId: "batch-1", pulls: [pull], type: "batch-start", ...request },
      {
        batchId: "batch-1",
        headSha: pull.headSha,
        pullNumber: pull.pullNumber,
        pullUrl: pull.pullUrl,
        state: "queued",
        type: "verification",
      },
      {
        batchId: "batch-1",
        headSha: pull.headSha,
        pullNumber: pull.pullNumber,
        pullUrl: pull.pullUrl,
        state: "complete",
        type: "verification",
        event: { exitCode: 0, type: "complete" },
      },
      {
        batchId: "batch-1",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "action-token" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          {
            headers: { "Content-Type": "application/x-ndjson" },
            status: 200,
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const received = [];
    for await (const event of streamReleaseVerification(request)) {
      received.push(event);
    }

    expect(received).toEqual(events);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/releases/verifications" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicate per-pull terminals even when the final totals look valid", async () => {
    const request = {
      releaseId: "123",
      repository: "appwrite/cloud",
      tag: "v1.2.3",
    };
    const identity = {
      batchId: "batch-1",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pullNumber: 41,
      pullUrl: "https://github.com/appwrite/cloud/pull/41",
    };
    const pull = {
      headSha: identity.headSha,
      pullNumber: identity.pullNumber,
      pullUrl: identity.pullUrl,
      ...request,
    };
    const events = [
      { batchId: "batch-1", pulls: [pull], type: "batch-start", ...request },
      { ...identity, state: "queued", type: "verification" },
      {
        ...identity,
        event: { exitCode: 0, type: "complete" },
        state: "complete",
        type: "verification",
      },
      {
        ...identity,
        event: { exitCode: 0, type: "complete" },
        state: "complete",
        type: "verification",
      },
      {
        batchId: "batch-1",
        totals: { complete: 1, error: 0, existing: 0, total: 1 },
        type: "complete",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "action-token" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      (async () => {
        for await (const _event of streamReleaseVerification(request)) {
          // Consume the validated stream.
        }
      })(),
    ).rejects.toThrow("invalid release verification state transition");
  });
});

describe("mergePull", () => {
  it("preserves expired-token refresh for generic action requests", async () => {
    const result = {
      mergeCommitOid: null,
      merged: true,
      number: 7,
      repository: "appwrite/cloud",
      url: "https://github.com/appwrite/cloud/pull/7",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "expired-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "action_unauthorized",
            error: "The action token is invalid or expired.",
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "fresh-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(result), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mergePull({
        expectedHeadRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: 7,
        repository: "appwrite/cloud",
      }),
    ).resolves.toEqual(result);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === "/api/pulls/appwrite/cloud/7/merge",
      ),
    ).toHaveLength(2);
  });

  it("rejects a success payload whose canonical pull URL does not match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "action-token" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            mergeCommitOid: null,
            merged: true,
            number: 7,
            repository: "appwrite/cloud",
            url: "https://github.com/other/repository/pull/7",
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mergePull({
        expectedHeadRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: 7,
        repository: "appwrite/cloud",
      }),
    ).rejects.toThrow("unexpected response");
  });
});

describe("isPullsResponse", () => {
  it("accepts a consistent normalized response", () => {
    expect(isPullsResponse(createPullsResponse())).toBe(true);
  });

  it.each<[string, (response: PullsResponse) => void]>([
    [
      "a blank CI check identity",
      (response) => {
        response.notReady[0]!.ci.checks![0]!.id = " ";
      },
    ],
    [
      "duplicate CI check identities",
      (response) => {
        response.notReady[0]!.ci.checks![1]!.id =
          response.notReady[0]!.ci.checks![0]!.id;
      },
    ],
    [
      "a missing issue-comment collection",
      (response) => {
        delete (response.ready[0] as unknown as Record<string, unknown>)
          .issueComments;
      },
    ],
    [
      "a blank issue-comment identity",
      (response) => {
        response.notReady[0]!.issueComments[0]!.id = "";
      },
    ],
    [
      "an invalid issue-comment update timestamp",
      (response) => {
        response.notReady[0]!.issueComments[0]!.updatedAt = "not-a-date";
      },
    ],
    [
      "an issue comment updated before it was created",
      (response) => {
        response.notReady[0]!.issueComments[0]!.updatedAt =
          "2026-07-17T08:29:59.000Z";
      },
    ],
    [
      "a thread without its nested comments",
      (response) => {
        response.notReady[0]!.unresolvedThreads![0]!.comments = [];
      },
    ],
    [
      "a blank nested review-comment identity",
      (response) => {
        response.notReady[0]!.unresolvedThreads![0]!.comments[1]!.id = " ";
      },
    ],
    [
      "an invalid nested review-comment timestamp",
      (response) => {
        response.notReady[0]!.unresolvedThreads![0]!.comments[1]!.updatedAt =
          "yesterday";
      },
    ],
    [
      "duplicate nested review-comment identities",
      (response) => {
        const comments = response.notReady[0]!.unresolvedThreads![0]!.comments;
        comments[1]!.id = comments[0]!.id;
      },
    ],
    [
      "nested review comments outside GitHub order",
      (response) => {
        response.notReady[0]!.unresolvedThreads![0]!.comments[1]!.createdAt =
          "2026-07-17T08:44:00.000Z";
        response.notReady[0]!.unresolvedThreads![0]!.comments[1]!.updatedAt =
          "2026-07-17T08:44:00.000Z";
      },
    ],
    [
      "thread root fields that do not match the root comment",
      (response) => {
        response.notReady[0]!.unresolvedThreads![0]!.body =
          "Different root body";
      },
    ],
    [
      "a blank Greptile comment identity",
      (response) => {
        response.notReady[0]!.greptile.commentId = "";
      },
    ],
    [
      "an invalid Greptile update timestamp",
      (response) => {
        response.notReady[0]!.greptile.updatedAt = "not-a-date";
      },
    ],
    [
      "Greptile evidence that does not identify an issue comment",
      (response) => {
        response.notReady[0]!.greptile.commentId = "missing-comment";
      },
    ],
  ])("rejects malformed readiness evidence: %s", (_label, mutate) => {
    const response = createPullsResponse();
    mutate(response);

    expect(isPullsResponse(response)).toBe(false);
  });

  it.each(["success", "none"] as const)(
    "accepts a ready pull with CI state %s",
    (state) => {
      const response = createPullsResponse();
      response.ready[0]!.ci =
        state === "none"
          ? {
              checks: [],
              complete: true,
              failed: 0,
              passed: 0,
              running: 0,
              state,
              total: 0,
              unknown: 0,
            }
          : response.ready[0]!.ci;

      expect(isPullsResponse(response)).toBe(true);
    },
  );

  it("accepts partial server evidence without rejecting the whole snapshot", () => {
    expect(isPullsResponse(createDegradedPullsResponse())).toBe(true);
  });

  it.each<[string, (response: PullsResponse) => void]>([
    [
      "known CI counts that do not sum to total",
      (response) => {
        response.notReady[0]!.ci.unknown = 1;
      },
    ],
    [
      "more returned CI rows than the total",
      (response) => {
        response.notReady[0]!.ci.total = 0;
        response.notReady[0]!.ci.passed = 0;
        response.notReady[0]!.ci.unknown = 0;
      },
    ],
    [
      "an observed CI bucket larger than its known count",
      (response) => {
        response.notReady[0]!.ci.passed = 0;
        response.notReady[0]!.ci.unknown = 3;
      },
    ],
    [
      "an incomplete CI result claiming a terminal aggregate state",
      (response) => {
        response.notReady[0]!.ci.state = "success";
      },
    ],
    [
      "more unresolved thread details than the unresolved count",
      (response) => {
        response.notReady[0]!.unresolved = 0;
      },
    ],
    [
      "complete thread evidence with omitted unresolved details",
      (response) => {
        response.notReady[0]!.checks.threadsComplete = true;
      },
    ],
  ])("rejects unsafe degraded evidence: %s", (_label, mutate) => {
    const response = createDegradedPullsResponse();
    mutate(response);

    expect(isPullsResponse(response)).toBe(false);
  });

  it.each<[string, (response: PullsResponse) => void]>([
    [
      "a ready pull with ready=false",
      (response) => (response.ready[0]!.ready = false),
    ],
    [
      "a ready pull with unresolved comments",
      (response) => (response.ready[0]!.unresolved = 1),
    ],
    [
      "a ready pull with incomplete thread data",
      (response) => (response.ready[0]!.checks.threadsComplete = false),
    ],
    [
      "a ready pull below 5/5 confidence",
      (response) => (response.ready[0]!.greptile.confidence = 4),
    ],
    [
      "a ready pull reviewed at an older head",
      (response) => (response.ready[0]!.greptile.reviewedSha = "older-head"),
    ],
    [
      "a ready pull without a Greptile review URL",
      (response) => (response.ready[0]!.greptile.commentUrl = null),
    ],
    [
      "a ready pull with pending CI checks",
      (response) => (response.ready[0]!.ci.state = "pending"),
    ],
    [
      "a ready pull with failing CI checks",
      (response) => (response.ready[0]!.ci.state = "failure"),
    ],
    [
      "a ready pull with unknown CI state",
      (response) => (response.ready[0]!.ci.state = "unknown"),
    ],
    [
      "a not-ready pull with ready=true",
      (response) => (response.notReady[0]!.ready = true),
    ],
    [
      "a not-ready pull without blockers",
      (response) => (response.notReady[0]!.blockers = []),
    ],
    [
      "counts that do not match the arrays",
      (response) => (response.counts.total = 3),
    ],
    ["a duplicate source rank", (response) => (response.notReady[0]!.rank = 1)],
    [
      "a duplicate pull URL",
      (response) => (response.notReady[0]!.url = response.ready[0]!.url),
    ],
  ])("rejects contradictory data: %s", (_label, mutate) => {
    const response = createPullsResponse();
    mutate(response);

    expect(isPullsResponse(response)).toBe(false);
  });

  it.each(["SUCCESS", "complete", "", null, true, 1])(
    "rejects an out-of-contract CI state: %j",
    (state) => {
      const response = createPullsResponse();
      (response.notReady[0] as unknown as Record<string, unknown>).ci = {
        state,
      };

      expect(isPullsResponse(response)).toBe(false);
    },
  );

  it("rejects a pull without CI state data", () => {
    const response = createPullsResponse();
    delete (response.ready[0] as unknown as Record<string, unknown>).ci;

    expect(isPullsResponse(response)).toBe(false);
  });

  it("requires an exact base commit for every pull", () => {
    const response = createPullsResponse();
    delete (response.ready[0] as unknown as Record<string, unknown>).baseRefOid;

    expect(isPullsResponse(response)).toBe(false);
  });

  it("requires a non-empty viewer login or an explicit unavailable value", () => {
    const unavailable = createPullsResponse();
    unavailable.viewerLogin = null;
    expect(isPullsResponse(unavailable)).toBe(true);

    const blank = createPullsResponse();
    blank.viewerLogin = " ";
    expect(isPullsResponse(blank)).toBe(false);

    const missing = createPullsResponse() as unknown as Record<string, unknown>;
    delete missing.viewerLogin;
    expect(isPullsResponse(missing)).toBe(false);
  });
});

describe("getPulls", () => {
  it("uses the cache-bypass endpoint for a manual refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createPullsResponse()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPulls(true)).resolves.toEqual(createPullsResponse());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pulls?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("accepts the server partial-evidence shape during refresh", async () => {
    const response = createDegradedPullsResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(getPulls(true)).resolves.toEqual(response);
  });

  it.each([
    ["the viewer changes", "viewer-change"],
    ["the viewer is unavailable", "viewer-unavailable"],
    ["the snapshot is stale", "stale"],
    ["the snapshot is partial", "partial"],
    ["the readiness request fails", "http-error"],
    ["the readiness fetch rejects", "network-error"],
    ["the readiness JSON is malformed", "malformed-json"],
    ["the readiness response is invalid", "invalid"],
  ] as const)(
    "aborts artifact requests when %s",
    async (_label, nextOutcome) => {
      let outcome:
        | "trusted"
        | "http-error"
        | "invalid"
        | "malformed-json"
        | "network-error"
        | "partial"
        | "stale"
        | "viewer-change"
        | "viewer-unavailable" = "trusted";
      const diff = createDegradedPullDiff();
      let artifactSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          if (/^\/api\/pulls(?:\?|$)/.test(String(input))) {
            if (outcome === "network-error") {
              return Promise.reject(new TypeError("readiness network failed"));
            }
            if (outcome === "malformed-json") {
              return Promise.resolve(
                new Response("{", {
                  headers: { "Content-Type": "application/json" },
                  status: 200,
                }),
              );
            }

            const next = {
              ...createPullsResponse(),
            } as Record<string, unknown>;
            let status = 200;
            if (outcome === "viewer-change") {
              next.viewerLogin = "other-viewer";
            } else if (outcome === "viewer-unavailable") {
              next.viewerLogin = null;
            } else if (outcome === "stale") {
              next.stale = true;
            } else if (outcome === "partial") {
              next.partial = true;
            } else if (outcome === "http-error") {
              status = 503;
            } else if (outcome === "invalid") {
              delete next.viewerLogin;
            }

            return Promise.resolve(
              new Response(
                JSON.stringify(
                  outcome === "http-error"
                    ? { error: "Readiness failed." }
                    : next,
                ),
                {
                  headers: { "Content-Type": "application/json" },
                  status,
                },
              ),
            );
          }

          artifactSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            artifactSignal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              { once: true },
            );
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await getPulls();
      const pending = getPullDiff({
        baseRefOid: diff.baseRefOid,
        headRefOid: diff.headRefOid,
        number: diff.number,
        repository: diff.repository,
        viewerLogin: VIEWER_LOGIN,
      });
      await vi.waitFor(() => expect(artifactSignal).toBeDefined());

      outcome = nextOutcome;

      const observation = getPulls();
      if (
        nextOutcome === "http-error" ||
        nextOutcome === "invalid" ||
        nextOutcome === "malformed-json" ||
        nextOutcome === "network-error"
      ) {
        await expect(observation).rejects.toThrow();
      } else {
        await expect(observation).resolves.toBeDefined();
      }

      expect(artifactSignal?.aborted).toBe(true);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        getPullDiff({
          baseRefOid: diff.baseRefOid,
          headRefOid: diff.headRefOid,
          number: diff.number,
          repository: diff.repository,
          viewerLogin: VIEWER_LOGIN,
        }),
      ).rejects.toThrow("viewer identity is unavailable");
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => !/^\/api\/pulls(?:\?|$)/.test(String(input)),
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["network-error", "stale", "partial"] as const)(
    "evicts a loaded artifact after an untrusted %s observation",
    async (outcome) => {
      const diff = createDegradedPullDiff();
      let next: "trusted" | typeof outcome = "trusted";
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (/^\/api\/pulls(?:\?|$)/.test(String(input))) {
          if (next === "network-error") {
            return Promise.reject(new TypeError("readiness network failed"));
          }

          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...createPullsResponse(),
                partial: next === "partial",
                stale: next === "stale",
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify(diff), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const pull = {
        baseRefOid: diff.baseRefOid,
        headRefOid: diff.headRefOid,
        number: diff.number,
        repository: diff.repository,
        viewerLogin: VIEWER_LOGIN,
      };

      await getPulls();
      await getPullDiff(pull);
      expect(getPullRequestCacheStatsForTests().diffs).toEqual({
        entries: 1,
        scopes: 1,
      });

      next = outcome;
      if (outcome === "network-error") {
        await expect(getPulls()).rejects.toThrow("readiness network failed");
      } else {
        await expect(getPulls()).resolves.toBeDefined();
      }

      expect(getPullRequestCacheStatsForTests().diffs).toEqual({
        entries: 0,
        scopes: 0,
      });
      await expect(getPullDiff(pull)).rejects.toThrow(
        "viewer identity is unavailable",
      );
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => !/^\/api\/pulls(?:\?|$)/.test(String(input)),
        ),
      ).toHaveLength(1);
    },
  );

  it("rejects unavailable direct artifact viewers before allocating cache scope", async () => {
    const diff = createDegradedPullDiff();
    const { job, pull } = createCheckRequest();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getPullDiff({
        baseRefOid: diff.baseRefOid,
        headRefOid: diff.headRefOid,
        number: diff.number,
        repository: diff.repository,
        viewerLogin: null,
      }),
    ).rejects.toThrow("viewer identity is unavailable");
    await expect(
      getCheckLog({ ...pull, viewerLogin: null }, job),
    ).rejects.toThrow("viewer identity is unavailable");

    expect(getPullRequestCacheStatsForTests()).toEqual({
      checkLogs: { entries: 0, scopes: 0 },
      diffs: { entries: 0, scopes: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a contradictory successful API payload", async () => {
    const response = createPullsResponse();
    response.ready[0]!.unresolved = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(getPulls()).rejects.toThrow("unexpected response");
  });
});

describe("pull diff validation", () => {
  it("accepts empty GitHub file links only in a warned incomplete diff", async () => {
    const diff = createDegradedPullDiff();
    expect(isPullDiff(diff)).toBe(true);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(diff), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getPullDiff({
        baseRefOid: diff.baseRefOid,
        headRefOid: diff.headRefOid,
        number: diff.number,
        repository: diff.repository,
        viewerLogin: VIEWER_LOGIN,
      }),
    ).resolves.toEqual(diff);
  });

  it.each<[string, (diff: PullDiff) => void]>([
    [
      "a complete diff with an empty blob link",
      (diff) => {
        diff.complete = true;
        diff.warning = null;
      },
    ],
    [
      "an incomplete diff without a warning",
      (diff) => {
        diff.warning = null;
      },
    ],
    [
      "a non-empty invalid raw link",
      (diff) => {
        diff.files[0]!.rawUrl = "javascript:alert(1)";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const diff = createDegradedPullDiff();
    mutate(diff);

    expect(isPullDiff(diff)).toBe(false);
  });
});

describe("pull diff requests", () => {
  const pullFrom = (diff: PullDiff) => ({
    baseRefOid: diff.baseRefOid,
    headRefOid: diff.headRefOid,
    number: diff.number,
    repository: diff.repository,
    viewerLogin: VIEWER_LOGIN,
  });
  const responseFor = (diff: PullDiff): Response =>
    new Response(JSON.stringify(diff), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

  it("does not request a diff before an explicit consumer call", async () => {
    const diff = createDegradedPullDiff();
    const fetchMock = vi.fn(() => Promise.resolve(responseFor(diff)));
    vi.stubGlobal("fetch", fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    await getPullDiff(pullFrom(diff));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces identical concurrent requests", async () => {
    const diff = createDegradedPullDiff();
    const pending = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    const first = getPullDiff(pullFrom(diff));
    const second = getPullDiff(pullFrom(diff));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    pending.resolve(responseFor(diff));

    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/pulls/appwrite/cloud/101/diff?base=${diff.baseRefOid}&head=${diff.headRefOid}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("detaches one aborted subscriber while another succeeds", async () => {
    const diff = createDegradedPullDiff();
    const pending = createDeferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        sharedSignal = init?.signal ?? undefined;
        return pending.promise;
      }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getPullDiff(pullFrom(diff), firstController.signal);
    const second = getPullDiff(pullFrom(diff), secondController.signal);
    await vi.waitFor(() => expect(sharedSignal).toBeDefined());
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);
    pending.resolve(responseFor(diff));
    await expect(second).resolves.toEqual(diff);
  });

  it("aborts the shared request after every subscriber detaches", async () => {
    const diff = createDegradedPullDiff();
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          sharedSignal = init?.signal ?? undefined;
          sharedSignal?.addEventListener(
            "abort",
            () => reject(sharedSignal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getPullDiff(pullFrom(diff), firstController.signal);
    const second = getPullDiff(pullFrom(diff), secondController.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    firstController.abort();
    expect(sharedSignal?.aborted).toBe(false);
    secondController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
    expect(getPullRequestCacheStatsForTests().diffs).toEqual({
      entries: 0,
      scopes: 0,
    });
  });

  it("rejects every subscriber when readiness invalidates a parsed shared response", async () => {
    const diff = createDegradedPullDiff();
    const body = createDeferred<unknown>();
    let readiness = createPullsResponse();
    let artifactSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (/^\/api\/pulls(?:\?|$)/.test(String(input))) {
          return Promise.resolve(
            new Response(JSON.stringify(readiness), {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }),
          );
        }

        artifactSignal = init?.signal ?? undefined;
        return Promise.resolve({
          json: () => body.promise,
          ok: true,
          status: 200,
        } as Response);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPulls();
    const pending = getPullDiff(pullFrom(diff));
    await vi.waitFor(() => expect(artifactSignal).toBeDefined());

    readiness = { ...readiness, viewerLogin: "other-viewer" };
    await getPulls();

    expect(artifactSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    body.resolve(diff);
    await Promise.resolve();
    await Promise.resolve();
    expect(getPullRequestCacheStatsForTests().diffs).toEqual({
      entries: 0,
      scopes: 0,
    });
  });

  it("invalidates successful responses when only base or head changes", async () => {
    const initial = createDegradedPullDiff();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://puller.local");
      return Promise.resolve(
        responseFor({
          ...initial,
          baseRefOid: url.searchParams.get("base")!,
          headRefOid: url.searchParams.get("head")!,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const original = pullFrom(initial);
    const nextBase = { ...original, baseRefOid: "e".repeat(40) };
    const nextHead = { ...nextBase, headRefOid: "f".repeat(40) };

    await getPullDiff(original);
    await getPullDiff(original);
    await getPullDiff(nextBase);
    await getPullDiff(nextHead);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains a near-limit ASCII diff across collapse and reopen", async () => {
    const diff = createDegradedPullDiff();
    const file = diff.files[0]!;
    const content = "a".repeat(15 * 1024 * 1024);
    file.additions = 1;
    file.binary = false;
    file.changes = 1;
    file.hunks = [
      {
        header: "@@ -0,0 +1 @@",
        lines: [{ content, kind: "addition", newLine: 1, oldLine: null }],
        newLines: 1,
        newStart: 1,
        oldLines: 0,
        oldStart: 0,
      },
    ];
    const serialized = new TextEncoder().encode(
      JSON.stringify(diff),
    ).byteLength;
    expect(serialized).toBeGreaterThan(14 * 1024 * 1024);
    expect(serialized).toBeLessThanOrEqual(16 * 1024 * 1024);
    const fetchMock = vi.fn(() => Promise.resolve(responseFor(diff)));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getPullDiff(pullFrom(diff));
    const reopened = await getPullDiff(pullFrom(diff));

    expect(first).toEqual(diff);
    expect(reopened).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getPullRequestCacheStatsForTests().diffs).toEqual({
      entries: 1,
      scopes: 1,
    });
  });

  it("isolates cached responses by canonical viewer", async () => {
    const diff = createDegradedPullDiff();
    const fetchMock = vi.fn(() => Promise.resolve(responseFor(diff)));
    vi.stubGlobal("fetch", fetchMock);
    const first = pullFrom(diff);
    const second = { ...first, viewerLogin: "Another-Viewer" };

    await getPullDiff(first);
    await getPullDiff({ ...first, viewerLogin: "JAKE" });
    await getPullDiff(second);
    await getPullDiff({ ...second, viewerLogin: "another-viewer" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves structured diff failures without caching them", async () => {
    const diff = createDegradedPullDiff();
    const message = "GitHub could not completely revalidate this pull request.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: "pull_incomplete", error: message }),
          {
            headers: { "Content-Type": "application/json" },
            status: 503,
          },
        ),
      )
      .mockResolvedValueOnce(responseFor(diff));
    vi.stubGlobal("fetch", fetchMock);

    const error = await getPullDiff(pullFrom(diff)).catch((value) => value);
    expect(error).toBeInstanceOf(PullDiffHttpError);
    expect(error).toMatchObject({
      code: "pull_incomplete",
      message,
      status: 503,
    });
    expect(getPullRequestCacheStatsForTests().diffs).toEqual({
      entries: 0,
      scopes: 0,
    });
    await expect(getPullDiff(pullFrom(diff))).resolves.toEqual(diff);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getPullRequestCacheStatsForTests().diffs).toEqual({
      entries: 1,
      scopes: 1,
    });
  });
});

describe("GitHub Actions check logs", () => {
  it("parses only an exact same-repository GitHub Actions job URL", () => {
    expect(
      parseGitHubActionsJobUrl(
        "https://github.com/Appwrite/Cloud/actions/runs/123456789/job/987654321",
        "appwrite/cloud",
      ),
    ).toEqual({ jobId: "987654321", runId: "123456789" });
  });

  it.each([
    [
      "a run-only URL",
      "https://github.com/appwrite/cloud/actions/runs/123456789",
    ],
    [
      "a third-party repository",
      "https://github.com/appwrite/console/actions/runs/123456789/job/987654321",
    ],
    [
      "credentials",
      "https://token@github.com/appwrite/cloud/actions/runs/123456789/job/987654321",
    ],
    [
      "a port",
      "https://github.com:443/appwrite/cloud/actions/runs/123456789/job/987654321",
    ],
    [
      "a query",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/987654321?check_suite_focus=true",
    ],
    [
      "a hash",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/987654321#step:1:1",
    ],
    [
      "an extra path segment",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/987654321/attempts/1",
    ],
    [
      "a non-decimal job ID",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/latest",
    ],
    [
      "a zero job ID",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/0",
    ],
    [
      "a leading-zero run ID",
      "https://github.com/appwrite/cloud/actions/runs/0123456789/job/987654321",
    ],
    [
      "an overlong job ID",
      "https://github.com/appwrite/cloud/actions/runs/123456789/job/123456789012345678901",
    ],
    [
      "an insecure scheme",
      "http://github.com/appwrite/cloud/actions/runs/123456789/job/987654321",
    ],
  ])("rejects %s", (_label, url) => {
    expect(parseGitHubActionsJobUrl(url, "appwrite/cloud")).toBeNull();
  });

  it("strictly validates the exact check-log response shape", () => {
    expect(isCheckLog(createCheckLog())).toBe(true);

    const missing = createCheckLog() as unknown as Record<string, unknown>;
    delete missing.fetchedAt;
    expect(isCheckLog(missing)).toBe(false);

    const extra = createCheckLog() as unknown as Record<string, unknown>;
    extra.url = "https://github.com/appwrite/cloud/actions/runs/123456789";
    expect(isCheckLog(extra)).toBe(false);

    const numericId = createCheckLog() as unknown as Record<string, unknown>;
    numericId.jobId = 987654321;
    expect(isCheckLog(numericId)).toBe(false);

    const zeroId = createCheckLog();
    zeroId.runId = "0";
    expect(isCheckLog(zeroId)).toBe(false);

    const leadingZeroId = createCheckLog();
    leadingZeroId.jobId = "0987654321";
    expect(isCheckLog(leadingZeroId)).toBe(false);

    const overlongId = createCheckLog();
    overlongId.jobId = "123456789012345678901";
    expect(isCheckLog(overlongId)).toBe(false);

    const invalidDate = createCheckLog();
    invalidDate.fetchedAt = "today";
    expect(isCheckLog(invalidDate)).toBe(false);
  });

  it("requests an exact base-and-head-scoped job log and caches only the successful response", async () => {
    const log = createCheckLog();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(log), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pull = {
      baseRefOid: BASE_SHA,
      headRefOid: log.headRefOid,
      number: log.number,
      repository: log.repository,
      viewerLogin: VIEWER_LOGIN,
    };
    const job = { jobId: log.jobId, runId: log.runId };

    await expect(getCheckLog(pull, job, controller.signal)).resolves.toEqual(
      log,
    );
    await expect(getCheckLog(pull, job)).resolves.toEqual(log);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pulls/appwrite/cloud/102/checks/123456789/jobs/987654321/logs?baseRefOid=dddddddddddddddddddddddddddddddddddddddd&headRefOid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("does not request logs before a consumer and coalesces duplicate job identities", async () => {
    const { job, log, pull } = createCheckRequest();
    const pending = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    const first = getCheckLog(pull, job);
    const duplicate = getCheckLog(pull, { ...job });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    pending.resolve(
      new Response(JSON.stringify(log), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(Promise.all([first, duplicate])).resolves.toEqual([log, log]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a shared log request active while one subscriber remains", async () => {
    const { job, log, pull } = createCheckRequest();
    const pending = createDeferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      sharedSignal = init?.signal ?? undefined;
      return pending.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getCheckLog(pull, job, firstController.signal);
    const second = getCheckLog(pull, job, secondController.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);
    pending.resolve(
      new Response(JSON.stringify(log), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    await expect(second).resolves.toEqual(log);
  });

  it("aborts a shared log request after every subscriber detaches", async () => {
    const { job, pull } = createCheckRequest();
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          sharedSignal = init?.signal ?? undefined;
          sharedSignal?.addEventListener(
            "abort",
            () => reject(sharedSignal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getCheckLog(pull, job, firstController.signal);
    const second = getCheckLog(pull, job, secondController.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    firstController.abort();
    expect(sharedSignal?.aborted).toBe(false);
    secondController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
    expect(getPullRequestCacheStatsForTests().checkLogs).toEqual({
      entries: 0,
      scopes: 0,
    });
  });

  it("invalidates cached logs when only base or head changes", async () => {
    const { job, log, pull } = createCheckRequest();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...log,
            headRefOid: new URL(
              String(input),
              "https://puller.local",
            ).searchParams.get("headRefOid"),
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const nextBase = { ...pull, baseRefOid: "e".repeat(40) };
    const nextHead = { ...nextBase, headRefOid: "f".repeat(40) };

    await getCheckLog(pull, job);
    await getCheckLog(pull, job);
    await getCheckLog(nextBase, job);
    await getCheckLog(nextHead, job);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("isolates cached logs by canonical viewer", async () => {
    const { job, log, pull } = createCheckRequest();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(log), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const second = { ...pull, viewerLogin: "another-viewer" };

    await getCheckLog(pull, job);
    await getCheckLog({ ...pull, viewerLogin: "JAKE" }, job);
    await getCheckLog(second, job);
    await getCheckLog({ ...second, viewerLogin: "ANOTHER-VIEWER" }, job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("runs no more than three uncached check-log requests concurrently", async () => {
    const requests = Array.from({ length: 7 }, (_, index) =>
      createCheckRequest(index),
    );
    const pending: Array<{
      input: RequestInfo | URL;
      request: ReturnType<typeof createDeferred<Response>>;
    }> = [];
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = createDeferred<Response>();
      active += 1;
      maximum = Math.max(maximum, active);
      pending.push({ input, request });

      return request.promise.finally(() => {
        active -= 1;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = requests.map(({ job, pull }) => getCheckLog(pull, job));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(maximum).toBe(3);

    for (let index = 0; index < requests.length; index += 1) {
      await vi.waitFor(() => expect(pending[index]).toBeDefined());
      const current = pending[index]!;
      current.request.resolve(checkLogResponse(current.input));
    }

    await expect(Promise.all(results)).resolves.toHaveLength(requests.length);
    expect(maximum).toBe(3);
  });

  it("removes an aborted queued request without fetching it", async () => {
    const requests = Array.from({ length: 4 }, (_, index) =>
      createCheckRequest(index),
    );
    const pending: Array<{
      input: RequestInfo | URL;
      request: ReturnType<typeof createDeferred<Response>>;
    }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = createDeferred<Response>();
      pending.push({ input, request });
      return request.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const active = requests
      .slice(0, 3)
      .map(({ job, pull }) => getCheckLog(pull, job));
    const controller = new AbortController();
    const queued = getCheckLog(
      requests[3]!.pull,
      requests[3]!.job,
      controller.signal,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    for (const current of pending) {
      current.request.resolve(checkLogResponse(current.input));
    }
    await expect(Promise.all(active)).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("releases an active slot immediately when its signal aborts", async () => {
    const requests = Array.from({ length: 4 }, (_, index) =>
      createCheckRequest(index),
    );
    const pending = new Map<
      string,
      ReturnType<typeof createDeferred<Response>>
    >();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = createDeferred<Response>();
      const jobId = /\/jobs\/([1-9][0-9]*)\/logs/.exec(String(input))?.[1];
      if (!jobId) throw new Error(`Unexpected check-log URL: ${String(input)}`);
      pending.set(jobId, request);
      init?.signal?.addEventListener(
        "abort",
        () => request.reject(init.signal?.reason),
        { once: true },
      );
      return request.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const aborted = getCheckLog(
      requests[0]!.pull,
      requests[0]!.job,
      controller.signal,
    );
    const remaining = requests
      .slice(1)
      .map(({ job, pull }) => getCheckLog(pull, job));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    for (const { job } of requests.slice(1)) {
      pending
        .get(job.jobId)
        ?.resolve(
          checkLogResponse(`/checks/${job.runId}/jobs/${job.jobId}/logs`),
        );
    }
    await expect(Promise.all(remaining)).resolves.toHaveLength(3);
  });

  it("supports a StrictMode-like abort and re-enqueue without sharing cancellation", async () => {
    const { job, log, pull } = createCheckRequest();
    const first = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          init?.signal?.addEventListener(
            "abort",
            () => first.reject(init.signal?.reason),
            { once: true },
          );
          return first.promise;
        },
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(log), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const initial = getCheckLog(pull, job, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(initial).rejects.toMatchObject({ name: "AbortError" });

    await expect(getCheckLog(pull, job)).resolves.toEqual(log);
    await expect(getCheckLog(pull, job)).resolves.toEqual(log);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each<[string, (log: CheckLog) => void]>([
    ["repository", (log) => (log.repository = "appwrite/console")],
    ["pull number", (log) => (log.number = 103)],
    [
      "head SHA",
      (log) => (log.headRefOid = "cccccccccccccccccccccccccccccccccccccccc"),
    ],
    ["run ID", (log) => (log.runId = "123456780")],
    ["job ID", (log) => (log.jobId = "987654320")],
  ])(
    "rejects a successful payload with a mismatched %s",
    async (_label, mutate) => {
      const log = createCheckLog();
      mutate(log);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(log), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        ),
      );

      await expect(
        getCheckLog(
          {
            baseRefOid: BASE_SHA,
            headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            number: 102,
            repository: "appwrite/cloud",
            viewerLogin: VIEWER_LOGIN,
          },
          { jobId: "987654321", runId: "123456789" },
        ),
      ).rejects.toThrow("unexpected response");
    },
  );

  it("does not cache failed requests", async () => {
    const log = createCheckLog();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Logs are still being prepared." }),
          {
            headers: { "Content-Type": "application/json" },
            status: 503,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(log), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const pull = {
      baseRefOid: BASE_SHA,
      headRefOid: log.headRefOid,
      number: log.number,
      repository: log.repository,
      viewerLogin: VIEWER_LOGIN,
    };
    const job = { jobId: log.jobId, runId: log.runId };

    await expect(getCheckLog(pull, job)).rejects.toThrow(
      "Logs are still being prepared.",
    );
    expect(getPullRequestCacheStatsForTests().checkLogs).toEqual({
      entries: 0,
      scopes: 0,
    });
    await expect(getCheckLog(pull, job)).resolves.toEqual(log);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects non-canonical request IDs before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pull = {
      baseRefOid: BASE_SHA,
      headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      number: 102,
      repository: "appwrite/cloud",
      viewerLogin: VIEWER_LOGIN,
    };

    await expect(
      getCheckLog(pull, { jobId: "0", runId: "123456789" }),
    ).rejects.toThrow("identity is invalid");
    await expect(
      getCheckLog(pull, {
        jobId: "987654321",
        runId: "123456789012345678901",
      }),
    ).rejects.toThrow("identity is invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getReleaseOptions", () => {
  it("strictly validates bounded unique previous tags", () => {
    const maximum = createReleaseOptions();
    maximum.repositories[0]!.previousTags = Array.from(
      { length: 10 },
      (_, index) => `v1.2.${10 - index}`,
    );
    expect(isReleaseOptions(maximum)).toBe(true);

    const cases: unknown[] = [
      undefined,
      "v1.2.3",
      Array.from({ length: 11 }, (_, index) => `v1.2.${index}`),
      ["v1.2.3", "v1.2.3"],
      ["v1.2.3", ""],
      ["v1.2.3", "   "],
    ];
    for (const previousTags of cases) {
      const invalid = createReleaseOptions() as unknown as {
        repositories: Array<Record<string, unknown>>;
      };
      invalid.repositories[0]!.previousTags = previousTags;
      expect(isReleaseOptions(invalid)).toBe(false);
    }
  });

  it("rejects unexpected release repository fields", () => {
    const options = createReleaseOptions() as unknown as {
      repositories: Array<Record<string, unknown>>;
    };
    options.repositories[0]!.allTags = ["v1.2.3"];

    expect(isReleaseOptions(options)).toBe(false);
  });

  it("strictly validates repository and tag cache timestamps", () => {
    expect(isReleaseOptions(createReleaseOptions())).toBe(true);

    for (const key of ["repositoriesUpdatedAt", "tagsUpdatedAt"] as const) {
      const missing = createReleaseOptions() as unknown as Record<
        string,
        unknown
      >;
      delete missing[key];
      expect(isReleaseOptions(missing)).toBe(false);

      const invalid = createReleaseOptions() as unknown as Record<
        string,
        unknown
      >;
      invalid[key] = "not-a-date";
      expect(isReleaseOptions(invalid)).toBe(false);
    }
  });

  it("rejects cache timestamps newer than the response and unexpected fields", () => {
    const futureRepositoryCache = createReleaseOptions();
    futureRepositoryCache.repositoriesUpdatedAt = "2026-07-21T08:03:00.000Z";
    expect(isReleaseOptions(futureRepositoryCache)).toBe(false);

    const futureTagCache = createReleaseOptions();
    futureTagCache.tagsUpdatedAt = "2026-07-21T08:03:00.000Z";
    expect(isReleaseOptions(futureTagCache)).toBe(false);

    const extra = createReleaseOptions() as unknown as Record<string, unknown>;
    extra.cachedAt = "2026-07-21T08:00:00.000Z";
    expect(isReleaseOptions(extra)).toBe(false);
  });

  it("keeps the cached endpoint by default and can explicitly bypass it", async () => {
    const options = createReleaseOptions();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(options), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getReleaseOptions();
    await getReleaseOptions(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/releases/options",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/releases/options?refresh=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects a successful response without required cache timestamps", async () => {
    const options = createReleaseOptions() as unknown as Record<
      string,
      unknown
    >;
    delete options.tagsUpdatedAt;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(options), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(getReleaseOptions()).rejects.toThrow("unexpected response");
  });
});
