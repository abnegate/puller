import { createHash, randomUUID } from 'node:crypto'

import { ActionError } from './claude.mjs'
import { ExecutorError } from './executor.mjs'
import { validateReleaseTag } from './workspace.mjs'

const CACHE_TTL = 5 * 60 * 1_000
const AUTHORED_MERGED_WINDOW = 90 * 24 * 60 * 60 * 1_000
const RECENT_RELEASE_WINDOW = 7 * 24 * 60 * 60 * 1_000
const PAGE_SIZE = 100
const READ_CONCURRENCY = 12
const VERIFICATION_CONTEXT_LIMIT = 96 * 1024
const MAXIMUM_PULL_FILES = 3_000
const MAXIMUM_RELEASE_PAGES = 100
const MAXIMUM_SEARCH_RESULTS = 1_000
const MAXIMUM_SEARCH_PAGES = MAXIMUM_SEARCH_RESULTS / PAGE_SIZE
const RECONCILIATION_ATTEMPTS = 3
const PREVIOUS_TAG_LIMIT = 10
export const VERIFICATION_OMISSION_MARKER =
  'Verification evidence is incomplete: one or more files or patches were omitted.'
const RELEASE_MARKER = 'puller-release:'
const TAGGER_EMAIL = 'puller@users.noreply.github.com'
const TAGGER_NAME = 'Puller'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const VERSION = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION_LIKE = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/
const SHA = /^[a-f0-9]{40}$/i

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
`

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validRepository(value) {
  return typeof value === 'string' &&
    REPOSITORY.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
}

function validateRepository(value) {
  if (!validRepository(value)) {
    throw new ActionError(400, 'invalid_repository', 'The repository is invalid.')
  }
  return value
}

function safeVersion(value) {
  if (typeof value !== 'string' || value.startsWith('-')) return null
  const match = VERSION.exec(value)
  if (!match) return null
  return {
    tag: value,
    prefix: match[1],
    parts: [BigInt(match[2]), BigInt(match[3]), BigInt(match[4])],
  }
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] > right.parts[index]) return 1
    if (left.parts[index] < right.parts[index]) return -1
  }
  if (left.prefix === right.prefix) return 0
  return left.prefix === 'v' ? 1 : -1
}

export function nextPatchTag(tags) {
  if (!Array.isArray(tags)) throw new TypeError('Tags must be an array.')
  const versions = tags
    .map((value) => safeVersion(typeof value === 'string' ? value : value?.name))
    .filter(Boolean)
  if (versions.length === 0) {
    return { latestTag: null, nextTag: 'v0.1.0' }
  }
  const latest = versions.reduce((winner, candidate) =>
    compareVersion(candidate, winner) > 0 ? candidate : winner)
  return {
    latestTag: latest.tag,
    nextTag: `${latest.prefix}${latest.parts[0]}.${latest.parts[1]}.${latest.parts[2] + 1n}`,
  }
}

function naturalParts(value) {
  return value.match(/\d+|\D+/g) ?? []
}

function compareText(left, right) {
  if (left === right) return 0
  const foldedLeft = left.toLowerCase()
  const foldedRight = right.toLowerCase()
  if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1
  return left < right ? -1 : 1
}

function compareNatural(left, right) {
  const leftParts = naturalParts(left)
  const rightParts = naturalParts(right)
  const length = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) {
      const leftValue = BigInt(leftPart)
      const rightValue = BigInt(rightPart)
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
      if (leftPart !== rightPart) return leftPart.length < rightPart.length ? -1 : 1
      continue
    }
    const comparison = compareText(leftPart, rightPart)
    if (comparison !== 0) return comparison
  }
  if (leftParts.length !== rightParts.length) {
    return leftParts.length < rightParts.length ? -1 : 1
  }
  return compareText(left, right)
}

function versionLike(tag) {
  const match = VERSION_LIKE.exec(tag)
  if (!match) return null
  return {
    parts: [BigInt(match[2]), BigInt(match[3]), BigInt(match[4])],
    prefix: match[1],
    suffix: match[5] ?? null,
  }
}

function comparePreviousTags(left, right) {
  const leftVersion = versionLike(left)
  const rightVersion = versionLike(right)
  if (leftVersion && rightVersion) {
    for (let index = 0; index < 3; index += 1) {
      if (leftVersion.parts[index] !== rightVersion.parts[index]) {
        return leftVersion.parts[index] > rightVersion.parts[index] ? -1 : 1
      }
    }
    if (leftVersion.suffix === null && rightVersion.suffix !== null) return -1
    if (leftVersion.suffix !== null && rightVersion.suffix === null) return 1
    if (leftVersion.suffix !== null && rightVersion.suffix !== null) {
      const suffix = compareNatural(leftVersion.suffix, rightVersion.suffix)
      if (suffix !== 0) return -suffix
    }
    if (leftVersion.prefix !== rightVersion.prefix) return leftVersion.prefix === 'v' ? -1 : 1
    return -compareNatural(left, right)
  }
  if (leftVersion) return -1
  if (rightVersion) return 1
  return -compareNatural(left, right)
}

function previousTags(tags) {
  return [...new Set(tags)].sort(comparePreviousTags).slice(0, PREVIOUS_TAG_LIMIT)
}

function withPage(endpoint, page) {
  const separator = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`
}

async function pagesOfArrays(executor, endpoint) {
  const items = []
  let page = 1
  let previous = null
  while (true) {
    const values = await executor.rest(withPage(endpoint, page), {
      validate: Array.isArray,
    })
    const marker = values.length === 0
      ? 'empty'
      : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`
    if (page > 1 && values.length > 0 && marker === previous) {
      throw new ActionError(502, 'github_pagination', 'GitHub repeated a pagination page.')
    }
    items.push(...values)
    if (values.length < PAGE_SIZE) return items
    previous = marker
    page += 1
  }
}

function createSemaphore(limit) {
  let active = 0
  const waiting = []
  return async function use(operation) {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve))
    }
    active += 1
    try {
      return await operation()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

async function mapLimit(values, limit, operation) {
  const use = createSemaphore(limit)
  return Promise.all(values.map((value, index) => use(() => operation(value, index))))
}

function executorError(error, code, message, status = 502) {
  if (error instanceof ActionError) return error
  if (error instanceof ExecutorError) return new ActionError(error.status, code, message)
  return new ActionError(status, code, message)
}

function repositoryFromApiUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') return null
    const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    const repository = match ? `${match[1]}/${match[2]}` : null
    return validRepository(repository) ? repository : null
  } catch {
    return null
  }
}

function repositoriesFromSnapshot(snapshot) {
  const pulls = snapshot?.pulls ?? [
    ...(snapshot?.ready ?? []),
    ...(snapshot?.notReady ?? []),
  ]
  if (!Array.isArray(pulls)) return []
  return pulls
    .filter((pull) => validRepository(pull?.repository))
    .map((pull) => ({
      repository: pull.repository,
      repositoryUrl: typeof pull.repositoryUrl === 'string'
        ? pull.repositoryUrl
        : `https://github.com/${pull.repository}`,
    }))
}

function normalizeViewer(value) {
  if (typeof value !== 'string') return null
  const login = value.trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return null
  return { key: login.toLowerCase(), login }
}

function normalizeMerged(value) {
  if (Array.isArray(value)) return { incomplete: false, items: value }
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.incomplete !== 'boolean') {
    throw new TypeError('Merged pull request evidence is invalid.')
  }
  return value
}

function authoredMergedCutoffDate(now) {
  return new Date(now() - AUTHORED_MERGED_WINDOW).toISOString().slice(0, 10)
}

