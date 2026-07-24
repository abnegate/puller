import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentLabel } from "./agent";
import {
  cancelReleaseVerification,
  cancelVerification,
  streamReleaseVerification,
  streamVerification,
} from "./api";
import {
  reconcileRecentReleasePipeline,
  releasePipelineIdentity,
} from "./release-pipelines";
import type {
  Agent,
  RecentRelease,
  RecentReleasesResponse,
  ReleaseVerificationEvent,
  ReleasedPull,
  VerificationRunEvent,
  VerificationRunRequest,
} from "./types";

export type VerificationStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "limited"
  | "existing"
  | "membership-changed";

export type ReleaseVerificationBatchStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ReleaseVerificationBatchState = {
  agent: Agent;
  batchId: string | null;
  cancelling: boolean;
  error: string | null;
  errors: number;
  existing: number;
  settled: number;
  status: ReleaseVerificationBatchStatus;
  total: number;
};

export type ReleaseVerificationBatches = {
  cancel: (release: RecentRelease) => Promise<void>;
  pullStates: ReadonlyMap<string, VerificationRunState>;
  start: (release: RecentRelease) => Promise<void>;
  states: ReadonlyMap<string, ReleaseVerificationBatchState>;
};

export type VerificationRunState = {
  agent: Agent;
  cancelling: boolean;
  output: string;
  runId: string | null;
  status: VerificationStatus;
};

export type VerificationRuns = {
  cancel: (key: string) => Promise<void>;
  start: (release: RecentRelease, pull: ReleasedPull) => Promise<void>;
  states: ReadonlyMap<string, VerificationRunState>;
};

type Runtime = {
  agent: Agent;
  cancellationController: AbortController | null;
  generation: number;
  runId: string | null;
  streamController: AbortController;
};

type BatchRuntime = {
  agent: Agent;
  batchId: string | null;
  cancellationController: AbortController | null;
  generation: number;
  members: Set<string>;
  streamController: AbortController;
};

export const IDLE_VERIFICATION_STATE: VerificationRunState = Object.freeze({
  agent: "claude",
  cancelling: false,
  output: "",
  runId: null,
  status: "idle",
});

export const IDLE_RELEASE_VERIFICATION_STATE: ReleaseVerificationBatchState =
  Object.freeze({
    agent: "claude",
    batchId: null,
    cancelling: false,
    error: null,
    errors: 0,
    existing: 0,
    settled: 0,
    status: "idle",
    total: 0,
  });

export const verificationKey = (
  release: Pick<RecentRelease, "id">,
  pull: Pick<ReleasedPull, "url">,
): string => `${release.id}\n${pull.url}`;

export const releaseVerificationKey = (
  release: Pick<RecentRelease, "id" | "repository" | "tag">,
): string =>
  `${release.repository.toLowerCase()}\n${release.id}\n${release.tag}`;

export const isVerificationActive = (
  state?: Pick<VerificationRunState, "status">,
): boolean => state?.status === "starting" || state?.status === "running";

export const canVerifyRelease = (
  release: Pick<RecentRelease, "complete" | "pulls" | "source">,
  pull: Pick<ReleasedPull, "url">,
): boolean =>
  release.pulls.some((listed) => listed.url === pull.url) &&
  (release.source === "notes-fallback" ||
    (release.complete && release.source === "comparison"));

export const canVerifyEntireRelease = (
  release: Pick<
    RecentRelease,
    "id" | "pulls" | "repository" | "source" | "tag"
  >,
): boolean =>
  release.source !== "unavailable" &&
  /^[1-9][0-9]*$/.test(release.id) &&
  /^[^/\s]+\/[^/\s]+$/.test(release.repository) &&
  release.tag.trim().length > 0 &&
  release.pulls.length > 0 &&
  release.pulls.every(
    (pull) =>
      pull.number > 0 &&
      /^[0-9a-f]{40}$/i.test(pull.headSha) &&
      pull.repository.toLowerCase() === release.repository.toLowerCase() &&
      pull.url.length > 0,
  );

