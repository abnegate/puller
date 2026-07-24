import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";

import { createExecutor, ExecutorError } from "./executor.mjs";
import { GREPTILE_LOGIN } from "./greptile.mjs";

export const SEARCH_QUERY =
  "is:pr author:@me state:open archived:false sort:updated-desc";
export const TARGET_SEARCH_QUERY = "is:pr author:@me state:open archived:false";
export const SEARCH_LIMIT = 1_000;
export const PAGE_SIZE = 100;
export const FAILURE_REFRESH_INTERVAL = 120_000;
export const GRAPHQL_MAX_BUFFER = 50 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const ACTIONS_JOB =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d{0,19})\/job\/([1-9]\d{0,19})$/;
const PULL_STATES = new Set(["CLOSED", "MERGED", "OPEN"]);

const CONTEXT_FIELDS = `
  checkRunCount
  checkRunCountsByState {
    count
    state
  }
  statusContextCount
  statusContextCountsByState {
    count
    state
  }
  nodes {
    __typename
    ... on CheckRun {
      id
      name
      status
      conclusion
      detailsUrl
      checkSuite {
        workflowRun {
          workflow {
            name
          }
        }
      }
    }
    ... on StatusContext {
      id
      context
      state
      targetUrl
    }
  }
  pageInfo {
    endCursor
    hasNextPage
  }
`;

const REVIEW_COMMENT_FIELDS = `
  id
  author {
    login
  }
  body
  createdAt
  updatedAt
  url
  path
  line
  outdated
`;

const THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  path
  line
  comments(first: 1) {
    totalCount
    nodes {
      ${REVIEW_COMMENT_FIELDS}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
`;

const ISSUE_COMMENT_FIELDS = `
  id
  author {
    login
  }
  body
  createdAt
  updatedAt
  url
`;

const PULL_FIELDS = `
  number
  title
  url
  updatedAt
  state
  author {
    login
  }
  baseRefOid
  headRefOid
  statusCheckRollup {
    state
    commit {
      oid
    }
    contexts(first: 100) {
      ${CONTEXT_FIELDS}
    }
  }
  repository {
    name
    nameWithOwner
    url
    owner {
      login
    }
  }
  reviewThreads(first: 100) {
    nodes {
      ${THREAD_FIELDS}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
  comments(first: 100) {
    nodes {
      ${ISSUE_COMMENT_FIELDS}
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
`;

export const OUTER_QUERY = `
  query AuthoredPulls($searchQuery: String!, $after: String) {
    viewer {
      login
    }
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          ${PULL_FIELDS}
        }
      }
    }
  }
`;

const POLL_FIELDS = `
  id
  number
  title
  url
  updatedAt
  state
  author {
    login
  }
  baseRefOid
  headRefOid
  statusCheckRollup {
    state
    commit {
      oid
    }
    contexts(first: 1) {
      checkRunCount
      checkRunCountsByState {
        count
        state
      }
      statusContextCount
      statusContextCountsByState {
        count
        state
      }
    }
  }
  repository {
    name
    nameWithOwner
    url
    owner {
      login
    }
  }
  reviewThreads(first: 100) {
    totalCount
    nodes {
      id
      isResolved
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
  comments(first: 100) {
    totalCount
    nodes {
      id
      author {
        login
      }
      updatedAt
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
`;

export const POLL_QUERY = `
  query AuthoredPullPoll($searchQuery: String!, $after: String) {
    viewer {
      login
    }
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          ${POLL_FIELDS}
        }
      }
    }
  }
`;

export const PULL_QUERY = `
  query AuthoredPull($owner: String!, $name: String!, $number: Int!) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${PULL_FIELDS}
      }
    }
  }
`;

const TARGET_PULL_FIELDS = `
  number
  url
  state
  author {
    login
  }
  baseRefOid
  headRefName
  headRefOid
  isCrossRepository
  headRepository {
    nameWithOwner
  }
  repository {
    nameWithOwner
    viewerPermission
  }
`;

export const TARGET_PULL_QUERY = `
  query TargetAuthoredPull(
    $owner: String!
    $name: String!
    $number: Int!
    $searchQuery: String!
    $after: String
  ) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${TARGET_PULL_FIELDS}
      }
    }
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          ${TARGET_PULL_FIELDS}
        }
      }
    }
  }
`;

export const TARGET_CHECKS_QUERY = `
  query TargetAuthoredPullChecks(
    $owner: String!
    $name: String!
    $number: Int!
    $searchQuery: String!
    $after: String
  ) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${TARGET_PULL_FIELDS}
        statusCheckRollup {
          state
          commit {
            oid
          }
          contexts(first: 100) {
            ${CONTEXT_FIELDS}
          }
        }
      }
    }
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          ${TARGET_PULL_FIELDS}
        }
      }
    }
  }
`;

export const TARGET_PULL_COMMITS_QUERY = `
  query TargetAuthoredPullCommits(
    $owner: String!
    $name: String!
    $number: Int!
    $searchQuery: String!
    $after: String
  ) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${TARGET_PULL_FIELDS}
        commits(first: 1) {
          totalCount
        }
      }
    }
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          ${TARGET_PULL_FIELDS}
        }
      }
    }
  }
`;

export const TARGET_CONTEXTS_QUERY = `
  query TargetPullContexts(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${TARGET_PULL_FIELDS}
        statusCheckRollup {
          state
          commit {
            oid
          }
          contexts(first: 100, after: $after) {
            ${CONTEXT_FIELDS}
          }
        }
      }
    }
  }
`;

export const CONTEXTS_QUERY = `
  query PullRequestContexts($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        statusCheckRollup {
          state
          commit {
            oid
          }
          contexts(first: 100, after: $after) {
            ${CONTEXT_FIELDS}
          }
        }
      }
    }
  }
`;

export const CI_QUERY = `
  query PullRequestCi($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        state
        statusCheckRollup {
          state
          commit {
            oid
          }
          contexts(first: 100) {
            ${CONTEXT_FIELDS}
          }
        }
      }
    }
  }
`;

export const EVIDENCE_STATES_QUERY = `
  query PullEvidenceStates($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequestReviewThread {
        id
        isResolved
        comments(first: 1) {
          totalCount
        }
      }
      ... on PullRequestReviewComment {
        id
        updatedAt
      }
    }
  }
