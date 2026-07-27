import { useCallback, useEffect, useMemo, useRef } from "react";

import { getReleasePipelines } from "./api";
import type {
  RecentRelease,
  RecentReleasesResponse,
  ReleasePipeline,
  ReleasePipelineRelease,
  ReleasePipelineRun,
  ReleasePipelinesResponse,
} from "./types";

export const RELEASE_PIPELINE_REFRESH_INTERVAL = 5_000;
export const RELEASE_PIPELINE_FOLLOWUP_INTERVAL = 30_000;
export const RELEASE_PIPELINE_DISCOVERY_WINDOW = 5 * 60 * 1_000;
const RELEASE_PIPELINE_MAXIMUM_BACKOFF = 60_000;

type PipelineRefreshMode = "discover" | "poll" | "refresh";

type ReleaseIdentity = Pick<
  ReleasePipelineRelease,
  "id" | "publishedAt" | "repository" | "tag"
>;

type PipelineRequest = {
  controller: AbortController;
  fingerprint: string;
  generation: number;
  mode: PipelineRefreshMode;
  promise: Promise<void>;
};

export type ReleasePipelinePollingOptions = {
  enabled: boolean;
  onSnapshot: (snapshot: ReleasePipelinesResponse) => void;
  refreshRevision: number;
  releases: RecentRelease[];
};

export type ReleasePipelinePolling = {
  refresh: () => Promise<void>;
};

export const releasePipelineIdentity = (release: ReleaseIdentity): string =>
  JSON.stringify([
    release.id,
    release.repository,
    release.tag,
    release.publishedAt,
  ]);

export const releasePipelineFingerprint = (
  releases: readonly ReleaseIdentity[],
): string =>
  JSON.stringify(
    releases
      .map(releasePipelineIdentity)
      .sort((left, right) => left.localeCompare(right)),
  );

export const isReleasePipelineActive = (pipeline: ReleasePipeline): boolean =>
  pipeline.lookup === "pending" ||
  pipeline.runs.some(
    (run) => run.state === "queued" || run.state === "running",
  );

export const hasActiveReleasePipelines = (
  releases: readonly Pick<RecentRelease, "pipeline">[],
): boolean =>
  releases.some((release) => isReleasePipelineActive(release.pipeline));

export const hasYoungReleasePipelines = (
  releases: readonly Pick<RecentRelease, "publishedAt">[],
  clock = Date.now(),
): boolean =>
  releases.some(
    (release) =>
      clock - Date.parse(release.publishedAt) <
      RELEASE_PIPELINE_DISCOVERY_WINDOW,
  );

const hasFastReleasePipelines = (
  releases: readonly RecentRelease[],
  clock = Date.now(),
): boolean =>
  releases.some(
    (release) =>
      release.pipeline.runs.some(
        (run) => run.state === "queued" || run.state === "running",
      ) ||
      (release.pipeline.lookup === "pending" &&
        clock - Date.parse(release.publishedAt) <
          RELEASE_PIPELINE_DISCOVERY_WINDOW),
  );

const hasTargetedReleasePipelines = (
  releases: readonly RecentRelease[],
  clock = Date.now(),
): boolean =>
  releases.some(
    (release) =>
      release.pipeline.runs.length === 0 ||
      release.pipeline.runs.some(
        (run) => run.state === "queued" || run.state === "running",
      ) ||
      clock - Date.parse(release.publishedAt) <
        RELEASE_PIPELINE_DISCOVERY_WINDOW,
  );

const refreshPriority: Record<PipelineRefreshMode, number> = {
  poll: 0,
  discover: 1,
  refresh: 2,
};

const compareDecimal = (left: string, right: string): number => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
};

const chooseWorkflowRun = (
  current: ReleasePipelineRun,
  candidate: ReleasePipelineRun,
): ReleasePipelineRun => {
  if (candidate.id === current.id) {
    if (candidate.attempt !== current.attempt) {
      return candidate.attempt > current.attempt ? candidate : current;
    }

    const updated =
      Date.parse(candidate.updatedAt) - Date.parse(current.updatedAt);
    return updated > 0 ? candidate : current;
  }

  const created =
    Date.parse(candidate.createdAt) - Date.parse(current.createdAt);
  if (created !== 0) return created > 0 ? candidate : current;
  return compareDecimal(candidate.id, current.id) > 0 ? candidate : current;
};

const comparePipelineRuns = (
  left: ReleasePipelineRun,
  right: ReleasePipelineRun,
): number => {
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (created !== 0) return created;

  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  if (left.attempt !== right.attempt) return right.attempt - left.attempt;

  const id = compareDecimal(right.id, left.id);
  if (id !== 0) return id;
  return compareDecimal(left.workflowId, right.workflowId);
};

