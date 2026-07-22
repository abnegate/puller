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

export const FILES_PER_PAGE = 100;
export const MAXIMUM_FILES = 3_000;
export const DEFAULT_DIFF_BUDGET = 16 * 1024 * 1024;

const ERRORS = {
  budget: [
    502,
    "diff_too_large",
    "The pull request diff cannot fit within the response budget.",
  ],
  closed: [409, "pull_closed", "The pull request is no longer open."],
  incomplete: [
    503,
    "pull_incomplete",
    "GitHub could not completely revalidate this pull request.",
  ],
  missing: [
    404,
    "pull_missing",
    "The pull request no longer exists or is unavailable.",
  ],
  not_authored: [
    403,
    "not_authored",
    "The pull request is not in the current GitHub user's authored search.",
  ],
  stale: [
    409,
    "stale_head",
    "The pull request changed. Refresh before opening its diff.",
  ],
};

const BUDGET_WARNING =
  "The diff stopped at a file boundary because it exceeded the response budget.";

export class DiffError extends Error {
  constructor(kind) {
    const [status, code, message] = ERRORS[kind] ?? ERRORS.incomplete;
    super(message);
    this.name = "DiffError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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

function parseHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  if (!match) return null;
  return {
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    newStart: Number(match[3]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    oldStart: Number(match[1]),
  };
}

export function parsePatch(patch) {
  if (typeof patch !== "string") {
    return { additions: 0, deletions: 0, hunks: [], truncated: true };
  }

  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let oldConsumed = 0;
  let newConsumed = 0;

  const closeHunk = () => {
    if (!current) return;
    if (oldConsumed !== current.oldLines || newConsumed !== current.newLines) {
      truncated = true;
    }
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      closeHunk();
      const header = parseHeader(line);
      if (!header) {
        truncated = true;
        current = null;
        continue;
      }
      current = { ...header, header: line, lines: [] };
      hunks.push(current);
      oldLine = header.oldStart;
      newLine = header.newStart;
      oldConsumed = 0;
      newConsumed = 0;
      continue;
    }

    if (!current) {
      truncated = true;
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({
        content: line.slice(1),
        kind: "addition",
        newLine,
        oldLine: null,
      });
      additions += 1;
      newConsumed += 1;
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({
        content: line.slice(1),
        kind: "deletion",
        newLine: null,
        oldLine,
      });
      deletions += 1;
      oldConsumed += 1;
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        content: line.slice(1),
        kind: "context",
        newLine,
        oldLine,
      });
      newConsumed += 1;
      newLine += 1;
      oldConsumed += 1;
      oldLine += 1;
    } else if (line === "\\ No newline at end of file") {
      current.lines.push({
        content: line,
        kind: "meta",
        newLine: null,
        oldLine: null,
      });
    } else {
      current.lines.push({
        content: line,
        kind: "meta",
        newLine: null,
        oldLine: null,
      });
      truncated = true;
    }
  }
  closeHunk();

  if (lines.length > 0 && hunks.length === 0) truncated = true;
  return { additions, deletions, hunks, truncated };
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

function validateRequest(value) {
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

  return Object.freeze({
    expectedBaseRefOid: value.expectedBaseRefOid.toLowerCase(),
    expectedHeadRefOid: value.expectedHeadRefOid.toLowerCase(),
    number: value.number,
    repository: value.repository,
    signal: value.signal,
  });
}

function validateMaximumBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
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
    typeof value.url !== "string" ||
    value.url.toLowerCase() !==
      `https://github.com/${input.repository}/pull/${input.number}`.toLowerCase() ||
    typeof value.baseRefOid !== "string" ||
    !SHA.test(value.baseRefOid) ||
    typeof value.headRefOid !== "string" ||
    !SHA.test(value.headRefOid)
  ) {
    throw new DiffError("incomplete");
  }
  if (
    value.baseRefOid.toLowerCase() !== input.expectedBaseRefOid ||
    value.headRefOid.toLowerCase() !== input.expectedHeadRefOid
  ) {
    throw new DiffError("stale");
  }

  return Object.freeze({
    authorLogin: value.authorLogin.trim(),
    baseRefOid: value.baseRefOid.toLowerCase(),
    headRefOid: value.headRefOid.toLowerCase(),
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
  if (error?.name === "AbortError" || error instanceof DiffError) return error;
  if (error?.code === "stale") return new DiffError("stale");
  if (error?.code === "not_found") return new DiffError("missing");
  return new DiffError("incomplete");
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
          ? authorizer.authorizePull(value)
          : authorizer.authorizePull(value, input.signal),
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

function endpoint(repository, number, page) {
  const [owner, name] = repository.split("/");
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`;
}

function addWarning(warnings, warning) {
  if (warning && !warnings.includes(warning)) warnings.push(warning);
}

function diffResult(authorization, complete, files, warnings) {
  return {
    baseRefOid: authorization.baseRefOid,
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

async function collectPullDiff({ authorization, maximumBytes, rest, signal }) {
  const { number, repository } = authorization;
  if (typeof rest !== "function")
    throw new TypeError("rest must be a function.");
  validateMaximumBytes(maximumBytes, "maximumBytes");
  throwIfAborted(signal);

  const files = [];
  const paths = new Set();
  const warnings = [];
  let bytes = 0;
  let complete = true;
  let exhausted = false;
  let hitCap = false;

  for (let page = 1; page <= MAXIMUM_FILES / FILES_PER_PAGE; page += 1) {
    let values;
    try {
      values = await rest(endpoint(repository, number, page), {
        signal,
        validate: Array.isArray,
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code !== "output_limit") throw error;
      complete = false;
      addWarning(
        warnings,
        "The diff stopped at a file boundary because GitHub exceeded the response budget.",
      );
      break;
    }
    throwIfAborted(signal);

    if (!Array.isArray(values)) {
      complete = false;
      addWarning(warnings, "GitHub returned malformed pull-request files.");
      break;
    }
    if (values.length > FILES_PER_PAGE) {
      complete = false;
      addWarning(
        warnings,
        "GitHub returned more files than requested in one page.",
      );
      values = values.slice(0, FILES_PER_PAGE);
    }

    for (const value of values) {
      const normalized = normalizeFile(value);
      if (normalized.file === null) {
        complete = false;
        addWarning(warnings, normalized.warning);
        continue;
      }
      if (paths.has(normalized.file.path)) {
        complete = false;
        addWarning(warnings, "GitHub returned duplicate file entries.");
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

    if (values.length < FILES_PER_PAGE) {
      exhausted = true;
      break;
    }
    if (page === MAXIMUM_FILES / FILES_PER_PAGE) hitCap = true;
  }

  if (hitCap) {
    complete = false;
    addWarning(
      warnings,
      "GitHub limits pull-request file pagination to 3,000 files, so this diff may be incomplete.",
    );
  }

  let result = diffResult(authorization, complete, files, warnings);
  if (serializedBytes(result) <= maximumBytes) return result;

  complete = false;
  addWarning(warnings, BUDGET_WARNING);
  result = diffResult(authorization, complete, files, warnings);
  while (files.length > 0 && serializedBytes(result) > maximumBytes) {
    files.pop();
    result = diffResult(authorization, complete, files, warnings);
  }
  if (serializedBytes(result) > maximumBytes) throw new DiffError("budget");
  return result;
}

async function loadAuthorized({ authorizer, collect, input }) {
  const initial = await authorize(authorizer, input);
  const result = await collect(initial);
  throwIfAborted(input.signal);
  const current = await authorize(authorizer, input, initial.viewerLogin);
  if (!sameAuthorization(initial, current)) throw new DiffError("stale");
  return { authorization: initial, result };
}

export async function fetchPullDiff(value = {}) {
  const { authorizer, maximumBytes = DEFAULT_DIFF_BUDGET, rest } = value;
  const input = validateRequest(value);
  if (!authorizer || typeof authorizer.authorizePull !== "function") {
    throw new TypeError("authorizer with an authorizePull method is required.");
  }
  if (typeof rest !== "function")
    throw new TypeError("rest must be a function.");
  validateMaximumBytes(maximumBytes, "maximumBytes");

  const { result } = await loadAuthorized({
    authorizer,
    collect: (authorization) =>
      collectPullDiff({
        authorization,
        maximumBytes,
        rest,
        signal: input.signal,
      }),
    input,
  });
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
    const generation = `${authorization.baseRefOid}:${authorization.headRefOid}`;
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

  const key = (scope) => `${scope.key}:${scope.generation}`;

  const get = (key, scope) => {
    if (scopes.get(scope.key) !== scope) return null;
    const entry = entries.get(key);
    if (!entry || entry.scope !== scope) return null;

    entries.delete(key);
    entries.set(key, entry);
    return JSON.parse(entry.serialized);
  };

  const set = (key, scope, value) => {
    if (scopes.get(scope.key) !== scope) return;
    const serialized = JSON.stringify(value);
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > maximumBytes) return;

    deleteEntry(key);
    while (bytes + size > maximumBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      deleteEntry(oldest);
    }

    entries.set(key, { bytes: size, scope, serialized });
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

  return Object.freeze({ acquire, get, invalidate, key, release, set });
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

export function createDiffService({
  authorizer,
  cacheBytes = DEFAULT_DIFF_BUDGET,
  executor,
  maximumBytes = DEFAULT_DIFF_BUDGET,
} = {}) {
  if (!authorizer || typeof authorizer.authorizePull !== "function") {
    throw new TypeError("authorizer with an authorizePull method is required.");
  }
  if (!executor || typeof executor.rest !== "function") {
    throw new TypeError("executor with a rest method is required.");
  }
  validateMaximumBytes(cacheBytes, "cacheBytes");
  validateMaximumBytes(maximumBytes, "maximumBytes");

  // Cache capacity is measured from the exact UTF-8 JSON payload. Scope
  // metadata exists only while a generation is cached or has active callers.
  const cache = createCache(cacheBytes);
  const requests = new Map();

  const loadAuthorized = async (value) => {
    const input = validateRequest(value);
    const initial = await authorize(authorizer, input);
    const scope = cache.acquire(initial);
    const key = cache.key(scope);

    try {
      const cached = cache.get(key, scope);
      const result =
        cached ??
        (await subscribe(
          requests,
          key,
          (signal) =>
            collectPullDiff({
              authorization: initial,
              maximumBytes,
              rest: (endpoint, options) => executor.rest(endpoint, options),
              signal,
            }),
          input.signal,
        ));
      throwIfAborted(input.signal);
      const current = await authorize(authorizer, input, initial.viewerLogin);
      if (!sameAuthorization(initial, current)) throw new DiffError("stale");

      if (cached === null) cache.set(key, scope, result);
      return Object.freeze({ authorization: current, diff: result });
    } finally {
      cache.release(scope);
    }
  };

  const load = async (value) => (await loadAuthorized(value)).diff;

  const invalidate = (value) => cache.invalidate(value);

  return Object.freeze({ invalidate, load, loadAuthorized, loadDiff: load });
}