async function searchMerged(executor, viewerLogin, now) {
  const query = `is:pr author:${viewerLogin} is:merged merged:>=${authoredMergedCutoffDate(now)}`
  if (typeof executor.graphql === 'function') {
    const items = []
    let after = null
    let incomplete = false
    let total = 0
    const cursors = new Set()
    for (let page = 1; page <= MAXIMUM_SEARCH_PAGES; page += 1) {
      const response = await executor.graphql(
        MERGED_PULLS_QUERY,
        { after, searchQuery: query },
        {
          validate: (value) => isRecord(value?.search) &&
            Number.isSafeInteger(value.search.issueCount) &&
            Array.isArray(value.search.nodes) &&
            isRecord(value.search.pageInfo) &&
            typeof value.search.pageInfo.hasNextPage === 'boolean',
        },
      )
      total = response.search.issueCount
      for (const value of response.search.nodes) {
        const pull = normalizeGraphqlPull(value, viewerLogin)
        if (pull) {
          items.push({
            number: pull.number,
            pull,
            repository: pull.repository,
            repositoryUrl: `https://github.com/${pull.repository}`,
          })
        } else {
          incomplete = true
        }
      }
      if (!response.search.pageInfo.hasNextPage) break
      const cursor = response.search.pageInfo.endCursor
      if (
        page === MAXIMUM_SEARCH_PAGES ||
        typeof cursor !== 'string' || !cursor || cursors.has(cursor)
      ) {
        incomplete = true
        break
      }
      cursors.add(cursor)
      after = cursor
    }
    return { incomplete: incomplete || total > items.length, items }
  }

  const items = []
  let page = 1
  let total = 0
  let incomplete = false
  const markers = new Set()
  while (page <= MAXIMUM_SEARCH_PAGES) {
    const endpoint = `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc`
    const response = await executor.rest(withPage(endpoint, page), {
      validate: (value) => isRecord(value) &&
        Number.isSafeInteger(value.total_count) &&
        Array.isArray(value.items) &&
        typeof value.incomplete_results === 'boolean',
    })
    total = response.total_count
    incomplete ||= response.incomplete_results
    const marker = response.items.length === 0
      ? 'empty'
      : `${response.items.length}:${JSON.stringify(response.items[0])}:${JSON.stringify(response.items.at(-1))}`
    if (response.items.length > 0 && markers.has(marker)) {
      incomplete = true
      break
    }
    markers.add(marker)
    items.push(...response.items)
    if (response.items.length < PAGE_SIZE || items.length >= Math.min(total, MAXIMUM_SEARCH_RESULTS)) break
    if (page === MAXIMUM_SEARCH_PAGES) incomplete = true
    page += 1
  }
  return {
    incomplete: incomplete || total > items.length,
    items,
  }
}

function normalizeGraphqlPull(value, viewerLogin) {
  if (
    !isRecord(value) || !isRecord(value.author) ||
    typeof value.author.login !== 'string' ||
    value.author.login.toLowerCase() !== viewerLogin.toLowerCase() ||
    typeof value.headRefOid !== 'string' || !SHA.test(value.headRefOid) ||
    !isRecord(value.mergeCommit) || typeof value.mergeCommit.oid !== 'string' ||
    !SHA.test(value.mergeCommit.oid) ||
    typeof value.mergedAt !== 'string' || Number.isNaN(Date.parse(value.mergedAt)) ||
    !Number.isSafeInteger(value.number) || value.number < 1 ||
    !isRecord(value.repository) || !validRepository(value.repository.nameWithOwner) ||
    typeof value.title !== 'string' || typeof value.url !== 'string'
  ) return null
  const repository = value.repository.nameWithOwner
  const canonical = `https://github.com/${repository}/pull/${value.number}`
  if (value.url.toLowerCase() !== canonical.toLowerCase()) return null
  return {
    headSha: value.headRefOid.toLowerCase(),
    mergeCommitSha: value.mergeCommit.oid.toLowerCase(),
    mergedAt: value.mergedAt,
    number: value.number,
    repository,
    title: value.title,
    url: canonical,
  }
}

async function listTags(executor, repository) {
  const values = await pagesOfArrays(executor, `repos/${repository}/tags`)
  if (values.some((tag) => !isRecord(tag) || typeof tag.name !== 'string')) {
    throw new ActionError(502, 'tags_incomplete', 'GitHub returned incomplete repository tags.')
  }
  return values.map((tag) => tag.name)
}

function normalizeRelease(value, repository) {
  const id = String(value?.id ?? '')
  if (
    !isRecord(value) ||
    (typeof value.id !== 'number' && typeof value.id !== 'string') ||
    (typeof value.id === 'number' && (!Number.isSafeInteger(value.id) || value.id < 1)) ||
    !/^[1-9]\d*$/.test(id) ||
    typeof value.tag_name !== 'string' || value.tag_name === '' ||
    typeof value.html_url !== 'string' ||
    typeof value.published_at !== 'string' || Number.isNaN(Date.parse(value.published_at)) ||
    typeof value.draft !== 'boolean'
  ) return null
  return {
    body: typeof value.body === 'string' ? value.body : '',
    draft: value.draft,
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : value.tag_name,
    publishedAt: value.published_at,
    repository,
    repositoryUrl: `https://github.com/${repository}`,
    tag: value.tag_name,
    url: value.html_url,
  }
}

function compareReleases(left, right) {
  const time = Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
  if (time !== 0) return time
  const leftId = BigInt(left.id)
  const rightId = BigInt(right.id)
  if (leftId > rightId) return -1
  if (leftId < rightId) return 1
  return 0
}

function sameRelease(left, right) {
  return Boolean(left && right) &&
    left.id === right.id &&
    left.publishedAt === right.publishedAt &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.tag === right.tag &&
    left.url === right.url
}

function tagObjectOid(transaction) {
  const timestamp = Math.floor(Date.parse(transaction.tagger.date) / 1_000)
  const content = [
    `object ${transaction.commitOid}`,
    'type commit',
    `tag ${transaction.tag}`,
    `tagger ${transaction.tagger.name} <${transaction.tagger.email}> ${timestamp} +0000`,
    '',
    transaction.tagMessage,
  ].join('\n')
  const header = `tag ${Buffer.byteLength(content, 'utf8')}\0`
  return createHash('sha1').update(header).update(content).digest('hex')
}

