import { ExecutorError } from './executor.mjs'

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[a-f0-9]{40}$/i
const DECIMAL = /^[1-9]\d{0,19}$/
const CONCURRENCY_LIMIT = 3

export const MAX_LOG_BYTES = 16 * 1024 * 1024
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024

const ERRORS = {
  invalid_head: {
    message: 'The pull request head is invalid.',
    status: 400,
  },
  invalid_identity: {
    message: 'The check run identity is invalid.',
    status: 400,
  },
  invalid_number: {
    message: 'The pull request number is invalid.',
    status: 400,
  },
  invalid_repository: {
    message: 'The repository is invalid.',
    status: 400,
  },
  logs_unavailable: {
    message: 'GitHub could not load the failed check logs.',
    status: 502,
  },
  not_found: {
    message: 'Failed check logs were not found.',
    status: 404,
  },
  pull_unavailable: {
    message: 'A complete fresh pull request check is required to load logs.',
    status: 503,
  },
}

export class CheckLogsError extends Error {
  constructor(code) {
    const detail = ERRORS[code] ?? ERRORS.logs_unavailable
    super(detail.message)
    this.name = 'CheckLogsError'
    this.code = code in ERRORS ? code : 'logs_unavailable'
    this.status = detail.status
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAbortSignal(value) {
  return value !== null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function optionalSignal(value) {
  if (value === undefined) return undefined
  const signal = isRecord(value) && Object.hasOwn(value, 'signal') ? value.signal : value
  if (!isAbortSignal(signal)) throw new TypeError('signal must be an AbortSignal.')
  return signal
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function raceAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(abortError(signal))

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function canonicalRepository(value) {
  if (
    typeof value !== 'string' ||
    !REPOSITORY.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new CheckLogsError('invalid_repository')
  }
  return value
}

function canonicalSha(value, code) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new CheckLogsError(code)
  }
  return value.toLowerCase()
}

function canonicalDecimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new CheckLogsError('invalid_identity')
  }
  return value
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`)
  }
  return value
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`)
  }
  return value
}

export function validateCheckLogsInput(value) {
  if (!isRecord(value)) throw new CheckLogsError('invalid_identity')
  const repository = canonicalRepository(value.repository)
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new CheckLogsError('invalid_number')
  }

  return {
    baseRefOid: canonicalSha(value.baseRefOid, 'invalid_head'),
    headRefOid: canonicalSha(value.headRefOid, 'invalid_head'),
    jobId: canonicalDecimal(value.jobId),
    number: value.number,
    repository,
    runId: canonicalDecimal(value.runId),
  }
}

function canonicalJobUrl(repository, runId, jobId) {
  return `https://github.com/${repository}/actions/runs/${runId}/job/${jobId}`
}

function isExactJobUrl(value, repository, runId, jobId) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname.toLowerCase() ===
        new URL(canonicalJobUrl(repository, runId, jobId)).pathname.toLowerCase()
  } catch {
    return false
  }
}

function authorizationRequest(input, expectedViewerLogin) {
  const request = {
    expectedBaseRefOid: input.baseRefOid,
    expectedHeadRefOid: input.headRefOid,
    jobId: input.jobId,
    number: input.number,
    repository: input.repository,
    runId: input.runId,
  }
  if (expectedViewerLogin !== null) request.expectedViewerLogin = expectedViewerLogin
  return request
}

function authorizationError(error) {
  if (error?.name === 'AbortError') return error
  if (error?.code === 'not_found' || error?.code === 'stale') {
    return new CheckLogsError('not_found')
  }
  if (error?.code === 'invalid') return new CheckLogsError('invalid_identity')
  return new CheckLogsError('pull_unavailable')
}

function validateAuthorization(value, input, expectedViewerLogin) {
  if (
    !isRecord(value) ||
    typeof value.viewerLogin !== 'string' ||
    value.viewerLogin.trim() === '' ||
    typeof value.repository !== 'string' ||
    typeof value.baseRefOid !== 'string' ||
    !SHA.test(value.baseRefOid) ||
    typeof value.headRefOid !== 'string' ||
    !SHA.test(value.headRefOid) ||
    typeof value.checkId !== 'string' ||
    value.checkId === '' ||
    typeof value.runId !== 'string' ||
    typeof value.jobId !== 'string'
  ) {
    throw new CheckLogsError('pull_unavailable')
  }

  const viewerLogin = value.viewerLogin.trim()
  if (
    (expectedViewerLogin !== null &&
      viewerLogin.toLowerCase() !== expectedViewerLogin.toLowerCase()) ||
    value.repository.toLowerCase() !== input.repository.toLowerCase() ||
    value.number !== input.number ||
    value.baseRefOid.toLowerCase() !== input.baseRefOid ||
    value.headRefOid.toLowerCase() !== input.headRefOid ||
    value.runId !== input.runId ||
    value.jobId !== input.jobId
  ) {
    throw new CheckLogsError('not_found')
  }

  return {
    repository: value.repository,
    viewerLogin,
  }
}

