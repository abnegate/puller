import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { ActionError } from '../claude.mjs'
import { ExecutorError } from '../executor.mjs'
import {
  createReleaseService,
  loadVerificationContext,
  nextPatchTag,
  validateCreateReleaseInput,
  VERIFICATION_OMISSION_MARKER,
} from '../releases.mjs'

const NOW = Date.parse('2026-07-21T00:00:00Z')
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678'
const TAG_SHA = '9999999999999999999999999999999999999999'
const BASE_RELEASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function deferred() {
  let reject
  let resolve
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

function annotatedTagSha(fields) {
  const timestamp = Math.floor(Date.parse(fields.tagger.date) / 1_000)
  const content = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger.name} <${fields.tagger.email}> ${timestamp} +0000`,
    '',
    fields.message,
  ].join('\n')
  return createHash('sha1')
    .update(`tag ${Buffer.byteLength(content, 'utf8')}\0`)
    .update(content)
    .digest('hex')
}

function openSnapshot(repositories = ['owner/repo']) {
  return {
    partial: false,
    stale: false,
    viewerLogin: 'viewer',
    ready: repositories.map((repository) => ({
      repository,
      repositoryUrl: `https://github.com/${repository}`,
    })),
    notReady: [],
  }
}

function search(items = []) {
  return { incomplete_results: false, items, total_count: items.length }
}

function release({
  id = 10,
  tag = 'v1.2.4',
  published = '2026-07-20T00:00:00Z',
  body = '',
} = {}) {
  return {
    body,
    draft: false,
    html_url: `https://github.com/owner/repo/releases/tag/${tag}`,
    id,
    name: tag,
    published_at: published,
    tag_name: tag,
  }
}

function authoredPull(number = 7, overrides = {}) {
  return {
    head: { sha: SHA },
    html_url: `https://github.com/owner/repo/pull/${number}`,
    merge_commit_sha: SHA,
    merged_at: '2026-07-19T00:00:00Z',
    number,
    title: 'Released fix',
    user: { login: 'viewer' },
    ...overrides,
  }
}

function mergedItem(number = 7, repository = 'owner/repo') {
  return {
    html_url: `https://github.com/${repository}/pull/${number}`,
    number,
    repository_url: `https://api.github.com/repos/${repository}`,
    user: { login: 'viewer' },
  }
}

function mergedCandidateWithPull(number = 7, overrides = {}) {
  return {
    ...mergedItem(number),
    pull: {
      headSha: SHA,
      mergeCommitSha: SHA,
      mergedAt: '2026-07-19T00:00:00Z',
      number,
      repository: 'owner/repo',
      title: 'Released fix',
      url: `https://github.com/owner/repo/pull/${number}`,
      ...overrides,
    },
  }
}

function verificationInput(overrides = {}) {
  return {
    headSha: SHA,
    pullNumber: 7,
    pullUrl: 'https://github.com/owner/repo/pull/7',
    releaseId: '10',
    repository: 'owner/repo',
    tag: 'v1.2.4',
    ...overrides,
  }
}

function changedFile() {
  return {
    additions: 1,
    deletions: 1,
    filename: 'src/fix.js',
    patch: '@@ -1 +1 @@\n-old\n+new',
    status: 'modified',
  }
}

describe('release tag selection', () => {
  it('selects the highest numeric stable tag and preserves its v prefix', () => {
    expect(nextPatchTag(['v2.9.9', '10.0.0', 'v10.0.0-rc.1', 'latest'])).toEqual({
      latestTag: '10.0.0',
      nextTag: '10.0.1',
    })
    expect(nextPatchTag(['1.2.3', 'v1.2.3'])).toEqual({
      latestTag: 'v1.2.3',
      nextTag: 'v1.2.4',
    })
    expect(nextPatchTag([])).toEqual({ latestTag: null, nextTag: 'v0.1.0' })
  })

  it('rejects unsafe tags while allowing valid user-edited tags', () => {
    expect(() => validateCreateReleaseInput({
      repository: 'owner/repo', tag: '--help', expectedLatestTag: null,
    })).toThrow('tag is invalid')
    expect(validateCreateReleaseInput({
      repository: 'owner/repo', tag: 'release/summer-2026', expectedLatestTag: null,
    })).toEqual({
      repository: 'owner/repo', tag: 'release/summer-2026', expectedLatestTag: null,
    })
    expect(() => validateCreateReleaseInput({
      repository: '../repo', tag: 'v1.2.3', expectedLatestTag: null,
    })).toThrow('repository')
  })
})

