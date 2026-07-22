import { describe, expect, it, vi } from "vitest";

import {
  CI_QUERY,
  COMMENTS_QUERY,
  CONTEXTS_QUERY,
  EVIDENCE_STATES_QUERY,
  FAILURE_REFRESH_INTERVAL,
  GRAPHQL_MAX_BUFFER,
  OUTER_QUERY,
  POLL_QUERY,
  PULL_QUERY,
  SEARCH_LIMIT,
  SEARCH_QUERY,
  TARGET_CHECKS_QUERY,
  TARGET_CONTEXTS_QUERY,
  TARGET_PULL_QUERY,
  TARGET_SEARCH_QUERY,
  THREAD_COMMENTS_QUERY,
  THREADS_QUERY,
  createAuthoredPullPoller,
  createGhGraphql,
  createGithubLoader,
  fetchAuthoredPulls,
  fetchCheckAuthorization,
  fetchPull,
  fetchPullAuthorization,
  targetSearchQuery,
} from "../github.mjs";
import { assessPull } from "../readiness.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const BASE = "1234567890abcdef1234567890abcdef12345678";
const NEXT_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function pageInfo(hasNextPage = false, endCursor = null) {
  return { endCursor, hasNextPage };
}

function checkRun(id, { conclusion = "SUCCESS", status = "COMPLETED" } = {}) {
  return {
    __typename: "CheckRun",
    checkSuite: { workflowRun: { workflow: { name: "CI" } } },
    conclusion,
    detailsUrl: `https://github.com/example/repo/actions/runs/${id}`,
    id: `check-${id}`,
    name: `Check ${id}`,
    status,
  };
}

function statusContext(id, state = "SUCCESS") {
  return {
    __typename: "StatusContext",
    context: `Status ${id}`,
    id: `status-${id}`,
    state,
    targetUrl: `https://ci.example/${id}`,
  };
}

