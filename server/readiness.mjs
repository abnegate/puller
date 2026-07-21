import { selectGreptileSummary } from './greptile.mjs'
import { SEARCH_QUERY } from './github.mjs'

const CI_STATES = new Set(['success', 'pending', 'failure', 'none', 'unknown'])

function shortSha(sha) {
  return sha.slice(0, 7)
}

function normalizeCiState(ci) {
  return CI_STATES.has(ci?.state) ? ci.state : 'unknown'
}

export function assessPull(pull, rank) {
  const unresolved = pull.reviewThreads.filter((thread) => !thread.isResolved).length
  const summary = selectGreptileSummary(pull.comments)
  const confidence = summary?.confidence ?? null
  const reviewedSha = summary?.reviewedSha ?? null
  const reviewUrl = summary?.commentUrl ?? null
  const headRefOid = pull.headRefOid.toLowerCase()
  const ciState = normalizeCiState(pull.ci)
  const blockers = []

  if (unresolved > 0) {
    blockers.push(
      `${unresolved} unresolved review ${unresolved === 1 ? 'thread' : 'threads'}`,
    )
  }

  if (!summary) {
    blockers.push('Greptile summary missing')
  } else {
    if (confidence === null) {
      blockers.push('Greptile confidence missing or unreadable')
    } else if (confidence !== 5) {
      blockers.push(`Greptile confidence ${confidence}/5`)
    }

    if (reviewedSha === null) {
      blockers.push('Last reviewed commit missing or unreadable')
    } else if (reviewedSha !== headRefOid) {
      blockers.push(
        `Greptile reviewed ${shortSha(reviewedSha)}; head is ${shortSha(headRefOid)}`,
      )
    }

    if (reviewUrl === null) {
      blockers.push('Greptile review link missing')
    }
  }

  if (!pull.threadsComplete) {
    blockers.push('Review threads could not be fully checked')
  }

  if (!pull.commentsComplete) {
    blockers.push('Greptile comments could not be fully checked')
  }

  if (ciState === 'pending') {
    blockers.push('CI checks pending')
  } else if (ciState === 'failure') {
    blockers.push('CI checks failed')
  } else if (ciState === 'unknown') {
    blockers.push('CI checks could not be fully checked')
  }

  const ready =
    pull.threadsComplete &&
    pull.commentsComplete &&
    unresolved === 0 &&
    confidence === 5 &&
    reviewedSha === headRefOid &&
    reviewUrl !== null &&
    (ciState === 'success' || ciState === 'none')

  return {
    rank,
    repository: pull.repository,
    repositoryUrl: pull.repositoryUrl,
    number: pull.number,
    title: pull.title,
    url: pull.url,
    updatedAt: pull.updatedAt,
    headRefOid: pull.headRefOid,
    unresolved,
    ci: {
      state: ciState,
    },
    greptile: {
      confidence,
      reviewedSha,
      commentUrl: reviewUrl,
    },
    checks: {
      threadsComplete: pull.threadsComplete,
      commentsComplete: pull.commentsComplete,
    },
    ready,
    blockers,
  }
}

export function createReadinessSnapshot(result) {
  const pulls = result.pulls.map((pull, index) => assessPull(pull, index + 1))
  const ready = pulls.filter((pull) => pull.ready)
  const notReady = pulls.filter((pull) => !pull.ready)

  return {
    query: SEARCH_QUERY,
    partial: result.partial,
    warnings: [...result.warnings],
    counts: {
      total: pulls.length,
      ready: ready.length,
      notReady: notReady.length,
    },
    ready,
    notReady,
  }
}
