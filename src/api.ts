import type { CIState, PullReadiness, PullsResponse } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum;

const isValidDate = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const isValidUrl = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const isCIState = (value: unknown): value is CIState =>
  value === 'success' ||
  value === 'pending' ||
  value === 'failure' ||
  value === 'none' ||
  value === 'unknown';

const isPullReadiness = (value: unknown): value is PullReadiness => {
  if (
    !isRecord(value) ||
    !isRecord(value.ci) ||
    !isRecord(value.checks) ||
    !isRecord(value.greptile)
  ) {
    return false;
  }

  return (
    Array.isArray(value.blockers) &&
    value.blockers.every(isNonEmptyString) &&
    isCIState(value.ci.state) &&
    typeof value.checks.commentsComplete === 'boolean' &&
    typeof value.checks.threadsComplete === 'boolean' &&
    (value.greptile.commentUrl === null || isValidUrl(value.greptile.commentUrl)) &&
    ((typeof value.greptile.confidence === 'number' &&
      value.greptile.confidence >= 0 &&
      value.greptile.confidence <= 5) ||
      value.greptile.confidence === null) &&
    (isNonEmptyString(value.greptile.reviewedSha) || value.greptile.reviewedSha === null) &&
    isNonEmptyString(value.headRefOid) &&
    isInteger(value.number, 1) &&
    isInteger(value.rank, 1) &&
    typeof value.ready === 'boolean' &&
    isNonEmptyString(value.repository) &&
    isValidUrl(value.repositoryUrl) &&
    isNonEmptyString(value.title) &&
    isInteger(value.unresolved) &&
    isValidDate(value.updatedAt) &&
    isValidUrl(value.url)
  );
};

const isReadyPull = (pull: PullReadiness): boolean =>
  pull.ready &&
  pull.blockers.length === 0 &&
  pull.unresolved === 0 &&
  pull.checks.commentsComplete &&
  pull.checks.threadsComplete &&
  (pull.ci.state === 'success' || pull.ci.state === 'none') &&
  pull.greptile.confidence === 5 &&
  pull.greptile.commentUrl !== null &&
  pull.greptile.reviewedSha !== null &&
  pull.greptile.reviewedSha === pull.headRefOid;

const isBlockedPull = (pull: PullReadiness): boolean => !pull.ready && pull.blockers.length > 0;

export const isPullsResponse = (value: unknown): value is PullsResponse => {
  if (!isRecord(value)) {
    return false;
  }

  const counts = value.counts;

  if (!isRecord(counts)) {
    return false;
  }

  const notReadyCount = counts.notReady;
  const readyCount = counts.ready;
  const totalCount = counts.total;

  if (
    !Array.isArray(value.ready) ||
    !value.ready.every(isPullReadiness) ||
    !value.ready.every(isReadyPull) ||
    !Array.isArray(value.notReady) ||
    !value.notReady.every(isPullReadiness) ||
    !value.notReady.every(isBlockedPull) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isNonEmptyString) ||
    !isValidDate(value.generatedAt) ||
    typeof value.partial !== 'boolean' ||
    !isNonEmptyString(value.query) ||
    typeof value.stale !== 'boolean' ||
    !isInteger(notReadyCount) ||
    !isInteger(readyCount) ||
    !isInteger(totalCount)
  ) {
    return false;
  }

  const pulls = [...value.ready, ...value.notReady];
  const countsMatch =
    readyCount === value.ready.length &&
    notReadyCount === value.notReady.length &&
    totalCount === pulls.length &&
    totalCount === readyCount + notReadyCount;
  const ranks = new Set(pulls.map((pull) => pull.rank));
  const urls = new Set(pulls.map((pull) => pull.url));
  const ranksAreComplete = pulls.every((pull) => pull.rank <= totalCount);

  return (
    countsMatch && ranks.size === pulls.length && urls.size === pulls.length && ranksAreComplete
  );
};

const getErrorMessage = (status: number, payload: unknown): string => {
  if (isRecord(payload) && typeof payload.error === 'string') {
    return payload.error;
  }

  return `The readiness service returned HTTP ${status}.`;
};

export const getPulls = async (refresh = false): Promise<PullsResponse> => {
  const response = await fetch(refresh ? '/api/pulls?refresh=1' : '/api/pulls', {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(getErrorMessage(response.status, payload));
  }

  if (!isPullsResponse(payload)) {
    throw new Error('The readiness service returned an unexpected response.');
  }

  return payload;
};
