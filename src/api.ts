import type {
  CheckLog,
  CICheck,
  CICheckState,
  CIState,
  CreateReleaseRequest,
  CreateReleaseResponse,
  GitHubActionsJob,
  MergePullRequest,
  MergePullRepairResponse,
  MergePullResponse,
  PullDiff,
  PullDiffFile,
  PullDiffFileStatus,
  PullDiffHunk,
  PullDiffLine,
  PullComment,
  PullReadiness,
  PullsResponse,
  RecentRelease,
  RecentReleasesResponse,
  RepairEvent,
  RepairSnapshot,
  RepairState,
  ReleaseVerificationEvent,
  ReleaseVerificationPull,
  ReleaseVerificationRequest,
  ReleaseVerificationState,
  ReleaseOptions,
  ReleaseRepository,
  ReleasedPull,
  ReviewComment,
  ReviewThread,
  StartTaskRequest,
  Task,
  TaskEvent,
  TaskOptions,
  TaskPhase,
  TaskRepository,
  VerificationRunEvent,
  VerificationRunRequest,
} from "./types";

const AUTH_STATUSES = new Set([401, 403]);
const CHECK_LOG_LIMIT = 3;
// The server admits at most 16 MiB of artifact data. Keep a derived 1 MiB
// allowance for the validated JSON envelope and cache record so one response
// at the server ceiling remains reusable after it is parsed.
const SERVER_ARTIFACT_BUDGET_BYTES = 16 * 1024 * 1024;
const RESPONSE_CACHE_ALLOWANCE_BYTES = 1024 * 1024;
const RESPONSE_CACHE_BUDGET_BYTES =
  SERVER_ARTIFACT_BUDGET_BYTES + RESPONSE_CACHE_ALLOWANCE_BYTES;
const MAX_ERROR_LENGTH = 500;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_ID = /^[A-Za-z0-9_-]{8,80}$/;
const TASK_PROMPT_LIMIT = 32 * 1024;
const SHA = /^[a-f0-9]{40}$/i;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;
const GITHUB_ACTIONS_JOB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9][0-9]{0,19})\/job\/([1-9][0-9]{0,19})$/;
const DIFF_LINE_KEYS = new Set(["content", "kind", "newLine", "oldLine"]);
const DIFF_LINE_KINDS = new Set(["addition", "context", "deletion", "meta"]);
const DIFF_HUNK_KEYS = new Set([
  "header",
  "lines",
  "newLines",
  "newStart",
  "oldLines",
  "oldStart",
]);
const DIFF_FILE_KEYS = new Set([
  "additions",
  "binary",
  "blobUrl",
  "changes",
  "deletions",
  "hunks",
  "path",
  "previousPath",
  "rawUrl",
  "status",
  "truncated",
]);
const DIFF_KEYS = new Set([
  "baseRefOid",
  "complete",
  "files",
  "headRefOid",
  "number",
  "repository",
  "warning",
]);
const CHECK_LOG_KEYS = new Set([
  "cached",
  "fetchedAt",
  "headRefOid",
  "jobId",
  "log",
  "number",
  "repository",
  "runId",
]);

let cachedActionToken: string | null = null;
let activeLogs = 0;
let logDrainQueued = false;

type PullIdentity = Pick<
  PullReadiness,
  "baseRefOid" | "headRefOid" | "number" | "repository"
> & { viewerLogin: string | null };

type CacheScope = {
  generation: string;
  keys: Set<string>;
  scope: string;
  users: number;
};

type CacheEntry<Value> = {
  bytes: number;
  scope: CacheScope;
  value: Value;
};

class ResponseCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private readonly scopes = new Map<string, CacheScope>();
  private bytes = 0;

  public constructor(private readonly budget: number) {}

  public acquire(scope: string, generation: string): CacheScope {
    const current = this.scopes.get(scope);
    if (current?.generation === generation) {
      current.users += 1;
      return current;
    }

    if (current) {
      for (const key of current.keys) this.delete(key);
    }

    const next = { generation, keys: new Set<string>(), scope, users: 1 };
    this.scopes.set(scope, next);
    return next;
  }

  public get(key: string, scope: CacheScope): Value | undefined {
    const entry = this.entries.get(key);
    if (entry?.scope !== scope || this.scopes.get(scope.scope) !== scope) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, scope: CacheScope, value: Value): void {
    const bytes = utf8Bytes(key) + serializedBytes(value);
    if (this.scopes.get(scope.scope) !== scope || bytes > this.budget) {
      return;
    }

    this.delete(key);
    while (this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }

    this.entries.set(key, { bytes, scope, value });
    scope.keys.add(key);
    this.bytes += bytes;
  }

  public release(scope: CacheScope): void {
    scope.users -= 1;
    this.prune(scope);
  }

  public stats(): { entries: number; scopes: number } {
    return { entries: this.entries.size, scopes: this.scopes.size };
  }

  public clear(): void {
    this.entries.clear();
    this.scopes.clear();
    this.bytes = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    this.entries.delete(key);
    this.bytes -= entry.bytes;
    entry.scope.keys.delete(key);
    this.prune(entry.scope);
  }

  private prune(scope: CacheScope): void {
    if (
      scope.users === 0 &&
      scope.keys.size === 0 &&
      this.scopes.get(scope.scope) === scope
    ) {
      this.scopes.delete(scope.scope);
    }
  }
}

type SharedRequest<Value> = {
  controller: AbortController;
  promise: Promise<Value>;
  subscribers: Set<symbol>;
};

const diffCache = new ResponseCache<PullDiff>(RESPONSE_CACHE_BUDGET_BYTES);
const checkLogCache = new ResponseCache<CheckLog>(RESPONSE_CACHE_BUDGET_BYTES);
const diffRequests = new Map<string, SharedRequest<PullDiff>>();
const checkLogRequests = new Map<string, SharedRequest<CheckLog>>();
let artifactViewer: string | null | undefined;

export class PullDiffHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PullDiffHttpError";
  }
}

type CheckLogRequest = {
  cancel: () => void;
  start: () => void;
};

const queuedLogs: CheckLogRequest[] = [];

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const encoder = new TextEncoder();

const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

const serializedBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? Number.POSITIVE_INFINITY
    : utf8Bytes(serialized);
};

const subscribe = <Value>(
  requests: Map<string, SharedRequest<Value>>,
  key: string,
  start: (signal: AbortSignal) => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  if (signal?.aborted) return Promise.reject(abortError(signal));

  let request = requests.get(key);
  if (request?.controller.signal.aborted) {
    requests.delete(key);
    request = undefined;
  }

  if (!request) {
    const controller = new AbortController();
    const subscribers = new Set<symbol>();
    const next: SharedRequest<Value> = {
      controller,
      promise: Promise.resolve().then(() => start(controller.signal)),
      subscribers,
    };
    next.promise = next.promise.finally(() => {
      if (requests.get(key) === next) requests.delete(key);
    });
    requests.set(key, next);
    request = next;
  }

  const current = request;
  const subscriber = Symbol(key);
  current.subscribers.add(subscriber);

  return new Promise<Value>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", cancel);
      current.controller.signal.removeEventListener("abort", cancelShared);
      current.subscribers.delete(subscriber);
    };
    const finish = (complete: () => void): void => {
      if (settled) return;

      settled = true;
      cleanup();
      complete();
    };
    const cancel = (): void => {
      finish(() => reject(abortError(signal)));
      if (
        current.subscribers.size === 0 &&
        !current.controller.signal.aborted
      ) {
        if (requests.get(key) === current) requests.delete(key);
        current.controller.abort(signal?.reason);
      }
    };
    const cancelShared = (): void => {
      finish(() => reject(abortError(current.controller.signal)));
    };

    signal?.addEventListener("abort", cancel, { once: true });
    current.controller.signal.addEventListener("abort", cancelShared, {
      once: true,
    });
    if (current.controller.signal.aborted) {
      cancelShared();
      return;
    }
    void current.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const drainCheckLogs = (): void => {
  while (activeLogs < CHECK_LOG_LIMIT && queuedLogs.length > 0) {
    queuedLogs.shift()?.start();
  }
};

const queueCheckLogDrain = (): void => {
  if (logDrainQueued) return;

  logDrainQueued = true;
  queueMicrotask(() => {
    logDrainQueued = false;
    drainCheckLogs();
  });
};

