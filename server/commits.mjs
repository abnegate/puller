import { DEFAULT_DIFF_BUDGET, MAXIMUM_FILES, parsePatch } from "./diff.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATUSES = new Set([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
  "unchanged",
]);

export const COMMITS_PER_PAGE = 100;
export const MAXIMUM_COMMITS = 250;
export const COMMIT_FILES_PER_PAGE = 100;
export const DEFAULT_COMMITS_BUDGET = DEFAULT_DIFF_BUDGET;

const ERRORS = {
  budget: [
    502,
    "commit_diff_too_large",
    "The commit diff cannot fit within the response budget.",
  ],
  incomplete: [
    503,
    "pull_commits_incomplete",
    "GitHub could not completely revalidate these pull request commits.",
  ],
  missing: [
    404,
    "commit_missing",
    "The commit is not part of this pull request.",
  ],
  listBudget: [
    502,
    "commits_too_large",
    "The pull request commit list cannot fit within the response budget.",
  ],
  stale: [
    409,
    "stale_head",
    "The pull request changed. Refresh before opening its commits.",
  ],
};

const COMMIT_CAP_WARNING =
  "GitHub limits pull-request commit listings to 250 commits, so this list is incomplete.";
const COMMIT_BUDGET_WARNING =
  "The pull request commit list stopped at a commit boundary because it exceeded the response budget.";
const FILE_CAP_WARNING =
  "GitHub limits commit file pagination to 3,000 files, so this diff may be incomplete.";
const BUDGET_WARNING =
  "The commit diff stopped at a file boundary because it exceeded the response budget.";

export class CommitsError extends Error {
  constructor(kind) {
    const [status, code, message] = ERRORS[kind] ?? ERRORS.incomplete;
    super(message);
    this.name = "CommitsError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function validateMaximumBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function validateRequest(value, commit = false) {
  if (!isRecord(value)) throw new TypeError("request must be an object.");
  if (
    typeof value.repository !== "string" ||
    !REPOSITORY.test(value.repository) ||
    value.repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError("repository must be an owner/name identifier.");
  }
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new TypeError("number must be a positive integer.");
  }
  if (
    typeof value.expectedBaseRefOid !== "string" ||
    !SHA.test(value.expectedBaseRefOid)
  ) {
    throw new TypeError("expectedBaseRefOid must be a full commit SHA.");
  }
  if (
    typeof value.expectedHeadRefOid !== "string" ||
    !SHA.test(value.expectedHeadRefOid)
  ) {
    throw new TypeError("expectedHeadRefOid must be a full commit SHA.");
  }
  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  if (
    commit &&
    (typeof value.commitSha !== "string" || !SHA.test(value.commitSha))
  ) {
    throw new TypeError("commitSha must be a full commit SHA.");
  }

  return Object.freeze({
    ...(commit ? { commitSha: value.commitSha.toLowerCase() } : {}),
    expectedBaseRefOid: value.expectedBaseRefOid.toLowerCase(),
    expectedHeadRefOid: value.expectedHeadRefOid.toLowerCase(),
    number: value.number,
    repository: value.repository,
    signal: value.signal,
  });
}

function pullUrl(value, repository, number) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.toLowerCase() ===
        `/${repository}/pull/${number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function commitUrl(value, repository, sha) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.toLowerCase() ===
        `/${repository}/commit/${sha}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function validateAuthorization(value, input) {
  if (
    !isRecord(value) ||
    typeof value.authorLogin !== "string" ||
    value.authorLogin.trim() === "" ||
    typeof value.viewerLogin !== "string" ||
    value.viewerLogin.trim() === "" ||
    typeof value.repository !== "string" ||
    value.repository.toLowerCase() !== input.repository.toLowerCase() ||
    value.number !== input.number ||
    !pullUrl(value.url, input.repository, input.number) ||
    typeof value.baseRefOid !== "string" ||
    !SHA.test(value.baseRefOid) ||
    typeof value.headRefOid !== "string" ||
    !SHA.test(value.headRefOid) ||
    typeof value.headRefName !== "string" ||
    value.headRefName.trim() === "" ||
    typeof value.headRepository !== "string" ||
    !REPOSITORY.test(value.headRepository) ||
    typeof value.isCrossRepository !== "boolean" ||
    !nonNegativeInteger(value.commitCount)
  ) {
    throw new CommitsError("incomplete");
  }
  if (
    value.baseRefOid.toLowerCase() !== input.expectedBaseRefOid ||
    value.headRefOid.toLowerCase() !== input.expectedHeadRefOid
  ) {
    throw new CommitsError("stale");
  }

  return Object.freeze({
    authorLogin: value.authorLogin.trim(),
    baseRefOid: value.baseRefOid.toLowerCase(),
    commitCount: value.commitCount,
    headRefName: value.headRefName,
    headRefOid: value.headRefOid.toLowerCase(),
    headRepository: value.headRepository,
    isCrossRepository: value.isCrossRepository,
    number: value.number,
    repository: value.repository,
    url: value.url,
    viewerLogin: value.viewerLogin.trim(),
  });
}

