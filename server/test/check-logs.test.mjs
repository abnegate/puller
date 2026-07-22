import { describe, expect, it, vi } from 'vitest'

import {
  CheckLogsError,
  createCheckLogsService,
  sanitizeCheckLog,
  validateCheckLogsInput,
} from '../check-logs.mjs'

const BASE = '1234567890abcdef1234567890abcdef12345678'
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const OTHER_BASE = 'fedcba9876543210fedcba9876543210fedcba98'
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234567'
const REPOSITORY = 'owner/repo'
const NUMBER = 7
const RUN = '123456789'
const JOB = '987654321'

function jobUrl(jobId = JOB, runId = RUN, repository = REPOSITORY) {
  return `https://github.com/${repository}/actions/runs/${runId}/job/${jobId}`
}

function request(overrides = {}) {
  return {
    baseRefOid: BASE,
    headRefOid: HEAD,
    jobId: JOB,
    number: NUMBER,
    repository: REPOSITORY,
    runId: RUN,
    ...overrides,
  }
}

function authorization(input = {}, overrides = {}) {
  const repository = input.repository ?? REPOSITORY
  const number = input.number ?? NUMBER
  return {
    authorLogin: 'delegated-author',
    baseRefOid: input.expectedBaseRefOid ?? BASE,
    checkId: 'check-1',
    headRefOid: input.expectedHeadRefOid ?? HEAD,
    jobId: input.jobId ?? JOB,
    number,
    repository,
    runId: input.runId ?? RUN,
    url: `https://github.com/${repository}/pull/${number}`,
    viewerLogin: input.expectedViewerLogin ?? 'viewer',
    ...overrides,
  }
}