async function listRelevantReleases(executor, repository) {
  const published = new Map()
  const markers = new Set()
  const warnings = []
  let incomplete = false
  for (let page = 1; page <= MAXIMUM_RELEASE_PAGES; page += 1) {
    const values = await executor.rest(withPage(`repos/${repository}/releases`, page), {
      validate: Array.isArray,
    })
    const marker = values.length === 0
      ? 'empty'
      : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`
    if (values.length > 0 && markers.has(marker)) {
      incomplete = true
      warnings.push(`${repository} returned a repeated release page.`)
      break
    }
    markers.add(marker)
    for (const value of values) {
      if (isRecord(value) && value.draft === true) continue
      const release = normalizeRelease(value, repository)
      if (!release || release.draft) {
        incomplete = true
        continue
      }
      const existing = published.get(release.id)
      if (existing && !sameRelease(existing, release)) incomplete = true
      if (!existing) published.set(release.id, release)
    }
    if (values.length < PAGE_SIZE) break
    if (page === MAXIMUM_RELEASE_PAGES) {
      incomplete = true
      warnings.push(`${repository} release pagination exceeded the safe bound.`)
    }
  }
  if (incomplete && !warnings.some((warning) => warning.includes('repeated release page') ||
      warning.includes('safe bound'))) {
    warnings.push(`${repository} returned malformed or changing published release data.`)
  }
  const releases = [...published.values()]
    .sort(compareReleases)
  return { incomplete, releases, warnings }
}

function normalizeAssociatedPull(value, repository, viewerLogin) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.number) || value.number < 1 ||
    typeof value.title !== 'string' ||
    typeof value.html_url !== 'string' ||
    typeof value.merged_at !== 'string' || Number.isNaN(Date.parse(value.merged_at)) ||
    !isRecord(value.user) || typeof value.user.login !== 'string' ||
    !isRecord(value.head) || typeof value.head.sha !== 'string' || !SHA.test(value.head.sha) ||
    typeof value.merge_commit_sha !== 'string' || !SHA.test(value.merge_commit_sha)
  ) return null
  if (value.user.login.toLowerCase() !== viewerLogin.toLowerCase()) return false
  const canonical = `https://github.com/${repository}/pull/${value.number}`
  if (value.html_url.toLowerCase() !== canonical.toLowerCase()) return null
  return {
    headSha: value.head.sha.toLowerCase(),
    mergeCommitSha: value.merge_commit_sha.toLowerCase(),
    mergedAt: value.merged_at,
    number: value.number,
    repository,
    title: value.title,
    url: canonical,
  }
}

function publicPull(pull) {
  const { mergeCommitSha: _mergeCommitSha, ...value } = pull
  return value
}

function mergedCandidate(value, viewerLogin) {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || value.number < 1) return null
  const repository = value.repository ?? repositoryFromApiUrl(value.repository_url)
  if (!validRepository(repository)) return null
  if (isRecord(value.user) && typeof value.user.login === 'string' &&
      value.user.login.toLowerCase() !== viewerLogin.toLowerCase()) return null
  const canonical = `https://github.com/${repository}/pull/${value.number}`
  if (typeof value.html_url === 'string' && value.html_url.toLowerCase() !== canonical.toLowerCase()) {
    return null
  }
  const pull = isRecord(value.pull) && value.pull.repository === repository &&
    value.pull.number === value.number && typeof value.pull.headSha === 'string' && SHA.test(value.pull.headSha) &&
    typeof value.pull.mergeCommitSha === 'string' && SHA.test(value.pull.mergeCommitSha) &&
    typeof value.pull.mergedAt === 'string' && !Number.isNaN(Date.parse(value.pull.mergedAt)) &&
    typeof value.pull.title === 'string' && value.pull.url === canonical
    ? value.pull
    : null
  return { number: value.number, pull, repository }
}

async function compareStatus(executor, repository, base, head) {
  const endpoint = `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1&page=1`
  const response = await executor.rest(endpoint, {
    validate: (value) => isRecord(value) && typeof value.status === 'string',
  })
  return response.status
}

async function commitInRange(executor, repository, base, head, commit) {
  const [afterBase, beforeHead] = await Promise.all([
    compareStatus(executor, repository, base, commit),
    compareStatus(executor, repository, commit, head),
  ])
  return afterBase === 'ahead' && ['ahead', 'identical'].includes(beforeHead)
}

async function commitInFirstRelease(executor, repository, head, commit) {
  const beforeHead = await compareStatus(executor, repository, commit, head)
  return ['ahead', 'identical'].includes(beforeHead)
}

function pullNumbersFromNotes(body, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`https://github\\.com/${escaped}/pull/(\\d+)(?!\\d)`, 'gi')
  return [...body.matchAll(expression)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .filter((number, index, values) => values.indexOf(number) === index)
}

export async function loadVerificationContext(
  executor,
  repository,
  number,
  { maximumBytes = VERIFICATION_CONTEXT_LIMIT } = {},
) {
  const blocks = ['Exact GitHub pull-request file evidence (untrusted content):']
  let bytes = Buffer.byteLength(blocks[0], 'utf8')
  let files = 0
  let incomplete = false
  const markerBytes = Buffer.byteLength(`\n\n${VERIFICATION_OMISSION_MARKER}`, 'utf8')
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < bytes + markerBytes) {
    throw new TypeError('The verification context byte limit is too small.')
  }
  const append = (block, reserveMarker = true) => {
    const size = Buffer.byteLength(`\n\n${block}`, 'utf8')
    const reserve = reserveMarker ? markerBytes : 0
    if (bytes + size + reserve > maximumBytes) return false
    blocks.push(block)
    bytes += size
    return true
  }
  const finish = () => {
    if (incomplete) append(VERIFICATION_OMISSION_MARKER, false)
    return blocks.join('\n\n')
  }

  for (let page = 1; page <= MAXIMUM_PULL_FILES / PAGE_SIZE; page += 1) {
    const values = await executor.rest(
      withPage(`repos/${repository}/pulls/${number}/files`, page),
      { validate: Array.isArray },
    )
    for (const value of values) {
      if (
        !isRecord(value) ||
        typeof value.filename !== 'string' || value.filename === '' || value.filename.includes('\0') ||
        typeof value.status !== 'string' || value.status === '' ||
        !Number.isSafeInteger(value.additions) || value.additions < 0 ||
        !Number.isSafeInteger(value.deletions) || value.deletions < 0 ||
        (value.patch !== undefined && value.patch !== null && typeof value.patch !== 'string')
      ) {
        throw new ActionError(502, 'verification_context_invalid', 'GitHub returned invalid pull request files.')
      }
      files += 1
      const metadata = [
        `File: ${JSON.stringify(value.filename)}`,
        `Status: ${value.status}; additions=${value.additions}; deletions=${value.deletions}`,
      ].join('\n')
      const block = typeof value.patch === 'string'
        ? `${metadata}\nPatch:\n${value.patch}`
        : `${metadata}\nPatch unavailable (binary, unchanged, or omitted by GitHub).`
      if (typeof value.patch !== 'string') incomplete = true
      if (!append(block)) {
        incomplete = true
        return finish()
      }
    }
    if (values.length < PAGE_SIZE) {
      if (files === 0 && !append('GitHub reported no changed files for this pull request.')) {
        incomplete = true
      }
      return finish()
    }
  }

  incomplete = true
  return finish()
}

export function validateCreateReleaseInput(value) {
  if (!isRecord(value)) {
    throw new ActionError(400, 'invalid_request', 'The release request is invalid.')
  }
  const repository = validateRepository(value.repository)
  if (!validateReleaseTag(value.tag)) {
    throw new ActionError(400, 'invalid_tag', 'The release tag is invalid.')
  }
  if (value.expectedLatestTag !== null && !safeVersion(value.expectedLatestTag)) {
    throw new ActionError(400, 'invalid_base_tag', 'The expected latest release tag is invalid.')
  }
  return { repository, tag: value.tag, expectedLatestTag: value.expectedLatestTag }
}