const scheduleCheckLog = (
  run: () => Promise<CheckLog>,
  signal?: AbortSignal,
): Promise<CheckLog> => {
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<CheckLog>((resolve, reject) => {
    let settled = false;
    let started = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", request.cancel);
    };
    const finish = (complete: () => void): void => {
      if (settled) return;

      settled = true;
      cleanup();
      if (started) activeLogs -= 1;
      complete();
      queueCheckLogDrain();
    };
    const request: CheckLogRequest = {
      cancel: () => {
        if (!started) {
          const index = queuedLogs.indexOf(request);
          if (index >= 0) queuedLogs.splice(index, 1);
        }

        finish(() => reject(abortError(signal)));
      },
      start: () => {
        if (settled) return;
        if (signal?.aborted) {
          request.cancel();
          return;
        }

        started = true;
        activeLogs += 1;
        void run().then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      },
    };

    signal?.addEventListener("abort", request.cancel, { once: true });
    queuedLogs.push(request);
    drainCheckLogs();
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const hasOnlyKeySet = (
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => keys.has(key));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isViewerLogin = (value: unknown): value is string | null =>
  value === null || isNonEmptyString(value);

const canonicalViewerLogin = (value: string | null): string => {
  if (!isNonEmptyString(value)) {
    throw new Error("The GitHub viewer identity is unavailable.");
  }

  return value.trim().toLowerCase();
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum;

const isNullableInteger = (
  value: unknown,
  minimum = 0,
): value is number | null => value === null || isInteger(value, minimum);

const isValidDate = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const isValidUrl = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const isNullableUrl = (value: unknown): value is string | null =>
  value === null || isValidUrl(value);

const isRepository = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  REPOSITORY.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");

const isTaskId = (value: unknown): value is string =>
  typeof value === "string" && TASK_ID.test(value);

const isTaskBranch = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  value !== "@" &&
  !value.includes("\0") &&
  !value.startsWith("-") &&
  !value.startsWith("/") &&
  !value.startsWith(".") &&
  !value.endsWith("/") &&
  !value.endsWith(".") &&
  !value.endsWith(".lock") &&
  !value.includes("//") &&
  !value.includes("..") &&
  value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        !part.startsWith(".") &&
        !part.endsWith(".") &&
        !part.endsWith(".lock"),
    ) &&
  !/[~^:?*\[\\\s\x00-\x1f\x7f]/.test(value);

const isTaskPhase = (value: unknown): value is TaskPhase =>
  value === "queued" ||
  value === "preparing" ||
  value === "pushing" ||
  value === "opening-pr" ||
  value === "running" ||
  value === "completed" ||
  value === "failed" ||
  value === "cancelled";

const isTaskPullRequest = (
  value: unknown,
  repository: string,
): value is Task["pullRequest"] =>
  isRecord(value) &&
  hasOnlyKeys(value, ["number", "url"]) &&
  isInteger(value.number, 1) &&
  value.url === `https://github.com/${repository}/pull/${value.number}`;

export const isTask = (value: unknown): value is Task => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "base",
      "branch",
      "createdAt",
      "error",
      "id",
      "phase",
      "pullRequest",
      "repository",
      "title",
      "updatedAt",
      "worktree",
    ]) ||
    !isTaskBranch(value.base) ||
    !isValidDate(value.createdAt) ||
    !isTaskId(value.id) ||
    !isTaskPhase(value.phase) ||
    !isRepository(value.repository) ||
    !isNonEmptyString(value.title) ||
    !isValidDate(value.updatedAt)
  ) {
    return false;
  }

  return (
    Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
    (value.branch === undefined || isTaskBranch(value.branch)) &&
    (value.worktree === undefined || isNonEmptyString(value.worktree)) &&
    (value.error === undefined || isNonEmptyString(value.error)) &&
    (value.pullRequest === undefined ||
      isTaskPullRequest(value.pullRequest, value.repository))
  );
};

const isTaskRepository = (value: unknown): value is TaskRepository => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "branches",
      "defaultBranch",
      "name",
      "owner",
      "repository",
      "updatedAt",
    ]) ||
    !isRepository(value.repository) ||
    !isNonEmptyString(value.owner) ||
    !isNonEmptyString(value.name) ||
    !isTaskBranch(value.defaultBranch) ||
    !Array.isArray(value.branches) ||
    value.branches.length === 0 ||
    !value.branches.every(isTaskBranch) ||
    !isValidDate(value.updatedAt)
  ) {
    return false;
  }

  const [owner, name] = value.repository.split("/");
  return (
    owner === value.owner &&
    name === value.name &&
    value.branches.includes(value.defaultBranch) &&
    new Set(value.branches).size === value.branches.length
  );
};

export const isTaskOptions = (value: unknown): value is TaskOptions =>
  isRecord(value) &&
  hasOnlyKeys(value, ["repositories", "updatedAt"]) &&
  isValidDate(value.updatedAt) &&
  Array.isArray(value.repositories) &&
  value.repositories.every(isTaskRepository) &&
  value.repositories.every(
    (repository) => repository.updatedAt === value.updatedAt,
  ) &&
  new Set(value.repositories.map((repository) => repository.repository))
    .size === value.repositories.length;

const isSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);

const isDecimalId = (value: unknown): value is string =>
  typeof value === "string" && DECIMAL_ID.test(value);

export const parseGitHubActionsJobUrl = (
  detailsUrl: string | null,
  repository: string,
): GitHubActionsJob | null => {
  if (detailsUrl === null || !isRepository(repository)) return null;

  const match = GITHUB_ACTIONS_JOB_URL.exec(detailsUrl);
  if (!match) return null;

  const [, owner, name, runId, jobId] = match;
  if (
    `${owner}/${name}`.toLowerCase() !== repository.toLowerCase() ||
    !isDecimalId(runId) ||
    !isDecimalId(jobId)
  ) {
    return null;
  }

  return { jobId, runId };
};

const isCIState = (value: unknown): value is CIState =>
  value === "success" ||
  value === "pending" ||
  value === "failure" ||
  value === "none" ||
  value === "unknown";

const isCICheckState = (value: unknown): value is CICheckState =>
  value === "success" ||
  value === "pending" ||
  value === "failure" ||
  value === "neutral" ||
  value === "skipped" ||
  value === "unknown";

const isCICheck = (value: unknown): value is CICheck =>
  isRecord(value) &&
  hasOnlyKeys(value, ["detailsUrl", "id", "name", "state", "workflow"]) &&
  isNullableUrl(value.detailsUrl) &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.name) &&
  isCICheckState(value.state) &&
  (value.workflow === null || isNonEmptyString(value.workflow));

const ciBucket = (
  state: CICheckState,
): "failed" | "passed" | "running" | "unknown" => {
  if (state === "failure") return "failed";
  if (state === "pending") return "running";
  if (state === "unknown") return "unknown";
  return "passed";
};

const isCI = (value: unknown): value is PullReadiness["ci"] => {
  if (!isRecord(value) || !isCIState(value.state)) {
    return false;
  }

  const enrichedKeys = [
    "checks",
    "complete",
    "failed",
    "passed",
    "running",
    "total",
    "unknown",
  ] as const;
  const enriched = enrichedKeys.some((key) => hasOwn(value, key));

  if (!enriched) {
    return hasOnlyKeys(value, ["state"]);
  }

  if (
    !hasOnlyKeys(value, ["state", ...enrichedKeys]) ||
    !Array.isArray(value.checks) ||
    !value.checks.every(isCICheck) ||
    typeof value.complete !== "boolean" ||
    !isInteger(value.failed) ||
    !isInteger(value.passed) ||
    !isInteger(value.running) ||
    !isInteger(value.total) ||
    !isInteger(value.unknown)
  ) {
    return false;
  }

  const counts = {
    failed: value.failed,
    passed: value.passed,
    running: value.running,
    unknown: value.unknown,
  };
  const observed = {
    failed: 0,
    passed: 0,
    running: 0,
    unknown: 0,
  };

  for (const check of value.checks) {
    observed[ciBucket(check.state)] += 1;
  }

  const checkIds = new Set(value.checks.map((check) => check.id));

  const countsSumToTotal =
    value.passed + value.failed + value.running + value.unknown === value.total;
  const observedFitCounts =
    observed.failed <= counts.failed &&
    observed.passed <= counts.passed &&
    observed.running <= counts.running &&
    observed.unknown <= counts.unknown;
  const expectedState =
    value.total === 0
      ? "none"
      : value.failed > 0
        ? "failure"
        : value.running > 0
          ? "pending"
          : value.unknown > 0
            ? "unknown"
            : "success";

  if (
    !countsSumToTotal ||
    value.checks.length > value.total ||
    checkIds.size !== value.checks.length ||
    !observedFitCounts
  ) {
    return false;
  }

  if (!value.complete) {
    return value.state === "unknown";
  }

  return (
    value.checks.length === value.total &&
    value.unknown === 0 &&
    value.state === expectedState &&
    observed.failed === counts.failed &&
    observed.passed === counts.passed &&
    observed.running === counts.running
  );
};

const isPullComment = (value: unknown): value is PullComment =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "author",
    "body",
    "createdAt",
    "id",
    "updatedAt",
    "url",
  ]) &&
  (value.author === null || isNonEmptyString(value.author)) &&
  typeof value.body === "string" &&
  isValidDate(value.createdAt) &&
  isNonEmptyString(value.id) &&
  isValidDate(value.updatedAt) &&
  Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
  isValidUrl(value.url);

