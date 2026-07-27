import { createHash, randomUUID } from "node:crypto";

import { ActionError } from "./claude.mjs";
import { ExecutorError } from "./executor.mjs";
import {
  loadReleasePipelines,
  mergeReleasePipeline,
  releasePipelineKey,
} from "./release-pipelines.mjs";
import { validateReleaseTag } from "./workspace.mjs";

const CACHE_TTL = 5 * 60 * 1_000;
const PIPELINE_ACTIVE_POLL_TTL = 5_000;
const PIPELINE_DISCOVERY_POLL_TTL = 30_000;
const PIPELINE_MAXIMUM_BACKOFF = 60_000;
const PIPELINE_TARGETED_DISCOVERY_TTL = 5_000;
const RELEASE_PIPELINE_DISCOVERY_WINDOW = CACHE_TTL;
const AUTHORED_MERGED_WINDOW = 90 * 24 * 60 * 60 * 1_000;
const RECENT_RELEASE_WINDOW = 7 * 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 100;
const READ_CONCURRENCY = 12;
const VERIFICATION_CONTEXT_LIMIT = 96 * 1024;
const MAXIMUM_PULL_FILES = 3_000;
const MAXIMUM_RELEASE_PAGES = 100;
const MAXIMUM_SEARCH_RESULTS = 1_000;
const MAXIMUM_SEARCH_PAGES = MAXIMUM_SEARCH_RESULTS / PAGE_SIZE;
const RECONCILIATION_ATTEMPTS = 3;
const PREVIOUS_TAG_LIMIT = 10;
export const VERIFICATION_OMISSION_MARKER =
  "Verification evidence is incomplete: one or more files or patches were omitted.";
const RELEASE_MARKER = "puller-release:";
const ROLLBACK = Object.freeze({
  clean: "clean",
  manual: "manual",
  preserved: "preserved",
});
const TAGGER_EMAIL = "puller@users.noreply.github.com";
const TAGGER_NAME = "Puller";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LIKE = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
const SHA = /^[a-f0-9]{40}$/i;

const MERGED_PULLS_QUERY = `
  query AuthoredMergedPulls($searchQuery: String!, $after: String) {
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      nodes {
        ... on PullRequest {
          author { login }
          headRefOid
          mergeCommit { oid }
          mergedAt
          number
          repository { nameWithOwner url }
          title
          url
        }
      }
      pageInfo { endCursor hasNextPage }
    }
  }
`;

const RELEASES_QUERY = `
  query RecentRepositoryReleases(
    $after: String
    $name: String!
    $owner: String!
  ) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      releases(
        first: 100
        after: $after
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          id
          databaseId
          createdAt
          description
          isDraft
          name
          publishedAt
          repository { nameWithOwner url }
          tagName
          url
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

const RELEASE_NODES_QUERY = `
  query RevalidateRecentReleases($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Release {
        id
        databaseId
        createdAt
        description
        isDraft
        name
        publishedAt
        repository { nameWithOwner url }
        tagName
        url
      }
    }
  }
`;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRepository(value) {
  return (
    typeof value === "string" &&
    REPOSITORY.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function validateRepository(value) {
  if (!validRepository(value)) {
    throw new ActionError(
      400,
      "invalid_repository",
      "The repository is invalid.",
    );
  }
  return value;
}

function safeVersion(value) {
  if (typeof value !== "string" || value.startsWith("-")) return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    tag: value,
    prefix: match[1],
    parts: [BigInt(match[2]), BigInt(match[3]), BigInt(match[4])],
  };
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] > right.parts[index]) return 1;
    if (left.parts[index] < right.parts[index]) return -1;
  }
  if (left.prefix === right.prefix) return 0;
  return left.prefix === "v" ? 1 : -1;
}

export function nextPatchTag(tags) {
  if (!Array.isArray(tags)) throw new TypeError("Tags must be an array.");
  const versions = tags
    .map((value) =>
      safeVersion(typeof value === "string" ? value : value?.name),
    )
    .filter(Boolean);
  if (versions.length === 0) {
    return { latestTag: null, nextTag: "v0.1.0" };
  }
  const latest = versions.reduce((winner, candidate) =>
    compareVersion(candidate, winner) > 0 ? candidate : winner,
  );
  return {
    latestTag: latest.tag,
    nextTag: `${latest.prefix}${latest.parts[0]}.${latest.parts[1]}.${latest.parts[2] + 1n}`,
  };
}

function naturalParts(value) {
  return value.match(/\d+|\D+/g) ?? [];
}

function compareText(left, right) {
  if (left === right) return 0;
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
  return left < right ? -1 : 1;
}

function compareNatural(left, right) {
  const leftParts = naturalParts(left);
  const rightParts = naturalParts(right);
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    const leftNumber = /^\d+$/.test(leftPart);
    const rightNumber = /^\d+$/.test(rightPart);
    if (leftNumber && rightNumber) {
      const leftValue = BigInt(leftPart);
      const rightValue = BigInt(rightPart);
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      if (leftPart !== rightPart)
        return leftPart.length < rightPart.length ? -1 : 1;
      continue;
    }
    const comparison = compareText(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  if (leftParts.length !== rightParts.length) {
    return leftParts.length < rightParts.length ? -1 : 1;
  }
  return compareText(left, right);
}

function versionLike(tag) {
  const match = VERSION_LIKE.exec(tag);
  if (!match) return null;
  return {
    parts: [BigInt(match[2]), BigInt(match[3]), BigInt(match[4])],
    prefix: match[1],
    suffix: match[5] ?? null,
  };
}

function comparePreviousTags(left, right) {
  const leftVersion = versionLike(left);
  const rightVersion = versionLike(right);
  if (leftVersion && rightVersion) {
    for (let index = 0; index < 3; index += 1) {
      if (leftVersion.parts[index] !== rightVersion.parts[index]) {
        return leftVersion.parts[index] > rightVersion.parts[index] ? -1 : 1;
      }
    }
    if (leftVersion.suffix === null && rightVersion.suffix !== null) return -1;
    if (leftVersion.suffix !== null && rightVersion.suffix === null) return 1;
    if (leftVersion.suffix !== null && rightVersion.suffix !== null) {
      const suffix = compareNatural(leftVersion.suffix, rightVersion.suffix);
      if (suffix !== 0) return -suffix;
    }
    if (leftVersion.prefix !== rightVersion.prefix)
      return leftVersion.prefix === "v" ? -1 : 1;
    return -compareNatural(left, right);
  }
  if (leftVersion) return -1;
  if (rightVersion) return 1;
  return -compareNatural(left, right);
}

function previousTags(tags) {
  return [...new Set(tags)]
    .sort(comparePreviousTags)
    .slice(0, PREVIOUS_TAG_LIMIT);
}

function withPage(endpoint, page) {
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`;
}

async function pagesOfArrays(executor, endpoint) {
  const items = [];
  let page = 1;
  let previous = null;
  while (true) {
    const values = await executor.rest(withPage(endpoint, page), {
      validate: Array.isArray,
    });
    const marker =
      values.length === 0
        ? "empty"
        : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`;
    if (page > 1 && values.length > 0 && marker === previous) {
      throw new ActionError(
        502,
        "github_pagination",
        "GitHub repeated a pagination page.",
      );
    }
    items.push(...values);
    if (values.length < PAGE_SIZE) return items;
    previous = marker;
    page += 1;
  }
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return async function use(operation) {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    }
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

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function executorError(error, code, message, status = 502) {
  if (error instanceof ActionError) return error;
  if (error instanceof ExecutorError)
    return new ActionError(error.status, code, message);
  return new ActionError(status, code, message);
}

function repositoryFromApiUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com")
      return null;
    const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const repository = match ? `${match[1]}/${match[2]}` : null;
    return validRepository(repository) ? repository : null;
  } catch {
    return null;
  }
}

function repositoriesFromSnapshot(snapshot) {
  const pulls = snapshot?.pulls ?? [
    ...(snapshot?.ready ?? []),
    ...(snapshot?.notReady ?? []),
  ];
  if (!Array.isArray(pulls)) return [];
  return pulls
    .filter((pull) => validRepository(pull?.repository))
    .map((pull) => ({
      repository: pull.repository,
      repositoryUrl:
        typeof pull.repositoryUrl === "string"
          ? pull.repositoryUrl
          : `https://github.com/${pull.repository}`,
    }));
}

function normalizeViewer(value) {
  if (typeof value !== "string") return null;
  const login = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return null;
  return { key: login.toLowerCase(), login };
}

function normalizeMerged(value) {
  if (Array.isArray(value)) return { incomplete: false, items: value };
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.incomplete !== "boolean"
  ) {
    throw new TypeError("Merged pull request evidence is invalid.");
  }
  return value;
}

function authoredMergedCutoffDate(now) {
  return new Date(now() - AUTHORED_MERGED_WINDOW).toISOString().slice(0, 10);
}

async function searchMerged(executor, viewerLogin, now) {
  const query = `is:pr author:${viewerLogin} is:merged merged:>=${authoredMergedCutoffDate(now)}`;
  if (typeof executor.graphql === "function") {
    const items = [];
    let after = null;
    let incomplete = false;
    let total = 0;
    const cursors = new Set();
    for (let page = 1; page <= MAXIMUM_SEARCH_PAGES; page += 1) {
      const response = await executor.graphql(
        MERGED_PULLS_QUERY,
        { after, searchQuery: query },
        {
          validate: (value) =>
            isRecord(value?.search) &&
            Number.isSafeInteger(value.search.issueCount) &&
            Array.isArray(value.search.nodes) &&
            isRecord(value.search.pageInfo) &&
            typeof value.search.pageInfo.hasNextPage === "boolean",
        },
      );
      total = response.search.issueCount;
      for (const value of response.search.nodes) {
        const pull = normalizeGraphqlPull(value, viewerLogin);
        if (pull) {
          items.push({
            number: pull.number,
            pull,
            repository: pull.repository,
            repositoryUrl: `https://github.com/${pull.repository}`,
          });
        } else {
          incomplete = true;
        }
      }
      if (!response.search.pageInfo.hasNextPage) break;
      const cursor = response.search.pageInfo.endCursor;
      if (
        page === MAXIMUM_SEARCH_PAGES ||
        typeof cursor !== "string" ||
        !cursor ||
        cursors.has(cursor)
      ) {
        incomplete = true;
        break;
      }
      cursors.add(cursor);
      after = cursor;
    }
    return { incomplete: incomplete || total > items.length, items };
  }

  const items = [];
  let page = 1;
  let total = 0;
  let incomplete = false;
  const markers = new Set();
  while (page <= MAXIMUM_SEARCH_PAGES) {
    const endpoint = `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc`;
    const response = await executor.rest(withPage(endpoint, page), {
      validate: (value) =>
        isRecord(value) &&
        Number.isSafeInteger(value.total_count) &&
        Array.isArray(value.items) &&
        typeof value.incomplete_results === "boolean",
    });
    total = response.total_count;
    incomplete ||= response.incomplete_results;
    const marker =
      response.items.length === 0
        ? "empty"
        : `${response.items.length}:${JSON.stringify(response.items[0])}:${JSON.stringify(response.items.at(-1))}`;
    if (response.items.length > 0 && markers.has(marker)) {
      incomplete = true;
      break;
    }
    markers.add(marker);
    items.push(...response.items);
    if (
      response.items.length < PAGE_SIZE ||
      items.length >= Math.min(total, MAXIMUM_SEARCH_RESULTS)
    )
      break;
    if (page === MAXIMUM_SEARCH_PAGES) incomplete = true;
    page += 1;
  }
  return {
    incomplete: incomplete || total > items.length,
    items,
  };
}

function normalizeGraphqlPull(value, viewerLogin) {
  if (
    !isRecord(value) ||
    !isRecord(value.author) ||
    typeof value.author.login !== "string" ||
    value.author.login.toLowerCase() !== viewerLogin.toLowerCase() ||
    typeof value.headRefOid !== "string" ||
    !SHA.test(value.headRefOid) ||
    !isRecord(value.mergeCommit) ||
    typeof value.mergeCommit.oid !== "string" ||
    !SHA.test(value.mergeCommit.oid) ||
    typeof value.mergedAt !== "string" ||
    Number.isNaN(Date.parse(value.mergedAt)) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !isRecord(value.repository) ||
    !validRepository(value.repository.nameWithOwner) ||
    typeof value.title !== "string" ||
    typeof value.url !== "string"
  )
    return null;
  const repository = value.repository.nameWithOwner;
  const canonical = `https://github.com/${repository}/pull/${value.number}`;
  if (value.url.toLowerCase() !== canonical.toLowerCase()) return null;
  return {
    headSha: value.headRefOid.toLowerCase(),
    mergeCommitSha: value.mergeCommit.oid.toLowerCase(),
    mergedAt: value.mergedAt,
    number: value.number,
    repository,
    title: value.title,
    url: canonical,
  };
}

async function listTags(executor, repository) {
  const values = await pagesOfArrays(executor, `repos/${repository}/tags`);
  if (values.some((tag) => !isRecord(tag) || typeof tag.name !== "string")) {
    throw new ActionError(
      502,
      "tags_incomplete",
      "GitHub returned incomplete repository tags.",
    );
  }
  return values.map((tag) => tag.name);
}

function normalizeRelease(value, repository) {
  const id = String(value?.id ?? "");
  if (
    !isRecord(value) ||
    (typeof value.id !== "number" && typeof value.id !== "string") ||
    (typeof value.id === "number" &&
      (!Number.isSafeInteger(value.id) || value.id < 1)) ||
    !/^[1-9]\d*$/.test(id) ||
    typeof value.tag_name !== "string" ||
    value.tag_name === "" ||
    typeof value.html_url !== "string" ||
    typeof value.published_at !== "string" ||
    Number.isNaN(Date.parse(value.published_at)) ||
    typeof value.draft !== "boolean"
  )
    return null;
  return {
    body: typeof value.body === "string" ? value.body : "",
    draft: value.draft,
    id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name
        : value.tag_name,
    publishedAt: value.published_at,
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    tag: value.tag_name,
    url: value.html_url,
  };
}

