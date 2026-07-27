const ACTIONS_RESULT_LIMIT = 1_000;
const PAGE_SIZE = 100;
const PIPELINE_WINDOW = 7 * 24 * 60 * 60 * 1_000;
// Match the normal recent-release refresh cadence: a new release gets one
// complete cadence for GitHub to create its release-triggered workflow run.
const RELEASE_REFRESH_DISCOVERY_WINDOW = 5 * 60 * 1_000;
const READ_CONCURRENCY = 12;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DECIMAL_ID = /^[1-9]\d*$/;
const PIPELINE_LOOKUPS = new Set(["complete", "pending", "unavailable"]);
const PIPELINE_STATES = new Set([
  "action-required",
  "cancelled",
  "failed",
  "neutral",
  "queued",
  "running",
  "skipped",
  "stale",
  "succeeded",
  "timed-out",
  "unknown",
]);
const ACTIVE_PIPELINE_STATES = new Set(["queued", "running"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function decimalId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === "string" && DECIMAL_ID.test(value) ? value : null;
}

function validRepository(value) {
  return (
    typeof value === "string" &&
    REPOSITORY.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function canonicalRunUrl(value, repository, id) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return null;
    const expected = `/${repository}/actions/runs/${id}`;
    return url.pathname === expected
      ? `https://github.com/${repository}/actions/runs/${id}`
      : null;
  } catch {
    return null;
  }
}

export function normalizePipelineState(status, conclusion) {
  if (status === "in_progress" && conclusion === null) return "running";
  if (
    (status === "pending" ||
      status === "queued" ||
      status === "requested" ||
      status === "waiting") &&
    conclusion === null
  )
    return "queued";
  if (status !== "completed") return "unknown";

  switch (conclusion) {
    case "action_required":
      return "action-required";
    case "cancelled":
      return "cancelled";
    case "failure":
    case "startup_failure":
      return "failed";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "stale":
      return "stale";
    case "success":
      return "succeeded";
    case "timed_out":
      return "timed-out";
    default:
      return "unknown";
  }
}

function normalizeRun(value, repository) {
  const id = decimalId(value?.id);
  const workflowId = decimalId(value?.workflow_id);
  if (
    !isRecord(value) ||
    id === null ||
    workflowId === null ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    typeof value.name !== "string" ||
    value.name.trim() === "" ||
    typeof value.path !== "string" ||
    value.path.trim() === "" ||
    value.event !== "release" ||
    typeof value.head_branch !== "string" ||
    value.head_branch === "" ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    !validDate(value.created_at) ||
    (value.run_started_at !== null && !validDate(value.run_started_at)) ||
    !validDate(value.updated_at) ||
    !isRecord(value.repository) ||
    typeof value.repository.full_name !== "string" ||
    value.repository.full_name !== repository
  )
    return null;
  const url = canonicalRunUrl(value.html_url, repository, id);
  if (url === null) return null;

  return {
    headBranch: value.head_branch,
    public: {
      attempt: value.run_attempt,
      createdAt: value.created_at,
      id,
      name: value.name.trim(),
      path: value.path,
      startedAt: value.run_started_at,
      state: normalizePipelineState(value.status, value.conclusion),
      updatedAt: value.updated_at,
      url,
      workflowId,
    },
  };
}

function compareRuns(left, right) {
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (created !== 0) return created;
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  if (left.attempt !== right.attempt) return right.attempt - left.attempt;
  return BigInt(right.id) > BigInt(left.id)
    ? 1
    : BigInt(right.id) < BigInt(left.id)
      ? -1
      : 0;
}

function newerAttempt(left, right) {
  if (right.attempt !== left.attempt) {
    return right.attempt > left.attempt ? right : left;
  }
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated > 0 ? right : left;
  return BigInt(right.id) > BigInt(left.id) ? right : left;
}

function newerWorkflowRun(left, right) {
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (created !== 0) return created > 0 ? right : left;
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated > 0 ? right : left;
  return BigInt(right.id) > BigInt(left.id) ? right : left;
}

function mergePipelineRuns(previous, incoming, preserveActive) {
  const byWorkflow = new Map(incoming.map((run) => [run.workflowId, run]));
  for (const run of previous) {
    if (!preserveActive && ACTIVE_PIPELINE_STATES.has(run.state)) continue;
    const current = byWorkflow.get(run.workflowId);
    byWorkflow.set(
      run.workflowId,
      current
        ? current.id === run.id
          ? newerAttempt(run, current)
          : newerWorkflowRun(run, current)
        : run,
    );
  }
  return [...byWorkflow.values()].sort(compareRuns);
}

export function mergeReleasePipeline(previous, incoming) {
  if (!previous) return incoming;
  if (Date.parse(incoming.checkedAt) < Date.parse(previous.checkedAt)) {
    return previous;
  }

  const unavailable = incoming.lookup === "unavailable";
  const runs = mergePipelineRuns(previous.runs, incoming.runs, unavailable);
  const lookup = unavailable
    ? previous.lookup === "pending"
      ? "pending"
      : "unavailable"
    : incoming.lookup === "pending" &&
        (previous.lookup === "complete" || runs.length > 0)
      ? "complete"
      : incoming.lookup;
  return {
    ...incoming,
    lookup,
    runs,
  };
}

function collapseRuns(values) {
  const byId = new Map();
  for (const value of values) {
    const existing = byId.get(value.public.id);
    if (!existing) {
      byId.set(value.public.id, value);
      continue;
    }
    byId.set(
      value.public.id,
      newerAttempt(existing.public, value.public) === value.public
        ? value
        : existing,
    );
  }

  const byWorkflow = new Map();
  for (const value of byId.values()) {
    const existing = byWorkflow.get(value.public.workflowId);
    if (
      !existing ||
      newerWorkflowRun(existing.public, value.public) === value.public
    ) {
      byWorkflow.set(value.public.workflowId, value);
    }
  }
  return [...byWorkflow.values()].sort((left, right) =>
    compareRuns(left.public, right.public),
  );
}

function endpoint(repository, created, branch, page) {
  const query = new URLSearchParams({
    created: `>=${created}`,
    event: "release",
    page: String(page),
    per_page: String(PAGE_SIZE),
  });
  if (branch !== null) query.set("branch", branch);
  return `repos/${repository}/actions/runs?${query.toString()}`;
}

function runEndpoint(repository, id) {
  return `repos/${repository}/actions/runs/${id}`;
}

function validPage(value) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.total_count) &&
    value.total_count >= 0 &&
    Array.isArray(value.workflow_runs)
  );
}