const isReviewComment = (value: unknown): value is ReviewComment =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "author",
    "body",
    "createdAt",
    "id",
    "line",
    "outdated",
    "path",
    "updatedAt",
    "url",
  ]) &&
  (value.author === null || isNonEmptyString(value.author)) &&
  typeof value.body === "string" &&
  isValidDate(value.createdAt) &&
  isNonEmptyString(value.id) &&
  isNullableInteger(value.line, 1) &&
  typeof value.outdated === "boolean" &&
  (value.path === null || isNonEmptyString(value.path)) &&
  isValidDate(value.updatedAt) &&
  Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
  isValidUrl(value.url);

const isReviewThread = (value: unknown): value is ReviewThread => {
  const comments = isRecord(value) ? value.comments : null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "author",
      "body",
      "comments",
      "createdAt",
      "id",
      "line",
      "outdated",
      "path",
      "url",
    ]) ||
    (value.author !== null && !isNonEmptyString(value.author)) ||
    typeof value.body !== "string" ||
    !Array.isArray(comments) ||
    comments.length === 0 ||
    !comments.every(isReviewComment) ||
    !isValidDate(value.createdAt) ||
    !isNonEmptyString(value.id) ||
    !isNullableInteger(value.line, 1) ||
    typeof value.outdated !== "boolean" ||
    (value.path !== null && !isNonEmptyString(value.path)) ||
    !isValidUrl(value.url)
  ) {
    return false;
  }

  const root = comments[0];
  const commentIds = new Set(comments.map((comment) => comment.id));
  const commentsOrdered = comments.every(
    (comment, index) =>
      index === 0 ||
      Date.parse(comment.createdAt) >=
        Date.parse(comments[index - 1]!.createdAt),
  );

  return (
    root !== undefined &&
    value.author === root.author &&
    value.body === root.body &&
    value.createdAt === root.createdAt &&
    value.url === root.url &&
    commentIds.size === comments.length &&
    commentsOrdered
  );
};

const isPullReadiness = (value: unknown): value is PullReadiness => {
  if (
    !isRecord(value) ||
    !isRecord(value.checks) ||
    !isRecord(value.greptile) ||
    !isCI(value.ci)
  ) {
    return false;
  }

  const checks = value.checks;
  const greptile = value.greptile;

  const unresolved = value.unresolved;
  const unresolvedValid = isInteger(unresolved);
  const unresolvedThreadsValid =
    !hasOwn(value, "unresolvedThreads") ||
    (unresolvedValid &&
      Array.isArray(value.unresolvedThreads) &&
      value.unresolvedThreads.every(isReviewThread) &&
      value.unresolvedThreads.length <= unresolved &&
      (!checks.threadsComplete ||
        value.unresolvedThreads.length === unresolved));
  const issueComments =
    Array.isArray(value.issueComments) &&
    value.issueComments.every(isPullComment) &&
    new Set(value.issueComments.map((comment) => comment.id)).size ===
      value.issueComments.length
      ? value.issueComments
      : null;
  const issueCommentsValid = issueComments !== null;
  const bodyValid =
    !hasOwn(greptile, "body") || isNullableString(greptile.body);
  const currentValid =
    !hasOwn(greptile, "current") ||
    (typeof greptile.current === "boolean" &&
      greptile.current ===
        (isSha(greptile.reviewedSha) &&
          isSha(value.headRefOid) &&
          greptile.reviewedSha.toLowerCase() ===
            value.headRefOid.toLowerCase()));
  const greptileIdentityValid =
    ((greptile.commentId === null &&
      greptile.commentUrl === null &&
      greptile.updatedAt === null) ||
      (isNonEmptyString(greptile.commentId) &&
        isValidUrl(greptile.commentUrl) &&
        isValidDate(greptile.updatedAt) &&
        issueComments !== null &&
        issueComments.some(
          (comment) =>
            comment.id === greptile.commentId &&
            comment.url === greptile.commentUrl &&
            comment.updatedAt === greptile.updatedAt,
        ))) &&
    (greptile.body === undefined ||
      greptile.commentId !== null ||
      greptile.body === null);

  return (
    Array.isArray(value.blockers) &&
    value.blockers.every(isNonEmptyString) &&
    typeof checks.commentsComplete === "boolean" &&
    typeof checks.threadsComplete === "boolean" &&
    greptileIdentityValid &&
    ((typeof greptile.confidence === "number" &&
      greptile.confidence >= 0 &&
      greptile.confidence <= 5) ||
      greptile.confidence === null) &&
    (isSha(greptile.reviewedSha) || greptile.reviewedSha === null) &&
    bodyValid &&
    currentValid &&
    isSha(value.baseRefOid) &&
    isSha(value.headRefOid) &&
    issueCommentsValid &&
    isInteger(value.number, 1) &&
    isInteger(value.rank, 1) &&
    typeof value.ready === "boolean" &&
    isRepository(value.repository) &&
    isValidUrl(value.repositoryUrl) &&
    isNonEmptyString(value.title) &&
    unresolvedValid &&
    unresolvedThreadsValid &&
    isValidDate(value.updatedAt) &&
    isValidUrl(value.url)
  );
};

const isReadyPull = (pull: PullReadiness): boolean =>
  pull.ready &&
  pull.blockers.length === 0 &&
  pull.unresolved === 0 &&
  pull.checks.commentsComplete &&
  pull.checks.threadsComplete &&
  (pull.ci.state === "success" || pull.ci.state === "none") &&
  pull.greptile.confidence === 5 &&
  pull.greptile.commentUrl !== null &&
  pull.greptile.reviewedSha !== null &&
  pull.greptile.reviewedSha.toLowerCase() === pull.headRefOid.toLowerCase();

const isBlockedPull = (pull: PullReadiness): boolean =>
  !pull.ready && pull.blockers.length > 0;

export const isPullsResponse = (value: unknown): value is PullsResponse => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "counts",
      "generatedAt",
      "notReady",
      "partial",
      "query",
      "ready",
      "stale",
      "viewerLogin",
      "warnings",
    ])
  ) {
    return false;
  }

  const counts = value.counts;

  if (!isRecord(counts)) {
    return false;
  }

  const notReadyCount = counts.notReady;
  const readyCount = counts.ready;
  const totalCount = counts.total;

  if (
    !Array.isArray(value.ready) ||
    !value.ready.every(isPullReadiness) ||
    !value.ready.every(isReadyPull) ||
    !Array.isArray(value.notReady) ||
    !value.notReady.every(isPullReadiness) ||
    !value.notReady.every(isBlockedPull) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isNonEmptyString) ||
    !isValidDate(value.generatedAt) ||
    typeof value.partial !== "boolean" ||
    !isNonEmptyString(value.query) ||
    typeof value.stale !== "boolean" ||
    !isViewerLogin(value.viewerLogin) ||
    !isInteger(notReadyCount) ||
    !isInteger(readyCount) ||
    !isInteger(totalCount)
  ) {
    return false;
  }

  const pulls = [...value.ready, ...value.notReady];
  const countsMatch =
    readyCount === value.ready.length &&
    notReadyCount === value.notReady.length &&
    totalCount === pulls.length &&
    totalCount === readyCount + notReadyCount;
  const ranks = new Set(pulls.map((pull) => pull.rank));
  const urls = new Set(pulls.map((pull) => pull.url));
  const ranksAreComplete = pulls.every((pull) => pull.rank <= totalCount);

  return (
    countsMatch &&
    ranks.size === pulls.length &&
    urls.size === pulls.length &&
    ranksAreComplete
  );
};

const isDiffLine = (value: unknown): value is PullDiffLine => {
  if (
    !isRecord(value) ||
    !hasOnlyKeySet(value, DIFF_LINE_KEYS) ||
    typeof value.content !== "string" ||
    !DIFF_LINE_KINDS.has(String(value.kind)) ||
    !isNullableInteger(value.newLine, 1) ||
    !isNullableInteger(value.oldLine, 1)
  ) {
    return false;
  }

  if (value.kind === "addition")
    return value.oldLine === null && value.newLine !== null;
  if (value.kind === "deletion")
    return value.oldLine !== null && value.newLine === null;
  if (value.kind === "context")
    return value.oldLine !== null && value.newLine !== null;
  return value.oldLine === null && value.newLine === null;
};

const isDiffHunk = (value: unknown): value is PullDiffHunk =>
  isRecord(value) &&
  hasOnlyKeySet(value, DIFF_HUNK_KEYS) &&
  isNonEmptyString(value.header) &&
  Array.isArray(value.lines) &&
  value.lines.every(isDiffLine) &&
  isInteger(value.newLines) &&
  isInteger(value.newStart) &&
  isInteger(value.oldLines) &&
  isInteger(value.oldStart);

