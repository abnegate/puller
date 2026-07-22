import type { PullDiff, PullReadiness, PullsResponse } from '../types';

const READY_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOCKED_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const READY_BASE_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const BLOCKED_BASE_SHA = 'dddddddddddddddddddddddddddddddddddddddd';

export const createPullsResponse = (): PullsResponse => ({
  counts: {
    notReady: 1,
    ready: 1,
    total: 2,
  },
  generatedAt: '2026-07-17T10:43:11.000Z',
  notReady: [
    {
      baseRefOid: BLOCKED_BASE_SHA,
      blockers: [
        '2 unresolved review comments',
        'Greptile confidence is 4/5',
        'CI checks failed',
      ],
      ci: {
        checks: [
          {
            detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/2',
            id: 'check-run-2',
            name: 'Unit tests',
            state: 'success',
            workflow: 'CI',
          },
          {
            detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/3',
            id: 'check-run-3',
            name: 'Integration tests',
            state: 'failure',
            workflow: 'CI',
          },
        ],
        complete: true,
        failed: 1,
        passed: 1,
        running: 0,
        state: 'failure',
        total: 2,
        unknown: 0,
      },
      checks: {
        commentsComplete: true,
        threadsComplete: true,
      },
      greptile: {
        body: 'Confidence: 4/5\n\nOne issue still needs attention.',
        commentId: 'issue-comment-2',
        commentUrl: 'https://github.com/appwrite/cloud/pull/102#issuecomment-2',
        confidence: 4,
        current: true,
        reviewedSha: BLOCKED_SHA,
        updatedAt: '2026-07-17T09:00:00.000Z',
      },
      headRefOid: BLOCKED_SHA,
      issueComments: [
        {
          author: 'reviewer-three',
          body: 'Please keep the rollout note up to date.',
          createdAt: '2026-07-17T08:30:00.000Z',
          id: 'issue-comment-1',
          updatedAt: '2026-07-17T08:30:00.000Z',
          url: 'https://github.com/appwrite/cloud/pull/102#issuecomment-1',
        },
        {
          author: 'greptile-apps',
          body: 'Confidence: 4/5\n\nOne issue still needs attention.',
          createdAt: '2026-07-17T09:00:00.000Z',
          id: 'issue-comment-2',
          updatedAt: '2026-07-17T09:00:00.000Z',
          url: 'https://github.com/appwrite/cloud/pull/102#issuecomment-2',
        },
      ],
      number: 102,
      rank: 2,
      ready: false,
      repository: 'appwrite/cloud',
      repositoryUrl: 'https://github.com/appwrite/cloud',
      title: 'Keep deployment state synchronized',
      unresolved: 2,
      unresolvedThreads: [
        {
          author: 'reviewer-one',
          body: 'Please cover the retry path.',
          comments: [
            {
              author: 'reviewer-one',
              body: 'Please cover the retry path.',
              createdAt: '2026-07-17T08:45:00.000Z',
              id: 'review-comment-1',
              line: 42,
              outdated: false,
              path: 'src/deploy.ts',
              updatedAt: '2026-07-17T08:45:00.000Z',
              url: 'https://github.com/appwrite/cloud/pull/102#discussion_r1',
            },
            {
              author: 'pull-author',
              body: 'I will add that coverage.',
              createdAt: '2026-07-17T08:47:00.000Z',
              id: 'review-comment-reply-1',
              line: 42,
              outdated: false,
              path: 'src/deploy.ts',
              updatedAt: '2026-07-17T08:48:00.000Z',
              url: 'https://github.com/appwrite/cloud/pull/102#discussion_r1-reply',
            },
          ],
          createdAt: '2026-07-17T08:45:00.000Z',
          id: 'thread-1',
          line: 42,
          outdated: false,
          path: 'src/deploy.ts',
          url: 'https://github.com/appwrite/cloud/pull/102#discussion_r1',
        },
        {
          author: 'reviewer-two',
          body: 'This error should preserve the original cause.',
          comments: [
            {
              author: 'reviewer-two',
              body: 'This error should preserve the original cause.',
              createdAt: '2026-07-17T08:50:00.000Z',
              id: 'review-comment-2',
              line: 73,
              outdated: false,
              path: 'src/deploy.ts',
              updatedAt: '2026-07-17T08:50:00.000Z',
              url: 'https://github.com/appwrite/cloud/pull/102#discussion_r2',
            },
          ],
          createdAt: '2026-07-17T08:50:00.000Z',
          id: 'thread-2',
          line: 73,
          outdated: false,
          path: 'src/deploy.ts',
          url: 'https://github.com/appwrite/cloud/pull/102#discussion_r2',
        },
      ],
      updatedAt: '2026-07-17T09:30:00.000Z',
      url: 'https://github.com/appwrite/cloud/pull/102',
    },
  ],
  partial: false,
  query: 'is:pr author:@me state:open archived:false sort:updated-desc',
  ready: [
    {
      baseRefOid: READY_BASE_SHA,
      blockers: [],
      ci: {
        checks: [
          {
            detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/1',
            id: 'check-run-1',
            name: 'Unit tests',
            state: 'success',
            workflow: 'CI',
          },
        ],
        complete: true,
        failed: 0,
        passed: 1,
        running: 0,
        state: 'success',
        total: 1,
        unknown: 0,
      },
      checks: {
        commentsComplete: true,
        threadsComplete: true,
      },
      greptile: {
        body: 'Confidence: 5/5\n\nReady to merge.',
        commentId: 'issue-comment-ready-1',
        commentUrl: 'https://github.com/appwrite/cloud/pull/101#issuecomment-1',
        confidence: 5,
        current: true,
        reviewedSha: READY_SHA,
        updatedAt: '2026-07-17T10:20:00.000Z',
      },
      headRefOid: READY_SHA,
      issueComments: [
        {
          author: 'greptile-apps',
          body: 'Confidence: 5/5\n\nReady to merge.',
          createdAt: '2026-07-17T10:20:00.000Z',
          id: 'issue-comment-ready-1',
          updatedAt: '2026-07-17T10:20:00.000Z',
          url: 'https://github.com/appwrite/cloud/pull/101#issuecomment-1',
        },
      ],
      number: 101,
      rank: 1,
      ready: true,
      repository: 'appwrite/cloud',
      repositoryUrl: 'https://github.com/appwrite/cloud',
      title: 'Make readiness signals explicit',
      unresolved: 0,
      unresolvedThreads: [],
      updatedAt: '2026-07-17T10:30:00.000Z',
      url: 'https://github.com/appwrite/cloud/pull/101',
    },
  ],
  stale: false,
  viewerLogin: 'jake',
  warnings: [],
});

