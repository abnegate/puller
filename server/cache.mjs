import { GithubError } from './github.mjs'

const DEFAULT_TTL = 5 * 60 * 1_000

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
  let inflight = null

  async function refresh() {
    try {
      const snapshot = await load()
      loadedAt = now()
      lastGood = {
        ...snapshot,
        generatedAt: new Date(loadedAt).toISOString(),
        stale: false,
      }
      return lastGood
    } catch (error) {
      if (lastGood) {
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

      throw initialError(error)
    } finally {
      inflight = null
    }
  }

  return {
    get({ refresh: bypass = false } = {}) {
      if (!bypass && lastGood && now() - loadedAt < ttl) {
        return Promise.resolve(lastGood)
      }

      if (inflight) {
        return inflight
      }

      inflight = refresh()
      return inflight
    },
  }
}
