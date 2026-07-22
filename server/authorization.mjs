const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const SHA = /^[0-9a-f]{40}$/i
const DECIMAL = /^[1-9]\d{0,19}$/

const ERRORS = {
  incomplete: [503, 'Fresh pull request authorization is incomplete.'],
  invalid: [400, 'The pull request authorization identity is invalid.'],
  not_found: [404, 'The pull request is not available to the current GitHub user.'],
  snapshot_unavailable: [503, 'A complete current authored pull request snapshot is required.'],
  stale: [409, 'The pull request identity changed.'],
}

export class AuthorizationError extends Error {
  constructor(code) {
    const [status, message] = ERRORS[code] ?? ERRORS.incomplete
    super(message)
    this.name = 'AuthorizationError'
    this.code = code in ERRORS ? code : 'incomplete'
    this.status = status
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalRepository(value) {
  if (
    typeof value !== 'string' ||
    !REPOSITORY.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new AuthorizationError('invalid')
  }
  return value
}

function canonicalSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new AuthorizationError('invalid')
  }
  return value.toLowerCase()
}

function canonicalDecimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new AuthorizationError('invalid')
  }
  return value
}

function canonicalViewer(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthorizationError('invalid')
  }
  return value.trim()
}

function pullUrl(value, repository, number) {
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
      url.pathname.toLowerCase() === `/${repository}/pull/${number}`.toLowerCase()
  } catch {
    return false
  }
}

function jobUrl(value, repository, runId, jobId) {
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
        `/${repository}/actions/runs/${runId}/job/${jobId}`.toLowerCase()
  } catch {
    return false
  }
}

function validateInput(value, failedCheck) {
  if (!isRecord(value)) throw new AuthorizationError('invalid')
  const repository = canonicalRepository(value.repository)
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new AuthorizationError('invalid')
  }

  const input = {
    expectedBaseRefOid: canonicalSha(value.expectedBaseRefOid),
    expectedHeadRefOid: canonicalSha(value.expectedHeadRefOid),
    expectedViewerLogin: canonicalViewer(value.expectedViewerLogin),
    number: value.number,
    repository,
  }
  if (!failedCheck) return input

  return {
    ...input,
    jobId: canonicalDecimal(value.jobId),
    runId: canonicalDecimal(value.runId),
  }
}

function snapshotPull(peek, input) {
  // This local snapshot can reject a request, but only the fresh proof below can authorize it.
  const snapshot = peek()
  if (
    !isRecord(snapshot) ||
    typeof snapshot.expired !== 'boolean' ||
    snapshot.stale !== false ||
    snapshot.partial !== false ||
    typeof snapshot.viewerLogin !== 'string' ||
    snapshot.viewerLogin.trim() === '' ||
    !Array.isArray(snapshot.ready) ||
    !Array.isArray(snapshot.notReady)
  ) {
    throw new AuthorizationError('snapshot_unavailable')
  }

  const viewerLogin = snapshot.viewerLogin.trim()
  if (
    input.expectedViewerLogin !== null &&
    viewerLogin.toLowerCase() !== input.expectedViewerLogin.toLowerCase()
  ) {
    throw new AuthorizationError('not_found')
  }

  const matches = [...snapshot.ready, ...snapshot.notReady].filter((pull) =>
    isRecord(pull) &&
    pull.number === input.number &&
    typeof pull.repository === 'string' &&
    pull.repository.toLowerCase() === input.repository.toLowerCase())
  if (matches.length !== 1) throw new AuthorizationError('not_found')

  const pull = matches[0]
  if (
    !pullUrl(pull.url, input.repository, input.number) ||
    typeof pull.baseRefOid !== 'string' ||
    !SHA.test(pull.baseRefOid) ||
    typeof pull.headRefOid !== 'string' ||
    !SHA.test(pull.headRefOid)
  ) {
    throw new AuthorizationError('snapshot_unavailable')
  }
  if (
    pull.baseRefOid.toLowerCase() !== input.expectedBaseRefOid ||
    pull.headRefOid.toLowerCase() !== input.expectedHeadRefOid
  ) {
    throw new AuthorizationError('stale')
  }

  return viewerLogin
}