const reconcilePipelineRuns = (
  previous: readonly ReleasePipelineRun[],
  incoming: readonly ReleasePipelineRun[],
  preserveActive = true,
): ReleasePipelineRun[] => {
  const workflows = new Map<string, ReleasePipelineRun>();

  for (const run of [
    ...previous.filter(
      (value) =>
        preserveActive ||
        (value.state !== "queued" && value.state !== "running"),
    ),
    ...incoming,
  ]) {
    const current = workflows.get(run.workflowId);
    workflows.set(
      run.workflowId,
      current ? chooseWorkflowRun(current, run) : run,
    );
  }

  return [...workflows.values()].sort(comparePipelineRuns);
};

export const reconcileReleasePipeline = (
  previous: ReleasePipeline | undefined,
  incoming: ReleasePipeline,
): ReleasePipeline => {
  if (previous === incoming) return incoming;

  if (!previous) {
    const runs = reconcilePipelineRuns([], incoming.runs);
    return {
      ...incoming,
      lookup:
        incoming.lookup === "pending" && runs.length > 0
          ? "complete"
          : incoming.lookup,
      runs,
    };
  }

  const previousCheckedAt = Date.parse(previous.checkedAt);
  const incomingCheckedAt = Date.parse(incoming.checkedAt);
  if (incomingCheckedAt < previousCheckedAt) return previous;

  if (incoming.lookup === "unavailable") {
    return {
      ...incoming,
      lookup: previous.lookup === "pending" ? "pending" : "unavailable",
      runs: reconcilePipelineRuns(previous.runs, []),
    };
  }

  const runs = reconcilePipelineRuns(previous.runs, incoming.runs, false);
  const lookup =
    incoming.lookup === "pending" &&
    (previous.lookup === "complete" || runs.length > 0)
      ? "complete"
      : incoming.lookup;
  return { ...incoming, lookup, runs };
};

export const reconcileRecentReleasePipeline = (
  previous: RecentRelease | undefined,
  incoming: RecentRelease,
): RecentRelease => {
  if (
    !previous ||
    releasePipelineIdentity(previous) !== releasePipelineIdentity(incoming)
  ) {
    return incoming;
  }

  const pipeline = reconcileReleasePipeline(
    previous.pipeline,
    incoming.pipeline,
  );
  return pipeline === incoming.pipeline ? incoming : { ...incoming, pipeline };
};

export const reconcileReleasePipelineList = (
  releases: RecentRelease[],
  snapshot: ReleasePipelinesResponse,
): RecentRelease[] => {
  const pipelines = new Map(
    snapshot.releases.map((release) => [
      releasePipelineIdentity(release),
      release.pipeline,
    ]),
  );
  let changed = false;
  const reconciled = releases.map((release) => {
    const incoming = pipelines.get(releasePipelineIdentity(release));
    if (!incoming) return release;

    const pipeline = reconcileReleasePipeline(release.pipeline, incoming);
    if (pipeline === release.pipeline) return release;
    changed = true;
    return { ...release, pipeline };
  });

  return changed ? reconciled : releases;
};

export const applyReleasePipelineSnapshot = (
  current: RecentReleasesResponse | null,
  snapshot: ReleasePipelinesResponse,
): RecentReleasesResponse | null => {
  if (!current) return current;

  const releases = reconcileReleasePipelineList(current.releases, snapshot);
  return releases === current.releases ? current : { ...current, releases };
};

const pageIsVisible = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "visible";