`;

export const THREADS_QUERY = `
  query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 100, after: $after) {
          nodes {
            ${THREAD_FIELDS}
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

export const THREAD_COMMENTS_QUERY = `
  query PullRequestThreadComments($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        id
        comments(first: 100, after: $after) {
          nodes {
            ${REVIEW_COMMENT_FIELDS}
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

export const COMMENTS_QUERY = `
  query PullRequestComments($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        comments(first: 100, after: $after) {
          nodes {
            ${ISSUE_COMMENT_FIELDS}
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const DOCUMENTS = new Set([
  CI_QUERY,
  COMMENTS_QUERY,
  CONTEXTS_QUERY,
  EVIDENCE_STATES_QUERY,
  OUTER_QUERY,
  POLL_QUERY,
  PULL_QUERY,
  TARGET_CHECKS_QUERY,
  TARGET_CONTEXTS_QUERY,
  TARGET_PULL_COMMITS_QUERY,
  TARGET_PULL_QUERY,
  THREAD_COMMENTS_QUERY,
  THREADS_QUERY,
]);

const PASSED_CONCLUSIONS = new Map([
  ["NEUTRAL", "neutral"],
  ["SKIPPED", "skipped"],
  ["SUCCESS", "success"],
]);
const FAILED_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const QUEUED_STATUSES = new Set(["PENDING", "QUEUED", "REQUESTED", "WAITING"]);

export class GithubError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "GithubError";
  }
}

function mapExecutorError(error) {
  if (error?.name === "AbortError") return error;
  if (error instanceof GithubError) return error;
  if (!(error instanceof ExecutorError)) {
    return new GithubError(
      "GitHub CLI could not load pull requests. Run gh auth status, then gh auth login if needed.",
      { cause: error },
    );
  }

  if (error.code === "missing") {
    return new GithubError(
      "GitHub CLI is not installed. Install gh, then run gh auth login.",
      {
        cause: error,
      },
    );
  }
  if (error.code === "timeout") {
    return new GithubError(
      "The GitHub request timed out. Check your connection and try again.",
      { cause: error },
    );
  }
  if (error.code === "invalid_response") {
    return new GithubError(
      "GitHub CLI returned an unreadable response. Run gh auth status and try again.",
      { cause: error },
    );
  }
  if (error.code === "output_limit") {
    return new GithubError(
      "GitHub returned more data than this request can safely process.",
      {
        cause: error,
      },
    );
  }

  return new GithubError(
    "GitHub CLI could not load pull requests. Run gh auth status, then gh auth login if needed.",
    { cause: error },
  );
}

export function createGhGraphql({
  executeFile = execFile,
  executor,
  timeout = 30_000,
} = {}) {
  const adapter =
    executor ??
    createExecutor({
      executeFile,
      maxBuffer: GRAPHQL_MAX_BUFFER,
      timeout,
    });

  return async function graphql(document, variables = {}, { signal } = {}) {
    if (!DOCUMENTS.has(document)) {
      throw new GithubError("The server rejected an unknown GitHub query.");
    }

    try {
      return await adapter.graphql(document, variables, {
        maxBuffer: GRAPHQL_MAX_BUFFER,
        signal,
      });
    } catch (error) {
      throw mapExecutorError(error);
    }
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCursor(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeViewer(viewer) {
  return isRecord(viewer) &&
    typeof viewer.login === "string" &&
    viewer.login.length > 0
    ? viewer.login
    : null;
}

function normalizeActor(actor) {
  if (actor === null) return null;
  return isRecord(actor) &&
    typeof actor.login === "string" &&
    actor.login.length > 0
    ? actor.login
    : undefined;
}

function validTimestampPair(createdAt, updatedAt) {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  return !Number.isNaN(created) && !Number.isNaN(updated) && updated >= created;
}

function normalizeIssueComment(comment) {
  const author = normalizeActor(comment?.author);
  if (
    !isRecord(comment) ||
    author === undefined ||
    typeof comment.id !== "string" ||
    comment.id.length === 0 ||
    typeof comment.body !== "string" ||
    typeof comment.createdAt !== "string" ||
    typeof comment.updatedAt !== "string" ||
    !validTimestampPair(comment.createdAt, comment.updatedAt) ||
    typeof comment.url !== "string"
  ) {
    return null;
  }

  return {
    author,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    updatedAt: comment.updatedAt,
    url: comment.url,
  };
}

function normalizeReviewComment(comment) {
  const author = normalizeActor(comment?.author);
  if (
    !isRecord(comment) ||
    author === undefined ||
    typeof comment.id !== "string" ||
    comment.id.length === 0 ||
    typeof comment.body !== "string" ||
    typeof comment.createdAt !== "string" ||
    typeof comment.updatedAt !== "string" ||
    !validTimestampPair(comment.createdAt, comment.updatedAt) ||
    typeof comment.url !== "string" ||
    typeof comment.path !== "string" ||
    comment.path.length === 0 ||
    (comment.line !== null &&
      (!Number.isInteger(comment.line) || comment.line < 1)) ||
    typeof comment.outdated !== "boolean"
  ) {
    return null;
  }

  return {
    author,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    line: comment.line,
    outdated: comment.outdated,
    path: comment.path,
    updatedAt: comment.updatedAt,
    url: comment.url,
  };
}

function normalizeConnection(connection, normalizeNode) {
  const nodesValid = isRecord(connection) && Array.isArray(connection.nodes);
  const normalized = nodesValid ? connection.nodes.map(normalizeNode) : [];
  const identifiers = new Set();
  const nodes = [];
  let nodesReliable = nodesValid;
  for (const node of normalized) {
    if (node === null || identifiers.has(node.id)) {
      nodesReliable = false;
      continue;
    }
    identifiers.add(node.id);
    nodes.push(node);
  }
  const pageInfoValid =
    isRecord(connection?.pageInfo) &&
    typeof connection.pageInfo.hasNextPage === "boolean" &&
    (!connection.pageInfo.hasNextPage ||
      isCursor(connection.pageInfo.endCursor));
  const hasNext = pageInfoValid && connection.pageInfo.hasNextPage;

  return {
    cursor: hasNext ? connection.pageInfo.endCursor : null,
    hasNext,
    nodes,
    reliable: nodesReliable && pageInfoValid,
  };
}

function normalizeThread(thread) {
  const commentCount = nonNegativeCount(thread?.comments);
  if (
    !isRecord(thread) ||
    typeof thread.id !== "string" ||
    thread.id.length === 0 ||
    typeof thread.isResolved !== "boolean" ||
    typeof thread.isOutdated !== "boolean" ||
    typeof thread.path !== "string" ||
    thread.path.length === 0 ||
    (thread.line !== null &&
      (!Number.isInteger(thread.line) || thread.line < 1)) ||
    commentCount === null
  ) {
    return null;
  }

  const comments = normalizeConnection(thread.comments, normalizeReviewComment);
  return {
    commentCursor: comments.cursor,
    commentCount,
    commentIds: new Set(comments.nodes.map(({ id }) => id)),
    comments: comments.nodes,
    commentsHaveNext: comments.hasNext,
    commentsReliable: comments.reliable,
    id: thread.id,
    isOutdated: thread.isOutdated,
    isResolved: thread.isResolved,
    line: thread.line,
    path: thread.path,
  };
}

function unknownContext(node) {
  const name =
    typeof node?.name === "string"
      ? node.name
      : typeof node?.context === "string"
        ? node.context
        : "Unknown check";
  return {
    check: {
      detailsUrl: null,
      id: typeof node?.id === "string" ? node.id : "",
      name,
      state: "unknown",
      workflow: null,
    },
    id: typeof node?.id === "string" && node.id.length > 0 ? node.id : null,
    reliable: false,
    type: node?.__typename === "StatusContext" ? "status" : "check",
  };
}

function normalizeCheckRun(node) {
  if (
    typeof node.id !== "string" ||
    node.id.length === 0 ||
    typeof node.name !== "string" ||
    typeof node.status !== "string" ||
    (node.conclusion !== null && typeof node.conclusion !== "string") ||
    (node.detailsUrl !== null && typeof node.detailsUrl !== "string") ||
    !isRecord(node.checkSuite)
  ) {
    return unknownContext(node);
  }

  let workflow = null;
  if (node.checkSuite.workflowRun !== null) {
    if (
      !isRecord(node.checkSuite.workflowRun) ||
      !isRecord(node.checkSuite.workflowRun.workflow) ||
      typeof node.checkSuite.workflowRun.workflow.name !== "string"
    ) {
      return unknownContext(node);
    }
    workflow = node.checkSuite.workflowRun.workflow.name;
  }

  let state = "unknown";
  if (node.status === "COMPLETED") {
    state =
      PASSED_CONCLUSIONS.get(node.conclusion) ??
      (FAILED_CONCLUSIONS.has(node.conclusion) ? "failure" : "unknown");
  } else if (node.status === "IN_PROGRESS" && node.conclusion === null) {
    state = "in_progress";
  } else if (QUEUED_STATUSES.has(node.status) && node.conclusion === null) {
    state = "queued";
  }

  return {
    check: {
      detailsUrl: node.detailsUrl,
      id: node.id,
      name: node.name,
      state,
      workflow,
    },
    id: node.id,
    reliable: state !== "unknown",
    type: "check",
  };
}

function normalizeStatusContext(node) {
  if (
    typeof node.id !== "string" ||
    node.id.length === 0 ||
    typeof node.context !== "string" ||
    typeof node.state !== "string" ||
    (node.targetUrl !== null && typeof node.targetUrl !== "string")
  ) {
    return unknownContext(node);
  }

  const state =
    node.state === "SUCCESS"
      ? "success"
      : node.state === "ERROR" || node.state === "FAILURE"
        ? "failure"
        : node.state === "EXPECTED" || node.state === "PENDING"
          ? "queued"
          : "unknown";

  return {
    check: {
      detailsUrl: node.targetUrl,
      id: node.id,
      name: node.context,
      state,
      workflow: null,
    },
    id: node.id,
    reliable: state !== "unknown",
    type: "status",
  };
}

function normalizeContext(node) {
  if (!isRecord(node)) return unknownContext(node);
  if (node.__typename === "CheckRun") return normalizeCheckRun(node);
  if (node.__typename === "StatusContext") return normalizeStatusContext(node);
  return unknownContext(node);
}

function normalizeContexts(connection) {
  const nodesValid = isRecord(connection) && Array.isArray(connection.nodes);
  const contexts = nodesValid ? connection.nodes.map(normalizeContext) : [];
  const pageInfoValid =
    isRecord(connection?.pageInfo) &&
    typeof connection.pageInfo.hasNextPage === "boolean" &&
    (!connection.pageInfo.hasNextPage ||
      isCursor(connection.pageInfo.endCursor));
  const countsValid =
    Number.isInteger(connection?.checkRunCount) &&
    connection.checkRunCount >= 0 &&
    Number.isInteger(connection?.statusContextCount) &&
    connection.statusContextCount >= 0;
  const hasNext = pageInfoValid && connection.pageInfo.hasNextPage;

  return {
    checkRunCount: countsValid ? connection.checkRunCount : null,
    contexts,
    cursor: hasNext ? connection.pageInfo.endCursor : null,
    hasNext,
    reliable:
      nodesValid &&
      pageInfoValid &&
      countsValid &&
      contexts.every((context) => context.reliable),
    statusContextCount: countsValid ? connection.statusContextCount : null,
  };
}

function emptyCi(state, complete) {
  return {
    checks: [],
    complete,
    failed: 0,
    inProgress: 0,
    passed: 0,
    queued: 0,
    running: 0,
    state,
    total: 0,
    unknown: 0,
  };
}

function normalizeCi(rollup, headRefOid) {
  if (rollup === null) {
    return {
      ci: emptyCi("none", true),
      internal: null,
    };
  }

  const rollupValid =
    isRecord(rollup) &&
    typeof rollup.state === "string" &&
    isRecord(rollup.commit) &&
    typeof rollup.commit.oid === "string" &&
    SHA.test(rollup.commit.oid) &&
    rollup.commit.oid.toLowerCase() === headRefOid.toLowerCase();
  const page = normalizeContexts(rollup?.contexts);
  const internal = {
    checkRunCount: page.checkRunCount,
    contexts: [],
    cursor: page.cursor,
    hasNext: page.hasNext,
    ids: new Set(),
    reliable: rollupValid && page.reliable,
    rollupState: typeof rollup?.state === "string" ? rollup.state : null,
    statusContextCount: page.statusContextCount,
  };
  appendContexts(internal, page);

  return {
    ci: emptyCi("unknown", false),
    internal,
  };
}

function appendContexts(internal, page) {
  if (
    internal.checkRunCount !== page.checkRunCount ||
    internal.statusContextCount !== page.statusContextCount
  ) {
    internal.reliable = false;
  }
  internal.reliable &&= page.reliable;

  for (const context of page.contexts) {
    if (context.id === null || internal.ids.has(context.id)) {
      internal.reliable = false;
    } else {
      internal.ids.add(context.id);
    }
    internal.contexts.push(context);
  }
  internal.cursor = page.cursor;
  internal.hasNext = page.hasNext;
}

function stateForRollup(state) {
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "unknown";
}

function finalizeCi(internal) {
  if (internal === null) return emptyCi("none", true);

  const checks = [];
  const checkIds = new Set();
  let passed = 0;
  let failed = 0;
  let inProgress = 0;
  let queued = 0;
  let unknown = 0;
  let checkRuns = 0;
  let statusContexts = 0;

  for (const context of internal.contexts) {
    if (context.id !== null && !checkIds.has(context.id)) {
      checkIds.add(context.id);
      checks.push(context.check);
    }
    if (context.type === "check") checkRuns += 1;
    else statusContexts += 1;

    if (
      context.check.state === "success" ||
      context.check.state === "neutral" ||
      context.check.state === "skipped"
    ) {
      passed += 1;
    } else if (context.check.state === "failure") {
      failed += 1;
    } else if (context.check.state === "in_progress") {
      inProgress += 1;
    } else if (context.check.state === "queued") {
      queued += 1;
    } else {
      unknown += 1;
    }
  }

  const expected =
    internal.checkRunCount === null || internal.statusContextCount === null
      ? null
      : internal.checkRunCount + internal.statusContextCount;
  if (expected !== null && expected > internal.contexts.length) {
    unknown += expected - internal.contexts.length;
  }
  const running = inProgress + queued;
  const total = passed + failed + running + unknown;
  const countsMatch =
    expected !== null &&
    checkRuns === internal.checkRunCount &&
    statusContexts === internal.statusContextCount;
  let complete = internal.reliable && !internal.hasNext && countsMatch;

  let state =
    unknown > 0
      ? "unknown"
      : failed > 0
        ? "failure"
        : running > 0
          ? "pending"
          : "success";
  if (total === 0) {
    complete = false;
    state = "unknown";
  }
  if (complete && stateForRollup(internal.rollupState) !== state) {
    complete = false;
    state = "unknown";
  }
  if (!complete) state = "unknown";

  return {
    checks,
    complete,
    failed,
    inProgress,
    passed,
    queued,
    running,
    state,
    total,
    unknown,
  };
}

function isPull(node) {
  const author = normalizeActor(node?.author);
  return (
    isRecord(node) &&
    Number.isInteger(node.number) &&
    node.number > 0 &&
    typeof node.title === "string" &&
    typeof node.url === "string" &&
    typeof node.updatedAt === "string" &&
    PULL_STATES.has(node.state) &&
    typeof author === "string" &&
    typeof node.baseRefOid === "string" &&
    SHA.test(node.baseRefOid) &&
    typeof node.headRefOid === "string" &&
    SHA.test(node.headRefOid) &&
    isRecord(node.repository) &&
    typeof node.repository.name === "string" &&
    typeof node.repository.nameWithOwner === "string" &&
    typeof node.repository.url === "string" &&
    isRecord(node.repository.owner) &&
    typeof node.repository.owner.login === "string"
  );
}

function normalizePull(node) {
  const threads = normalizeConnection(node.reviewThreads, normalizeThread);
  const comments = normalizeConnection(node.comments, normalizeIssueComment);
  const ci = normalizeCi(node.statusCheckRollup, node.headRefOid);

  return {
    authorLogin: node.author.login,
    baseRefOid: node.baseRefOid,
    ci: ci.ci,
    ciInternal: ci.internal,
    commentCursor: comments.cursor,
    commentIds: new Set(comments.nodes.map(({ id }) => id)),
    comments: comments.nodes,
    commentsComplete: comments.reliable && !comments.hasNext,
    commentsHaveNext: comments.hasNext,
    commentsReliable: comments.reliable,
    headRefOid: node.headRefOid,
    name: node.repository.name,
    number: node.number,
    owner: node.repository.owner.login,
    repository: node.repository.nameWithOwner,
    repositoryUrl: node.repository.url,
    reviewThreads: threads.nodes,
    state: node.state,
    threadCursor: threads.cursor,
    threadIds: new Set(threads.nodes.map(({ id }) => id)),
    threadsComplete: threads.reliable && !threads.hasNext,
    threadsHaveNext: threads.hasNext,
    threadsReliable: threads.reliable,
    title: node.title,
    updatedAt: node.updatedAt,
    url: node.url,
  };
}

async function continueContexts(graphql, pull) {
  const internal = pull.ciInternal;
  if (internal === null) return;
  let cursor = internal.cursor;
  const seen = new Set([cursor]);

  try {
    while (internal.hasNext) {
      const data = await graphql(CONTEXTS_QUERY, {
        after: cursor,
        name: pull.name,
        number: pull.number,
        owner: pull.owner,
      });
      const exact = data.repository?.pullRequest;
      if (
        !isRecord(exact) ||
        exact.headRefOid?.toLowerCase() !== pull.headRefOid.toLowerCase() ||
        !isRecord(exact.statusCheckRollup) ||
        exact.statusCheckRollup.commit?.oid?.toLowerCase() !==
          pull.headRefOid.toLowerCase() ||
        exact.statusCheckRollup.state !== internal.rollupState
      ) {
        internal.reliable = false;
        break;
      }

      const page = normalizeContexts(exact.statusCheckRollup.contexts);
      appendContexts(internal, page);
      if (internal.hasNext) {
        if (seen.has(internal.cursor)) {
          internal.reliable = false;
          break;
        }
        seen.add(internal.cursor);
        cursor = internal.cursor;
      }
    }
  } catch {
    internal.reliable = false;
  }

  pull.ci = finalizeCi(internal);
}

async function continueThreads(graphql, pull) {
  let cursor = pull.threadCursor;
  const seen = new Set([cursor]);
  try {
    while (pull.threadsHaveNext) {
      const data = await graphql(THREADS_QUERY, {
        after: cursor,
        name: pull.name,
        number: pull.number,
        owner: pull.owner,
      });
      const exact = data.repository?.pullRequest;
      if (
        !isRecord(exact) ||
        exact.headRefOid?.toLowerCase() !== pull.headRefOid.toLowerCase()
      ) {
        pull.threadsReliable = false;
        break;
      }
      const connection = normalizeConnection(
        exact.reviewThreads,
        normalizeThread,
      );
      pull.threadsReliable &&= connection.reliable;
      for (const thread of connection.nodes) {
        if (pull.threadIds.has(thread.id)) {
          pull.threadsReliable = false;
          continue;
        }
        pull.threadIds.add(thread.id);
        pull.reviewThreads.push(thread);
      }
      pull.threadsHaveNext = connection.hasNext;
      pull.threadCursor = connection.cursor;
      if (connection.hasNext) {
        if (seen.has(connection.cursor)) {
          pull.threadsReliable = false;
          break;
        }
        seen.add(connection.cursor);
        cursor = connection.cursor;
      }
    }
  } catch {
    pull.threadsReliable = false;
  }

  for (const thread of pull.reviewThreads.filter(
    ({ isResolved }) => !isResolved,
  )) {
    let commentCursor = thread.commentCursor;
    const commentCursors = new Set([commentCursor]);
    try {
      while (thread.commentsHaveNext) {
        const data = await graphql(THREAD_COMMENTS_QUERY, {
          after: commentCursor,
          id: thread.id,
        });
        if (!isRecord(data.node) || data.node.id !== thread.id) {
          thread.commentsReliable = false;
          break;
        }
        const connection = normalizeConnection(
          data.node?.comments,
          normalizeReviewComment,
        );
        thread.commentsReliable &&= connection.reliable;
        for (const comment of connection.nodes) {
          if (thread.commentIds.has(comment.id)) {
            thread.commentsReliable = false;
            continue;
          }
          thread.commentIds.add(comment.id);
          thread.comments.push(comment);
        }
        thread.commentsHaveNext = connection.hasNext;
        thread.commentCursor = connection.cursor;
        if (connection.hasNext) {
          if (commentCursors.has(connection.cursor)) {
            thread.commentsReliable = false;
            break;
          }
          commentCursors.add(connection.cursor);
          commentCursor = connection.cursor;
        }
      }
    } catch {
      thread.commentsReliable = false;
    }
  }

  pull.threadsComplete =
    pull.threadsReliable &&
    !pull.threadsHaveNext &&
    pull.reviewThreads
      .filter(({ isResolved }) => !isResolved)
      .every(
        (thread) =>
          thread.commentsReliable &&
          !thread.commentsHaveNext &&
          thread.comments.length > 0,
      );
}

async function continueComments(graphql, pull) {
  let cursor = pull.commentCursor;
  const seen = new Set([cursor]);
  try {
    while (pull.commentsHaveNext) {
      const data = await graphql(COMMENTS_QUERY, {
        after: cursor,
        name: pull.name,
        number: pull.number,
        owner: pull.owner,
      });
      const exact = data.repository?.pullRequest;
      if (
        !isRecord(exact) ||
        exact.headRefOid?.toLowerCase() !== pull.headRefOid.toLowerCase()
      ) {
        pull.commentsReliable = false;
        break;
      }
      const connection = normalizeConnection(
        exact.comments,
        normalizeIssueComment,
      );
      pull.commentsReliable &&= connection.reliable;
      for (const comment of connection.nodes) {
        if (pull.commentIds.has(comment.id)) {
          pull.commentsReliable = false;
          continue;
        }
        pull.commentIds.add(comment.id);
        pull.comments.push(comment);
      }
      pull.commentsHaveNext = connection.hasNext;
      pull.commentCursor = connection.cursor;
      if (connection.hasNext) {
        if (seen.has(connection.cursor)) {
          pull.commentsReliable = false;
          break;
        }
        seen.add(connection.cursor);
        cursor = connection.cursor;
      }
    }
  } catch {
    pull.commentsReliable = false;
  }

  pull.commentsComplete = pull.commentsReliable && !pull.commentsHaveNext;
}

async function completePull(graphql, pull) {
  await Promise.all([
    continueComments(graphql, pull),
    continueContexts(graphql, pull),
    continueThreads(graphql, pull),
  ]);
  if (pull.ciInternal === null) pull.ci = finalizeCi(null);
}

function stripInternalFields(pull) {
  return {
    authorLogin: pull.authorLogin,
    baseRefOid: pull.baseRefOid,
    ci: pull.ci,
    comments: pull.comments,
    commentsComplete: pull.commentsComplete,
    headRefOid: pull.headRefOid,
    number: pull.number,
    repository: pull.repository,
    repositoryUrl: pull.repositoryUrl,
    reviewThreads: pull.reviewThreads.map(({ id, isResolved }) => ({
      id,
      isResolved,
    })),
    state: pull.state,
    threadsComplete: pull.threadsComplete,
    title: pull.title,
    unresolvedThreads: pull.reviewThreads
      .filter(({ isResolved }) => !isResolved)
      .flatMap((thread) => {
        const root = thread.comments[0];
        return root
          ? [
              {
                author: root.author,
                body: root.body,
                comments: thread.comments,
                createdAt: root.createdAt,
                id: thread.id,
                line: thread.line ?? root.line,
                outdated: thread.isOutdated || root.outdated,
                path: thread.path || root.path,
                url: root.url,
              },
            ]
          : [];
      }),
    updatedAt: pull.updatedAt,
    url: pull.url,
  };
}

function evidenceForPull(pull) {
  const threads = pull.reviewThreads.filter(({ isResolved }) => !isResolved);
  return {
    reviewComments: threads.flatMap((thread) =>
      thread.comments.map(({ id, updatedAt }) => ({ id, updatedAt })),
    ),
    reviewThreads: threads.map(({ commentCount, id, isResolved }) => ({
      commentCount,
      id,
      isResolved,
    })),
  };
}

function validSearch(search) {
  return (
    isRecord(search) &&
    Number.isInteger(search.issueCount) &&
    search.issueCount >= 0 &&
    Array.isArray(search.nodes) &&
    isRecord(search.pageInfo) &&
    typeof search.pageInfo.hasNextPage === "boolean" &&
    (!search.pageInfo.hasNextPage || isCursor(search.pageInfo.endCursor))
  );
}

export async function fetchAuthoredPulls({ graphql, maximum = SEARCH_LIMIT }) {
  const pulls = [];
  const warnings = [];
  const cursors = new Set();
  let after = null;
  let consumed = 0;
  let issueCount = null;
  let hasNextPage = true;
  let partial = false;
  let viewerLogin = null;

  const warn = (message) => {
    partial = true;
    if (!warnings.includes(message)) warnings.push(message);
  };

  while (hasNextPage && consumed < maximum) {
    const data = await graphql(OUTER_QUERY, {
      after,
      searchQuery: SEARCH_QUERY,
    });
    const pageViewer = normalizeViewer(data.viewer);
    if (pageViewer === null) {
      if (
        consumed === 0 &&
        validSearch(data.search) &&
        data.search.issueCount === 0 &&
        data.search.nodes.length === 0
      ) {
        viewerLogin = null;
      } else if (consumed === 0) {
        throw new GithubError("GitHub returned incomplete viewer identity.");
      } else {
        warn(
          "GitHub returned incomplete viewer identity during pagination; the snapshot is incomplete.",
        );
        break;
      }
    } else if (viewerLogin === null) viewerLogin = pageViewer;
    else if (viewerLogin.toLowerCase() !== pageViewer.toLowerCase()) {
      warn(
        "GitHub viewer identity changed during pagination; the snapshot is incomplete.",
      );
      break;
    }

    const search = data.search;
    if (!validSearch(search)) {
      if (consumed === 0)
        throw new GithubError(
          "GitHub returned an incomplete pull request search.",
        );
      warn(
        "GitHub returned malformed search pagination metadata; the snapshot is incomplete.",
      );
      break;
    }

    if (issueCount === null) issueCount = search.issueCount;
    else if (search.issueCount !== issueCount) {
      warn(
        "GitHub changed the reported search count during pagination; the snapshot may be incomplete.",
      );
      issueCount = Math.max(issueCount, search.issueCount);
    }

    const nodes = search.nodes.slice(0, maximum - consumed);
    consumed += nodes.length;
    for (const node of nodes) {
      if (!isPull(node)) {
        warn(
          "GitHub returned malformed search result nodes; some pull requests were skipped.",
        );
        continue;
      }
      if (node.state !== "OPEN") continue;
      const pull = normalizePull(node);
      await completePull(graphql, pull);
      pulls.push(stripInternalFields(pull));
    }

    if (consumed > issueCount) {
      warn(
        "GitHub returned more search result nodes than it reported; the snapshot may be inconsistent.",
      );
    }
    hasNextPage = search.pageInfo.hasNextPage;
    if (hasNextPage && search.nodes.length === 0) {
      warn("GitHub returned an empty search page before pagination completed.");
      break;
    }
    if (hasNextPage) {
      const cursor = search.pageInfo.endCursor;
      if (cursors.has(cursor)) {
        warn(
          "GitHub repeated a search cursor; pagination stopped to avoid a loop.",
        );
        break;
      }
      cursors.add(cursor);
      after = cursor;
    }
  }

  if (issueCount !== null && issueCount !== consumed && !hasNextPage) {
    warn(
      `GitHub reported ${issueCount.toLocaleString("en-US")} results but returned ${consumed.toLocaleString("en-US")}; the snapshot may be incomplete.`,
    );
  }
  if ((issueCount ?? 0) > maximum || (hasNextPage && consumed >= maximum)) {
    warn(
      `GitHub search is limited to the first ${maximum.toLocaleString("en-US")} results.`,
    );
  }

  return {
    partial,
    pulls,
    viewerLogin,
    warnings,
  };
}

function parseRepository(repository) {
  const match =
    typeof repository === "string" ? REPOSITORY.exec(repository) : null;
  if (!match)
    throw new TypeError("repository must be an owner/name identifier.");
  return { name: match[2], owner: match[1] };
}

export function targetSearchQuery(repository) {
  parseRepository(repository);
  return `${TARGET_SEARCH_QUERY} repo:${repository}`;
}

function normalizeTargetPull(node) {
  const authorLogin = normalizeActor(node?.author);
  if (
    !isRecord(node) ||
    !Number.isSafeInteger(node.number) ||
    node.number < 1 ||
    typeof node.url !== "string" ||
    typeof node.state !== "string" ||
    typeof authorLogin !== "string" ||
    typeof node.baseRefOid !== "string" ||
    !SHA.test(node.baseRefOid) ||
    typeof node.headRefName !== "string" ||
    node.headRefName.length === 0 ||
    typeof node.headRefOid !== "string" ||
    !SHA.test(node.headRefOid) ||
    typeof node.isCrossRepository !== "boolean" ||
    !isRecord(node.headRepository) ||
    typeof node.headRepository.nameWithOwner !== "string" ||
    !REPOSITORY.test(node.headRepository.nameWithOwner) ||
    !isRecord(node.repository) ||
    typeof node.repository.nameWithOwner !== "string" ||
    !REPOSITORY.test(node.repository.nameWithOwner) ||
    typeof node.repository.viewerPermission !== "string" ||
    node.repository.viewerPermission.length === 0
  ) {
    return null;
  }

  return {
    authorLogin,
    baseRefOid: node.baseRefOid.toLowerCase(),
    headRefName: node.headRefName,
    headRefOid: node.headRefOid.toLowerCase(),
    headRepository: node.headRepository.nameWithOwner,
    isCrossRepository: node.isCrossRepository,
    number: node.number,
    open: node.state === "OPEN",
    repository: node.repository.nameWithOwner,
    state: node.state,
    url: node.url,
    viewerPermission: node.repository.viewerPermission,
  };
}

function sameTargetPull(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.authorLogin.toLowerCase() === right.authorLogin.toLowerCase() &&
    left.baseRefOid === right.baseRefOid &&
    left.headRefName === right.headRefName &&
    left.headRefOid === right.headRefOid &&
    left.headRepository.toLowerCase() === right.headRepository.toLowerCase() &&
    left.isCrossRepository === right.isCrossRepository &&
    left.number === right.number &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.state === right.state &&
    left.url.toLowerCase() === right.url.toLowerCase() &&
    left.viewerPermission === right.viewerPermission
  );
}

function isTargetSearch(search) {
  return (
    isRecord(search) &&
    Number.isInteger(search.issueCount) &&
    search.issueCount >= 0 &&
    Array.isArray(search.nodes) &&
    isRecord(search.pageInfo) &&
    typeof search.pageInfo.hasNextPage === "boolean" &&
    (!search.pageInfo.hasNextPage || isCursor(search.pageInfo.endCursor))
  );
}

function parseActionsJob(value, repository) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    const match = ACTIONS_JOB.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      match === null ||
      `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()
    ) {
      return null;
    }

    return {
      detailsUrl: `https://github.com/${match[1]}/${match[2]}/actions/runs/${match[3]}/job/${match[4]}`,
      jobId: match[4],
      runId: match[3],
    };
  } catch {
    return null;
  }
}

function failedChecks(internal, repository) {
  if (internal === null) return [];

  return internal.contexts.flatMap((context) => {
    if (context.type !== "check" || context.check.state !== "failure")
      return [];
    const identity = parseActionsJob(context.check.detailsUrl, repository);
    return identity === null
      ? []
      : [
          {
            ...identity,
            checkId: context.id,
            name: context.check.name,
          },
        ];
  });
}

function targetContextFingerprint(internal) {
  return JSON.stringify(
    internal.contexts
      .map((context) => [
        context.id,
        context.type,
        context.check.detailsUrl,
        context.check.name,
        context.check.state,
        context.check.workflow,
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function targetQuery(graphql, document, variables, signal) {
  return signal === undefined
    ? graphql(document, variables)
    : graphql(document, variables, { signal });
}

async function continueTargetChecks({
  graphql,
  identity,
  internal,
  name,
  number,
  owner,
  signal,
  viewerLogin,
}) {
  let cursor = internal.cursor;
  const cursors = new Set([cursor]);
  while (internal.hasNext) {
    const data = await targetQuery(
      graphql,
      TARGET_CONTEXTS_QUERY,
      {
        after: cursor,
        name,
        number,
        owner,
      },
      signal,
    );
    const currentViewer = normalizeViewer(data.viewer);
    const currentNode = data.repository?.pullRequest;
    const current = normalizeTargetPull(currentNode);
    if (
      currentViewer === null ||
      currentViewer.toLowerCase() !== viewerLogin.toLowerCase() ||
      !sameTargetPull(current, identity) ||
      !isRecord(currentNode.statusCheckRollup) ||
      typeof currentNode.statusCheckRollup.commit?.oid !== "string" ||
      currentNode.statusCheckRollup.commit.oid.toLowerCase() !==
        identity.headRefOid ||
      currentNode.statusCheckRollup.state !== internal.rollupState
    ) {
      internal.reliable = false;
      break;
    }

    const page = normalizeContexts(currentNode.statusCheckRollup.contexts);
    appendContexts(internal, page);
    if (internal.hasNext) {
      if (cursors.has(internal.cursor)) {
        internal.reliable = false;
        break;
      }
      cursors.add(internal.cursor);
      cursor = internal.cursor;
    }
  }

  return finalizeCi(internal);
}

async function reloadTargetChecks({
  graphql,
  identity,
  name,
  number,
  owner,
  rollupState,
  signal,
  viewerLogin,
}) {
  const data = await targetQuery(
    graphql,
    TARGET_CONTEXTS_QUERY,
    {
      after: null,
      name,
      number,
      owner,
    },
    signal,
  );
  const currentViewer = normalizeViewer(data.viewer);
  const currentNode = data.repository?.pullRequest;
  const current = normalizeTargetPull(currentNode);
  if (
    currentViewer === null ||
    currentViewer.toLowerCase() !== viewerLogin.toLowerCase() ||
    !sameTargetPull(current, identity) ||
    !isRecord(currentNode.statusCheckRollup) ||
    typeof currentNode.statusCheckRollup.commit?.oid !== "string" ||
    currentNode.statusCheckRollup.commit.oid.toLowerCase() !==
      identity.headRefOid ||
    currentNode.statusCheckRollup.state !== rollupState
  ) {
    return null;
  }

  const normalized = normalizeCi(
    currentNode.statusCheckRollup,
    identity.headRefOid,
  );
  if (normalized.internal === null) return null;
  const ci = await continueTargetChecks({
    graphql,
    identity,
    internal: normalized.internal,
    name,
    number,
    owner,
    signal,
    viewerLogin,
  });
  return { ci, internal: normalized.internal };
}

async function completeTargetChecks({
  graphql,
  identity,
  internal,
  name,
  number,
  owner,
  signal,
  viewerLogin,
}) {
  if (internal === null) {
    return { checksComplete: true, failedChecks: [] };
  }

  const paginated = internal.hasNext;
  const ci = await continueTargetChecks({
    graphql,
    identity,
    internal,
    name,
    number,
    owner,
    signal,
    viewerLogin,
  });
  if (!ci.complete) return { checksComplete: false, failedChecks: [] };

  if (paginated) {
    const current = await reloadTargetChecks({
      graphql,
      identity,
      name,
      number,
      owner,
      rollupState: internal.rollupState,
      signal,
      viewerLogin,
    });
    if (
      current === null ||
      !current.ci.complete ||
      targetContextFingerprint(current.internal) !==
        targetContextFingerprint(internal)
    ) {
      return { checksComplete: false, failedChecks: [] };
    }

    return {
      checksComplete: true,
      failedChecks: failedChecks(current.internal, identity.repository),
    };
  }

  return {
    checksComplete: true,
    failedChecks: failedChecks(internal, identity.repository),
  };
}

async function fetchTargetedPull({
  graphql,
  includeChecks,
  includeCommits = false,
  number,
  repository,
  signal,
}) {
  const { name, owner } = parseRepository(repository);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("number must be a positive integer.");
  }
  if (typeof graphql !== "function")
    throw new TypeError("graphql must be a function.");

  const document = includeChecks
    ? TARGET_CHECKS_QUERY
    : includeCommits
      ? TARGET_PULL_COMMITS_QUERY
      : TARGET_PULL_QUERY;
  const searchQuery = targetSearchQuery(repository);
  const cursors = new Set();
  let after = null;
  let authored = false;
  let complete = true;
  let consumed = 0;
  let exact = null;
  let exactCommitCount = null;
  let exactCommitCountObserved = false;
  let exactNode = null;
  let exactObserved = false;
  let issueCount = null;
  let viewerLogin = null;

  while (true) {
    const data = await targetQuery(
      graphql,
      document,
      {
        after,
        name,
        number,
        owner,
        searchQuery,
      },
      signal,
    );
    const pageViewer = normalizeViewer(data.viewer);
    if (pageViewer === null) {
      complete = false;
    } else if (viewerLogin === null) {
      viewerLogin = pageViewer;
    } else if (viewerLogin.toLowerCase() !== pageViewer.toLowerCase()) {
      complete = false;
    }

    const node = data.repository?.pullRequest;
    const normalized =
      node === null || data.repository === null
        ? null
        : normalizeTargetPull(node);
    if (node !== null && data.repository !== null && normalized === null)
      complete = false;
    if (!exactObserved) {
      exact = normalized;
      exactNode = node;
      exactObserved = true;
    } else if (!sameTargetPull(exact, normalized)) {
      complete = false;
    } else {
      exactNode = node;
    }
    if (includeCommits) {
      const commitCount = node?.commits?.totalCount;
      const valid = Number.isSafeInteger(commitCount) && commitCount >= 0;
      if (!valid) {
        complete = false;
      } else if (!exactCommitCountObserved) {
        exactCommitCount = commitCount;
        exactCommitCountObserved = true;
      } else if (exactCommitCount !== commitCount) {
        complete = false;
      }
    }

    const search = data.search;
    if (!isTargetSearch(search)) {
      complete = false;
      break;
    }
    if (issueCount === null) issueCount = search.issueCount;
    else if (issueCount !== search.issueCount) complete = false;

    const members = search.nodes.map(normalizeTargetPull);
    if (
      members.some((member) => member === null) ||
      members.some(
        (member) =>
          member !== null &&
          member.repository.toLowerCase() !== repository.toLowerCase(),
      )
    ) {
      complete = false;
    }
    consumed += search.nodes.length;
    if (consumed > issueCount) complete = false;

    const matches = members.filter(
      (member) =>
        member !== null &&
        member.number === number &&
        member.repository.toLowerCase() === repository.toLowerCase(),
    );
    if (matches.length > 1) complete = false;
    if (matches.length === 1) {
      authored = sameTargetPull(exact, matches[0]);
      if (!authored) complete = false;
      if (!search.pageInfo.hasNextPage && consumed !== issueCount)
        complete = false;
      break;
    }

    if (!search.pageInfo.hasNextPage) {
      if (consumed !== issueCount) complete = false;
      break;
    }
    if (search.nodes.length === 0 || cursors.has(search.pageInfo.endCursor)) {
      complete = false;
      break;
    }
    cursors.add(search.pageInfo.endCursor);
    after = search.pageInfo.endCursor;
  }

  const available = exact !== null;
  const result = {
    authored: authored && complete,
    authorLogin: exact?.authorLogin ?? null,
    available,
    baseRefOid: exact?.baseRefOid ?? null,
    complete: complete && viewerLogin !== null,
    headRefName: exact?.headRefName ?? null,
    headRefOid: exact?.headRefOid ?? null,
    headRepository: exact?.headRepository ?? null,
    isCrossRepository: exact?.isCrossRepository ?? null,
    number: exact?.number ?? number,
    open: exact?.open ?? false,
    repository: exact?.repository ?? repository,
    state: exact?.state ?? null,
    url: exact?.url ?? null,
    viewerLogin,
    viewerPermission: exact?.viewerPermission ?? null,
  };
  if (includeCommits) {
    return {
      ...result,
      commitCount: exactCommitCount,
      complete: result.complete && exactCommitCountObserved,
    };
  }
  if (!includeChecks) return result;

  if (!available || !authored || !result.complete) {
    return { ...result, checksComplete: false, failedChecks: [] };
  }

  const normalized = normalizeCi(exactNode.statusCheckRollup, exact.headRefOid);
  const checks = await completeTargetChecks({
    graphql,
    identity: exact,
    internal: normalized.internal,
    name,
    number,
    owner,
    signal,
    viewerLogin,
  });
  return {
    ...result,
    complete: result.complete && checks.checksComplete,
    ...checks,
  };
}

export function fetchPullAuthorization({
  graphql,
  number,
  repository,
  signal,
}) {
  return fetchTargetedPull({
    graphql,
    includeChecks: false,
    number,
    repository,
    signal,
  });
}

export function fetchPullCommitsAuthorization({
  graphql,
  number,
  repository,
  signal,
}) {
  return fetchTargetedPull({
    graphql,
    includeChecks: false,
    includeCommits: true,
    number,
    repository,
    signal,
  });
}

export function fetchCheckAuthorization({
  graphql,
  number,
  repository,
  signal,
}) {
  return fetchTargetedPull({
    graphql,
    includeChecks: true,
    number,
    repository,
    signal,
  });
}

async function fetchExactPull({ graphql, number, repository }) {
  const { name, owner } = parseRepository(repository);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("number must be a positive integer.");
  }

  const data = await graphql(PULL_QUERY, { name, number, owner });
  const viewerLogin = normalizeViewer(data.viewer);
  if (viewerLogin === null)
    throw new GithubError("GitHub returned incomplete viewer identity.");
  const node = data.repository?.pullRequest;
  if (node === null || data.repository === null) {
    return {
      authorLogin: null,
      available: false,
      baseRefOid: null,
      ciFingerprint: null,
      complete: true,
      evidence: null,
      evidenceFingerprint: null,
      headRefOid: null,
      number,
      open: false,
      pull: null,
      repository,
      repositoryUrl: null,
      state: null,
      url: null,
      viewerLogin,
    };
  }
  if (!isPull(node)) {
    return {
      authorLogin: null,
      available: true,
      baseRefOid: null,
      ciFingerprint: null,
      complete: false,
      evidence: null,
      evidenceFingerprint: null,
      headRefOid: null,
      number,
      open: false,
      pull: null,
      repository,
      repositoryUrl: null,
      state: null,
      url: null,
      viewerLogin,
    };
  }

  const pull = normalizePull(node);
  await completePull(graphql, pull);
  const normalized = stripInternalFields(pull);
  const sameRepository =
    pull.repository.toLowerCase() === repository.toLowerCase();
  const sameNumber = pull.number === number;
  const complete =
    sameRepository &&
    sameNumber &&
    pull.ci.complete &&
    pull.commentsComplete &&
    pull.threadsComplete;

  return {
    authorLogin: pull.authorLogin,
    available: true,
    baseRefOid: pull.baseRefOid,
    ciFingerprint: normalizePollRollup(node.statusCheckRollup, node.headRefOid),
    complete,
    evidence: evidenceForPull(pull),
    evidenceFingerprint: compactEvidenceFingerprint(
      pull.comments,
      pull.reviewThreads,
    ),
    headRefOid: pull.headRefOid,
    number: pull.number,
    open: pull.state === "OPEN",
    pull: normalized,
    repository: pull.repository,
    repositoryUrl: pull.repositoryUrl,
    state: pull.state,
    url: pull.url,
    viewerLogin,
  };
}

function nonNegativeCount(connection) {
  return isRecord(connection) &&
    Number.isSafeInteger(connection.totalCount) &&
    connection.totalCount >= 0
    ? connection.totalCount
    : null;
}

function validPollPageInfo(pageInfo) {
  return (
    isRecord(pageInfo) &&
    typeof pageInfo.hasNextPage === "boolean" &&
    (pageInfo.endCursor === null || isCursor(pageInfo.endCursor)) &&
    (!pageInfo.hasNextPage || isCursor(pageInfo.endCursor))
  );
}

function normalizePollConnection(connection, normalizeNode) {
  const totalCount = nonNegativeCount(connection);
  const nodesValid = isRecord(connection) && Array.isArray(connection.nodes);
  const pageInfoValid = validPollPageInfo(connection?.pageInfo);
  const normalized = nodesValid ? connection.nodes.map(normalizeNode) : [];
  const identifiers = new Set();
  const nodes = [];
  let unique = nodesValid;

  for (const node of normalized) {
    if (node === null || identifiers.has(node.id)) {
      unique = false;
      continue;
    }
    identifiers.add(node.id);
    nodes.push(node);
  }

  const complete =
    totalCount !== null &&
    unique &&
    pageInfoValid &&
    connection.pageInfo.hasNextPage === false &&
    totalCount <= PAGE_SIZE &&
    nodes.length === totalCount;

  return { complete, nodes, totalCount };
}

function normalizePollIssueComment(comment) {
  const author = normalizeActor(comment?.author);
  if (
    !isRecord(comment) ||
    author === undefined ||
    typeof comment.id !== "string" ||
    comment.id.length === 0 ||
    typeof comment.updatedAt !== "string" ||
    Number.isNaN(Date.parse(comment.updatedAt))
  ) {
    return null;
  }

  return {
    author,
    id: comment.id,
    updatedAt: comment.updatedAt,
  };
}

function normalizePollThread(thread) {
  if (
    !isRecord(thread) ||
    typeof thread.id !== "string" ||
    thread.id.length === 0 ||
    typeof thread.isResolved !== "boolean"
  ) {
    return null;
  }

  return {
    id: thread.id,
    isResolved: thread.isResolved,
  };
}

function sortedFingerprint(items, normalize) {
  return items
    .map(normalize)
    .sort(([left], [right]) => left.localeCompare(right));
}

function compactEvidenceFingerprint(comments, threads) {
  return JSON.stringify([
    sortedFingerprint(comments, ({ author, id, updatedAt }) => [
      id,
      author,
      author === GREPTILE_LOGIN ? updatedAt : null,
    ]),
    sortedFingerprint(threads, ({ id, isResolved }) => [id, isResolved]),
  ]);
}

function normalizePollCounts(connection, countField, statesField) {
  const count = connection?.[countField];
  const states = connection?.[statesField];
  if (!Number.isInteger(count) || count < 0 || !Array.isArray(states))
    return null;

  const normalized = [];
  const observed = new Set();
  let total = 0;
  for (const item of states) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.count) ||
      item.count < 0 ||
      typeof item.state !== "string" ||
      item.state.length === 0 ||
      observed.has(item.state)
    ) {
      return null;
    }
    observed.add(item.state);
    normalized.push([item.state, item.count]);
    total += item.count;
  }
  if (total !== count) return null;

  normalized.sort(([left], [right]) => left.localeCompare(right));
  return [count, normalized];
}

function normalizePollRollup(rollup, headRefOid) {
  if (rollup === null) return "none";
  if (
    !isRecord(rollup) ||
    typeof rollup.state !== "string" ||
    !isRecord(rollup.commit) ||
    typeof rollup.commit.oid !== "string" ||
    !SHA.test(rollup.commit.oid) ||
    rollup.commit.oid.toLowerCase() !== headRefOid.toLowerCase()
  ) {
    return null;
  }

  const checkRuns = normalizePollCounts(
    rollup.contexts,
    "checkRunCount",
    "checkRunCountsByState",
  );
  const statuses = normalizePollCounts(
    rollup.contexts,
    "statusContextCount",
    "statusContextCountsByState",
  );
  if (checkRuns === null || statuses === null) return null;

  return `${rollup.state}:${rollup.commit.oid.toLowerCase()}:${JSON.stringify([checkRuns, statuses])}`;
}

function normalizePollPull(node) {
  if (!isPull(node) || typeof node.id !== "string" || node.id.length === 0) {
    return null;
  }

  const comments = normalizePollConnection(
    node.comments,
    normalizePollIssueComment,
  );
  const threads = normalizePollConnection(
    node.reviewThreads,
    normalizePollThread,
  );
  const ciFingerprint = normalizePollRollup(
    node.statusCheckRollup,
    node.headRefOid,
  );
  if (ciFingerprint === null) return null;

  const repository = node.repository.nameWithOwner;
  const evidenceComplete = comments.complete && threads.complete;
  const evidenceFingerprint = evidenceComplete
    ? compactEvidenceFingerprint(comments.nodes, threads.nodes)
    : null;
  const identityFingerprint = JSON.stringify([
    node.id,
    node.author.login,
    node.baseRefOid.toLowerCase(),
    node.headRefOid.toLowerCase(),
    node.number,
    repository,
    node.repository.url,
    node.state,
    node.title,
    node.updatedAt,
    node.url,
    comments.totalCount,
    threads.totalCount,
  ]);

  return {
    authorLogin: node.author.login,
    baseRefOid: node.baseRefOid.toLowerCase(),
    ciFingerprint,
    comments: comments.totalCount,
    evidenceComplete,
    evidenceFingerprint,
    headRefOid: node.headRefOid.toLowerCase(),
    id: node.id,
    identityFingerprint,
    name: node.repository.name,
    number: node.number,
    owner: node.repository.owner.login,
    repository,
    repositoryUrl: node.repository.url,
    state: node.state,
    threads: threads.totalCount,
    title: node.title,
    updatedAt: node.updatedAt,
    url: node.url,
  };
}

async function fetchPollIndex({ graphql, maximum }) {
  const pulls = [];
  const warnings = [];
  const cursors = new Set();
  const identities = new Set();
  let after = null;
  let consumed = 0;
  let issueCount = null;
  let hasNextPage = true;
  let partial = false;
  let viewerLogin = null;

  const warn = (message) => {
    partial = true;
    if (!warnings.includes(message)) warnings.push(message);
  };

  while (hasNextPage && consumed < maximum) {
    const data = await graphql(POLL_QUERY, {
      after,
      searchQuery: SEARCH_QUERY,
    });
    const pageViewer = normalizeViewer(data.viewer);
    const search = data.search;
    if (pageViewer === null) {
      if (
        consumed === 0 &&
        validSearch(search) &&
        search.issueCount === 0 &&
        search.nodes.length === 0
      ) {
        viewerLogin = null;
      } else if (consumed === 0) {
        throw new GithubError("GitHub returned incomplete viewer identity.");
      } else {
        warn(
          "GitHub returned incomplete viewer identity during pagination; the snapshot is incomplete.",
        );
        break;
      }
    } else if (viewerLogin === null) viewerLogin = pageViewer;
    else if (viewerLogin.toLowerCase() !== pageViewer.toLowerCase()) {
      warn(
        "GitHub viewer identity changed during pagination; the snapshot is incomplete.",
      );
      break;
    }

    if (!validSearch(search)) {
      if (consumed === 0)
        throw new GithubError(
          "GitHub returned an incomplete pull request search.",
        );
      warn(
        "GitHub returned malformed search pagination metadata; the snapshot is incomplete.",
      );
      break;
    }

    if (issueCount === null) issueCount = search.issueCount;
    else if (search.issueCount !== issueCount) {
      warn(
        "GitHub changed the reported search count during pagination; the snapshot may be incomplete.",
      );
      issueCount = Math.max(issueCount, search.issueCount);
    }

    const nodes = search.nodes.slice(0, maximum - consumed);
    consumed += nodes.length;
    for (const node of nodes) {
      const pull = normalizePollPull(node);
      if (pull === null) {
        warn(
          "GitHub returned malformed search result nodes; some pull requests were skipped.",
        );
        continue;
      }
      if (pull.state !== "OPEN") continue;
      const identity = `${pull.repository.toLowerCase()}#${pull.number}`;
      if (identities.has(identity)) {
        warn(
          "GitHub returned duplicate pull requests; duplicates were skipped.",
        );
        continue;
      }
      identities.add(identity);
      pulls.push(pull);
    }

    if (consumed > issueCount) {
      warn(
        "GitHub returned more search result nodes than it reported; the snapshot may be inconsistent.",
      );
    }
    hasNextPage = search.pageInfo.hasNextPage;
    if (hasNextPage && search.nodes.length === 0) {
      warn("GitHub returned an empty search page before pagination completed.");
      break;
    }
    if (hasNextPage) {
      const cursor = search.pageInfo.endCursor;
      if (cursors.has(cursor)) {
        warn(
          "GitHub repeated a search cursor; pagination stopped to avoid a loop.",
        );
        break;
      }
      cursors.add(cursor);
      after = cursor;
    }
  }

  if (issueCount !== null && issueCount !== consumed && !hasNextPage) {
    warn(
      `GitHub reported ${issueCount.toLocaleString("en-US")} results but returned ${consumed.toLocaleString("en-US")}; the snapshot may be incomplete.`,
    );
  }
  if ((issueCount ?? 0) > maximum || (hasNextPage && consumed >= maximum)) {
    warn(
      `GitHub search is limited to the first ${maximum.toLocaleString("en-US")} results.`,
    );
  }

  return { partial, pulls, viewerLogin, warnings };
}

function matchesIndexedPull(exact, indexed) {
  if (!exact?.pull || !indexed) return false;

  return (
    exact.authorLogin === indexed.authorLogin &&
    exact.baseRefOid?.toLowerCase() === indexed.baseRefOid &&
    exact.ciFingerprint === indexed.ciFingerprint &&
    exact.headRefOid?.toLowerCase() === indexed.headRefOid &&
    exact.number === indexed.number &&
    exact.repository?.toLowerCase() === indexed.repository.toLowerCase() &&
    exact.repositoryUrl?.toLowerCase() ===
      indexed.repositoryUrl.toLowerCase() &&
    exact.state === indexed.state &&
    exact.url?.toLowerCase() === indexed.url.toLowerCase() &&
    exact.pull.title === indexed.title &&
    exact.pull.updatedAt === indexed.updatedAt &&
    exact.pull.commentsComplete === true &&
    exact.pull.threadsComplete === true &&
    (indexed.evidenceComplete !== true ||
      (exact.pull.comments.length === indexed.comments &&
        exact.pull.reviewThreads.length === indexed.threads &&
        exact.evidenceFingerprint === indexed.evidenceFingerprint))
  );
}

export async function fetchPull({ graphql, number, repository }) {
  parseRepository(repository);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("number must be a positive integer.");
  }

  const index = await fetchPollIndex({ graphql, maximum: SEARCH_LIMIT });
  const indexed = index.pulls.find(
    (pull) =>
      pull.repository.toLowerCase() === repository.toLowerCase() &&
      pull.number === number,
  );
  const exact = await fetchExactPull({ graphql, number, repository });
  const sameViewer =
    index.viewerLogin !== null &&
    exact.viewerLogin !== null &&
    index.viewerLogin.toLowerCase() === exact.viewerLogin.toLowerCase();
  const memberMatches = sameViewer && matchesIndexedPull(exact, indexed);
  const membershipComplete =
    sameViewer && !index.partial && (indexed ? memberMatches : true);

  return {
    ...exact,
    authored: Boolean(indexed && memberMatches && !index.partial),
    complete: exact.complete && membershipComplete,
  };
}