function countsByState(nodes, typename, total, stateFor) {
  const counts = new Map();
  for (const node of nodes.filter((item) => item.__typename === typename)) {
    const state = stateFor(node);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  const observed = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const missing = total - observed;
  if (missing > 0) {
    const state = "SUCCESS";
    counts.set(state, (counts.get(state) ?? 0) + missing);
  }

  return [...counts].map(([state, count]) => ({ count, state }));
}

function contexts(
  nodes = [checkRun(1)],
  {
    checkRunCount = nodes.filter((node) => node.__typename === "CheckRun")
      .length,
    cursor = null,
    next = false,
    statusContextCount = nodes.filter(
      (node) => node.__typename === "StatusContext",
    ).length,
  } = {},
) {
  return {
    checkRunCount,
    checkRunCountsByState: countsByState(
      nodes,
      "CheckRun",
      checkRunCount,
      (node) => (node.status === "COMPLETED" ? node.conclusion : node.status),
    ),
    nodes,
    pageInfo: pageInfo(next, cursor),
    statusContextCount,
    statusContextCountsByState: countsByState(
      nodes,
      "StatusContext",
      statusContextCount,
      (node) => node.state,
    ),
  };
}

function reviewComment(id, body = `Comment ${id}`) {
  return {
    author: { login: "reviewer" },
    body,
    createdAt: "2026-07-17T00:00:00Z",
    id: `review-comment-${id}`,
    line: 10,
    outdated: false,
    path: "src/index.ts",
    updatedAt: "2026-07-17T00:00:00Z",
    url: `https://github.com/example/repo/pull/1#discussion_r${id}`,
  };
}

function thread(
  id,
  {
    comments = [reviewComment(id)],
    cursor = null,
    next = false,
    resolved = false,
  } = {},
) {
  return {
    comments: {
      nodes: comments,
      pageInfo: pageInfo(next, cursor),
      totalCount: comments.length,
    },
    id: `thread-${id}`,
    isOutdated: false,
    isResolved: resolved,
    line: 10,
    path: "src/index.ts",
  };
}

function issueComment(id, body = "body") {
  return {
    author: { login: "greptile-apps" },
    body,
    createdAt: "2026-07-17T00:00:00Z",
    id: `comment-${id}`,
    updatedAt: "2026-07-17T00:00:00Z",
    url: `https://github.com/example/repo/pull/1#issuecomment-${id}`,
  };
}

function issueCommentEvidence(comment) {
  return {
    __typename: "IssueComment",
    id: comment.id,
    updatedAt: comment.updatedAt,
  };
}

function reviewCommentEvidence(comment) {
  return {
    __typename: "PullRequestReviewComment",
    id: comment.id,
    updatedAt: comment.updatedAt,
  };
}

function threadEvidence(
  value,
  { commentCount = value.comments.totalCount } = {},
) {
  return {
    __typename: "PullRequestReviewThread",
    comments: { totalCount: commentCount },
    id: value.id,
    isResolved: value.isResolved,
  };
}

function summaryComment(
  id,
  {
    confidence = 5,
    createdAt = "2026-07-17T00:00:00Z",
    reviewedSha = SHA,
    updatedAt = "2026-07-17T00:00:00Z",
  } = {},
) {
  return {
    ...issueComment(
      id,
      `Confidence Score: ${confidence}/5\nLast reviewed commit: ${reviewedSha}`,
    ),
    createdAt,
    updatedAt,
  };
}

function node(number, overrides = {}) {
  return {
    author: { login: "viewer" },
    baseRefOid: BASE,
    comments: { nodes: [], pageInfo: pageInfo() },
    headRefName: "fix/review",
    headRefOid: SHA,
    headRepository: { nameWithOwner: "example/repo" },
    isCrossRepository: false,
    number,
    repository: {
      name: "repo",
      nameWithOwner: "example/repo",
      owner: { login: "example" },
      url: "https://github.com/example/repo",
      viewerPermission: "WRITE",
    },
    reviewThreads: { nodes: [], pageInfo: pageInfo() },
    state: "OPEN",
    statusCheckRollup: {
      commit: { oid: SHA },
      contexts: contexts(),
      state: "SUCCESS",
    },
    title: `Pull ${number}`,
    updatedAt: "2026-07-17T00:00:00Z",
    url: `https://github.com/example/repo/pull/${number}`,
    ...overrides,
  };
}

function search(
  nodes,
  { count = nodes.length, cursor = null, next = false } = {},
) {
  return {
    search: { issueCount: count, nodes, pageInfo: pageInfo(next, cursor) },
    viewer: { login: "viewer" },
  };
}

function target(
  exact,
  members,
  {
    count = members.length,
    cursor = null,
    next = false,
    viewer = "viewer",
  } = {},
) {
  return {
    repository: exact === null ? null : { pullRequest: exact },
    search: {
      issueCount: count,
      nodes: members,
      pageInfo: pageInfo(next, cursor),
    },
    viewer: { login: viewer },
  };
}

function pollNode(number, overrides = {}) {
  const exact = node(number, overrides);
  const fallbackContexts = contexts([
    checkRun(
      1,
      ["PENDING", "EXPECTED"].includes(exact.statusCheckRollup?.state)
        ? { conclusion: null, status: "IN_PROGRESS" }
        : ["FAILURE", "ERROR"].includes(exact.statusCheckRollup?.state)
          ? { conclusion: "FAILURE" }
          : {},
    ),
  ]);
  const rollupContexts = exact.statusCheckRollup?.contexts ?? fallbackContexts;
  return {
    ...exact,
    comments: { totalCount: exact.comments.nodes.length },
    id: `pull-${number}`,
    reviewThreads: { totalCount: exact.reviewThreads.nodes.length },
    statusCheckRollup:
      exact.statusCheckRollup === null
        ? null
        : {
            commit: exact.statusCheckRollup.commit,
            contexts: {
              checkRunCount: rollupContexts.checkRunCount,
              checkRunCountsByState: rollupContexts.checkRunCountsByState,
              statusContextCount: rollupContexts.statusContextCount,
              statusContextCountsByState:
                rollupContexts.statusContextCountsByState,
            },
            state: exact.statusCheckRollup.state,
          },
  };
}

describe("GitHub CI evidence", () => {
  it.each([
    ["SUCCESS", "success"],
    ["NEUTRAL", "neutral"],
    ["SKIPPED", "skipped"],
    ["ACTION_REQUIRED", "failure"],
    ["CANCELLED", "failure"],
    ["FAILURE", "failure"],
    ["STARTUP_FAILURE", "failure"],
    ["STALE", "failure"],
    ["TIMED_OUT", "failure"],
  ])(
    "normalizes completed CheckRun conclusion %s",
    async (conclusion, expected) => {
      const result = await fetchAuthoredPulls({
        graphql: async () =>
          search([
            node(1, {
              statusCheckRollup: {
                commit: { oid: SHA },
                contexts: contexts([checkRun(1, { conclusion })]),
                state: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)
                  ? "SUCCESS"
                  : "FAILURE",
              },
            }),
          ]),
      });

      expect(result.pulls[0].ci).toMatchObject({
        complete: true,
        state: expected === "failure" ? "failure" : "success",
      });
      expect(result.pulls[0].ci.checks[0].id).toBe("check-1");
      expect(result.pulls[0].ci.checks[0].state).toBe(expected);
    },
  );

  it.each(["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"])(
    "normalizes non-completed CheckRun status %s as running",
    async (status) => {
      const result = await fetchAuthoredPulls({
        graphql: async () =>
          search([
            node(1, {
              statusCheckRollup: {
                commit: { oid: SHA },
                contexts: contexts([checkRun(1, { conclusion: null, status })]),
                state: "PENDING",
              },
            }),
          ]),
      });
      expect(result.pulls[0].ci).toMatchObject({
        complete: true,
        passed: 0,
        running: 1,
        state: "pending",
        total: 1,
      });
    },
  );

  it.each([
    ["SUCCESS", "success"],
    ["ERROR", "failure"],
    ["FAILURE", "failure"],
    ["EXPECTED", "pending"],
    ["PENDING", "pending"],
  ])("normalizes StatusContext state %s", async (state, expected) => {
    const result = await fetchAuthoredPulls({
      graphql: async () =>
        search([
          node(1, {
            statusCheckRollup: {
              commit: { oid: SHA },
              contexts: contexts([statusContext(1, state)]),
              state:
                expected === "success"
                  ? "SUCCESS"
                  : expected === "failure"
                    ? "FAILURE"
                    : "PENDING",
            },
          }),
        ]),
    });
    expect(result.pulls[0].ci).toMatchObject({
      checks: [expect.objectContaining({ id: "status-1" })],
      state: expected,
    });
  });

  it("paginates more than 100 mixed contexts and preserves the count invariant", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      checkRun(index + 1),
    );
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            statusCheckRollup: {
              commit: { oid: SHA },
              contexts: contexts(first, {
                checkRunCount: 101,
                cursor: "checks-100",
                next: true,
              }),
              state: "SUCCESS",
            },
          }),
        ]);
      }
      expect(document).toBe(CONTEXTS_QUERY);
      return {
        repository: {
          pullRequest: {
            headRefOid: SHA,
            statusCheckRollup: {
              commit: { oid: SHA },
              contexts: contexts([checkRun(101)], { checkRunCount: 101 }),
              state: "SUCCESS",
            },
          },
        },
      };
    });

    const { ci } = (await fetchAuthoredPulls({ graphql })).pulls[0];
    expect(ci).toMatchObject({
      complete: true,
      passed: 101,
      total: 101,
      unknown: 0,
    });
    expect(ci.passed + ci.failed + ci.running + ci.unknown).toBe(ci.total);
  });

  it.each([
    ["completed without conclusion", checkRun(1, { conclusion: null })],
    [
      "running with conclusion",
      checkRun(1, { conclusion: "SUCCESS", status: "QUEUED" }),
    ],
    ["missing context id", { ...checkRun(1), id: "" }],
    ["unknown typename", { __typename: "FutureCheck", id: "future" }],
  ])("fails closed for %s", async (_label, context) => {
    const result = await fetchAuthoredPulls({
      graphql: async () =>
        search([
          node(1, {
            statusCheckRollup: {
              commit: { oid: SHA },
              contexts: contexts([context]),
              state: "SUCCESS",
            },
          }),
        ]),
    });
    const ci = result.pulls[0].ci;
    expect(ci.complete).toBe(false);
    expect(ci.state).toBe("unknown");
    expect(ci.checks.every(({ id }) => id.length > 0)).toBe(true);
    expect(new Set(ci.checks.map(({ id }) => id)).size).toBe(ci.checks.length);
    expect(ci.passed + ci.failed + ci.running + ci.unknown).toBe(ci.total);
  });

  it("uses none only for an explicit null rollup and rejects mismatched commits/counts", async () => {
    const none = await fetchAuthoredPulls({
      graphql: async () => search([node(1, { statusCheckRollup: null })]),
    });
    expect(none.pulls[0].ci).toEqual({
      checks: [],
      complete: true,
      failed: 0,
      passed: 0,
      running: 0,
      state: "none",
      total: 0,
      unknown: 0,
    });

    const unknown = await fetchAuthoredPulls({
      graphql: async () =>
        search([
          node(1, {
            statusCheckRollup: {
              commit: { oid: BASE },
              contexts: contexts([], { checkRunCount: 2 }),
              state: "SUCCESS",
            },
          }),
        ]),
    });
    expect(unknown.pulls[0].ci).toMatchObject({
      complete: false,
      state: "unknown",
      total: 2,
      unknown: 2,
    });
  });
});