const mergeReleasedPulls = (
  previous: readonly ReleasedPull[],
  incoming: readonly ReleasedPull[],
): { pulls: ReleasedPull[]; retained: boolean } => {
  const next = new Map(incoming.map((pull) => [pull.url, pull]));
  let retained = false;

  for (const pull of previous) {
    if (!next.has(pull.url)) {
      next.set(pull.url, pull);
      retained = true;
    }
  }

  return { pulls: [...next.values()], retained };
};

export const RECENT_RELEASE_WINDOW = 7 * 24 * 60 * 60 * 1000;

const releasesWithinWindow = (
  releases: RecentRelease[],
  generatedAt: string,
): RecentRelease[] => {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return releases;

  const cutoff = generated - RECENT_RELEASE_WINDOW;
  const filtered = releases.filter((release) => {
    const published = Date.parse(release.publishedAt);
    return !Number.isFinite(published) || published >= cutoff;
  });

  return filtered.length === releases.length ? releases : filtered;
};

const newestReleasesFirst = (releases: RecentRelease[]): RecentRelease[] =>
  releases
    .map((release, index) => ({
      index,
      published: Date.parse(release.publishedAt),
      release,
    }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.published);
      const rightValid = Number.isFinite(right.published);
      if (leftValid && rightValid) {
        const difference = right.published - left.published;
        if (difference !== 0) return difference;
      } else if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ release }) => release);

export const reconcileRecentReleases = (
  previous: RecentReleasesResponse | null,
  incoming: RecentReleasesResponse,
): RecentReleasesResponse => {
  const scopedReleases = releasesWithinWindow(
    incoming.releases,
    incoming.generatedAt,
  );
  const previousReleases = previous
    ? releasesWithinWindow(previous.releases, incoming.generatedAt)
    : [];
  const previousByIdentity = new Map(
    previousReleases.map((release) => [
      releasePipelineIdentity(release),
      release,
    ]),
  );
  const incomingReleases = scopedReleases.map((release) =>
    reconcileRecentReleasePipeline(
      previousByIdentity.get(releasePipelineIdentity(release)),
      release,
    ),
  );
  const scopedIncoming =
    incomingReleases.every(
      (release, index) => release === incoming.releases[index],
    ) && incomingReleases.length === incoming.releases.length
      ? incoming
      : { ...incoming, releases: incomingReleases };
  if (!previous || !incoming.partial) return scopedIncoming;

  const known = new Map(
    previousReleases.map((release) => [
      releasePipelineIdentity(release),
      release,
    ]),
  );
  const releases = incomingReleases.map((release) => {
    const identity = releasePipelineIdentity(release);
    const prior = known.get(identity);
    known.delete(identity);
    if (!prior) return release;

    const merged = mergeReleasedPulls(prior.pulls, release.pulls);
    if (!merged.retained) return release;

    return {
      ...release,
      complete: false,
      pulls: merged.pulls,
      warning:
        release.warning ??
        "This partial refresh omitted previously known pull requests; their membership is retained until a complete refresh.",
    };
  });

  for (const release of known.values()) {
    releases.push({
      ...release,
      complete: false,
      warning:
        release.warning ??
        "This release was omitted from the partial refresh and is retained until a complete refresh.",
    });
  }

  return { ...incoming, releases: newestReleasesFirst(releases) };
};

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