const isDiffFileStatus = (value: unknown): value is PullDiffFileStatus =>
  value === "added" ||
  value === "changed" ||
  value === "copied" ||
  value === "modified" ||
  value === "removed" ||
  value === "renamed" ||
  value === "unchanged";

const isDiffLink = (value: unknown): value is string =>
  value === "" || isValidUrl(value);

const isDiffFile = (value: unknown): value is PullDiffFile =>
  isRecord(value) &&
  hasOnlyKeySet(value, DIFF_FILE_KEYS) &&
  isInteger(value.additions) &&
  typeof value.binary === "boolean" &&
  isDiffLink(value.blobUrl) &&
  isInteger(value.changes) &&
  isInteger(value.deletions) &&
  Array.isArray(value.hunks) &&
  value.hunks.every(isDiffHunk) &&
  isNonEmptyString(value.path) &&
  (value.previousPath === null || isNonEmptyString(value.previousPath)) &&
  isDiffLink(value.rawUrl) &&
  isDiffFileStatus(value.status) &&
  typeof value.truncated === "boolean";

export const isPullDiff = (value: unknown): value is PullDiff => {
  if (
    !isRecord(value) ||
    !hasOnlyKeySet(value, DIFF_KEYS) ||
    !isSha(value.baseRefOid) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.files) ||
    !value.files.every(isDiffFile) ||
    !isSha(value.headRefOid) ||
    !isInteger(value.number, 1) ||
    !isRepository(value.repository) ||
    (value.warning !== null && !isNonEmptyString(value.warning))
  ) {
    return false;
  }

  const degradedFile = value.files.some(
    (file) => file.blobUrl === "" || file.rawUrl === "" || file.truncated,
  );

  return value.complete
    ? value.warning === null && !degradedFile
    : value.warning !== null;
};

export const isCheckLog = (value: unknown): value is CheckLog =>
  isRecord(value) &&
  hasOnlyKeySet(value, CHECK_LOG_KEYS) &&
  typeof value.cached === "boolean" &&
  isValidDate(value.fetchedAt) &&
  isSha(value.headRefOid) &&
  isDecimalId(value.jobId) &&
  typeof value.log === "string" &&
  isInteger(value.number, 1) &&
  isRepository(value.repository) &&
  isDecimalId(value.runId);

const isReleaseRepository = (value: unknown): value is ReleaseRepository =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "latestTag",
    "nextTag",
    "previousTags",
    "repository",
    "repositoryUrl",
  ]) &&
  (value.latestTag === null || isNonEmptyString(value.latestTag)) &&
  isNonEmptyString(value.nextTag) &&
  Array.isArray(value.previousTags) &&
  value.previousTags.length <= 10 &&
  value.previousTags.every(isNonEmptyString) &&
  new Set(value.previousTags).size === value.previousTags.length &&
  isRepository(value.repository) &&
  isValidUrl(value.repositoryUrl);

export const isReleaseOptions = (value: unknown): value is ReleaseOptions =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "generatedAt",
    "repositories",
    "repositoriesUpdatedAt",
    "tagsUpdatedAt",
    "viewerLogin",
    "warnings",
  ]) &&
  isValidDate(value.generatedAt) &&
  isValidDate(value.repositoriesUpdatedAt) &&
  isValidDate(value.tagsUpdatedAt) &&
  Date.parse(value.repositoriesUpdatedAt) <= Date.parse(value.generatedAt) &&
  Date.parse(value.tagsUpdatedAt) <= Date.parse(value.generatedAt) &&
  Array.isArray(value.repositories) &&
  value.repositories.every(isReleaseRepository) &&
  new Set(value.repositories.map((item) => item.repository.toLowerCase()))
    .size === value.repositories.length &&
  isNonEmptyString(value.viewerLogin) &&
  Array.isArray(value.warnings) &&
  value.warnings.every(isNonEmptyString);

const isReleasedPull = (value: unknown): value is ReleasedPull =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "headSha",
    "mergedAt",
    "number",
    "repository",
    "title",
    "url",
  ]) &&
  isSha(value.headSha) &&
  isValidDate(value.mergedAt) &&
  isInteger(value.number, 1) &&
  isRepository(value.repository) &&
  isNonEmptyString(value.title) &&
  isValidUrl(value.url);

const isRecentRelease = (value: unknown): value is RecentRelease =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "complete",
    "id",
    "name",
    "publishedAt",
    "pulls",
    "repository",
    "repositoryUrl",
    "source",
    "tag",
    "url",
    "warning",
  ]) &&
  typeof value.complete === "boolean" &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.name) &&
  isValidDate(value.publishedAt) &&
  Array.isArray(value.pulls) &&
  value.pulls.every(isReleasedPull) &&
  value.pulls.every(
    (pull) =>
      pull.repository.toLowerCase() === String(value.repository).toLowerCase(),
  ) &&
  isRepository(value.repository) &&
  isValidUrl(value.repositoryUrl) &&
  (value.source === "comparison" ||
    value.source === "notes-fallback" ||
    value.source === "unavailable") &&
  isNonEmptyString(value.tag) &&
  isValidUrl(value.url) &&
  (value.warning === null || isNonEmptyString(value.warning)) &&
  (value.complete || value.warning !== null);

export const isRecentReleasesResponse = (
  value: unknown,
): value is RecentReleasesResponse =>
  isRecord(value) &&
  hasOnlyKeys(value, ["generatedAt", "partial", "releases", "warnings"]) &&
  isValidDate(value.generatedAt) &&
  typeof value.partial === "boolean" &&
  Array.isArray(value.releases) &&
  value.releases.every(isRecentRelease) &&
  new Set(value.releases.map((release) => release.id)).size ===
    value.releases.length &&
  Array.isArray(value.warnings) &&
  value.warnings.every(isNonEmptyString);

const isMergePullResponse = (value: unknown): value is MergePullResponse => {
  if (
    !isRecord(value) ||
    !isInteger(value.number, 1) ||
    !isRepository(value.repository) ||
    !isValidUrl(value.url)
  ) {
    return false;
  }

  if (value.merged === true) {
    return (
      hasOnlyKeys(value, [
        "mergeCommitOid",
        "merged",
        "number",
        "repository",
        "url",
      ]) &&
      (value.mergeCommitOid === null || isSha(value.mergeCommitOid))
    );
  }

  return (
    value.merged === false &&
    hasOnlyKeys(value, [
      "action",
      "headRefOid",
      "merged",
      "number",
      "repository",
      "url",
    ]) &&
    isSha(value.headRefOid) &&
    isRecord(value.action) &&
    hasOnlyKeys(value.action, [
      "deduplicated",
      "id",
      "state",
      "token",
      "type",
    ]) &&
    typeof value.action.deduplicated === "boolean" &&
    isNonEmptyString(value.action.id) &&
    (value.action.state === "repair_queued" ||
      value.action.state === "repair_running") &&
    typeof value.action.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.action.token) &&
    value.action.type === "repair_queued"
  );
};

const isCreateReleaseResponse = (
  value: unknown,
): value is CreateReleaseResponse =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "name",
    "publishedAt",
    "repository",
    "tag",
    "url",
  ]) &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.name) &&
  isValidDate(value.publishedAt) &&
  isRepository(value.repository) &&
  isNonEmptyString(value.tag) &&
  isValidUrl(value.url);

const getErrorMessage = (
  status: number,
  payload: unknown,
  fallback: string,
): string => {
  const message =
    isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
  const normalized = message
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);

  return normalized || `${fallback} (HTTP ${status}).`;
};

const getErrorCode = (payload: unknown, fallback: string): string =>
  isRecord(payload) &&
  typeof payload.code === "string" &&
  /^[a-z][a-z0-9_]{0,63}$/.test(payload.code)
    ? payload.code
    : fallback;

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

const isActionUnauthorized = async (response: Response): Promise<boolean> => {
  if (!AUTH_STATUSES.has(response.status)) return false;
  try {
    const payload = await readJson(response.clone());
    return isRecord(payload) && payload.code === "action_unauthorized";
  } catch {
    return false;
  }
};

const requestActionToken = async (signal?: AbortSignal): Promise<string> => {
  const response = await fetch("/api/actions/token", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "The action token request failed",
      ),
    );
  }
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, ["token"]) ||
    !isNonEmptyString(payload.token)
  ) {
    throw new Error("The action service returned an invalid token response.");
  }

  return payload.token;
};

const getActionToken = async (
  signal?: AbortSignal,
  refresh = false,
): Promise<string> => {
  if (refresh) cachedActionToken = null;
  if (cachedActionToken) return cachedActionToken;

  cachedActionToken = await requestActionToken(signal);
  return cachedActionToken;
};