export async function fetchPullCi({ graphql, number, repository }) {
  const { name, owner } = parseRepository(repository);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("number must be a positive integer.");
  }

  const data = await graphql(CI_QUERY, { name, number, owner });
  const node = data.repository?.pullRequest;
  if (node === null || data.repository === null) {
    return {
      available: false,
      ci: null,
      ciFingerprint: null,
      headRefOid: null,
      open: false,
    };
  }
  if (
    !isRecord(node) ||
    typeof node.headRefOid !== "string" ||
    !SHA.test(node.headRefOid) ||
    typeof node.state !== "string"
  ) {
    throw new GithubError(
      "GitHub returned incomplete pull request CI evidence.",
    );
  }

  const normalized = normalizeCi(node.statusCheckRollup, node.headRefOid);
  const pull = {
    ci: normalized.ci,
    ciInternal: normalized.internal,
    headRefOid: node.headRefOid,
    name,
    number,
    owner,
  };
  await continueContexts(graphql, pull);
  if (pull.ciInternal === null) pull.ci = finalizeCi(null);

  return {
    available: true,
    ci: pull.ci,
    ciFingerprint: normalizePollRollup(node.statusCheckRollup, node.headRefOid),
    headRefOid: node.headRefOid,
    open: node.state === "OPEN",
  };
}

