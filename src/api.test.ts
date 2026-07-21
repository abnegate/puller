import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPulls, isPullsResponse } from './api';
import { createPullsResponse } from './test/fixtures';
import type { PullsResponse } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPullsResponse', () => {
  it('accepts a consistent normalized response', () => {
    expect(isPullsResponse(createPullsResponse())).toBe(true);
  });

  it.each(['success', 'none'] as const)('accepts a ready pull with CI state %s', (state) => {
    const response = createPullsResponse();
    response.ready[0]!.ci.state = state;

    expect(isPullsResponse(response)).toBe(true);
  });

  it.each<[string, (response: PullsResponse) => void]>([
    ['a ready pull with ready=false', (response) => (response.ready[0]!.ready = false)],
    ['a ready pull with unresolved comments', (response) => (response.ready[0]!.unresolved = 1)],
    [
      'a ready pull with incomplete thread data',
      (response) => (response.ready[0]!.checks.threadsComplete = false),
    ],
    [
      'a ready pull below 5/5 confidence',
      (response) => (response.ready[0]!.greptile.confidence = 4),
    ],
    [
      'a ready pull reviewed at an older head',
      (response) => (response.ready[0]!.greptile.reviewedSha = 'older-head'),
    ],
    [
      'a ready pull without a Greptile review URL',
      (response) => (response.ready[0]!.greptile.commentUrl = null),
    ],
    [
      'a ready pull with pending CI checks',
      (response) => (response.ready[0]!.ci.state = 'pending'),
    ],
    [
      'a ready pull with failing CI checks',
      (response) => (response.ready[0]!.ci.state = 'failure'),
    ],
    [
      'a ready pull with unknown CI state',
      (response) => (response.ready[0]!.ci.state = 'unknown'),
    ],
    ['a not-ready pull with ready=true', (response) => (response.notReady[0]!.ready = true)],
    ['a not-ready pull without blockers', (response) => (response.notReady[0]!.blockers = [])],
    ['counts that do not match the arrays', (response) => (response.counts.total = 3)],
    ['a duplicate source rank', (response) => (response.notReady[0]!.rank = 1)],
    [
      'a duplicate pull URL',
      (response) => (response.notReady[0]!.url = response.ready[0]!.url),
    ],
  ])('rejects contradictory data: %s', (_label, mutate) => {
    const response = createPullsResponse();
    mutate(response);

    expect(isPullsResponse(response)).toBe(false);
  });

  it.each(['SUCCESS', 'complete', '', null, true, 1])(
    'rejects an out-of-contract CI state: %j',
    (state) => {
      const response = createPullsResponse();
      (response.notReady[0] as unknown as Record<string, unknown>).ci = { state };

      expect(isPullsResponse(response)).toBe(false);
    },
  );

  it('rejects a pull without CI state data', () => {
    const response = createPullsResponse();
    delete (response.ready[0] as unknown as Record<string, unknown>).ci;

    expect(isPullsResponse(response)).toBe(false);
  });
});

describe('getPulls', () => {
  it('uses the cache-bypass endpoint for a manual refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createPullsResponse()), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPulls(true)).resolves.toEqual(createPullsResponse());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pulls?refresh=1',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('rejects a contradictory successful API payload', async () => {
    const response = createPullsResponse();
    response.ready[0]!.unresolved = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );

    await expect(getPulls()).rejects.toThrow('unexpected response');
  });
});