const actionFetch = async (
  input: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getActionToken(signal, attempt === 1);
    const response = await fetch(input, {
      ...init,
      headers: {
        ...init.headers,
        "X-Action-Token": token,
      },
      signal,
    });

    if (attempt === 1 || !(await isActionUnauthorized(response))) {
      return response;
    }
    cachedActionToken = null;
  }

  throw new Error("The action request could not be authorized.");
};

const pullPath = (repository: string, number: number): string => {
  if (!isRepository(repository) || !isInteger(number, 1)) {
    throw new Error("The pull request identity is invalid.");
  }

  const [owner, name] = repository.split("/") as [string, string];
  return `/api/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`;
};

const postJsonAction = async <ResponseType>(
  path: string,
  body: unknown,
  validate: (value: unknown) => value is ResponseType,
  fallback: string,
  signal?: AbortSignal,
): Promise<ResponseType> => {
  const response = await actionFetch(
    path,
    {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(response.status, payload, fallback));
  }
  if (!validate(payload)) {
    throw new Error(`${fallback} returned an unexpected response.`);
  }

  return payload;
};

const clearPullRequestArtifacts = (): void => {
  diffCache.clear();
  checkLogCache.clear();
  for (const request of diffRequests.values()) request.controller.abort();
  for (const request of checkLogRequests.values()) request.controller.abort();
  diffRequests.clear();
  checkLogRequests.clear();
};

const observeArtifactViewer = (viewerLogin: string | null): void => {
  const viewer =
    viewerLogin === null ? null : canonicalViewerLogin(viewerLogin);

  if (viewer === null || viewer !== artifactViewer) {
    clearPullRequestArtifacts();
  }

  artifactViewer = viewer;
};

export const getPulls = async (
  refresh = false,
  signal?: AbortSignal,
): Promise<PullsResponse> => {
  try {
    const response = await fetch(
      refresh ? "/api/pulls?refresh=1" : "/api/pulls",
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      },
    );
    throwIfAborted(signal);
    const payload = await readJson(response);
    throwIfAborted(signal);

    if (!response.ok) {
      throw new Error(
        getErrorMessage(
          response.status,
          payload,
          "The readiness service request failed",
        ),
      );
    }
    if (!isPullsResponse(payload)) {
      throw new Error("The readiness service returned an unexpected response.");
    }

    observeArtifactViewer(
      payload.partial || payload.stale ? null : payload.viewerLogin,
    );
    return payload;
  } catch (error) {
    if (!signal?.aborted) observeArtifactViewer(null);
    throw error;
  }
};

const pullScope = (pull: PullIdentity): string => {
  const viewer = canonicalViewerLogin(pull.viewerLogin);
  if (artifactViewer !== undefined && artifactViewer !== viewer) {
    throw new Error("The GitHub viewer identity is unavailable.");
  }

  return JSON.stringify([viewer, pull.repository.toLowerCase(), pull.number]);
};

const pullGeneration = (pull: PullIdentity): string =>
  JSON.stringify([
    pull.baseRefOid.toLowerCase(),
    pull.headRefOid.toLowerCase(),
  ]);

const pullDiffKey = (pull: PullIdentity): string =>
  JSON.stringify([pullScope(pull), pullGeneration(pull)]);

const checkLogKey = (pull: PullIdentity, job: GitHubActionsJob): string =>
  JSON.stringify([pullDiffKey(pull), job.runId, job.jobId]);

export const getPullDiff = async (
  pull: PullIdentity,
  signal?: AbortSignal,
): Promise<PullDiff> => {
  throwIfAborted(signal);
  if (!isSha(pull.baseRefOid))
    throw new Error("The pull request base is invalid.");
  if (!isSha(pull.headRefOid))
    throw new Error("The pull request head is invalid.");

  const scope = pullScope(pull);
  const generation = pullGeneration(pull);
  const key = pullDiffKey(pull);
  const cacheScope = diffCache.acquire(scope, generation);

  try {
    const cached = diffCache.get(key, cacheScope);
    if (cached) return cached;

    return await subscribe(
      diffRequests,
      key,
      async (sharedSignal) => {
        throwIfAborted(sharedSignal);
        const query = new URLSearchParams({
          base: pull.baseRefOid.toLowerCase(),
          head: pull.headRefOid.toLowerCase(),
        });
        const response = await fetch(
          `${pullPath(pull.repository, pull.number)}/diff?${query}`,
          {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: sharedSignal,
          },
        );
        throwIfAborted(sharedSignal);
        const payload = await readJson(response);
        throwIfAborted(sharedSignal);

        if (!response.ok) {
          throw new PullDiffHttpError(
            response.status,
            getErrorCode(payload, "diff_unavailable"),
            getErrorMessage(
              response.status,
              payload,
              "The pull request diff failed",
            ),
          );
        }
        if (
          !isPullDiff(payload) ||
          payload.repository.toLowerCase() !== pull.repository.toLowerCase() ||
          payload.number !== pull.number ||
          payload.baseRefOid.toLowerCase() !== pull.baseRefOid.toLowerCase() ||
          payload.headRefOid.toLowerCase() !== pull.headRefOid.toLowerCase()
        ) {
          throw new Error(
            "The pull request diff returned an unexpected response.",
          );
        }

        throwIfAborted(sharedSignal);
        diffCache.set(key, cacheScope, payload);
        return payload;
      },
      signal,
    );
  } finally {
    diffCache.release(cacheScope);
  }
};

export const getCheckLog = async (
  pull: PullIdentity,
  job: GitHubActionsJob,
  signal?: AbortSignal,
): Promise<CheckLog> => {
  throwIfAborted(signal);
  if (
    !isSha(pull.baseRefOid) ||
    !isSha(pull.headRefOid) ||
    !isDecimalId(job.runId) ||
    !isDecimalId(job.jobId)
  ) {
    throw new Error("The check log identity is invalid.");
  }

  const scope = pullScope(pull);
  const generation = pullGeneration(pull);
  const key = checkLogKey(pull, job);
  const cacheScope = checkLogCache.acquire(scope, generation);

  try {
    const cached = checkLogCache.get(key, cacheScope);
    if (cached) return cached;

    return await subscribe(
      checkLogRequests,
      key,
      (sharedSignal) =>
        scheduleCheckLog(async () => {
          throwIfAborted(sharedSignal);
          const query = new URLSearchParams({
            baseRefOid: pull.baseRefOid.toLowerCase(),
            headRefOid: pull.headRefOid.toLowerCase(),
          });
          const response = await fetch(
            `${pullPath(pull.repository, pull.number)}/checks/${job.runId}/jobs/${job.jobId}/logs?${query}`,
            {
              cache: "no-store",
              headers: { Accept: "application/json" },
              signal: sharedSignal,
            },
          );
          throwIfAborted(sharedSignal);
          const responsePayload = await readJson(response);
          throwIfAborted(sharedSignal);

          if (!response.ok) {
            throw new Error(
              getErrorMessage(
                response.status,
                responsePayload,
                "The check log could not be loaded",
              ),
            );
          }
          if (
            !isCheckLog(responsePayload) ||
            responsePayload.repository.toLowerCase() !==
              pull.repository.toLowerCase() ||
            responsePayload.number !== pull.number ||
            responsePayload.headRefOid.toLowerCase() !==
              pull.headRefOid.toLowerCase() ||
            responsePayload.runId !== job.runId ||
            responsePayload.jobId !== job.jobId
          ) {
            throw new Error("The check log returned an unexpected response.");
          }

          throwIfAborted(sharedSignal);
          checkLogCache.set(key, cacheScope, responsePayload);
          return responsePayload;
        }, sharedSignal),
      signal,
    );
  } finally {
    checkLogCache.release(cacheScope);
  }
};

export function getReleaseOptions(
  signal?: AbortSignal,
): Promise<ReleaseOptions>;
export function getReleaseOptions(
  refresh: boolean,
  signal?: AbortSignal,
): Promise<ReleaseOptions>;
export async function getReleaseOptions(
  refreshOrSignal: boolean | AbortSignal = false,
  nextSignal?: AbortSignal,
): Promise<ReleaseOptions> {
  const refresh =
    typeof refreshOrSignal === "boolean" ? refreshOrSignal : false;
  const signal =
    typeof refreshOrSignal === "boolean" ? nextSignal : refreshOrSignal;
  const response = await fetch(
    refresh ? "/api/releases/options?refresh=1" : "/api/releases/options",
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Release options could not be loaded",
      ),
    );
  }
  if (!isReleaseOptions(payload)) {
    throw new Error("Release options returned an unexpected response.");
  }

  return payload;
}

export const getRecentReleases = async (
  refresh = false,
  signal?: AbortSignal,
): Promise<RecentReleasesResponse> => {
  const response = await fetch(
    refresh ? "/api/releases/recent?refresh=1" : "/api/releases/recent",
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Recent releases could not be loaded",
      ),
    );
  }
  if (!isRecentReleasesResponse(payload)) {
    throw new Error("Recent releases returned an unexpected response.");
  }

  return payload;
};

