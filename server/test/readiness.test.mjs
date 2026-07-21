import { describe, expect, it } from 'vitest'

import { assessPull, createReadinessSnapshot } from '../readiness.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function pull(overrides = {}) {
  return {
    repository: 'example/repo',
    repositoryUrl: 'https://github.com/example/repo',
    number: 1,
    title: 'Ready pull',
    url: 'https://github.com/example/repo/pull/1',
    updatedAt: '2026-07-17T00:00:00Z',
    headRefOid: SHA,
    reviewThreads: [],
    comments: [
      {
        author: 'greptile-apps',
        body: `Confidence Score: 5/5\nLast reviewed commit: ${SHA.toUpperCase()}`,
        updatedAt: '2026-07-17T00:00:00Z',
        url: 'https://github.com/example/repo/pull/1#issuecomment-1',
      },
    ],
    ci: { state: 'success' },
    threadsComplete: true,
    commentsComplete: true,
    ...overrides,
  }
}

describe('pull readiness', () => {
  it('marks current 5/5 evidence with no unresolved threads ready', () => {
    expect(assessPull(pull(), 1)).toMatchObject({
      rank: 1,
      ready: true,
      unresolved: 0,
      blockers: [],
      ci: { state: 'success' },
    })
  })

  it.each([
    ['success', true, []],
    ['none', true, []],
    ['pending', false, ['CI checks pending']],
    ['failure', false, ['CI checks failed']],
    ['unknown', false, ['CI checks could not be fully checked']],
  ])('maps CI state %s to readiness', (state, ready, blockers) => {
    expect(assessPull(pull({ ci: { state } }), 1)).toMatchObject({
      ready,
      blockers,
      ci: { state },
    })
  })

  it.each([
    ['missing CI', undefined],
    ['null CI', null],
    ['missing state', {}],
    ['malformed state', { state: 'future' }],
  ])('fails closed for %s', (_description, ci) => {
    expect(assessPull(pull({ ci }), 1)).toMatchObject({
      ready: false,
      blockers: ['CI checks could not be fully checked'],
      ci: { state: 'unknown' },
    })
  })

  it('blocks score mismatch, SHA mismatch, and unresolved threads', () => {
    const other = '1234567890abcdef1234567890abcdef12345678'
    const result = assessPull(
      pull({
        reviewThreads: [{ isResolved: false }, { isResolved: true }],
        comments: [
          {
            author: 'greptile-apps',
            body: `Confidence Score: 4/5\nLast reviewed commit: ${other}`,
            updatedAt: '2026-07-17T00:00:00Z',
            url: 'https://github.com/example/repo/pull/1#issuecomment-2',
          },
        ],
      }),
      1,
    )

    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual([
      '1 unresolved review thread',
      'Greptile confidence 4/5',
      'Greptile reviewed 1234567; head is abcdef0',
    ])
  })

  it('accumulates a CI blocker after existing readiness blockers', () => {
    const result = assessPull(
      pull({
        ci: { state: 'failure' },
        comments: [],
        reviewThreads: [{ isResolved: false }],
        threadsComplete: false,
      }),
      1,
    )

    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual([
      '1 unresolved review thread',
      'Greptile summary missing',
      'Review threads could not be fully checked',
      'CI checks failed',
    ])
  })

  it('returns every incomplete-evidence blocker together', () => {
    const result = assessPull(
      pull({
        reviewThreads: [{ isResolved: false }, { isResolved: false }],
        comments: [
          {
            author: 'greptile-apps',
            body: 'Confidence Score: unknown/5\nLast reviewed commit: short',
            updatedAt: '2026-07-17T00:00:00Z',
            url: 'https://github.com/example/repo/pull/1#issuecomment-3',
          },
        ],
        threadsComplete: false,
        commentsComplete: false,
      }),
      3,
    )

    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual([
      '2 unresolved review threads',
      'Greptile confidence missing or unreadable',
      'Last reviewed commit missing or unreadable',
      'Review threads could not be fully checked',
      'Greptile comments could not be fully checked',
    ])
  })

  it('reports a missing Greptile summary', () => {
    expect(assessPull(pull({ comments: [] }), 1).blockers).toEqual([
      'Greptile summary missing',
    ])
  })

  it('requires a review link before a pull is ready', () => {
    const result = assessPull(pull({
      comments: [{
        author: 'greptile-apps',
        body: `Confidence Score: 5/5\nLast reviewed commit: ${SHA}`,
        updatedAt: '2026-07-17T00:00:00Z',
      }],
    }), 1)

    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Greptile review link missing')
  })

  it('uses stable filters and preserves encounter ranks in both sections', () => {
    const result = createReadinessSnapshot({
      pulls: [
        pull({ number: 1, title: 'ready one' }),
        pull({ number: 2, title: 'not ready', ci: { state: 'pending' } }),
        pull({ number: 3, title: 'ready two' }),
      ],
      partial: false,
      warnings: [],
    })

    expect(result.ready.map(({ number, rank }) => [number, rank])).toEqual([
      [1, 1],
      [3, 3],
    ])
    expect(result.notReady.map(({ number, rank }) => [number, rank])).toEqual([[2, 2]])
    expect(result.counts).toEqual({ total: 3, ready: 2, notReady: 1 })
  })
})
