import { GithubError } from './github.mjs'

export const DEFAULT_TTL = 10_000

export class SnapshotError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SnapshotError'
  }
}

function warningFor(error) {
  if (error instanceof GithubError && error.message) {
    return `Showing the last successful snapshot. ${error.message}`
  }

  return 'Showing the last successful snapshot because GitHub could not be refreshed.'
}

function initialError(error) {
  const detail =
    error instanceof GithubError && error.message
      ? error.message
      : 'GitHub pull requests could not be loaded.'

  return new SnapshotError(
    `${detail} Run gh auth status, then gh auth login if needed.`,
    { cause: error },
  )
}

export function createSnapshotCache({ load, now = Date.now, ttl = DEFAULT_TTL }) {
  let lastGood = null
  let loadedAt = 0
  let loadInflight = null
  let refreshInflight = null
  let freshInflight = null

  function store(snapshot) {
    loadedAt = now()
    lastGood = {
      ...snapshot,
      generatedAt: new Date(loadedAt).toISOString(),
      stale: false,
    }
    return lastGood
  }

  function markStale(error) {
    if (lastGood === null) return null

    loadedAt = now()
    lastGood = {
      ...lastGood,
      stale: true,
      warnings: [
        ...lastGood.warnings.filter(
          (warning) => !warning.startsWith('Showing the last successful snapshot'),
        ),
        warningFor(error),
      ],
    }
    return lastGood
  }

  function startLoad() {
    if (loadInflight) return loadInflight

    let running
    try {
      running = Promise.resolve(load()).then(store)
    } catch (error) {
      running = Promise.reject(error)
    }
    running = running.catch((error) => {
      markStale(error)
      throw error
    })
    loadInflight = running.finally(() => {
      loadInflight = null
    })
    return loadInflight
  }

  function loadFresh() {
    if (freshInflight) return freshInflight

    const running = startLoad().catch((error) => {
      throw initialError(error)
    })
    let shared
    shared = running.finally(() => {
      if (freshInflight === shared) {
        freshInflight = null
      }
    })
    freshInflight = shared
    return shared
  }

  function refresh() {
    if (refreshInflight) return refreshInflight

    const running = startLoad().catch((error) => {
      if (lastGood) return lastGood

      throw initialError(error)
    })
    let shared
    shared = running.finally(() => {
      if (refreshInflight === shared) {
        refreshInflight = null
      }
    })
    refreshInflight = shared
    return shared
  }

  return {
    get({ refresh: bypass = false } = {}) {
      if (!bypass && lastGood && now() - loadedAt < ttl) {
        return Promise.resolve(lastGood)
      }

      if (refreshInflight) {
        return refreshInflight
      }

      return refresh()
    },
    getFresh: loadFresh,
    loadFresh,
    /**
     * Returns the last snapshot and its TTL state without starting a load.
     * Consumers may use this only to deny or prune; fresh authorization must come from GitHub.
     */
    peek() {
      if (lastGood === null) return null
      return {
        ...lastGood,
        expired: now() - loadedAt >= ttl,
      }
    },
  }
}