export const getTaskOptions = async (
  signal?: AbortSignal,
): Promise<TaskOptions> => {
  const response = await fetch("/api/tasks/options", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Task options could not be loaded",
      ),
    );
  }
  if (!isTaskOptions(payload)) {
    throw new Error("Task options returned an unexpected response.");
  }
  return payload;
};

export const getTasks = async (signal?: AbortSignal): Promise<Task[]> => {
  const response = await fetch("/api/tasks/runs", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(
      getErrorMessage(response.status, payload, "Tasks could not be restored"),
    );
  }
  if (
    !Array.isArray(payload) ||
    !payload.every(isTask) ||
    new Set(payload.map((task) => task.id)).size !== payload.length
  ) {
    throw new Error("Tasks returned an unexpected response.");
  }
  return payload;
};

export class TaskStartError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TaskStartError";
    this.status = status;
  }
}

const validStartTaskRequest = (request: StartTaskRequest): boolean =>
  isTaskId(request.id) &&
  isRepository(request.repository) &&
  isTaskBranch(request.base) &&
  isNonEmptyString(request.prompt) &&
  !request.prompt.includes("\0") &&
  new TextEncoder().encode(request.prompt.trim()).byteLength <=
    TASK_PROMPT_LIMIT;

export const startTask = async (
  request: StartTaskRequest,
  signal?: AbortSignal,
): Promise<Task> => {
  if (!validStartTaskRequest(request)) {
    throw new Error("The task request is invalid.");
  }

  const response = await actionFetch(
    "/api/tasks/runs",
    {
      body: JSON.stringify(request),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw new TaskStartError(
      response.status,
      getErrorMessage(
        response.status,
        payload,
        "The task could not be started",
      ),
    );
  }
  if (response.status !== 202 || !isTask(payload)) {
    throw new Error("The task service returned an unexpected response.");
  }
  const task = payload;
  if (
    task.id !== request.id ||
    task.repository.toLowerCase() !== request.repository.toLowerCase() ||
    task.base !== request.base
  ) {
    throw new Error("The task service returned an unexpected response.");
  }
  return task;
};

export const cancelTask = async (
  id: string,
  signal?: AbortSignal,
): Promise<Task | null> => {
  if (!isTaskId(id)) throw new Error("The task identity is invalid.");

  const response = await actionFetch(
    `/api/tasks/runs/${encodeURIComponent(id)}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    signal,
  );
  if (response.status === 204) return null;

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "The task could not be cancelled",
      ),
    );
  }
  if (!isTask(payload) || payload.id !== id) {
    throw new Error("Task cancellation returned an unexpected response.");
  }
  return payload;
};

export const mergePull = async (
  request: MergePullRequest,
  signal?: AbortSignal,
): Promise<MergePullResponse> => {
  if (!isSha(request.expectedHeadRefOid)) {
    throw new Error("The expected pull request head is invalid.");
  }

  const response = await postJsonAction(
    `${pullPath(request.repository, request.number)}/merge`,
    { expectedHeadRefOid: request.expectedHeadRefOid.toLowerCase() },
    isMergePullResponse,
    "The pull request merge failed",
    signal,
  );
  if (
    response.repository.toLowerCase() !== request.repository.toLowerCase() ||
    response.number !== request.number ||
    response.url !==
      `https://github.com/${request.repository}/pull/${request.number}` ||
    (!response.merged &&
      response.headRefOid.toLowerCase() !==
        request.expectedHeadRefOid.toLowerCase())
  ) {
    throw new Error("The pull request merge returned an unexpected response.");
  }

  return response;
};

export const createRelease = async (
  request: CreateReleaseRequest,
  signal?: AbortSignal,
): Promise<CreateReleaseResponse> => {
  if (
    !isRepository(request.repository) ||
    !isNonEmptyString(request.tag) ||
    (request.expectedLatestTag !== null &&
      !isNonEmptyString(request.expectedLatestTag))
  ) {
    throw new Error("The release request is invalid.");
  }

  const response = await postJsonAction(
    "/api/releases",
    request,
    isCreateReleaseResponse,
    "The release could not be created",
    signal,
  );
  if (
    response.repository.toLowerCase() !== request.repository.toLowerCase() ||
    response.tag !== request.tag
  ) {
    throw new Error("The release service returned an unexpected response.");
  }

  return response;
};

const readLines = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield line;
        newline = buffer.indexOf("\n");
      }

      if (done) {
        if (buffer.trim()) yield buffer.replace(/\r$/, "");
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

const parseTaskEvent = (value: unknown): TaskEvent => {
  if (
    !isRecord(value) ||
    !isInteger(value.sequence, 1) ||
    !isNonEmptyString(value.type)
  ) {
    throw new Error("Claude returned an invalid task event.");
  }

  if (
    value.type === "task" &&
    hasOnlyKeys(value, ["sequence", "task", "type"]) &&
    isTask(value.task)
  ) {
    return { sequence: value.sequence, task: value.task, type: "task" };
  }
  if (
    value.type === "output" &&
    hasOnlyKeys(value, ["id", "sequence", "stream", "text", "type"]) &&
    isTaskId(value.id) &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    typeof value.text === "string"
  ) {
    return {
      id: value.id,
      sequence: value.sequence,
      stream: value.stream,
      text: value.text,
      type: "output",
    };
  }

  throw new Error("Claude returned an invalid task event.");
};

export async function* streamTaskEvents(
  id: string,
  after = 0,
  signal?: AbortSignal,
): AsyncGenerator<TaskEvent, void, undefined> {
  if (!isTaskId(id) || !Number.isSafeInteger(after) || after < 0) {
    throw new Error("The task event request is invalid.");
  }

  const response = await fetch(
    `/api/tasks/runs/${encodeURIComponent(id)}/events?after=${after}`,
    {
      cache: "no-store",
      headers: { Accept: "application/x-ndjson" },
      signal,
    },
  );
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Task events could not be loaded",
      ),
    );
  }
  if (!response.body) {
    throw new Error("Claude returned an empty task event stream.");
  }

  let sequence = after;
  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error("Claude returned malformed task event data.");
    }

    const event = parseTaskEvent(payload);
    if (
      event.sequence <= sequence ||
      (event.type === "task" && event.task.id !== id) ||
      (event.type === "output" && event.id !== id)
    ) {
      throw new Error("Claude returned mismatched task event data.");
    }
    sequence = event.sequence;
    yield event;
  }
}

const isRepairState = (value: unknown): value is RepairState =>
  value === "repair_queued" ||
  value === "repair_running" ||
  value === "ready" ||
  value === "conflict" ||
  value === "failed" ||
  value === "cancelled";

const repairTerminal = (state: RepairState): boolean =>
  state === "ready" ||
  state === "conflict" ||
  state === "failed" ||
  state === "cancelled";

const parseRepairEvent = (value: unknown): RepairEvent => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.type) ||
    !isNonEmptyString(value.actionId) ||
    !isRepository(value.repository) ||
    !isInteger(value.number, 1) ||
    !isSha(value.headRefOid)
  ) {
    throw new Error("Claude returned an invalid conflict repair event.");
  }

  if (
    value.type === "output" &&
    hasOnlyKeys(value, [
      "actionId",
      "headRefOid",
      "number",
      "repository",
      "text",
      "type",
    ]) &&
    typeof value.text === "string"
  ) {
    return {
      actionId: value.actionId,
      headRefOid: value.headRefOid,
      number: value.number,
      repository: value.repository,
      text: value.text,
      type: "output",
    };
  }

  const stateKeys = [
    "actionId",
    "commit",
    "headRefOid",
    "message",
    "number",
    "repository",
    "state",
    "terminal",
    "type",
    "updatedAt",
  ];
  const snapshotKeys = [...stateKeys, "output"];
  if (
    (value.type === "snapshot" || value.type === "state") &&
    hasOnlyKeys(value, value.type === "snapshot" ? snapshotKeys : stateKeys) &&
    isRepairState(value.state) &&
    typeof value.terminal === "boolean" &&
    value.terminal === repairTerminal(value.state) &&
    isValidDate(value.updatedAt) &&
    (value.commit === undefined || isSha(value.commit)) &&
    (value.message === undefined || isNonEmptyString(value.message)) &&
    (value.type !== "snapshot" || typeof value.output === "string")
  ) {
    const common = {
      actionId: value.actionId,
      ...(value.commit === undefined ? {} : { commit: value.commit }),
      headRefOid: value.headRefOid,
      ...(value.message === undefined ? {} : { message: value.message }),
      number: value.number,
      repository: value.repository,
      state: value.state,
      terminal: value.terminal,
      updatedAt: value.updatedAt,
    };
    return value.type === "snapshot"
      ? { ...common, output: String(value.output), type: "snapshot" }
      : { ...common, type: "state" };
  }

  throw new Error("Claude returned an invalid conflict repair event.");
};