export const createPendingPull = (rank = 3): PullReadiness => {
  const blocked = createPullsResponse().notReady[0]!;

  return {
    ...blocked,
    blockers: ['CI checks pending'],
    ci: {
      checks: [
        {
          detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/4',
          id: 'check-run-4',
          name: 'Unit tests',
          state: 'success',
          workflow: 'CI',
        },
        {
          detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/5',
          id: 'check-run-5',
          name: 'Integration tests',
          state: 'pending',
          workflow: 'CI',
        },
      ],
      complete: true,
      failed: 0,
      passed: 1,
      running: 1,
      state: 'pending',
      total: 2,
      unknown: 0,
    },
    number: 103,
    rank,
    title: 'Wait for required CI checks',
    url: 'https://github.com/appwrite/cloud/pull/103',
  };
};

export const createDegradedPullsResponse = (): PullsResponse => {
  const response = createPullsResponse();
  const pull = response.notReady[0]!;

  pull.blockers = [
    '2 unresolved review threads',
    'Review threads could not be fully checked',
    'CI checks could not be fully checked',
  ];
  pull.checks.threadsComplete = false;
  pull.ci = {
    checks: [
      {
        detailsUrl: 'https://github.com/appwrite/cloud/actions/runs/2',
        id: 'check-run-2',
        name: 'Unit tests',
        state: 'success',
        workflow: 'CI',
      },
    ],
    complete: false,
    failed: 0,
    passed: 1,
    running: 0,
    state: 'unknown',
    total: 3,
    unknown: 2,
  };
  pull.unresolvedThreads = pull.unresolvedThreads?.slice(0, 1);
  response.partial = true;
  response.warnings = ['GitHub returned incomplete readiness evidence.'];

  return response;
};

export const createDegradedPullDiff = (): PullDiff => ({
  baseRefOid: READY_BASE_SHA,
  complete: false,
  files: [
    {
      additions: 0,
      binary: true,
      blobUrl: '',
      changes: 0,
      deletions: 0,
      hunks: [],
      path: 'public/logo.png',
      previousPath: null,
      rawUrl: '',
      status: 'modified',
      truncated: false,
    },
  ],
  headRefOid: READY_SHA,
  number: 101,
  repository: 'appwrite/cloud',
  warning: 'GitHub omitted file links.',
});