function validateProof(proof, input, snapshotViewer) {
  if (!isRecord(proof) || proof.complete !== true) {
    throw new AuthorizationError('incomplete')
  }
  if (proof.available !== true || proof.authored !== true) {
    throw new AuthorizationError('not_found')
  }
  if (
    typeof proof.viewerLogin !== 'string' ||
    proof.viewerLogin.trim() === '' ||
    proof.viewerLogin.toLowerCase() !== snapshotViewer.toLowerCase() ||
    (input.expectedViewerLogin !== null &&
      proof.viewerLogin.toLowerCase() !== input.expectedViewerLogin.toLowerCase())
  ) {
    throw new AuthorizationError('not_found')
  }
  if (
    typeof proof.authorLogin !== 'string' ||
    proof.authorLogin.trim() === '' ||
    typeof proof.repository !== 'string' ||
    proof.repository.toLowerCase() !== input.repository.toLowerCase() ||
    proof.number !== input.number ||
    !pullUrl(proof.url, input.repository, input.number) ||
    typeof proof.baseRefOid !== 'string' ||
    !SHA.test(proof.baseRefOid) ||
    typeof proof.headRefOid !== 'string' ||
    !SHA.test(proof.headRefOid)
  ) {
    throw new AuthorizationError('incomplete')
  }
  if (
    proof.open !== true ||
    proof.state !== 'OPEN' ||
    proof.baseRefOid.toLowerCase() !== input.expectedBaseRefOid ||
    proof.headRefOid.toLowerCase() !== input.expectedHeadRefOid
  ) {
    throw new AuthorizationError('stale')
  }

  return Object.freeze({
    authorLogin: proof.authorLogin,
    baseRefOid: proof.baseRefOid.toLowerCase(),
    headRefOid: proof.headRefOid.toLowerCase(),
    number: input.number,
    repository: proof.repository,
    url: proof.url,
    viewerLogin: proof.viewerLogin,
  })
}

export function createArtifactAuthorizer({ loadCheckAuthorization, loadPullAuthorization, peek }) {
  if (typeof loadCheckAuthorization !== 'function') {
    throw new TypeError('loadCheckAuthorization must be a function.')
  }
  if (typeof loadPullAuthorization !== 'function') {
    throw new TypeError('loadPullAuthorization must be a function.')
  }
  if (typeof peek !== 'function') throw new TypeError('peek must be a function.')

  function loadProof(load, input, signal) {
    return signal === undefined ? load(input) : load(input, signal)
  }

  async function authorizePull(value, signal) {
    const input = validateInput(value, false)
    const snapshotViewer = snapshotPull(peek, input)
    const proof = await loadProof(loadPullAuthorization, {
      number: input.number,
      repository: input.repository,
    }, signal)
    return validateProof(proof, input, snapshotViewer)
  }

  async function authorizeFailedCheck(value, signal) {
    const input = validateInput(value, true)
    const snapshotViewer = snapshotPull(peek, input)
    const proof = await loadProof(loadCheckAuthorization, {
      number: input.number,
      repository: input.repository,
    }, signal)
    const authorization = validateProof(proof, input, snapshotViewer)
    if (proof.checksComplete !== true || !Array.isArray(proof.failedChecks)) {
      throw new AuthorizationError('incomplete')
    }

    const matches = proof.failedChecks.filter((check) =>
      isRecord(check) &&
      typeof check.checkId === 'string' &&
      check.checkId !== '' &&
      check.runId === input.runId &&
      check.jobId === input.jobId &&
      jobUrl(check.detailsUrl, input.repository, input.runId, input.jobId))
    if (matches.length !== 1) throw new AuthorizationError('not_found')

    return Object.freeze({
      ...authorization,
      checkId: matches[0].checkId,
      jobId: input.jobId,
      runId: input.runId,
    })
  }

  return Object.freeze({
    authorizeFailedCheck,
    authorizePull,
  })
}