const matchesRepair = (
  event: RepairEvent,
  action: Pick<MergePullRepairResponse["action"], "id">,
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
): boolean =>
  event.actionId === action.id &&
  event.repository.toLowerCase() === pull.repository.toLowerCase() &&
  event.number === pull.number &&
  event.headRefOid.toLowerCase() === pull.headRefOid.toLowerCase();

const repairPath = (
  action: Pick<MergePullRepairResponse["action"], "id">,
  pull: Pick<PullReadiness, "number" | "repository">,
): string => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(action.id)) {
    throw new Error("The conflict repair identity is invalid.");
  }
  return `${pullPath(pull.repository, pull.number)}/repairs/${encodeURIComponent(action.id)}`;
};

export async function* streamRepair(
  action: Pick<MergePullRepairResponse["action"], "id" | "token">,
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
  signal?: AbortSignal,
): AsyncGenerator<RepairEvent, void, undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(action.token) || !isSha(pull.headRefOid)) {
    throw new Error("The conflict repair authorization is invalid.");
  }
  const response = await fetch(repairPath(action, pull), {
    cache: "no-store",
    headers: {
      Accept: "application/x-ndjson",
      "X-Action-Token": action.token,
    },
    signal,
  });
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Conflict repair could not be observed",
      ),
    );
  }
  if (!response.body) {
    throw new Error("Claude returned an empty conflict repair stream.");
  }

  let index = 0;
  let terminal = false;
  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error("Claude returned malformed conflict repair stream data.");
    }
    const event = parseRepairEvent(payload);
    if (index === 0 && event.type !== "snapshot") {
      throw new Error(
        "Claude returned conflict repair data without a snapshot.",
      );
    }
    if (index > 0 && event.type === "snapshot") {
      throw new Error(
        "Claude returned more than one conflict repair snapshot.",
      );
    }
    if (!matchesRepair(event, action, pull)) {
      throw new Error("Claude returned a mismatched conflict repair identity.");
    }
    if (terminal) {
      throw new Error("Claude returned data after conflict repair completed.");
    }

    index += 1;
    terminal = event.type !== "output" && event.terminal;
    yield event;
  }

  if (index === 0) {
    throw new Error("Claude returned an empty conflict repair stream.");
  }
  if (!terminal) {
    throw new Error("Claude disconnected before conflict repair completed.");
  }
}

export const cancelRepair = async (
  action: Pick<MergePullRepairResponse["action"], "id" | "token">,
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
  signal?: AbortSignal,
): Promise<RepairSnapshot> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(action.token) || !isSha(pull.headRefOid)) {
    throw new Error("The conflict repair authorization is invalid.");
  }
  const response = await fetch(repairPath(action, pull), {
    headers: {
      Accept: "application/json",
      "X-Action-Token": action.token,
    },
    method: "DELETE",
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Conflict repair could not be cancelled",
      ),
    );
  }
  const snapshot = parseRepairEvent(payload);
  if (
    snapshot.type !== "snapshot" ||
    !snapshot.terminal ||
    !matchesRepair(snapshot, action, pull)
  ) {
    throw new Error("Conflict repair returned an unexpected response.");
  }
  return snapshot;
};

const parseVerificationEvent = (value: unknown): VerificationRunEvent => {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    throw new Error("Claude returned an invalid verification event.");
  }

  switch (value.type) {
    case "start":
      if (
        hasOnlyKeys(value, [
          "headSha",
          "pullNumber",
          "pullUrl",
          "releaseId",
          "repository",
          "runId",
          "tag",
          "type",
        ]) &&
        isSha(value.headSha) &&
        isInteger(value.pullNumber, 1) &&
        isValidUrl(value.pullUrl) &&
        isNonEmptyString(value.releaseId) &&
        isRepository(value.repository) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.tag)
      ) {
        return {
          headSha: value.headSha,
          pullNumber: value.pullNumber,
          pullUrl: value.pullUrl,
          releaseId: value.releaseId,
          repository: value.repository,
          runId: value.runId,
          tag: value.tag,
          type: "start",
        };
      }
      break;
    case "text":
    case "diagnostic":
      if (
        hasOnlyKeys(value, ["text", "type"]) &&
        typeof value.text === "string"
      ) {
        return { text: value.text, type: value.type };
      }
      break;
    case "tool":
      if (
        hasOnlyKeys(value, ["name", "status", "type"]) &&
        isNonEmptyString(value.name) &&
        (value.status === undefined || typeof value.status === "string")
      ) {
        return value.status === undefined
          ? { name: value.name, type: "tool" }
          : { name: value.name, status: value.status, type: "tool" };
      }
      break;
    case "complete":
      if (
        hasOnlyKeys(value, ["exitCode", "type"]) &&
        isInteger(value.exitCode)
      ) {
        return { exitCode: value.exitCode, type: "complete" };
      }
      break;
    case "error":
    case "limit":
      if (
        hasOnlyKeys(value, ["message", "type"]) &&
        isNonEmptyString(value.message)
      ) {
        return { message: value.message, type: value.type };
      }
      break;
    case "cancelled":
      if (
        hasOnlyKeys(value, ["message", "type"]) &&
        (value.message === undefined || isNonEmptyString(value.message))
      ) {
        return value.message === undefined
          ? { type: "cancelled" }
          : { message: value.message, type: "cancelled" };
      }
      break;
  }

  throw new Error("Claude returned an invalid verification event.");
};

const isReleaseVerificationState = (
  value: unknown,
): value is ReleaseVerificationState =>
  value === "queued" ||
  value === "running" ||
  value === "complete" ||
  value === "error" ||
  value === "cancelled" ||
  value === "existing";

const isReleaseVerificationPull = (
  value: unknown,
): value is ReleaseVerificationPull =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "headSha",
    "pullNumber",
    "pullUrl",
    "releaseId",
    "repository",
    "tag",
  ]) &&
  isSha(value.headSha) &&
  isInteger(value.pullNumber, 1) &&
  isRepository(value.repository) &&
  value.pullUrl ===
    `https://github.com/${value.repository}/pull/${value.pullNumber}` &&
  /^[1-9][0-9]*$/.test(String(value.releaseId)) &&
  isNonEmptyString(value.tag);

const parseReleaseVerificationEvent = (
  value: unknown,
): ReleaseVerificationEvent => {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    throw new Error("Claude returned an invalid release verification event.");
  }

  if (value.type === "batch-start") {
    if (
      hasOnlyKeys(value, [
        "batchId",
        "pulls",
        "releaseId",
        "repository",
        "tag",
        "type",
      ]) &&
      isNonEmptyString(value.batchId) &&
      Array.isArray(value.pulls) &&
      value.pulls.every(isReleaseVerificationPull) &&
      new Set(value.pulls.map((pull) => pull.pullUrl)).size ===
        value.pulls.length &&
      /^[1-9][0-9]*$/.test(String(value.releaseId)) &&
      isRepository(value.repository) &&
      isNonEmptyString(value.tag) &&
      value.pulls.every(
        (pull) =>
          pull.releaseId === value.releaseId &&
          pull.repository.toLowerCase() ===
            String(value.repository).toLowerCase() &&
          pull.tag === value.tag,
      )
    ) {
      return {
        batchId: value.batchId,
        pulls: value.pulls,
        releaseId: String(value.releaseId),
        repository: value.repository,
        tag: value.tag,
        type: "batch-start",
      };
    }
  } else if (value.type === "verification") {
    if (
      hasOnlyKeys(value, [
        "batchId",
        "code",
        "event",
        "headSha",
        "message",
        "pullNumber",
        "pullUrl",
        "state",
        "type",
      ]) &&
      isNonEmptyString(value.batchId) &&
      isSha(value.headSha) &&
      isInteger(value.pullNumber, 1) &&
      isValidUrl(value.pullUrl) &&
      isReleaseVerificationState(value.state) &&
      (value.code === undefined || isNonEmptyString(value.code)) &&
      (value.message === undefined || isNonEmptyString(value.message))
    ) {
      const event =
        value.event === undefined
          ? undefined
          : parseVerificationEvent(value.event);
      const validEvent =
        (value.state === "queued" &&
          event === undefined &&
          value.code === undefined &&
          value.message === undefined) ||
        (value.state === "running" &&
          event !== undefined &&
          ["start", "text", "tool", "diagnostic"].includes(event.type)) ||
        (value.state === "complete" && event?.type === "complete") ||
        (value.state === "cancelled" && event?.type === "cancelled") ||
        (value.state === "error" &&
          (event?.type === "error" ||
            event?.type === "limit" ||
            (event === undefined &&
              isNonEmptyString(value.code) &&
              isNonEmptyString(value.message)))) ||
        (value.state === "existing" &&
          event === undefined &&
          isNonEmptyString(value.code) &&
          isNonEmptyString(value.message));

      if (validEvent) {
        return {
          batchId: value.batchId,
          ...(value.code === undefined ? {} : { code: value.code }),
          ...(event === undefined ? {} : { event }),
          headSha: value.headSha,
          ...(value.message === undefined ? {} : { message: value.message }),
          pullNumber: value.pullNumber,
          pullUrl: value.pullUrl,
          state: value.state,
          type: "verification",
        };
      }
    }
  } else if (value.type === "complete") {
    const totals = value.totals;
    if (
      hasOnlyKeys(value, ["batchId", "totals", "type"]) &&
      isNonEmptyString(value.batchId) &&
      isRecord(totals) &&
      hasOnlyKeys(totals, ["complete", "error", "existing", "total"]) &&
      isInteger(totals.complete) &&
      isInteger(totals.error) &&
      isInteger(totals.existing) &&
      isInteger(totals.total) &&
      totals.complete + totals.error + totals.existing === totals.total
    ) {
      return {
        batchId: value.batchId,
        totals: {
          complete: totals.complete,
          error: totals.error,
          existing: totals.existing,
          total: totals.total,
        },
        type: "complete",
      };
    }
  } else if (
    value.type === "cancelled" &&
    hasOnlyKeys(value, ["batchId", "message", "type"]) &&
    isNonEmptyString(value.batchId) &&
    isNonEmptyString(value.message)
  ) {
    return {
      batchId: value.batchId,
      message: value.message,
      type: "cancelled",
    };
  }

  throw new Error("Claude returned an invalid release verification event.");
};