async function authorize(authorizer, input, expectedViewerLogin, signal) {
  throwIfAborted(signal)
  try {
    const proof = await raceAbort(
      Promise.resolve().then(() =>
        signal === undefined
          ? authorizer.authorizeFailedCheck(
              authorizationRequest(input, expectedViewerLogin),
            )
          : authorizer.authorizeFailedCheck(
              authorizationRequest(input, expectedViewerLogin),
              signal,
            )),
      signal,
    )
    throwIfAborted(signal)
    return validateAuthorization(proof, input, expectedViewerLogin)
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    throw authorizationError(error)
  }
}

function metadataDecimal(value) {
  if (typeof value === 'string' && DECIMAL.test(value)) return value
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null
}

function validateJobMetadata(value, input) {
  const jobId = metadataDecimal(value?.id)
  const runId = metadataDecimal(value?.run_id)
  if (
    !isRecord(value) ||
    jobId === null ||
    runId === null ||
    typeof value.head_sha !== 'string' ||
    !SHA.test(value.head_sha) ||
    typeof value.conclusion !== 'string' ||
    typeof value.html_url !== 'string'
  ) {
    throw new CheckLogsError('logs_unavailable')
  }

  if (
    jobId !== input.jobId ||
    runId !== input.runId ||
    value.head_sha.toLowerCase() !== input.headRefOid ||
    value.conclusion !== 'failure' ||
    !isExactJobUrl(value.html_url, input.repository, input.runId, input.jobId)
  ) {
    throw new CheckLogsError('not_found')
  }
}