describe("review and Greptile evidence pagination", () => {
  it("paginates more than 100 review threads", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      thread(index, { comments: [], resolved: true }),
    );
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: {
              nodes: first,
              pageInfo: pageInfo(true, "threads-100"),
            },
          }),
        ]);
      }
      expect(document).toBe(THREADS_QUERY);
      return {
        repository: {
          pullRequest: {
            headRefOid: SHA,
            reviewThreads: {
              nodes: [thread(101, { comments: [], resolved: true })],
              pageInfo: pageInfo(),
            },
          },
        },
      };
    });

    const pull = (await fetchAuthoredPulls({ graphql })).pulls[0];
    expect(pull.reviewThreads).toHaveLength(101);
    expect(pull.threadsComplete).toBe(true);
  });

  it("exhausts nested comments and exposes every unresolved-thread reply with stable identity", async () => {
    const graphql = vi.fn(async (document, variables) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: {
              nodes: [thread(1, { cursor: "comment-1", next: true })],
              pageInfo: pageInfo(),
            },
          }),
        ]);
      }
      expect(document).toBe(THREAD_COMMENTS_QUERY);
      if (variables.after === "comment-1") {
        return {
          node: {
            id: "thread-1",
            comments: {
              nodes: Array.from({ length: 100 }, (_, index) =>
                reviewComment(index + 2),
              ),
              pageInfo: pageInfo(true, "comment-101"),
            },
          },
        };
      }
      return {
        node: {
          id: "thread-1",
          comments: {
            nodes: [reviewComment(102)],
            pageInfo: pageInfo(),
          },
        },
      };
    });

    const pull = (await fetchAuthoredPulls({ graphql })).pulls[0];
    expect(pull.threadsComplete).toBe(true);
    expect(pull.unresolvedThreads).toEqual([
      expect.objectContaining({
        body: "Comment 1",
        id: "thread-1",
        path: "src/index.ts",
        line: 10,
      }),
    ]);
    expect(pull.unresolvedThreads[0].comments).toHaveLength(102);
    expect(pull.unresolvedThreads[0].comments[0]).toEqual({
      author: "reviewer",
      body: "Comment 1",
      createdAt: "2026-07-17T00:00:00Z",
      id: "review-comment-1",
      line: 10,
      outdated: false,
      path: "src/index.ts",
      updatedAt: "2026-07-17T00:00:00Z",
      url: "https://github.com/example/repo/pull/1#discussion_r1",
    });
    expect(pull.unresolvedThreads[0].comments.at(-1)?.id).toBe(
      "review-comment-102",
    );
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("paginates outer issue comments used for Greptile evidence", async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            comments: {
              nodes: [issueComment(1)],
              pageInfo: pageInfo(true, "issue-1"),
            },
          }),
        ]);
      }
      expect(document).toBe(COMMENTS_QUERY);
      return {
        repository: {
          pullRequest: {
            comments: { nodes: [issueComment(2)], pageInfo: pageInfo() },
            headRefOid: SHA,
          },
        },
      };
    });
    expect((await fetchAuthoredPulls({ graphql })).pulls[0].comments).toEqual([
      expect.objectContaining({
        id: "comment-1",
        createdAt: "2026-07-17T00:00:00Z",
        updatedAt: "2026-07-17T00:00:00Z",
      }),
      expect.objectContaining({ id: "comment-2" }),
    ]);
  });

  it("fails closed and omits a duplicate reply repeated across comment pages", async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: {
              nodes: [thread(1, { cursor: "reply-1", next: true })],
              pageInfo: pageInfo(),
            },
          }),
        ]);
      }
      expect(document).toBe(THREAD_COMMENTS_QUERY);
      return {
        node: {
          id: "thread-1",
          comments: {
            nodes: [reviewComment(1)],
            pageInfo: pageInfo(),
          },
        },
      };
    });

    const pull = (await fetchAuthoredPulls({ graphql })).pulls[0];
    expect(pull.threadsComplete).toBe(false);
    expect(pull.unresolvedThreads).toEqual([
      expect.objectContaining({
        comments: [expect.objectContaining({ id: "review-comment-1" })],
      }),
    ]);
  });

  it("fails closed for incomplete outer, nested, and comment connections", async () => {
    const result = await fetchAuthoredPulls({
      graphql: async () =>
        search([
          node(1, {
            comments: { nodes: null, pageInfo: pageInfo() },
            reviewThreads: {
              nodes: [thread(1, { comments: [], next: false })],
              pageInfo: pageInfo(),
            },
          }),
        ]),
    });
    expect(result.pulls[0]).toMatchObject({
      commentsComplete: false,
      threadsComplete: false,
    });
  });
});

