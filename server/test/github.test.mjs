import { describe, expect, it, vi } from 'vitest'

import {
  COMMENTS_QUERY,
  OUTER_QUERY,
  SEARCH_LIMIT,
  SEARCH_QUERY,
  THREADS_QUERY,
  createGhGraphql,
  fetchAuthoredPulls,
} from '../github.mjs'
import { createReadinessSnapshot } from '../readiness.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function pageInfo(hasNextPage = false, endCursor = null) {
  return { hasNextPage, endCursor }
}

function node(number, overrides = {}) {
  return {
    number,
    title: `Pull ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    updatedAt: `2026-07-17T00:00:0${number}Z`,
    headRefOid: SHA,
    statusCheckRollup: {
      state: 'SUCCESS',
      commit: { oid: SHA },
    },
    repository: {
      name: 'repo',
      nameWithOwner: 'example/repo',
      url: 'https://github.com/example/repo',
      owner: { login: 'example' },
    },
    reviewThreads: { nodes: [], pageInfo: pageInfo() },
    comments: { nodes: [], pageInfo: pageInfo() },
    ...overrides,
  }
}

function comment(author, body = 'body') {
  return {
    author: author === null ? null : { login: author },
    body,
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    url: 'https://github.com/example/repo/pull/1#issuecomment-1',
  }
}

function search(nodes, { count = nodes.length, next = false, cursor = null } = {}) {
  return {
    search: {
      issueCount: count,
      nodes,
      pageInfo: pageInfo(next, cursor),
    },
  }
}

describe('GitHub CI rollup', () => {
  it('queries the direct head rollup without commit or context connections', () => {
    expect(OUTER_QUERY).toMatch(
      /headRefOid\s+statusCheckRollup\s*\{\s*state\s+commit\s*\{\s*oid\s*\}/s,
    )
    expect(OUTER_QUERY).not.toMatch(/\bcommits\s*\(/)
    expect(OUTER_QUERY).not.toMatch(/\bcontexts\s*\(/)
  })

  it.each([
    ['SUCCESS', 'success'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
  ])('normalizes %s to %s', async (state, expected) => {
    const graphql = vi.fn(async () =>
      search([
        node(1, {
          statusCheckRollup: { state, commit: { oid: SHA } },
        }),
      ]),
    )

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls[0].ci).toEqual({ state: expected })
  })

  it('treats an explicit null rollup as no checks', async () => {
    const result = await fetchAuthoredPulls({
      graphql: async () => search([node(1, { statusCheckRollup: null })]),
    })

    expect(result.pulls[0].ci).toEqual({ state: 'none' })
  })

  it('matches the rollup commit to the head case-insensitively', async () => {
    const result = await fetchAuthoredPulls({
      graphql: async () =>
        search([
          node(1, {
            statusCheckRollup: {
              state: 'SUCCESS',
              commit: { oid: SHA.toUpperCase() },
            },
          }),
        ]),
    })

    expect(result.pulls[0].ci).toEqual({ state: 'success' })
  })

  it.each([
    ['missing rollup', undefined],
    ['malformed rollup', {}],
    ['missing commit', { state: 'SUCCESS' }],
    ['null commit', { state: 'SUCCESS', commit: null }],
    ['missing commit oid', { state: 'SUCCESS', commit: {} }],
    ['invalid commit oid', { state: 'SUCCESS', commit: { oid: 'short' } }],
    [
      'different commit',
      {
        state: 'SUCCESS',
        commit: { oid: '1234567890abcdef1234567890abcdef12345678' },
      },
    ],
    ['missing state', { commit: { oid: SHA } }],
    ['future state', { state: 'WAITING_FOR_MERGE', commit: { oid: SHA } }],
  ])('retains the pull and fails closed for %s', async (_label, statusCheckRollup) => {
    const result = await fetchAuthoredPulls({
      graphql: async () => search([node(1, { statusCheckRollup })]),
    })

    expect(result.pulls).toHaveLength(1)
    expect(result.pulls[0]).toMatchObject({
      number: 1,
      ci: { state: 'unknown' },
    })
  })
})

describe('GitHub pagination', () => {
  it('uses the exact search query and preserves encounter order across outer pages', async () => {
    const graphql = vi.fn(async (document, variables) => {
      expect(document).toBe(OUTER_QUERY)
      expect(variables.searchQuery).toBe(SEARCH_QUERY)
      return variables.after === null
        ? search([node(2), node(1)], { count: 3, next: true, cursor: 'outer-2' })
        : search([node(3)], { count: 3 })
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls.map((pull) => pull.number)).toEqual([2, 1, 3])
    expect(graphql).toHaveBeenCalledTimes(2)
  })

  it('does not issue nested follow-ups for complete first pages', async () => {
    const graphql = vi.fn(async () => search([node(1)]))

    await fetchAuthoredPulls({ graphql })

    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('continues only the truncated nested connection', async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: {
              nodes: [{ isResolved: false }],
              pageInfo: pageInfo(true, 'thread-1'),
            },
          }),
        ])
      }

      expect(document).toBe(THREADS_QUERY)
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: true }],
              pageInfo: pageInfo(),
            },
          },
        },
      }
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(graphql.mock.calls.map(([document]) => document)).toEqual([
      OUTER_QUERY,
      THREADS_QUERY,
    ])
    expect(result.pulls[0].reviewThreads).toEqual([
      { isResolved: false },
      { isResolved: true },
    ])
  })

  it('accumulates multiple comment continuation pages', async () => {
    const graphql = vi.fn(async (document, variables) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            comments: {
              nodes: [comment('one', 'one')],
              pageInfo: pageInfo(true, 'comment-1'),
            },
          }),
        ])
      }

      expect(document).toBe(COMMENTS_QUERY)
      const last = variables.after === 'comment-2'
      return {
        repository: {
          pullRequest: {
            comments: {
              nodes: [comment(last ? 'three' : 'two', 'next')],
              pageInfo: pageInfo(!last, last ? null : 'comment-2'),
            },
          },
        },
      }
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls[0].comments.map((comment) => comment.author)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(graphql).toHaveBeenCalledTimes(3)
  })

  it('marks only the failed nested evidence incomplete', async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: { nodes: [], pageInfo: pageInfo(true, 'thread-1') },
          }),
        ])
      }
      throw new Error('secret from nested request')
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls[0]).toMatchObject({
      threadsComplete: false,
      commentsComplete: true,
    })
  })

  it('fails closed on malformed initial nested connections and exposes blockers', async () => {
    const graphql = vi.fn(async () =>
      search([
        node(1, {
          reviewThreads: { nodes: [{}], pageInfo: pageInfo() },
          comments: { nodes: [], pageInfo: { endCursor: null } },
        }),
      ]),
    )

    const result = await fetchAuthoredPulls({ graphql })
    const snapshot = createReadinessSnapshot(result)

    expect(result.pulls[0]).toMatchObject({
      threadsComplete: false,
      commentsComplete: false,
    })
    expect(snapshot.notReady[0].blockers).toEqual(
      expect.arrayContaining([
        'Review threads could not be fully checked',
        'Greptile comments could not be fully checked',
      ]),
    )
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('fails closed when both initial nested connections are absent', async () => {
    const graphql = vi.fn(async () =>
      search([node(1, { reviewThreads: undefined, comments: undefined })]),
    )

    const result = await fetchAuthoredPulls({ graphql })
    const snapshot = createReadinessSnapshot(result)

    expect(result.pulls[0]).toMatchObject({
      threadsComplete: false,
      commentsComplete: false,
    })
    expect(snapshot.notReady[0].blockers).toEqual(
      expect.arrayContaining([
        'Review threads could not be fully checked',
        'Greptile comments could not be fully checked',
      ]),
    )
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('fails closed on malformed nested continuation nodes and metadata', async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: { nodes: [], pageInfo: pageInfo(true, 'thread-1') },
            comments: { nodes: [], pageInfo: pageInfo(true, 'comment-1') },
          }),
        ])
      }
      if (document === THREADS_QUERY) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: null, pageInfo: pageInfo() },
            },
          },
        }
      }
      return {
        repository: {
          pullRequest: {
            comments: { nodes: [], pageInfo: { hasNextPage: 'false' } },
          },
        },
      }
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls[0]).toMatchObject({
      threadsComplete: false,
      commentsComplete: false,
    })
    expect(graphql).toHaveBeenCalledTimes(3)
  })

  it('fails closed when continuation pageInfo is absent', async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: { nodes: [], pageInfo: pageInfo(true, 'thread-1') },
            comments: { nodes: [], pageInfo: pageInfo(true, 'comment-1') },
          }),
        ])
      }
      const field = document === THREADS_QUERY ? 'reviewThreads' : 'comments'
      return {
        repository: {
          pullRequest: {
            [field]: { nodes: [] },
          },
        },
      }
    })

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls[0]).toMatchObject({
      threadsComplete: false,
      commentsComplete: false,
    })
    expect(graphql).toHaveBeenCalledTimes(3)
  })

  it('terminates repeated nested cursors and keeps both evidence sets incomplete', async () => {
    const graphql = vi.fn(async (document) => {
      if (document === OUTER_QUERY) {
        return search([
          node(1, {
            reviewThreads: { nodes: [], pageInfo: pageInfo(true, 'thread-loop') },
            comments: { nodes: [], pageInfo: pageInfo(true, 'comment-loop') },
          }),
        ])
      }
      if (document === THREADS_QUERY) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: true }],
                pageInfo: pageInfo(true, 'thread-loop'),
              },
            },
          },
        }
      }
      return {
        repository: {
          pullRequest: {
            comments: {
              nodes: [comment('greptile-apps')],
              pageInfo: pageInfo(true, 'comment-loop'),
            },
          },
        },
      }
    })

    const result = await fetchAuthoredPulls({ graphql })
    const snapshot = createReadinessSnapshot(result)

    expect(graphql).toHaveBeenCalledTimes(3)
    expect(snapshot.notReady[0].blockers).toEqual(
      expect.arrayContaining([
        'Review threads could not be fully checked',
        'Greptile comments could not be fully checked',
      ]),
    )
  })

  it('reports the GitHub 1,000-result ceiling as partial', async () => {
    expect(SEARCH_LIMIT).toBe(1_000)
    const graphql = vi.fn(async () => search([node(1)], { count: 1_001 }))

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.partial).toBe(true)
    expect(result.warnings).toContain(
      'GitHub search is limited to the first 1,000 results.',
    )
  })

  it('stops at the configured ceiling when another outer page remains', async () => {
    const graphql = vi.fn(async () =>
      search([node(1), node(2), node(3)], { count: 3, next: true, cursor: 'more' }),
    )

    const result = await fetchAuthoredPulls({ graphql, maximum: 2 })

    expect(result.pulls.map((pull) => pull.number)).toEqual([1, 2])
    expect(result.partial).toBe(true)
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('counts consumed search nodes rather than accepted pull requests at the cap', async () => {
    const graphql = vi.fn(async () =>
      search([{}, {}], { count: 3, next: true, cursor: 'more' }),
    )

    const result = await fetchAuthoredPulls({ graphql, maximum: 2 })

    expect(result.pulls).toEqual([])
    expect(result.partial).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'GitHub returned malformed search result nodes; some pull requests were skipped.',
        'GitHub search is limited to the first 2 results.',
      ]),
    )
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('fails the initial load when outer search metadata is malformed', async () => {
    const malformed = [
      { issueCount: 1, nodes: null, pageInfo: pageInfo() },
      { issueCount: '1', nodes: [], pageInfo: pageInfo() },
      { issueCount: 1, nodes: [], pageInfo: {} },
      { issueCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    ]

    for (const searchPage of malformed) {
      await expect(
        fetchAuthoredPulls({ graphql: async () => ({ search: searchPage }) }),
      ).rejects.toThrow('incomplete pull request search')
    }
  })

  it('returns a warned partial snapshot for malformed later search metadata', async () => {
    const graphql = vi.fn(async (_document, variables) =>
      variables.after === null
        ? search([node(1)], { count: 2, next: true, cursor: 'outer-1' })
        : { search: { issueCount: 2, nodes: null, pageInfo: pageInfo() } },
    )

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.pulls.map((pull) => pull.number)).toEqual([1])
    expect(result.partial).toBe(true)
    expect(result.warnings).toContain(
      'GitHub returned malformed search pagination metadata; the snapshot is incomplete.',
    )
  })

  it('warns on outer count inconsistencies and malformed result nodes', async () => {
    const graphql = vi.fn(async () => search([node(1), {}], { count: 1 }))

    const result = await fetchAuthoredPulls({ graphql })

    expect(result.partial).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'GitHub returned malformed search result nodes; some pull requests were skipped.',
        'GitHub returned more search result nodes than it reported; the snapshot may be inconsistent.',
      ]),
    )
  })

  it('terminates a repeated outer cursor with a partial warning', async () => {
    const graphql = vi.fn(async (_document, variables) =>
      variables.after === null
        ? search([node(1)], { count: 3, next: true, cursor: 'outer-loop' })
        : search([node(2)], { count: 3, next: true, cursor: 'outer-loop' }),
    )

    const result = await fetchAuthoredPulls({ graphql })

    expect(graphql).toHaveBeenCalledTimes(2)
    expect(result.pulls.map((pull) => pull.number)).toEqual([1, 2])
    expect(result.partial).toBe(true)
    expect(result.warnings).toContain(
      'GitHub repeated a search cursor; pagination stopped to avoid a loop.',
    )
  })

  it('terminates an empty outer page that claims another page exists', async () => {
    const graphql = vi.fn(async () =>
      search([], { count: 1, next: true, cursor: 'outer-empty' }),
    )

    const result = await fetchAuthoredPulls({ graphql })

    expect(graphql).toHaveBeenCalledTimes(1)
    expect(result.partial).toBe(true)
    expect(result.warnings).toContain(
      'GitHub returned an empty search page before pagination completed.',
    )
  })

  it('never queries PullRequestReview nodes', () => {
    for (const document of [OUTER_QUERY, THREADS_QUERY, COMMENTS_QUERY]) {
      expect(document).not.toContain('PullRequestReview')
      expect(document).not.toMatch(/\breviews\s*\(/)
    }
  })
})

describe('GitHub CLI adapter', () => {
  it('uses execFile without a shell and fixed GraphQL arguments', async () => {
    const executeFile = vi.fn((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ data: { search: {} } }))
    })
    const graphql = createGhGraphql({ executeFile })

    await graphql(OUTER_QUERY, { searchQuery: SEARCH_QUERY, after: null })

    const [file, args, options] = executeFile.mock.calls[0]
    expect(file).toBe('gh')
    expect(args.slice(0, 4)).toEqual(['api', 'graphql', '-f', `query=${OUTER_QUERY}`])
    expect(args).toContain(`searchQuery=${SEARCH_QUERY}`)
    expect(options).not.toHaveProperty('shell')
  })

  it('normalizes missing gh, authentication failure, and timeout', async () => {
    const cases = [
      [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'not installed'],
      [Object.assign(new Error('secret'), { code: 1 }), 'gh auth status'],
      [Object.assign(new Error('slow'), { killed: true }), 'timed out'],
    ]

    for (const [failure, expected] of cases) {
      const graphql = createGhGraphql({
        executeFile: (_file, _args, _options, callback) => callback(failure, ''),
      })
      await expect(graphql(OUTER_QUERY)).rejects.toThrow(expected)
      await expect(graphql(OUTER_QUERY)).rejects.not.toThrow('secret')
    }
  })

  it('normalizes malformed JSON and GraphQL errors', async () => {
    const malformed = createGhGraphql({
      executeFile: (_file, _args, _options, callback) => callback(null, 'not json'),
    })
    await expect(malformed(OUTER_QUERY)).rejects.toThrow('unreadable response')

    const graphError = createGhGraphql({
      executeFile: (_file, _args, _options, callback) =>
        callback(null, JSON.stringify({ errors: [{ message: 'token-secret' }] })),
    })
    await expect(graphError(OUTER_QUERY)).rejects.toThrow('could not complete')
    await expect(graphError(OUTER_QUERY)).rejects.not.toThrow('token-secret')
  })
})
