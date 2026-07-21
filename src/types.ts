export type CIState = 'success' | 'pending' | 'failure' | 'none' | 'unknown';

export type PullReadiness = {
  blockers: string[];
  ci: {
    state: CIState;
  };
  checks: {
    commentsComplete: boolean;
    threadsComplete: boolean;
  };
  greptile: {
    commentUrl: string | null;
    confidence: number | null;
    reviewedSha: string | null;
  };
  headRefOid: string;
  number: number;
  rank: number;
  ready: boolean;
  repository: string;
  repositoryUrl: string;
  title: string;
  unresolved: number;
  updatedAt: string;
  url: string;
};

export type PullsResponse = {
  counts: {
    notReady: number;
    ready: number;
    total: number;
  };
  generatedAt: string;
  notReady: PullReadiness[];
  partial: boolean;
  query: string;
  ready: PullReadiness[];
  stale: boolean;
  warnings: string[];
};
