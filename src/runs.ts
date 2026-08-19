import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentLabel, isAgent } from "./agent";
import { cancelRepair, streamRepair } from "./api";
import {
  cancelAgentRun,
  ClaudeRunHttpError,
  streamAgentRun,
  type AgentRunEvent,
  type AgentRunRequest,
  DEFAULT_FIX_INSTRUCTIONS,
  RATE_LIMIT_EVENT_CODE,
  isRateLimitMessage,
  type AutoParallelism,
  type AutoTrigger,
  type ReviewFeedback,
  type RunSource,
} from "./fixes";
import {
  browserRunTranscriptStore,
  RunTranscriptStoreError,
  type RunTranscriptFailureCode,
  type RunTranscriptStore,
} from "./run-transcripts";
import type {
  Agent,
  MergePullRepairResponse,
  PullReadiness,
  RepairEvent,
  RepairState,
} from "./types";

export type RunStatus =
  | "idle"
  | "preparing"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "limited";

export type RunTerminalStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled" | "limited"
>;

export type RunInstructions =
  | {
      kind: "manual";
      text: string;
    }
  | {
      feedback: Readonly<ReviewFeedback>;
      kind: "review";
      message: string;
    }
  | {
      kind: "auto";
      message: string;
      triggers: readonly Readonly<AutoTrigger>[];
    };

export type RunHistoryEntry = {
  agent: Agent;
  finishedAt: string;
  headRefOid: string;
  id: string;
  instructions: RunInstructions;
  source: RunSource;
  status: RunTerminalStatus;
  transcript:
    | Readonly<{
        availability: "available";
        bytes: number;
        key: string;
      }>
    | Readonly<{
        availability: "unavailable";
        bytes: number;
        code: RunTranscriptFailureCode;
        message: string;
      }>;
};

export type ReviewAttemptToken = string;

export type ReviewRetryContext = Readonly<{
  attemptToken: ReviewAttemptToken;
  baseRefOid: string;
  draft: string;
  feedback: Readonly<ReviewFeedback>;
  headRefOid: string;
  runId: string;
  status: Exclude<RunTerminalStatus, "completed">;
}>;

export type StartRunOptions =
  | {
      message?: string;
      parallelism?: never;
      source?: "manual";
      triggers?: never;
    }
  | {
      agent: Agent;
      message?: string;
      parallelism: AutoParallelism;
      source: "auto";
      triggers: readonly AutoTrigger[];
    }
  | {
      draft?: string;
      expectedBaseRefOid: string;
      feedback: ReviewFeedback;
      message?: string;
      parallelism?: never;
      source: "review";
      triggers?: never;
    };

export type RunStartOutcome =
  | {
      kind: "accepted";
      completion: Promise<RunTerminalStatus>;
      runId: string;
      source: RunSource;
      status: "running";
    }
  | {
      kind: "accepted-equivalent";
      code: "auto_triggers_running";
      message: string;
      source: RunSource;
    }
  | {
      kind: "retryable";
      code:
        | "auto_running"
        | "pull_running"
        | "run_limit"
        | "workspace_running"
        | "snapshot_incomplete"
        | "snapshot_unavailable"
        | "transport";
      message: string;
      source: RunSource;
    }
  | {
      kind: "rebaseline";
      code: "head_changed" | "pull_ready" | "auto_trigger_stale";
      message: string;
      source: RunSource;
    }
  | {
      kind: "prune";
      code: "pull_missing";
      message: string;
      source: RunSource;
    }
  | {
      kind: "failed";
      code: string | null;
      message: string;
      source: RunSource;
    };

export type RunRateLimit = Readonly<{
  agent: Agent;
  message: string;
}>;

export type RunState = {
  actionId: string | null;
  agent: Agent;
  cancelling: boolean;
  headRefOid: string | null;
  history: readonly RunHistoryEntry[];
  kind: "fix" | "repair";
  message: string;
  output: string;
  rateLimit: RunRateLimit | null;
  repairState: RepairState | null;
  reviewAttemptToken: ReviewAttemptToken | null;
  reviewRetry: ReviewRetryContext | null;
  source: RunSource;
  status: RunStatus;
};

export type PullGroups = {
  blocked: PullReadiness[];
  progress: PullReadiness[];
  ready: PullReadiness[];
};