function cacheKey(pull) {
  return `${pull.repository.toLowerCase()}#${pull.number}`;
}

function refreshesCi(entry, now, failureRefreshInterval) {
  const ci = entry.pull.ci;
  return (
    ci?.complete !== true ||
    ci.state === "pending" ||
    ci.state === "unknown" ||
    ci.running > 0 ||
    (ci.state === "failure" &&
      now - entry.ciRefreshedAt >= failureRefreshInterval)
  );
}

function successfulCiFingerprint(fingerprint) {
  return fingerprint === "none" || fingerprint?.startsWith("SUCCESS:") === true;
}

function promotesCi(entry, pull) {
  if (!successfulCiFingerprint(pull.ciFingerprint)) return false;

  const cached = entry.pull.ci;
  const cachedSuccessful =
    cached?.complete === true &&
    (cached.state === "success" || cached.state === "none");
  return (
    !cachedSuccessful ||
    (entry.ciFingerprint !== pull.ciFingerprint &&
      !successfulCiFingerprint(entry.ciFingerprint))
  );
}

async function mapConcurrent(values, task) {
  if (values.length === 0) return [];
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(availableParallelism(), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function changedEvidence(graphql, entries) {
  const expected = new Map();
  const unavailable = new Set();
  const add = (id, evidence) => {
    if (typeof id !== "string" || id.length === 0) {
      unavailable.add(evidence.key);
      return;
    }
    const duplicate = expected.get(id);
    if (duplicate) {
      unavailable.add(duplicate.key);
      unavailable.add(evidence.key);
      return;
    }
    expected.set(id, evidence);
  };

  for (const [key, entry] of entries) {
    for (const thread of entry.evidence?.reviewThreads ?? []) {
      add(thread.id, {
        commentCount: thread.commentCount,
        isResolved: thread.isResolved,
        key,
        type: "PullRequestReviewThread",
      });
    }
    for (const comment of entry.evidence?.reviewComments ?? []) {
      add(comment.id, {
        key,
        type: "PullRequestReviewComment",
        updatedAt: comment.updatedAt,
      });
    }
  }
  if (expected.size === 0)
    return { changed: new Set(), unavailable };

  const changed = new Set();
  const identifiers = [...expected]
    .filter(([, evidence]) => !unavailable.has(evidence.key))
    .map(([id]) => id);
  for (let offset = 0; offset < identifiers.length; offset += PAGE_SIZE) {
    const ids = identifiers.slice(offset, offset + PAGE_SIZE);
    let data;
    try {
      data = await graphql(EVIDENCE_STATES_QUERY, { ids });
    } catch {
      for (const id of ids) unavailable.add(expected.get(id).key);
      continue;
    }

    const nodes = data?.nodes;
    const requested = new Set(ids);
    const observed = new Map();
    const malformed =
      !Array.isArray(nodes) ||
      nodes.length !== ids.length ||
      nodes.some((node) => {
        if (node === null) return false;
        if (
          !isRecord(node) ||
          typeof node.id !== "string" ||
          !requested.has(node.id) ||
          observed.has(node.id)
        ) {
          return true;
        }
        observed.set(node.id, node);
        return false;
      });
    if (malformed) {
      for (const id of ids) unavailable.add(expected.get(id).key);
      continue;
    }

    for (const id of ids) {
      const evidence = expected.get(id);
      const node = observed.get(id) ?? null;
      if (node === null || node.__typename !== evidence.type) {
        changed.add(evidence.key);
        continue;
      }

      if (evidence.type === "PullRequestReviewThread") {
        const commentCount = nonNegativeCount(node.comments);
        if (
          typeof node.isResolved !== "boolean" ||
          commentCount === null
        ) {
          unavailable.add(evidence.key);
        } else if (
          node.isResolved !== evidence.isResolved ||
          commentCount !== evidence.commentCount
        ) {
          changed.add(evidence.key);
        }
      } else if (
        typeof node.updatedAt !== "string" ||
        Number.isNaN(Date.parse(node.updatedAt))
      ) {
        unavailable.add(evidence.key);
      } else if (node.updatedAt !== evidence.updatedAt) {
        changed.add(evidence.key);
      }
    }
  }
  return { changed, unavailable };
}

function incompleteCi(pull) {
  if (pull.ciFingerprint === "none") return emptyCi("none", true);

  const state = pull.ciFingerprint.split(":", 1)[0];
  return {
    checks: [],
    complete: false,
    failed: state === "FAILURE" || state === "ERROR" ? 1 : 0,
    inProgress: 0,
    passed: state === "SUCCESS" ? 1 : 0,
    queued: state === "PENDING" || state === "EXPECTED" ? 1 : 0,
    running: state === "PENDING" || state === "EXPECTED" ? 1 : 0,
    state: "unknown",
    total: 1,
    unknown: ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"].includes(
      state,
    )
      ? 0
      : 1,
  };
}

function degradedPull(pull, entry, { ciOnly = false } = {}) {
  const previous = entry?.pull;
  const ci =
    previous &&
    previous.headRefOid.toLowerCase() === pull.headRefOid &&
    entry.ciFingerprint === pull.ciFingerprint
      ? previous.ci
      : incompleteCi(pull);

  if (ciOnly && previous) {
    return { ...previous, ci: incompleteCi(pull) };
  }

  return {
    authorLogin: pull.authorLogin,
    baseRefOid: pull.baseRefOid,
    ci,
    comments: previous?.comments ?? [],
    commentsComplete: false,
    headRefOid: pull.headRefOid,
    number: pull.number,
    repository: pull.repository,
    repositoryUrl: pull.repositoryUrl,
    reviewThreads: previous?.reviewThreads ?? [],
    state: pull.state,
    threadsComplete: false,
    title: pull.title,
    unresolvedThreads: previous?.unresolvedThreads ?? [],
    updatedAt: pull.updatedAt,
    url: pull.url,
  };
}

function degradedEntry(pull, entry, options) {
  return {
    ciFingerprint: entry?.ciFingerprint ?? null,
    ciRefreshedAt: entry?.ciRefreshedAt ?? Number.NEGATIVE_INFINITY,
    evidence: entry?.evidence ?? null,
    evidenceFingerprint: entry?.evidenceFingerprint ?? null,
    identityFingerprint: entry?.identityFingerprint ?? "",
    needsFull: options?.ciOnly !== true,
    pull: degradedPull(pull, entry, options),
  };
}

export function createAuthoredPullPoller({
  failureRefreshInterval = FAILURE_REFRESH_INTERVAL,
  graphql,
  now = Date.now,
}) {
  if (!Number.isFinite(failureRefreshInterval) || failureRefreshInterval < 0) {
    throw new TypeError(
      "failureRefreshInterval must be a non-negative duration.",
    );
  }
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  let cached = new Map();
  let cachedViewer = null;

  return async function loadAuthoredPulls({ maximum = SEARCH_LIMIT } = {}) {
    const index = await fetchPollIndex({ graphql, maximum });
    const checkedAt = now();
    if (
      cachedViewer !== null &&
      index.viewerLogin !== null &&
      cachedViewer.toLowerCase() !== index.viewerLogin.toLowerCase()
    ) {
      cached = new Map();
    }
    cachedViewer = index.viewerLogin;

    const partial = index.partial;
    const warnings = [...index.warnings];
    const warn = (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    };

    const indexed = new Map(index.pulls.map((pull) => [cacheKey(pull), pull]));
    const probeable = [...indexed].filter(([key, pull]) => {
      const entry = cached.get(key);
      return (
        entry?.needsFull !== true &&
        entry?.identityFingerprint === pull.identityFingerprint &&
        pull.evidenceComplete === true &&
        entry.evidenceFingerprint === pull.evidenceFingerprint &&
        !promotesCi(entry, pull)
      );
    });
    const { changed: evidenceChanges, unavailable: evidenceUnavailable } =
      await changedEvidence(
        graphql,
        probeable.map(([key]) => [key, cached.get(key)]),
      );
    if (evidenceUnavailable.size > 0) {
      warn(
        "GitHub could not refresh cached pull request evidence; affected pull requests were marked incomplete.",
      );
    }

    const full = [];
    const ci = [];
    for (const [key, pull] of indexed) {
      const entry = cached.get(key);
      if (
        entry === undefined ||
        entry.needsFull === true ||
        entry.identityFingerprint !== pull.identityFingerprint ||
        pull.evidenceComplete !== true ||
        entry.evidenceFingerprint !== pull.evidenceFingerprint ||
        evidenceChanges.has(key) ||
        promotesCi(entry, pull)
      ) {
        full.push([key, pull, evidenceUnavailable.has(key)]);
      } else if (evidenceUnavailable.has(key)) {
        full.push([key, pull, true]);
      } else if (
        entry.ciFingerprint !== pull.ciFingerprint ||
        refreshesCi(entry, checkedAt, failureRefreshInterval)
      ) {
        ci.push([key, pull]);
      }
    }

    const fullResults = await mapConcurrent(
      full,
      async ([key, pull, evidenceFailed]) => {
        if (evidenceFailed) return [key, degradedEntry(pull, cached.get(key))];
        try {
          const exact = await fetchExactPull({
            graphql,
            number: pull.number,
            repository: pull.repository,
          });
          if (!exact.available || !exact.open) {
            warn(
              `GitHub returned conflicting state for ${pull.repository}#${pull.number}; readiness was marked incomplete.`,
            );
            return [key, degradedEntry(pull, cached.get(key))];
          }
          if (
            exact.pull === null ||
            exact.viewerLogin.toLowerCase() !==
              index.viewerLogin.toLowerCase() ||
            !matchesIndexedPull(exact, pull)
          ) {
            warn(
              `GitHub returned incomplete evidence for ${pull.repository}#${pull.number}; the pull request was not updated.`,
            );
            return [key, degradedEntry(pull, cached.get(key))];
          }
          if (exact.complete !== true) {
            warn(
              `GitHub returned incomplete evidence for ${pull.repository}#${pull.number}.`,
            );
          }
          return [
            key,
            {
              ciFingerprint: pull.ciFingerprint,
              ciRefreshedAt: checkedAt,
              evidence: exact.evidence,
              evidenceFingerprint: pull.evidenceFingerprint,
              identityFingerprint: pull.identityFingerprint,
              needsFull: exact.complete !== true,
              pull: exact.pull,
            },
          ];
        } catch {
          warn(
            `GitHub could not refresh ${pull.repository}#${pull.number}; readiness was marked incomplete.`,
          );
          return [key, degradedEntry(pull, cached.get(key))];
        }
      },
    );

    const next = index.partial ? new Map(cached) : new Map();
    for (const [key, entry] of fullResults) {
      if (entry === null) next.delete(key);
      else next.set(key, entry);
    }

    const ciResults = await mapConcurrent(ci, async ([key, pull]) => {
      const entry = cached.get(key);
      let drift = null;
      try {
        const result = await fetchPullCi({
          graphql,
          number: pull.number,
          repository: pull.repository,
        });
        if (!result.available || !result.open) {
          warn(
            `GitHub returned conflicting CI state for ${pull.repository}#${pull.number}; readiness was marked incomplete.`,
          );
          return [key, degradedEntry(pull, entry)];
        }
        if (result.headRefOid.toLowerCase() !== pull.headRefOid) {
          const headRefOid = result.headRefOid.toLowerCase();
          drift = {
            ...pull,
            ciFingerprint: result.ciFingerprint ?? `UNKNOWN:${headRefOid}`,
            headRefOid,
          };
          const exact = await fetchExactPull({
            graphql,
            number: pull.number,
            repository: pull.repository,
          });
          if (!exact.available || !exact.open) {
            warn(
              `GitHub returned conflicting state for ${pull.repository}#${pull.number}; readiness was marked incomplete.`,
            );
            return [key, degradedEntry(drift, entry)];
          }
          if (
            exact.pull === null ||
            exact.viewerLogin.toLowerCase() !==
              index.viewerLogin.toLowerCase() ||
            !matchesIndexedPull(exact, pull)
          ) {
            throw new GithubError(
              "GitHub returned incomplete pull request evidence.",
            );
          }
          return [
            key,
            {
              ciFingerprint: pull.ciFingerprint,
              ciRefreshedAt: checkedAt,
              evidence: exact.evidence,
              evidenceFingerprint: pull.evidenceFingerprint,
              identityFingerprint: pull.identityFingerprint,
              needsFull: exact.complete !== true,
              pull: exact.pull,
            },
          ];
        }
        if (result.ciFingerprint !== pull.ciFingerprint) {
          warn(
            `GitHub changed CI while refreshing ${pull.repository}#${pull.number}; readiness was marked incomplete.`,
          );
          return [key, degradedEntry(pull, entry, { ciOnly: true })];
        }
        if (result.ci.complete !== true) {
          warn(
            `GitHub returned incomplete CI for ${pull.repository}#${pull.number}.`,
          );
        }
        return [
          key,
          {
            ciFingerprint: pull.ciFingerprint,
            ciRefreshedAt: checkedAt,
            evidence: entry.evidence,
            evidenceFingerprint: entry.evidenceFingerprint,
            identityFingerprint: pull.identityFingerprint,
            needsFull: false,
            pull: { ...entry.pull, ci: result.ci },
          },
        ];
      } catch {
        warn(
          `GitHub could not refresh CI for ${pull.repository}#${pull.number}.`,
        );
        if (drift) return [key, degradedEntry(drift, entry)];
        return [
          key,
          entry.ciFingerprint === pull.ciFingerprint
            ? entry
            : degradedEntry(pull, entry, { ciOnly: true }),
        ];
      }
    });
    for (const [key, entry] of ciResults) {
      if (entry === null) next.delete(key);
      else next.set(key, entry);
    }

    for (const [key, pull] of indexed) {
      if (
        !next.has(key) &&
        cached.has(key) &&
        !full.some(([fullKey]) => fullKey === key)
      ) {
        next.set(key, cached.get(key));
      }
      const entry = next.get(key);
      if (
        entry &&
        !full.some(([fullKey]) => fullKey === key) &&
        !ci.some(([ciKey]) => ciKey === key)
      ) {
        next.set(key, {
          ...entry,
          ciFingerprint: pull.ciFingerprint,
          evidenceFingerprint: pull.evidenceFingerprint,
          identityFingerprint: pull.identityFingerprint,
        });
      }
    }
    cached = next;

    return {
      partial,
      pulls: index.pulls.flatMap((pull) => {
        const entry = cached.get(cacheKey(pull));
        return entry ? [entry.pull] : [];
      }),
      viewerLogin: index.viewerLogin,
      warnings,
    };
  };
}

export function createGithubLoader({ executor, graphql } = {}) {
  const request = graphql ?? createGhGraphql({ executor });
  const loadAuthoredPulls = createAuthoredPullPoller({ graphql: request });
  return Object.freeze({
    loadCheckAuthorization: ({ number, repository }, signal) =>
      fetchCheckAuthorization({ graphql: request, number, repository, signal }),
    loadAuthoredPulls,
    loadPullAuthorization: ({ number, repository }, signal) =>
      fetchPullAuthorization({ graphql: request, number, repository, signal }),
    loadPullCommitsAuthorization: ({ number, repository }, signal) =>
      fetchPullCommitsAuthorization({
        graphql: request,
        number,
        repository,
        signal,
      }),
    loadPull: ({ number, repository }) =>
      fetchPull({ graphql: request, number, repository }),
  });
}