function normalizeReleaseMetadata(value, repository) {
  const canonicalRepositoryUrl = `https://github.com/${repository}`;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    !Number.isSafeInteger(value.databaseId) ||
    value.databaseId < 1 ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.description !== null && typeof value.description !== "string") ||
    typeof value.isDraft !== "boolean" ||
    (value.name !== null && typeof value.name !== "string") ||
    typeof value.tagName !== "string" ||
    value.tagName === "" ||
    typeof value.url !== "string" ||
    value.url === "" ||
    !isRecord(value.repository) ||
    typeof value.repository.nameWithOwner !== "string" ||
    value.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
    typeof value.repository.url !== "string" ||
    value.repository.url.toLowerCase() !==
      canonicalRepositoryUrl.toLowerCase() ||
    (value.publishedAt !== null &&
      (typeof value.publishedAt !== "string" ||
        Number.isNaN(Date.parse(value.publishedAt)))) ||
    (!value.isDraft && value.publishedAt === null)
  )
    return null;
  return {
    body: value.description ?? "",
    createdAt: value.createdAt,
    description: value.description,
    databaseId: String(value.databaseId),
    draft: value.isDraft,
    id: String(value.databaseId),
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name
        : value.tagName,
    nodeId: value.id,
    rawName: value.name,
    publishedAt: value.publishedAt,
    repository: value.repository.nameWithOwner,
    repositoryUrl: value.repository.url,
    tag: value.tagName,
    url: value.url,
  };
}

function compareReleases(left, right) {
  const time = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  if (time !== 0) return time;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId > rightId) return -1;
  if (leftId < rightId) return 1;
  return 0;
}

function sameReleaseMetadata(left, right) {
  return (
    Boolean(left && right) &&
    left.body === right.body &&
    left.createdAt === right.createdAt &&
    left.databaseId === right.databaseId &&
    left.description === right.description &&
    left.draft === right.draft &&
    left.id === right.id &&
    left.nodeId === right.nodeId &&
    left.rawName === right.rawName &&
    left.publishedAt === right.publishedAt &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.repositoryUrl.toLowerCase() === right.repositoryUrl.toLowerCase() &&
    left.tag === right.tag &&
    left.url === right.url
  );
}

function sameRelease(left, right) {
  return (
    Boolean(left && right) &&
    left.body === right.body &&
    left.draft === right.draft &&
    left.id === right.id &&
    left.name === right.name &&
    left.publishedAt === right.publishedAt &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.repositoryUrl.toLowerCase() === right.repositoryUrl.toLowerCase() &&
    left.tag === right.tag &&
    left.url === right.url
  );
}

function tagObjectOid(transaction) {
  const timestamp = Math.floor(Date.parse(transaction.tagger.date) / 1_000);
  const content = [
    `object ${transaction.commitOid}`,
    "type commit",
    `tag ${transaction.tag}`,
    `tagger ${transaction.tagger.name} <${transaction.tagger.email}> ${timestamp} +0000`,
    "",
    transaction.tagMessage,
  ].join("\n");
  const header = `tag ${Buffer.byteLength(content, "utf8")}\0`;
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function listRelevantReleasesRest(executor, repository) {
  const published = new Map();
  const markers = new Set();
  const warnings = [];
  let incomplete = false;
  for (let page = 1; page <= MAXIMUM_RELEASE_PAGES; page += 1) {
    const values = await executor.rest(
      withPage(`repos/${repository}/releases`, page),
      {
        validate: Array.isArray,
      },
    );
    const marker =
      values.length === 0
        ? "empty"
        : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`;
    if (values.length > 0 && markers.has(marker)) {
      incomplete = true;
      warnings.push(`${repository} returned a repeated release page.`);
      break;
    }
    markers.add(marker);
    for (const value of values) {
      if (isRecord(value) && value.draft === true) continue;
      const release = normalizeRelease(value, repository);
      if (!release || release.draft) {
        incomplete = true;
        continue;
      }
      const existing = published.get(release.id);
      if (existing && !sameRelease(existing, release)) incomplete = true;
      if (!existing) published.set(release.id, release);
    }
    if (values.length < PAGE_SIZE) break;
    if (page === MAXIMUM_RELEASE_PAGES) {
      incomplete = true;
      warnings.push(
        `${repository} release pagination exceeded the safe bound.`,
      );
    }
  }
  if (
    incomplete &&
    !warnings.some(
      (warning) =>
        warning.includes("repeated release page") ||
        warning.includes("safe bound"),
    )
  ) {
    warnings.push(
      `${repository} returned malformed or changing published release data.`,
    );
  }
  const releases = [...published.values()].sort(compareReleases);
  return { incomplete, releases, warnings };
}

async function listRelevantReleasesGraphql(executor, repository, cutoff) {
  const [owner, name] = repository.split("/");
  const byDatabaseId = new Map();
  const databaseIdById = new Map();
  const conflictedDatabaseIds = new Set();
  const conflictedIds = new Set();
  const cursors = new Set();
  const warnings = [];
  let after = null;
  let incomplete = false;

  for (let page = 1; page <= MAXIMUM_RELEASE_PAGES; page += 1) {
    const response = await executor.graphql(
      RELEASES_QUERY,
      { after, name, owner },
      {
        validate: (value) =>
          value?.repository === null ||
          (isRecord(value?.repository) &&
            typeof value.repository.nameWithOwner === "string" &&
            isRecord(value.repository.releases) &&
            Array.isArray(value.repository.releases.nodes) &&
            isRecord(value.repository.releases.pageInfo) &&
            typeof value.repository.releases.pageInfo.hasNextPage ===
              "boolean"),
      },
    );
    const connection = response.repository?.releases;
    if (
      !connection ||
      response.repository.nameWithOwner.toLowerCase() !==
        repository.toLowerCase()
    ) {
      incomplete = true;
      warnings.push(
        `${repository} returned malformed or changing published release data.`,
      );
      break;
    }

    for (const value of connection.nodes) {
      if (isRecord(value) && value.isDraft === true) continue;
      const metadata = normalizeReleaseMetadata(value, repository);
      if (!metadata) {
        incomplete = true;
        continue;
      }
      const previousDatabaseId = databaseIdById.get(metadata.nodeId);
      const previous = byDatabaseId.get(metadata.databaseId);
      if (
        conflictedIds.has(metadata.nodeId) ||
        conflictedDatabaseIds.has(metadata.databaseId) ||
        (previousDatabaseId && previousDatabaseId !== metadata.databaseId) ||
        (previous && !sameReleaseMetadata(previous, metadata))
      ) {
        incomplete = true;
        conflictedIds.add(metadata.nodeId);
        conflictedDatabaseIds.add(metadata.databaseId);
        if (previousDatabaseId) {
          conflictedDatabaseIds.add(previousDatabaseId);
          byDatabaseId.delete(previousDatabaseId);
        }
        if (previous) {
          conflictedIds.add(previous.nodeId);
          databaseIdById.delete(previous.nodeId);
        }
        byDatabaseId.delete(metadata.databaseId);
        databaseIdById.delete(metadata.nodeId);
        continue;
      }
      if (!previous) {
        byDatabaseId.set(metadata.databaseId, metadata);
        databaseIdById.set(metadata.nodeId, metadata.databaseId);
      }
    }

    if (!connection.pageInfo.hasNextPage) break;
    const cursor = connection.pageInfo.endCursor;
    if (
      page === MAXIMUM_RELEASE_PAGES ||
      typeof cursor !== "string" ||
      cursor === "" ||
      cursors.has(cursor)
    ) {
      incomplete = true;
      warnings.push(
        page === MAXIMUM_RELEASE_PAGES
          ? `${repository} release pagination exceeded the safe bound.`
          : `${repository} returned a repeated release cursor.`,
      );
      break;
    }
    cursors.add(cursor);
    after = cursor;
  }

  const relevant = [...byDatabaseId.values()].filter(
    (metadata) =>
      !metadata.draft &&
      Date.parse(metadata.publishedAt) >= cutoff &&
      !conflictedIds.has(metadata.nodeId) &&
      !conflictedDatabaseIds.has(metadata.databaseId),
  );
  if (
    incomplete &&
    !warnings.some(
      (warning) =>
        warning.includes("repeated release cursor") ||
        warning.includes("safe bound") ||
        warning.includes("malformed or changing published release data"),
    )
  ) {
    warnings.push(
      `${repository} returned malformed or changing published release data.`,
    );
  }
  return {
    incomplete,
    releases: relevant.sort(compareReleases),
    warnings,
  };
}

async function confirmRelevantReleasesGraphql(executor, releases) {
  let incomplete = false;
  const groups = await mapLimit(
    chunks(releases, PAGE_SIZE),
    READ_CONCURRENCY,
    async (batch) => {
      try {
        const response = await executor.graphql(
          RELEASE_NODES_QUERY,
          { ids: batch.map(({ nodeId }) => nodeId) },
          { validate: (value) => Array.isArray(value?.nodes) },
        );
        if (response.nodes.length !== batch.length) incomplete = true;
        return batch.flatMap((metadata, index) => {
          const release = normalizeReleaseMetadata(
            response.nodes[index],
            metadata.repository,
          );
          if (!release || !sameReleaseMetadata(metadata, release)) {
            incomplete = true;
            return [];
          }
          return [release];
        });
      } catch {
        incomplete = true;
        return [];
      }
    },
  );
  return { incomplete, releases: groups.flat().sort(compareReleases) };
}

async function confirmRelevantReleasesRest(executor, releases) {
  let incomplete = false;
  const values = await mapLimit(releases, READ_CONCURRENCY, async (release) => {
    try {
      const value = await executor.rest(
        `repos/${release.repository}/releases/${release.id}`,
        {
          validate: isRecord,
        },
      );
      const confirmed = normalizeRelease(value, release.repository);
      if (!confirmed || !sameRelease(release, confirmed)) {
        incomplete = true;
        return null;
      }
      return confirmed;
    } catch {
      incomplete = true;
      return null;
    }
  });
  return { incomplete, releases: values.filter(Boolean).sort(compareReleases) };
}

async function confirmRelevantReleases(executor, releases) {
  return typeof executor.graphql === "function"
    ? confirmRelevantReleasesGraphql(executor, releases)
    : confirmRelevantReleasesRest(executor, releases);
}

async function listRelevantReleases(executor, repository, cutoff) {
  return typeof executor.graphql === "function"
    ? listRelevantReleasesGraphql(executor, repository, cutoff)
    : listRelevantReleasesRest(executor, repository);
}

function normalizeExactGraphqlPull(value, descriptor, viewerLogin, cutoff) {
  if (value === null) return false;
  if (!isRecord(value)) return null;
  if (typeof value.state !== "string" || typeof value.merged !== "boolean")
    return null;
  if (value.state !== "MERGED" || value.merged !== true) return false;
  if (
    isRecord(value.author) &&
    typeof value.author.login === "string" &&
    value.author.login.toLowerCase() !== viewerLogin.toLowerCase()
  )
    return false;
  if (
    !isRecord(value.author) ||
    typeof value.author.login !== "string" ||
    typeof value.mergedAt !== "string" ||
    Number.isNaN(Date.parse(value.mergedAt))
  )
    return null;
  if (Date.parse(value.mergedAt) < cutoff) return false;
  if (
    !Number.isSafeInteger(value.number) ||
    value.number !== descriptor.number ||
    typeof value.title !== "string" ||
    typeof value.url !== "string" ||
    typeof value.baseRefOid !== "string" ||
    !SHA.test(value.baseRefOid) ||
    typeof value.headRefOid !== "string" ||
    !SHA.test(value.headRefOid) ||
    !isRecord(value.mergeCommit) ||
    typeof value.mergeCommit.oid !== "string" ||
    !SHA.test(value.mergeCommit.oid) ||
    !isRecord(value.repository) ||
    typeof value.repository.nameWithOwner !== "string" ||
    value.repository.nameWithOwner.toLowerCase() !==
      descriptor.repository.toLowerCase() ||
    typeof value.repository.url !== "string"
  )
    return null;
  const repositoryUrl = `https://github.com/${descriptor.repository}`;
  const pullUrl = `${repositoryUrl}/pull/${descriptor.number}`;
  if (
    value.repository.url.toLowerCase() !== repositoryUrl.toLowerCase() ||
    value.url.toLowerCase() !== pullUrl.toLowerCase()
  )
    return null;
  return {
    baseSha: value.baseRefOid.toLowerCase(),
    headSha: value.headRefOid.toLowerCase(),
    mergeCommitSha: value.mergeCommit.oid.toLowerCase(),
    mergedAt: value.mergedAt,
    number: descriptor.number,
    repository: descriptor.repository,
    title: value.title,
    url: pullUrl,
  };
}

function normalizeExactRestPull(value, descriptor, viewerLogin, cutoff) {
  if (!isRecord(value)) return null;
  if (typeof value.state !== "string" || typeof value.merged !== "boolean")
    return null;
  if (value.state !== "closed" || value.merged !== true) return false;
  if (
    isRecord(value.user) &&
    typeof value.user.login === "string" &&
    value.user.login.toLowerCase() !== viewerLogin.toLowerCase()
  )
    return false;
  if (
    !isRecord(value.user) ||
    typeof value.user.login !== "string" ||
    typeof value.merged_at !== "string" ||
    Number.isNaN(Date.parse(value.merged_at))
  )
    return null;
  if (Date.parse(value.merged_at) < cutoff) return false;
  if (
    !Number.isSafeInteger(value.number) ||
    value.number !== descriptor.number ||
    typeof value.title !== "string" ||
    typeof value.html_url !== "string" ||
    !isRecord(value.base) ||
    typeof value.base.sha !== "string" ||
    !SHA.test(value.base.sha) ||
    !isRecord(value.base.repo) ||
    typeof value.base.repo.full_name !== "string" ||
    value.base.repo.full_name.toLowerCase() !==
      descriptor.repository.toLowerCase() ||
    typeof value.base.repo.html_url !== "string" ||
    !isRecord(value.head) ||
    typeof value.head.sha !== "string" ||
    !SHA.test(value.head.sha) ||
    typeof value.merge_commit_sha !== "string" ||
    !SHA.test(value.merge_commit_sha)
  )
    return null;
  const repositoryUrl = `https://github.com/${descriptor.repository}`;
  const pullUrl = `https://github.com/${descriptor.repository}/pull/${descriptor.number}`;
  if (
    value.base.repo.html_url.toLowerCase() !== repositoryUrl.toLowerCase() ||
    value.html_url.toLowerCase() !== pullUrl.toLowerCase()
  )
    return null;
  return {
    baseSha: value.base.sha.toLowerCase(),
    headSha: value.head.sha.toLowerCase(),
    mergeCommitSha: value.merge_commit_sha.toLowerCase(),
    mergedAt: value.merged_at,
    number: descriptor.number,
    repository: descriptor.repository,
    title: value.title,
    url: pullUrl,
  };
}

function pullBatches(descriptors) {
  const batches = [];
  let batch = [];
  let repositories = new Set();
  for (const descriptor of descriptors) {
    const repository = descriptor.repository.toLowerCase();
    if (
      batch.length === PAGE_SIZE ||
      (!repositories.has(repository) && repositories.size === 10)
    ) {
      batches.push(batch);
      batch = [];
      repositories = new Set();
    }
    batch.push(descriptor);
    repositories.add(repository);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function pullBatchQuery(batch) {
  const repositories = new Map();
  for (const descriptor of batch) {
    const key = descriptor.repository.toLowerCase();
    const values = repositories.get(key) ?? [];
    values.push(descriptor);
    repositories.set(key, values);
  }
  const definitions = [];
  const selections = ["viewer { login }"];
  const variables = {};
  const entries = [];
  let repositoryIndex = 0;
  let pullIndex = 0;
  for (const pulls of repositories.values()) {
    const repository = pulls[0].repository;
    const [owner, name] = repository.split("/");
    definitions.push(
      `$owner${repositoryIndex}: String!`,
      `$name${repositoryIndex}: String!`,
    );
    variables[`owner${repositoryIndex}`] = owner;
    variables[`name${repositoryIndex}`] = name;
    const pullSelections = [];
    for (const descriptor of pulls) {
      const alias = `pull${pullIndex}`;
      const number = `number${pullIndex}`;
      definitions.push(`$${number}: Int!`);
      variables[number] = descriptor.number;
      pullSelections.push(`
        ${alias}: pullRequest(number: $${number}) {
          author { login }
          baseRefOid
          headRefOid
          mergeCommit { oid }
          merged
          mergedAt
          number
          repository { nameWithOwner url }
          state
          title
          url
        }
      `);
      entries.push({
        descriptor,
        pullAlias: alias,
        repositoryAlias: `repository${repositoryIndex}`,
      });
      pullIndex += 1;
    }
    selections.push(`
      repository${repositoryIndex}: repository(
        owner: $owner${repositoryIndex}
        name: $name${repositoryIndex}
      ) {
        nameWithOwner
        url
        ${pullSelections.join("\n")}
      }
    `);
    repositoryIndex += 1;
  }
  return {
    document: `
      query RecentReleasePulls(${definitions.join(", ")}) {
        ${selections.join("\n")}
      }
    `,
    entries,
    variables,
  };
}

async function loadGraphqlPulls(executor, descriptors, viewerLogin, cutoff) {
  let incomplete = false;
  const groups = await mapLimit(
    pullBatches(descriptors),
    READ_CONCURRENCY,
    async (batch) => {
      const query = pullBatchQuery(batch);
      try {
        const response = await executor.graphql(
          query.document,
          query.variables,
          {
            validate: (value) =>
              isRecord(value) &&
              (value.viewer === null || isRecord(value.viewer)),
          },
        );
        if (
          !isRecord(response.viewer) ||
          typeof response.viewer.login !== "string" ||
          response.viewer.login.toLowerCase() !== viewerLogin.toLowerCase()
        ) {
          incomplete = true;
          return [];
        }
        const pulls = [];
        for (const entry of query.entries) {
          const repository = response[entry.repositoryAlias];
          if (repository === null) {
            incomplete = true;
            continue;
          }
          if (
            !isRecord(repository) ||
            typeof repository.nameWithOwner !== "string" ||
            repository.nameWithOwner.toLowerCase() !==
              entry.descriptor.repository.toLowerCase() ||
            typeof repository.url !== "string" ||
            repository.url.toLowerCase() !==
              `https://github.com/${entry.descriptor.repository}`.toLowerCase()
          ) {
            incomplete = true;
            continue;
          }
          const pull = normalizeExactGraphqlPull(
            repository[entry.pullAlias],
            entry.descriptor,
            viewerLogin,
            cutoff,
          );
          if (pull === null) incomplete = true;
          if (pull) pulls.push(pull);
        }
        return pulls;
      } catch {
        incomplete = true;
        return [];
      }
    },
  );
  return { incomplete, pulls: groups.flat() };
}

async function loadRestPulls(executor, descriptors, viewerLogin, cutoff) {
  let authenticatedViewer = null;
  try {
    const value = await executor.rest("user", {
      validate: (result) =>
        isRecord(result) && normalizeViewer(result.login) !== null,
    });
    authenticatedViewer = normalizeViewer(value.login);
    if (authenticatedViewer.key !== normalizeViewer(viewerLogin)?.key) {
      return { authenticatedViewer, incomplete: true, pulls: [] };
    }
  } catch {
    return { authenticatedViewer, incomplete: true, pulls: [] };
  }
  if (descriptors.length === 0) {
    return { authenticatedViewer, incomplete: false, pulls: [] };
  }

  let incomplete = false;
  const pulls = await mapLimit(
    descriptors,
    READ_CONCURRENCY,
    async (descriptor) => {
      try {
        const value = await executor.rest(
          `repos/${descriptor.repository}/pulls/${descriptor.number}`,
          {
            validate: isRecord,
          },
        );
        const pull = normalizeExactRestPull(
          value,
          descriptor,
          viewerLogin,
          cutoff,
        );
        if (pull === null) incomplete = true;
        return pull || null;
      } catch (error) {
        if (error instanceof ExecutorError && error.apiStatus === 404)
          return null;
        incomplete = true;
        return null;
      }
    },
  );
  return { authenticatedViewer, incomplete, pulls: pulls.filter(Boolean) };
}

function normalizeAssociatedPull(value, repository, viewerLogin) {
  if (
    !isRecord(value) ||
    value.state !== "closed" ||
    value.merged !== true ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !Number.isSafeInteger(value.changed_files) ||
    value.changed_files < 1 ||
    value.changed_files > MAXIMUM_PULL_FILES ||
    typeof value.title !== "string" ||
    typeof value.html_url !== "string" ||
    typeof value.merged_at !== "string" ||
    Number.isNaN(Date.parse(value.merged_at)) ||
    !isRecord(value.user) ||
    typeof value.user.login !== "string" ||
    !isRecord(value.base) ||
    typeof value.base.sha !== "string" ||
    !SHA.test(value.base.sha) ||
    !isRecord(value.base.repo) ||
    typeof value.base.repo.full_name !== "string" ||
    value.base.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
    !isRecord(value.head) ||
    typeof value.head.sha !== "string" ||
    !SHA.test(value.head.sha) ||
    typeof value.merge_commit_sha !== "string" ||
    !SHA.test(value.merge_commit_sha)
  )
    return null;
  if (value.user.login.toLowerCase() !== viewerLogin.toLowerCase())
    return false;
  const canonical = `https://github.com/${repository}/pull/${value.number}`;
  if (value.html_url.toLowerCase() !== canonical.toLowerCase()) return null;
  return {
    baseSha: value.base.sha.toLowerCase(),
    changedFiles: value.changed_files,
    headSha: value.head.sha.toLowerCase(),
    mergeCommitSha: value.merge_commit_sha.toLowerCase(),
    mergedAt: value.merged_at,
    number: value.number,
    repository,
    title: value.title,
    url: canonical,
  };
}

function publicPull(pull) {
  const {
    baseSha: _baseSha,
    changedFiles: _changedFiles,
    mergeCommitSha: _mergeCommitSha,
    ...value
  } = pull;
  return value;
}

function sameAssociatedPull(left, right) {
  return (
    right !== null &&
    right !== false &&
    left.baseSha === right.baseSha &&
    left.changedFiles === right.changedFiles &&
    left.headSha === right.headSha &&
    left.mergeCommitSha === right.mergeCommitSha &&
    left.mergedAt === right.mergedAt &&
    left.number === right.number &&
    left.repository === right.repository &&
    left.title === right.title &&
    left.url === right.url
  );
}

async function compareStatus(executor, repository, base, head) {
  const endpoint = `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1&page=1`;
  const response = await executor.rest(endpoint, {
    validate: (value) => isRecord(value) && typeof value.status === "string",
  });
  return response.status;
}

async function commitInRange(executor, repository, base, head, commit) {
  const [afterBase, beforeHead] = await Promise.all([
    compareStatus(executor, repository, base, commit),
    compareStatus(executor, repository, commit, head),
  ]);
  return afterBase === "ahead" && ["ahead", "identical"].includes(beforeHead);
}

async function commitInFirstRelease(executor, repository, head, commit) {
  const beforeHead = await compareStatus(executor, repository, commit, head);
  return ["ahead", "identical"].includes(beforeHead);
}

function pullNumbersFromNotes(body, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `https://github\\.com/${escaped}/pull/(\\d+)(?!\\d)`,
    "gi",
  );
  return [...body.matchAll(expression)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .filter((number, index, values) => values.indexOf(number) === index);
}

function titleFromReleaseNote(line, url, number) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markdown = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, "i").exec(
    line,
  );
  if (markdown?.[1]?.trim()) return markdown[1].trim();

  const before = line
    .slice(0, line.toLowerCase().indexOf(url.toLowerCase()))
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+by\s+@[A-Za-z0-9-]+\s+in\s*$/i, "")
    .replace(/\s+in\s*$/i, "")
    .trim();
  return before || `Pull request #${number}`;
}

export function pullsFromReleaseNotes(body, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `https://github\\.com/${escaped}/pull/(\\d+)(?!\\d)`,
    "gi",
  );
  const pulls = new Map();
  for (const match of body.matchAll(expression)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1 || pulls.has(number))
      continue;
    const url = `https://github.com/${repository}/pull/${number}`;
    const start = body.lastIndexOf("\n", match.index ?? 0) + 1;
    const end = body.indexOf("\n", match.index ?? 0);
    const line = body.slice(start, end < 0 ? body.length : end);
    pulls.set(number, {
      number,
      title: titleFromReleaseNote(line, match[0], number),
      url,
    });
  }
  return [...pulls.values()].sort((left, right) => left.number - right.number);
}