export type PullRuns = {
  cancel: (key: string) => Promise<void>;
  clearReviewRetry: (key: string, attemptToken: ReviewAttemptToken) => void;
  loadTranscript: (
    entry: Pick<RunHistoryEntry, "transcript">,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  observeRepair: (
    pull: PullReadiness,
    response: MergePullRepairResponse,
  ) => Promise<void>;
  setMessage: (key: string, message: string) => void;
  start: (
    pull: PullReadiness,
    options?: StartRunOptions,
  ) => Promise<RunStartOutcome>;
  states: ReadonlyMap<string, RunState>;
};

export type PullRunOptions = {
  agent?: Agent;
  authoritative?: boolean;
  transcriptStore?: RunTranscriptStore;
};

type Runtime = {
  accepted: boolean;
  action: MergePullRepairResponse["action"] | null;
  agent: Agent;
  archive: Promise<void> | null;
  attemptToken: ReviewAttemptToken | null;
  baseRefOid: string | null;
  cancellationController: AbortController | null;
  finalize: (
    status: RunTerminalStatus,
    output?: { line: boolean; text: string },
  ) => boolean;
  finalized: boolean;
  generation: number;
  headRefOid: string | null;
  instructions: RunInstructions | null;
  kind: "fix" | "repair";
  pull: PullReadiness | null;
  pendingTranscriptKey: string | null;
  rateLimit: RunRateLimit | null;
  reviewDraft: string | null;
  reviewFeedback: Readonly<ReviewFeedback> | null;
  runId: string | null;
  source: RunSource;
  streamController: AbortController;
  triggers: ReadonlySet<string> | null;
};

const EMPTY_RUN_HISTORY: readonly RunHistoryEntry[] = Object.freeze([]);
const textEncoder = new TextEncoder();

export const IDLE_RUN_STATE: RunState = Object.freeze({
  actionId: null,
  agent: "claude",
  cancelling: false,
  headRefOid: null,
  history: EMPTY_RUN_HISTORY,
  kind: "fix",
  message: "",
  output: "",
  rateLimit: null,
  repairState: null,
  reviewAttemptToken: null,
  reviewRetry: null,
  source: "manual",
  status: "idle",
});

export const isRunActive = (state?: Pick<RunState, "status">): boolean =>
  state?.status === "preparing" ||
  state?.status === "starting" ||
  state?.status === "running";

export const isRunPreparing = (state?: Pick<RunState, "status">): boolean =>
  state?.status === "preparing";

export const isRunExecuting = (state?: Pick<RunState, "status">): boolean =>
  state?.status === "running";

const comparePulls = (first: PullReadiness, second: PullReadiness): number =>
  first.rank - second.rank ||
  (first.url < second.url ? -1 : first.url > second.url ? 1 : 0);

export const reconcilePulls = (
  previous: readonly PullReadiness[],
  incoming: readonly PullReadiness[],
  authoritative: boolean,
): PullReadiness[] => {
  const pulls = new Map<string, PullReadiness>(
    authoritative ? [] : previous.map((pull) => [pull.url, pull]),
  );

  for (const pull of incoming) {
    pulls.set(pull.url, pull);
  }

  return [...pulls.values()].sort(comparePulls);
};

export const groupPulls = (
  pulls: readonly PullReadiness[],
  states: ReadonlyMap<string, RunState>,
): PullGroups => {
  const groups: PullGroups = { blocked: [], progress: [], ready: [] };
  const seen = new Set<string>();
  const ordered = [...pulls].sort(comparePulls);

  for (const pull of ordered) {
    if (seen.has(pull.url)) {
      continue;
    }

    seen.add(pull.url);
    const run = states.get(pull.url);
    const repairTerminal =
      run?.kind === "repair" &&
      (run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "limited");
    const repairPending =
      run?.kind === "repair" &&
      (isRunActive(run) || run.status === "completed");
    const fixInProgress =
      run !== undefined &&
      run.kind !== "repair" &&
      isRunActive(run) &&
      !isRunPreparing(run);

    if (
      pull.ci.state === "pending" ||
      (pull.ci.running ?? 0) > 0 ||
      repairPending ||
      fixInProgress
    ) {
      groups.progress.push(pull);
    } else if (pull.ready && !repairTerminal) {
      groups.ready.push(pull);
    } else {
      groups.blocked.push(pull);
    }
  }

  return groups;
};

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

const triggerFingerprint = (trigger: AutoTrigger): string => {
  if (trigger.kind === "issue_comment") {
    return JSON.stringify([trigger.kind, trigger.id, trigger.updatedAt]);
  }
  if (trigger.kind === "review_comment") {
    return JSON.stringify([
      trigger.kind,
      trigger.threadId,
      trigger.id,
      trigger.updatedAt,
    ]);
  }
  if (trigger.kind === "failed_check") {
    return JSON.stringify([
      trigger.kind,
      trigger.id,
      trigger.detailsUrl,
      trigger.headRefOid.toLowerCase(),
    ]);
  }
  return JSON.stringify([
    trigger.kind,
    trigger.commentId,
    trigger.updatedAt,
    trigger.reviewedSha.toLowerCase(),
    trigger.confidence,
  ]);
};

const triggerSet = (triggers: readonly AutoTrigger[]): ReadonlySet<string> =>
  new Set(triggers.map(triggerFingerprint));

const matchesTriggers = (
  active: ReadonlySet<string> | null,
  requested: ReadonlySet<string>,
): boolean =>
  active !== null &&
  active.size === requested.size &&
  [...requested].every((trigger) => active.has(trigger));

const startFailure = (
  error: unknown,
  source: RunSource,
  agent: Agent,
): Exclude<RunStartOutcome, { kind: "accepted" }> => {
  const label = agentLabel(agent);
  if (!(error instanceof ClaudeRunHttpError)) {
    if (isAbortError(error)) {
      return {
        code: null,
        kind: "failed",
        message: `The ${label} run was cancelled before it started.`,
        source,
      };
    }

    return {
      code: "transport",
      kind: "retryable",
      message:
        error instanceof Error
          ? error.message
          : `${label} could not be reached before the run started.`,
      source,
    };
  }

  const { code, message } = error;
  if (code === "auto_triggers_running") {
    return { code, kind: "accepted-equivalent", message, source };
  }
  if (
    code === "auto_running" ||
    code === "pull_running" ||
    code === "run_limit" ||
    code === "workspace_running" ||
    code === "snapshot_incomplete" ||
    code === "snapshot_unavailable"
  ) {
    return { code, kind: "retryable", message, source };
  }
  if (code === "head_changed" || code === "pull_ready") {
    return { code, kind: "rebaseline", message, source };
  }
  if (code === "auto_trigger_stale" || code === "auto_triggers_stale") {
    return {
      code: "auto_trigger_stale",
      kind: "rebaseline",
      message,
      source,
    };
  }
  if (code === "pull_missing") {
    return { code, kind: "prune", message, source };
  }
  return { code, kind: "failed", message, source };
};

const codeAgentLabel = (agent: Agent): string =>
  agent === "claude" ? "Claude Code" : "Codex";

export const rateLimitFromEvent = (
  event: AgentRunEvent,
  agent: Agent,
): RunRateLimit | null => {
  if (event.type !== "error" && event.type !== "limit") return null;
  if (
    (event.type === "error" && event.code === RATE_LIMIT_EVENT_CODE) ||
    isRateLimitMessage(event.message)
  ) {
    return Object.freeze({ agent, message: event.message });
  }
  return null;
};

const formatEvent = (event: AgentRunEvent): string | null => {
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

const append = (current: string, text: string, line: boolean): string => {
  if (!text) {
    return current;
  }

  if (!line) {
    return current + text;
  }

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${prefix}${text}\n`;
};

const transcriptKey = (
  pull: Pick<PullReadiness, "number" | "repository" | "url">,
  generation: number,
  runId: string,
): string =>
  JSON.stringify([
    pull.repository.toLowerCase(),
    pull.number,
    pull.url,
    generation,
    runId,
  ]);

const transcriptFailure = (
  error: unknown,
  bytes: number,
): Extract<RunHistoryEntry["transcript"], { availability: "unavailable" }> => {
  if (error instanceof RunTranscriptStoreError) {
    return Object.freeze({
      availability: "unavailable",
      bytes,
      code: error.code,
      message: error.message,
    });
  }

  return Object.freeze({
    availability: "unavailable",
    bytes,
    code: "indexeddb_write_failed",
    message: "The run transcript could not be saved in browser storage.",
  });
};

const effectiveInstructions = (
  options: StartRunOptions,
  message: string,
): RunInstructions => {
  if (options.source === "review") {
    return Object.freeze({
      feedback: Object.freeze({ ...options.feedback }),
      kind: "review",
      message,
    });
  }

  if (options.source === "auto") {
    return Object.freeze({
      kind: "auto",
      message,
      triggers: Object.freeze(
        options.triggers.map((trigger) => Object.freeze({ ...trigger })),
      ),
    });
  }

  return Object.freeze({
    kind: "manual",
    text: message || DEFAULT_FIX_INSTRUCTIONS,
  });
};

const repairStatus = (state: RepairState): RunStatus => {
  if (state === "repair_queued") return "starting";
  if (state === "repair_running") return "running";
  if (state === "ready") return "completed";
  if (state === "cancelled") return "cancelled";
  return "failed";
};

const applyRepairEvent = (state: RunState, event: RepairEvent): RunState => {
  if (event.type === "output") {
    return { ...state, output: append(state.output, event.text, false) };
  }

  const output =
    event.type === "snapshot"
      ? event.output
      : event.message
        ? append(state.output, `[diagnostic] ${event.message}`, true)
        : state.output;
  return {
    ...state,
    cancelling: false,
    output,
    repairState: event.state,
    status: repairStatus(event.state),
  };
};

export function usePullRuns(
  pulls: readonly PullReadiness[],
  onRepairReady: (pull: PullReadiness) => void = () => undefined,
  {
    agent = "claude",
    authoritative = true,
    transcriptStore = browserRunTranscriptStore,
  }: PullRunOptions = {},
): PullRuns {
  const [states, setStates] = useState<Map<string, RunState>>(() => new Map());
  const statesRef = useRef(states);
  const runtimesRef = useRef(new Map<string, Runtime>());
  const cancellationsRef = useRef(new Set<AbortController>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const identities = pulls
    .map(
      (pull) =>
        `${pull.url}\n${pull.baseRefOid.toLowerCase()}\n${pull.headRefOid.toLowerCase()}`,
    )
    .sort()
    .join("\u0000");
  const present = useMemo(
    () =>
      new Map(
        (identities ? identities.split("\u0000") : []).map((identity) => {
          const headSeparator = identity.lastIndexOf("\n");
          const baseSeparator = identity.lastIndexOf("\n", headSeparator - 1);
          return [
            identity.slice(0, baseSeparator),
            {
              baseRefOid: identity.slice(baseSeparator + 1, headSeparator),
              headRefOid: identity.slice(headSeparator + 1),
            },
          ];
        }),
      ),
    [identities],
  );
  const presentRef = useRef(present);
  const authoritativeRef = useRef(authoritative);
  presentRef.current = present;
  authoritativeRef.current = authoritative;

  const publish = useCallback(
    (
      update: (current: ReadonlyMap<string, RunState>) => Map<string, RunState>,
    ) => {
      const next = update(statesRef.current);
      if (next === statesRef.current) {
        return;
      }

      statesRef.current = next;
      if (mountedRef.current) {
        setStates(next);
      }
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
      change: (state: RunState) => RunState,
    ): boolean => {
      if (!current(key, runtime)) {
        return false;
      }

      publish((existing) => {
        if (!current(key, runtime)) {
          return existing as Map<string, RunState>;
        }

        const next = new Map(existing);
        next.set(key, change(existing.get(key) ?? IDLE_RUN_STATE));
        return next;
      });
      return true;
    },
    [current, publish],
  );

  const deleteTranscripts = useCallback(
    async (keys: readonly string[]): Promise<void> => {
      if (keys.length === 0) return;
      await transcriptStore.initialize();
      try {
        await transcriptStore.delete(keys);
      } catch (error) {
        if (!transcriptStore.retriesFailedDeletes) throw error;
        // IndexedDB records are session-tagged, so the next browser-store
        // initialization deterministically retries this cleanup.
      }
    },
    [transcriptStore],
  );

  const purge = useCallback(
    (key: string) => {
      const state = statesRef.current.get(key);
      const transcriptKeys = [
        ...(state?.history ?? []).flatMap((entry) =>
          entry.transcript.availability === "available"
            ? [entry.transcript.key]
            : [],
        ),
      ];
      publish((existing) => {
        if (!existing.has(key)) {
          return existing as Map<string, RunState>;
        }

        const next = new Map(existing);
        next.delete(key);
        return next;
      });
      if (transcriptKeys.length > 0) {
        void deleteTranscripts(transcriptKeys);
      }
    },
    [deleteTranscripts, publish],
  );

  const clearReviewRetry = useCallback(
    (key: string, attemptToken: ReviewAttemptToken) => {
      publish((existing) => {
        const state = existing.get(key);
        if (state?.reviewRetry?.attemptToken !== attemptToken) {
          return existing as Map<string, RunState>;
        }

        const next = new Map(existing);
        next.set(key, { ...state, reviewRetry: null });
        return next;
      });
    },
    [publish],
  );

  const loadTranscript = useCallback(
    async (
      entry: Pick<RunHistoryEntry, "transcript">,
      signal?: AbortSignal,
    ): Promise<string | null> => {
      if (entry.transcript.availability === "unavailable") {
        throw new RunTranscriptStoreError(
          entry.transcript.code,
          entry.transcript.message,
        );
      }
      await transcriptStore.initialize();
      return await transcriptStore.get(entry.transcript.key, signal);
    },
    [transcriptStore],
  );

  const cancelDetached = useCallback((runId: string) => {
    const controller = new AbortController();
    cancellationsRef.current.add(controller);
    void Promise.resolve(cancelAgentRun(runId, controller.signal))
      .catch(() => undefined)
      .finally(() => cancellationsRef.current.delete(controller));
  }, []);

  const discard = useCallback(
    async (key: string, purgeState: boolean): Promise<void> => {
      const runtime = runtimesRef.current.get(key);
      if (purgeState) {
        purge(key);
        if (runtime) {
          runtimesRef.current.delete(key);
        }
      }
      if (!runtime) {
        return;
      }

      if (
        !purgeState &&
        runtime.kind === "fix" &&
        runtime.accepted &&
        runtime.runId
      ) {
        const runId = runtime.runId;
        if (runtime.finalize("cancelled")) {
          await runtime.archive;
          cancelDetached(runId);
          return;
        }
      }

      runtimesRef.current.delete(key);
      runtime.cancellationController?.abort();
      runtime.streamController.abort();
      if (runtime.kind === "fix" && runtime.runId) {
        cancelDetached(runtime.runId);
      }
    },
    [cancelDetached, purge],
  );

  const resetRepair = useCallback(
    (key: string) => {
      const runtime = runtimesRef.current.get(key);
      if (runtime?.kind === "repair") {
        runtimesRef.current.delete(key);
        runtime.cancellationController?.abort();
        runtime.streamController.abort();
      }

      publish((existing) => {
        const state = existing.get(key);
        if (!state || state.kind !== "repair") {
          return existing as Map<string, RunState>;
        }

        const next = new Map(existing);
        next.set(key, {
          ...IDLE_RUN_STATE,
          history: state.history,
          message: state.message,
        });
        return next;
      });
    },
    [publish],
  );

  const setMessage = useCallback(
    (key: string, message: string) => {
      publish((existing) => {
        const state = existing.get(key) ?? IDLE_RUN_STATE;
        if (state.message === message) {
          return existing as Map<string, RunState>;
        }

        const next = new Map(existing);
        next.set(key, { ...state, message });
        return next;
      });
    },
    [publish],
  );

  const start = useCallback(
    async (
      pull: PullReadiness,
      options: StartRunOptions = {},
    ): Promise<RunStartOutcome> => {
      const key = pull.url;
      const previousState = statesRef.current.get(key);
      const state = previousState ?? IDLE_RUN_STATE;
      const source = options.source ?? "manual";
      const selectedAgent = options.source === "auto" ? options.agent : agent;
      if (!isAgent(selectedAgent)) {
        return {
          code: "agent_invalid",
          kind: "failed",
          message: "Select Claude or Codex for this automatic run.",
          source,
        };
      }
      const label = agentLabel(selectedAgent);
      const message = (
        options.message ?? (source === "manual" ? state.message : "")
      ).trim();
      if (isRunActive(state)) {
        const runtime = runtimesRef.current.get(key);
        const requested =
          options.source === "auto" ? triggerSet(options.triggers) : null;
        if (
          source === "auto" &&
          runtime?.kind === "fix" &&
          runtime.source === "auto" &&
          runtime.agent === selectedAgent &&
          runtime.headRefOid?.toLowerCase() === pull.headRefOid.toLowerCase() &&
          requested !== null &&
          matchesTriggers(runtime.triggers, requested)
        ) {
          return {
            code: "auto_triggers_running",
            kind: "accepted-equivalent",
            message:
              "These Auto incidents are already assigned to the active run.",
            source,
          };
        }
        return {
          code: "pull_running",
          kind: "retryable",
          message: `A ${codeAgentLabel(runtime?.agent ?? state.agent)} run is already active for this pull request.`,
          source,
        };
      }

      const generation = ++generationRef.current;
      const attemptToken = source === "review" ? `${key}\n${generation}` : null;
      const runtime: Runtime = {
        accepted: false,
        action: null,
        agent: selectedAgent,
        archive: null,
        attemptToken,
        baseRefOid:
          options.source === "review" ? options.expectedBaseRefOid : null,
        cancellationController: null,
        finalize: () => false,
        finalized: false,
        generation,
        headRefOid: pull.headRefOid,
        instructions: effectiveInstructions(options, message),
        kind: "fix",
        pendingTranscriptKey: null,
        pull: null,
        rateLimit: null,
        reviewDraft:
          options.source === "review"
            ? (options.draft ?? options.feedback.body)
            : null,
        reviewFeedback:
          options.source === "review"
            ? Object.freeze({ ...options.feedback })
            : null,
        runId: null,
        source,
        streamController: new AbortController(),
        triggers:
          options.source === "auto" ? triggerSet(options.triggers) : null,
      };
      runtimesRef.current.set(key, runtime);
      update(key, runtime, (existing) => ({
        ...existing,
        actionId: null,
        agent: selectedAgent,
        cancelling: false,
        headRefOid: null,
        kind: "fix",
        output: "",
        rateLimit: null,
        repairState: null,
        source,
        status: source === "review" ? "preparing" : "starting",
      }));

      let resolveAcceptance!: (outcome: RunStartOutcome) => void;
      const acceptance = new Promise<RunStartOutcome>((resolve) => {
        resolveAcceptance = resolve;
      });
      let resolveCompletion!: (status: RunTerminalStatus) => void;
      const completion = new Promise<RunTerminalStatus>((resolve) => {
        resolveCompletion = resolve;
      });
      let acceptanceSettled = false;
      let completionSettled = false;

      const settleAcceptance = (outcome: RunStartOutcome): void => {
        if (acceptanceSettled) return;
        acceptanceSettled = true;
        resolveAcceptance(outcome);
      };
      const settleCompletion = (status: RunTerminalStatus): void => {
        if (completionSettled) return;
        completionSettled = true;
        resolveCompletion(status);
      };
      const restoreAutoPreflight = (): void => {
        if (source !== "auto" || runtime.accepted || !current(key, runtime)) {
          return;
        }

        publish((existing) => {
          if (!current(key, runtime)) {
            return existing as Map<string, RunState>;
          }

          const active = existing.get(key) ?? IDLE_RUN_STATE;
          const retained = {
            history: active.history,
            message: active.message,
            reviewAttemptToken: active.reviewAttemptToken,
            reviewRetry: active.reviewRetry,
          };
          const next = new Map(existing);
          if (
            previousState === undefined &&
            retained.history.length === 0 &&
            retained.message === "" &&
            retained.reviewAttemptToken === null &&
            retained.reviewRetry === null
          ) {
            next.delete(key);
          } else {
            next.set(key, {
              ...(previousState ?? IDLE_RUN_STATE),
              ...retained,
            });
          }
          return next;
        });
      };

      runtime.finalize = (status, output): boolean => {
        if (
          runtime.finalized ||
          !runtime.accepted ||
          runtime.runId === null ||
          runtime.instructions === null ||
          !current(key, runtime)
        ) {
          return false;
        }

        runtime.finalized = true;
        const finishedAt = new Date().toISOString();
        const runId = runtime.runId;
        const instructions = runtime.instructions;
        const archivedOutput = output
          ? append(
              statesRef.current.get(key)?.output ?? "",
              output.text,
              output.line,
            )
          : (statesRef.current.get(key)?.output ?? "");
        const bytes = textEncoder.encode(archivedOutput).byteLength;
        const pendingKey =
          runtime.pendingTranscriptKey ??
          transcriptKey(pull, runtime.generation, runtime.runId);
        runtime.pendingTranscriptKey = pendingKey;
        runtime.cancellationController?.abort();
        runtime.cancellationController = null;
        runtime.streamController.abort();
        runtime.archive = (async () => {
          let transcript: RunHistoryEntry["transcript"];
          let stored = false;
          try {
            await transcriptStore.initialize();
            await transcriptStore.put(pendingKey, archivedOutput);
            stored = true;
            transcript = Object.freeze({
              availability: "available",
              bytes,
              key: pendingKey,
            });
          } catch (error) {
            transcript = transcriptFailure(error, bytes);
          }

          const identity = presentRef.current.get(key);
          const presentEnough =
            identity !== undefined || !authoritativeRef.current;
          const identityMatches =
            !authoritativeRef.current ||
            (identity !== undefined &&
              identity.baseRefOid === runtime.baseRefOid?.toLowerCase() &&
              identity.headRefOid === runtime.headRefOid?.toLowerCase());
          if (!current(key, runtime) || !presentEnough) {
            if (stored) {
              await deleteTranscripts([pendingKey]);
            }
            return;
          }

          update(key, runtime, (existing) => {
            const entry: RunHistoryEntry = Object.freeze({
              agent: runtime.agent,
              finishedAt,
              headRefOid: runtime.headRefOid ?? pull.headRefOid,
              id: runId,
              instructions,
              source: runtime.source,
              status,
              transcript,
            });
            const retryableReview =
              runtime.source === "review" &&
              status !== "completed" &&
              identityMatches &&
              runtime.attemptToken !== null &&
              runtime.baseRefOid !== null &&
              runtime.headRefOid !== null &&
              runtime.reviewDraft !== null &&
              runtime.reviewFeedback !== null;
            const reviewRetry: ReviewRetryContext | null =
              runtime.source !== "review"
                ? existing.reviewRetry
                : retryableReview
                  ? Object.freeze({
                      attemptToken: runtime.attemptToken!,
                      baseRefOid: runtime.baseRefOid!,
                      draft: runtime.reviewDraft!,
                      feedback: runtime.reviewFeedback!,
                      headRefOid: runtime.headRefOid!,
                      runId,
                      status: status as Exclude<RunTerminalStatus, "completed">,
                    })
                  : null;
            return {
              ...IDLE_RUN_STATE,
              agent: runtime.agent,
              history: Object.freeze([entry, ...existing.history]),
              message:
                runtime.source === "manual" && status === "completed"
                  ? ""
                  : existing.message,
              rateLimit: runtime.rateLimit,
              reviewAttemptToken:
                runtime.source === "review"
                  ? null
                  : existing.reviewAttemptToken,
              reviewRetry,
            };
          });
        })().finally(() => {
          runtime.pendingTranscriptKey = null;
          if (current(key, runtime)) {
            runtimesRef.current.delete(key);
          }
          settleCompletion(status);
        });
        return true;
      };

      const execute = async (): Promise<void> => {
        try {
          const base = {
            expectedHeadRefOid: pull.headRefOid,
            message,
            number: pull.number,
            repository: pull.repository,
          };
          const request: AgentRunRequest =
            options.source === "auto"
              ? {
                  ...base,
                  agent: runtime.agent,
                  parallelism: options.parallelism,
                  source: "auto",
                  triggers: options.triggers,
                }
              : options.source === "review"
                ? {
                    ...base,
                    agent: runtime.agent,
                    expectedBaseRefOid: options.expectedBaseRefOid,
                    feedback: options.feedback,
                    source: "review",
                  }
                : { ...base, agent: runtime.agent, source: "manual" };
          for await (const event of streamAgentRun(
            request,
            runtime.streamController.signal,
          )) {
            if (!current(key, runtime)) {
              settleCompletion("cancelled");
              return;
            }
            if (runtime.finalized) return;

            if (event.type === "start") {
              if (runtime.accepted) continue;
              runtime.accepted = true;
              runtime.runId = event.runId;
              runtime.pendingTranscriptKey = transcriptKey(
                pull,
                runtime.generation,
                event.runId,
              );
              update(key, runtime, (existing) => ({
                ...existing,
                headRefOid: pull.headRefOid,
                reviewAttemptToken:
                  source === "review"
                    ? runtime.attemptToken
                    : existing.reviewAttemptToken,
                reviewRetry: source === "review" ? null : existing.reviewRetry,
                status: "running",
              }));
              settleAcceptance({
                completion,
                kind: "accepted",
                runId: event.runId,
                source,
                status: "running",
              });
              continue;
            }

            let terminal: RunTerminalStatus | null = null;
            if (event.type === "complete") {
              terminal = event.exitCode === 0 ? "completed" : "failed";
            } else if (event.type === "error") {
              terminal = "failed";
            } else if (event.type === "cancelled") {
              terminal = "cancelled";
            } else if (event.type === "limit") {
              terminal = "limited";
            }

            if (terminal !== null) {
              const formatted = formatEvent(event);
              const rateLimit = rateLimitFromEvent(event, runtime.agent);
              if (rateLimit !== null) runtime.rateLimit = rateLimit;
              if (runtime.accepted) {
                runtime.finalize(
                  terminal,
                  formatted === null
                    ? undefined
                    : { line: event.type !== "text", text: formatted },
                );
                return;
              }

              update(key, runtime, (existing) => ({
                ...existing,
                cancelling: false,
                output:
                  formatted === null
                    ? existing.output
                    : append(existing.output, formatted, event.type !== "text"),
                rateLimit: rateLimit ?? existing.rateLimit,
                status: terminal,
              }));
              settleAcceptance({
                code: null,
                kind: "failed",
                message: `The ${label} run ended before it was accepted.`,
                source,
              });
              return;
            }

            const formatted = formatEvent(event);
            if (formatted !== null) {
              update(key, runtime, (existing) => ({
                ...existing,
                output: append(
                  existing.output,
                  formatted,
                  event.type !== "text",
                ),
              }));
            }
          }

          if (!runtime.finalized) {
            const error = new Error(
              runtime.accepted
                ? `${label} disconnected before reporting completion.`
                : `${label} disconnected before accepting the run.`,
            );
            if (runtime.accepted) {
              runtime.finalize("failed", {
                line: true,
                text: `[error] ${error.message}`,
              });
            } else if (current(key, runtime)) {
              update(key, runtime, (existing) => ({
                ...existing,
                cancelling: false,
                output: append(
                  existing.output,
                  `[error] ${error.message}`,
                  true,
                ),
                status: "failed",
              }));
              settleAcceptance(startFailure(error, source, runtime.agent));
            }
          }
        } catch (error) {
          if (runtime.finalized) return;

          if (runtime.accepted) {
            const finalized = runtime.finalize(
              isAbortError(error) ? "cancelled" : "failed",
              isAbortError(error)
                ? undefined
                : {
                    line: true,
                    text: `[error] ${error instanceof Error ? error.message : `${label} could not be reached.`}`,
                  },
            );
            if (!finalized && !current(key, runtime)) {
              settleCompletion("cancelled");
            }
          } else if (current(key, runtime) && !isAbortError(error)) {
            const outcome = startFailure(error, source, runtime.agent);
            if (source === "auto" && outcome.kind === "rebaseline") {
              restoreAutoPreflight();
            } else {
              update(key, runtime, (existing) => ({
                ...existing,
                cancelling: false,
                output: append(
                  existing.output,
                  `[error] ${error instanceof Error ? error.message : `${label} could not be reached.`}`,
                  true,
                ),
                status: "failed",
              }));
            }
            settleAcceptance(outcome);
          } else {
            settleAcceptance(startFailure(error, source, runtime.agent));
          }
        } finally {
          if (!acceptanceSettled) {
            settleAcceptance({
              code: null,
              kind: "failed",
              message: `The ${label} run ended before it was accepted.`,
              source,
            });
          }
          if (!completionSettled && runtime.accepted) {
            if (!current(key, runtime)) {
              settleCompletion("cancelled");
            } else if (!runtime.finalized) {
              runtime.finalize("failed", {
                line: true,
                text: `[error] ${label} disconnected before reporting completion.`,
              });
            }
          }
          if (current(key, runtime) && !runtime.finalized) {
            runtimesRef.current.delete(key);
            runtime.cancellationController?.abort();
          }
        }
      };

      void execute();
      return acceptance;
    },
    [agent, current, deleteTranscripts, publish, transcriptStore, update],
  );

  const observeRepair = useCallback(
    async (pull: PullReadiness, response: MergePullRepairResponse) => {
      const key = pull.url;
      if (
        response.repository.toLowerCase() !== pull.repository.toLowerCase() ||
        response.number !== pull.number ||
        response.headRefOid.toLowerCase() !== pull.headRefOid.toLowerCase()
      ) {
        return;
      }

      const existing = runtimesRef.current.get(key);
      if (existing?.kind === "repair") return;
      if (existing) await discard(key, false);

      const runtime: Runtime = {
        accepted: false,
        action: response.action,
        agent: response.action.agent,
        archive: null,
        attemptToken: null,
        baseRefOid: null,
        cancellationController: null,
        finalize: () => false,
        finalized: false,
        generation: ++generationRef.current,
        headRefOid: pull.headRefOid,
        instructions: null,
        kind: "repair",
        pendingTranscriptKey: null,
        pull,
        rateLimit: null,
        reviewDraft: null,
        reviewFeedback: null,
        runId: null,
        source: "auto",
        streamController: new AbortController(),
        triggers: null,
      };
      runtimesRef.current.set(key, runtime);
      update(key, runtime, (state) => ({
        ...state,
        actionId: response.action.id,
        agent: response.action.agent,
        cancelling: false,
        headRefOid: pull.headRefOid,
        kind: "repair",
        output: response.action.deduplicated
          ? "Attached to the existing automatic conflict repair.\n"
          : "Merge conflict detected. Automatic repair queued.\n",
        repairState: response.action.state,
        source: "auto",
        status: repairStatus(response.action.state),
      }));

      try {
        for await (const event of streamRepair(
          response.action,
          pull,
          runtime.streamController.signal,
        )) {
          if (!current(key, runtime)) return;
          update(key, runtime, (state) => applyRepairEvent(state, event));
          if (
            event.type !== "output" &&
            event.state === "ready" &&
            event.terminal
          ) {
            try {
              onRepairReady(pull);
            } catch {
              // A background refresh cannot change the completed repair state.
            }
          }
        }
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          update(key, runtime, (state) => ({
            ...state,
            output: append(
              state.output,
              `[error] ${error instanceof Error ? error.message : "Automatic conflict repair could not be observed."}`,
              true,
            ),
            repairState: "failed",
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
    [current, discard, onRepairReady, update],
  );

  const cancel = useCallback(
    async (key: string) => {
      const runtime = runtimesRef.current.get(key);
      const state = statesRef.current.get(key);
      if (!runtime || !state || !isRunActive(state) || state.cancelling) {
        return;
      }

      if (runtime.kind === "repair" && runtime.action && runtime.pull) {
        const controller = new AbortController();
        runtime.cancellationController?.abort();
        runtime.cancellationController = controller;
        update(key, runtime, (existing) => ({
          ...existing,
          cancelling: true,
        }));
        try {
          const snapshot = await cancelRepair(
            runtime.action,
            runtime.pull,
            controller.signal,
          );
          if (!current(key, runtime)) return;
          update(key, runtime, (existing) =>
            applyRepairEvent(existing, snapshot),
          );
          runtimesRef.current.delete(key);
          runtime.cancellationController = null;
          runtime.streamController.abort();
        } catch (error) {
          if (current(key, runtime) && !isAbortError(error)) {
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              output: append(
                existing.output,
                `[diagnostic] ${error instanceof Error ? error.message : "Automatic conflict repair could not be cancelled."}`,
                true,
              ),
            }));
          }
        }
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
        await cancelAgentRun(runtime.runId, controller.signal);
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          update(key, runtime, (existing) => ({
            ...existing,
            cancelling: false,
            output: append(
              existing.output,
              `[diagnostic] ${error instanceof Error ? error.message : `${agentLabel(runtime.agent)} could not be cancelled.`}`,
              true,
            ),
          }));
        }
        return;
      }

      runtime.finalize("cancelled");
    },
    [current, update],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statesRef.current = new Map();
      const active = [...runtimesRef.current.entries()];
      runtimesRef.current.clear();
      for (const [, runtime] of active) {
        runtime.cancellationController?.abort();
        runtime.streamController.abort();
        if (runtime.kind === "fix" && runtime.runId) {
          cancelDetached(runtime.runId);
        }
      }
    };
  }, [cancelDetached]);

  useEffect(() => {
    const stored = new Set([
      ...statesRef.current.keys(),
      ...runtimesRef.current.keys(),
    ]);

    for (const key of stored) {
      const identity = present.get(key);
      const state = statesRef.current.get(key);
      const runtime = runtimesRef.current.get(key);
      if (identity === undefined) {
        if (authoritative) void discard(key, true);
      } else if (
        authoritative &&
        ((state?.reviewRetry &&
          (state.reviewRetry.baseRefOid.toLowerCase() !== identity.baseRefOid ||
            state.reviewRetry.headRefOid.toLowerCase() !==
              identity.headRefOid)) ||
          (state?.reviewAttemptToken &&
            runtime?.source === "review" &&
            (runtime.baseRefOid?.toLowerCase() !== identity.baseRefOid ||
              runtime.headRefOid?.toLowerCase() !== identity.headRefOid)))
      ) {
        publish((existing) => {
          const currentState = existing.get(key);
          if (
            !currentState ||
            (!currentState.reviewRetry && !currentState.reviewAttemptToken)
          ) {
            return existing as Map<string, RunState>;
          }
          const next = new Map(existing);
          next.set(key, {
            ...currentState,
            reviewAttemptToken: null,
            reviewRetry: null,
          });
          return next;
        });
      } else if (
        authoritative &&
        state?.kind === "repair" &&
        state.headRefOid?.toLowerCase() !== identity.headRefOid
      ) {
        resetRepair(key);
      }
    }
  }, [authoritative, discard, present, publish, resetRepair]);

  return useMemo(
    () => ({
      cancel,
      clearReviewRetry,
      loadTranscript,
      observeRepair,
      setMessage,
      start,
      states,
    }),
    [
      cancel,
      clearReviewRetry,
      loadTranscript,
      observeRepair,
      setMessage,
      start,
      states,
    ],
  );
}