function pageMarker(values) {
  return values.length === 0
    ? "empty"
    : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`;
}

async function loadPages(executor, repository, created, branch) {
  const first = await executor.rest(endpoint(repository, created, branch, 1), {
    validate: validPage,
  });
  if (first.total_count >= ACTIONS_RESULT_LIMIT) {
    if (first.workflow_runs.length !== PAGE_SIZE) {
      throw new Error("GitHub Actions returned incomplete capped evidence.");
    }
    return { capped: true, runs: first.workflow_runs };
  }

  const pages = Math.max(1, Math.ceil(first.total_count / PAGE_SIZE));
  const values = [];
  const markers = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const response =
      page === 1
        ? first
        : await executor.rest(endpoint(repository, created, branch, page), {
            validate: validPage,
          });
    if (response.total_count !== first.total_count) {
      throw new Error("GitHub Actions pagination changed while it was read.");
    }
    const expected =
      page < pages ? PAGE_SIZE : first.total_count - PAGE_SIZE * (pages - 1);
    if (response.workflow_runs.length !== expected) {
      throw new Error("GitHub Actions returned an incomplete pagination page.");
    }
    const marker = pageMarker(response.workflow_runs);
    if (response.workflow_runs.length > 0 && markers.has(marker)) {
      throw new Error("GitHub Actions repeated a pagination page.");
    }
    markers.add(marker);
    values.push(...response.workflow_runs);
  }
  return { capped: false, runs: values };
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return async function use(operation) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function mapLimit(values, limit, operation) {
  const use = createSemaphore(limit);
  return Promise.all(
    values.map((value, index) => use(() => operation(value, index))),
  );
}

export function releasePipelineKey(value) {
  return `${value.repository}:${value.id}:${value.tag}:${value.publishedAt}`;
}

function validRelease(value) {
  return (
    isRecord(value) &&
    DECIMAL_ID.test(String(value.id ?? "")) &&
    validRepository(value.repository) &&
    typeof value.tag === "string" &&
    value.tag !== "" &&
    validDate(value.publishedAt)
  );
}

function validPublicRun(value, repository) {
  return (
    isRecord(value) &&
    DECIMAL_ID.test(String(value.id ?? "")) &&
    DECIMAL_ID.test(String(value.workflowId ?? "")) &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    typeof value.name === "string" &&
    value.name !== "" &&
    typeof value.path === "string" &&
    value.path !== "" &&
    validDate(value.createdAt) &&
    (value.startedAt === null || validDate(value.startedAt)) &&
    validDate(value.updatedAt) &&
    PIPELINE_STATES.has(value.state) &&
    canonicalRunUrl(value.url, repository, String(value.id)) !== null
  );
}

function validPrevious(value) {
  return (
    validRelease(value) &&
    isRecord(value.pipeline) &&
    validDate(value.pipeline.checkedAt) &&
    PIPELINE_LOOKUPS.has(value.pipeline.lookup) &&
    Array.isArray(value.pipeline.runs) &&
    value.pipeline.runs.every((run) => validPublicRun(run, value.repository))
  );
}

function unavailable(release, previous, checkedAt) {
  const prior = previous.get(releasePipelineKey(release));
  return {
    id: release.id,
    pipeline: {
      checkedAt,
      lookup: "unavailable",
      runs: prior?.pipeline?.runs ?? [],
    },
    publishedAt: release.publishedAt,
    repository: release.repository,
    tag: release.tag,
  };
}

function available(release, runs, checkedAt, now) {
  const matching = collapseRuns(
    runs.filter(
      (run) =>
        run.headBranch === release.tag &&
        Date.parse(run.public.createdAt) >= Date.parse(release.publishedAt),
    ),
  ).map((run) => run.public);
  const discovering =
    now - Date.parse(release.publishedAt) < RELEASE_REFRESH_DISCOVERY_WINDOW;
  return {
    id: release.id,
    pipeline: {
      checkedAt,
      lookup: matching.length === 0 && discovering ? "pending" : "complete",
      runs: matching,
    },
    publishedAt: release.publishedAt,
    repository: release.repository,
    tag: release.tag,
  };
}

async function loadRelease(executor, release, previous, checkedAt, now) {
  try {
    const exact = await loadPages(
      executor,
      release.repository,
      release.publishedAt,
      release.tag,
    );
    if (exact.capped) return unavailable(release, previous, checkedAt);
    const values = exact.runs.map((value) =>
      normalizeRun(value, release.repository),
    );
    if (values.some((value) => value === null)) {
      return unavailable(release, previous, checkedAt);
    }
    return available(release, values, checkedAt, now);
  } catch {
    return unavailable(release, previous, checkedAt);
  }
}

async function loadExactRelease(
  executor,
  release,
  runIds,
  previous,
  checkedAt,
  now,
) {
  try {
    const values = await mapLimit(runIds, READ_CONCURRENCY, async (id) => {
      const response = await executor.rest(
        runEndpoint(release.repository, id),
        {
          validate: isRecord,
        },
      );
      const value = normalizeRun(response, release.repository);
      if (
        value === null ||
        value.public.id !== id ||
        value.headBranch !== release.tag ||
        Date.parse(value.public.createdAt) < Date.parse(release.publishedAt)
      ) {
        throw new Error(
          "GitHub Actions returned unrelated workflow-run evidence.",
        );
      }
      return value;
    });
    return available(release, values, checkedAt, now);
  } catch {
    return unavailable(release, previous, checkedAt);
  }
}

async function loadRepository(executor, releases, previous, checkedAt, now) {
  const repository = releases[0].repository;
  const earliest = releases.reduce(
    (value, release) => Math.min(value, Date.parse(release.publishedAt)),
    Date.parse(releases[0].publishedAt),
  );
  const cutoff = Math.max(earliest, now - PIPELINE_WINDOW);
  const created = new Date(cutoff).toISOString();
  try {
    const broad = await loadPages(executor, repository, created, null);
    const broadRuns = broad.runs.map((value) =>
      normalizeRun(value, repository),
    );
    if (broadRuns.some((value) => value === null)) {
      throw new Error(
        "GitHub Actions returned malformed release workflow evidence.",
      );
    }
    if (!broad.capped) {
      return mapLimit(releases, READ_CONCURRENCY, (release) =>
        Date.parse(release.publishedAt) < cutoff
          ? loadRelease(executor, release, previous, checkedAt, now)
          : available(release, broadRuns, checkedAt, now),
      );
    }

    return mapLimit(releases, READ_CONCURRENCY, (release) =>
      loadRelease(executor, release, previous, checkedAt, now),
    );
  } catch {
    return releases.map((release) => unavailable(release, previous, checkedAt));
  }
}

export async function loadReleasePipelines({
  exactRuns = new Map(),
  executor,
  now = Date.now,
  previous = [],
  releases,
} = {}) {
  if (!executor || typeof executor.rest !== "function") {
    throw new TypeError("A GitHub executor is required.");
  }
  if (typeof now !== "function") throw new TypeError("A clock is required.");
  if (
    !Array.isArray(releases) ||
    releases.some((release) => !validRelease(release))
  ) {
    throw new TypeError("Recent release identities are invalid.");
  }
  if (new Set(releases.map(releasePipelineKey)).size !== releases.length) {
    throw new TypeError("Recent release identities must be unique.");
  }
  if (!Array.isArray(previous)) {
    throw new TypeError("Previous release pipeline evidence must be an array.");
  }
  if (
    !(exactRuns instanceof Map) ||
    [...exactRuns].some(
      ([key, ids]) =>
        typeof key !== "string" ||
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.some((id) => typeof id !== "string" || !DECIMAL_ID.test(id)) ||
        new Set(ids).size !== ids.length,
    )
  ) {
    throw new TypeError("Exact release workflow runs are invalid.");
  }

  const checked = now();
  const checkedAt = new Date(checked).toISOString();
  const prior = new Map(
    previous
      .filter((release) => validPrevious(release))
      .map((release) => [releasePipelineKey(release), release]),
  );
  const groups = new Map();
  const exact = [];
  for (const release of releases) {
    const runIds = exactRuns.get(releasePipelineKey(release));
    if (runIds) {
      exact.push({ release, runIds });
      continue;
    }
    const key = release.repository;
    const group = groups.get(key);
    if (group) group.push(release);
    else groups.set(key, [release]);
  }
  if (
    [...exactRuns.keys()].some(
      (key) => !releases.some((release) => releasePipelineKey(release) === key),
    )
  ) {
    throw new TypeError(
      "Exact workflow runs must belong to a requested release.",
    );
  }
  const values = await mapLimit(
    [
      ...[...groups.values()].map((group) => ({
        group,
        kind: "repository",
      })),
      ...exact.map((value) => ({ ...value, kind: "exact" })),
    ],
    READ_CONCURRENCY,
    (value) =>
      value.kind === "repository"
        ? loadRepository(executor, value.group, prior, checkedAt, checked)
        : loadExactRelease(
            executor,
            value.release,
            value.runIds,
            prior,
            checkedAt,
            checked,
          ).then((release) => [release]),
  );
  const byRelease = new Map(
    values.flat().map((release) => [releasePipelineKey(release), release]),
  );
  return {
    generatedAt: checkedAt,
    releases: releases.map((release) =>
      byRelease.get(releasePipelineKey(release)),
    ),
  };
}