export async function* streamVerification(
  request: VerificationRunRequest,
  signal?: AbortSignal,
): AsyncGenerator<VerificationRunEvent, void, undefined> {
  if (
    !isSha(request.headSha) ||
    !isInteger(request.pullNumber, 1) ||
    !isValidUrl(request.pullUrl) ||
    !isNonEmptyString(request.releaseId) ||
    !isRepository(request.repository) ||
    !isNonEmptyString(request.tag)
  ) {
    throw new Error("The verification request is invalid.");
  }

  const response = await actionFetch(
    "/api/verifications",
    {
      body: JSON.stringify(request),
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );

  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Claude verification could not start",
      ),
    );
  }
  if (!response.body)
    throw new Error("Claude returned an empty verification stream.");

  let eventIndex = 0;
  let terminal = false;
  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error("Claude returned malformed verification stream data.");
    }

    const event = parseVerificationEvent(payload);
    if (eventIndex === 0 && event.type !== "start") {
      throw new Error(
        "Claude returned a verification stream without a start event.",
      );
    }
    if (eventIndex > 0 && event.type === "start") {
      throw new Error(
        "Claude returned more than one verification start event.",
      );
    }
    if (event.type === "start") {
      const sameRequest =
        event.releaseId === request.releaseId &&
        event.repository.toLowerCase() === request.repository.toLowerCase() &&
        event.tag === request.tag &&
        event.pullNumber === request.pullNumber &&
        event.pullUrl === request.pullUrl &&
        event.headSha.toLowerCase() === request.headSha.toLowerCase();
      if (!sameRequest) {
        throw new Error(
          "Claude started verification for a different released pull request.",
        );
      }
    }
    if (terminal)
      throw new Error(
        "Claude returned data after a terminal verification event.",
      );

    eventIndex += 1;
    terminal = ["cancelled", "complete", "error", "limit"].includes(event.type);
    yield event;
  }

  if (eventIndex === 0)
    throw new Error("Claude returned an empty verification stream.");
  if (!terminal)
    throw new Error(
      "Claude disconnected before reporting verification completion.",
    );
}

export async function* streamReleaseVerification(
  request: ReleaseVerificationRequest,
  signal?: AbortSignal,
): AsyncGenerator<ReleaseVerificationEvent, void, undefined> {
  if (
    !isRepository(request.repository) ||
    !/^[1-9][0-9]*$/.test(request.releaseId) ||
    !isNonEmptyString(request.tag)
  ) {
    throw new Error("The release verification request is invalid.");
  }

  const response = await actionFetch(
    "/api/releases/verifications",
    {
      body: JSON.stringify(request),
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );

  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Release verification could not start",
      ),
    );
  }
  if (!response.body) {
    throw new Error("Claude returned an empty release verification stream.");
  }

  let batchId: string | null = null;
  let listed = new Map<
    string,
    Pick<ReleaseVerificationPull, "headSha" | "pullNumber"> & {
      state: ReleaseVerificationState | null;
    }
  >();
  let terminal = false;
  let eventIndex = 0;

  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error(
        "Claude returned malformed release verification stream data.",
      );
    }

    const event = parseReleaseVerificationEvent(payload);
    if (eventIndex === 0 && event.type !== "batch-start") {
      throw new Error(
        "Claude returned a release verification stream without a batch start event.",
      );
    }
    if (eventIndex > 0 && event.type === "batch-start") {
      throw new Error(
        "Claude returned more than one release verification batch start event.",
      );
    }
    if (terminal) {
      throw new Error(
        "Claude returned data after a terminal release verification event.",
      );
    }

    if (event.type === "batch-start") {
      if (
        event.releaseId !== request.releaseId ||
        event.repository.toLowerCase() !== request.repository.toLowerCase() ||
        event.tag !== request.tag
      ) {
        throw new Error("Claude started verification for a different release.");
      }
      batchId = event.batchId;
      listed = new Map(
        event.pulls.map((pull) => [
          pull.pullUrl,
          {
            headSha: pull.headSha,
            pullNumber: pull.pullNumber,
            state: null,
          },
        ]),
      );
    } else {
      if (batchId === null || event.batchId !== batchId) {
        throw new Error(
          "Claude returned a mismatched release verification identity.",
        );
      }
      if (event.type === "verification") {
        const pull = listed.get(event.pullUrl);
        if (
          !pull ||
          pull.pullNumber !== event.pullNumber ||
          pull.headSha.toLowerCase() !== event.headSha.toLowerCase()
        ) {
          throw new Error(
            "Claude returned verification for an unlisted released pull request.",
          );
        }
        const terminalState =
          pull.state === "complete" ||
          pull.state === "error" ||
          pull.state === "cancelled" ||
          pull.state === "existing";
        const validTransition =
          !terminalState &&
          (event.state === "queued"
            ? pull.state === null
            : event.state === "running"
              ? pull.state === "queued" || pull.state === "running"
              : pull.state === "queued" || pull.state === "running");
        if (!validTransition) {
          throw new Error(
            "Claude returned an invalid release verification state transition.",
          );
        }
        pull.state = event.state;
      } else if (event.type === "complete") {
        const states = [...listed.values()].map((pull) => pull.state);
        const totals = {
          complete: states.filter((state) => state === "complete").length,
          error: states.filter((state) => state === "error").length,
          existing: states.filter((state) => state === "existing").length,
          total: listed.size,
        };
        if (
          states.some(
            (state) =>
              state !== "complete" && state !== "error" && state !== "existing",
          ) ||
          event.totals.complete !== totals.complete ||
          event.totals.error !== totals.error ||
          event.totals.existing !== totals.existing ||
          event.totals.total !== totals.total
        ) {
          throw new Error(
            "Claude returned inconsistent release verification totals.",
          );
        }
      }
    }

    eventIndex += 1;
    terminal = event.type === "complete" || event.type === "cancelled";
    yield event;
  }

  if (eventIndex === 0) {
    throw new Error("Claude returned an empty release verification stream.");
  }
  if (!terminal) {
    throw new Error(
      "Claude disconnected before reporting release verification completion.",
    );
  }
}

export const cancelVerification = async (
  runId: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (!isNonEmptyString(runId))
    throw new Error("The verification run identity is invalid.");

  const response = await actionFetch(
    `/api/verifications/${encodeURIComponent(runId)}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    signal,
  );
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Claude verification could not stop",
      ),
    );
  }
};

export const cancelReleaseVerification = async (
  batchId: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(batchId)) {
    throw new Error("The release verification identity is invalid.");
  }

  const response = await actionFetch(
    `/api/releases/verifications/${encodeURIComponent(batchId)}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    signal,
  );
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(
      getErrorMessage(
        response.status,
        payload,
        "Release verification could not stop",
      ),
    );
  }
};

export const resetApiActionTokenForTests = (): void => {
  cachedActionToken = null;
};

export const resetPullRequestCachesForTests = (): void => {
  clearPullRequestArtifacts();
  artifactViewer = undefined;
};

export const getPullRequestCacheStatsForTests = (): {
  checkLogs: { entries: number; scopes: number };
  diffs: { entries: number; scopes: number };
} => ({ checkLogs: checkLogCache.stats(), diffs: diffCache.stats() });

export const resetCheckLogCacheForTests = resetPullRequestCachesForTests;