function canonicalReleaseText(value) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function canonicalReleaseNotes(value) {
  return {
    body: canonicalReleaseText(value.body),
    name: canonicalReleaseText(value.name),
  };
}

function releasePreviewContent(value) {
  return {
    baseTag: value.baseTag,
    body: value.body,
    name: value.name,
    pulls: value.pulls.map(({ number, title, url }) => ({
      number,
      title,
      url,
    })),
    repository: value.repository.toLowerCase(),
    tag: value.tag,
    targetOid: value.targetOid.toLowerCase(),
  };
}

function releasePreviewDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(releasePreviewContent(value)))
    .digest("hex");
}

function sameReleasePreview(left, right) {
  return (
    left.digest === right.digest &&
    JSON.stringify(releasePreviewContent(left)) ===
      JSON.stringify(releasePreviewContent(right))
  );
}

function previewIdentity({
  baseTag,
  body,
  name,
  pulls,
  repository,
  tag,
  targetOid,
}) {
  const notes = canonicalReleaseNotes({ body, name });
  const identity = {
    baseTag,
    ...notes,
    pulls: pulls.map((pull) => ({
      ...pull,
      title: canonicalReleaseText(pull.title),
    })),
    repository,
    tag,
    targetOid: targetOid.toLowerCase(),
  };
  return {
    ...identity,
    digest: releasePreviewDigest(identity),
  };
}

function validatePreviewPull(value, repository) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    value.url !== `https://github.com/${repository}/pull/${value.number}`
  ) {
    throw new ActionError(
      400,
      "invalid_preview",
      "The release preview is invalid.",
    );
  }
  return {
    number: value.number,
    title: value.title,
    url: value.url,
  };
}

function validatePreviewIdentity(value, input) {
  if (
    !isRecord(value) ||
    value.repository !== input.repository ||
    value.tag !== input.tag ||
    value.baseTag !== input.expectedLatestTag ||
    typeof value.body !== "string" ||
    typeof value.name !== "string" ||
    typeof value.targetOid !== "string" ||
    !SHA.test(value.targetOid) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Array.isArray(value.pulls)
  ) {
    throw new ActionError(
      400,
      "invalid_preview",
      "The release preview is invalid.",
    );
  }
  const pulls = value.pulls.map((pull) =>
    validatePreviewPull(pull, input.repository),
  );
  if (
    pulls.some(
      (pull, index) => index > 0 && pulls[index - 1].number >= pull.number,
    )
  ) {
    throw new ActionError(
      400,
      "invalid_preview",
      "The release preview is invalid.",
    );
  }
  const preview = previewIdentity({
    baseTag: value.baseTag,
    body: value.body,
    name: value.name,
    pulls,
    repository: value.repository,
    tag: value.tag,
    targetOid: value.targetOid,
  });
  if (preview.digest !== value.digest) {
    throw new ActionError(
      400,
      "invalid_preview",
      "The release preview is invalid.",
    );
  }
  return preview;
}

export function validateReleasePreviewInput(value) {
  if (!isRecord(value)) {
    throw new ActionError(
      400,
      "invalid_request",
      "The release preview request is invalid.",
    );
  }
  const repository = validateRepository(value.repository);
  if (!validateReleaseTag(value.tag)) {
    throw new ActionError(400, "invalid_tag", "The release tag is invalid.");
  }
  if (
    value.expectedLatestTag !== null &&
    !safeVersion(value.expectedLatestTag)
  ) {
    throw new ActionError(
      400,
      "invalid_base_tag",
      "The expected latest release tag is invalid.",
    );
  }
  return {
    expectedLatestTag: value.expectedLatestTag,
    repository,
    tag: value.tag,
  };
}

