import { describe, expect, it } from 'vitest'

import {
  GREPTILE_LOGIN,
  parseConfidence,
  parseReviewedSha,
  selectGreptileSummary,
} from '../greptile.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function comment(overrides = {}) {
  return {
    author: GREPTILE_LOGIN,
    body: `Confidence Score: 5/5\nLast reviewed commit: ${SHA}`,
    updatedAt: '2026-07-17T00:00:00Z',
    url: 'https://github.com/example/repo/pull/1#issuecomment-1',
    ...overrides,
  }
}

describe('Greptile summary parsing', () => {
  it('accepts the exact bot and ignores spoofed or human authors', () => {
    const result = selectGreptileSummary([
      comment({ author: 'greptile-apps[bot]', updatedAt: '2026-07-17T03:00:00Z' }),
      comment({ author: 'greptile-app', updatedAt: '2026-07-17T02:00:00Z' }),
      comment({ author: 'jakebarnby', updatedAt: '2026-07-17T01:00:00Z' }),
      comment(),
    ])

    expect(result).toMatchObject({ confidence: 5, reviewedSha: SHA })
  })

  it('selects the latest updated summary', () => {
    const result = selectGreptileSummary([
      comment({ body: `Confidence Score: 2/5\nLast reviewed commit: ${SHA}` }),
      comment({
        body: `Confidence Score: 4/5\nLast reviewed commit: ${SHA}`,
        updatedAt: '2026-07-17T01:00:00Z',
      }),
    ])

    expect(result?.confidence).toBe(4)
  })

  it('never combines confidence and SHA from different comments', () => {
    const result = selectGreptileSummary([
      comment({ body: 'Confidence Score: 5/5' }),
      comment({
        body: `Last reviewed commit: ${SHA}`,
        updatedAt: '2026-07-17T01:00:00Z',
      }),
    ])

    expect(result).toMatchObject({ confidence: null, reviewedSha: SHA })
  })

  it('does not let an older valid summary rescue a malformed newer summary', () => {
    const result = selectGreptileSummary([
      comment(),
      comment({
        body: 'Confidence Score: excellent/5\nLast reviewed commit: abc1234',
        updatedAt: '2026-07-17T01:00:00Z',
      }),
    ])

    expect(result).toMatchObject({ confidence: null, reviewedSha: null })
  })

  it('parses Markdown and HTML summary forms', () => {
    expect(
      selectGreptileSummary([
        comment({
          body: `<strong>Confidence Score:</strong> 5/5\n<strong>Last reviewed commit:</strong> <a href="https://github.com/example/repo/commit/${SHA}">current</a>`,
        }),
      ]),
    ).toMatchObject({ confidence: 5, reviewedSha: SHA })

    expect(
      selectGreptileSummary([
        comment({
          body: `**Confidence Score:** 4/5\n**Last reviewed commit:** [current](https://github.com/example/repo/commit/${SHA})`,
        }),
      ]),
    ).toMatchObject({ confidence: 4, reviewedSha: SHA })
  })

  it('accepts confidence scores from zero through five only', () => {
    for (let score = 0; score <= 5; score += 1) {
      expect(parseConfidence(`Confidence Score: ${score}/5`)).toBe(score)
    }

    expect(parseConfidence('Confidence Score: 6/5')).toBeNull()
    expect(parseConfidence('Confidence Score: -1/5')).toBeNull()
    expect(parseConfidence('No confidence here')).toBeNull()
  })

  it('requires exactly 40 hexadecimal SHA characters', () => {
    expect(parseReviewedSha(`Last reviewed commit: ${SHA.toUpperCase()}`)).toBe(SHA)
    expect(parseReviewedSha('Last reviewed commit: abc1234')).toBeNull()
    expect(parseReviewedSha(`Last reviewed commit: ${'g'.repeat(40)}`)).toBeNull()
    expect(parseReviewedSha(`Last reviewed commit: ${SHA}a`)).toBeNull()
    expect(parseReviewedSha('No reviewed commit')).toBeNull()
  })
})