describe("authored search and exact loader", () => {
  it("uses the exact query, viewer identity, ordering, and 1,000 result cap", async () => {
    expect(SEARCH_LIMIT).toBe(1_000);
    const graphql = vi.fn(async (_document, variables) => {
      expect(variables.searchQuery).toBe(SEARCH_QUERY);
      return search([node(2), node(1)], { count: 1_001 });
    });
    const result = await fetchAuthoredPulls({ graphql });
    expect(result.viewerLogin).toBe("viewer");
    expect(result.pulls.map(({ number }) => number)).toEqual([2, 1]);
    expect(result.partial).toBe(true);
    expect(result.warnings).toContain(
      "GitHub search is limited to the first 1,000 results.",
    );
  });

  it("keeps delegated author:@me results while reporting malformed evidence", async () => {
    const result = await fetchAuthoredPulls({
      graphql: async () =>
        search([{}, node(1, { author: { login: "someone-else" } })]),
    });
    expect(result.pulls).toHaveLength(1);
    expect(result.pulls[0]).toMatchObject({
      authorLogin: "someone-else",
      number: 1,
    });
    expect(result.partial).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("fresh-loads a delegated search member with exact identity and complete evidence", async () => {
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(7, { author: { login: "copilot-swe-agent" } }),
        ]);
      }
      expect(document).toBe(PULL_QUERY);
      return {
        repository: {
          pullRequest: node(7, { author: { login: "copilot-swe-agent" } }),
        },
        viewer: { login: "viewer" },
      };
    });
    const exact = await fetchPull({
      graphql,
      number: 7,
      repository: "example/repo",
    });
    expect(exact).toMatchObject({
      authorLogin: "copilot-swe-agent",
      authored: true,
      available: true,
      baseRefOid: BASE,
      complete: true,
      headRefOid: SHA,
      number: 7,
      open: true,
      repository: "example/repo",
      viewerLogin: "viewer",
    });
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("distinguishes unavailable pulls from incomplete or non-member pulls", async () => {
    const missing = await fetchPull({
      graphql: async (document) =>
        document === POLL_QUERY
          ? search([])
          : { repository: null, viewer: { login: "viewer" } },
      number: 1,
      repository: "example/repo",
    });
    expect(missing).toMatchObject({ available: false, complete: true });

    const authored = await fetchPull({
      graphql: async (document) =>
        document === POLL_QUERY
          ? search([])
          : {
              repository: {
                pullRequest: node(1, { author: { login: "other" } }),
              },
              viewer: { login: "viewer" },
            },
      number: 1,
      repository: "example/repo",
    });
    expect(authored).toMatchObject({
      authored: false,
      available: true,
      complete: true,
    });
  });

  it("fails membership proof closed when search and exact head state disagree", async () => {
    const exact = await fetchPull({
      graphql: async (document) =>
        document === POLL_QUERY
          ? search([
              pollNode(1, {
                headRefOid: NEXT_SHA,
                statusCheckRollup: {
                  commit: { oid: NEXT_SHA },
                  state: "SUCCESS",
                },
              }),
            ])
          : {
              repository: { pullRequest: node(1) },
              viewer: { login: "viewer" },
            },
      number: 1,
      repository: "example/repo",
    });

    expect(exact).toMatchObject({
      authored: false,
      available: true,
      complete: false,
    });
  });

  it("fails membership authorization closed when the authored search is partial", async () => {
    const exact = await fetchPull({
      graphql: async (document) =>
        document === POLL_QUERY
          ? search([pollNode(1)], { count: 1_001 })
          : {
              repository: { pullRequest: node(1) },
              viewer: { login: "viewer" },
            },
      number: 1,
      repository: "example/repo",
    });

    expect(exact).toMatchObject({
      authored: false,
      available: true,
      complete: false,
    });
  });

  it("creates a reusable loader over an injected GraphQL function", async () => {
    const graphql = vi.fn(async (document) =>
      document === POLL_QUERY
        ? search([])
        : { repository: null, viewer: { login: "viewer" } },
    );
    const loader = createGithubLoader({ graphql });
    await loader.loadPull({ number: 1, repository: "example/repo" });
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});

describe("targeted authored pull authorization", () => {
  it("uses a fixed repository-scoped author search and preserves delegated membership", async () => {
    const delegated = node(7, { author: { login: "copilot-swe-agent" } });
    const graphql = vi.fn(async (document, variables) => {
      expect(document).toBe(TARGET_PULL_QUERY);
      expect(variables).toMatchObject({
        after: null,
        name: "repo",
        number: 7,
        owner: "example",
        searchQuery: `${TARGET_SEARCH_QUERY} repo:example/repo`,
      });
      return target(delegated, [delegated]);
    });

    expect(targetSearchQuery("example/repo")).toBe(
      "is:pr author:@me state:open archived:false repo:example/repo",
    );
    await expect(
      fetchPullAuthorization({
        graphql,
        number: 7,
        repository: "example/repo",
      }),
    ).resolves.toMatchObject({
      authored: true,
      authorLogin: "copilot-swe-agent",
      available: true,
      complete: true,
      headRefName: "fix/review",
      headRepository: "example/repo",
      isCrossRepository: false,
      viewerLogin: "viewer",
      viewerPermission: "WRITE",
    });
  });

  it("threads a caller signal through the reusable loader and every targeted page", async () => {
    const exact = node(7);
    const controller = new AbortController();
    const graphql = vi.fn(async (_document, variables, options) => {
      expect(options).toEqual({ signal: controller.signal });
      return variables.after === null
        ? target(exact, [node(1)], { count: 2, cursor: "page-1", next: true })
        : target(exact, [exact], { count: 2 });
    });
    const loader = createGithubLoader({ graphql });

    await expect(
      loader.loadPullAuthorization(
        {
          number: 7,
          repository: "example/repo",
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ authored: true, complete: true });

    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("paginates until the exact pull is found on a later page", async () => {
    const exact = node(7);
    const graphql = vi.fn(async (_document, variables) =>
      variables.after === null
        ? target(exact, [node(1)], { count: 2, cursor: "page-1", next: true })
        : target(exact, [exact], { count: 2 }),
    );

    const proof = await fetchPullAuthorization({
      graphql,
      number: 7,
      repository: "example/repo",
    });

    expect(proof).toMatchObject({ authored: true, complete: true, number: 7 });
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      TARGET_PULL_QUERY,
      expect.objectContaining({
        after: "page-1",
      }),
    );
  });

  it("proves fresh membership removal after exhausting the scoped search", async () => {
    const exact = node(7);
    const proof = await fetchPullAuthorization({
      graphql: async () => target(exact, []),
      number: 7,
      repository: "example/repo",
    });

    expect(proof).toMatchObject({
      authored: false,
      available: true,
      complete: true,
      headRefOid: SHA,
    });
  });

  it("fails closed for malformed pagination and identity drift", async () => {
    const exact = node(7);
    const repeated = vi.fn(async () =>
      target(exact, [node(1)], {
        count: 3,
        cursor: "same",
        next: true,
      }),
    );
    const repeatedProof = await fetchPullAuthorization({
      graphql: repeated,
      number: 7,
      repository: "example/repo",
    });
    expect(repeatedProof).toMatchObject({ authored: false, complete: false });
    expect(repeated).toHaveBeenCalledTimes(2);

    const drifted = await fetchPullAuthorization({
      graphql: async (_document, variables) =>
        variables.after === null
          ? target(exact, [node(1)], { count: 2, cursor: "next", next: true })
          : target(node(7, { headRefOid: NEXT_SHA }), [exact], { count: 2 }),
      number: 7,
      repository: "example/repo",
    });
    expect(drifted).toMatchObject({ authored: false, complete: false });
  });

  it("paginates the current rollup and returns only canonical failed Actions jobs", async () => {
    const failed = {
      ...checkRun(7, { conclusion: "FAILURE" }),
      detailsUrl: "https://github.com/example/repo/actions/runs/700/job/701",
    };
    const failedLater = {
      ...checkRun(8, { conclusion: "TIMED_OUT" }),
      detailsUrl: "https://github.com/example/repo/actions/runs/800/job/801",
    };
    const rollup = {
      commit: { oid: SHA },
      contexts: contexts([failed], {
        checkRunCount: 2,
        cursor: "checks-1",
        next: true,
      }),
      state: "FAILURE",
    };
    const exact = node(7, { statusCheckRollup: rollup });
    const controller = new AbortController();
    const graphql = vi.fn(async (document, variables, options) => {
      expect(options).toEqual({ signal: controller.signal });
      if (document === TARGET_CHECKS_QUERY) return target(exact, [exact]);
      expect(document).toBe(TARGET_CONTEXTS_QUERY);
      return {
        repository: {
          pullRequest:
            variables.after === null
              ? exact
              : node(7, {
                  statusCheckRollup: {
                    commit: { oid: SHA },
                    contexts: contexts([failedLater], { checkRunCount: 2 }),
                    state: "FAILURE",
                  },
                }),
        },
        viewer: { login: "viewer" },
      };
    });

    const proof = await fetchCheckAuthorization({
      graphql,
      number: 7,
      repository: "example/repo",
      signal: controller.signal,
    });

    expect(proof).toMatchObject({ checksComplete: true, complete: true });
    expect(proof.failedChecks).toEqual([
      expect.objectContaining({
        checkId: "check-7",
        jobId: "701",
        runId: "700",
      }),
      expect.objectContaining({
        checkId: "check-8",
        jobId: "801",
        runId: "800",
      }),
    ]);
  });

  it("rejects a same-head failed job replaced during context pagination", async () => {
    const stale = {
      ...checkRun(7, { conclusion: "FAILURE" }),
      detailsUrl: "https://github.com/example/repo/actions/runs/700/job/701",
    };
    const replacement = {
      ...checkRun(9, { conclusion: "FAILURE" }),
      detailsUrl: "https://github.com/example/repo/actions/runs/900/job/901",
    };
    const unchanged = checkRun(8);
    const firstRollup = {
      commit: { oid: SHA },
      contexts: contexts([stale], {
        checkRunCount: 2,
        cursor: "checks-1",
        next: true,
      }),
      state: "FAILURE",
    };
    const currentRollup = {
      commit: { oid: SHA },
      contexts: contexts([replacement], {
        checkRunCount: 2,
        cursor: "checks-1",
        next: true,
      }),
      state: "FAILURE",
    };
    const exact = node(7, { statusCheckRollup: firstRollup });
    let revalidating = false;
    const graphql = vi.fn(async (document, variables) => {
      if (document === TARGET_CHECKS_QUERY) return target(exact, [exact]);
      expect(document).toBe(TARGET_CONTEXTS_QUERY);
      if (variables.after === null) {
        revalidating = true;
        return {
          repository: {
            pullRequest: node(7, { statusCheckRollup: currentRollup }),
          },
          viewer: { login: "viewer" },
        };
      }
      return {
        repository: {
          pullRequest: node(7, {
            statusCheckRollup: {
              commit: { oid: SHA },
              contexts: contexts([unchanged], { checkRunCount: 2 }),
              state: "FAILURE",
            },
          }),
        },
        viewer: { login: "viewer" },
      };
    });

    const proof = await fetchCheckAuthorization({
      graphql,
      number: 7,
      repository: "example/repo",
    });

    expect(revalidating).toBe(true);
    expect(proof).toMatchObject({ checksComplete: false, complete: false });
    expect(proof.failedChecks).toEqual([]);
  });

  it("fails check proof closed when the rollup changes during pagination", async () => {
    const failed = {
      ...checkRun(7, { conclusion: "FAILURE" }),
      detailsUrl: "https://github.com/example/repo/actions/runs/700/job/701",
    };
    const exact = node(7, {
      statusCheckRollup: {
        commit: { oid: SHA },
        contexts: contexts([failed], {
          checkRunCount: 2,
          cursor: "next",
          next: true,
        }),
        state: "FAILURE",
      },
    });
    const proof = await fetchCheckAuthorization({
      graphql: async (document) =>
        document === TARGET_CHECKS_QUERY
          ? target(exact, [exact])
          : {
              repository: { pullRequest: node(7, { statusCheckRollup: null }) },
              viewer: { login: "viewer" },
            },
      number: 7,
      repository: "example/repo",
    });

    expect(proof).toMatchObject({
      checksComplete: false,
      complete: false,
      failedChecks: [],
    });
  });
});

describe("rate-efficient authored pull polling", () => {
  it("hydrates delegated author:@me members without an extra membership search", async () => {
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, { author: { login: "copilot-swe-agent" } }),
        ]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, { author: { login: "copilot-swe-agent" } }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    const result = await poll();

    expect(result.pulls).toHaveLength(1);
    expect(result.pulls[0]).toMatchObject({
      authorLogin: "copilot-swe-agent",
      number: 1,
    });
    expect(graphql.mock.calls.map(([document]) => document)).toEqual([
      POLL_QUERY,
      PULL_QUERY,
    ]);
  });

  it("reuses complete evidence when the lightweight poll fingerprint is unchanged", async () => {
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) return search([pollNode(1)]);
      if (document === PULL_QUERY) {
        return {
          repository: { pullRequest: node(1) },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected expensive query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const second = await poll();

    expect(second.pulls).toHaveLength(1);
    expect(graphql.mock.calls.map(([document]) => document)).toEqual([
      POLL_QUERY,
      PULL_QUERY,
      POLL_QUERY,
    ]);
    expect(POLL_QUERY).not.toContain("comments(first: 100)");
    expect(POLL_QUERY).not.toContain("reviewThreads(first: 100)");
    expect(POLL_QUERY).not.toContain("contexts(first: 100)");
  });

  it("retries full hydration while any exact readiness evidence is incomplete", async () => {
    const incompleteRollup = {
      commit: { oid: SHA },
      contexts: contexts([], { checkRunCount: 1 }),
      state: "SUCCESS",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([pollNode(1, { statusCheckRollup: incompleteRollup })]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, { statusCheckRollup: incompleteRollup }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    const first = await poll();
    const second = await poll();

    expect(first.partial).toBe(false);
    expect(first.warnings).not.toHaveLength(0);
    expect(second.partial).toBe(false);
    expect(second.warnings).not.toHaveLength(0);
    expect(
      graphql.mock.calls.filter(([document]) => document === PULL_QUERY),
    ).toHaveLength(2);
  });

  it("keeps search removals authoritative when another pull evidence refresh fails", async () => {
    let polls = 0;
    const pendingRollup = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1, { conclusion: null, status: "IN_PROGRESS" }),
      ]),
      state: "PENDING",
    };
    const graphql = vi.fn(async (document, variables) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const current = pollNode(2, { statusCheckRollup: pendingRollup });
        return search(polls === 1 ? [pollNode(1), current] : [current]);
      }
      if (document === PULL_QUERY) {
        const statusCheckRollup =
          variables.number === 2 ? pendingRollup : node(1).statusCheckRollup;
        return {
          repository: {
            pullRequest: node(variables.number, { statusCheckRollup }),
          },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) throw new Error("temporary CI failure");
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect((await poll()).pulls.map(({ number }) => number)).toEqual([1, 2]);
    const changed = await poll();

    expect(changed.partial).toBe(false);
    expect(changed.warnings).not.toHaveLength(0);
    expect(changed.pulls.map(({ number }) => number)).toEqual([2]);
    expect(
      graphql.mock.calls.filter(([document]) => document === CI_QUERY),
    ).toHaveLength(1);
  });

  it("reloads complete evidence when the pull head or metadata changes", async () => {
    let generation = 0;
    const graphql = vi.fn(async (document) => {
      const headRefOid = generation > 1 ? NEXT_SHA : SHA;
      const updatedAt =
        generation > 1 ? "2026-07-17T01:00:00Z" : "2026-07-17T00:00:00Z";
      const statusCheckRollup = {
        commit: { oid: headRefOid },
        contexts: contexts(),
        state: "SUCCESS",
      };
      if (document === POLL_QUERY) {
        generation += 1;
        const currentHead = generation > 1 ? NEXT_SHA : SHA;
        return search([
          pollNode(1, {
            headRefOid: currentHead,
            statusCheckRollup: {
              commit: { oid: currentHead },
              contexts: contexts(),
              state: "SUCCESS",
            },
            updatedAt: generation > 1 ? "2026-07-17T01:00:00Z" : updatedAt,
          }),
        ]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, { headRefOid, statusCheckRollup, updatedAt }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const second = await poll();

    expect(second.pulls[0].headRefOid).toBe(NEXT_SHA);
    expect(
      graphql.mock.calls.filter(([document]) => document === PULL_QUERY),
    ).toHaveLength(2);
  });

  it("invalidates old ready evidence when a changed head cannot be hydrated", async () => {
    let polls = 0;
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const headRefOid = polls === 1 ? SHA : NEXT_SHA;
        return search([
          pollNode(1, {
            headRefOid,
            statusCheckRollup: {
              commit: { oid: headRefOid },
              state: "SUCCESS",
            },
          }),
        ]);
      }
      if (document === PULL_QUERY) {
        if (polls > 1) throw new Error("temporary exact-load failure");
        return {
          repository: { pullRequest: node(1) },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const changed = await poll();

    expect(changed).toMatchObject({ partial: false });
    expect(changed.warnings).not.toHaveLength(0);
    expect(changed.pulls[0]).toMatchObject({
      commentsComplete: false,
      headRefOid: NEXT_SHA,
      threadsComplete: false,
    });
    expect(changed.pulls[0].ci).toMatchObject({
      complete: false,
      state: "unknown",
    });
  });

  it("keeps a conflicting exact closure visible but never ready", async () => {
    let polls = 0;
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const headRefOid = polls === 1 ? SHA : NEXT_SHA;
        return search([
          pollNode(1, {
            headRefOid,
            statusCheckRollup: {
              commit: { oid: headRefOid },
              state: "SUCCESS",
            },
          }),
        ]);
      }
      if (document === PULL_QUERY) {
        if (polls === 1) {
          return {
            repository: { pullRequest: node(1) },
            viewer: { login: "viewer" },
          };
        }
        return {
          repository: {
            pullRequest: node(1, {
              headRefOid: NEXT_SHA,
              state: "CLOSED",
              statusCheckRollup: {
                commit: { oid: NEXT_SHA },
                contexts: contexts(),
                state: "SUCCESS",
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const changed = await poll();

    expect(changed).toMatchObject({ partial: false });
    expect(changed.warnings).not.toHaveLength(0);
    expect(changed.pulls).toHaveLength(1);
    expect(changed.pulls[0]).toMatchObject({
      commentsComplete: false,
      headRefOid: NEXT_SHA,
      threadsComplete: false,
    });
    expect(assessPull(changed.pulls[0], 1).ready).toBe(false);
  });

  it("refreshes only CI evidence while a check is running and exposes progress counts", async () => {
    let polls = 0;
    const pendingRollup = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1, { conclusion: null, status: "IN_PROGRESS" }),
        checkRun(2, { conclusion: null, status: "QUEUED" }),
      ]),
      state: "PENDING",
    };
    const refreshedRollup = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1),
        checkRun(2, { conclusion: null, status: "IN_PROGRESS" }),
      ]),
      state: "PENDING",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const statusCheckRollup = polls > 1 ? refreshedRollup : pendingRollup;
        return search([pollNode(1, { statusCheckRollup })]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, { statusCheckRollup: pendingRollup }),
          },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) {
        return {
          repository: {
            pullRequest: {
              headRefOid: SHA,
              state: "OPEN",
              statusCheckRollup: refreshedRollup,
            },
          },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const second = await poll();

    expect(second.pulls[0].ci).toMatchObject({
      passed: 1,
      running: 1,
      total: 2,
    });
    expect(
      graphql.mock.calls.filter(([document]) => document === PULL_QUERY),
    ).toHaveLength(1);
    expect(
      graphql.mock.calls.filter(([document]) => document === CI_QUERY),
    ).toHaveLength(1);
  });

  it("invalidates cached successful CI when a changed fingerprint cannot be hydrated", async () => {
    let polls = 0;
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const statusCheckRollup =
          polls === 1
            ? { commit: { oid: SHA }, state: "SUCCESS" }
            : { commit: { oid: SHA }, state: "FAILURE" };
        return search([pollNode(1, { statusCheckRollup })]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: { pullRequest: node(1) },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) throw new Error("temporary CI failure");
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const changed = await poll();

    expect(changed).toMatchObject({ partial: false });
    expect(changed.warnings).not.toHaveLength(0);
    expect(changed.pulls[0].ci).toMatchObject({
      complete: false,
      failed: 1,
      state: "unknown",
    });
  });

  it("invalidates cached evidence when the CI refresh observes a newer head", async () => {
    let polls = 0;
    const pending = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1, { conclusion: null, status: "IN_PROGRESS" }),
      ]),
      state: "PENDING",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        return search([pollNode(1, { statusCheckRollup: pending })]);
      }
      if (document === PULL_QUERY) {
        if (polls > 1) throw new Error("temporary exact-load failure");
        return {
          repository: { pullRequest: node(1, { statusCheckRollup: pending }) },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) {
        return {
          repository: {
            pullRequest: {
              headRefOid: NEXT_SHA,
              state: "OPEN",
              statusCheckRollup: {
                commit: { oid: NEXT_SHA },
                contexts: contexts([checkRun(1)]),
                state: "SUCCESS",
              },
            },
          },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const changed = await poll();

    expect(changed).toMatchObject({ partial: false });
    expect(changed.warnings).not.toHaveLength(0);
    expect(changed.pulls[0]).toMatchObject({
      commentsComplete: false,
      headRefOid: NEXT_SHA,
      threadsComplete: false,
    });
    expect(changed.pulls[0].ci).toMatchObject({
      complete: false,
      state: "unknown",
    });
  });

  it("refreshes failed CI within one poll interval and detects newly running checks", async () => {
    let now = 0;
    let polls = 0;
    const failedRollup = {
      commit: { oid: SHA },
      contexts: contexts([checkRun(1, { conclusion: "FAILURE" })]),
      state: "FAILURE",
    };
    const failedAndRunningRollup = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1, { conclusion: "FAILURE" }),
        checkRun(2, { conclusion: null, status: "IN_PROGRESS" }),
      ]),
      state: "FAILURE",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const statusCheckRollup =
          polls > 2 ? failedAndRunningRollup : failedRollup;
        return search([pollNode(1, { statusCheckRollup })]);
      }
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, { statusCheckRollup: failedRollup }),
          },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) {
        return {
          repository: {
            pullRequest: {
              headRefOid: SHA,
              state: "OPEN",
              statusCheckRollup: failedAndRunningRollup,
            },
          },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql, now: () => now });

    await poll();
    await poll();
    expect(
      graphql.mock.calls.filter(([document]) => document === CI_QUERY),
    ).toHaveLength(0);
    expect(FAILURE_REFRESH_INTERVAL).toBe(120_000);
    now = 10_000;
    const second = await poll();

    expect(second.pulls[0].ci).toMatchObject({
      failed: 1,
      passed: 0,
      running: 1,
      total: 2,
    });
    expect(
      second.pulls[0].ci.checks.find(({ state }) => state === "failure")?.name,
    ).toBe("Check 1");
  });

  it("fully hydrates a CI promotion and catches a hidden reopened thread before readiness", async () => {
    let polls = 0;
    let fullLoads = 0;
    const comment = summaryComment(1);
    const pendingRollup = {
      commit: { oid: SHA },
      contexts: contexts([
        checkRun(1, { conclusion: null, status: "IN_PROGRESS" }),
      ]),
      state: "PENDING",
    };
    const successRollup = {
      commit: { oid: SHA },
      contexts: contexts([checkRun(1)]),
      state: "SUCCESS",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        const statusCheckRollup = polls > 1 ? successRollup : pendingRollup;
        return search([
          pollNode(1, {
            comments: { nodes: [comment], pageInfo: pageInfo() },
            reviewThreads: {
              nodes: [thread(1, { resolved: true })],
              pageInfo: pageInfo(),
            },
            statusCheckRollup,
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        const current = thread(1, { resolved: true });
        return {
          nodes: [
            threadEvidence(current),
            issueCommentEvidence(comment),
            reviewCommentEvidence(current.comments.nodes[0]),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [comment], pageInfo: pageInfo() },
              reviewThreads: {
                nodes: [thread(1, { resolved: fullLoads === 1 })],
                pageInfo: pageInfo(),
              },
              statusCheckRollup:
                fullLoads === 1 ? pendingRollup : successRollup,
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      ci: { state: "pending" },
      ready: false,
      unresolved: 0,
    });
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      ci: { state: "success" },
      ready: false,
      unresolved: 1,
    });
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.filter(([document]) => document === CI_QUERY),
    ).toHaveLength(0);
    expect(
      graphql.mock.calls.filter(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      ),
    ).toHaveLength(1);
  });

  it("fully hydrates successful CI after degraded evidence before restoring readiness", async () => {
    let polls = 0;
    let fullLoads = 0;
    const comment = summaryComment(1);
    const success = (count) => ({
      commit: { oid: SHA },
      contexts: contexts(
        Array.from({ length: count }, (_, index) => checkRun(index + 1)),
      ),
      state: "SUCCESS",
    });
    const firstRollup = success(1);
    const indexedRollup = success(2);
    const racedRollup = success(3);
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        polls += 1;
        return search([
          pollNode(1, {
            comments: { nodes: [comment], pageInfo: pageInfo() },
            reviewThreads: {
              nodes: [thread(1, { resolved: true })],
              pageInfo: pageInfo(),
            },
            statusCheckRollup: polls === 1 ? firstRollup : indexedRollup,
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        const current = thread(1, { resolved: true });
        return {
          nodes: [
            threadEvidence(current),
            issueCommentEvidence(comment),
            reviewCommentEvidence(current.comments.nodes[0]),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [comment], pageInfo: pageInfo() },
              reviewThreads: {
                nodes: [thread(1, { resolved: fullLoads === 1 })],
                pageInfo: pageInfo(),
              },
              statusCheckRollup: fullLoads === 1 ? firstRollup : indexedRollup,
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      if (document === CI_QUERY) {
        return {
          repository: {
            pullRequest: {
              headRefOid: SHA,
              state: "OPEN",
              statusCheckRollup: racedRollup,
            },
          },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1).ready).toBe(true);
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      ci: { complete: false, state: "unknown" },
      ready: false,
    });
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      ci: { state: "success" },
      ready: false,
      unresolved: 1,
    });
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.filter(([document]) => document === CI_QUERY),
    ).toHaveLength(1);
    expect(
      graphql.mock.calls.filter(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      ),
    ).toHaveLength(2);
  });

  it("probes unchanged non-ready evidence without rehydrating when it has not changed", async () => {
    let fullLoads = 0;
    const current = thread(1);
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            reviewThreads: { nodes: [current], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return {
          nodes: [
            threadEvidence(current),
            reviewCommentEvidence(current.comments.nodes[0]),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              reviewThreads: {
                nodes: [current],
                pageInfo: pageInfo(),
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect((await poll()).pulls[0].unresolvedThreads).toHaveLength(1);
    expect((await poll()).pulls[0].unresolvedThreads).toHaveLength(1);
    expect(fullLoads).toBe(1);
    expect(
      graphql.mock.calls.filter(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      ),
    ).toHaveLength(1);
  });

  it("marks an unchanged non-ready pull incomplete when its evidence probe fails", async () => {
    const current = thread(1);
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            reviewThreads: { nodes: [current], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY)
        throw new Error("temporary evidence failure");
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, {
              reviewThreads: { nodes: [current], pageInfo: pageInfo() },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    await poll();
    const result = await poll();

    expect(result.warnings).toContain(
      "GitHub could not refresh cached pull request evidence; affected pull requests were marked incomplete.",
    );
    expect(result.pulls[0]).toMatchObject({
      commentsComplete: false,
      threadsComplete: false,
    });
    expect(
      graphql.mock.calls.filter(([document]) => document === PULL_QUERY),
    ).toHaveLength(1);
  });

  it("rehydrates an unchanged non-ready pull when an ordinary issue comment is edited", async () => {
    let fullLoads = 0;
    const original = {
      ...issueComment(1, "Please handle this edge case."),
      author: { login: "reviewer" },
    };
    const edited = {
      ...original,
      body: "Please handle this edge case and add a regression test.",
      updatedAt: "2026-07-17T01:00:00Z",
    };
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            comments: { nodes: [original], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return { nodes: [issueCommentEvidence(edited)] };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              comments: {
                nodes: [fullLoads === 1 ? original : edited],
                pageInfo: pageInfo(),
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect((await poll()).pulls[0].comments[0].body).toBe(original.body);
    expect((await poll()).pulls[0].comments[0].body).toBe(edited.body);
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.find(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      )?.[1].ids,
    ).toEqual(["comment-1"]);
  });

  it("rehydrates an unchanged non-ready pull when an existing review thread gets a reply", async () => {
    let fullLoads = 0;
    const root = reviewComment(1);
    const reply = {
      ...reviewComment(2, "The latest push still needs this change."),
      createdAt: "2026-07-17T01:00:00Z",
      updatedAt: "2026-07-17T01:00:00Z",
    };
    const original = thread(1, { comments: [root] });
    const replied = thread(1, { comments: [root, reply] });
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            reviewThreads: { nodes: [original], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return {
          nodes: [
            threadEvidence(original, { commentCount: 2 }),
            reviewCommentEvidence(root),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              reviewThreads: {
                nodes: [fullLoads === 1 ? original : replied],
                pageInfo: pageInfo(),
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect((await poll()).pulls[0].unresolvedThreads[0].comments).toHaveLength(
      1,
    );
    expect((await poll()).pulls[0].unresolvedThreads[0].comments).toHaveLength(
      2,
    );
    expect(fullLoads).toBe(2);
  });

  it("rehydrates an unchanged non-ready pull when a review comment is edited", async () => {
    let fullLoads = 0;
    const original = reviewComment(1, "Please cover the failure path.");
    const edited = {
      ...original,
      body: "Please cover both failure paths.",
      updatedAt: "2026-07-17T01:00:00Z",
    };
    const originalThread = thread(1, { comments: [original] });
    const editedThread = thread(1, { comments: [edited] });
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            reviewThreads: { nodes: [originalThread], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return {
          nodes: [
            threadEvidence(originalThread),
            reviewCommentEvidence(edited),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              reviewThreads: {
                nodes: [fullLoads === 1 ? originalThread : editedThread],
                pageInfo: pageInfo(),
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect((await poll()).pulls[0].unresolvedThreads[0].comments[0].body).toBe(
      original.body,
    );
    expect((await poll()).pulls[0].unresolvedThreads[0].comments[0].body).toBe(
      edited.body,
    );
    expect(fullLoads).toBe(2);
  });

  it("detects a reopened thread on a ready pull without relying on pull updatedAt or totalCount", async () => {
    let fullLoads = 0;
    const comment = summaryComment(1);
    const graphql = vi.fn(async (document, variables) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            comments: { nodes: [comment], pageInfo: pageInfo() },
            reviewThreads: {
              nodes: [thread(1, { resolved: true })],
              pageInfo: pageInfo(),
            },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        const current = thread(1, { resolved: false });
        return {
          nodes: [
            threadEvidence(current),
            issueCommentEvidence(comment),
            reviewCommentEvidence(current.comments.nodes[0]),
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [comment], pageInfo: pageInfo() },
              reviewThreads: {
                nodes: [thread(1, { resolved: fullLoads === 1 })],
                pageInfo: pageInfo(),
              },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1).ready).toBe(true);
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      ready: false,
      unresolved: 1,
    });
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.find(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      )?.[1].ids,
    ).toEqual(["thread-1", "comment-1", "review-comment-1"]);
  });

  it("demotes a ready pull when its targeted evidence probe fails", async () => {
    const comment = summaryComment(1);
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            comments: { nodes: [comment], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY)
        throw new Error("temporary evidence failure");
      if (document === PULL_QUERY) {
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [comment], pageInfo: pageInfo() },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1).ready).toBe(true);
    const changed = await poll();

    expect(changed.partial).toBe(false);
    expect(changed.warnings).not.toHaveLength(0);
    expect(assessPull(changed.pulls[0], 1).ready).toBe(false);
    expect(changed.pulls[0]).toMatchObject({
      commentsComplete: false,
      threadsComplete: false,
    });
    expect(
      graphql.mock.calls.filter(([document]) => document === PULL_QUERY),
    ).toHaveLength(1);
  });

  it("probes every Greptile comment and detects the selected summary edit on a ready pull", async () => {
    let fullLoads = 0;
    const historical = summaryComment(1, {
      confidence: 3,
      createdAt: "2026-07-16T00:00:00Z",
      updatedAt: "2026-07-18T00:00:00Z",
    });
    const graphql = vi.fn(async (document, variables) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            comments: {
              nodes: [historical, summaryComment(2)],
              pageInfo: pageInfo(),
            },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return {
          nodes: [
            {
              __typename: "IssueComment",
              id: "comment-1",
              updatedAt: historical.updatedAt,
            },
            {
              __typename: "IssueComment",
              id: "comment-2",
              updatedAt: "2026-07-17T01:00:00Z",
            },
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        const comment = summaryComment(2, {
          confidence: fullLoads > 1 ? 4 : 5,
          updatedAt:
            fullLoads > 1 ? "2026-07-17T01:00:00Z" : "2026-07-17T00:00:00Z",
        });
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [historical, comment], pageInfo: pageInfo() },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1).ready).toBe(true);
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      greptile: { confidence: 4 },
      ready: false,
    });
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.find(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      )?.[1].ids,
    ).toEqual(["comment-1", "comment-2"]);
  });

  it("detects when a newer Greptile comment is edited into the active summary", async () => {
    let fullLoads = 0;
    const active = summaryComment(1);
    const latent = issueComment(2, "Greptile review is still running.");
    latent.createdAt = "2026-07-17T01:00:00Z";
    latent.updatedAt = "2026-07-17T01:00:00Z";
    const graphql = vi.fn(async (document) => {
      if (document === POLL_QUERY) {
        return search([
          pollNode(1, {
            comments: { nodes: [active, latent], pageInfo: pageInfo() },
          }),
        ]);
      }
      if (document === EVIDENCE_STATES_QUERY) {
        return {
          nodes: [
            {
              __typename: "IssueComment",
              id: "comment-1",
              updatedAt: active.updatedAt,
            },
            {
              __typename: "IssueComment",
              id: "comment-2",
              updatedAt: "2026-07-17T02:00:00Z",
            },
          ],
        };
      }
      if (document === PULL_QUERY) {
        fullLoads += 1;
        const latest =
          fullLoads === 1
            ? latent
            : {
                ...latent,
                body: `Confidence Score: 2/5\nLast reviewed commit: ${SHA}`,
                updatedAt: "2026-07-17T02:00:00Z",
              };
        return {
          repository: {
            pullRequest: node(1, {
              comments: { nodes: [active, latest], pageInfo: pageInfo() },
            }),
          },
          viewer: { login: "viewer" },
        };
      }
      throw new Error("unexpected query");
    });
    const poll = createAuthoredPullPoller({ graphql });

    expect(assessPull((await poll()).pulls[0], 1).ready).toBe(true);
    expect(assessPull((await poll()).pulls[0], 1)).toMatchObject({
      greptile: { confidence: 2 },
      ready: false,
    });
    expect(fullLoads).toBe(2);
    expect(
      graphql.mock.calls.find(
        ([document]) => document === EVIDENCE_STATES_QUERY,
      )?.[1].ids,
    ).toEqual(["comment-1", "comment-2"]);
  });
});

describe("GitHub CLI adapter", () => {
  it("uses execFile without a shell and fixed GraphQL arguments", async () => {
    const executeFile = vi.fn((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ data: search([]) }));
    });
    const graphql = createGhGraphql({ executeFile });
    await graphql(OUTER_QUERY, { after: null, searchQuery: SEARCH_QUERY });
    const [file, args, options] = executeFile.mock.calls[0];
    expect(file).toBe("gh");
    expect(args).toContain(`query=${OUTER_QUERY}`);
    expect(args).toContain(`searchQuery=${SEARCH_QUERY}`);
    expect(options.maxBuffer).toBe(GRAPHQL_MAX_BUFFER);
    expect(options).not.toHaveProperty("shell");
  });

  it("forwards cancellation to the GraphQL process without remapping AbortError", async () => {
    const executeFile = vi.fn((_file, _args, options, callback) => {
      options.signal.addEventListener(
        "abort",
        () => callback(options.signal.reason, ""),
        {
          once: true,
        },
      );
    });
    const graphql = createGhGraphql({ executeFile });
    const controller = new AbortController();
    const reason = new DOMException("Client disconnected.", "AbortError");

    const pending = graphql(OUTER_QUERY, {}, { signal: controller.signal });
    const result = expect(pending).rejects.toBe(reason);
    controller.abort(reason);

    await result;
    expect(executeFile.mock.calls[0][2]).toMatchObject({
      maxBuffer: GRAPHQL_MAX_BUFFER,
      signal: controller.signal,
    });
  });

  it("rejects unknown documents and normalizes CLI errors without leaking details", async () => {
    const graphql = createGhGraphql({
      executeFile: (_file, _args, _options, callback) =>
        callback(Object.assign(new Error("ghp_secret"), { code: 1 }), ""),
    });
    await expect(graphql("query Unknown { viewer { login } }")).rejects.toThrow(
      "unknown GitHub query",
    );
    await expect(graphql(OUTER_QUERY)).rejects.toThrow("gh auth status");
    await expect(graphql(OUTER_QUERY)).rejects.not.toThrow("ghp_secret");
  });
});
