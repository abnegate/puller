import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './time';

const NOW = Date.parse('2026-07-21T00:00:00.000Z');

describe('formatRelativeTime', () => {
  it.each([
    [NOW, 'just now'],
    [NOW - 59_999, 'just now'],
    [NOW - 60_000, '1 min ago'],
    [NOW - 5 * 60_000, '5 mins ago'],
    [NOW - 60 * 60_000, '1 hr ago'],
    [NOW - 5 * 60 * 60_000, '5 hrs ago'],
    [NOW - 24 * 60 * 60_000, '1 day ago'],
    [NOW - 8 * 24 * 60 * 60_000, '8 days ago'],
    [NOW - 30 * 24 * 60 * 60_000, '1 month ago'],
    [NOW - 365 * 24 * 60 * 60_000, '1 yr ago'],
  ])('formats past boundary %s as %s', (value, expected) => {
    expect(formatRelativeTime(value, NOW)).toBe(expected);
  });

  it('formats future values without claiming they already happened', () => {
    expect(formatRelativeTime(NOW + 2 * 60_000, NOW)).toBe('in 2 mins');
    expect(formatRelativeTime(NOW + 30_000, NOW)).toBe('just now');
  });

  it('returns a stable fallback for invalid values', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe(
      'Update time unavailable',
    );
    expect(formatRelativeTime(NOW, Number.NaN)).toBe(
      'Update time unavailable',
    );
  });
});
