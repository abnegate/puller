import { describe, expect, it, vi } from 'vitest'

import {
  AuthorizationError,
  createArtifactAuthorizer,
} from '../authorization.mjs'

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const BASE = '1234567890abcdef1234567890abcdef12345678'
const NEXT = 'fedcba9876543210fedcba9876543210fedcba98'

function pull(overrides = {}) {
  return {
    baseRefOid: BASE,
    headRefOid: HEAD,
    number: 7,
    repository: 'example/repo',
    url: 'https://github.com/example/repo/pull/7',
    ...overrides,
  }
}

function snapshot(overrides = {}) {
  return {
    expired: false,
    notReady: [pull()],
    partial: false,
    ready: [],
    stale: false,
    viewerLogin: 'viewer',
    ...overrides,
  }
}

function proof(overrides = {}) {
  return {
    authored: true,
    authorLogin: 'copilot-swe-agent',
    available: true,
    baseRefOid: BASE,
    complete: true,
    headRefOid: HEAD,
    number: 7,
    open: true,
    repository: 'example/repo',
    state: 'OPEN',
    url: 'https://github.com/example/repo/pull/7',
    viewerLogin: 'viewer',
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    number: 7,
    repository: 'example/repo',
    ...overrides,
  }
}

function checkProof(overrides = {}) {
  return proof({
    checksComplete: true,
    failedChecks: [{
      checkId: 'check-701',
      detailsUrl: 'https://github.com/example/repo/actions/runs/700/job/701',
      jobId: '701',
      name: 'Test',
      runId: '700',
    }],
    ...overrides,
  })
}

function authorizer({ current = snapshot(), loadCheck, loadPull } = {}) {
  return createArtifactAuthorizer({
    loadCheckAuthorization: loadCheck ?? vi.fn(async () => checkProof()),
    loadPullAuthorization: loadPull ?? vi.fn(async () => proof()),
    peek: () => current,
  })
}

