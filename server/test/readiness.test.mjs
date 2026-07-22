import { describe, expect, it } from 'vitest'

import { assessPull, createReadinessSnapshot } from '../readiness.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const BASE_SHA = '1234567890abcdef1234567890abcdef12345678'

function ci(state = 'success', overrides = {}) {
  const total = state === 'none' ? 0 : 1
  return {
    checks: total === 0 ? [] : [{ detailsUrl: null, id: 'check-1', name: 'CI', state, workflow: 'CI' }],
    complete: state !== 'unknown',
    failed: state === 'failure' ? 1 : 0,
    passed: state === 'success' ? 1 : 0,
    running: state === 'pending' ? 1 : 0,
    state,
    total,
    unknown: state === 'unknown' ? 1 : 0,
    ...overrides,
  }
}

function pull(overrides = {}) {
  const body = `Confidence Score: 5/5\nLast reviewed commit: ${SHA.toUpperCase()}`
  return {
    baseRefOid: BASE_SHA,
    comments: [{
      author: 'greptile-apps', body, createdAt: '2026-07-17T00:00:00Z',
      id: 'comment-1',
      updatedAt: '2026-07-17T00:00:00Z',
      url: 'https://github.com/example/repo/pull/1#issuecomment-1',
    }],
    commentsComplete: true,
    ci: ci(),
    headRefOid: SHA,
    number: 1,
    repository: 'example/repo',
    repositoryUrl: 'https://github.com/example/repo',
    reviewThreads: [],
    threadsComplete: true,
    title: 'Ready pull',
    unresolvedThreads: [],
    updatedAt: '2026-07-17T00:00:00Z',
    url: 'https://github.com/example/repo/pull/1',
    ...overrides,
  }
}

describe('pull readiness', () => {
  it('returns full current Greptile, CI, and unresolved detail for a ready pull', () => {
    expect(assessPull(pull(), 1)).toMatchObject({
      baseRefOid: BASE_SHA,
      blockers: [],
      ci: { complete: true, passed: 1, state: 'success', total: 1 },
      greptile: {
        body: expect.stringContaining('Confidence Score: 5/5'),
        commentId: 'comment-1',
        confidence: 5,
        current: true,
        reviewedSha: SHA,
        updatedAt: '2026-07-17T00:00:00Z',
      },
      issueComments: [expect.objectContaining({ id: 'comment-1' })],
      rank: 1,
      ready: true,
      unresolved: 0,
      unresolvedThreads: [],
    })
  })

  it.each([
    ['success', true, []],
    ['none', true, []],
    ['pending', false, ['CI checks pending']],
    ['failure', false, ['CI checks failed']],
    ['unknown', false, ['CI checks could not be fully checked']],
  ])('maps complete CI state %s', (state, ready, blockers) => {
    expect(assessPull(pull({ ci: ci(state) }), 1)).toMatchObject({ blockers, ready })
  })

  it.each([
    ['missing', undefined],
    ['incomplete', ci('success', { complete: false })],
    ['broken invariant', ci('success', { total: 2 })],
    ['future state', ci('future')],
  ])('fails closed for %s CI evidence', (_label, evidence) => {
    expect(assessPull(pull({ ci: evidence }), 1)).toMatchObject({
      blockers: ['CI checks could not be fully checked'],
      ready: false,
      ci: { complete: false, state: 'unknown' },
    })
  })

  it('exposes failed checks, unresolved comment detail, and the Greptile confidence body', () => {
    const unresolved = {
      author: 'reviewer', body: 'Cover this edge case.', createdAt: '2026-07-17T00:00:00Z',
      comments: [{
        author: 'reviewer', body: 'Cover this edge case.', createdAt: '2026-07-17T00:00:00Z',
        id: 'review-comment-1', line: 42, outdated: false, path: 'src/index.ts',
        updatedAt: '2026-07-17T00:00:00Z',
        url: 'https://github.com/example/repo/pull/1#discussion_r1',
      }],
      id: 'thread-1', line: 42, outdated: false, path: 'src/index.ts',
      url: 'https://github.com/example/repo/pull/1#discussion_r1',
    }
    const body = `Confidence Score: 4/5\nLast reviewed commit: ${SHA}`
    const result = assessPull(pull({
      ci: ci('failure'),
      comments: [{
        author: 'greptile-apps', body, createdAt: '2026-07-17T00:00:00Z',
        id: 'comment-2',
        updatedAt: '2026-07-17T00:00:00Z', url: 'https://github.com/example/repo/pull/1#issuecomment-2',
      }],
      reviewThreads: [{ isResolved: false }],
      unresolvedThreads: [unresolved],
    }), 2)

    expect(result.blockers).toEqual([
      '1 unresolved review thread',
      'Greptile confidence 4/5',
      'CI checks failed',
    ])
    expect(result.greptile).toMatchObject({
      body,
      commentId: 'comment-2',
      confidence: 4,
      current: true,
      updatedAt: '2026-07-17T00:00:00Z',
    })
    expect(result.issueComments).toEqual([expect.objectContaining({ id: 'comment-2' })])
    expect(result.unresolvedThreads).toEqual([unresolved])
  })

  it('blocks stale Greptile SHA and every incomplete connection', () => {
    const other = '1234567890abcdef1234567890abcdef12345678'
    const result = assessPull(pull({
      comments: [{
        author: 'greptile-apps',
        body: `Confidence Score: 5/5\nLast reviewed commit: ${other}`,
        createdAt: '2026-07-17T00:00:00Z', updatedAt: '2026-07-17T00:00:00Z',
        id: 'comment-3',
        url: 'https://github.com/example/repo/pull/1#issuecomment-3',
      }],
      commentsComplete: false,
      threadsComplete: false,
    }), 1)

    expect(result.ready).toBe(false)
    expect(result.greptile.current).toBe(false)
    expect(result.blockers).toEqual([
      'Greptile reviewed 1234567; head is abcdef0',
      'Review threads could not be fully checked',
      'Greptile comments could not be fully checked',
    ])
  })

  it('preserves encounter ranks and stable ready/not-ready counts', () => {
    const result = createReadinessSnapshot({
      partial: false,
      pulls: [
        pull({ number: 1 }),
        pull({ number: 2, ci: ci('pending') }),
        pull({ number: 3 }),
      ],
      viewerLogin: 'viewer',
      warnings: [],
    })
    expect(result.ready.map(({ number, rank }) => [number, rank])).toEqual([[1, 1], [3, 3]])
    expect(result.notReady.map(({ number, rank }) => [number, rank])).toEqual([[2, 2]])
    expect(result.counts).toEqual({ total: 3, ready: 2, notReady: 1 })
    expect(result.viewerLogin).toBe('viewer')
  })
})