export const useReleasePipelinePolling = ({
  enabled,
  onSnapshot,
  refreshRevision,
  releases,
}: ReleasePipelinePollingOptions): ReleasePipelinePolling => {
  const fingerprint = useMemo(
    () => releasePipelineFingerprint(releases),
    [releases],
  );
  const confirmationsRef = useRef(new Map<string, string>());
  const enabledRef = useRef(enabled);
  const failuresRef = useRef(0);
  const fingerprintRef = useRef(fingerprint);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const onSnapshotRef = useRef(onSnapshot);
  const releasesRef = useRef(releases);
  const requestRef = useRef<PipelineRequest | null>(null);
  const timerRef = useRef<number | null>(null);
  const refreshRef = useRef<(mode?: PipelineRefreshMode) => Promise<void>>(
    async () => undefined,
  );
  const configurationRef = useRef({
    enabled,
    fingerprint,
    refreshRevision,
  });

  enabledRef.current = enabled;
  fingerprintRef.current = fingerprint;
  onSnapshotRef.current = onSnapshot;
  releasesRef.current = releases;

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const invalidate = useCallback(() => {
    clearTimer();
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    confirmationsRef.current.clear();
    failuresRef.current = 0;
  }, [clearTimer]);

  const schedule = useCallback(() => {
    clearTimer();
    const baseInterval =
      hasFastReleasePipelines(releasesRef.current) ||
      confirmationsRef.current.size > 0
        ? RELEASE_PIPELINE_REFRESH_INTERVAL
        : releasesRef.current.length > 0
          ? RELEASE_PIPELINE_FOLLOWUP_INTERVAL
          : null;
    if (
      !mountedRef.current ||
      !enabledRef.current ||
      !pageIsVisible() ||
      baseInterval === null
    ) {
      return;
    }

    const interval = Math.min(
      baseInterval * 2 ** failuresRef.current,
      RELEASE_PIPELINE_MAXIMUM_BACKOFF,
    );
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void refreshRef.current("poll");
    }, interval);
  }, [clearTimer]);

  const refresh = useCallback(
    async (mode: PipelineRefreshMode = "refresh"): Promise<void> => {
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        !pageIsVisible() ||
        releasesRef.current.length === 0
      ) {
        return;
      }

      const activeRequest = requestRef.current;
      if (activeRequest) {
        if (refreshPriority[mode] <= refreshPriority[activeRequest.mode]) {
          return activeRequest.promise;
        }
        await activeRequest.promise;
        return refreshRef.current(mode);
      }

      clearTimer();
      const controller = new AbortController();
      const generation = generationRef.current;
      const requestFingerprint = fingerprintRef.current;
      const previous = releasesRef.current;
      const previousActive = new Set(
        previous
          .filter((release) => isReleasePipelineActive(release.pipeline))
          .map(releasePipelineIdentity),
      );
      const previousConfirmations = new Map(confirmationsRef.current);
      const request: PipelineRequest = {
        controller,
        fingerprint: requestFingerprint,
        generation,
        mode,
        promise: Promise.resolve(),
      };

      request.promise = (async () => {
        try {
          const snapshot =
            mode === "discover"
              ? await getReleasePipelines(controller.signal, false, true)
              : await getReleasePipelines(
                  controller.signal,
                  mode === "refresh",
                );
          if (
            !mountedRef.current ||
            !enabledRef.current ||
            !pageIsVisible() ||
            requestRef.current !== request ||
            generationRef.current !== generation ||
            fingerprintRef.current !== requestFingerprint
          ) {
            return;
          }

          const next = reconcileReleasePipelineList(
            releasesRef.current,
            snapshot,
          );
          const snapshots = new Map(
            snapshot.releases.map((release) => [
              releasePipelineIdentity(release),
              release.pipeline,
            ]),
          );
          const current = new Map(
            next.map((release) => [releasePipelineIdentity(release), release]),
          );
          for (const [identity] of previousConfirmations) {
            const incoming = snapshots.get(identity);
            const release = current.get(identity);
            if (!incoming || !release) continue;
            if (isReleasePipelineActive(release.pipeline)) {
              confirmationsRef.current.delete(identity);
            } else if (incoming.lookup !== "unavailable") {
              confirmationsRef.current.delete(identity);
            }
          }
          for (const identity of previousActive) {
            const incoming = snapshots.get(identity);
            const release = current.get(identity);
            if (
              incoming &&
              incoming.lookup !== "unavailable" &&
              release &&
              !isReleasePipelineActive(release.pipeline)
            ) {
              confirmationsRef.current.set(identity, incoming.checkedAt);
            }
          }
          releasesRef.current = next;
          failuresRef.current = 0;
          onSnapshotRef.current(snapshot);
        } catch {
          // Pipeline refreshes are opportunistic and never replace the release
          // membership error surface.
          failuresRef.current += 1;
        } finally {
          if (requestRef.current !== request) return;
          requestRef.current = null;

          if (
            mountedRef.current &&
            enabledRef.current &&
            pageIsVisible() &&
            generationRef.current === generation &&
            fingerprintRef.current === requestFingerprint
          ) {
            schedule();
          }
        }
      })();
      requestRef.current = request;
      return request.promise;
    },
    [clearTimer, schedule],
  );

  refreshRef.current = refresh;

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibility = () => {
      if (!pageIsVisible()) {
        invalidate();
        return;
      }

      if (
        enabledRef.current &&
        (hasTargetedReleasePipelines(releasesRef.current) ||
          confirmationsRef.current.size > 0)
      ) {
        void refreshRef.current("discover");
      }
    };
    const handleFocus = () => {
      if (
        pageIsVisible() &&
        enabledRef.current &&
        (hasTargetedReleasePipelines(releasesRef.current) ||
          confirmationsRef.current.size > 0)
      ) {
        void refreshRef.current("discover");
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      invalidate();
    };
  }, [invalidate]);

  useEffect(() => {
    const previous = configurationRef.current;
    const identityChanged = previous.fingerprint !== fingerprint;
    const expanded = !previous.enabled && enabled;
    const collapsed = previous.enabled && !enabled;
    const revisionChanged = previous.refreshRevision !== refreshRevision;
    configurationRef.current = { enabled, fingerprint, refreshRevision };

    if (collapsed || identityChanged) invalidate();
    if (!enabled || releases.length === 0 || !pageIsVisible()) return;

    if (identityChanged || expanded || revisionChanged) {
      void refreshRef.current(revisionChanged ? "refresh" : "discover");
    }
  }, [enabled, fingerprint, invalidate, refreshRevision, releases.length]);

  useEffect(() => {
    if (!enabled || releases.length === 0 || !pageIsVisible()) {
      clearTimer();
      return;
    }

    if (!requestRef.current && timerRef.current === null) schedule();
  }, [clearTimer, enabled, fingerprint, releases, schedule]);

  return useMemo(
    () => ({
      refresh: () => refresh("refresh"),
    }),
    [refresh],
  );
};