function metadata(overrides = {}) {
  return {
    conclusion: 'failure',
    head_sha: HEAD,
    html_url: jobUrl(),
    id: Number(JOB),
    run_id: Number(RUN),
    ...overrides,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function service(overrides = {}) {
  const authorizer = overrides.authorizer ?? {
    authorizeFailedCheck: vi.fn(async (input) => authorization(input)),
  }
  const executor = overrides.executor ?? {
    output: vi.fn(async () => 'failed log'),
    rest: vi.fn(async () => metadata()),
  }
  return {
    authorizer,
    executor,
    value: createCheckLogsService({
      authorizer,
      cacheBytes: overrides.cacheBytes,
      executor,
      logBytes: overrides.logBytes,
      now: overrides.now ?? (() => Date.parse('2026-07-21T05:00:00.000Z')),
    }),
  }
}

function rejectedAuthorization(code) {
  return Object.assign(new Error('private authorization detail'), { code })
}

describe('failed check log service', () => {
  it('proves the exact job before and after a direct REST metadata and log download', async () => {
    const context = service({
      executor: {
        output: vi.fn(async () => '\u001b[31méchec\u001b[0m\0\r\nnext\tline\u0007'),
        rest: vi.fn(async () => metadata()),
      },
    })

    const controller = new AbortController()
    await expect(context.value.load(request(), controller.signal)).resolves.toEqual({
      cached: false,
      fetchedAt: '2026-07-21T05:00:00.000Z',
      headRefOid: HEAD,
      jobId: JOB,
      log: 'échec\nnext\tline',
      number: NUMBER,
      repository: REPOSITORY,
      runId: RUN,
    })
    expect(context.authorizer.authorizeFailedCheck).toHaveBeenNthCalledWith(1, {
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      jobId: JOB,
      number: NUMBER,
      repository: REPOSITORY,
      runId: RUN,
    }, controller.signal)
    expect(context.authorizer.authorizeFailedCheck).toHaveBeenNthCalledWith(2, {
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      expectedViewerLogin: 'viewer',
      jobId: JOB,
      number: NUMBER,
      repository: REPOSITORY,
      runId: RUN,
    }, controller.signal)
    expect(context.executor.rest).toHaveBeenCalledWith(
      `repos/owner/repo/actions/jobs/${JOB}`,
      { signal: expect.any(AbortSignal) },
    )
    expect(context.executor.output).toHaveBeenCalledWith(
      ['api', `repos/owner/repo/actions/jobs/${JOB}/logs`],
      { signal: expect.any(AbortSignal) },
    )
    expect(context.executor.output.mock.calls.flat()).not.toContain('run')
    expect(context.executor.rest.mock.calls[0][1].signal).not.toBe(controller.signal)
    expect(context.executor.output.mock.calls[0][1].signal).not.toBe(controller.signal)
  })

  it('aborts pre-authorization with the caller reason before starting log work', async () => {
    let authorizationSignal
    const authorizer = {
      authorizeFailedCheck: vi.fn((_value, signal) =>
        new Promise((_resolve, reject) => {
          authorizationSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })),
    }
    const executor = {
      output: vi.fn(async () => 'must not run'),
      rest: vi.fn(async () => metadata()),
    }
    const context = service({ authorizer, executor })
    const controller = new AbortController()
    const reason = new DOMException('Client disconnected.', 'AbortError')

    const pending = context.value.load(request(), controller.signal)
    const result = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(authorizer.authorizeFailedCheck).toHaveBeenCalledOnce())
    controller.abort(reason)

    await result
    expect(authorizationSignal).toBe(controller.signal)
    expect(executor.rest).not.toHaveBeenCalled()
    expect(executor.output).not.toHaveBeenCalled()
  })

  it('freshly authorizes cache hits without repeating metadata or log downloads', async () => {
    const context = service()

    await context.value.load(request())
    await expect(context.value.load(request())).resolves.toMatchObject({
      cached: true,
      log: 'failed log',
    })

    expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(3)
    expect(context.executor.rest).toHaveBeenCalledOnce()
    expect(context.executor.output).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing membership', 'not_found', 'not_found', 404],
    ['identity drift', 'stale', 'not_found', 404],
    ['incomplete evidence', 'incomplete', 'pull_unavailable', 503],
    ['missing snapshot', 'snapshot_unavailable', 'pull_unavailable', 503],
  ])('maps %s authorization failures to the public contract', async (_label, failure, code, status) => {
    const context = service({
      authorizer: {
        authorizeFailedCheck: vi.fn(async () => {
          throw rejectedAuthorization(failure)
        }),
      },
    })

    const error = await context.value.load(request()).catch((value) => value)
    expect(error).toBeInstanceOf(CheckLogsError)
    expect(error).toMatchObject({ code, status })
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('private authorization detail')
    expect(context.executor.rest).not.toHaveBeenCalled()
    expect(context.executor.output).not.toHaveBeenCalled()
  })

  it.each([
    ['body', null],
    ['job id', { id: {} }],
    ['run id', { run_id: null }],
    ['head', { head_sha: null }],
    ['conclusion', { conclusion: null }],
    ['URL', { html_url: null }],
  ])('rejects malformed %s metadata as unavailable', async (_label, change) => {
    const context = service({
      executor: {
        output: vi.fn(async () => 'must not run'),
        rest: vi.fn(async () => change === null ? null : metadata(change)),
      },
    })

    await expect(context.value.load(request())).rejects.toMatchObject({
      code: 'logs_unavailable',
      status: 502,
    })
    expect(context.executor.output).not.toHaveBeenCalled()
  })

  it.each([
    ['job id', { id: Number(JOB) + 1 }],
    ['run id', { run_id: Number(RUN) + 1 }],
    ['head', { head_sha: OTHER_HEAD }],
    ['conclusion', { conclusion: 'success' }],
    ['repository URL', { html_url: jobUrl(JOB, RUN, 'other/repo') }],
    ['URL query', { html_url: `${jobUrl()}?attempt=1` }],
  ])('rejects mismatched %s metadata before downloading logs', async (_label, change) => {
    const context = service({
      executor: {
        output: vi.fn(async () => 'must not run'),
        rest: vi.fn(async () => metadata(change)),
      },
    })

    await expect(context.value.load(request())).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
    expect(context.executor.output).not.toHaveBeenCalled()
  })

  it('rejects a same-repository and same-head job from another workflow run', async () => {
    const context = service({
      executor: {
        output: vi.fn(async () => 'must not run'),
        rest: vi.fn(async () => metadata({
          html_url: jobUrl(JOB, '444444444'),
          run_id: 444444444,
        })),
      },
    })

    await expect(context.value.load(request())).rejects.toMatchObject({ code: 'not_found' })
    expect(context.executor.output).not.toHaveBeenCalled()
  })

  it('does not return or cache bytes when the failed job leaves the rollup after download', async () => {
    let calls = 0
    const authorizer = {
      authorizeFailedCheck: vi.fn(async (input) => {
        calls += 1
        if (calls === 2) throw rejectedAuthorization('not_found')
        return authorization(input)
      }),
    }
    const context = service({ authorizer })

    await expect(context.value.load(request())).rejects.toMatchObject({ code: 'not_found' })
    await expect(context.value.load(request())).resolves.toMatchObject({
      cached: false,
      log: 'failed log',
    })
    expect(context.executor.output).toHaveBeenCalledTimes(2)
  })

  it('coalesces one metadata and byte download while every caller gets independent proofs', async () => {
    const pending = deferred()
    const context = service({
      executor: {
        output: vi.fn(() => pending.promise),
        rest: vi.fn(async () => metadata()),
      },
    })
    const loads = Array.from({ length: 4 }, () => context.value.load(request()))

    await vi.waitFor(() => expect(context.executor.output).toHaveBeenCalledOnce())
    pending.resolve('one download')

    const values = await Promise.all(loads)
    expect(values).toHaveLength(4)
    expect(values.every(({ cached, log }) => !cached && log === 'one download')).toBe(true)
    expect(context.executor.rest).toHaveBeenCalledOnce()
    expect(context.executor.output).toHaveBeenCalledOnce()
    expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(8)
  })

  it('coalesces identical data downloads independently of the viewer-scoped cache', async () => {
    const pending = deferred()
    let authorizationCalls = 0
    const context = service({
      authorizer: {
        authorizeFailedCheck: vi.fn(async (input) => {
          authorizationCalls += 1
          const viewerLogin = authorizationCalls % 2 === 1 ? 'first-viewer' : 'second-viewer'
          return authorization(input, { viewerLogin })
        }),
      },
      executor: {
        output: vi.fn(() => pending.promise),
        rest: vi.fn(async () => metadata()),
      },
    })

    const first = context.value.load(request())
    const second = context.value.load(request())
    await vi.waitFor(() => expect(context.executor.output).toHaveBeenCalledOnce())
    pending.resolve('shared viewers')

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(context.executor.rest).toHaveBeenCalledOnce()
    expect(context.executor.output).toHaveBeenCalledOnce()
  })

  it('detaches one aborted waiter without cancelling the shared child', async () => {
    const pending = deferred()
    let sharedSignal
    const context = service({
      executor: {
        output: vi.fn((_arguments, { signal }) => {
          sharedSignal = signal
          signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
          return pending.promise
        }),
        rest: vi.fn(async () => metadata()),
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = context.value.load(request(), firstController.signal)
    const second = context.value.load(request(), secondController.signal)

    await vi.waitFor(() => expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(context.executor.output).toHaveBeenCalledOnce())
    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(false)
    pending.resolve('surviving log')
    await expect(second).resolves.toMatchObject({ log: 'surviving log' })
    expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(3)
  })

  it('aborts the shared child only after the final waiter detaches', async () => {
    const pending = deferred()
    let sharedSignal
    const context = service({
      executor: {
        output: vi.fn((_arguments, { signal }) => {
          sharedSignal = signal
          signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
          return pending.promise
        }),
        rest: vi.fn(async () => metadata()),
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = context.value.load(request(), { signal: firstController.signal })
    const second = context.value.load(request(), { signal: secondController.signal })

    await vi.waitFor(() => expect(context.executor.output).toHaveBeenCalledOnce())
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(false)
    secondController.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(true)
  })

  it('never attaches a later authorized caller to an abandoned aborted download', async () => {
    const secondAuthorization = deferred()
    const abandoned = deferred()
    let authorizationCalls = 0
    let abandonedSignal
    const context = service({
      authorizer: {
        authorizeFailedCheck: vi.fn(async (input) => {
          authorizationCalls += 1
          if (authorizationCalls === 2) await secondAuthorization.promise
          return authorization(input)
        }),
      },
      executor: {
        output: vi.fn((_arguments, { signal }) => {
          if (authorizationCalls === 1) {
            abandonedSignal = signal
            return abandoned.promise
          }
          return Promise.resolve('replacement log')
        }),
        rest: vi.fn(async () => metadata()),
      },
    })
    const controller = new AbortController()
    const first = context.value.load(request(), controller.signal)
    await vi.waitFor(() => expect(context.executor.output).toHaveBeenCalledOnce())
    const second = context.value.load(request())
    await vi.waitFor(() => expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(2))

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(abandonedSignal.aborted).toBe(true)
    secondAuthorization.resolve()

    await expect(second).resolves.toMatchObject({ log: 'replacement log' })
    expect(context.executor.output).toHaveBeenCalledTimes(2)
  })

  it.each(['base', 'head', 'viewer'])('does not reuse cache entries after %s identity changes', async (field) => {
    let viewerLogin = 'viewer'
    let currentHead = HEAD
    const authorizer = {
      authorizeFailedCheck: vi.fn(async (input) => authorization(input, { viewerLogin })),
    }
    const executor = {
      output: vi.fn(async () => `${field} log`),
      rest: vi.fn(async () => metadata({ head_sha: currentHead })),
    }
    const context = service({ authorizer, executor })

    await context.value.load(request())
    let next = request()
    if (field === 'base') next = request({ baseRefOid: OTHER_BASE })
    if (field === 'head') {
      currentHead = OTHER_HEAD
      next = request({ headRefOid: OTHER_HEAD })
    }
    if (field === 'viewer') viewerLogin = 'other-viewer'

    await expect(context.value.load(next)).resolves.toMatchObject({ cached: false })
    expect(executor.output).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed downloads and retries with safe errors', async () => {
    const output = vi.fn()
      .mockRejectedValueOnce(new Error('stderr ghp_secret /Users/person/repo'))
      .mockResolvedValueOnce('retry log')
    const context = service({
      executor: {
        output,
        rest: vi.fn(async () => metadata()),
      },
    })

    const failed = await context.value.load(request()).catch((value) => value)
    expect(failed).toMatchObject({ code: 'logs_unavailable', status: 502 })
    expect(`${failed.message} ${JSON.stringify(failed)}`).not.toMatch(/ghp_secret|\/Users\/person/)
    await expect(context.value.load(request())).resolves.toMatchObject({
      cached: false,
      log: 'retry log',
    })
    expect(output).toHaveBeenCalledTimes(2)
  })

  it('preserves the output byte ceiling before sanitizing or caching', async () => {
    const output = vi.fn()
      .mockResolvedValueOnce('\u001b[31mééé\u001b[0m')
      .mockResolvedValueOnce('safe')
    const context = service({
      executor: {
        output,
        rest: vi.fn(async () => metadata()),
      },
      logBytes: 5,
    })

    await expect(context.value.load(request())).rejects.toMatchObject({
      code: 'output_limit',
      status: 502,
    })
    await expect(context.value.load(request())).resolves.toMatchObject({ log: 'safe' })
    expect(output).toHaveBeenCalledTimes(2)
  })

  it('does not retain an entry larger than the configured byte-bounded cache', async () => {
    const context = service({ cacheBytes: 1 })

    await context.value.load(request())
    await context.value.load(request())

    expect(context.executor.output).toHaveBeenCalledTimes(2)
    expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(4)
  })

  it('limits distinct metadata and log downloads globally to three', async () => {
    let active = 0
    let maximum = 0
    const executor = {
      output: vi.fn(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return 'log'
      }),
      rest: vi.fn(async (endpoint) => {
        const jobId = endpoint.split('/').at(-1)
        return metadata({
          html_url: jobUrl(jobId),
          id: Number(jobId),
        })
      }),
    }
    const context = service({ executor })
    const loads = Array.from({ length: 6 }, (_, index) => {
      const jobId = String(index + 1)
      return context.value.load(request({ jobId }))
    })

    await expect(Promise.all(loads)).resolves.toHaveLength(6)
    expect(executor.output).toHaveBeenCalledTimes(6)
    expect(maximum).toBe(3)
  })

  it('removes an aborted queued download before admitting the next job', async () => {
    const gates = [deferred(), deferred(), deferred()]
    const executor = {
      output: vi.fn(async () => 'log'),
      rest: vi.fn((endpoint) => {
        const jobId = endpoint.split('/').at(-1)
        const value = metadata({
          html_url: jobUrl(jobId),
          id: Number(jobId),
        })
        return Number(jobId) <= 3
          ? gates[Number(jobId) - 1].promise.then(() => value)
          : Promise.resolve(value)
      }),
    }
    const context = service({ executor })
    const controller = new AbortController()
    const reason = new DOMException('Queued request closed.', 'AbortError')
    const active = ['1', '2', '3'].map((jobId) =>
      context.value.load(request({ jobId })))

    await vi.waitFor(() => expect(executor.rest).toHaveBeenCalledTimes(3))
    const abandoned = context.value.load(request({ jobId: '4' }), controller.signal)
    const next = context.value.load(request({ jobId: '5' }))
    await vi.waitFor(() =>
      expect(context.authorizer.authorizeFailedCheck).toHaveBeenCalledTimes(5))
    expect(executor.rest).toHaveBeenCalledTimes(3)

    controller.abort(reason)
    await expect(abandoned).rejects.toBe(reason)
    expect(executor.rest).toHaveBeenCalledTimes(3)

    gates[0].resolve()
    await vi.waitFor(() => expect(executor.rest).toHaveBeenCalledTimes(4))
    expect(executor.rest.mock.calls[3][0]).toContain('/jobs/5')
    gates[1].resolve()
    gates[2].resolve()

    await expect(Promise.all([...active, next])).resolves.toHaveLength(4)
    expect(executor.rest.mock.calls.some(([endpoint]) => endpoint.includes('/jobs/4'))).toBe(false)
  })
})

describe('failed check log validation', () => {
  it.each([
    [{ ...request(), repository: '../repo' }, 'invalid_repository'],
    [{ ...request(), number: 0 }, 'invalid_number'],
    [{ ...request(), baseRefOid: 'short' }, 'invalid_head'],
    [{ ...request(), headRefOid: 'short' }, 'invalid_head'],
    [{ ...request(), runId: '0' }, 'invalid_identity'],
    [{ ...request(), runId: '01' }, 'invalid_identity'],
    [{ ...request(), runId: '1'.repeat(21) }, 'invalid_identity'],
    [{ ...request(), runId: '1; env' }, 'invalid_identity'],
    [{ ...request(), jobId: 123 }, 'invalid_identity'],
  ])('rejects invalid input before execution', (input, code) => {
    expect(() => validateCheckLogsInput(input)).toThrowError(expect.objectContaining({ code }))
  })

  it('removes CSI, OSC, C1 controls, NUL, and unsafe controls while preserving UTF-8, tabs, and lines', () => {
    expect(sanitizeCheckLog([
      '\u001b]0;secret title\u0007',
      '\u001b[1;31méchec\u001b[0m',
      '\u009b32mgreen\u009b0m',
      'tab\tvalue\0\u0001',
    ].join('\r\n'))).toBe('\néchec\ngreen\ntab\tvalue')
  })
})