describe('release catalog', () => {
  it('unions open and paginated merged repositories and computes repository tags', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) {
          return search([{ repository_url: 'https://api.github.com/repos/merged/repo' }])
        }
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.3' }]
        if (endpoint.startsWith('repos/merged/repo/tags?')) return [{ name: '3.4.5' }]
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })
    await expect(service.getOptions()).resolves.toEqual({
      generatedAt: '2026-07-21T00:00:00.000Z',
      repositoriesUpdatedAt: '2026-07-21T00:00:00.000Z',
      repositories: [
        {
          latestTag: '3.4.5', nextTag: '3.4.6', repository: 'merged/repo',
          previousTags: ['3.4.5'],
          repositoryUrl: 'https://github.com/merged/repo',
        },
        {
          latestTag: 'v1.2.3', nextTag: 'v1.2.4', repository: 'owner/repo',
          previousTags: ['v1.2.3'],
          repositoryUrl: 'https://github.com/owner/repo',
        },
      ],
      tagsUpdatedAt: '2026-07-21T00:00:00.000Z',
      viewerLogin: 'viewer',
      warnings: [],
    })
  })

  it('bypasses the release option cache only when refresh is explicit', async () => {
    let tags = ['v1.2.3']
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search([mergedItem()])
        if (endpoint.startsWith('repos/owner/repo/tags?')) return tags.map((name) => ({ name }))
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })
    expect((await service.getOptions()).repositories[0].nextTag).toBe('v1.2.4')
    tags = ['v1.2.4']
    expect((await service.getOptions()).repositories[0]).toMatchObject({
      nextTag: 'v1.2.4', previousTags: ['v1.2.3'],
    })
    expect((await service.getOptions({ refresh: true })).repositories[0]).toMatchObject({
      nextTag: 'v1.2.5', previousTags: ['v1.2.4'],
    })
  })

  it('returns ten exact-deduplicated tags in deterministic version and name order', async () => {
    const tags = [
      'release-2',
      'v1.9.99',
      'v2.0.0-rc.10',
      'alpha',
      '2.0.0-rc.2',
      'v2.0.0',
      'release-10',
      'v1.10.0',
      'v2.0.0-beta',
      'v2.0.0',
      '2.0.0',
      'release-20',
    ]
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/tags?')) {
          return tags.map((name) => ({ name }))
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getOptions()).resolves.toMatchObject({
      repositories: [{
        latestTag: 'v2.0.0',
        previousTags: [
          'v2.0.0',
          '2.0.0',
          'v2.0.0-rc.10',
          '2.0.0-rc.2',
          'v2.0.0-beta',
          'v1.10.0',
          'v1.9.99',
          'release-20',
          'release-10',
          'release-2',
        ],
      }],
    })
    expect(executor.rest).toHaveBeenCalledOnce()
  })

  it('does not disguise a failed explicit option refresh as fresh cached data', async () => {
    let fail = false
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (fail) throw new Error('offline')
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search()
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.3' }]
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    await service.getOptions()
    fail = true
    await expect(service.getOptions({ refresh: true })).rejects.toMatchObject({
      code: 'release_options_unavailable',
    })
  })

  it('bootstraps and coalesces repository discovery before the first pull-list prime', async () => {
    const loadOpenPulls = vi.fn(async () => openSnapshot())
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [mergedCandidateWithPull()],
    }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.3' }]
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls, now: () => NOW,
    })

    const [left, right] = await Promise.all([service.getOptions(), service.getOptions()])

    expect(left).toEqual(right)
    expect(loadOpenPulls).toHaveBeenCalledOnce()
    expect(loadOpenPulls).toHaveBeenCalledWith({ refresh: false })
    expect(loadMergedPulls).toHaveBeenCalledOnce()
    expect(executor.rest).toHaveBeenCalledOnce()
  })

  it('discovers a viewer repository catalog once and refreshes only tags afterward', async () => {
    let clock = NOW
    let tags = ['v1.2.3']
    const loadOpenPulls = vi.fn(async () => openSnapshot())
    const loadMergedPulls = vi.fn(async () => ({ incomplete: false, items: [] }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/tags?')) return tags.map((name) => ({ name }))
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls, now: () => clock,
    })

    await service.primeRepositories(openSnapshot())
    const initial = await service.getOptions()
    clock += 1_000
    tags = ['v1.2.4']
    const refreshed = await service.getOptions({ refresh: true })
    service.invalidate()
    clock += 1_000
    const invalidated = await service.getOptions()
    await service.primeRepositories({ ...openSnapshot(['other/repo']), viewerLogin: 'VIEWER' })

    expect(initial).toMatchObject({
      generatedAt: '2026-07-21T00:00:00.000Z',
      repositoriesUpdatedAt: '2026-07-21T00:00:00.000Z',
      tagsUpdatedAt: '2026-07-21T00:00:00.000Z',
    })
    expect(refreshed).toMatchObject({
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: '2026-07-21T00:00:01.000Z',
    })
    expect(invalidated).toMatchObject({
      repositories: [{ repository: 'owner/repo' }],
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: '2026-07-21T00:00:02.000Z',
    })
    expect(loadOpenPulls).not.toHaveBeenCalled()
    expect(loadMergedPulls).toHaveBeenCalledOnce()
    expect(executor.rest).toHaveBeenCalledTimes(3)
  })

  it('keeps a first truncated repository catalog usable and does not replace a complete catalog', async () => {
    const partialMerged = vi.fn(async () => ({
      incomplete: true,
      items: [{ repository: 'merged/repo', repositoryUrl: 'https://github.com/merged/repo' }],
    }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes('/tags?')) return []
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const partialService = createReleaseService({
      executor, loadMergedPulls: partialMerged, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    await partialService.primeRepositories(openSnapshot())
    const partial = await partialService.getOptions()
    await partialService.primeRepositories({ ...openSnapshot(['ignored/repo']), partial: false })

    expect(partial).toMatchObject({ repositoriesUpdatedAt: '2026-07-21T00:00:00.000Z' })
    expect(partial.repositories.map(({ repository }) => repository)).toEqual(['merged/repo', 'owner/repo'])
    expect(partial.warnings).toContain('GitHub truncated the authored merged pull request search.')
    expect(partialMerged).toHaveBeenCalledOnce()

    const completeMerged = vi.fn(async () => ({ incomplete: false, items: [] }))
    const completeService = createReleaseService({
      executor, loadMergedPulls: completeMerged, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    await completeService.primeRepositories(openSnapshot())
    await completeService.primeRepositories({ ...openSnapshot(['ignored/repo']), partial: true })
    const complete = await completeService.getOptions()
    expect(complete).toMatchObject({ warnings: [] })
    expect(complete.repositories).toMatchObject([{ repository: 'owner/repo' }])
    expect(completeMerged).toHaveBeenCalledOnce()
  })

  it('ignores an old viewer discovery that completes after a new viewer is active', async () => {
    const alice = deferred()
    const bob = deferred()
    const loadMergedPulls = vi.fn(({ viewerLogin }) =>
      viewerLogin.toLowerCase() === 'alice' ? alice.promise : bob.promise)
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/bob/repo/tags?')) return []
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    const oldPrime = service.primeRepositories({ ...openSnapshot(['alice/repo']), viewerLogin: 'Alice' })
    const newPrime = service.primeRepositories({ ...openSnapshot(['bob/repo']), viewerLogin: 'Bob' })
    alice.resolve({ incomplete: false, items: [] })
    await expect(oldPrime).resolves.toBeNull()
    bob.resolve({ incomplete: false, items: [] })
    await expect(newPrime).resolves.toMatchObject({ viewerLogin: 'Bob' })

    await expect(service.getOptions()).resolves.toMatchObject({
      repositories: [{ repository: 'bob/repo' }],
      viewerLogin: 'Bob',
    })
  })

  it('clears old-viewer options immediately while the new viewer catalog is loading', async () => {
    const bob = deferred()
    const loadMergedPulls = vi.fn(({ viewerLogin }) => viewerLogin === 'Bob'
      ? bob.promise
      : Promise.resolve({ incomplete: false, items: [] }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes('/tags?')) return []
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    await service.primeRepositories({ ...openSnapshot(['alice/repo']), viewerLogin: 'Alice' })
    await service.getOptions()

    const prime = service.primeRepositories({ ...openSnapshot(['bob/repo']), viewerLogin: 'Bob' })
    let settled = false
    const options = service.getOptions().then((value) => {
      settled = true
      return value
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    bob.resolve({ incomplete: false, items: [] })
    await prime
    await expect(options).resolves.toMatchObject({
      repositories: [{ repository: 'bob/repo' }],
      viewerLogin: 'Bob',
    })
  })

  it('rebinds options before reading tags when the viewer changes after catalog resolution', async () => {
    const alice = deferred()
    const bob = deferred()
    const bobStarted = deferred()
    const loadMergedPulls = vi.fn(({ viewerLogin }) => {
      if (viewerLogin === 'Alice') return alice.promise
      bobStarted.resolve()
      return bob.promise
    })
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/alice/repo/tags?')) return [{ name: 'v9.0.0' }]
        if (endpoint.startsWith('repos/bob/repo/tags?')) return [{ name: 'v2.0.0' }]
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    const alicePrime = service.primeRepositories({
      ...openSnapshot(['alice/repo']),
      viewerLogin: 'Alice',
    })
    const bobPrime = alicePrime.then(() => service.primeRepositories({
      ...openSnapshot(['bob/repo']),
      viewerLogin: 'Bob',
    }))
    const options = service.getOptions()

    alice.resolve({ incomplete: false, items: [] })
    await bobStarted.promise
    await new Promise((resolve) => setImmediate(resolve))
    const readsBeforeBob = executor.rest.mock.calls.map(([endpoint]) => endpoint)
    bob.resolve({ incomplete: false, items: [] })
    await bobPrime

    await expect(options).resolves.toMatchObject({
      repositories: [{ latestTag: 'v2.0.0', repository: 'bob/repo' }],
      viewerLogin: 'Bob',
    })
    await expect(service.getOptions()).resolves.toMatchObject({ viewerLogin: 'Bob' })
    expect(readsBeforeBob).toEqual([])
    expect(executor.rest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'repos/bob/repo/tags?per_page=100&page=1',
    ])
  })

  it('does not begin recent-release reads from a catalog superseded after await', async () => {
    const bob = deferred()
    const bobStarted = deferred()
    const loadMergedPulls = vi.fn(({ viewerLogin }) => {
      if (viewerLogin === 'Bob') {
        bobStarted.resolve()
        return bob.promise
      }
      return Promise.resolve({ incomplete: false, items: [] })
    })
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes('/releases?')) return []
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadMergedPulls, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    await service.primeRepositories({
      ...openSnapshot(['alice/repo']),
      viewerLogin: 'Alice',
    })

    const recent = service.getRecent().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    let bobPrime
    queueMicrotask(() => {
      bobPrime = service.primeRepositories({
        ...openSnapshot(['bob/repo']),
        viewerLogin: 'Bob',
      })
    })

    await bobStarted.promise
    await new Promise((resolve) => setImmediate(resolve))
    const mergedBeforeBob = loadMergedPulls.mock.calls.map(([{ viewerLogin }]) => viewerLogin)
    const releaseReadsBeforeBob = executor.rest.mock.calls.map(([endpoint]) => endpoint)
    bob.resolve({ incomplete: false, items: [] })
    await bobPrime

    await expect(recent).resolves.toMatchObject({
      error: { code: 'repository_catalog_changed' },
    })
    await expect(service.getRecent()).resolves.toMatchObject({ partial: false, releases: [] })
    expect(mergedBeforeBob).toEqual(['Alice', 'Bob'])
    expect(releaseReadsBeforeBob).toEqual([])
    expect(executor.rest.mock.calls.every(([endpoint]) =>
      !endpoint.startsWith('repos/alice/repo/releases?'))).toBe(true)
  })

  it('falls back to cached tags only for non-explicit refresh failures', async () => {
    let clock = NOW
    let fail = false
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/tags?')) {
          if (fail) throw new Error('offline')
          return [{ name: 'v1.2.3' }]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
      ttl: 10,
    })
    await service.primeRepositories(openSnapshot())
    const initial = await service.getOptions()
    fail = true
    clock += 11

    const fallback = await service.getOptions()
    expect(fallback).toMatchObject({
      generatedAt: '2026-07-21T00:00:00.011Z',
      repositories: [{ previousTags: ['v1.2.3'] }],
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: initial.tagsUpdatedAt,
    })
    expect(fallback.warnings).toContain('Showing cached release options because GitHub could not refresh tags.')
    await expect(service.getOptions({ refresh: true })).rejects.toMatchObject({
      code: 'release_options_unavailable',
    })
  })

  it('rebases a failed recent refresh and removes cached releases that have left the seven-day window', async () => {
    let clock = NOW
    let fail = false
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          if (fail) {
            throw new ActionError(502, 'github_unavailable', 'GitHub is unavailable.')
          }
          return [release({
            body: 'https://github.com/owner/repo/pull/7',
            published: new Date(NOW).toISOString(),
          })]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    })

    const initial = await service.getRecent()
    fail = true
    clock += 7 * 24 * 60 * 60 * 1_000 + 1

    const fallback = await service.getRecent({ refresh: true })

    expect(initial).toMatchObject({
      generatedAt: '2026-07-21T00:00:00.000Z',
      releases: [{ id: '10' }],
    })
    expect(fallback).toMatchObject({
      generatedAt: '2026-07-28T00:00:00.001Z',
      partial: true,
      releases: [],
      warnings: [expect.stringContaining('Showing cached releases')],
    })
  })

  it('includes a release published exactly at the seven-day boundary', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [release({
            body: 'https://github.com/owner/repo/pull/7',
            published: '2026-07-14T00:00:00.000Z',
          })]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      releases: [{ id: '10', pulls: [{ number: 7 }] }],
    })
  })

  it('excludes a release published one millisecond before the seven-day boundary', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [release({
            body: 'https://github.com/owner/repo/pull/7',
            published: '2026-07-13T23:59:59.999Z',
          })]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({ releases: [] })
  })

  it('keeps authored merged pull discovery on its ninety-day window', async () => {
    const loadMergedPulls = vi.fn(async () => ({ incomplete: false, items: [] }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/repo/releases?')) return []
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await service.primeRepositories(openSnapshot())
    await service.getRecent()

    expect(loadMergedPulls.mock.calls.map(([input]) => input)).toEqual([
      { since: '2026-04-22', viewerLogin: 'viewer' },
      { since: '2026-04-22', viewerLogin: 'viewer' },
    ])
  })

  it('intersects canonical release-note links with authored candidates and deduplicates pulls', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search([
          mergedItem(),
          mergedItem(),
        ])
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.4' }]
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [
            release({ body: 'https://github.com/owner/repo/pull/7' }),
            release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' }),
          ]
        }
        if (endpoint.startsWith('repos/owner/repo/compare/')) {
          return { commits: [{ sha: SHA }], status: 'ahead', total_commits: 1 }
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull(), mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })
    const result = await service.getRecent()
    expect(result.releases).toHaveLength(1)
    expect(result.releases[0]).toMatchObject({
      complete: false,
      id: '10',
      source: 'notes-fallback',
      tag: 'v1.2.4',
      warning: expect.stringContaining('Verify'),
    })
    expect(result.releases[0].pulls).toEqual([{
      headSha: SHA,
      mergedAt: '2026-07-19T00:00:00Z',
      number: 7,
      repository: 'owner/repo',
      title: 'Released fix',
      url: 'https://github.com/owner/repo/pull/7',
    }])
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/compare/'))).toBe(false)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/'))).toBe(false)
  })

  it('does not fan out comparisons or per-pull REST reads during recent discovery', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search([mergedItem()])
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [
            release({ body: 'https://github.com/owner/repo/pull/7' }),
            release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' }),
          ]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    const result = await service.getRecent()

    expect(result.releases[0].pulls).toMatchObject([{ number: 7 }])
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      /^repos\/owner\/repo\/commits\/[a-f0-9]{40}\/pulls/.test(endpoint))).toHaveLength(0)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/pulls/7')).toHaveLength(0)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/compare/'))).toBe(false)
    expect(executor.rest).toHaveBeenCalledOnce()
  })

  it('uses batched GraphQL authored candidates without one REST request per pull', async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async () => ({
        search: {
          issueCount: 1,
          nodes: [{
            author: { login: 'viewer' },
            headRefOid: SHA,
            mergeCommit: { oid: SHA },
            mergedAt: '2026-07-19T00:00:00Z',
            number: 7,
            repository: { nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' },
            title: 'Released fix',
            url: 'https://github.com/owner/repo/pull/7',
          }],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      })),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [
            release({ body: 'https://github.com/owner/repo/pull/7' }),
            release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' }),
          ]
        }
        if (endpoint.startsWith('repos/owner/repo/compare/')) {
          return { commits: [{ sha: SHA }], status: 'ahead', total_commits: 1 }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    const result = await service.getRecent()

    expect(result.releases[0]).toMatchObject({
      complete: false,
      pulls: [{ number: 7 }],
      source: 'notes-fallback',
    })
    expect(executor.graphql).toHaveBeenCalledTimes(2)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/'))).toBe(false)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/compare/'))).toBe(false)
    expect(executor.rest).toHaveBeenCalledOnce()
  })

  it('omits completely compared release groups with no authored pull requests', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [
            release(),
            release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' }),
          ]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [],
    })
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/compare/'))).toBe(false)
  })

  it('uses only canonical release-note links that intersect authored candidates', async () => {
    const current = release({ body: 'Included https://github.com/owner/repo/pull/7' })
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search()
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.4' }]
        if (endpoint.startsWith('repos/owner/repo/releases?')) return [current]
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })
    const result = await service.getRecent()
    expect(result.releases[0]).toMatchObject({
      complete: false, source: 'notes-fallback', pulls: [{ number: 7 }],
    })
    expect(result.partial).toBe(false)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/'))).toBe(false)
  })

  it('returns an authoritative empty refresh when a previously linked authored pull disappears', async () => {
    let include = true
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [release({ body: 'https://github.com/owner/repo/pull/7' })]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: include ? [mergedCandidateWithPull()] : [],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ pulls: [{ number: 7 }] }],
    })
    include = false
    await expect(service.getRecent({ refresh: true })).resolves.toMatchObject({
      partial: false,
      releases: [],
    })
  })

  it('marks malformed published release data partial without discarding valid groups', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [
            release({ body: 'https://github.com/owner/repo/pull/7' }),
            { draft: false, id: 9, tag_name: 'v1.2.3' },
          ]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [mergedCandidateWithPull()] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
      warnings: [expect.stringContaining('malformed or changing published release data')],
    })
  })

  it('bounds repeated GraphQL cursors and marks authored search evidence partial', async () => {
    const node = {
      author: { login: 'viewer' },
      headRefOid: SHA,
      mergeCommit: { oid: SHA },
      mergedAt: '2026-07-19T00:00:00Z',
      number: 7,
      repository: { nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' },
      title: 'Released fix',
      url: 'https://github.com/owner/repo/pull/7',
    }
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async () => ({
        search: {
          issueCount: 2,
          nodes: [node],
          pageInfo: { endCursor: 'repeated', hasNextPage: true },
        },
      })),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [release({ body: 'https://github.com/owner/repo/pull/7' })]
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    const result = await service.getRecent()
    expect(result).toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
    })
    expect(result.warnings).toContain('GitHub truncated the authored merged pull request search.')
    expect(executor.graphql).toHaveBeenCalledTimes(4)
  })

  it('bounds repeated release pages and marks the release catalog partial', async () => {
    const values = [
      release({ body: 'https://github.com/owner/repo/pull/7' }),
      ...Array.from({ length: 99 }, (_, index) => release({
        id: index + 100,
        tag: `v0.0.${index + 1}`,
        published: '2026-07-01T00:00:00Z',
      })),
    ]
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) return values
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [mergedCandidateWithPull()] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
      warnings: [expect.stringContaining('repeated release page')],
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.startsWith('repos/owner/repo/releases?'))).toHaveLength(2)
  })

  it('finds a recently published release on a later page after older releases', async () => {
    const oldPage = Array.from({ length: 100 }, (_, index) => release({
      id: index + 100,
      tag: `v0.0.${index + 1}`,
      published: '2026-01-01T00:00:00Z',
    }))
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return endpoint.endsWith('page=2')
            ? [release({ body: 'https://github.com/owner/repo/pull/7' })]
            : oldPage
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [mergedCandidateWithPull()] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ id: '10', pulls: [{ number: 7 }] }],
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.startsWith('repos/owner/repo/releases?'))).toHaveLength(2)
  })

  it('bypasses cached notes evidence and freshly authorizes exact comparison membership', async () => {
    let fresh = false
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search()
        if (endpoint.startsWith('repos/owner/repo/tags?')) return [{ name: 'v1.2.4' }]
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return fresh
            ? [release(), release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })]
            : [release({ body: 'https://github.com/owner/repo/pull/7' })]
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) {
          return [{
            additions: 1,
            deletions: 1,
            filename: 'src/fix.js',
            patch: '@@ -1 +1 @@\n-old\n+new',
            status: 'modified',
          }]
        }
        if (endpoint.startsWith('repos/owner/repo/compare/')) return { status: 'ahead' }
        if (endpoint.startsWith(`repos/owner/repo/commits/${SHA}/pulls?`)) return [authoredPull()]
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: TAG_SHA, type: 'tag' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return { ref: 'refs/tags/v1.2.3', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === `repos/owner/repo/git/tags/${TAG_SHA}`) {
          return { object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    })
    expect((await service.getRecent()).releases[0].source).toBe('notes-fallback')
    fresh = true
    await expect(service.resolveVerification({
      headSha: SHA,
      pullNumber: 7,
      pullUrl: 'https://github.com/owner/repo/pull/7',
      releaseId: '10',
      repository: 'owner/repo',
      tag: 'v1.2.4',
    })).resolves.toMatchObject({
      context: expect.stringContaining('src/fix.js'),
      pull: { headSha: SHA, number: 7 },
      release: {
        commitOid: RELEASE_SHA,
        complete: true,
        id: '10',
        source: 'comparison',
        tag: 'v1.2.4',
      },
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/releases/10')).toHaveLength(2)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4')).toHaveLength(2)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.startsWith('repos/owner/repo/compare/'))).toHaveLength(2)
    expect(executor.rest.mock.calls.some(([endpoint]) =>
      /\/commits\/[a-f0-9]{40}\/pulls/.test(endpoint))).toBe(false)
  })

  it('rejects display-only notes membership and tag or pull identity drift', async () => {
    let tagCalls = 0
    let moved = false
    let wrongHead = false
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return moved || wrongHead
            ? [release(), release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })]
            : [release({ body: 'https://github.com/owner/repo/pull/7' })]
        }
        if (endpoint.startsWith('repos/owner/repo/compare/')) {
          return { status: moved || wrongHead ? 'ahead' : 'behind' }
        }
        if (endpoint.startsWith(`repos/owner/repo/commits/${SHA}/pulls?`)) return [authoredPull()]
        if (endpoint === 'repos/owner/repo/pulls/7') {
          return wrongHead ? authoredPull(7, { head: { sha: TAG_SHA } }) : authoredPull()
        }
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) {
          return [{
            additions: 1,
            deletions: 0,
            filename: 'src/fix.js',
            patch: '@@ -0,0 +1 @@\n+fix',
            status: 'added',
          }]
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          tagCalls += 1
          return {
            ref: 'refs/tags/v1.2.4',
            object: { sha: moved && tagCalls % 2 === 0 ? TAG_SHA : RELEASE_SHA, type: 'commit' },
          }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return {
            ref: 'refs/tags/v1.2.3',
            object: { sha: BASE_RELEASE_SHA, type: 'commit' },
          }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    const input = {
      headSha: SHA,
      pullNumber: 7,
      pullUrl: 'https://github.com/owner/repo/pull/7',
      releaseId: '10',
      repository: 'owner/repo',
      tag: 'v1.2.4',
    }
    await expect(service.resolveVerification(input)).resolves.toBeNull()

    moved = true
    await expect(service.resolveVerification(input)).resolves.toBeNull()

    moved = false
    wrongHead = true
    await expect(service.resolveVerification(input)).resolves.toBeNull()
  })

  it('excludes a pull whose merge commit is exactly the predecessor boundary', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return [release(), release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })]
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return { ref: 'refs/tags/v1.2.3', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint.includes(`/compare/${BASE_RELEASE_SHA}...${SHA}`)) return { status: 'identical' }
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`)) return { status: 'ahead' }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput())).resolves.toBeNull()
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/7/files?'))).toBe(false)
  })

  it('finds the globally closest predecessor even when it appears on a later page', async () => {
    const closer = release({
      id: 11,
      tag: 'v1.2.3-close',
      published: '2026-07-10T00:00:00Z',
    })
    const far = release({ id: 9, tag: 'v1.2.3-far', published: '2026-04-01T00:00:00Z' })
    const firstPage = [
      release(),
      far,
      ...Array.from({ length: 98 }, (_, index) => release({
        id: index + 100,
        tag: `v0.0.${index + 1}`,
        published: '2026-03-01T00:00:00Z',
      })),
    ]
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return endpoint.endsWith('page=2') ? [closer] : firstPage
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) return [changedFile()]
        if (endpoint.startsWith('repos/owner/repo/compare/')) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3-close') {
          return { ref: 'refs/tags/v1.2.3-close', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput())).resolves.toMatchObject({
      pull: { number: 7 },
      release: { commitOid: RELEASE_SHA, source: 'comparison' },
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3-close')).toHaveLength(2)
    expect(executor.rest.mock.calls.some(([endpoint]) =>
      endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3-far')).toBe(false)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.startsWith('repos/owner/repo/releases?'))).toHaveLength(4)
  })

  it('orders same-second releases by numeric GitHub release ID', async () => {
    const current = release({ id: 100, published: '2026-07-20T00:00:00Z' })
    const predecessor = release({
      id: 99,
      tag: 'v1.2.3',
      published: '2026-07-20T00:00:00Z',
    })
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/100') return current
        if (endpoint.startsWith('repos/owner/repo/releases?')) return [predecessor, current]
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) return [changedFile()]
        if (endpoint.startsWith('repos/owner/repo/compare/')) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return { ref: 'refs/tags/v1.2.3', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput({ releaseId: '100' }))).resolves.toMatchObject({
      pull: { number: 7 },
      release: { id: '100', source: 'comparison' },
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3')).toHaveLength(2)
  })

  it('rejects verification when release adjacency changes after diff context is loaded', async () => {
    const predecessor = release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })
    const raced = release({ id: 11, tag: 'v1.2.3.5', published: '2026-07-10T00:00:00Z' })
    let releaseListCalls = 0
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          releaseListCalls += 1
          return releaseListCalls === 1
            ? [release(), predecessor]
            : [release(), raced, predecessor]
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) return [changedFile()]
        if (endpoint.startsWith('repos/owner/repo/compare/')) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return { ref: 'refs/tags/v1.2.3', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput())).resolves.toBeNull()
    expect(releaseListCalls).toBe(2)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/7/files?'))).toBe(true)
  })

  it('verifies first-release membership against the release head without a lower bound', async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) return [release()]
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) return [changedFile()]
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`)) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput())).resolves.toMatchObject({
      context: expect.stringContaining('src/fix.js'),
      pull: { number: 7 },
      release: { commitOid: RELEASE_SHA, source: 'comparison' },
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.startsWith('repos/owner/repo/compare/'))).toHaveLength(1)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4')).toHaveLength(2)
  })

  it('rejects first-release verification when a predecessor appears after context is loaded', async () => {
    const predecessor = release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })
    let releaseListCalls = 0
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return release()
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          releaseListCalls += 1
          return releaseListCalls === 1 ? [release()] : [release(), predecessor]
        }
        if (endpoint === 'repos/owner/repo/pulls/7') return authoredPull()
        if (endpoint.startsWith('repos/owner/repo/pulls/7/files?')) return [changedFile()]
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`)) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })

    await expect(service.resolveVerification(verificationInput())).resolves.toBeNull()
    expect(releaseListCalls).toBe(2)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/pulls/7/files?'))).toBe(true)
  })

  it('snapshots exact current authored release membership and rejects pull identity drift', async () => {
    const current = release({
      body: [
        'https://github.com/owner/repo/pull/7',
        'https://github.com/owner/repo/pull/8',
        'https://github.com/owner/repo/pull/8',
        'https://github.com/owner/repo/pull/9',
      ].join('\n'),
    })
    const predecessor = release({ id: 9, tag: 'v1.2.3', published: '2026-04-01T00:00:00Z' })
    let drift = false
    let pullSevenReads = 0
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint === 'repos/owner/repo/releases/10') return current
        if (endpoint.startsWith('repos/owner/repo/releases?')) return [current, predecessor]
        if (endpoint === 'repos/owner/repo/pulls/7') {
          pullSevenReads += 1
          return drift && pullSevenReads % 2 === 0
            ? authoredPull(7, { head: { sha: TAG_SHA } })
            : authoredPull(7)
        }
        if (endpoint === 'repos/owner/repo/pulls/8') return authoredPull(8)
        if (endpoint === 'repos/owner/repo/pulls/9') {
          return authoredPull(9, { user: { login: 'someone-else' } })
        }
        if (endpoint.startsWith('repos/owner/repo/compare/')) return { status: 'ahead' }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          return { ref: 'refs/tags/v1.2.4', object: { sha: RELEASE_SHA, type: 'commit' } }
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.3') {
          return { ref: 'refs/tags/v1.2.3', object: { sha: BASE_RELEASE_SHA, type: 'commit' } }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    const service = createReleaseService({
      executor, loadOpenPulls: async () => openSnapshot(), now: () => NOW,
    })
    const releaseIdentity = { releaseId: '10', repository: 'owner/repo', tag: 'v1.2.4' }

    await expect(service.resolveReleaseVerifications(releaseIdentity)).resolves.toMatchObject({
      pulls: [{ number: 7, headSha: SHA }, { number: 8, headSha: SHA }],
      release: {
        commitOid: RELEASE_SHA,
        complete: true,
        id: '10',
        source: 'comparison',
      },
    })
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/pulls/8')).toHaveLength(2)
    expect(executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint === 'repos/owner/repo/pulls/9')).toHaveLength(1)

    drift = true
    await expect(service.resolveReleaseVerifications(releaseIdentity)).rejects.toMatchObject({
      code: 'verification_membership_changed',
    })
  })
})

describe('verification context', () => {
  it('reserves room for an explicit marker when a file exceeds the byte boundary', async () => {
    const header = 'Exact GitHub pull-request file evidence (untrusted content):'
    const first = [
      'File: "a.js"',
      'Status: modified; additions=1; deletions=0',
      'Patch:',
      '+a',
    ].join('\n')
    const expected = [header, first, VERIFICATION_OMISSION_MARKER].join('\n\n')
    const maximumBytes = Buffer.byteLength(expected, 'utf8')
    const executor = {
      rest: vi.fn(async () => [
        { additions: 1, deletions: 0, filename: 'a.js', patch: '+a', status: 'modified' },
        { additions: 100, deletions: 0, filename: 'emoji.js', patch: '🙂'.repeat(100), status: 'modified' },
      ]),
    }

    const context = await loadVerificationContext(executor, 'owner/repo', 7, { maximumBytes })

    expect(context).toBe(expected)
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(maximumBytes)
    expect(context).not.toContain('emoji.js')
  })

  it('marks GitHub-omitted patches as incomplete without exceeding a multibyte-safe budget', async () => {
    const executor = {
      rest: vi.fn(async () => [{
        additions: 2,
        deletions: 1,
        filename: '日本語.js',
        status: 'modified',
      }]),
    }
    const maximumBytes = 512

    const context = await loadVerificationContext(executor, 'owner/repo', 7, { maximumBytes })

    expect(context).toContain('Patch unavailable')
    expect(context).toContain(VERIFICATION_OMISSION_MARKER)
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(maximumBytes)
  })
})

describe('release creation', () => {
  function creationFixture({
    baseTags = ['v1.2.3'],
    draftLost = 0,
    foreignReference = false,
    foreignRelease = false,
    publishFails = false,
    publishLost = 0,
    referenceLost = 0,
    tagObjectLost = 0,
    moveOnReferenceRead = null,
  } = {}) {
    const state = {
      draftLost,
      publishLost,
      reference: null,
      referenceReads: 0,
      referenceLost,
      release: null,
      tagObjectExists: false,
      tagObjectLost,
      tagObjectOid: null,
      tagObjectPayloads: [],
    }
    const missing = () => new ExecutorError('failed')
    const notFound = () => {
      const error = missing()
      error.status = 404
      return error
    }
    const published = () => ({
      body: state.release.body,
      draft: false,
      html_url: 'https://github.com/owner/repo/releases/tag/v1.2.4',
      id: 10,
      name: 'Generated v1.2.4',
      published_at: '2026-07-21T00:00:00Z',
      tag_name: state.release.tag_name,
    })
    const executor = {
      action: vi.fn(async (args) => {
        if (args[1] === 'repos/owner/repo/releases/10') {
          state.release = null
          throw new ExecutorError('timeout')
        }
        if (args[1] === 'repos/owner/repo/git/refs/tags/v1.2.4') {
          state.reference = null
          throw new ExecutorError('timeout')
        }
        throw new Error(`Unexpected action ${args.join(' ')}`)
      }),
      rest: vi.fn(async (endpoint, options = {}) => {
        if (endpoint === 'user') return { login: 'viewer' }
        if (endpoint.startsWith('search/issues?')) return search()
        if (endpoint.startsWith('repos/owner/repo/tags?')) {
          return [...baseTags, ...(state.reference ? ['v1.2.4'] : [])].map((name) => ({ name }))
        }
        if (endpoint === 'repos/owner/repo') return { default_branch: 'main' }
        if (endpoint === 'repos/owner/repo/commits/main') return { sha: RELEASE_SHA }
        if (endpoint === 'repos/owner/repo/git/tags' && options.method === 'POST') {
          state.tagObjectOid = annotatedTagSha(options.fields)
          state.tagObjectExists = true
          state.tagObjectPayloads.push(JSON.stringify(options.fields))
          const value = {
            message: options.fields.message,
            object: { sha: RELEASE_SHA, type: 'commit' },
            sha: state.tagObjectOid,
            tag: options.fields.tag,
            tagger: options.fields.tagger,
          }
          if (state.tagObjectLost > 0) {
            state.tagObjectLost -= 1
            throw new ExecutorError('timeout')
          }
          return value
        }
        if (state.tagObjectExists && endpoint === `repos/owner/repo/git/tags/${state.tagObjectOid}`) {
          return {
            message: '<!-- puller-release:transaction -->\n',
            object: { sha: RELEASE_SHA, type: 'commit' },
            sha: state.tagObjectOid,
            tag: 'v1.2.4',
            tagger: {
              date: '2026-07-21T00:00:00.000Z',
              email: 'puller@users.noreply.github.com',
              name: 'Puller',
            },
          }
        }
        if (endpoint === 'repos/owner/repo/git/refs' && options.method === 'POST') {
          state.reference = foreignReference
            ? { oid: BASE_RELEASE_SHA, type: 'commit' }
            : { oid: options.fields.sha, type: 'tag' }
          if (foreignReference) throw new Error('Reference already exists')
          const value = {
            object: { sha: options.fields.sha, type: 'tag' },
            ref: 'refs/tags/v1.2.4',
          }
          if (state.referenceLost > 0) {
            state.referenceLost -= 1
            throw new ExecutorError('timeout')
          }
          return value
        }
        if (endpoint === 'repos/owner/repo/git/ref/tags/v1.2.4') {
          if (!state.reference) throw notFound()
          state.referenceReads += 1
          if (state.referenceReads === moveOnReferenceRead) {
            state.reference = { oid: BASE_RELEASE_SHA, type: 'commit' }
          }
          return {
            object: { sha: state.reference.oid, type: state.reference.type },
            ref: 'refs/tags/v1.2.4',
          }
        }
        if (endpoint === 'repos/owner/repo/releases' && options.method === 'POST') {
          state.release = foreignRelease
            ? { body: 'foreign', draft: true, id: 11, tag_name: 'v1.2.4' }
            : {
                body: `${options.fields.body}\n\n## What's Changed\n\nGenerated notes`,
                draft: true,
                id: 10,
                tag_name: options.fields.tag_name,
              }
          if (foreignRelease) throw new Error('Already exists')
          if (state.draftLost > 0) {
            state.draftLost -= 1
            throw new ExecutorError('timeout')
          }
          return state.release
        }
        if (endpoint === 'repos/owner/repo/releases/10' && options.method === 'PATCH') {
          if (publishFails) throw new ExecutorError('timeout')
          state.release = published()
          if (state.publishLost > 0) {
            state.publishLost -= 1
            throw new ExecutorError('timeout')
          }
          return state.release
        }
        if (endpoint === 'repos/owner/repo/releases/10') {
          if (!state.release || String(state.release.id) !== '10') throw notFound()
          return state.release
        }
        if (endpoint === 'repos/owner/repo/releases/tags/v1.2.4') {
          if (!state.release) throw notFound()
          return state.release
        }
        if (endpoint.startsWith('repos/owner/repo/releases?')) {
          return state.release ? [state.release] : []
        }
        throw new Error(`Unexpected endpoint ${endpoint}`)
      }),
    }
    return { executor, state }
  }

  function serviceFor(executor, overrides = {}) {
    return createReleaseService({
      executor,
      identifier: () => 'transaction',
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
      ...overrides,
    })
  }

  const input = { repository: 'owner/repo', tag: 'v1.2.4', expectedLatestTag: 'v1.2.3' }

  it('creates an ownership-marked annotated tag and publishes REST-generated notes', async () => {
    const { executor, state } = creationFixture()
    const invalidateReadiness = vi.fn()
    const refetch = vi.fn()
    const service = serviceFor(executor, { invalidateReadiness, refetch })

    await expect(service.create(input)).resolves.toMatchObject({
      id: '10', repository: 'owner/repo', tag: 'v1.2.4',
    })
    expect(executor.rest).toHaveBeenCalledWith('repos/owner/repo/git/tags', {
      fields: {
        message: '<!-- puller-release:transaction -->\n',
        object: RELEASE_SHA,
        tag: 'v1.2.4',
        tagger: {
          date: '2026-07-21T00:00:00.000Z',
          email: 'puller@users.noreply.github.com',
          name: 'Puller',
        },
        type: 'commit',
      },
      method: 'POST',
      validate: expect.any(Function),
    })
    expect(executor.rest).toHaveBeenCalledWith('repos/owner/repo/releases', {
      fields: {
        body: '<!-- puller-release:transaction -->',
        draft: true,
        generate_release_notes: true,
        prerelease: false,
        tag_name: 'v1.2.4',
        target_commitish: RELEASE_SHA,
      },
      method: 'POST',
      validate: expect.any(Function),
    })
    expect(state.release.body).toContain('Generated notes')
    expect(state.release.draft).toBe(false)
    expect(invalidateReadiness).toHaveBeenCalledOnce()
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('uses a whole-second deterministic tagger timestamp', async () => {
    const { executor, state } = creationFixture()

    await expect(serviceFor(executor, { now: () => NOW + 789 }).create(input)).resolves.toMatchObject({
      id: '10',
    })

    const [payload] = state.tagObjectPayloads.map((value) => JSON.parse(value))
    expect(payload.tagger).toEqual({
      date: '2026-07-21T00:00:00.000Z',
      email: 'puller@users.noreply.github.com',
      name: 'Puller',
    })
    expect(annotatedTagSha(payload)).toBe(state.tagObjectOid)
  })

  it('reconciles response loss for tag-object, ref, draft, and publication without duplicates', async () => {
    const { executor, state } = creationFixture({
      draftLost: 1,
      publishLost: 1,
      referenceLost: 1,
      tagObjectLost: 1,
    })
    await expect(serviceFor(executor).create(input)).resolves.toMatchObject({ id: '10' })
    expect(state.reference).toEqual({ oid: state.tagObjectOid, type: 'tag' })
    expect(state.release).toMatchObject({ draft: false, id: 10 })
    expect(state.tagObjectPayloads).toHaveLength(1)
    expect(executor.rest.mock.calls.filter(([endpoint, options]) =>
      endpoint === 'repos/owner/repo/git/tags' && options.method === 'POST')).toHaveLength(1)
    expect(executor.rest.mock.calls.filter(([endpoint, options]) =>
      endpoint === 'repos/owner/repo/releases' && options.method === 'POST')).toHaveLength(1)
    expect(executor.action).not.toHaveBeenCalled()
  })

  it('reconciles lost cleanup responses and leaves no owned draft or tag', async () => {
    const { executor, state } = creationFixture({ publishFails: true })
    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: 'release_publish_unconfirmed',
    })
    expect(state.release).toBeNull()
    expect(state.reference).toBeNull()
    expect(executor.action).toHaveBeenCalledWith([
      'api', 'repos/owner/repo/releases/10', '--method', 'DELETE',
    ])
    expect(executor.action).toHaveBeenCalledWith([
      'api', 'repos/owner/repo/git/refs/tags/v1.2.4', '--method', 'DELETE',
    ])
  })

  it('does not delete a foreign tag or a release raced onto the owned tag', async () => {
    const tagRace = creationFixture({ foreignReference: true })
    await expect(serviceFor(tagRace.executor).create(input)).rejects.toMatchObject({
      code: 'tag_create_conflict',
    })
    expect(tagRace.state.reference).toEqual({ oid: BASE_RELEASE_SHA, type: 'commit' })
    expect(tagRace.executor.action).not.toHaveBeenCalled()

    const releaseRace = creationFixture({ foreignRelease: true })
    await expect(serviceFor(releaseRace.executor).create(input)).rejects.toMatchObject({
      code: 'release_create_conflict',
    })
    expect(releaseRace.state.release).toMatchObject({ body: 'foreign', id: 11 })
    expect(releaseRace.state.reference).toEqual({ oid: releaseRace.state.tagObjectOid, type: 'tag' })
    expect(releaseRace.executor.action).not.toHaveBeenCalled()
  })

  it('removes its owned release but preserves a replacement tag after publication', async () => {
    const { executor, state } = creationFixture({ moveOnReferenceRead: 3 })

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: 'release_target_changed',
    })
    expect(state.release).toBeNull()
    expect(state.reference).toEqual({ oid: BASE_RELEASE_SHA, type: 'commit' })
    expect(executor.action).toHaveBeenCalledWith([
      'api', 'repos/owner/repo/releases/10', '--method', 'DELETE',
    ])
    expect(executor.action).not.toHaveBeenCalledWith([
      'api', 'repos/owner/repo/git/refs/tags/v1.2.4', '--method', 'DELETE',
    ])
  })

  it('freshly fails closed instead of authorizing from cached or stale open-pull data', async () => {
    const { executor } = creationFixture()
    const loadOpenPulls = vi.fn(async ({ refresh }) => refresh
      ? { ...openSnapshot(), stale: true }
      : openSnapshot())
    const service = serviceFor(executor, { loadOpenPulls })
    await service.getOptions()

    await expect(service.create(input)).rejects.toMatchObject({ code: 'repository_not_allowed' })
    expect(loadOpenPulls).toHaveBeenLastCalledWith({ refresh: true })
    expect(executor.rest.mock.calls.some(([endpoint, options]) =>
      endpoint === 'repos/owner/repo/git/tags' && options?.method === 'POST')).toBe(false)
  })

  it('freshly authorizes a repository proven by an authored merge in the last 90 days', async () => {
    const { executor } = creationFixture()
    const service = serviceFor(executor, {
      loadMergedPulls: async () => ({ incomplete: false, items: [mergedItem()] }),
      loadOpenPulls: async () => ({ ...openSnapshot(), stale: true }),
    })

    await expect(service.create(input)).resolves.toMatchObject({ id: '10' })
  })

  it('detects latest-tag races before creating any remote release state', async () => {
    const { executor, state } = creationFixture({ baseTags: ['v1.2.4'] })
    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({ code: 'release_base_changed' })
    expect(state.reference).toBeNull()
    expect(state.release).toBeNull()
  })

  it('rejects an exact duplicate tag even when it is outside the preview', async () => {
    const duplicate = 'archive-duplicate'
    const baseTags = [
      'v1.2.3',
      ...Array.from({ length: 12 }, (_, index) => `release-${index + 1}`),
      duplicate,
    ]
    const { executor, state } = creationFixture({ baseTags })
    const service = serviceFor(executor)
    const options = await service.getOptions()

    expect(options.repositories[0].previousTags).toHaveLength(10)
    expect(options.repositories[0].previousTags).not.toContain(duplicate)
    await expect(service.create({
      expectedLatestTag: 'v1.2.3',
      repository: 'owner/repo',
      tag: duplicate,
    })).rejects.toMatchObject({ code: 'tag_exists' })
    expect(state.reference).toBeNull()
    expect(state.release).toBeNull()
    expect(executor.rest.mock.calls.some(([endpoint, options]) =>
      endpoint === 'repos/owner/repo/git/tags' && options?.method === 'POST')).toBe(false)
  })

  it('deduplicates repository release creation before the first GitHub await', async () => {
    let releaseViewer
    const waiting = new Promise((resolve) => { releaseViewer = resolve })
    const { executor } = creationFixture()
    const original = executor.rest
    executor.rest = vi.fn(async (...argumentsList) => {
      if (argumentsList[0] === 'user') await waiting
      return original(...argumentsList)
    })
    const service = serviceFor(executor)
    const first = service.create(input)
    await expect(service.create(input)).rejects.toMatchObject({ code: 'release_running' })
    releaseViewer()
    await first
  })
})
