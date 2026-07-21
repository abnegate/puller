import type { PullsResponse } from '../types';

const READY_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOCKED_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export const createPullsResponse = (): PullsResponse => ({
  counts: {
    notReady: 1,
    ready: 1,
    total: 2,
  },
  generatedAt: '2026-07-17T10:43:11.000Z',
  notReady: [
    {
      blockers: [
        '2 unresolved review comments',
        'Greptile confidence is 4/5',
        'CI checks failed',
      ],
      ci: {
        state: 'failure',
      },
      checks: {
        commentsComplete: true,
        threadsComplete: true,
      },
      greptile: {
        commentUrl: 'https://github.com/appwrite/cloud/pull/102#issuecomment-2',
        confidence: 4,
        reviewedSha: BLOCKED_SHA,
      },
      headRefOid: BLOCKED_SHA,
      number: 102,
      rank: 2,
      ready: false,
      repository: 'appwrite/cloud',
      repositoryUrl: 'https://github.com/appwrite/cloud',
      title: 'Keep deployment state synchronized',
      unresolved: 2,
      updatedAt: '2026-07-17T09:30:00.000Z',
      url: 'https://github.com/appwrite/cloud/pull/102',
    },
  ],
  partial: false,
  query: 'is:pr author:@me state:open archived:false sort:updated-desc',
  ready: [
    {
      blockers: [],
      ci: {
        state: 'success',
      },
      checks: {
        commentsComplete: true,
        threadsComplete: true,
      },
      greptile: {
        commentUrl: 'https://github.com/appwrite/cloud/pull/101#issuecomment-1',
        confidence: 5,
        reviewedSha: READY_SHA,
      },
      headRefOid: READY_SHA,
      number: 101,
      rank: 1,
      ready: true,
      repository: 'appwrite/cloud',
      repositoryUrl: 'https://github.com/appwrite/cloud',
      title: 'Make readiness signals explicit',
      unresolved: 0,
      updatedAt: '2026-07-17T10:30:00.000Z',
      url: 'https://github.com/appwrite/cloud/pull/101',
    },
  ],
  stale: false,
  warnings: [],
});