export function createReleaseService({
  executor,
  readinessCache = null,
  loadOpenPulls = readinessCache
    ? ({ refresh = false } = {}) => refresh && typeof readinessCache.getFresh === 'function'
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
  if (!executor || typeof executor.rest !== 'function' || typeof executor.action !== 'function') {
    throw new TypeError('A GitHub executor is required.')
  }
  if (typeof identifier !== 'function') throw new TypeError('A release identifier factory is required.')

  let catalog = null
  let catalogInflight = null
  let bootstrapInflight = null
  let viewerGeneration = 0
  let viewerKey = null
  let optionRevision = 0
  let optionCache = null
  let optionLoadedAt = 0
  let optionInflight = null
  let recentRevision = 0
  let recentCache = null
  let recentLoadedAt = 0
  let recentInflight = null
  const activeReleases = new Set()

  async function viewer() {
    const value = await executor.rest('user', {
      validate: (result) => isRecord(result) && normalizeViewer(result.login) !== null,
    })
    return normalizeViewer(value.login).login
  }

  async function loadMerged(viewerLogin) {
    return loadMergedPulls
      ? loadMergedPulls({ viewerLogin, since: authoredMergedCutoffDate(now) })
      : searchMerged(executor, viewerLogin, now)
  }

  async function allowedRepositories({ refreshOpen = false } = {}) {
    const warnings = []
    let partial = false
    const viewerLogin = await viewer()
    const [openResult, mergedResult] = await Promise.allSettled([
      loadOpenPulls({ refresh: refreshOpen }),
      loadMerged(viewerLogin),
    ])
    const repositories = new Map()
    if (openResult.status === 'fulfilled') {
      for (const item of repositoriesFromSnapshot(openResult.value)) {
        repositories.set(item.repository.toLowerCase(), item)
      }
      if (openResult.value?.partial || openResult.value?.stale) {
        partial = true
        warnings.push('Open pull request repositories may be incomplete.')
      }
    } else {
      partial = true
      warnings.push('Open pull request repositories could not be loaded.')
    }

    let merged = { incomplete: true, items: [] }
    if (mergedResult.status === 'fulfilled') {
      merged = normalizeMerged(mergedResult.value)
      for (const item of merged?.items ?? []) {
        const repository = item?.repository ?? repositoryFromApiUrl(item?.repository_url)
        if (!validRepository(repository)) continue
        repositories.set(repository.toLowerCase(), {
          repository,
          repositoryUrl: item?.repositoryUrl ?? `https://github.com/${repository}`,
        })
      }
      if (merged?.incomplete) {
        partial = true
        warnings.push('GitHub truncated the authored merged pull request search.')
      }
    } else {
      partial = true
      warnings.push('Recently merged pull request repositories could not be loaded.')
    }
    return {
      merged,
      open: openResult.status === 'fulfilled' ? openResult.value : null,
      partial,
      repositories: [...repositories.values()],
      viewerLogin,
      warnings,
    }
  }

  function clearViewerData(identity) {
    viewerGeneration += 1
    viewerKey = identity.key
    catalog = null
    catalogInflight = null
    bootstrapInflight = null
    optionRevision += 1
    optionCache = null
    optionLoadedAt = 0
    optionInflight = null
    recentRevision += 1
    recentCache = null
    recentLoadedAt = 0
    recentInflight = null
    return viewerGeneration
  }

  function activateViewer(identity) {
    return viewerKey === identity.key
      ? viewerGeneration
      : clearViewerData(identity)
  }

  async function discoverRepositories(snapshot, identity) {
    const repositories = new Map()
    const warnings = []
    let partial = Boolean(snapshot.partial)
    for (const item of repositoriesFromSnapshot(snapshot)) {
      repositories.set(item.repository.toLowerCase(), item)
    }
    if (snapshot.partial) {
      warnings.push('Open pull request repositories may be incomplete.')
    }

    const mergedResult = await Promise.allSettled([loadMerged(identity.login)])
    if (mergedResult[0].status === 'fulfilled') {
      try {
        const merged = normalizeMerged(mergedResult[0].value)
        for (const item of merged.items) {
          const repository = item?.repository ?? repositoryFromApiUrl(item?.repository_url)
          if (!validRepository(repository)) continue
          repositories.set(repository.toLowerCase(), {
            repository,
            repositoryUrl: item?.repositoryUrl ?? `https://github.com/${repository}`,
          })
        }
        if (merged.incomplete) {
          partial = true
          warnings.push('GitHub truncated the authored merged pull request search.')
        }
      } catch {
        partial = true
        warnings.push('Recently merged pull request repositories could not be loaded.')
      }
    } else {
      partial = true
      warnings.push('Recently merged pull request repositories could not be loaded.')
    }

    return {
      partial,
      repositories: [...repositories.values()]
        .sort((left, right) => left.repository.localeCompare(right.repository)),
      repositoriesUpdatedAt: new Date(now()).toISOString(),
      viewerLogin: identity.login,
      warnings,
    }
  }

  function primeRepositories(snapshot) {
    const identity = normalizeViewer(snapshot?.viewerLogin)
    if (!identity || snapshot?.stale !== false) {
      return Promise.reject(new ActionError(
        503,
        'repository_catalog_unavailable',
        'A fresh authenticated pull request snapshot is required.',
      ))
    }

    const generation = activateViewer(identity)
    if (catalog) return Promise.resolve(catalog)
    if (catalogInflight?.generation === generation) return catalogInflight.promise

    const entry = { generation, key: identity.key, promise: null }
    entry.promise = discoverRepositories(snapshot, identity)
      .then((candidate) => {
        if (viewerGeneration !== generation || viewerKey !== identity.key) return null
        if (catalog && !catalog.partial && candidate.partial) return catalog
        catalog ??= candidate
        return catalog
      })
      .finally(() => {
        if (catalogInflight === entry) catalogInflight = null
      })
    catalogInflight = entry
    return entry.promise
  }

  async function ensureCatalog() {
    if (catalog) return catalog
    if (catalogInflight) {
      const value = await catalogInflight.promise
      if (value) return value
    }
    if (bootstrapInflight) return bootstrapInflight.promise

    const generation = viewerGeneration
    const key = viewerKey
    const entry = { promise: null }
    entry.promise = Promise.resolve()
      .then(() => loadOpenPulls({ refresh: false }))
      .then(async (snapshot) => {
        if (viewerGeneration !== generation || viewerKey !== key) {
          if (catalog) return catalog
          if (catalogInflight) return catalogInflight.promise
          throw new ActionError(503, 'repository_catalog_changed', 'The authenticated viewer changed.')
        }
        const value = await primeRepositories(snapshot)
        if (!value) {
          throw new ActionError(503, 'repository_catalog_changed', 'The authenticated viewer changed.')
        }
        return value
      })
      .finally(() => {
        if (bootstrapInflight === entry) bootstrapInflight = null
      })
    bootstrapInflight = entry
    return entry.promise
  }

  function assertCatalogBinding(binding) {
    if (
      binding.catalog !== catalog ||
      binding.generation !== viewerGeneration ||
      binding.key !== viewerKey
    ) {
      throw new ActionError(409, 'repository_catalog_changed', 'The authenticated viewer changed.')
    }
  }

  async function bindCatalog() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await ensureCatalog()
      const identity = normalizeViewer(value?.viewerLogin)
      const binding = {
        catalog: value,
        generation: viewerGeneration,
        key: viewerKey,
      }
      if (identity?.key === binding.key && value === catalog) return binding
    }
    throw new ActionError(409, 'repository_catalog_changed', 'The authenticated viewer changed.')
  }

  async function authorizeRepository(repository) {
    let allowed
    try {
      allowed = await allowedRepositories({ refreshOpen: true })
    } catch (error) {
      throw executorError(
        error,
        'release_authorization_unavailable',
        'The repository authorization could not be refreshed.',
        503,
      )
    }
    const key = repository.toLowerCase()
    const allowedViewer = normalizeViewer(allowed.viewerLogin)
    const openViewer = normalizeViewer(allowed.open?.viewerLogin)
    const openProof = allowed.open?.stale === false &&
      allowedViewer?.key === openViewer?.key && repositoriesFromSnapshot(allowed.open)
      .some((item) => item.repository.toLowerCase() === key)
    const mergedProof = (allowed.merged?.items ?? []).some((item) => {
      const candidate = item?.repository ?? repositoryFromApiUrl(item?.repository_url)
      return validRepository(candidate) && candidate.toLowerCase() === key
    })
    if (openProof || mergedProof) return
    throw new ActionError(
      403,
      'repository_not_allowed',
      'The repository is not freshly proven by an authored open or recently merged pull request.',
    )
  }

  async function loadOptions(binding) {
    assertCatalogBinding(binding)
    const repositories = await mapLimit(
      binding.catalog.repositories,
      READ_CONCURRENCY,
      async (item) => {
        assertCatalogBinding(binding)
        const tags = await listTags(executor, item.repository)
        assertCatalogBinding(binding)
        return { ...item, ...nextPatchTag(tags), previousTags: previousTags(tags) }
      },
    )
    assertCatalogBinding(binding)
    const generatedAt = new Date(now()).toISOString()
    return {
      generatedAt,
      repositoriesUpdatedAt: binding.catalog.repositoriesUpdatedAt,
      repositories,
      tagsUpdatedAt: generatedAt,
      viewerLogin: binding.catalog.viewerLogin,
      warnings: [...binding.catalog.warnings],
    }
  }

  async function options({ refresh = false } = {}) {
    let binding
    try {
      binding = await bindCatalog()
      assertCatalogBinding(binding)
    } catch (error) {
      throw executorError(error, 'release_options_unavailable', 'Release options could not be loaded.', 503)
    }
    if (!refresh && optionCache && now() - optionLoadedAt < ttl) return optionCache
    const fallback = optionCache
    const generation = binding.generation
    const revision = optionRevision
    if (!optionInflight || optionInflight.generation !== generation || optionInflight.revision !== revision) {
      const entry = { generation, revision, promise: null }
      entry.promise = loadOptions(binding)
        .then((value) => {
          assertCatalogBinding(binding)
          if (optionRevision !== revision) {
            throw new ActionError(409, 'repository_catalog_changed', 'The authenticated viewer changed.')
          }
          optionCache = value
          optionLoadedAt = now()
          return value
        })
        .finally(() => {
          if (optionInflight === entry) optionInflight = null
        })
      optionInflight = entry
    }
    try {
      return await optionInflight.promise
    } catch (error) {
      if (!refresh && fallback && viewerGeneration === generation) {
        return {
          ...fallback,
          generatedAt: new Date(now()).toISOString(),
          warnings: [...fallback.warnings, 'Showing cached release options because GitHub could not refresh tags.'],
        }
      }
      throw executorError(error, 'release_options_unavailable', 'Release options could not be loaded.', 503)
    }
  }

  function loadCandidates(items, viewerLogin, repositories) {
    const descriptors = new Map()
    for (const item of items) {
      const candidate = mergedCandidate(item, viewerLogin)
      if (!candidate || !repositories.has(candidate.repository.toLowerCase())) continue
      descriptors.set(`${candidate.repository.toLowerCase()}:${candidate.number}`, candidate)
    }

    let incomplete = false
    const pulls = [...descriptors.values()].map((candidate) => {
      if (candidate.pull) return candidate.pull
      incomplete = true
      return null
    })
    const grouped = new Map()
    for (const pull of pulls) {
      if (!pull) continue
      const key = pull.repository.toLowerCase()
      const existing = grouped.get(key) ?? []
      existing.push(pull)
      grouped.set(key, existing)
    }
    return { grouped, incomplete }
  }

  async function loadRecent(binding) {
    assertCatalogBinding(binding)
    const currentCatalog = binding.catalog
    const cutoff = now() - RECENT_RELEASE_WINDOW
    const warnings = [...currentCatalog.warnings]
    let merged = { incomplete: true, items: [] }
    try {
      merged = normalizeMerged(await loadMerged(currentCatalog.viewerLogin))
    } catch {
      warnings.push('Recently merged pull requests could not be refreshed for release membership.')
    }
    assertCatalogBinding(binding)
    let releaseReadsIncomplete = false
    const releaseResults = await mapLimit(currentCatalog.repositories, READ_CONCURRENCY, async ({ repository }) => {
      try {
        assertCatalogBinding(binding)
        const result = await listRelevantReleases(executor, repository)
        assertCatalogBinding(binding)
        releaseReadsIncomplete ||= result.incomplete
        warnings.push(...result.warnings)
        return result.releases
      } catch (error) {
        if (error instanceof ActionError) throw error
        releaseReadsIncomplete = true
        warnings.push(`${repository} releases could not be loaded.`)
        return []
      }
    })
    assertCatalogBinding(binding)
    const work = []
    for (const list of releaseResults) {
      for (const release of list) {
        if (Date.parse(release.publishedAt) >= cutoff) work.push({ release })
      }
    }
    const repositories = new Set(work.map(({ release }) => release.repository.toLowerCase()))
    const candidates = loadCandidates(merged.items, currentCatalog.viewerLogin, repositories)
    if (merged.incomplete || candidates.incomplete) {
      warnings.push('Some authored merged pull requests could not be loaded for release membership.')
    }
    const assignments = new Map(work.map(({ release }) => [release.id, new Map()]))
    for (const [repository, pulls] of candidates.grouped) {
      const intervals = work.filter(({ release }) => release.repository.toLowerCase() === repository)
      for (const pull of pulls) {
        const linked = intervals.filter(({ release }) =>
          pullNumbersFromNotes(release.body, release.repository).includes(pull.number))
        for (const { release } of linked) {
          assignments.get(release.id).set(pull.number, pull)
        }
      }
    }
    const releases = work.flatMap(({ release }) => {
      const pulls = [...assignments.get(release.id).values()]
        .sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt))
        .map(publicPull)
      if (pulls.length === 0) return []
      return [{
        ...release,
        complete: false,
        pulls,
        source: 'notes-fallback',
        warning: 'Discovered from canonical GitHub release-note links; Verify refreshes exact release-boundary membership.',
      }]
    })
    releases.sort(compareReleases)
    const partial = currentCatalog.partial || merged.incomplete || releaseReadsIncomplete || candidates.incomplete
    return {
      generatedAt: new Date(now()).toISOString(),
      partial,
      releases: releases.map(({ body: _body, draft: _draft, ...release }) => release),
      warnings,
    }
  }

  async function recent({ refresh = false } = {}) {
    if (!refresh && recentCache && now() - recentLoadedAt < ttl) return recentCache
    let binding
    try {
      binding = await bindCatalog()
      assertCatalogBinding(binding)
    } catch (error) {
      throw executorError(error, 'releases_unavailable', 'Recent releases could not be loaded.', 503)
    }
    const fallback = recentCache
    const generation = binding.generation
    const revision = recentRevision
    if (!recentInflight || recentInflight.generation !== generation || recentInflight.revision !== revision) {
      const entry = { generation, revision, promise: null }
      entry.promise = loadRecent(binding)
        .then((value) => {
          assertCatalogBinding(binding)
          if (recentRevision !== revision) {
            throw new ActionError(409, 'repository_catalog_changed', 'The authenticated viewer changed.')
          }
          recentCache = value
          recentLoadedAt = now()
          return value
        })
        .finally(() => {
          if (recentInflight === entry) recentInflight = null
        })
      recentInflight = entry
    }
    try {
      return await recentInflight.promise
    } catch (error) {
      if (fallback && viewerGeneration === generation) {
        const generated = now()
        const cutoff = generated - RECENT_RELEASE_WINDOW
        return {
          ...fallback,
          generatedAt: new Date(generated).toISOString(),
          partial: true,
          releases: fallback.releases.filter((release) =>
            Date.parse(release.publishedAt) >= cutoff),
          warnings: [...fallback.warnings, 'Showing cached releases because GitHub could not refresh.'],
        }
      }
      throw executorError(error, 'releases_unavailable', 'Recent releases could not be loaded.', 503)
    }
  }

  function invalidate() {
    optionRevision += 1
    optionCache = null
    optionLoadedAt = 0
    optionInflight = null
    recentRevision += 1
    recentCache = null
    recentLoadedAt = 0
    recentInflight = null
  }

  async function defaultCommit(repository) {
    try {
      const details = await executor.rest(`repos/${repository}`, {
        validate: (value) => isRecord(value) &&
          typeof value.default_branch === 'string' && value.default_branch !== '',
      })
      const commit = await executor.rest(
        `repos/${repository}/commits/${encodeURIComponent(details.default_branch)}`,
        { validate: (value) => isRecord(value) && typeof value.sha === 'string' && SHA.test(value.sha) },
      )
      return commit.sha.toLowerCase()
    } catch (error) {
      throw executorError(
        error,
        'release_target_unavailable',
        'The repository default-branch commit could not be captured.',
        503,
      )
    }
  }

  function missing(error) {
    return error instanceof ExecutorError && error.status === 404
  }

  function markerFor(id) {
    return `<!-- ${RELEASE_MARKER}${id} -->`
  }

  function releaseState(value) {
    if (
      !isRecord(value) ||
      (typeof value.id !== 'number' && typeof value.id !== 'string') ||
      typeof value.tag_name !== 'string' ||
      typeof value.draft !== 'boolean' ||
      typeof value.body !== 'string'
    ) return null
    return {
      body: value.body,
      draft: value.draft,
      id: String(value.id),
      raw: value,
      tag: value.tag_name,
    }
  }

  function ownedRelease(value, transaction) {
    const state = releaseState(value)
    if (!state || state.tag !== transaction.tag || !state.body.includes(transaction.marker)) return null
    if (transaction.releaseId && state.id !== transaction.releaseId) return null
    return state
  }

  function ownedTagObject(value, transaction) {
    return isRecord(value) &&
      typeof value.sha === 'string' && value.sha.toLowerCase() === transaction.tagObjectOid &&
      value.tag === transaction.tag && value.message === transaction.tagMessage &&
      isRecord(value.object) && value.object.type === 'commit' &&
      typeof value.object.sha === 'string' && value.object.sha.toLowerCase() === transaction.commitOid &&
      isRecord(value.tagger) && value.tagger.name === transaction.tagger.name &&
      value.tagger.email === transaction.tagger.email &&
      typeof value.tagger.date === 'string' &&
      Date.parse(value.tagger.date) === Date.parse(transaction.tagger.date)
  }

  async function readOwnedTagObject(transaction) {
    try {
      const value = await executor.rest(
        `repos/${transaction.repository}/git/tags/${transaction.tagObjectOid}`,
        { validate: isRecord },
      )
      if (!ownedTagObject(value, transaction)) {
        throw new ActionError(409, 'tag_object_changed', 'The deterministic release tag object is not owned.')
      }
      return true
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  async function readReference(repository, tag) {
    try {
      const value = await executor.rest(
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
        { validate: isRecord },
      )
      if (value.ref !== `refs/tags/${tag}` || !isRecord(value.object) ||
          typeof value.object.sha !== 'string' || !SHA.test(value.object.sha) ||
          typeof value.object.type !== 'string') {
        throw new ActionError(502, 'tag_invalid', 'GitHub returned an invalid release tag reference.')
      }
      return {
        oid: value.object.sha.toLowerCase(),
        type: value.object.type,
      }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  async function readReleaseById(repository, id) {
    try {
      return await executor.rest(`repos/${repository}/releases/${id}`, { validate: isRecord })
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  async function readReleaseByTag(repository, tag) {
    try {
      return await executor.rest(
        `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        { validate: isRecord },
      )
    } catch (error) {
      if (!missing(error)) throw error
    }
    const values = await pagesOfArrays(executor, `repos/${repository}/releases`)
    return values.find((value) => isRecord(value) && value.tag_name === tag) ?? null
  }

  async function createTagObject(transaction) {
    let lastError = null
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(`repos/${transaction.repository}/git/tags`, {
          fields: {
            message: transaction.tagMessage,
            object: transaction.commitOid,
            tag: transaction.tag,
            tagger: transaction.tagger,
            type: 'commit',
          },
          method: 'POST',
          validate: isRecord,
        })
        if (!ownedTagObject(value, transaction)) {
          throw new ActionError(502, 'tag_object_invalid', 'GitHub returned an invalid owned tag object.')
        }
        return
      } catch (error) {
        lastError = error
      }

      try {
        if (await readOwnedTagObject(transaction)) return
      } catch (error) {
        if (error instanceof ActionError && error.code === 'tag_object_changed') throw error
        lastError = error
      }
    }
    throw executorError(
      lastError,
      'tag_object_create_unconfirmed',
      'The owned release tag object could not be created.',
      503,
    )
  }

  async function confirmOwnedTag(transaction) {
    const reference = await readReference(transaction.repository, transaction.tag)
    if (!reference || reference.type !== 'tag' || reference.oid !== transaction.tagObjectOid) return false
    return readOwnedTagObject(transaction)
  }

  async function createReference(transaction) {
    let lastError = null
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(`repos/${transaction.repository}/git/refs`, {
          fields: { ref: `refs/tags/${transaction.tag}`, sha: transaction.tagObjectOid },
          method: 'POST',
          validate: isRecord,
        })
        if (
          value.ref === `refs/tags/${transaction.tag}` && isRecord(value.object) &&
          value.object.type === 'tag' && typeof value.object.sha === 'string' &&
          value.object.sha.toLowerCase() === transaction.tagObjectOid
        ) return
        lastError = new ActionError(502, 'tag_create_unconfirmed', 'GitHub returned an invalid tag reference.')
      } catch (error) {
        lastError = error
      }

      try {
        const current = await readReference(transaction.repository, transaction.tag)
        if (current?.type === 'tag' && current.oid === transaction.tagObjectOid) return
        if (current) {
          throw new ActionError(
            409,
            'tag_create_conflict',
            'Another actor created the release tag. Reload release options and try again.',
          )
        }
      } catch (error) {
        if (error instanceof ActionError && error.code === 'tag_create_conflict') throw error
        lastError = error
      }
    }
    throw executorError(
      lastError,
      'tag_create_unconfirmed',
      'The release tag creation could not be confirmed.',
      503,
    )
  }

  async function createDraft(transaction) {
    let lastError = null
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const value = await executor.rest(`repos/${transaction.repository}/releases`, {
          fields: {
            body: transaction.marker,
            draft: true,
            generate_release_notes: true,
            prerelease: false,
            tag_name: transaction.tag,
            target_commitish: transaction.commitOid,
          },
          method: 'POST',
          validate: isRecord,
        })
        const state = ownedRelease(value, transaction)
        if (state?.draft) return state
        lastError = new ActionError(502, 'release_created_unconfirmed', 'GitHub returned an invalid draft release.')
      } catch (error) {
        lastError = error
      }

      try {
        const current = await readReleaseByTag(transaction.repository, transaction.tag)
        if (current) {
          const state = ownedRelease(current, transaction)
          if (state?.draft) return state
          throw new ActionError(
            409,
            'release_create_conflict',
            'Another release now uses this tag. No foreign release was changed.',
          )
        }
      } catch (error) {
        if (error instanceof ActionError && error.code === 'release_create_conflict') throw error
        lastError = error
      }
    }
    throw executorError(
      lastError,
      'release_created_unconfirmed',
      'The draft release creation could not be confirmed.',
      503,
    )
  }

  async function publishDraft(transaction) {
    let lastError = null
    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const before = await readReleaseById(transaction.repository, transaction.releaseId)
        const ownedBefore = ownedRelease(before, transaction)
        if (!ownedBefore) {
          throw new ActionError(409, 'release_changed', 'The owned draft release changed before publication.')
        }
        if (!ownedBefore.draft) {
          const normalized = normalizeRelease(before, transaction.repository)
          if (normalized) return normalized
          throw new ActionError(502, 'release_created_unconfirmed', 'The published release is incomplete.')
        }
        const value = await executor.rest(
          `repos/${transaction.repository}/releases/${transaction.releaseId}`,
          { fields: { draft: false }, method: 'PATCH', validate: isRecord },
        )
        const state = ownedRelease(value, transaction)
        const normalized = normalizeRelease(value, transaction.repository)
        if (state && !state.draft && normalized) return normalized
        lastError = new ActionError(502, 'release_created_unconfirmed', 'GitHub returned an invalid published release.')
      } catch (error) {
        if (error instanceof ActionError && error.code === 'release_changed') throw error
        lastError = error
      }

      try {
        const current = await readReleaseById(transaction.repository, transaction.releaseId)
        const state = ownedRelease(current, transaction)
        if (!state) {
          throw new ActionError(409, 'release_changed', 'The owned release changed during publication.')
        }
        if (!state.draft) {
          const normalized = normalizeRelease(current, transaction.repository)
          if (normalized) return normalized
        }
      } catch (error) {
        if (error instanceof ActionError && error.code === 'release_changed') throw error
        lastError = error
      }
    }
    throw executorError(
      lastError,
      'release_publish_unconfirmed',
      'The release publication could not be confirmed.',
      503,
    )
  }

  async function removeOwnedRelease(transaction) {
    let current
    try {
      current = transaction.releaseId
        ? await readReleaseById(transaction.repository, transaction.releaseId)
        : await readReleaseByTag(transaction.repository, transaction.tag)
    } catch {
      return false
    }
    if (!current) return true
    const state = ownedRelease(current, transaction)
    if (!state) return transaction.releaseId === null
    transaction.releaseId = state.id

    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        await executor.action([
          'api', `repos/${transaction.repository}/releases/${transaction.releaseId}`, '--method', 'DELETE',
        ])
      } catch {
        // A lost DELETE response is reconciled by the following exact read.
      }
      try {
        current = await readReleaseById(transaction.repository, transaction.releaseId)
        if (!current) return true
        if (!ownedRelease(current, transaction)) return false
      } catch {
        // Retry a bounded number of times before preserving the tag.
      }
    }
    return false
  }

  async function removeOwnedReference(transaction) {
    try {
      const release = await readReleaseByTag(transaction.repository, transaction.tag)
      if (release) return true
    } catch {
      return false
    }

    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      let reference
      try {
        reference = await readReference(transaction.repository, transaction.tag)
      } catch {
        continue
      }
      if (!reference) return true
      if (reference.type !== 'tag' || reference.oid !== transaction.tagObjectOid) return true
      try {
        await executor.action([
          'api',
          `repos/${transaction.repository}/git/refs/tags/${encodeURIComponent(transaction.tag)}`,
          '--method',
          'DELETE',
        ])
      } catch {
        // Reconcile the exact owned object before retrying.
      }
    }
    try {
      const reference = await readReference(transaction.repository, transaction.tag)
      return !reference || reference.type !== 'tag' || reference.oid !== transaction.tagObjectOid
    } catch {
      return false
    }
  }

  async function rollbackRelease(transaction) {
    if (!(await removeOwnedRelease(transaction))) return false
    return removeOwnedReference(transaction)
  }

  async function create(value) {
    const input = validateCreateReleaseInput(value)
    const key = input.repository.toLowerCase()
    if (activeReleases.has(key)) {
      throw new ActionError(409, 'release_running', 'A release is already being created for this repository.')
    }
    activeReleases.add(key)
    try {
      await authorizeRepository(input.repository)
      let tags
      try {
        tags = await listTags(executor, input.repository)
      } catch (error) {
        throw executorError(error, 'tags_unavailable', 'Repository tags could not be checked.', 503)
      }
      const current = nextPatchTag(tags)
      if (current.latestTag !== input.expectedLatestTag) {
        throw new ActionError(409, 'release_base_changed', 'The latest repository tag changed. Reload release options.')
      }
      if (tags.includes(input.tag)) {
        throw new ActionError(409, 'tag_exists', 'That release tag already exists.')
      }

      const commitOid = await defaultCommit(input.repository)
      const transaction = {
        commitOid,
        marker: markerFor(identifier()),
        releaseId: null,
        repository: input.repository,
        tag: input.tag,
        tagger: {
          name: TAGGER_NAME,
          email: TAGGER_EMAIL,
          date: new Date(Math.floor(now() / 1_000) * 1_000).toISOString(),
        },
      }
      transaction.tagMessage = `${transaction.marker}\n`
      transaction.tagObjectOid = tagObjectOid(transaction)
      try {
        await createTagObject(transaction)
        await createReference(transaction)
        const afterTag = await listTags(executor, input.repository)
        const base = nextPatchTag(afterTag.filter((tag) => tag !== input.tag))
        if (base.latestTag !== input.expectedLatestTag || !(await confirmOwnedTag(transaction))) {
          throw new ActionError(409, 'release_target_changed', 'The release base or owned tag changed before draft creation.')
        }
        const draft = await createDraft(transaction)
        transaction.releaseId = draft.id
        if (!(await confirmOwnedTag(transaction))) {
          throw new ActionError(409, 'release_target_changed', 'The owned release tag changed before publication.')
        }
        const normalized = await publishDraft(transaction)
        if (!(await confirmOwnedTag(transaction))) {
          throw new ActionError(409, 'release_target_changed', 'The owned release tag changed during publication.')
        }

        invalidate()
        await Promise.allSettled([
          Promise.resolve().then(() => invalidateReadiness()),
          Promise.resolve().then(() => refetch({ repository: input.repository, tag: input.tag })),
        ])
        return {
          id: normalized.id,
          name: normalized.name,
          publishedAt: normalized.publishedAt,
          repository: input.repository,
          tag: input.tag,
          url: normalized.url,
        }
      } catch (error) {
        if (transaction.tagObjectOid && !(await rollbackRelease(transaction))) {
          throw new ActionError(
            503,
            'release_cleanup_unconfirmed',
            'The failed release transaction could not be reconciled safely. Inspect the owned draft and tag before retrying.',
          )
        }
        if (error instanceof ActionError) throw error
        throw executorError(error, 'release_failed', 'GitHub could not create the release.')
      }
    } finally {
      activeReleases.delete(key)
    }
  }

  async function exactRelease(value) {
    let raw
    try {
      raw = await executor.rest(
        `repos/${value.repository}/releases/${value.releaseId}`,
        { validate: isRecord },
      )
    } catch (error) {
      throw executorError(
        error,
        'verification_evidence_unavailable',
        'Release verification evidence could not be refreshed.',
        503,
      )
    }
    const release = normalizeRelease(raw, value.repository)
    if (
      !release ||
      release.draft ||
      release.id !== value.releaseId ||
      release.tag !== value.tag
    ) return null
    return release
  }

  async function predecessorFor(release) {
    const markers = new Set()
    const published = new Map()
    for (let page = 1; page <= MAXIMUM_RELEASE_PAGES; page += 1) {
      let values
      try {
        values = await executor.rest(withPage(`repos/${release.repository}/releases`, page), {
          validate: Array.isArray,
        })
      } catch (error) {
        throw executorError(
          error,
          'verification_evidence_unavailable',
          'Release verification evidence could not be refreshed.',
          503,
        )
      }
      const marker = values.length === 0
        ? 'empty'
        : `${values.length}:${JSON.stringify(values[0])}:${JSON.stringify(values.at(-1))}`
      if (values.length > 0 && markers.has(marker)) {
        throw new ActionError(502, 'github_pagination', 'GitHub repeated a release page.')
      }
      markers.add(marker)
      for (const value of values) {
        if (isRecord(value) && value.draft === true) continue
        const candidate = normalizeRelease(value, release.repository)
        if (!candidate || candidate.draft) {
          throw new ActionError(
            502,
            'verification_evidence_incomplete',
            'GitHub returned incomplete published release evidence.',
          )
        }
        const existing = published.get(candidate.id)
        if (existing && (
          existing.tag !== candidate.tag ||
          existing.publishedAt !== candidate.publishedAt ||
          existing.url !== candidate.url
        )) {
          throw new ActionError(
            502,
            'verification_evidence_changed',
            'A published release changed while its adjacency was loaded.',
          )
        }
        published.set(candidate.id, candidate)
      }
      if (values.length < PAGE_SIZE) break
      if (page === MAXIMUM_RELEASE_PAGES) {
        throw new ActionError(
          502,
          'verification_evidence_incomplete',
          'GitHub release pagination exceeded the verification bound.',
        )
      }
    }

    const ordered = [...published.values()].sort(compareReleases)
    const index = ordered.findIndex((candidate) => candidate.id === release.id)
    if (index < 0) return undefined
    const listed = ordered[index]
    if (!sameRelease(listed, release)) return undefined
    return ordered[index + 1] ?? null
  }

  async function tagCommit(repository, tag) {
    const fail = () => new ActionError(
      409,
      'release_changed',
      'The release tag no longer resolves to the authorized commit.',
    )
    let reference
    try {
      reference = await executor.rest(
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
        { validate: isRecord },
      )
    } catch (error) {
      if (error instanceof ExecutorError && error.status === 404) throw fail()
      throw executorError(
        error,
        'verification_evidence_unavailable',
        'The release tag could not be refreshed.',
        503,
      )
    }
    if (reference.ref !== `refs/tags/${tag}` || !isRecord(reference.object)) throw fail()

    let target = reference.object
    const visited = new Set()
    while (target.type === 'tag') {
      if (typeof target.sha !== 'string' || !SHA.test(target.sha) || visited.has(target.sha)) throw fail()
      visited.add(target.sha)
      if (visited.size > 32) throw fail()
      let annotated
      try {
        annotated = await executor.rest(`repos/${repository}/git/tags/${target.sha}`, {
          validate: isRecord,
        })
      } catch (error) {
        throw executorError(
          error,
          'verification_evidence_unavailable',
          'The release tag could not be peeled.',
          503,
        )
      }
      if (!isRecord(annotated.object)) throw fail()
      target = annotated.object
    }
    if (target.type !== 'commit' || typeof target.sha !== 'string' || !SHA.test(target.sha)) {
      throw fail()
    }
    return target.sha.toLowerCase()
  }

  async function resolveVerification(value) {
    const release = await exactRelease(value)
    if (!release) return null
    const predecessor = await predecessorFor(release)
    if (predecessor === undefined) return null

    let viewerLogin
    try {
      viewerLogin = await viewer()
      const before = await tagCommit(value.repository, value.tag)
      const baseBefore = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null

      const rawPull = await executor.rest(
        `repos/${value.repository}/pulls/${value.pullNumber}`,
        { validate: isRecord },
      )
      const pull = normalizeAssociatedPull(rawPull, value.repository, viewerLogin)
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
      ) return null

      const context = await loadVerificationContext(executor, value.repository, value.pullNumber)
      const confirmedRawPull = await executor.rest(
        `repos/${value.repository}/pulls/${value.pullNumber}`,
        { validate: isRecord },
      )
      const confirmedPull = normalizeAssociatedPull(confirmedRawPull, value.repository, viewerLogin)
      if (
        !confirmedPull ||
        confirmedPull.url !== pull.url ||
        confirmedPull.headSha !== pull.headSha ||
        confirmedPull.mergeCommitSha !== pull.mergeCommitSha ||
        confirmedPull.mergedAt !== pull.mergedAt ||
        confirmedPull.title !== pull.title
      ) return null

      const currentRelease = await exactRelease(value)
      if (!sameRelease(currentRelease, release)) return null
      const after = await tagCommit(value.repository, value.tag)
      const baseAfter = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null
      if (after !== before || baseAfter !== baseBefore) return null
      const currentPredecessor = await predecessorFor(currentRelease)
      if (
        currentPredecessor === undefined ||
        (predecessor === null
          ? currentPredecessor !== null
          : !sameRelease(currentPredecessor, predecessor))
      ) return null
      const { body: _body, draft: _draft, ...authorized } = currentRelease

      const releasedPull = publicPull(confirmedPull)
      return {
        context,
        pull: releasedPull,
        release: {
          ...authorized,
          commitOid: after,
          complete: true,
          pulls: [releasedPull],
          source: 'comparison',
          warning: null,
        },
      }
    } catch (error) {
      if (error instanceof ActionError) throw error
      throw executorError(
        error,
        'verification_evidence_unavailable',
        'Release verification evidence could not be refreshed.',
        503,
      )
    }
  }

  async function resolveReleaseVerifications(value) {
    const release = await exactRelease(value)
    if (!release) return null
    const predecessor = await predecessorFor(release)
    if (predecessor === undefined) return null

    try {
      const viewerLogin = await viewer()
      const before = await tagCommit(value.repository, value.tag)
      const baseBefore = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null
      const numbers = pullNumbersFromNotes(release.body, value.repository)
      const pulls = (await mapLimit(numbers, READ_CONCURRENCY, async (number) => {
        const raw = await executor.rest(
          `repos/${value.repository}/pulls/${number}`,
          { validate: isRecord },
        )
        const pull = normalizeAssociatedPull(raw, value.repository, viewerLogin)
        if (pull === false) return null
        if (!pull) {
          throw new ActionError(
            409,
            'verification_membership_changed',
            'A released pull request identity could not be confirmed.',
          )
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
          )
        if (!included) return null

        const confirmedRaw = await executor.rest(
          `repos/${value.repository}/pulls/${number}`,
          { validate: isRecord },
        )
        const confirmed = normalizeAssociatedPull(confirmedRaw, value.repository, viewerLogin)
        if (
          !confirmed ||
          confirmed.url !== pull.url ||
          confirmed.headSha !== pull.headSha ||
          confirmed.mergeCommitSha !== pull.mergeCommitSha ||
          confirmed.mergedAt !== pull.mergedAt ||
          confirmed.title !== pull.title
        ) {
          throw new ActionError(
            409,
            'verification_membership_changed',
            'A released pull request changed while verification was queued.',
          )
        }
        return publicPull(confirmed)
      })).filter(Boolean)

      const currentRelease = await exactRelease(value)
      if (!sameRelease(currentRelease, release) || currentRelease.body !== release.body) return null
      const after = await tagCommit(value.repository, value.tag)
      const baseAfter = predecessor
        ? await tagCommit(value.repository, predecessor.tag)
        : null
      if (after !== before || baseAfter !== baseBefore) return null
      const currentPredecessor = await predecessorFor(currentRelease)
      if (
        currentPredecessor === undefined ||
        (predecessor === null
          ? currentPredecessor !== null
          : !sameRelease(currentPredecessor, predecessor))
      ) return null

      const { body: _body, draft: _draft, ...authorized } = currentRelease
      return {
        pulls,
        release: {
          ...authorized,
          commitOid: after,
          complete: true,
          pulls,
          source: 'comparison',
          warning: null,
        },
      }
    } catch (error) {
      if (error instanceof ActionError) throw error
      throw executorError(
        error,
        'verification_evidence_unavailable',
        'Release verification evidence could not be refreshed.',
        503,
      )
    }
  }

  return Object.freeze({
    activeReleaseCount: () => activeReleases.size,
    create,
    getOptions: options,
    getRecent: recent,
    invalidate,
    options,
    primeRepositories,
    recent,
    resolveReleaseVerifications,
    resolveVerification,
  })
}
