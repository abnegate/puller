export const GREPTILE_LOGIN = 'greptile-apps'

function readableBody(body) {
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
}

function identifiesSummary(body) {
  const readable = readableBody(body)
  return /Confidence\s+Score\s*:/i.test(readable) || /Last\s+reviewed\s+commit\s*:/i.test(readable)
}

export function parseConfidence(body) {
  const readable = readableBody(body)
  const match = /Confidence\s+Score\s*:\s*(\d+)\s*\/\s*5/i.exec(readable)
  if (!match) {
    return null
  }

  const score = Number(match[1])
  return Number.isInteger(score) && score >= 0 && score <= 5 ? score : null
}

export function parseReviewedSha(body) {
  const line = /Last\s+reviewed\s+commit\s*:?[^\r\n]*/i.exec(body)?.[0]
  if (!line) {
    return null
  }

  const match = /(?:^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/i.exec(line)
  return match?.[1]?.toLowerCase() ?? null
}

function timestamp(comment) {
  const value = Date.parse(comment.createdAt ?? '')
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value
}

export function selectGreptileSummary(comments) {
  const summaries = comments.filter(
    (comment) =>
      comment.author === GREPTILE_LOGIN &&
      typeof comment.body === 'string' &&
      identifiesSummary(comment.body),
  )

  if (summaries.length === 0) {
    return null
  }

  const latest = summaries.reduce((selected, comment) =>
    timestamp(comment) > timestamp(selected) ? comment : selected,
  )

  return {
    commentId: latest.id ?? null,
    createdAt: latest.createdAt ?? null,
    confidence: parseConfidence(latest.body),
    reviewedSha: parseReviewedSha(latest.body),
    commentUrl: latest.url ?? null,
    updatedAt: latest.updatedAt ?? null,
  }
}
