import { describe, expect, it, vi } from 'vitest'

import { createSnapshotCache } from '../cache.mjs'
import { GithubError } from '../github.mjs'

function snapshot(total = 1) {
  return {
    query: 'query',
    partial: false,
    warnings: [],
    counts: { total, ready: total, notReady: 0 },
    ready: [],
    notReady: [],
  }
}

describe('snapshot cache', () => {
  it('peeks at the last snapshot without loading or changing its freshness', async () => {
    let current = 1_000
    const load = vi.fn(async () => snapshot())
    const cache = createSnapshotCache({ load, now: () => current })

    expect(cache.peek()).toBeNull()
    await cache.get()
    expect(cache.peek()).toMatchObject({ expired: false, stale: false })
    current = 20_000

    expect(load).toHaveBeenCalledOnce()
    expect(cache.peek()).toMatchObject({ expired: true, stale: false })
  })

  it('serves fresh cached reads without repeating GitHub work', async () => {
    const load = vi.fn(async () => snapshot())
    const cache = createSnapshotCache({ load, now: () => 1_000 })

    const first = await cache.get()
    const second = await cache.get()

    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('bypasses freshness for a manual refresh', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(2))
    const cache = createSnapshotCache({ load, now: () => 1_000 })

    await cache.get()
    const refreshed = await cache.get({ refresh: true })

    expect(refreshed.counts.total).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight promise across concurrent refreshes', async () => {
    let finish
    const load = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const cache = createSnapshotCache({ load })

    const first = cache.get()
    const second = cache.get({ refresh: true })
    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)

    finish(snapshot())
    await expect(first).resolves.toMatchObject({ stale: false })
  })

  it('uses a ten-second TTL and never overlaps the refresh at expiry', async () => {
    let current = 0
    let finish
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    const cache = createSnapshotCache({ load, now: () => current })

    await cache.get()
    current = 9_999
    await cache.get()
    expect(load).toHaveBeenCalledTimes(1)

    current = 10_000
    const expired = cache.get()
    const joined = cache.get()
    expect(expired).toBe(joined)
    expect(load).toHaveBeenCalledTimes(2)
    finish(snapshot(2))
    await expired
  })

  it('offers an explicit fresh path that never returns stale last-good data', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockRejectedValueOnce(new GithubError('Fresh evidence failed.'))
    const cache = createSnapshotCache({ load })

    await cache.get()
    await expect(cache.loadFresh()).rejects.toThrow('Fresh evidence failed')
    expect(cache.peek()).toMatchObject({
      stale: true,
      warnings: ['Showing the last successful snapshot. Fresh evidence failed.'],
    })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('coalesces ordinary and strict refreshes while preserving strict failure semantics', async () => {
    let rejectRefresh
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRefresh = reject
          }),
      )
    const cache = createSnapshotCache({ load })
    await cache.get()

    const ordinary = cache.get({ refresh: true })
    const strict = cache.getFresh()
    expect(load).toHaveBeenCalledTimes(2)

    rejectRefresh(new GithubError('Fresh evidence failed.'))
    await expect(ordinary).resolves.toMatchObject({ stale: true })
    await expect(strict).rejects.toThrow('Fresh evidence failed')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the original last-good timestamp and marks a failed refresh stale', async () => {
    let current = Date.parse('2026-07-17T00:00:00Z')
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new GithubError('GitHub is temporarily unavailable.'))
    const cache = createSnapshotCache({ load, now: () => current })

    const good = await cache.get()
    current += 1_000
    const stale = await cache.get({ refresh: true })

    expect(stale.generatedAt).toBe(good.generatedAt)
    expect(stale.stale).toBe(true)
    expect(stale.warnings).toEqual([
      'Showing the last successful snapshot. GitHub is temporarily unavailable.',
    ])

    const cached = await cache.get()
    expect(cached).toBe(stale)
    expect(cached.stale).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('replaces a stale refresh warning instead of accumulating duplicates', async () => {
    let current = Date.parse('2026-07-17T00:00:00Z')
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new GithubError('First failure.'))
      .mockRejectedValueOnce(new GithubError('Second failure.'))
    const cache = createSnapshotCache({ load, now: () => current })

    await cache.get()
    current += 1_000
    await cache.get({ refresh: true })
    current += 1_000
    const stale = await cache.get({ refresh: true })

    expect(stale.warnings).toEqual([
      'Showing the last successful snapshot. Second failure.',
    ])
  })

  it('returns actionable initial errors without leaking unknown details', async () => {
    const cache = createSnapshotCache({
      load: async () => {
        throw new Error('stderr contained ghp_super_secret')
      },
    })

    await expect(cache.get()).rejects.toThrow('gh auth status')
    await expect(cache.get()).rejects.not.toThrow('ghp_super_secret')
  })
})