function sameAuthorization(initial, current) {
  return (
    current.repository.toLowerCase() === initial.repository.toLowerCase() &&
    current.number === initial.number &&
    current.url.toLowerCase() === initial.url.toLowerCase() &&
    current.baseRefOid === initial.baseRefOid &&
    current.headRefOid === initial.headRefOid &&
    current.headRefName === initial.headRefName &&
    current.headRepository.toLowerCase() ===
      initial.headRepository.toLowerCase() &&
    current.isCrossRepository === initial.isCrossRepository &&
    current.commitCount === initial.commitCount &&
    current.authorLogin.toLowerCase() === initial.authorLogin.toLowerCase() &&
    current.viewerLogin.toLowerCase() === initial.viewerLogin.toLowerCase()
  );
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function raceAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function authorizationError(error) {
  if (error?.name === "AbortError" || error instanceof CommitsError)
    return error;
  if (error?.code === "stale") return new CommitsError("stale");
  if (error?.code === "not_found") return new CommitsError("missing");
  return new CommitsError("incomplete");
}

async function authorize(authorizer, input, expectedViewerLogin) {
  throwIfAborted(input.signal);
  const value = {
    expectedBaseRefOid: input.expectedBaseRefOid,
    expectedHeadRefOid: input.expectedHeadRefOid,
    number: input.number,
    repository: input.repository,
  };
  if (expectedViewerLogin !== undefined)
    value.expectedViewerLogin = expectedViewerLogin;

  let proof;
  try {
    proof = await raceAbort(
      Promise.resolve().then(() =>
        input.signal === undefined
          ? authorizer.authorizePullCommits(value)
          : authorizer.authorizePullCommits(value, input.signal),
      ),
      input.signal,
    );
  } catch (error) {
    throwIfAborted(input.signal);
    throw authorizationError(error);
  }
  throwIfAborted(input.signal);
  return validateAuthorization(proof, input);
}

function repositoryParts(repository) {
  const [owner, name] = repository.split("/");
  return {
    name: encodeURIComponent(name),
    owner: encodeURIComponent(owner),
  };
}

function commitsEndpoint(repository, number, page) {
  const { name, owner } = repositoryParts(repository);
  return `repos/${owner}/${name}/pulls/${number}/commits?per_page=${COMMITS_PER_PAGE}&page=${page}`;
}

function commitEndpoint(repository, sha, page) {
  const { name, owner } = repositoryParts(repository);
  return `repos/${owner}/${name}/commits/${sha}?per_page=${COMMIT_FILES_PER_PAGE}&page=${page}`;
}

function normalizeCommit(value, repository) {
  const sha =
    typeof value?.sha === "string" && SHA.test(value.sha)
      ? value.sha.toLowerCase()
      : null;
  const author =
    value?.author === null
      ? null
      : isRecord(value?.author) &&
          typeof value.author.login === "string" &&
          value.author.login.trim() !== ""
        ? value.author.login
        : undefined;
  const authoredAt = value?.commit?.author?.date;
  const authorName = value?.commit?.author?.name;
  const message = value?.commit?.message;
  if (
    sha === null ||
    author === undefined ||
    typeof authoredAt !== "string" ||
    Number.isNaN(Date.parse(authoredAt)) ||
    typeof authorName !== "string" ||
    authorName.trim() === "" ||
    typeof message !== "string" ||
    !commitUrl(value.html_url, repository, sha)
  ) {
    return null;
  }

  return {
    authorLogin: author,
    authorName,
    authoredAt,
    message,
    sha,
    url: value.html_url,
  };
}

function addWarning(warnings, warning) {
  if (warning && !warnings.includes(warning)) warnings.push(warning);
}

function commitsResult(authorization, commits, complete, warnings) {
  return {
    baseRefOid: authorization.baseRefOid,
    commits,
    complete,
    count: authorization.commitCount,
    headRefOid: authorization.headRefOid,
    number: authorization.number,
    repository: authorization.repository,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

function fitCommitList(
  authorization,
  commits,
  complete,
  warnings,
  maximumBytes,
) {
  let response = commitsResult(authorization, commits, complete, warnings);
  if (serializedBytes(response) <= maximumBytes) return response;

  const budgetWarnings = [...warnings];
  addWarning(budgetWarnings, COMMIT_BUDGET_WARNING);
  let lower = 0;
  let upper = commits.length;
  let fitted = null;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    response = commitsResult(
      authorization,
      commits.slice(0, middle),
      false,
      budgetWarnings,
    );
    if (serializedBytes(response) <= maximumBytes) {
      fitted = response;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  if (fitted !== null) return fitted;
  throw new CommitsError("listBudget");
}

async function collectPullCommits({
  authorization,
  maximumBytes,
  rest,
  signal,
}) {
  const target = Math.min(authorization.commitCount, MAXIMUM_COMMITS);
  const commits = [];
  const shas = new Set();
  const warnings = [];
  let reliable = true;

  for (
    let page = 1;
    commits.length < target &&
    page <= Math.ceil(MAXIMUM_COMMITS / COMMITS_PER_PAGE);
    page += 1
  ) {
    let values = await rest(
      commitsEndpoint(authorization.repository, authorization.number, page),
      {
        signal,
        validate: Array.isArray,
      },
    );
    throwIfAborted(signal);
    if (!Array.isArray(values)) throw new CommitsError("incomplete");
    if (values.length > COMMITS_PER_PAGE) {
      reliable = false;
      addWarning(
        warnings,
        "GitHub returned more pull-request commits than requested in one page.",
      );
      values = values.slice(0, COMMITS_PER_PAGE);
    }

    const remaining = target - commits.length;
    if (values.length > remaining) {
      reliable = false;
      addWarning(
        warnings,
        "GitHub returned more commits than the pull request reports.",
      );
      values = values.slice(0, remaining);
    }
    for (const value of values) {
      const commit = normalizeCommit(value, authorization.repository);
      if (commit === null) {
        reliable = false;
        addWarning(warnings, "GitHub returned malformed commit metadata.");
        continue;
      }
      if (shas.has(commit.sha)) {
        reliable = false;
        addWarning(warnings, "GitHub returned duplicate pull-request commits.");
        continue;
      }
      shas.add(commit.sha);
      commits.push(commit);
    }
    if (values.length < COMMITS_PER_PAGE) break;
  }

  if (commits.length !== target) {
    reliable = false;
    addWarning(
      warnings,
      "GitHub returned a different number of commits than the pull request reports.",
    );
  }
  const capped = authorization.commitCount > MAXIMUM_COMMITS;
  if (capped) addWarning(warnings, COMMIT_CAP_WARNING);
  const complete = reliable && !capped;
  return {
    membershipReliable: reliable,
    response: fitCommitList(
      authorization,
      commits,
      complete,
      warnings,
      maximumBytes,
    ),
  };
}

function normalizeFile(value) {
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    value.filename.length === 0
  ) {
    return { file: null, warning: "GitHub returned malformed file metadata." };
  }

  let warning = null;
  const additions = nonNegativeInteger(value.additions) ? value.additions : 0;
  const deletions = nonNegativeInteger(value.deletions) ? value.deletions : 0;
  const changes = nonNegativeInteger(value.changes)
    ? value.changes
    : additions + deletions;
  if (
    !nonNegativeInteger(value.additions) ||
    !nonNegativeInteger(value.deletions) ||
    !nonNegativeInteger(value.changes)
  ) {
    warning = "GitHub returned malformed change counts.";
  }

  const status = STATUSES.has(value.status) ? value.status : "changed";
  if (!STATUSES.has(value.status))
    warning ??= "GitHub returned an unknown file status.";
  const previousPath =
    value.previous_filename === undefined || value.previous_filename === null
      ? null
      : typeof value.previous_filename === "string"
        ? value.previous_filename
        : null;
  if (
    value.previous_filename !== undefined &&
    value.previous_filename !== null &&
    previousPath === null
  ) {
    warning ??= "GitHub returned malformed rename metadata.";
  }
  if ((status === "renamed" || status === "copied") && previousPath === null) {
    warning ??= "GitHub omitted rename metadata.";
  }

  const blobUrl = typeof value.blob_url === "string" ? value.blob_url : "";
  const rawUrl = typeof value.raw_url === "string" ? value.raw_url : "";
  if (blobUrl === "" || rawUrl === "") warning ??= "GitHub omitted file links.";

  const hasPatch =
    Object.hasOwn(value, "patch") && typeof value.patch === "string";
  const patchMalformed =
    Object.hasOwn(value, "patch") &&
    value.patch !== null &&
    value.patch !== undefined &&
    typeof value.patch !== "string";
  const pureMove =
    (status === "renamed" || status === "copied") && changes === 0;
  const binary = !hasPatch && !patchMalformed && changes === 0 && !pureMove;
  let parsed = { additions: 0, deletions: 0, hunks: [], truncated: false };
  let truncated = false;

  if (hasPatch) {
    parsed = parsePatch(value.patch);
    truncated =
      parsed.truncated ||
      parsed.additions !== additions ||
      parsed.deletions !== deletions;
    if (truncated) warning ??= "GitHub returned a truncated textual patch.";
  } else if (!binary && !pureMove && changes > 0) {
    truncated = true;
    warning ??=
      "GitHub omitted a textual patch, likely because the file is too large.";
  } else if (patchMalformed) {
    truncated = true;
    warning ??= "GitHub returned malformed patch data.";
  }

  return {
    file: {
      additions,
      binary,
      blobUrl,
      changes,
      deletions,
      hunks: parsed.hunks,
      path: value.filename,
      previousPath,
      rawUrl,
      status,
      truncated,
    },
    warning,
  };
}

function commitFingerprint(value, repository, sha) {
  const normalized = normalizeCommit(value, repository);
  return normalized !== null && normalized.sha === sha
    ? JSON.stringify(normalized)
    : null;
}

function commitDiffResult(authorization, commitSha, complete, files, warnings) {
  return {
    baseRefOid: authorization.baseRefOid,
    commitSha,
    complete,
    files,
    headRefOid: authorization.headRefOid,
    number: authorization.number,
    repository: authorization.repository,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function collectCommitDiff({
  authorization,
  commitSha,
  maximumBytes,
  rest,
  signal,
}) {
  const files = [];
  const paths = new Set();
  const warnings = [];
  let bytes = 0;
  let complete = true;
  let exhausted = false;
  let fingerprint = null;

  for (let page = 1; page <= MAXIMUM_FILES / COMMIT_FILES_PER_PAGE; page += 1) {
    const value = await rest(
      commitEndpoint(authorization.repository, commitSha, page),
      {
        signal,
        validate: isRecord,
      },
    );
    throwIfAborted(signal);
    if (!isRecord(value) || !Array.isArray(value.files)) {
      throw new CommitsError("incomplete");
    }
    const currentFingerprint = commitFingerprint(
      value,
      authorization.repository,
      commitSha,
    );
    if (
      currentFingerprint === null ||
      (fingerprint !== null && currentFingerprint !== fingerprint)
    ) {
      throw new CommitsError("incomplete");
    }
    fingerprint = currentFingerprint;

    let values = value.files;
    if (values.length > COMMIT_FILES_PER_PAGE) {
      complete = false;
      addWarning(
        warnings,
        "GitHub returned more commit files than requested in one page.",
      );
      values = values.slice(0, COMMIT_FILES_PER_PAGE);
    }

    for (const rawFile of values) {
      const normalized = normalizeFile(rawFile);
      if (normalized.file === null) {
        complete = false;
        addWarning(warnings, normalized.warning);
        continue;
      }
      if (paths.has(normalized.file.path)) {
        complete = false;
        addWarning(warnings, "GitHub returned duplicate commit file entries.");
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(normalized.file), "utf8");
      if (bytes + size > maximumBytes) {
        complete = false;
        addWarning(warnings, BUDGET_WARNING);
        exhausted = true;
        break;
      }
      bytes += size;
      paths.add(normalized.file.path);
      files.push(normalized.file);
      if (normalized.warning) {
        complete = false;
        addWarning(warnings, normalized.warning);
      }
    }
    if (exhausted) break;
    if (values.length < COMMIT_FILES_PER_PAGE) {
      exhausted = true;
      break;
    }
    if (page === MAXIMUM_FILES / COMMIT_FILES_PER_PAGE) {
      complete = false;
      addWarning(warnings, FILE_CAP_WARNING);
    }
  }

  let result = commitDiffResult(
    authorization,
    commitSha,
    complete,
    files,
    warnings,
  );
  if (serializedBytes(result) <= maximumBytes) return result;

  complete = false;
  addWarning(warnings, BUDGET_WARNING);
  result = commitDiffResult(
    authorization,
    commitSha,
    complete,
    files,
    warnings,
  );
  while (files.length > 0 && serializedBytes(result) > maximumBytes) {
    files.pop();
    result = commitDiffResult(
      authorization,
      commitSha,
      complete,
      files,
      warnings,
    );
  }
  if (serializedBytes(result) > maximumBytes) throw new CommitsError("budget");
  return result;
}

function createCache(maximumBytes) {
  let bytes = 0;
  const entries = new Map();
  const scopes = new Map();

  const cleanup = (scope) => {
    if (
      scope.users === 0 &&
      scope.entries.size === 0 &&
      scopes.get(scope.key) === scope
    ) {
      scopes.delete(scope.key);
    }
  };
  const deleteEntry = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.scope.entries.delete(key);
    bytes -= entry.bytes;
    cleanup(entry.scope);
  };
  const acquire = (authorization) => {
    const key = JSON.stringify([
      authorization.viewerLogin.toLowerCase(),
      authorization.repository.toLowerCase(),
      authorization.number,
    ]);
    const generation = JSON.stringify([
      authorization.baseRefOid,
      authorization.headRefOid,
      authorization.headRefName,
      authorization.headRepository.toLowerCase(),
      authorization.isCrossRepository,
      authorization.commitCount,
    ]);
    let scope = scopes.get(key);
    if (!scope || scope.generation !== generation) {
      if (scope) {
        for (const entryKey of [...scope.entries]) deleteEntry(entryKey);
      }
      scope = {
        entries: new Set(),
        generation,
        key,
        number: authorization.number,
        repository: authorization.repository.toLowerCase(),
        users: 0,
        viewerLogin: authorization.viewerLogin.toLowerCase(),
      };
      scopes.set(key, scope);
    }
    scope.users += 1;
    return scope;
  };
  const release = (scope) => {
    scope.users -= 1;
    cleanup(scope);
  };
  const get = (key, scope) => {
    if (scopes.get(scope.key) !== scope) return null;
    const entry = entries.get(key);
    if (!entry || entry.scope !== scope) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };
  const set = (key, scope, value) => {
    if (scopes.get(scope.key) !== scope) return;
    const size = serializedBytes(value);
    if (size > maximumBytes) return;
    deleteEntry(key);
    while (bytes + size > maximumBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      deleteEntry(oldest);
    }
    entries.set(key, { bytes: size, scope, value });
    scope.entries.add(key);
    bytes += size;
  };
  const invalidate = (value = {}) => {
    const filter = isRecord(value) ? value : {};
    const repository =
      typeof filter.repository === "string"
        ? filter.repository.toLowerCase()
        : null;
    const viewerLogin =
      typeof filter.viewerLogin === "string"
        ? filter.viewerLogin.toLowerCase()
        : null;
    for (const scope of [...scopes.values()]) {
      if (
        (repository !== null && scope.repository !== repository) ||
        (viewerLogin !== null && scope.viewerLogin !== viewerLogin) ||
        (filter.number !== undefined && scope.number !== filter.number)
      ) {
        continue;
      }
      for (const key of [...scope.entries]) deleteEntry(key);
      if (scopes.get(scope.key) === scope) scopes.delete(scope.key);
    }
  };

  return Object.freeze({ acquire, get, invalidate, release, set });
}

function subscribe(requests, key, start, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  let request = requests.get(key);
  if (request?.controller.signal.aborted) {
    requests.delete(key);
    request = undefined;
  }
  if (!request) {
    const controller = new AbortController();
    const next = {
      controller,
      promise: Promise.resolve().then(() => start(controller.signal)),
      waiters: new Set(),
    };
    next.promise = next.promise.finally(() => {
      if (requests.get(key) === next) requests.delete(key);
    });
    requests.set(key, next);
    request = next;
  }
  const current = request;
  const waiter = Symbol(key);
  current.waiters.add(waiter);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", cancel);
      current.waiters.delete(waiter);
    };
    const finish = (complete) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const cancel = () => {
      finish(() => reject(abortError(signal)));
      if (current.waiters.size === 0 && !current.controller.signal.aborted) {
        if (requests.get(key) === current) requests.delete(key);
        current.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    void current.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function createCommitsService({
  authorizer,
  cacheBytes = DEFAULT_COMMITS_BUDGET,
  executor,
  maximumBytes = DEFAULT_COMMITS_BUDGET,
} = {}) {
  if (!authorizer || typeof authorizer.authorizePullCommits !== "function") {
    throw new TypeError(
      "authorizer with an authorizePullCommits method is required.",
    );
  }
  if (!executor || typeof executor.rest !== "function") {
    throw new TypeError("executor with a rest method is required.");
  }
  validateMaximumBytes(cacheBytes, "cacheBytes");
  validateMaximumBytes(maximumBytes, "maximumBytes");

  const cache = createCache(cacheBytes);
  const listRequests = new Map();
  const diffRequests = new Map();

  const loadListFor = async (authorization, scope, signal) => {
    const key = `${scope.key}:${scope.generation}:commits`;
    const cached = cache.get(key, scope);
    if (cached !== null) return cached;
    const collected = await subscribe(
      listRequests,
      key,
      (sharedSignal) =>
        collectPullCommits({
          authorization,
          maximumBytes,
          rest: (endpoint, options) => executor.rest(endpoint, options),
          signal: sharedSignal,
        }),
      signal,
    );
    cache.set(key, scope, collected);
    return collected;
  };

  const loadAuthorized = async (value) => {
    const input = validateRequest(value);
    const initial = await authorize(authorizer, input);
    const scope = cache.acquire(initial);
    try {
      const collected = await loadListFor(initial, scope, input.signal);
      throwIfAborted(input.signal);
      const current = await authorize(authorizer, input, initial.viewerLogin);
      if (!sameAuthorization(initial, current)) throw new CommitsError("stale");
      return Object.freeze({
        authorization: current,
        commits: collected.response,
      });
    } finally {
      cache.release(scope);
    }
  };

  const load = async (value) => (await loadAuthorized(value)).commits;

  const loadCommitDiff = async (value) => {
    const input = validateRequest(value, true);
    const initial = await authorize(authorizer, input);
    const scope = cache.acquire(initial);
    try {
      const collected = await loadListFor(initial, scope, input.signal);
      if (
        !collected.membershipReliable ||
        collected.response.commits.filter(
          (commit) => commit.sha === input.commitSha,
        ).length !== 1
      ) {
        throw new CommitsError("missing");
      }

      const key = `${scope.key}:${scope.generation}:commit:${input.commitSha}`;
      const cached = cache.get(key, scope);
      const diff =
        cached ??
        (await subscribe(
          diffRequests,
          key,
          (sharedSignal) =>
            collectCommitDiff({
              authorization: initial,
              commitSha: input.commitSha,
              maximumBytes,
              rest: (endpoint, options) => executor.rest(endpoint, options),
              signal: sharedSignal,
            }),
          input.signal,
        ));
      throwIfAborted(input.signal);
      const current = await authorize(authorizer, input, initial.viewerLogin);
      if (!sameAuthorization(initial, current)) throw new CommitsError("stale");
      if (cached === null) cache.set(key, scope, diff);
      return diff;
    } finally {
      cache.release(scope);
    }
  };

  const invalidate = (value) => cache.invalidate(value);
  return Object.freeze({
    invalidate,
    load,
    loadAuthorized,
    loadCommitDiff,
    loadDiff: loadCommitDiff,
  });
}