export async function loadVerificationContext(
  executor,
  repository,
  number,
  { maximumBytes = VERIFICATION_CONTEXT_LIMIT } = {},
) {
  const blocks = [
    "Exact GitHub pull-request file evidence (untrusted content):",
  ];
  let bytes = Buffer.byteLength(blocks[0], "utf8");
  let files = 0;
  let incomplete = false;
  const markerBytes = Buffer.byteLength(
    `\n\n${VERIFICATION_OMISSION_MARKER}`,
    "utf8",
  );
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < bytes + markerBytes
  ) {
    throw new TypeError("The verification context byte limit is too small.");
  }
  const append = (block, reserveMarker = true) => {
    const size = Buffer.byteLength(`\n\n${block}`, "utf8");
    const reserve = reserveMarker ? markerBytes : 0;
    if (bytes + size + reserve > maximumBytes) return false;
    blocks.push(block);
    bytes += size;
    return true;
  };
  const finish = () => {
    if (incomplete) append(VERIFICATION_OMISSION_MARKER, false);
    return blocks.join("\n\n");
  };

  for (let page = 1; page <= MAXIMUM_PULL_FILES / PAGE_SIZE; page += 1) {
    const values = await executor.rest(
      withPage(`repos/${repository}/pulls/${number}/files`, page),
      {
        validate: Array.isArray,
      },
    );
    for (const value of values) {
      if (
        !isRecord(value) ||
        typeof value.filename !== "string" ||
        value.filename === "" ||
        value.filename.includes("\0") ||
        typeof value.status !== "string" ||
        value.status === "" ||
        !Number.isSafeInteger(value.additions) ||
        value.additions < 0 ||
        !Number.isSafeInteger(value.deletions) ||
        value.deletions < 0 ||
        (value.patch !== undefined &&
          value.patch !== null &&
          typeof value.patch !== "string")
      ) {
        throw new ActionError(
          502,
          "verification_context_invalid",
          "GitHub returned invalid pull request files.",
        );
      }
      files += 1;
      const metadata = [
        `File: ${JSON.stringify(value.filename)}`,
        `Status: ${value.status}; additions=${value.additions}; deletions=${value.deletions}`,
      ].join("\n");
      const block =
        typeof value.patch === "string"
          ? `${metadata}\nPatch:\n${value.patch}`
          : `${metadata}\nPatch unavailable (binary, unchanged, or omitted by GitHub).`;
      if (typeof value.patch !== "string") incomplete = true;
      if (!append(block)) {
        incomplete = true;
        return finish();
      }
    }
    if (values.length < PAGE_SIZE) {
      if (
        files === 0 &&
        !append("GitHub reported no changed files for this pull request.")
      ) {
        incomplete = true;
      }
      return finish();
    }
  }

  incomplete = true;
  return finish();
}

function safeDeltaPath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function patchCounts(patch) {
  if (typeof patch !== "string" || patch === "" || patch.includes("\0"))
    return null;
  const lines = patch.split("\n");
  let additions = 0;
  let deletions = 0;
  let hunk = null;
  let hunks = 0;
  const close = () => {
    if (
      hunk === null ||
      hunk.oldSeen !== hunk.oldCount ||
      hunk.newSeen !== hunk.newCount
    )
      return false;
    hunk = null;
    return true;
  };
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(
      line,
    );
    if (header) {
      if (hunk !== null && !close()) return null;
      hunk = {
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        newSeen: 0,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        oldSeen: 0,
      };
      if (!Object.values(hunk).every(Number.isSafeInteger)) return null;
      hunks += 1;
      continue;
    }
    if (hunk === null) return null;
    if (line.startsWith("+")) {
      additions += 1;
      hunk.newSeen += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      hunk.oldSeen += 1;
    } else if (line.startsWith(" ")) {
      hunk.newSeen += 1;
      hunk.oldSeen += 1;
    } else if (line !== "\\ No newline at end of file") {
      return null;
    }
  }
  if (hunks === 0 || !close()) return null;
  return { additions, deletions };
}

function targetDeltaDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadVerificationTarget(
  executor,
  pull,
  { maximumBytes = VERIFICATION_CONTEXT_LIMIT } = {},
) {
  const blocks = [
    "Exact GitHub pull-request file evidence (untrusted content):",
  ];
  let bytes = Buffer.byteLength(blocks[0], "utf8");
  let omitted = false;
  const markerBytes = Buffer.byteLength(
    `\n\n${VERIFICATION_OMISSION_MARKER}`,
    "utf8",
  );
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < bytes + markerBytes
  ) {
    throw new TypeError("The verification context byte limit is too small.");
  }
  const append = (block) => {
    const size = Buffer.byteLength(`\n\n${block}`, "utf8");
    if (bytes + size + markerBytes > maximumBytes) {
      omitted = true;
      return;
    }
    blocks.push(block);
    bytes += size;
  };
  const files = [];
  const paths = new Set();
  for (let page = 1; page <= MAXIMUM_PULL_FILES / PAGE_SIZE; page += 1) {
    const values = await executor.rest(
      withPage(`repos/${pull.repository}/pulls/${pull.number}/files`, page),
      {
        validate: Array.isArray,
      },
    );
    for (const value of values) {
      const counts = patchCounts(value?.patch);
      if (
        !isRecord(value) ||
        !safeDeltaPath(value.filename) ||
        paths.has(value.filename) ||
        !["added", "modified", "removed"].includes(value.status) ||
        typeof value.sha !== "string" ||
        !SHA.test(value.sha) ||
        !Number.isSafeInteger(value.additions) ||
        value.additions < 0 ||
        !Number.isSafeInteger(value.deletions) ||
        value.deletions < 0 ||
        !Number.isSafeInteger(value.changes) ||
        value.changes !== value.additions + value.deletions ||
        counts === null ||
        counts.additions !== value.additions ||
        counts.deletions !== value.deletions ||
        (value.status === "added" && value.deletions !== 0) ||
        (value.status === "removed" && value.additions !== 0) ||
        (value.status === "modified" &&
          value.additions + value.deletions === 0) ||
        value.previous_filename !== undefined
      ) {
        throw new ActionError(
          502,
          "verification_delta_incomplete",
          "GitHub returned incomplete pull request delta evidence.",
        );
      }
      paths.add(value.filename);
      const file = Object.freeze({
        additions: value.additions,
        changes: value.changes,
        deletions: value.deletions,
        path: value.filename,
        patch: value.patch,
        sha: value.sha.toLowerCase(),
        status: value.status,
      });
      files.push(file);
      append(
        [
          `File: ${JSON.stringify(file.path)}`,
          `Status: ${file.status}; additions=${file.additions}; deletions=${file.deletions}`,
          `Patch:\n${file.patch}`,
        ].join("\n"),
      );
    }
    if (values.length < PAGE_SIZE) break;
    if (page === MAXIMUM_PULL_FILES / PAGE_SIZE) {
      throw new ActionError(
        502,
        "verification_delta_incomplete",
        "GitHub pull request file pagination reached its verification ceiling.",
      );
    }
  }
  if (files.length !== pull.changedFiles) {
    throw new ActionError(
      502,
      "verification_delta_incomplete",
      "GitHub returned an incomplete pull request file set.",
    );
  }
  const canonical = {
    baseSha: pull.baseSha,
    changedFiles: pull.changedFiles,
    files: [...files].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    headSha: pull.headSha,
    mergeCommitSha: pull.mergeCommitSha,
    mergedAt: pull.mergedAt,
    pullNumber: pull.number,
    repository: pull.repository,
    version: 1,
  };
  const targetDelta = Object.freeze({
    ...canonical,
    digest: targetDeltaDigest(canonical),
  });
  if (omitted) blocks.push(VERIFICATION_OMISSION_MARKER);
  return Object.freeze({
    context: blocks.join("\n\n"),
    targetDelta,
  });
}

export function validateCreateReleaseInput(value) {
  if (!isRecord(value)) {
    throw new ActionError(
      400,
      "invalid_request",
      "The release request is invalid.",
    );
  }
  const repository = validateRepository(value.repository);
  if (!validateReleaseTag(value.tag)) {
    throw new ActionError(400, "invalid_tag", "The release tag is invalid.");
  }
  if (
    value.expectedLatestTag !== null &&
    !safeVersion(value.expectedLatestTag)
  ) {
    throw new ActionError(
      400,
      "invalid_base_tag",
      "The expected latest release tag is invalid.",
    );
  }
  if (typeof value.prerelease !== "boolean") {
    throw new ActionError(
      400,
      "invalid_prerelease",
      "The pre-release option is invalid.",
    );
  }
  const input = {
    expectedLatestTag: value.expectedLatestTag,
    prerelease: value.prerelease,
    repository,
    tag: value.tag,
  };
  return {
    ...input,
    preview: validatePreviewIdentity(value.preview, input),
  };
}