export function sanitizeCheckLog(value) {
  if (typeof value !== 'string') throw new CheckLogsError('logs_unavailable')
  return value
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

function downloadError(error, signal) {
  if (signal.aborted) return abortError(signal)
  if (error?.name === 'AbortError') return error
  if (error instanceof CheckLogsError || error instanceof ExecutorError) return error
  return new CheckLogsError('logs_unavailable')
}

async function download(executor, input, signal, logBytes) {
  const [owner, name] = input.repository.split('/')
  const jobEndpoint = `repos/${owner}/${name}/actions/jobs/${input.jobId}`

  try {
    throwIfAborted(signal)
    const metadata = await executor.rest(jobEndpoint, { signal })
    throwIfAborted(signal)
    validateJobMetadata(metadata, input)
    const output = await executor.output(['api', `${jobEndpoint}/logs`], { signal })
    throwIfAborted(signal)
    if (Buffer.byteLength(output, 'utf8') > logBytes) {
      throw new ExecutorError('output_limit')
    }
    return sanitizeCheckLog(output)
  } catch (error) {
    throw downloadError(error, signal)
  }
}

function createLimiter(limit) {
  let active = 0
  const waiting = []

  const start = (entry) => {
    entry.dispose()
    active += 1
    Promise.resolve()
      .then(entry.operation)
      .then(
        (value) => {
          active -= 1
          entry.resolve(value)
          drain()
        },
        (error) => {
          active -= 1
          entry.reject(error)
          drain()
        },
      )
  }

  const drain = () => {
    while (active < limit && waiting.length > 0) {
      const entry = waiting.shift()
      if (entry.signal?.aborted) {
        entry.dispose()
        entry.reject(abortError(entry.signal))
        continue
      }
      start(entry)
    }
  }

  return function limited(operation, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal))

    return new Promise((resolve, reject) => {
      const entry = {
        dispose: () => undefined,
        operation,
        reject,
        resolve,
        signal,
      }
      const abort = () => {
        const index = waiting.indexOf(entry)
        if (index === -1) return
        waiting.splice(index, 1)
        entry.dispose()
        reject(abortError(signal))
      }
      entry.dispose = () => signal?.removeEventListener('abort', abort)

      if (active < limit) {
        start(entry)
        return
      }
      waiting.push(entry)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}

function downloadKey(input) {
  return JSON.stringify([
    input.repository.toLowerCase(),
    input.number,
    input.baseRefOid,
    input.headRefOid,
    input.runId,
    input.jobId,
  ])
}

function cacheKey(input, viewerLogin) {
  return JSON.stringify([viewerLogin.toLowerCase(), downloadKey(input)])
}

function createCache(limit) {
  const entries = new Map()
  let bytes = 0

  return {
    get(key) {
      const cached = entries.get(key)
      if (!cached) return null
      entries.delete(key)
      entries.set(key, cached)
      return cached.value
    },
    set(key, value) {
      const size = Buffer.byteLength(key, 'utf8') +
        Buffer.byteLength(JSON.stringify(value), 'utf8')
      const current = entries.get(key)
      if (current) {
        bytes -= current.size
        entries.delete(key)
      }
      if (size > limit) return

      entries.set(key, { size, value })
      bytes += size
      while (bytes > limit) {
        const oldest = entries.entries().next().value
        if (!oldest) break
        entries.delete(oldest[0])
        bytes -= oldest[1].size
      }
    },
  }
}

export function createCheckLogsService({
  authorizer,
  cacheBytes = DEFAULT_CACHE_BYTES,
  executor,
  logBytes = MAX_LOG_BYTES,
  now = Date.now,
} = {}) {
  if (!authorizer || typeof authorizer.authorizeFailedCheck !== 'function') {
    throw new TypeError('A failed check authorizer is required.')
  }
  if (
    !executor ||
    typeof executor.output !== 'function' ||
    typeof executor.rest !== 'function'
  ) {
    throw new TypeError('A GitHub executor with REST and output support is required.')
  }
  nonNegativeInteger(cacheBytes, 'cacheBytes')
  positiveInteger(logBytes, 'logBytes')
  if (typeof now !== 'function') throw new TypeError('now must be a function.')

  const cache = createCache(cacheBytes)
  const inflight = new Map()
  const limitDownload = createLimiter(CONCURRENCY_LIMIT)

  function createDownload(key, input) {
    const controller = new AbortController()
    const record = {
      controller,
      failed: false,
      settled: false,
      waiters: 0,
    }
    record.promise = limitDownload(
      () => download(executor, input, controller.signal, logBytes),
      controller.signal,
    )
    record.promise.then(
      () => {
        record.settled = true
        if (record.waiters === 0 && inflight.get(key) === record) inflight.delete(key)
      },
      () => {
        record.failed = true
        record.settled = true
        if (inflight.get(key) === record) inflight.delete(key)
      },
    )
    return record
  }

  function release(key, record) {
    record.waiters -= 1
    if (record.waiters !== 0) return
    if (!record.settled && !record.controller.signal.aborted) record.controller.abort()
    if ((record.settled || record.failed) && inflight.get(key) === record) {
      inflight.delete(key)
    }
  }

  return Object.freeze({
    async load(value, signalOrOptions) {
      const input = validateCheckLogsInput(value)
      const signal = optionalSignal(signalOrOptions)
      throwIfAborted(signal)

      const initial = await authorize(authorizer, input, null, signal)
      const key = cacheKey(input, initial.viewerLogin)
      const cached = cache.get(key)
      if (cached) return { ...cached, cached: true }

      const requestKey = downloadKey(input)
      let record = inflight.get(requestKey)
      if (record?.controller.signal.aborted) {
        if (inflight.get(requestKey) === record) inflight.delete(requestKey)
        record = undefined
      }
      if (!record) {
        record = createDownload(requestKey, input)
        inflight.set(requestKey, record)
      }
      record.waiters += 1

      try {
        const log = await raceAbort(record.promise, signal)
        const current = await authorize(
          authorizer,
          input,
          initial.viewerLogin,
          signal,
        )
        throwIfAborted(signal)
        const entry = {
          cached: false,
          fetchedAt: new Date(now()).toISOString(),
          headRefOid: input.headRefOid,
          jobId: input.jobId,
          log,
          number: input.number,
          repository: current.repository,
          runId: input.runId,
        }
        cache.set(key, entry)
        return { ...entry }
      } finally {
        release(requestKey, record)
      }
    },
  })
}