const append = (current: string, value: string, line = true): string => {
  if (!value) return current;
  if (!line) return current + value;

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${prefix}${value}\n`;
};

const formatEvent = (event: VerificationRunEvent): string | null => {
  switch (event.type) {
    case "text":
      return event.text;
    case "tool":
      return `[tool] ${event.name}${event.status ? ` — ${event.status}` : ""}`;
    case "diagnostic":
      return `[diagnostic] ${event.text}`;
    case "error":
      return `[error] ${event.message}`;
    case "limit":
      return `[limit] ${event.message}`;
    case "start":
    case "complete":
    case "cancelled":
      return null;
  }
};

const requestFor = (
  agent: Agent,
  release: RecentRelease,
  pull: ReleasedPull,
): VerificationRunRequest => ({
  agent,
  headSha: pull.headSha,
  pullNumber: pull.number,
  pullUrl: pull.url,
  releaseId: release.id,
  repository: release.repository,
  tag: release.tag,
});

export function useVerificationRuns(
  releases: readonly RecentRelease[],
  authoritative = true,
  agent: Agent = "claude",
): VerificationRuns {
  const [states, setStates] = useState<Map<string, VerificationRunState>>(
    () => new Map(),
  );
  const statesRef = useRef(states);
  const runtimesRef = useRef(new Map<string, Runtime>());
  const cancellationsRef = useRef(new Set<AbortController>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const keySignature = releases
    .flatMap((release) =>
      release.pulls.map((pull) => verificationKey(release, pull)),
    )
    .sort()
    .join("\u0000");
  const present = useMemo(
    () => new Set(keySignature ? keySignature.split("\u0000") : []),
    [keySignature],
  );

  const publish = useCallback(
    (
      update: (
        current: ReadonlyMap<string, VerificationRunState>,
      ) => Map<string, VerificationRunState>,
    ) => {
      const next = update(statesRef.current);
      if (next === statesRef.current) return;

      statesRef.current = next;
      if (mountedRef.current) setStates(next);
    },
    [],
  );

  const current = useCallback(
    (key: string, runtime: Runtime): boolean =>
      runtimesRef.current.get(key)?.generation === runtime.generation,
    [],
  );

  const update = useCallback(
    (
      key: string,
      runtime: Runtime,
      change: (state: VerificationRunState) => VerificationRunState,
    ): boolean => {
      if (!current(key, runtime)) return false;

      publish((existing) => {
        if (!current(key, runtime)) {
          return existing as Map<string, VerificationRunState>;
        }

        const next = new Map(existing);
        next.set(key, change(existing.get(key) ?? IDLE_VERIFICATION_STATE));
        return next;
      });
      return true;
    },
    [current, publish],
  );

  const purge = useCallback(
    (key: string) => {
      publish((existing) => {
        if (!existing.has(key)) {
          return existing as Map<string, VerificationRunState>;
        }

        const next = new Map(existing);
        next.delete(key);
        return next;
      });
    },
    [publish],
  );

  const cancelDetached = useCallback((runId: string) => {
    const controller = new AbortController();
    cancellationsRef.current.add(controller);
    void cancelVerification(runId, controller.signal)
      .catch(() => undefined)
      .finally(() => cancellationsRef.current.delete(controller));
  }, []);

  const discard = useCallback(
    (key: string, purgeState: boolean) => {
      const runtime = runtimesRef.current.get(key);
      if (runtime) runtimesRef.current.delete(key);
      if (purgeState) purge(key);
      if (!runtime) return;

      runtime.cancellationController?.abort();
      runtime.streamController.abort();
      if (runtime.runId) cancelDetached(runtime.runId);
    },
    [cancelDetached, purge],
  );

  const start = useCallback(
    async (release: RecentRelease, pull: ReleasedPull) => {
      if (!canVerifyRelease(release, pull)) return;

      const key = verificationKey(release, pull);
      const state = statesRef.current.get(key) ?? IDLE_VERIFICATION_STATE;
      if (isVerificationActive(state)) return;

      const runtime: Runtime = {
        agent,
        cancellationController: null,
        generation: ++generationRef.current,
        runId: null,
        streamController: new AbortController(),
      };
      runtimesRef.current.set(key, runtime);
      update(key, runtime, () => ({
        agent: runtime.agent,
        cancelling: false,
        output: "",
        runId: null,
        status: "starting",
      }));

      let ended = false;
      try {
        for await (const event of streamVerification(
          requestFor(runtime.agent, release, pull),
          runtime.streamController.signal,
        )) {
          if (!current(key, runtime)) return;

          if (event.type === "start") {
            runtime.runId = event.runId;
            update(key, runtime, (existing) => ({
              ...existing,
              runId: event.runId,
              status: "running",
            }));
            continue;
          }

          const formatted = formatEvent(event);
          if (formatted !== null) {
            update(key, runtime, (existing) => ({
              ...existing,
              output: append(existing.output, formatted, event.type !== "text"),
            }));
          }

          if (event.type === "complete") {
            ended = true;
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              status: event.exitCode === 0 ? "completed" : "failed",
            }));
          } else if (event.type === "error") {
            ended = true;
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              status: "failed",
            }));
          } else if (event.type === "cancelled") {
            ended = true;
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              status: "cancelled",
            }));
          } else if (event.type === "limit") {
            ended = true;
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              status: "limited",
            }));
          }
        }

        if (!ended && current(key, runtime)) {
          update(key, runtime, (existing) => ({
            ...existing,
            output: append(
              existing.output,
              `[error] ${agentLabel(runtime.agent)} disconnected before reporting completion.`,
            ),
            status: "failed",
          }));
        }
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          update(key, runtime, (existing) => ({
            ...existing,
            cancelling: false,
            output: append(
              existing.output,
              `[error] ${error instanceof Error ? error.message : `${agentLabel(runtime.agent)} verification could not be reached.`}`,
            ),
            status: "failed",
          }));
        }
      } finally {
        if (current(key, runtime)) {
          runtimesRef.current.delete(key);
          runtime.cancellationController?.abort();
        }
      }
    },
    [agent, current, update],
  );

  const cancel = useCallback(
    async (key: string) => {
      const runtime = runtimesRef.current.get(key);
      const state = statesRef.current.get(key);
      if (
        !runtime ||
        !state ||
        !isVerificationActive(state) ||
        state.cancelling
      ) {
        return;
      }

      if (!runtime.runId) {
        update(key, runtime, (existing) => ({
          ...existing,
          cancelling: false,
          status: "cancelled",
        }));
        runtimesRef.current.delete(key);
        runtime.streamController.abort();
        return;
      }

      const controller = new AbortController();
      runtime.cancellationController?.abort();
      runtime.cancellationController = controller;
      update(key, runtime, (existing) => ({
        ...existing,
        cancelling: true,
      }));

      try {
        await cancelVerification(runtime.runId, controller.signal);
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          update(key, runtime, (existing) => ({
            ...existing,
            cancelling: false,
            output: append(
              existing.output,
              `[diagnostic] ${error instanceof Error ? error.message : `${agentLabel(runtime.agent)} verification could not be cancelled.`}`,
            ),
          }));
        }
        return;
      }

      if (
        !current(key, runtime) ||
        !isVerificationActive(statesRef.current.get(key))
      ) {
        return;
      }

      update(key, runtime, (existing) => ({
        ...existing,
        cancelling: false,
        status: "cancelled",
      }));
      runtimesRef.current.delete(key);
      runtime.cancellationController = null;
      runtime.streamController.abort();
    },
    [current, update],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statesRef.current = new Map();
      const active = [...runtimesRef.current.values()];
      runtimesRef.current.clear();
      for (const runtime of active) {
        runtime.cancellationController?.abort();
        runtime.streamController.abort();
        if (runtime.runId) cancelDetached(runtime.runId);
      }
      for (const controller of cancellationsRef.current) controller.abort();
      cancellationsRef.current.clear();
    };
  }, [cancelDetached]);

  useEffect(() => {
    if (!authoritative) return;

    const stored = new Set([
      ...statesRef.current.keys(),
      ...runtimesRef.current.keys(),
    ]);
    for (const key of stored) {
      if (!present.has(key)) discard(key, true);
    }
  }, [authoritative, discard, present]);

  return useMemo(() => ({ cancel, start, states }), [cancel, start, states]);
}

const isReleaseBatchActive = (
  state?: Pick<ReleaseVerificationBatchState, "status">,
): boolean => state?.status === "starting" || state?.status === "running";

const batchStatus = (
  event: Extract<ReleaseVerificationEvent, { type: "verification" }>,
): VerificationStatus => {
  switch (event.state) {
    case "queued":
      return "starting";
    case "running":
      return "running";
    case "complete":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return event.event?.type === "limit" ? "limited" : "failed";
    case "existing":
      return "existing";
  }
};

const batchOutput = (
  current: string,
  event: Extract<ReleaseVerificationEvent, { type: "verification" }>,
): string => {
  if (event.message) {
    return append(
      current,
      `${event.state === "error" ? "[error]" : "[diagnostic]"} ${event.message}`,
    );
  }
  if (!event.event) return current;

  const formatted = formatEvent(event.event);
  return formatted === null
    ? current
    : append(current, formatted, event.event.type !== "text");
};

const settleActiveBatchPulls = (
  existing: ReadonlyMap<string, VerificationRunState>,
  members: Iterable<string>,
  status: Extract<VerificationStatus, "cancelled" | "failed">,
  message: string,
): Map<string, VerificationRunState> => {
  const next = new Map(existing);
  let changed = false;

  for (const key of members) {
    const state = existing.get(key);
    if (!state || !isVerificationActive(state)) continue;

    next.set(key, {
      ...state,
      cancelling: false,
      output: append(
        state.output,
        `${status === "failed" ? "[error]" : "[diagnostic]"} ${message}`,
      ),
      status,
    });
    changed = true;
  }

  return changed ? next : (existing as Map<string, VerificationRunState>);
};

const countBatchErrors = (
  states: ReadonlyMap<string, VerificationRunState>,
  members: Iterable<string>,
): number =>
  [...members].filter((key) => {
    const status = states.get(key)?.status;
    return status === "failed" || status === "limited";
  }).length;

const MEMBERSHIP_CHANGED_MESSAGE =
  "Release membership changed on GitHub; this pull request is no longer included in this release.";

const preserveVerificationResult = (status: VerificationStatus): boolean =>
  status === "completed" || status === "existing";

export function useReleaseVerificationBatches(
  releases: readonly RecentRelease[],
  authoritative = true,
  agent: Agent = "claude",
  directStates: ReadonlyMap<string, VerificationRunState> = new Map(),
): ReleaseVerificationBatches {
  const [states, setStates] = useState<
    Map<string, ReleaseVerificationBatchState>
  >(() => new Map());
  const [pullStates, setPullStates] = useState<
    Map<string, VerificationRunState>
  >(() => new Map());
  const statesRef = useRef(states);
  const pullStatesRef = useRef(pullStates);
  const directStatesRef = useRef(directStates);
  const runtimesRef = useRef(new Map<string, BatchRuntime>());
  const batchMembersRef = useRef(new Map<string, Set<string>>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const presentReleases = useMemo(
    () => new Set(releases.map(releaseVerificationKey)),
    [releases],
  );
  const presentPulls = useMemo(
    () =>
      new Set(
        releases.flatMap((release) =>
          release.pulls.map((pull) => verificationKey(release, pull)),
        ),
      ),
    [releases],
  );
  directStatesRef.current = directStates;

  const publishStates = useCallback(
    (
      change: (
        current: ReadonlyMap<string, ReleaseVerificationBatchState>,
      ) => Map<string, ReleaseVerificationBatchState>,
    ) => {
      const next = change(statesRef.current);
      if (next === statesRef.current) return;
      statesRef.current = next;
      if (mountedRef.current) setStates(next);
    },
    [],
  );
  const publishPulls = useCallback(
    (
      change: (
        current: ReadonlyMap<string, VerificationRunState>,
      ) => Map<string, VerificationRunState>,
    ) => {
      const next = change(pullStatesRef.current);
      if (next === pullStatesRef.current) return;
      pullStatesRef.current = next;
      if (mountedRef.current) setPullStates(next);
    },
    [],
  );
  const current = useCallback(
    (key: string, runtime: BatchRuntime): boolean =>
      runtimesRef.current.get(key)?.generation === runtime.generation,
    [],
  );
  const updateState = useCallback(
    (
      key: string,
      runtime: BatchRuntime,
      change: (
        state: ReleaseVerificationBatchState,
      ) => ReleaseVerificationBatchState,
    ) => {
      if (!current(key, runtime)) return;
      publishStates((existing) => {
        if (!current(key, runtime)) {
          return existing as Map<string, ReleaseVerificationBatchState>;
        }
        const next = new Map(existing);
        next.set(
          key,
          change(existing.get(key) ?? IDLE_RELEASE_VERIFICATION_STATE),
        );
        return next;
      });
    },
    [current, publishStates],
  );

  const start = useCallback(
    async (release: RecentRelease) => {
      if (!canVerifyEntireRelease(release)) return;
      const key = releaseVerificationKey(release);
      if (
        isReleaseBatchActive(statesRef.current.get(key)) ||
        release.pulls.some((pull) =>
          isVerificationActive(
            directStatesRef.current.get(verificationKey(release, pull)),
          ),
        )
      ) {
        return;
      }

      const runtime: BatchRuntime = {
        agent,
        batchId: null,
        cancellationController: null,
        generation: ++generationRef.current,
        members: new Set(
          release.pulls.map((pull) => verificationKey(release, pull)),
        ),
        streamController: new AbortController(),
      };
      runtimesRef.current.set(key, runtime);
      updateState(key, runtime, () => ({
        ...IDLE_RELEASE_VERIFICATION_STATE,
        agent: runtime.agent,
        status: "starting",
        total: release.pulls.length,
      }));

      publishPulls((existing) => {
        const next = new Map(existing);
        for (const pull of release.pulls) {
          const pullKey = verificationKey(release, pull);
          const previous = existing.get(pullKey);
          if (previous && preserveVerificationResult(previous.status)) {
            continue;
          }
          next.set(pullKey, {
            ...IDLE_VERIFICATION_STATE,
            agent: runtime.agent,
            status: "starting",
          });
        }
        return next;
      });

      try {
        for await (const event of streamReleaseVerification(
          {
            agent: runtime.agent,
            releaseId: release.id,
            repository: release.repository,
            tag: release.tag,
          },
          runtime.streamController.signal,
        )) {
          if (!current(key, runtime)) return;

          if (event.type === "batch-start") {
            runtime.batchId = event.batchId;
            const members = new Set(
              event.pulls.map((pull) =>
                verificationKey(release, { url: pull.pullUrl }),
              ),
            );
            runtime.members = members;
            batchMembersRef.current.set(key, members);
            publishPulls((existing) => {
              const next = new Map(existing);
              let changed = false;

              for (const pull of release.pulls) {
                const pullKey = verificationKey(release, pull);
                const previous = existing.get(pullKey);
                if (
                  members.has(pullKey) ||
                  !previous ||
                  !isVerificationActive(previous)
                ) {
                  continue;
                }
                next.set(pullKey, {
                  ...previous,
                  cancelling: false,
                  output: append(
                    previous.output,
                    `[diagnostic] ${MEMBERSHIP_CHANGED_MESSAGE}`,
                  ),
                  status: "membership-changed",
                });
                changed = true;
              }

              for (const pullKey of members) {
                const previous = existing.get(pullKey);
                if (
                  previous &&
                  (isVerificationActive(previous) ||
                    preserveVerificationResult(previous.status))
                ) {
                  continue;
                }
                next.set(pullKey, {
                  ...IDLE_VERIFICATION_STATE,
                  agent: runtime.agent,
                  status: "starting",
                });
                changed = true;
              }

              return changed
                ? next
                : (existing as Map<string, VerificationRunState>);
            });
            updateState(key, runtime, (state) => ({
              ...state,
              batchId: event.batchId,
              status: "running",
              total: event.pulls.length,
            }));
            continue;
          }

          if (event.type === "verification") {
            const pullKey = verificationKey(release, { url: event.pullUrl });
            if (!runtime.members.has(pullKey)) continue;
            publishPulls((existing) => {
              const next = new Map(existing);
              const previous = existing.get(pullKey) ?? IDLE_VERIFICATION_STATE;
              next.set(pullKey, {
                ...previous,
                cancelling: false,
                output: batchOutput(previous.output, event),
                runId:
                  event.event?.type === "start"
                    ? event.event.runId
                    : previous.runId,
                status: batchStatus(event),
              });
              return next;
            });
            const terminal = ["complete", "error", "existing"].includes(
              event.state,
            );
            if (terminal) {
              updateState(key, runtime, (state) => ({
                ...state,
                settled: Math.min(state.total, state.settled + 1),
              }));
            }
            continue;
          }

          if (event.type === "complete") {
            updateState(key, runtime, (state) => ({
              ...state,
              cancelling: false,
              errors: event.totals.error,
              existing: event.totals.existing,
              settled: event.totals.total,
              status: "completed",
              total: event.totals.total,
            }));
          } else {
            const message =
              event.message || "Release verification was cancelled.";
            updateState(key, runtime, (state) => ({
              ...state,
              cancelling: false,
              error: message,
              settled: state.total,
              status: "cancelled",
            }));
            publishPulls((existing) =>
              settleActiveBatchPulls(
                existing,
                runtime.members,
                "cancelled",
                message,
              ),
            );
          }
        }
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          const message =
            error instanceof Error
              ? error.message
              : "Release verification could not be reached.";
          publishPulls((existing) =>
            settleActiveBatchPulls(
              existing,
              runtime.members,
              "failed",
              `Release verification failed: ${message}`,
            ),
          );
          updateState(key, runtime, (state) => ({
            ...state,
            cancelling: false,
            error: message,
            errors: countBatchErrors(pullStatesRef.current, runtime.members),
            settled: state.total,
            status: "failed",
          }));
        }
      } finally {
        if (current(key, runtime)) {
          runtimesRef.current.delete(key);
          runtime.cancellationController?.abort();
        }
      }
    },
    [agent, current, publishPulls, updateState],
  );

  const cancel = useCallback(
    async (release: RecentRelease) => {
      const key = releaseVerificationKey(release);
      const runtime = runtimesRef.current.get(key);
      const state = statesRef.current.get(key);
      if (
        !runtime ||
        !state ||
        !isReleaseBatchActive(state) ||
        state.cancelling
      ) {
        return;
      }

      if (!runtime.batchId) {
        const message = "Release verification cancelled before it started.";
        publishPulls((existing) =>
          settleActiveBatchPulls(
            existing,
            runtime.members,
            "cancelled",
            message,
          ),
        );
        updateState(key, runtime, (currentState) => ({
          ...currentState,
          cancelling: false,
          error: message,
          settled: currentState.total,
          status: "cancelled",
        }));
        runtimesRef.current.delete(key);
        runtime.streamController.abort();
        return;
      }

      const controller = new AbortController();
      runtime.cancellationController?.abort();
      runtime.cancellationController = controller;
      updateState(key, runtime, (currentState) => ({
        ...currentState,
        cancelling: true,
      }));
      try {
        await cancelReleaseVerification(runtime.batchId, controller.signal);
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          updateState(key, runtime, (currentState) => ({
            ...currentState,
            cancelling: false,
            error:
              error instanceof Error
                ? error.message
                : "Release verification could not be cancelled.",
          }));
        }
        return;
      }

      if (!current(key, runtime)) return;
      const message = "Release verification cancelled.";
      publishPulls((existing) =>
        settleActiveBatchPulls(existing, runtime.members, "cancelled", message),
      );
      updateState(key, runtime, (currentState) => ({
        ...currentState,
        cancelling: false,
        error: message,
        settled: currentState.total,
        status: "cancelled",
      }));
      runtimesRef.current.delete(key);
      runtime.cancellationController = null;
      runtime.streamController.abort();
    },
    [current, publishPulls, updateState],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const runtime of runtimesRef.current.values()) {
        runtime.cancellationController?.abort();
        runtime.streamController.abort();
      }
      runtimesRef.current.clear();
      batchMembersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!authoritative) return;
    for (const [key, runtime] of runtimesRef.current) {
      if (!presentReleases.has(key)) {
        runtime.cancellationController?.abort();
        runtime.streamController.abort();
        runtimesRef.current.delete(key);
      }
    }
    const acceptedPulls = new Set(presentPulls);
    for (const [key, members] of batchMembersRef.current) {
      if (!presentReleases.has(key)) {
        batchMembersRef.current.delete(key);
        continue;
      }
      for (const member of members) acceptedPulls.add(member);
    }
    publishStates((existing) => {
      const next = new Map(
        [...existing].filter(([key]) => presentReleases.has(key)),
      );
      return next.size === existing.size
        ? (existing as Map<string, ReleaseVerificationBatchState>)
        : next;
    });
    publishPulls((existing) => {
      const next = new Map(
        [...existing].filter(([key]) => acceptedPulls.has(key)),
      );
      return next.size === existing.size
        ? (existing as Map<string, VerificationRunState>)
        : next;
    });
  }, [
    authoritative,
    presentPulls,
    presentReleases,
    publishPulls,
    publishStates,
  ]);

  return useMemo(
    () => ({ cancel, pullStates, start, states }),
    [cancel, pullStates, start, states],
  );
}