export function createReleaseService({
  executor,
  readinessCache = null,
  loadOpenPulls = readinessCache
    ? ({ refresh = false } = {}) =>
        refresh && typeof readinessCache.getFresh === "function"
          ? readinessCache.getFresh()
          : readinessCache.get({ refresh })
    : async () => ({ ready: [], notReady: [] }),
  loadMergedPulls = null,
  now = Date.now,
  identifier = randomUUID,
  ttl = CACHE_TTL,
  invalidateReadiness = () => undefined,
  refetch = () => undefined,
} = {}) {
  if (
    !executor ||
    typeof executor.rest !== "function" ||
    typeof executor.action !== "function"
  ) {
    throw new TypeError("A GitHub executor is required.");
  }
  if (typeof identifier !== "function")
    throw new TypeError("A release identifier factory is required.");

  let catalog = null;
  let catalogInflight = null;
  let bootstrapInflight = null;
  let viewerGeneration = 0;
  let viewerKey = null;
  let optionRevision = 0;
  let optionCache = null;
  let optionLoadedAt = 0;
  let optionInflight = null;
  let recentRevision = 0;
  let recentCache = null;
  let recentLoadedAt = 0;
  let recentInflight = null;
  let pipelineRevision = 0;
  let pipelineCache = null;
  let pipelineCacheFingerprint = null;
  let pipelineInflight = null;
  let pipelinePolls = new Map();
  let pipelineConfirmations = new Map();
  let previewCache = new Map();
  let previewInflight = new Map();
  const activeReleases = new Set();

  function pipelineTargets(releases) {
    return releases.map(({ id, publishedAt, repository, tag }) => ({
      id,
      publishedAt,
      repository,
      tag,
    }));
  }

  function fingerprintPipelines(releases) {
    return pipelineTargets(releases)
      .map((release) => releasePipelineKey(release))
      .sort()
      .join("\n");
  }

  function activePipelineRunIds(pipeline) {
    return pipeline.runs
      .filter((run) => run.state === "queued" || run.state === "running")
      .map((run) => run.id);
  }

  function youngPipeline(release) {
    return (
      now() - Date.parse(release.publishedAt) <
      RELEASE_PIPELINE_DISCOVERY_WINDOW
    );
  }

  function pollDue(key, interval) {
    const poll = pipelinePolls.get(key);
    return (
      !poll ||
      now() >= poll.nextAt ||
      (poll.interval > interval && now() - poll.loadedAt >= interval)
    );
  }

  function recordPoll(key, interval, failed) {
    const previous = pipelinePolls.get(key);
    const failures = failed ? (previous?.failures ?? 0) + 1 : 0;
    const delay = failed
      ? Math.min(
          interval * 2 ** Math.max(0, failures - 1),
          PIPELINE_MAXIMUM_BACKOFF,
        )
      : interval;
    const loadedAt = now();
    pipelinePolls.set(key, {
      failures,
      interval,
      loadedAt,
      nextAt: loadedAt + delay,
    });
  }

  function pipelinePlan(releases, { discover = false, refresh = false } = {}) {
    if (refresh) {
      const discoveryGroups = new Map();
      for (const release of releases) {
        const group = discoveryGroups.get(release.repository) ?? [];
        group.push(release);
        discoveryGroups.set(release.repository, group);
      }
      return {
        discoveries: releases,
        discoveryGroups,
        exactRuns: new Map(),
      };
    }

    const candidates = new Map();
    for (const release of releases) {
      const group = candidates.get(release.repository) ?? [];
      group.push(release);
      candidates.set(release.repository, group);
    }

    const discoveryGroups = new Map();
    if (discover) {
      for (const [repository, group] of candidates) {
        const targets = group.filter((release) => {
          const key = releasePipelineKey(release);
          return (
            activePipelineRunIds(release.pipeline).length > 0 ||
            release.pipeline.runs.length === 0 ||
            youngPipeline(release) ||
            (pipelineConfirmations.get(key) ?? []).length > 0
          );
        });
        if (
          targets.length > 0 &&
          pollDue(`repository:${repository}`, PIPELINE_TARGETED_DISCOVERY_TTL)
        ) {
          discoveryGroups.set(repository, targets);
        }
      }
    } else {
      for (const [repository, group] of candidates) {
        const interval = group.some(
          (release) =>
            release.pipeline.runs.length === 0 && youngPipeline(release),
        )
          ? PIPELINE_ACTIVE_POLL_TTL
          : PIPELINE_DISCOVERY_POLL_TTL;
        if (pollDue(`repository:${repository}`, interval)) {
          discoveryGroups.set(repository, group);
        }
      }
    }

    const discoveredRepositories = new Set(discoveryGroups.keys());
    const exactRuns = new Map();
    if (!discover) {
      const dueByRepository = new Map();
      for (const release of releases) {
        if (discoveredRepositories.has(release.repository)) continue;
        const key = releasePipelineKey(release);
        const active = activePipelineRunIds(release.pipeline);
        const activeIds = new Set(active);
        const runIds = [
          ...new Set([...active, ...(pipelineConfirmations.get(key) ?? [])]),
        ];
        const due = runIds.filter((id) =>
          pollDue(`run:${release.repository}:${id}`, PIPELINE_ACTIVE_POLL_TTL),
        );
        if (due.length === 0) continue;
        const group = dueByRepository.get(release.repository) ?? [];
        group.push({
          active: due.filter((id) => activeIds.has(id)).length,
          due,
          key,
        });
        dueByRepository.set(release.repository, group);
      }
      for (const [repository, group] of dueByRepository) {
        if (group.reduce((total, item) => total + item.active, 0) > 1) {
          discoveryGroups.set(repository, candidates.get(repository));
          continue;
        }
        for (const item of group) exactRuns.set(item.key, item.due);
      }
    }

    const discoveryTargets = [...discoveryGroups.values()].flat();
    return {
      discoveries: discoveryTargets,
      discoveryGroups,
      exactRuns,
    };
  }

  function attachPipelines(releases, evidence) {
    const pipelines = new Map(
      evidence.releases.map((release) => [
        releasePipelineKey(release),
        release.pipeline,
      ]),
    );
    return releases.map((release) => ({
      ...release,
      pipeline: pipelines.get(releasePipelineKey(release)) ?? {
        checkedAt: evidence.generatedAt,
        lookup: "unavailable",
        runs: [],
      },
    }));
  }

  function mergePipelineEvidence(current, incoming) {
    const updates = new Map(
      incoming.releases.map((release) => [
        releasePipelineKey(release),
        release.pipeline,
      ]),
    );
    return {
      generatedAt: incoming.generatedAt,
      releases: current.releases.map((release) => {
        const pipeline = updates.get(releasePipelineKey(release));
        return pipeline
          ? {
              ...release,
              pipeline: mergeReleasePipeline(release.pipeline, pipeline),
            }
          : release;
      }),
    };
  }

  function synchronizePipelineCatalog(releases) {
    const fingerprint = fingerprintPipelines(releases);
    if (pipelineCache && pipelineCacheFingerprint === fingerprint) {
      const pipelines = new Map(
        releases.map((release) => [
          releasePipelineKey(release),
          release.pipeline,
        ]),
      );
      pipelineCache = {
        ...pipelineCache,
        releases: pipelineCache.releases.map((release) => ({
          ...release,
          pipeline: mergeReleasePipeline(
            release.pipeline,
            pipelines.get(releasePipelineKey(release)) ?? release.pipeline,
          ),
        })),
      };
      return fingerprint;
    }

    const checkedAt = new Date(now()).toISOString();
    const cached = new Map(
      (pipelineCache?.releases ?? []).map((release) => [
        releasePipelineKey(release),
        release.pipeline,
      ]),
    );
    pipelineRevision += 1;
    pipelineCache = {
      generatedAt: checkedAt,
      releases: releases.map(
        ({ id, pipeline, publishedAt, repository, tag }) => ({
          id,
          pipeline: cached.get(
            releasePipelineKey({
              id,
              publishedAt,
              repository,
              tag,
            }),
          ) ??
            pipeline ?? {
              checkedAt,
              lookup: "unavailable",
              runs: [],
            },
          publishedAt,
          repository,
          tag,
        }),
      ),
    };
    pipelineCacheFingerprint = fingerprint;
    pipelineInflight = null;
    pipelinePolls = new Map();
    const identities = new Set(pipelineCache.releases.map(releasePipelineKey));
    pipelineConfirmations = new Map(
      [...pipelineConfirmations].filter(([key]) => identities.has(key)),
    );
    return fingerprint;
  }

  function seedPipelines(releases) {
    const checked = now();
    const checkedAt = new Date(checked).toISOString();
    const cached = new Map(
      (pipelineCache?.releases ?? []).map((release) => [
        releasePipelineKey(release),
        release.pipeline,
      ]),
    );
    return releases.map((release) => {
      const pipeline = cached.get(releasePipelineKey(release));
      const discovering =
        checked - Date.parse(release.publishedAt) <
        RELEASE_PIPELINE_DISCOVERY_WINDOW;
      const expiredPending =
        pipeline?.lookup === "pending" &&
        pipeline.runs.length === 0 &&
        !discovering;
      return {
        ...release,
        pipeline:
          pipeline && !expiredPending
            ? pipeline
            : {
                checkedAt,
                lookup: discovering ? "pending" : "complete",
                runs: [],
              },
      };
    });
  }

  function clearPipelines() {
    pipelineRevision += 1;
    pipelineCache = null;
    pipelineCacheFingerprint = null;
    pipelineInflight = null;
    pipelinePolls = new Map();
    pipelineConfirmations = new Map();
  }

  function clearPreviews() {
    previewCache = new Map();
    previewInflight = new Map();
  }

  async function viewer() {
    const value = await executor.rest("user", {
      validate: (result) =>
        isRecord(result) && normalizeViewer(result.login) !== null,
    });
    return normalizeViewer(value.login).login;
  }

  async function loadMerged(viewerLogin) {
    return loadMergedPulls
      ? loadMergedPulls({ viewerLogin, since: authoredMergedCutoffDate(now) })
      : searchMerged(executor, viewerLogin, now);
  }

  async function allowedRepositories({ refreshOpen = false } = {}) {
    const warnings = [];
    let partial = false;
    const viewerLogin = await viewer();
    const [openResult, mergedResult] = await Promise.allSettled([
      loadOpenPulls({ refresh: refreshOpen }),
      loadMerged(viewerLogin),
    ]);
    const repositories = new Map();
    if (openResult.status === "fulfilled") {
      for (const item of repositoriesFromSnapshot(openResult.value)) {
        repositories.set(item.repository.toLowerCase(), item);
      }
      if (openResult.value?.partial || openResult.value?.stale) {
        partial = true;
        warnings.push("Open pull request repositories may be incomplete.");
      }
    } else {
      partial = true;
      warnings.push("Open pull request repositories could not be loaded.");
    }

    let merged = { incomplete: true, items: [] };
    if (mergedResult.status === "fulfilled") {
      merged = normalizeMerged(mergedResult.value);
      for (const item of merged?.items ?? []) {
        const repository =
          item?.repository ?? repositoryFromApiUrl(item?.repository_url);
        if (!validRepository(repository)) continue;
        repositories.set(repository.toLowerCase(), {
          repository,
          repositoryUrl:
            item?.repositoryUrl ?? `https://github.com/${repository}`,
        });
      }
      if (merged?.incomplete) {
        partial = true;
        warnings.push(
          "GitHub truncated the authored merged pull request search.",
        );
      }
    } else {
      partial = true;
      warnings.push(
        "Recently merged pull request repositories could not be loaded.",
      );
    }
    return {
      merged,
      open: openResult.status === "fulfilled" ? openResult.value : null,
      partial,
      repositories: [...repositories.values()],
      viewerLogin,
      warnings,
    };
  }

  function clearViewerData(identity) {
    viewerGeneration += 1;
    viewerKey = identity.key;
    catalog = null;
    catalogInflight = null;
    bootstrapInflight = null;
    optionRevision += 1;
    optionCache = null;
    optionLoadedAt = 0;
    optionInflight = null;
    recentRevision += 1;
    recentCache = null;
    recentLoadedAt = 0;
    recentInflight = null;
    clearPipelines();
    clearPreviews();
    return viewerGeneration;
  }

  function activateViewer(identity) {
    return viewerKey === identity.key
      ? viewerGeneration
      : clearViewerData(identity);
  }

  async function discoverRepositories(snapshot, identity) {
    const repositories = new Map();
    const warnings = [];
    let partial = Boolean(snapshot.partial);
    for (const item of repositoriesFromSnapshot(snapshot)) {
      repositories.set(item.repository.toLowerCase(), item);
    }
    if (snapshot.partial) {
      warnings.push("Open pull request repositories may be incomplete.");
    }

    const mergedResult = await Promise.allSettled([loadMerged(identity.login)]);
    if (mergedResult[0].status === "fulfilled") {
      try {
        const merged = normalizeMerged(mergedResult[0].value);
        for (const item of merged.items) {
          const repository =
            item?.repository ?? repositoryFromApiUrl(item?.repository_url);
          if (!validRepository(repository)) continue;
          repositories.set(repository.toLowerCase(), {
            repository,
            repositoryUrl:
              item?.repositoryUrl ?? `https://github.com/${repository}`,
          });
        }
        if (merged.incomplete) {
          partial = true;
          warnings.push(
            "GitHub truncated the authored merged pull request search.",
          );
        }
      } catch {
        partial = true;
        warnings.push(
          "Recently merged pull request repositories could not be loaded.",
        );
      }
    } else {
      partial = true;
      warnings.push(
        "Recently merged pull request repositories could not be loaded.",
      );
    }

    return {
      partial,
      repositories: [...repositories.values()].sort((left, right) =>
        left.repository.localeCompare(right.repository),
      ),
      repositoriesUpdatedAt: new Date(now()).toISOString(),
      viewerLogin: identity.login,
      warnings,
    };
  }

  function primeRepositories(snapshot) {
    const identity = normalizeViewer(snapshot?.viewerLogin);
    if (!identity || snapshot?.stale !== false) {
      return Promise.reject(
        new ActionError(
          503,
          "repository_catalog_unavailable",
          "A fresh authenticated pull request snapshot is required.",
        ),
      );
    }

    const generation = activateViewer(identity);
    if (catalog) return Promise.resolve(catalog);
    if (catalogInflight?.generation === generation)
      return catalogInflight.promise;

    const entry = { generation, key: identity.key, promise: null };
    entry.promise = discoverRepositories(snapshot, identity)
      .then((candidate) => {
        if (viewerGeneration !== generation || viewerKey !== identity.key)
          return null;
        if (catalog && !catalog.partial && candidate.partial) return catalog;
        catalog ??= candidate;
        return catalog;
      })
      .finally(() => {
        if (catalogInflight === entry) catalogInflight = null;
      });
    catalogInflight = entry;
    return entry.promise;
  }

  async function ensureCatalog() {
    if (catalog) return catalog;
    if (catalogInflight) {
      const value = await catalogInflight.promise;
      if (value) return value;
    }
    if (bootstrapInflight) return bootstrapInflight.promise;

    const generation = viewerGeneration;
    const key = viewerKey;
    const entry = { promise: null };
    entry.promise = Promise.resolve()
      .then(() => loadOpenPulls({ refresh: false }))
      .then(async (snapshot) => {
        if (viewerGeneration !== generation || viewerKey !== key) {
          if (catalog) return catalog;
          if (catalogInflight) return catalogInflight.promise;
          throw new ActionError(
            503,
            "repository_catalog_changed",
            "The authenticated viewer changed.",
          );
        }
        const value = await primeRepositories(snapshot);
        if (!value) {
          throw new ActionError(
            503,
            "repository_catalog_changed",
            "The authenticated viewer changed.",
          );
        }
        return value;
      })
      .finally(() => {
        if (bootstrapInflight === entry) bootstrapInflight = null;
      });
    bootstrapInflight = entry;
    return entry.promise;
  }

  function assertCatalogBinding(binding) {
    if (
      binding.catalog !== catalog ||
      binding.generation !== viewerGeneration ||
      binding.key !== viewerKey
    ) {
      throw new ActionError(
        409,
        "repository_catalog_changed",
        "The authenticated viewer changed.",
      );
    }
  }

  async function bindCatalog() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await ensureCatalog();
      const identity = normalizeViewer(value?.viewerLogin);
      const binding = {
        catalog: value,
        generation: viewerGeneration,
        key: viewerKey,
      };
      if (identity?.key === binding.key && value === catalog) return binding;
    }
    throw new ActionError(
      409,
      "repository_catalog_changed",
      "The authenticated viewer changed.",
    );
  }

  async function authorizeRepository(repository) {
    let allowed;
    try {
      allowed = await allowedRepositories({ refreshOpen: true });
    } catch (error) {
      throw executorError(
        error,
        "release_authorization_unavailable",
        "The repository authorization could not be refreshed.",
        503,
      );
    }
    const key = repository.toLowerCase();
    const allowedViewer = normalizeViewer(allowed.viewerLogin);
    const openViewer = normalizeViewer(allowed.open?.viewerLogin);
    const openProof =
      allowed.open?.stale === false &&
      allowedViewer?.key === openViewer?.key &&
      repositoriesFromSnapshot(allowed.open).some(
        (item) => item.repository.toLowerCase() === key,
      );
    const mergedProof = (allowed.merged?.items ?? []).some((item) => {
      const candidate =
        item?.repository ?? repositoryFromApiUrl(item?.repository_url);
      return validRepository(candidate) && candidate.toLowerCase() === key;
    });
    if (allowedViewer && (openProof || mergedProof)) {
      return {
        generation: activateViewer(allowedViewer),
        key: allowedViewer.key,
      };
    }
    throw new ActionError(
      403,
      "repository_not_allowed",
      "The repository is not freshly proven by an authored open or recently merged pull request.",
    );
  }

  async function loadOptions(binding) {
    assertCatalogBinding(binding);
    const repositories = await mapLimit(
      binding.catalog.repositories,
      READ_CONCURRENCY,
      async (item) => {
        assertCatalogBinding(binding);
        const tags = await listTags(executor, item.repository);
        assertCatalogBinding(binding);
        return {
          ...item,
          ...nextPatchTag(tags),
          previousTags: previousTags(tags),
        };
      },
    );
    assertCatalogBinding(binding);
    const generatedAt = new Date(now()).toISOString();
    return {
      generatedAt,
      repositoriesUpdatedAt: binding.catalog.repositoriesUpdatedAt,
      repositories,
      tagsUpdatedAt: generatedAt,
      viewerLogin: binding.catalog.viewerLogin,
      warnings: [...binding.catalog.warnings],
    };
  }

  async function options({ refresh = false } = {}) {
    let binding;
    try {
      binding = await bindCatalog();
      assertCatalogBinding(binding);
    } catch (error) {
      throw executorError(
        error,
        "release_options_unavailable",
        "Release options could not be loaded.",
        503,
      );
    }
    if (!refresh && optionCache && now() - optionLoadedAt < ttl)
      return optionCache;
    const fallback = optionCache;
    const generation = binding.generation;
    const revision = optionRevision;
    if (
      !optionInflight ||
      optionInflight.generation !== generation ||
      optionInflight.revision !== revision
    ) {
      const entry = { generation, revision, promise: null };
      entry.promise = loadOptions(binding)
        .then((value) => {
          assertCatalogBinding(binding);
          if (optionRevision !== revision) {
            throw new ActionError(
              409,
              "repository_catalog_changed",
              "The authenticated viewer changed.",
            );
          }
          optionCache = value;
          optionLoadedAt = now();
          return value;
        })
        .finally(() => {
          if (optionInflight === entry) optionInflight = null;
        });
      optionInflight = entry;
    }
    try {
      return await optionInflight.promise;
    } catch (error) {
      if (!refresh && fallback && viewerGeneration === generation) {
        return {
          ...fallback,
          generatedAt: new Date(now()).toISOString(),
          warnings: [
            ...fallback.warnings,
            "Showing cached release options because GitHub could not refresh tags.",
          ],
        };
      }
      throw executorError(
        error,
        "release_options_unavailable",
        "Release options could not be loaded.",
        503,
      );
    }
  }

  async function loadPipelineEvidence(
    releases,
    binding,
    { discover = false, refresh = false } = {},
  ) {
    assertCatalogBinding(binding);
    synchronizePipelineCatalog(releases);
    const plan = pipelinePlan(pipelineCache.releases, {
      discover,
      refresh,
    });
    const exactKeys = new Set(plan.exactRuns.keys());
    const discoveryKeys = new Set(plan.discoveries.map(releasePipelineKey));
    const targets = pipelineCache.releases.filter(
      (release) =>
        exactKeys.has(releasePipelineKey(release)) ||
        discoveryKeys.has(releasePipelineKey(release)),
    );
    if (targets.length === 0) {
      return pipelineCache;
    }

    const identities = pipelineTargets(targets);
    const fingerprint = [
      fingerprintPipelines(identities),
      ...[...plan.exactRuns]
        .map(([key, ids]) => `${key}:${[...ids].sort().join(",")}`)
        .sort(),
    ].join("\n");
    const generation = binding.generation;
    const revision = pipelineRevision;

    if (pipelineInflight) {
      if (
        pipelineInflight.generation === generation &&
        pipelineInflight.revision === revision &&
        (pipelineInflight.refresh ||
          (!refresh && pipelineInflight.fingerprint === fingerprint))
      ) {
        return pipelineInflight.promise;
      }
      try {
        await pipelineInflight.promise;
      } catch {
        // A forced sweep still follows a failed narrow load.
      }
      assertCatalogBinding(binding);
      return loadPipelineEvidence(releases, binding, {
        discover,
        refresh,
      });
    }

    const previous = new Map(
      targets.map((release) => [
        releasePipelineKey(release),
        {
          active: activePipelineRunIds(release.pipeline),
          confirmation:
            pipelineConfirmations.get(releasePipelineKey(release)) ?? [],
          known: release.pipeline.runs.map((run) => run.id),
        },
      ]),
    );
    const entry = {
      fingerprint,
      generation,
      promise: null,
      refresh,
      revision,
    };
    entry.promise = loadReleasePipelines({
      exactRuns: plan.exactRuns,
      executor,
      now,
      previous: targets,
      releases: identities,
    })
      .then((value) => {
        assertCatalogBinding(binding);
        if (
          pipelineRevision !== revision ||
          pipelineCacheFingerprint !== fingerprintPipelines(releases)
        ) {
          throw new ActionError(
            409,
            "release_pipelines_changed",
            "Recent release pipeline targets changed.",
          );
        }

        pipelineCache = mergePipelineEvidence(pipelineCache, value);
        const updates = new Map(
          value.releases.map((release) => [
            releasePipelineKey(release),
            release.pipeline,
          ]),
        );
        const merged = new Map(
          pipelineCache.releases.map((release) => [
            releasePipelineKey(release),
            release.pipeline,
          ]),
        );
        for (const identity of identities) {
          const key = releasePipelineKey(identity);
          const incoming = updates.get(key);
          if (!incoming || incoming.lookup === "unavailable") continue;

          const state = previous.get(key);
          const pipeline = merged.get(key);
          if (!pipeline) continue;

          const requestedExact = plan.exactRuns.get(key) ?? [];
          if (refresh || discoveryKeys.has(key)) {
            pipelineConfirmations.delete(key);
          } else if (requestedExact.length > 0) {
            const remaining = state.confirmation.filter(
              (id) => !requestedExact.includes(id),
            );
            if (remaining.length > 0) {
              pipelineConfirmations.set(key, remaining);
            } else {
              pipelineConfirmations.delete(key);
            }
          }

          const active = new Set(activePipelineRunIds(pipeline));
          const known = new Set(state.known);
          const terminal = pipeline.runs
            .filter((run) => !active.has(run.id))
            .map((run) => run.id);
          const transitioned = state.active.filter((id) =>
            terminal.includes(id),
          );
          const discovered = terminal.filter((id) => !known.has(id));
          const confirmations = [
            ...new Set([
              ...(pipelineConfirmations.get(key) ?? []),
              ...transitioned,
              ...discovered,
            ]),
          ];
          if (confirmations.length > 0) {
            pipelineConfirmations.set(key, confirmations);
          }
        }

        for (const [key, runIds] of plan.exactRuns) {
          const incoming = updates.get(key);
          const failed = !incoming || incoming.lookup === "unavailable";
          const identity = targets.find(
            (release) => releasePipelineKey(release) === key,
          );
          if (!identity) continue;
          for (const id of runIds) {
            recordPoll(
              `run:${identity.repository}:${id}`,
              PIPELINE_ACTIVE_POLL_TTL,
              failed,
            );
          }
        }
        for (const [repository, group] of plan.discoveryGroups) {
          const failed = group.every((release) => {
            const pipeline = updates.get(releasePipelineKey(release));
            return !pipeline || pipeline.lookup === "unavailable";
          });
          const interval =
            discover && !refresh
              ? PIPELINE_TARGETED_DISCOVERY_TTL
              : group.some((release) => {
                    const pipeline = merged.get(releasePipelineKey(release));
                    return (
                      pipeline?.runs.length === 0 && youngPipeline(release)
                    );
                  })
                ? PIPELINE_ACTIVE_POLL_TTL
                : PIPELINE_DISCOVERY_POLL_TTL;
          recordPoll(`repository:${repository}`, interval, failed);
          for (const release of group) {
            const pipeline = merged.get(releasePipelineKey(release));
            if (!pipeline) continue;
            if (failed) {
              const runIds = [
                ...new Set([
                  ...activePipelineRunIds(pipeline),
                  ...(pipelineConfirmations.get(releasePipelineKey(release)) ??
                    []),
                ]),
              ];
              for (const id of runIds) {
                recordPoll(
                  `run:${repository}:${id}`,
                  PIPELINE_ACTIVE_POLL_TTL,
                  true,
                );
              }
            } else {
              for (const run of pipeline.runs) {
                recordPoll(
                  `run:${repository}:${run.id}`,
                  PIPELINE_ACTIVE_POLL_TTL,
                  false,
                );
              }
            }
          }
        }
        return pipelineCache;
      })
      .finally(() => {
        if (pipelineInflight === entry) pipelineInflight = null;
      });
    pipelineInflight = entry;
    return entry.promise;
  }

  async function loadRecent(binding, fallback) {
    assertCatalogBinding(binding);
    const currentCatalog = binding.catalog;
    const cutoff = now() - RECENT_RELEASE_WINDOW;
    const failedRepositories = new Set();
    const warnings = [...currentCatalog.warnings];
    let releaseReadsIncomplete = false;
    const releaseResults = await mapLimit(
      currentCatalog.repositories,
      READ_CONCURRENCY,
      async ({ repository }) => {
        try {
          assertCatalogBinding(binding);
          const result = await listRelevantReleases(
            executor,
            repository,
            cutoff,
          );
          assertCatalogBinding(binding);
          releaseReadsIncomplete ||= result.incomplete;
          warnings.push(...result.warnings);
          return result.releases;
        } catch (error) {
          if (
            error instanceof ActionError &&
            error.code === "repository_catalog_changed"
          )
            throw error;
          releaseReadsIncomplete = true;
          failedRepositories.add(repository.toLowerCase());
          warnings.push(`${repository} releases could not be loaded.`);
          return [];
        }
      },
    );
    assertCatalogBinding(binding);
    const work = [];
    for (const list of releaseResults) {
      for (const release of list) {
        if (Date.parse(release.publishedAt) >= cutoff) work.push({ release });
      }
    }

    const descriptors = new Map();
    for (const { release } of work) {
      for (const number of pullNumbersFromNotes(
        release.body,
        release.repository,
      )) {
        const key = `${release.repository.toLowerCase()}:${number}`;
        const descriptor = descriptors.get(key) ?? {
          number,
          releaseIds: new Set(),
          repository: release.repository,
        };
        descriptor.releaseIds.add(release.id);
        descriptors.set(key, descriptor);
      }
    }
    const mergedCutoff = Date.parse(
      `${authoredMergedCutoffDate(now)}T00:00:00.000Z`,
    );
    const pullResult =
      typeof executor.graphql === "function"
        ? await loadGraphqlPulls(
            executor,
            [...descriptors.values()],
            currentCatalog.viewerLogin,
            mergedCutoff,
          )
        : await loadRestPulls(
            executor,
            [...descriptors.values()],
            currentCatalog.viewerLogin,
            mergedCutoff,
          );
    if (
      pullResult.authenticatedViewer &&
      pullResult.authenticatedViewer.key !== binding.key
    ) {
      activateViewer(pullResult.authenticatedViewer);
      throw new ActionError(
        409,
        "repository_catalog_changed",
        "The authenticated viewer changed.",
      );
    }
    if (pullResult.incomplete) {
      warnings.push(
        "Some authored merged pull requests could not be loaded for release membership.",
      );
    }
    const confirmation = await confirmRelevantReleases(
      executor,
      work.map(({ release }) => release),
    );
    if (confirmation.incomplete) {
      warnings.push(
        "Some recent releases changed while linked pull requests were loaded.",
      );
    }
    const confirmedWork = confirmation.releases.map((release) => ({ release }));
    const assignments = new Map(
      confirmedWork.map(({ release }) => [release.id, new Map()]),
    );
    for (const pull of pullResult.pulls) {
      const descriptor = descriptors.get(
        `${pull.repository.toLowerCase()}:${pull.number}`,
      );
      for (const releaseId of descriptor?.releaseIds ?? []) {
        assignments.get(releaseId)?.set(pull.number, pull);
      }
    }
    const releases = confirmedWork.flatMap(({ release }) => {
      const pulls = [...assignments.get(release.id).values()]
        .sort(
          (left, right) =>
            Date.parse(right.mergedAt) - Date.parse(left.mergedAt),
        )
        .map(publicPull);
      if (pulls.length === 0) return [];
      return [
        {
          ...release,
          complete: false,
          pulls,
          source: "notes-fallback",
          warning:
            "Discovered from canonical GitHub release-note links; Verify refreshes exact release-boundary membership.",
        },
      ];
    });
    releases.sort(compareReleases);
    const partial =
      currentCatalog.partial ||
      releaseReadsIncomplete ||
      pullResult.incomplete ||
      confirmation.incomplete;
    assertCatalogBinding(binding);
    const publicReleases = releases.map(
      ({
        body: _body,
        createdAt: _createdAt,
        databaseId: _databaseId,
        description: _description,
        draft: _draft,
        nodeId: _nodeId,
        rawName: _rawName,
        ...release
      }) => release,
    );
    const mergedReleases = new Map(
      publicReleases.map((release) => [
        `${release.repository.toLowerCase()}:${release.id}`,
        release,
      ]),
    );
    if (fallback && failedRepositories.size > 0) {
      for (const release of fallback.releases) {
        if (
          failedRepositories.has(release.repository.toLowerCase()) &&
          Date.parse(release.publishedAt) >= cutoff
        ) {
          const key = `${release.repository.toLowerCase()}:${release.id}`;
          if (!mergedReleases.has(key)) mergedReleases.set(key, release);
        }
      }
    }
    const resultReleases = [...mergedReleases.values()].sort(compareReleases);
    assertCatalogBinding(binding);
    return {
      generatedAt: new Date(now()).toISOString(),
      partial,
      releases: seedPipelines(resultReleases),
      warnings,
    };
  }

  async function recent({ refresh = false } = {}) {
    if (!refresh && recentCache && now() - recentLoadedAt < ttl)
      return recentCache;
    let binding;
    try {
      binding = await bindCatalog();
      assertCatalogBinding(binding);
    } catch (error) {
      throw executorError(
        error,
        "releases_unavailable",
        "Recent releases could not be loaded.",
        503,
      );
    }
    const fallback = recentCache;
    const generation = binding.generation;
    const revision = recentRevision;
    if (
      !recentInflight ||
      recentInflight.generation !== generation ||
      recentInflight.revision !== revision
    ) {
      const entry = { generation, revision, promise: null };
      entry.promise = loadRecent(binding, fallback)
        .then((value) => {
          assertCatalogBinding(binding);
          if (recentRevision !== revision) {
            throw new ActionError(
              409,
              "repository_catalog_changed",
              "The authenticated viewer changed.",
            );
          }
          recentCache = value;
          recentLoadedAt = now();
          return value;
        })
        .finally(() => {
          if (recentInflight === entry) recentInflight = null;
        });
      recentInflight = entry;
    }
    try {
      return await recentInflight.promise;
    } catch (error) {
      if (
        fallback &&
        viewerGeneration === generation &&
        recentRevision === revision
      ) {
        const generated = now();
        const cutoff = generated - RECENT_RELEASE_WINDOW;
        return {
          ...fallback,
          generatedAt: new Date(generated).toISOString(),
          partial: true,
          releases: fallback.releases.filter(
            (release) => Date.parse(release.publishedAt) >= cutoff,
          ),
          warnings: [
            ...fallback.warnings,
            "Showing cached releases because GitHub could not refresh.",
          ],
        };
      }
      throw executorError(
        error,
        "releases_unavailable",
        "Recent releases could not be loaded.",
        503,
      );
    }
  }

  async function pipelines({ discover = false, refresh = false } = {}) {
    const source = recentCache;
    if (!source || !catalog) {
      throw new ActionError(
        409,
        "release_pipelines_unavailable",
        "Recent releases must be loaded before their pipelines can be refreshed.",
      );
    }
    const binding = {
      catalog,
      generation: viewerGeneration,
      key: viewerKey,
    };
    assertCatalogBinding(binding);
    const revision = recentRevision;
    const fingerprint = fingerprintPipelines(source.releases);
    let evidence;
    try {
      evidence = await loadPipelineEvidence(source.releases, binding, {
        discover,
        refresh,
      });
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw executorError(
        error,
        "release_pipelines_unavailable",
        "Release pipelines could not be loaded.",
        503,
      );
    }
    assertCatalogBinding(binding);
    if (
      recentRevision !== revision ||
      !recentCache ||
      fingerprintPipelines(recentCache.releases) !== fingerprint
    ) {
      throw new ActionError(
        409,
        "release_pipelines_changed",
        "Recent releases changed while their pipelines were refreshed.",
      );
    }
    recentCache = {
      ...recentCache,
      releases: attachPipelines(recentCache.releases, evidence),
    };
    return evidence;
  }

  function invalidate() {
    optionRevision += 1;
    optionCache = null;
    optionLoadedAt = 0;
    optionInflight = null;
    recentRevision += 1;
    recentCache = null;
    recentLoadedAt = 0;
    recentInflight = null;
    clearPipelines();
    clearPreviews();
  }

  async function defaultCommit(repository) {
    try {
      const details = await executor.rest(`repos/${repository}`, {
        validate: (value) =>
          isRecord(value) &&
          typeof value.default_branch === "string" &&
          value.default_branch !== "",
      });
      const commit = await executor.rest(
        `repos/${repository}/commits/${encodeURIComponent(details.default_branch)}`,
        {
          validate: (value) =>
            isRecord(value) &&
            typeof value.sha === "string" &&
            SHA.test(value.sha),
        },
      );
      return commit.sha.toLowerCase();
    } catch (error) {
      throw executorError(
        error,
        "release_target_unavailable",
        "The repository default-branch commit could not be captured.",
        503,
      );
    }
  }

  function assertAuthorization(binding) {
    if (binding.generation !== viewerGeneration || binding.key !== viewerKey) {
      throw new ActionError(
        409,
        "repository_catalog_changed",
        "The authenticated viewer changed.",
      );
    }
  }

  async function generateNotes(input, targetOid) {
    const fields = {
      tag_name: input.tag,
      target_commitish: targetOid,
    };
    if (input.expectedLatestTag !== null) {
      fields.previous_tag_name = input.expectedLatestTag;
    }
    try {
      const notes = await executor.rest(
        `repos/${input.repository}/releases/generate-notes`,
        {
          fields,
          method: "POST",
          validate: (value) =>
            isRecord(value) &&
            typeof value.body === "string" &&
            typeof value.name === "string",
        },
      );
      return canonicalReleaseNotes(notes);
    } catch (error) {
      throw executorError(
        error,
        "release_preview_unavailable",
        "GitHub could not generate the release preview.",
        503,
      );
    }
  }

  async function capturePreview(input, binding, { cache = true } = {}) {
    assertAuthorization(binding);
    let tags;
    let targetOid;
    try {
      [tags, targetOid] = await Promise.all([
        listTags(executor, input.repository),
        defaultCommit(input.repository),
      ]);
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw executorError(
        error,
        "release_preview_unavailable",
        "The release preview could not be loaded.",
        503,
      );
    }
    assertAuthorization(binding);
    const current = nextPatchTag(tags);
    if (current.latestTag !== input.expectedLatestTag) {
      throw new ActionError(
        409,
        "release_base_changed",
        "The latest repository tag changed. Reload release options.",
      );
    }
    if (tags.includes(input.tag)) {
      throw new ActionError(
        409,
        "tag_exists",
        "That release tag already exists.",
      );
    }

    const key = JSON.stringify([
      binding.generation,
      binding.key,
      input.repository.toLowerCase(),
      input.tag,
      input.expectedLatestTag,
      targetOid,
    ]);
    const cached = previewCache.get(key);
    if (cache && cached && now() - cached.loadedAt < ttl) return cached.value;

    let entry = cache ? previewInflight.get(key) : null;
    if (!entry) {
      entry = {
        promise: generateNotes(input, targetOid).then((notes) => {
          assertAuthorization(binding);
          const value = {
            notes,
            preview: previewIdentity({
              baseTag: input.expectedLatestTag,
              body: notes.body,
              name: notes.name,
              pulls: pullsFromReleaseNotes(notes.body, input.repository),
              repository: input.repository,
              tag: input.tag,
              targetOid,
            }),
          };
          if (cache) {
            previewCache.set(key, { loadedAt: now(), value });
          }
          return value;
        }),
      };
      if (cache) {
        previewInflight.set(key, entry);
        void entry.promise
          .finally(() => {
            if (previewInflight.get(key) === entry) previewInflight.delete(key);
          })
          .catch(() => undefined);
      }
    }
    return entry.promise;
  }

  async function preview(value) {
    const input = validateReleasePreviewInput(value);
    const binding = await authorizeRepository(input.repository);
    const captured = await capturePreview(input, binding);
    return captured.preview;
  }

  function missing(error) {
    return error instanceof ExecutorError && error.status === 404;
  }

  function markerFor(id) {
    return `<!-- ${RELEASE_MARKER}${id} -->`;
  }

  function releaseState(value) {
    if (
      !isRecord(value) ||
      (typeof value.id !== "number" && typeof value.id !== "string") ||
      typeof value.tag_name !== "string" ||
      typeof value.draft !== "boolean" ||
      typeof value.prerelease !== "boolean" ||
      typeof value.name !== "string" ||
      typeof value.body !== "string"
    )
      return null;
    return {
      body: value.body,
      draft: value.draft,
      id: String(value.id),
      name: value.name,
      prerelease: value.prerelease,
      raw: value,
      tag: value.tag_name,
    };
  }

  function ownedRelease(value, transaction) {
    const state = releaseState(value);
    if (!state || !markedRelease(value, transaction)) return null;
    return state;
  }

  function markedRelease(value, transaction) {
    if (
      !isRecord(value) ||
      (typeof value.id !== "number" && typeof value.id !== "string") ||
      typeof value.tag_name !== "string" ||
      typeof value.body !== "string"
    ) {
      return false;
    }
    return (
      value.tag_name === transaction.tag &&
      value.body.includes(transaction.marker) &&
      (!transaction.releaseId || String(value.id) === transaction.releaseId)
    );
  }

  function releaseBody(transaction) {
    return transaction.notes.body
      ? `${transaction.marker}\n\n${transaction.notes.body}`
      : transaction.marker;
  }

  function matchesReleaseRequest(state, transaction) {
    return (
      state.body === releaseBody(transaction) &&
      state.name === transaction.notes.name &&
      state.prerelease === transaction.prerelease
    );
  }

  function ownedTagObject(value, transaction) {
    return (
      isRecord(value) &&
      typeof value.sha === "string" &&
      value.sha.toLowerCase() === transaction.tagObjectOid &&
      value.tag === transaction.tag &&
      value.message === transaction.tagMessage &&
      isRecord(value.object) &&
      value.object.type === "commit" &&
      typeof value.object.sha === "string" &&
      value.object.sha.toLowerCase() === transaction.commitOid &&
      isRecord(value.tagger) &&
      value.tagger.name === transaction.tagger.name &&
      value.tagger.email === transaction.tagger.email &&
      typeof value.tagger.date === "string" &&
      Date.parse(value.tagger.date) === Date.parse(transaction.tagger.date)
    );
  }

  async function readOwnedTagObject(transaction) {
    try {
      const value = await executor.rest(
        `repos/${transaction.repository}/git/tags/${transaction.tagObjectOid}`,
        {
          validate: isRecord,
        },
      );
      if (!ownedTagObject(value, transaction)) {
        throw new ActionError(
          409,
          "tag_object_changed",
          "The deterministic release tag object is not owned.",
        );
      }
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  async function readReference(repository, tag) {
    try {
      const value = await executor.rest(
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
        {
          validate: isRecord,
        },
      );
      if (
        value.ref !== `refs/tags/${tag}` ||
        !isRecord(value.object) ||
        typeof value.object.sha !== "string" ||
        !SHA.test(value.object.sha) ||
        typeof value.object.type !== "string"
      ) {
        throw new ActionError(
          502,
          "tag_invalid",
          "GitHub returned an invalid release tag reference.",
        );
      }
      return {
        oid: value.object.sha.toLowerCase(),
        type: value.object.type,
      };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function readReleaseById(repository, id) {
    try {
      return await executor.rest(`repos/${repository}/releases/${id}`, {
        validate: isRecord,
      });
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function readReleaseByTag(repository, tag) {
    try {
      return await executor.rest(
        `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        { validate: isRecord },
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const values = await pagesOfArrays(
      executor,
      `repos/${repository}/releases`,
    );
    return (
      values.find((value) => isRecord(value) && value.tag_name === tag) ?? null
    );
  }

  async function createTagObject(transaction) {
    let lastError = null;
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(
          `repos/${transaction.repository}/git/tags`,
          {
            fields: {
              message: transaction.tagMessage,
              object: transaction.commitOid,
              tag: transaction.tag,
              tagger: transaction.tagger,
              type: "commit",
            },
            method: "POST",
            validate: isRecord,
          },
        );
        if (!ownedTagObject(value, transaction)) {
          throw new ActionError(
            502,
            "tag_object_invalid",
            "GitHub returned an invalid owned tag object.",
          );
        }
        return;
      } catch (error) {
        lastError = error;
      }

      try {
        if (await readOwnedTagObject(transaction)) return;
      } catch (error) {
        if (error instanceof ActionError && error.code === "tag_object_changed")
          throw error;
        lastError = error;
      }
    }
    throw executorError(
      lastError,
      "tag_object_create_unconfirmed",
      "The owned release tag object could not be created.",
      503,
    );
  }

  async function confirmOwnedTag(transaction) {
    const reference = await readReference(
      transaction.repository,
      transaction.tag,
    );
    if (
      !reference ||
      reference.type !== "tag" ||
      reference.oid !== transaction.tagObjectOid
    )
      return false;
    return readOwnedTagObject(transaction);
  }

  async function createReference(transaction) {
    let lastError = null;
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(
          `repos/${transaction.repository}/git/refs`,
          {
            fields: {
              ref: `refs/tags/${transaction.tag}`,
              sha: transaction.tagObjectOid,
            },
            method: "POST",
            validate: isRecord,
          },
        );
        if (
          value.ref === `refs/tags/${transaction.tag}` &&
          isRecord(value.object) &&
          value.object.type === "tag" &&
          typeof value.object.sha === "string" &&
          value.object.sha.toLowerCase() === transaction.tagObjectOid
        )
          return;
        lastError = new ActionError(
          502,
          "tag_create_unconfirmed",
          "GitHub returned an invalid tag reference.",
        );
      } catch (error) {
        lastError = error;
      }

      try {
        const current = await readReference(
          transaction.repository,
          transaction.tag,
        );
        if (current?.type === "tag" && current.oid === transaction.tagObjectOid)
          return;
        if (current) {
          throw new ActionError(
            409,
            "tag_create_conflict",
            "Another actor created the release tag. Reload release options and try again.",
          );
        }
      } catch (error) {
        if (
          error instanceof ActionError &&
          error.code === "tag_create_conflict"
        )
          throw error;
        lastError = error;
      }
    }
    throw executorError(
      lastError,
      "tag_create_unconfirmed",
      "The release tag creation could not be confirmed.",
      503,
    );
  }

  async function createDraft(transaction) {
    let lastError = null;
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(
          `repos/${transaction.repository}/releases`,
          {
            fields: {
              body: releaseBody(transaction),
              draft: true,
              generate_release_notes: false,
              name: transaction.notes.name,
              prerelease: transaction.prerelease,
              tag_name: transaction.tag,
              target_commitish: transaction.commitOid,
            },
            method: "POST",
            validate: isRecord,
          },
        );
        const state = ownedRelease(value, transaction);
        if (state?.draft && matchesReleaseRequest(state, transaction))
          return state;
        lastError = new ActionError(
          502,
          "release_created_unconfirmed",
          "GitHub returned an invalid draft release.",
        );
      } catch (error) {
        lastError = error;
      }

      try {
        const current = await readReleaseByTag(
          transaction.repository,
          transaction.tag,
        );
        if (current) {
          const state = ownedRelease(current, transaction);
          if (state?.draft && matchesReleaseRequest(state, transaction))
            return state;
          if (state && !matchesReleaseRequest(state, transaction)) {
            throw new ActionError(
              409,
              "release_changed",
              "The owned draft release does not match the reviewed release contents.",
            );
          }
          throw new ActionError(
            409,
            "release_create_conflict",
            "Another release now uses this tag. No foreign release was changed.",
          );
        }
      } catch (error) {
        if (
          error instanceof ActionError &&
          error.code === "release_create_conflict"
        )
          throw error;
        lastError = error;
      }
    }
    throw executorError(
      lastError,
      "release_created_unconfirmed",
      "The draft release creation could not be confirmed.",
      503,
    );
  }

  async function publishDraft(transaction) {
    let lastError = null;
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const before = await readReleaseById(
          transaction.repository,
          transaction.releaseId,
        );
        const ownedBefore = ownedRelease(before, transaction);
        if (!ownedBefore) {
          throw new ActionError(
            409,
            "release_changed",
            "The owned draft release changed before publication.",
          );
        }
        if (!matchesReleaseRequest(ownedBefore, transaction)) {
          throw new ActionError(
            409,
            "release_changed",
            "The owned draft release does not match the requested pre-release state.",
          );
        }
        if (!ownedBefore.draft) {
          const normalized = normalizeRelease(before, transaction.repository);
          if (normalized) return normalized;
          throw new ActionError(
            502,
            "release_created_unconfirmed",
            "The published release is incomplete.",
          );
        }
        const value = await executor.rest(
          `repos/${transaction.repository}/releases/${transaction.releaseId}`,
          {
            fields: { draft: false, prerelease: transaction.prerelease },
            method: "PATCH",
            validate: isRecord,
          },
        );
        const state = ownedRelease(value, transaction);
        const normalized = normalizeRelease(value, transaction.repository);
        if (state && !matchesReleaseRequest(state, transaction)) {
          throw new ActionError(
            409,
            "release_changed",
            "The published release does not match the requested pre-release state.",
          );
        }
        if (state && !state.draft && normalized) return normalized;
        lastError = new ActionError(
          502,
          "release_created_unconfirmed",
          "GitHub returned an invalid published release.",
        );
      } catch (error) {
        if (error instanceof ActionError && error.code === "release_changed")
          throw error;
        lastError = error;
      }

      try {
        const current = await readReleaseById(
          transaction.repository,
          transaction.releaseId,
        );
        const state = ownedRelease(current, transaction);
        if (!state) {
          throw new ActionError(
            409,
            "release_changed",
            "The owned release changed during publication.",
          );
        }
        if (!matchesReleaseRequest(state, transaction)) {
          throw new ActionError(
            409,
            "release_changed",
            "The published release does not match the requested pre-release state.",
          );
        }
        if (!state.draft) {
          const normalized = normalizeRelease(current, transaction.repository);
          if (normalized) return normalized;
        }
      } catch (error) {
        if (error instanceof ActionError && error.code === "release_changed")
          throw error;
        lastError = error;
      }
    }
    throw executorError(
      lastError,
      "release_publish_unconfirmed",
      "The release publication could not be confirmed.",
      503,
    );
  }

  async function removeOwnedRelease(transaction) {
    let current;
    try {
      current = transaction.releaseId
        ? await readReleaseById(transaction.repository, transaction.releaseId)
        : await readReleaseByTag(transaction.repository, transaction.tag);
    } catch {
      return ROLLBACK.manual;
    }
    if (!current) return ROLLBACK.clean;
    if (!markedRelease(current, transaction)) {
      return transaction.releaseId ? ROLLBACK.manual : ROLLBACK.preserved;
    }
    return ROLLBACK.manual;
  }

  async function removeOwnedReference(transaction) {
    try {
      const release = await readReleaseByTag(
        transaction.repository,
        transaction.tag,
      );
      if (release) {
        return markedRelease(release, transaction)
          ? ROLLBACK.manual
          : ROLLBACK.preserved;
      }
    } catch {
      return ROLLBACK.manual;
    }

    let reference;
    try {
      reference = await readReference(transaction.repository, transaction.tag);
    } catch {
      return ROLLBACK.manual;
    }
    if (!reference) return ROLLBACK.clean;
    if (reference.type !== "tag" || reference.oid !== transaction.tagObjectOid)
      return ROLLBACK.preserved;
    return ROLLBACK.manual;
  }

  async function rollbackRelease(transaction) {
    const release = await removeOwnedRelease(transaction);
    if (release !== ROLLBACK.clean) return release;
    return removeOwnedReference(transaction);
  }

  async function create(value) {
    const input = validateCreateReleaseInput(value);
    const key = input.repository.toLowerCase();
    if (activeReleases.has(key)) {
      throw new ActionError(
        409,
        "release_running",
        "A release is already being created for this repository.",
      );
    }
    activeReleases.add(key);
    try {
      const binding = await authorizeRepository(input.repository);
      const captured = await capturePreview(input, binding, { cache: false });
      if (!sameReleasePreview(captured.preview, input.preview)) {
        throw new ActionError(
          409,
          "release_preview_changed",
          "The release contents changed. Review the included pull requests again.",
        );
      }
      const commitOid = captured.preview.targetOid;
      const transaction = {
        commitOid,
        marker: markerFor(identifier()),
        notes: {
          body: input.preview.body,
          name: input.preview.name,
        },
        prerelease: input.prerelease,
        releaseId: null,
        repository: input.repository,
        tag: input.tag,
        tagger: {
          name: TAGGER_NAME,
          email: TAGGER_EMAIL,
          date: new Date(Math.floor(now() / 1_000) * 1_000).toISOString(),
        },
      };
      transaction.tagMessage = `${transaction.marker}\n`;
      transaction.tagObjectOid = tagObjectOid(transaction);
      try {
        await createTagObject(transaction);
        await createReference(transaction);
        const [afterTag, afterTarget] = await Promise.all([
          listTags(executor, input.repository),
          defaultCommit(input.repository),
        ]);
        const base = nextPatchTag(afterTag.filter((tag) => tag !== input.tag));
        if (
          base.latestTag !== input.expectedLatestTag ||
          afterTarget !== input.preview.targetOid ||
          !(await confirmOwnedTag(transaction))
        ) {
          throw new ActionError(
            409,
            "release_target_changed",
            "The release base or owned tag changed before draft creation.",
          );
        }
        const draft = await createDraft(transaction);
        transaction.releaseId = draft.id;
        if (!(await confirmOwnedTag(transaction))) {
          throw new ActionError(
            409,
            "release_target_changed",
            "The owned release tag changed before publication.",
          );
        }
        await publishDraft(transaction);
        if (!(await confirmOwnedTag(transaction))) {
          throw new ActionError(
            409,
            "release_target_changed",
            "The owned release tag changed during publication.",
          );
        }
        const published = await readReleaseById(
          transaction.repository,
          transaction.releaseId,
        );
        const finalState = ownedRelease(published, transaction);
        const normalized = normalizeRelease(published, transaction.repository);
        if (
          !finalState ||
          finalState.draft ||
          !matchesReleaseRequest(finalState, transaction) ||
          !normalized
        ) {
          throw new ActionError(
            409,
            "release_changed",
            "The published release changed before the release transaction completed.",
          );
        }

        invalidate();
        await Promise.allSettled([
          Promise.resolve().then(() => invalidateReadiness()),
          Promise.resolve().then(() =>
            refetch({ repository: input.repository, tag: input.tag }),
          ),
        ]);
        return {
          id: normalized.id,
          name: normalized.name,
          publishedAt: normalized.publishedAt,
          repository: input.repository,
          tag: input.tag,
          url: normalized.url,
        };
      } catch (error) {
        const rollback = transaction.tagObjectOid
          ? await rollbackRelease(transaction)
          : ROLLBACK.clean;
        if (rollback === ROLLBACK.manual || rollback === ROLLBACK.preserved) {
          throw new ActionError(
            409,
            "release_manual_reconciliation_required",
            "The failed release transaction left a release or tag on GitHub. Puller preserved the remote state because GitHub does not support atomic conditional deletion for releases or tag references. Inspect it before retrying.",
          );
        }
        if (error instanceof ActionError) throw error;
        throw executorError(
          error,
          "release_failed",
          "GitHub could not create the release.",
        );
      }
    } finally {
      activeReleases.delete(key);
    }
  }

  async function exactRelease(value) {
    let raw;
    try {
      raw = await executor.rest(
        `repos/${value.repository}/releases/${value.releaseId}`,
        { validate: isRecord },
      );
    } catch (error) {
      throw executorError(
        error,
        "verification_evidence_unavailable",
        "Release verification evidence could not be refreshed.",
        503,
      );
    }
    const release = normalizeRelease(raw, value.repository);
    if (
      !release ||
      release.draft ||
      release.id !== value.releaseId ||
      release.tag !== value.tag
    )
      return null;
    return release;
  }

  async function predecessorFor(release) {
    const markers = new Set();
    const published = new Map();
    for (let page = 1; page <= MAXIMUM_RELEASE_PAGES; page += 1) {
      let values;
      try {
        values = await executor.rest(
          withPage(`repos/${release.repository}/releases`, page),
          {
            validate: Array.isArray,
          },
        );
      } catch (error) {
        throw executorError(
          error,
          "verification_evidence_unavailable",
          "Release verification evidence could not be refreshed.",
          503,
        );
      }
      const marker =
        values.length === 0
          ? "empty"
          : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`;
      if (values.length > 0 && markers.has(marker)) {
        throw new ActionError(
          502,
          "github_pagination",
          "GitHub repeated a release page.",
        );
      }
      markers.add(marker);
      for (const value of values) {
        if (isRecord(value) && value.draft === true) continue;
        const candidate = normalizeRelease(value, release.repository);
        if (!candidate || candidate.draft) {
          throw new ActionError(
            502,
            "verification_evidence_incomplete",
            "GitHub returned incomplete published release evidence.",
          );
        }
        const existing = published.get(candidate.id);
        if (
          existing &&
          (existing.tag !== candidate.tag ||
            existing.publishedAt !== candidate.publishedAt ||
            existing.url !== candidate.url)
        ) {
          throw new ActionError(
            502,
            "verification_evidence_changed",
            "A published release changed while its adjacency was loaded.",
          );
        }
        published.set(candidate.id, candidate);
      }
      if (values.length < PAGE_SIZE) break;
      if (page === MAXIMUM_RELEASE_PAGES) {
        throw new ActionError(
          502,
          "verification_evidence_incomplete",
          "GitHub release pagination exceeded the verification bound.",
        );
      }
    }

    const ordered = [...published.values()].sort(compareReleases);
    const index = ordered.findIndex((candidate) => candidate.id === release.id);
    if (index < 0) return undefined;
    const listed = ordered[index];
    if (!sameRelease(listed, release)) return undefined;
    return ordered[index + 1] ?? null;
  }

  async function tagCommit(repository, tag) {
    const fail = () =>
      new ActionError(
        409,
        "release_changed",
        "The release tag no longer resolves to the authorized commit.",
      );
    let reference;
    try {
      reference = await executor.rest(
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
        {
          validate: isRecord,
        },
      );
    } catch (error) {
      if (error instanceof ExecutorError && error.status === 404) throw fail();
      throw executorError(
        error,
        "verification_evidence_unavailable",
        "The release tag could not be refreshed.",
        503,
      );
    }
    if (reference.ref !== `refs/tags/${tag}` || !isRecord(reference.object))
      throw fail();

    let target = reference.object;
    const visited = new Set();
    while (target.type === "tag") {
      if (
        typeof target.sha !== "string" ||
        !SHA.test(target.sha) ||
        visited.has(target.sha)
      )
        throw fail();
      visited.add(target.sha);
      if (visited.size > 32) throw fail();
      let annotated;
      try {
        annotated = await executor.rest(
          `repos/${repository}/git/tags/${target.sha}`,
          {
            validate: isRecord,
          },
        );
      } catch (error) {
        throw executorError(
          error,
          "verification_evidence_unavailable",
          "The release tag could not be peeled.",
          503,
        );
      }
      if (!isRecord(annotated.object)) throw fail();
      target = annotated.object;
    }
    if (
      target.type !== "commit" ||
      typeof target.sha !== "string" ||
      !SHA.test(target.sha)
    ) {
      throw fail();
    }
    return target.sha.toLowerCase();
  }

  async function resolveVerification(value) {
    const release = await exactRelease(value);
    if (!release) return null;
    const predecessor = await predecessorFor(release);
    if (predecessor === undefined) return null;

    let viewerLogin;
    try {
      viewerLogin = await viewer();
      const before = await tagCommit(value.repository, value.tag);
      const baseBefore = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null;

      const rawPull = await executor.rest(
        `repos/${value.repository}/pulls/${value.pullNumber}`,
        { validate: isRecord },
      );
      const pull = normalizeAssociatedPull(
        rawPull,
        value.repository,
        viewerLogin,
      );
      if (
        !pull ||
        pull.number !== value.pullNumber ||
        pull.url !== value.pullUrl ||
        pull.headSha !== String(value.headSha).toLowerCase() ||
        !(predecessor
          ? await commitInRange(
              executor,
              value.repository,
              baseBefore,
              before,
              pull.mergeCommitSha,
            )
          : await commitInFirstRelease(
              executor,
              value.repository,
              before,
              pull.mergeCommitSha,
            ))
      )
        return null;

      const target = await loadVerificationTarget(executor, pull);
      const confirmedRawPull = await executor.rest(
        `repos/${value.repository}/pulls/${value.pullNumber}`,
        {
          validate: isRecord,
        },
      );
      const confirmedPull = normalizeAssociatedPull(
        confirmedRawPull,
        value.repository,
        viewerLogin,
      );
      if (!sameAssociatedPull(pull, confirmedPull)) return null;

      const currentRelease = await exactRelease(value);
      if (!sameRelease(currentRelease, release)) return null;
      const after = await tagCommit(value.repository, value.tag);
      const baseAfter = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null;
      if (after !== before || baseAfter !== baseBefore) return null;
      const currentPredecessor = await predecessorFor(currentRelease);
      if (
        currentPredecessor === undefined ||
        (predecessor === null
          ? currentPredecessor !== null
          : !sameRelease(currentPredecessor, predecessor))
      )
        return null;
      const { body: _body, draft: _draft, ...authorized } = currentRelease;

      const releasedPull = publicPull(confirmedPull);
      return {
        context: target.context,
        pull: releasedPull,
        release: {
          ...authorized,
          commitOid: after,
          complete: true,
          predecessorCommitOid: baseAfter,
          predecessorTag: predecessor?.tag ?? null,
          pulls: [releasedPull],
          source: "comparison",
          warning: null,
        },
        targetDelta: target.targetDelta,
      };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw executorError(
        error,
        "verification_evidence_unavailable",
        "Release verification evidence could not be refreshed.",
        503,
      );
    }
  }

  async function resolveReleaseVerifications(value) {
    const release = await exactRelease(value);
    if (!release) return null;
    const predecessor = await predecessorFor(release);
    if (predecessor === undefined) return null;

    try {
      const viewerLogin = await viewer();
      const before = await tagCommit(value.repository, value.tag);
      const baseBefore = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null;
      const numbers = pullNumbersFromNotes(release.body, value.repository);
      const pulls = (
        await mapLimit(numbers, READ_CONCURRENCY, async (number) => {
          const raw = await executor.rest(
            `repos/${value.repository}/pulls/${number}`,
            { validate: isRecord },
          );
          const pull = normalizeAssociatedPull(
            raw,
            value.repository,
            viewerLogin,
          );
          if (pull === false) return null;
          if (!pull) {
            throw new ActionError(
              409,
              "verification_membership_changed",
              "A released pull request identity could not be confirmed.",
            );
          }
          const included = predecessor
            ? await commitInRange(
                executor,
                value.repository,
                baseBefore,
                before,
                pull.mergeCommitSha,
              )
            : await commitInFirstRelease(
                executor,
                value.repository,
                before,
                pull.mergeCommitSha,
              );
          if (!included) return null;

          const confirmedRaw = await executor.rest(
            `repos/${value.repository}/pulls/${number}`,
            { validate: isRecord },
          );
          const confirmed = normalizeAssociatedPull(
            confirmedRaw,
            value.repository,
            viewerLogin,
          );
          if (!sameAssociatedPull(pull, confirmed)) {
            throw new ActionError(
              409,
              "verification_membership_changed",
              "A released pull request changed while verification was queued.",
            );
          }
          return publicPull(confirmed);
        })
      ).filter(Boolean);

      const currentRelease = await exactRelease(value);
      if (
        !sameRelease(currentRelease, release) ||
        currentRelease.body !== release.body
      )
        return null;
      const after = await tagCommit(value.repository, value.tag);
      const baseAfter = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null;
      if (after !== before || baseAfter !== baseBefore) return null;
      const currentPredecessor = await predecessorFor(currentRelease);
      if (
        currentPredecessor === undefined ||
        (predecessor === null
          ? currentPredecessor !== null
          : !sameRelease(currentPredecessor, predecessor))
      )
        return null;

      const { body: _body, draft: _draft, ...authorized } = currentRelease;
      return {
        pulls,
        release: {
          ...authorized,
          commitOid: after,
          complete: true,
          pulls,
          source: "comparison",
          warning: null,
        },
      };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw executorError(
        error,
        "verification_evidence_unavailable",
        "Release verification evidence could not be refreshed.",
        503,
      );
    }
  }

  return Object.freeze({
    activeReleaseCount: () => activeReleases.size,
    create,
    getOptions: options,
    getPipelines: pipelines,
    getRecent: recent,
    invalidate,
    options,
    pipelines,
    preview,
    primeRepositories,
    recent,
    resolveReleaseVerifications,
    resolveVerification,
  });
}
