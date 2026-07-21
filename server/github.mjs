import { execFile } from 'node:child_process'

export const SEARCH_QUERY = 'is:pr author:@me state:open archived:false sort:updated-desc'
export const SEARCH_LIMIT = 1_000

export const OUTER_QUERY = `
  query AuthoredPulls($searchQuery: String!, $after: String) {
    search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        ... on PullRequest {
          number
          title
          url
          updatedAt
          headRefOid
          statusCheckRollup {
            state
            commit {
              oid
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
              isResolved
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
          comments(first: 100) {
            nodes {
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
  }
`

export const THREADS_QUERY = `
  query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            isResolved
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`

export const COMMENTS_QUERY = `
  query PullRequestComments($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: 100, after: $after) {
          nodes {
            author {
              login
            }
            body
            createdAt
            updatedAt
            url
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`

const DOCUMENTS = new Set([OUTER_QUERY, THREADS_QUERY, COMMENTS_QUERY])

export class GithubError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'GithubError'
  }
}

export function createGhGraphql({ executeFile = execFile, timeout = 30_000 } = {}) {
  return async function graphql(document, variables = {}) {
    if (!DOCUMENTS.has(document)) {
      throw new GithubError('The server rejected an unknown GitHub query.')
    }

    const args = ['api', 'graphql', '-f', `query=${document}`]
    for (const [name, value] of Object.entries(variables)) {
      if (value === null || value === undefined) {
        continue
      }

      const flag = typeof value === 'number' ? '-F' : '-f'
      args.push(flag, `${name}=${value}`)
    }

    const stdout = await new Promise((resolve, reject) => {
      executeFile(
        'gh',
        args,
        {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          timeout,
        },
        (error, output) => {
          if (!error) {
            resolve(output)
            return
          }

          if (error.code === 'ENOENT') {
            reject(
              new GithubError(
                'GitHub CLI is not installed. Install gh, then run gh auth login.',
              ),
            )
            return
          }

          if (error.killed || error.code === 'ETIMEDOUT') {
            reject(
              new GithubError(
                'The GitHub request timed out. Check your connection and try again.',
              ),
            )
            return
          }

          reject(
            new GithubError(
              'GitHub CLI could not load pull requests. Run gh auth status, then gh auth login if needed.',
            ),
          )
        },
      )
    })

    let payload
    try {
      payload = JSON.parse(stdout)
    } catch {
      throw new GithubError(
        'GitHub CLI returned an unreadable response. Run gh auth status and try again.',
      )
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new GithubError('GitHub CLI returned an unexpected response.')
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new GithubError(
        'GitHub could not complete the pull request query. Run gh auth status and try again.',
      )
    }

    if (!payload.data || typeof payload.data !== 'object') {
      throw new GithubError('GitHub CLI returned an incomplete response.')
    }

    return payload.data
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCursor(value) {
  return typeof value === 'string' && value.length > 0
}

function normalizeComment(comment) {
  if (
    !isRecord(comment) ||
    (comment.author !== null &&
      (!isRecord(comment.author) || typeof comment.author.login !== 'string')) ||
    typeof comment.body !== 'string' ||
    typeof comment.createdAt !== 'string' ||
    typeof comment.updatedAt !== 'string' ||
    typeof comment.url !== 'string'
  ) {
    return null
  }

  return {
    author: comment.author?.login ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: comment.url,
  }
}

function normalizeConnection(connection, normalizeNode) {
  const nodesValid = isRecord(connection) && Array.isArray(connection.nodes)
  const normalized = nodesValid
    ? connection.nodes.map(normalizeNode).filter((node) => node !== null)
    : []
  const pageInfoValid =
    isRecord(connection?.pageInfo) &&
    typeof connection.pageInfo.hasNextPage === 'boolean' &&
    (!connection.pageInfo.hasNextPage || isCursor(connection.pageInfo.endCursor))
  const hasNext = pageInfoValid && connection.pageInfo.hasNextPage

  return {
    nodes: normalized,
    reliable: nodesValid && normalized.length === connection.nodes.length && pageInfoValid,
    hasNext,
    cursor: hasNext ? connection.pageInfo.endCursor : null,
  }
}

function normalizeThread(thread) {
  return isRecord(thread) && typeof thread.isResolved === 'boolean'
    ? { isResolved: thread.isResolved }
    : null
}

function normalizeCi(rollup, headRefOid) {
  if (rollup === null) {
    return { state: 'none' }
  }

  if (
    !isRecord(rollup) ||
    !isRecord(rollup.commit) ||
    typeof rollup.commit.oid !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(rollup.commit.oid) ||
    rollup.commit.oid.toLowerCase() !== headRefOid.toLowerCase()
  ) {
    return { state: 'unknown' }
  }

  switch (rollup.state) {
    case 'SUCCESS':
      return { state: 'success' }
    case 'PENDING':
    case 'EXPECTED':
      return { state: 'pending' }
    case 'FAILURE':
    case 'ERROR':
      return { state: 'failure' }
    default:
      return { state: 'unknown' }
  }
}

function isPull(node) {
  return (
    isRecord(node) &&
    Number.isInteger(node.number) &&
    node.number > 0 &&
    typeof node.title === 'string' &&
    typeof node.url === 'string' &&
    typeof node.updatedAt === 'string' &&
    typeof node.headRefOid === 'string' &&
    /^[0-9a-f]{40}$/i.test(node.headRefOid) &&
    isRecord(node.repository) &&
    typeof node.repository.name === 'string' &&
    typeof node.repository.nameWithOwner === 'string' &&
    typeof node.repository.url === 'string' &&
    isRecord(node.repository.owner) &&
    typeof node.repository.owner.login === 'string'
  )
}

function normalizePull(node) {
  const threads = normalizeConnection(node.reviewThreads, normalizeThread)
  const comments = normalizeConnection(node.comments, normalizeComment)

  return {
    repository: node.repository.nameWithOwner,
    repositoryUrl: node.repository.url,
    owner: node.repository.owner.login,
    name: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    updatedAt: node.updatedAt,
    headRefOid: node.headRefOid,
    ci: normalizeCi(node.statusCheckRollup, node.headRefOid),
    reviewThreads: threads.nodes,
    comments: comments.nodes,
    threadsComplete: threads.reliable && !threads.hasNext,
    commentsComplete: comments.reliable && !comments.hasNext,
    threadsReliable: threads.reliable,
    commentsReliable: comments.reliable,
    threadsHaveNext: threads.hasNext,
    commentsHaveNext: comments.hasNext,
    threadCursor: threads.cursor,
    commentCursor: comments.cursor,
  }
}

async function continueThreads(graphql, pull) {
  let cursor = pull.threadCursor
  const seen = new Set([cursor])
  while (pull.threadsHaveNext) {
    const data = await graphql(THREADS_QUERY, {
      owner: pull.owner,
      name: pull.name,
      number: pull.number,
      after: cursor,
    })
    const connection = normalizeConnection(
      data.repository?.pullRequest?.reviewThreads,
      normalizeThread,
    )
    if (!connection.reliable) {
      throw new GithubError('GitHub returned incomplete review-thread evidence.')
    }

    pull.reviewThreads.push(...connection.nodes)
    pull.threadsHaveNext = connection.hasNext
    if (connection.hasNext) {
      if (seen.has(connection.cursor)) {
        throw new GithubError('GitHub repeated a review-thread cursor.')
      }
      seen.add(connection.cursor)
      cursor = connection.cursor
    }
  }

  pull.threadsComplete = pull.threadsReliable
}

async function continueComments(graphql, pull) {
  let cursor = pull.commentCursor
  const seen = new Set([cursor])
  while (pull.commentsHaveNext) {
    const data = await graphql(COMMENTS_QUERY, {
      owner: pull.owner,
      name: pull.name,
      number: pull.number,
      after: cursor,
    })
    const connection = normalizeConnection(
      data.repository?.pullRequest?.comments,
      normalizeComment,
    )
    if (!connection.reliable) {
      throw new GithubError('GitHub returned incomplete Greptile comment evidence.')
    }

    pull.comments.push(...connection.nodes)
    pull.commentsHaveNext = connection.hasNext
    if (connection.hasNext) {
      if (seen.has(connection.cursor)) {
        throw new GithubError('GitHub repeated a comment cursor.')
      }
      seen.add(connection.cursor)
      cursor = connection.cursor
    }
  }

  pull.commentsComplete = pull.commentsReliable
}

async function completeNestedConnections(graphql, pull) {
  if (pull.threadsHaveNext) {
    try {
      await continueThreads(graphql, pull)
    } catch {
      pull.threadsComplete = false
    }
  }

  if (pull.commentsHaveNext) {
    try {
      await continueComments(graphql, pull)
    } catch {
      pull.commentsComplete = false
    }
  }
}

function stripInternalFields(pull) {
  const {
    commentCursor,
    commentsHaveNext,
    commentsReliable,
    name,
    owner,
    threadCursor,
    threadsHaveNext,
    threadsReliable,
    ...normalized
  } = pull
  return normalized
}

export async function fetchAuthoredPulls({ graphql, maximum = SEARCH_LIMIT }) {
  const pulls = []
  const warnings = []
  const cursors = new Set()
  let after = null
  let consumed = 0
  let issueCount = null
  let hasNextPage = true
  let partial = false

  const warn = (message) => {
    partial = true
    if (!warnings.includes(message)) {
      warnings.push(message)
    }
  }

  while (hasNextPage && consumed < maximum) {
    const data = await graphql(OUTER_QUERY, {
      searchQuery: SEARCH_QUERY,
      after,
    })
    const search = data.search
    const validSearch =
      isRecord(search) &&
      Number.isInteger(search.issueCount) &&
      search.issueCount >= 0 &&
      Array.isArray(search.nodes) &&
      isRecord(search.pageInfo) &&
      typeof search.pageInfo.hasNextPage === 'boolean' &&
      (!search.pageInfo.hasNextPage || isCursor(search.pageInfo.endCursor))

    if (!validSearch) {
      if (consumed === 0) {
        throw new GithubError('GitHub returned an incomplete pull request search.')
      }
      warn('GitHub returned malformed search pagination metadata; the snapshot is incomplete.')
      break
    }

    if (issueCount === null) {
      issueCount = search.issueCount
    } else if (search.issueCount !== issueCount) {
      warn('GitHub changed the reported search count during pagination; the snapshot may be incomplete.')
      issueCount = Math.max(issueCount, search.issueCount)
    }

    const remaining = maximum - consumed
    const nodes = search.nodes.slice(0, remaining)
    consumed += nodes.length

    for (const node of nodes) {
      if (!isPull(node)) {
        warn('GitHub returned malformed search result nodes; some pull requests were skipped.')
        continue
      }
      const pull = normalizePull(node)
      await completeNestedConnections(graphql, pull)
      pulls.push(stripInternalFields(pull))
    }

    if (consumed > issueCount) {
      warn('GitHub returned more search result nodes than it reported; the snapshot may be inconsistent.')
    }

    hasNextPage = search.pageInfo.hasNextPage
    if (hasNextPage && search.nodes.length === 0) {
      warn('GitHub returned an empty search page before pagination completed.')
      break
    }

    if (hasNextPage) {
      const cursor = search.pageInfo.endCursor
      if (cursors.has(cursor)) {
        warn('GitHub repeated a search cursor; pagination stopped to avoid a loop.')
        break
      }
      cursors.add(cursor)
      after = cursor
    }
  }

  if (issueCount !== null && issueCount !== consumed && !hasNextPage) {
    warn(
      `GitHub reported ${issueCount.toLocaleString('en-US')} results but returned ${consumed.toLocaleString('en-US')}; the snapshot may be incomplete.`,
    )
  }

  if ((issueCount ?? 0) > maximum || (hasNextPage && consumed >= maximum)) {
    warn(
      `GitHub search is limited to the first ${maximum.toLocaleString('en-US')} results.`,
    )
  }

  return {
    pulls,
    partial,
    warnings,
  }
}