describe('artifact authorization', () => {
  it('requires a fresh targeted proof after the snapshot fast-deny', async () => {
    const loadPull = vi.fn(async () => proof())
    const service = authorizer({ loadPull })

    await expect(service.authorizePull(input())).resolves.toMatchObject({
      authorLogin: 'copilot-swe-agent',
      baseRefOid: BASE,
      headRefOid: HEAD,
      viewerLogin: 'viewer',
    })
    expect(loadPull).toHaveBeenCalledOnce()
  })

  it('refreshes an expired complete snapshot through the targeted pull proof', async () => {
    const loadPull = vi.fn(async () => proof())
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadPull,
    })

    await expect(service.authorizePull(input())).resolves.toMatchObject({
      authorLogin: 'copilot-swe-agent',
      baseRefOid: BASE,
      headRefOid: HEAD,
      viewerLogin: 'viewer',
    })
    expect(loadPull).toHaveBeenCalledOnce()
  })

  it('forwards the caller signal to targeted pull and failed-check proofs', async () => {
    const loadCheck = vi.fn(async () => checkProof())
    const loadPull = vi.fn(async () => proof())
    const service = authorizer({ loadCheck, loadPull })
    const controller = new AbortController()

    await service.authorizePull(input(), controller.signal)
    await service.authorizeFailedCheck({
      ...input(),
      jobId: '701',
      runId: '700',
    }, controller.signal)

    expect(loadPull).toHaveBeenCalledWith({
      number: 7,
      repository: 'example/repo',
    }, controller.signal)
    expect(loadCheck).toHaveBeenCalledWith({
      number: 7,
      repository: 'example/repo',
    }, controller.signal)
  })

  it.each([
    ['missing', null],
    ['missing expiry metadata', snapshot({ expired: undefined })],
    ['malformed expiry metadata', snapshot({ expired: 'false' })],
    ['stale', snapshot({ stale: true })],
    ['partial', snapshot({ partial: true })],
    ['missing viewer', snapshot({ viewerLogin: null })],
    ['malformed ready list', snapshot({ ready: null })],
    ['malformed not-ready list', snapshot({ notReady: null })],
  ])('does not authorize from a %s snapshot', async (_label, current) => {
    const loadPull = vi.fn(async () => proof())
    const service = authorizer({ current, loadPull })

    await expect(service.authorizePull(input())).rejects.toMatchObject({
      code: 'snapshot_unavailable',
    })
    expect(loadPull).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'false'],
  ])('fast-denies failed-check authorization with %s expiry metadata', async (_label, expired) => {
    const loadCheck = vi.fn(async () => checkProof())
    const service = authorizer({
      current: snapshot({ expired }),
      loadCheck,
    })

    await expect(service.authorizeFailedCheck({
      ...input(),
      jobId: '701',
      runId: '700',
    })).rejects.toMatchObject({ code: 'snapshot_unavailable' })
    expect(loadCheck).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing pull',
      snapshot({ expired: true, notReady: [] }),
      input(),
      'not_found',
    ],
    [
      'duplicate pull',
      snapshot({ expired: true, ready: [pull()] }),
      input(),
      'not_found',
    ],
    [
      'foreign pull URL',
      snapshot({
        expired: true,
        notReady: [pull({ url: 'https://github.com/example/other/pull/7' })],
      }),
      input(),
      'snapshot_unavailable',
    ],
    [
      'malformed base identity',
      snapshot({ expired: true, notReady: [pull({ baseRefOid: 'invalid' })] }),
      input(),
      'snapshot_unavailable',
    ],
    [
      'malformed head identity',
      snapshot({ expired: true, notReady: [pull({ headRefOid: 'invalid' })] }),
      input(),
      'snapshot_unavailable',
    ],
    [
      'base identity mismatch',
      snapshot({ expired: true }),
      input({ expectedBaseRefOid: NEXT }),
      'stale',
    ],
    [
      'head identity mismatch',
      snapshot({ expired: true }),
      input({ expectedHeadRefOid: NEXT }),
      'stale',
    ],
    [
      'viewer identity mismatch',
      snapshot({ expired: true }),
      input({ expectedViewerLogin: 'other-viewer' }),
      'not_found',
    ],
  ])('fast-denies an expired snapshot with a %s', async (_label, current, value, code) => {
    const loadPull = vi.fn(async () => proof())
    const service = authorizer({ current, loadPull })

    await expect(service.authorizePull(value)).rejects.toMatchObject({ code })
    expect(loadPull).not.toHaveBeenCalled()
  })

  it('rejects an account switch even when pull identity is unchanged', async () => {
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadPull: vi.fn(async () => proof({ viewerLogin: 'other-viewer' })),
    })

    await expect(service.authorizePull(input())).rejects.toMatchObject({ code: 'not_found' })
  })

  it.each([
    ['authored membership removal', { authored: false }],
    ['pull unavailability', { available: false }],
  ])('rejects fresh %s with an unchanged head', async (_label, change) => {
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadPull: vi.fn(async () => proof(change)),
    })

    await expect(service.authorizePull(input())).rejects.toMatchObject({ code: 'not_found' })
  })

  it.each([
    ['closure', { open: false, state: 'CLOSED' }, 'stale'],
    ['foreign URL', { url: 'https://github.com/example/other/pull/7' }, 'incomplete'],
    ['base drift', { baseRefOid: NEXT }, 'stale'],
    ['head drift', { headRefOid: NEXT }, 'stale'],
  ])('fails closed for %s', async (_label, change, code) => {
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadPull: vi.fn(async () => proof(change)),
    })

    await expect(service.authorizePull(input())).rejects.toMatchObject({ code })
  })

  it('does not share settled or simultaneous authorization calls', async () => {
    const releases = []
    const loadPull = vi.fn(() => new Promise((resolve) => {
      releases.push(() => resolve(proof()))
    }))
    const service = authorizer({ loadPull })

    const first = service.authorizePull(input())
    const second = service.authorizePull(input())
    expect(loadPull).toHaveBeenCalledTimes(2)
    for (const release of releases.splice(0)) release()
    await Promise.all([first, second])
    const third = service.authorizePull(input())
    expect(loadPull).toHaveBeenCalledTimes(3)
    for (const release of releases.splice(0)) release()
    await third
  })

  it('authorizes only the exact current failed run and job association', async () => {
    const loadCheck = vi.fn(async () => checkProof())
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadCheck,
    })
    await expect(service.authorizeFailedCheck({
      ...input(),
      jobId: '701',
      runId: '700',
    })).resolves.toMatchObject({ checkId: 'check-701', jobId: '701', runId: '700' })
    expect(loadCheck).toHaveBeenCalledOnce()
  })

  it.each([
    ['different job on the same head', checkProof({ failedChecks: [{
      checkId: 'check-702',
      detailsUrl: 'https://github.com/example/repo/actions/runs/700/job/702',
      jobId: '702',
      name: 'Other',
      runId: '700',
    }] })],
    ['stale rerun', checkProof({ failedChecks: [{
      checkId: 'check-801',
      detailsUrl: 'https://github.com/example/repo/actions/runs/800/job/801',
      jobId: '801',
      name: 'Rerun',
      runId: '800',
    }] })],
    ['removed rollup job', checkProof({ failedChecks: [] })],
  ])('rejects a %s', async (_label, currentProof) => {
    const service = authorizer({
      current: snapshot({ expired: true }),
      loadCheck: vi.fn(async () => currentProof),
    })

    await expect(service.authorizeFailedCheck({
      ...input(),
      jobId: '701',
      runId: '700',
    })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects incomplete current check evidence', async () => {
    const service = authorizer({
      loadCheck: vi.fn(async () => checkProof({ checksComplete: false, complete: false })),
    })

    await expect(service.authorizeFailedCheck({
      ...input(),
      jobId: '701',
      runId: '700',
    })).rejects.toBeInstanceOf(AuthorizationError)
  })
})
