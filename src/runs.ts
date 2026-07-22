import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cancelRepair, streamRepair } from "./api";
import {
  cancelClaudeRun,
  ClaudeRunHttpError,
  streamClaudeRun,
  type AutoParallelism,
  type AutoTrigger,
  type ClaudeRunEvent,
  type ClaudeRunRequest,
  type ReviewFeedback,
  type RunSource,
} from "./fixes";
import type {
  MergePullRepairResponse,
  PullReadiness,
  RepairEvent,
  RepairState,
} from "./types";

export type RunStatus =
  | "idle"
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

export type StartRunOptions =
  | {
      message?: string;
      parallelism?: never;
      source?: "manual";
      triggers?: never;
    }
  | {
      message?: string;
      parallelism: AutoParallelism;
      source: "auto";
      triggers: readonly AutoTrigger[];
    }
  | {
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

export type RunState = {
  actionId: string | null;
  cancelling: boolean;
  headRefOid: string | null;
  kind: "fix" | "repair";
  message: string;
  output: string;
  repairState: RepairState | null;
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

type Runtime = {
  action: MergePullRepairResponse["action"] | null;
  cancellationController: AbortController | null;
  generation: number;
  headRefOid: string | null;
  kind: "fix" | "repair";
  pull: PullReadiness | null;
  runId: string | null;
  source: RunSource;
  streamController: AbortController;
  triggers: ReadonlySet<string> | null;
};

export const IDLE_RUN_STATE: RunState = Object.freeze({
  actionId: null,
  cancelling: false,
  headRefOid: null,
  kind: "fix",
  message: "",
  output: "",
  repairState: null,
  source: "manual",
  status: "idle",
});

export const isRunActive = (state?: Pick<RunState, "status">): boolean =>
  state?.status === "starting" || state?.status === "running";

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

    if (
      pull.ci.state === "pending" ||
      (pull.ci.running ?? 0) > 0 ||
      repairPending ||
      (run?.kind !== "repair" && isRunActive(run))
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
): Exclude<RunStartOutcome, { kind: "accepted" }> => {
  if (!(error instanceof ClaudeRunHttpError)) {
    if (isAbortError(error)) {
      return {
        code: null,
        kind: "failed",
        message: "The Claude Code run was cancelled before it started.",
        source,
      };
    }

    return {
      code: "transport",
      kind: "retryable",
      message:
        error instanceof Error
          ? error.message
          : "Claude could not be reached before the run started.",
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

const formatEvent = (event: ClaudeRunEvent): string | null => {
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
): PullRuns {
  const [states, setStates] = useState<Map<string, RunState>>(() => new Map());
  const statesRef = useRef(states);
  const runtimesRef = useRef(new Map<string, Runtime>());
  const cancellationsRef = useRef(new Set<AbortController>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const identities = pulls
    .map((pull) => `${pull.url}\n${pull.headRefOid.toLowerCase()}`)
    .sort()
    .join("\u0000");
  const present = useMemo(
    () =>
      new Map(
        (identities ? identities.split("\u0000") : []).map((identity) => {
          const newline = identity.lastIndexOf("\n");
          return [identity.slice(0, newline), identity.slice(newline + 1)];
        }),
      ),
    [identities],
  );

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

  const purge = useCallback(
    (key: string) => {
      publish((existing) => {
        if (!existing.has(key)) {
          return existing as Map<string, RunState>;
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
    void cancelClaudeRun(runId, controller.signal)
      .catch(() => undefined)
      .finally(() => cancellationsRef.current.delete(controller));
  }, []);

  const discard = useCallback(
    (key: string, purgeState: boolean) => {
      const runtime = runtimesRef.current.get(key);
      if (runtime) {
        runtimesRef.current.delete(key);
      }
      if (purgeState) {
        purge(key);
      }
      if (!runtime) {
        return;
      }

      runtime.cancellationController?.abort();
      runtime.streamController.abort();
      if (runtime.kind === "fix" && runtime.runId) {
        cancelDetached(runtime.runId);
      }
    },
    [cancelDetached, purge],
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
      const state = statesRef.current.get(key) ?? IDLE_RUN_STATE;
      const source = options.source ?? "manual";
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
          message: "A Claude Code run is already active for this pull request.",
          source,
        };
      }

      const runtime: Runtime = {
        action: null,
        cancellationController: null,
        generation: ++generationRef.current,
        headRefOid: pull.headRefOid,
        kind: "fix",
        pull: null,
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
        cancelling: false,
        headRefOid: null,
        kind: "fix",
        output: "",
        repairState: null,
        source,
        status: "starting",
      }));

      let resolveAcceptance!: (outcome: RunStartOutcome) => void;
      const acceptance = new Promise<RunStartOutcome>((resolve) => {
        resolveAcceptance = resolve;
      });
      let resolveCompletion!: (status: RunTerminalStatus) => void;
      const completion = new Promise<RunTerminalStatus>((resolve) => {
        resolveCompletion = resolve;
      });
      let accepted = false;
      let acceptanceSettled = false;
      let completionSettled = false;
      let ended = false;

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

      const execute = async (): Promise<void> => {
        try {
          const base = {
            expectedHeadRefOid: pull.headRefOid,
            message,
            number: pull.number,
            repository: pull.repository,
          };
          const request: ClaudeRunRequest =
            options.source === "auto"
              ? {
                  ...base,
                  parallelism: options.parallelism,
                  source: "auto",
                  triggers: options.triggers,
                }
              : options.source === "review"
                ? {
                    ...base,
                    expectedBaseRefOid: options.expectedBaseRefOid,
                    feedback: options.feedback,
                    source: "review",
                  }
                : { ...base, source: "manual" };
          for await (const event of streamClaudeRun(
            request,
            runtime.streamController.signal,
          )) {
            if (!current(key, runtime)) {
              settleCompletion("cancelled");
              return;
            }

            if (event.type === "start") {
              accepted = true;
              runtime.runId = event.runId;
              update(key, runtime, (existing) => ({
                ...existing,
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
              ended = true;
              update(key, runtime, (existing) => ({
                ...existing,
                cancelling: false,
                status: terminal,
              }));
              settleCompletion(terminal);
            }
          }

          if (!ended) {
            const error = new Error(
              accepted
                ? "Claude disconnected before reporting completion."
                : "Claude disconnected before accepting the run.",
            );
            if (current(key, runtime)) {
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
            }
            if (accepted) {
              settleCompletion("failed");
            } else {
              settleAcceptance(startFailure(error, source));
            }
          }
        } catch (error) {
          if (current(key, runtime) && !isAbortError(error)) {
            update(key, runtime, (existing) => ({
              ...existing,
              cancelling: false,
              output: append(
                existing.output,
                `[error] ${error instanceof Error ? error.message : "Claude could not be reached."}`,
                true,
              ),
              status: "failed",
            }));
          }
          if (accepted) {
            settleCompletion(isAbortError(error) ? "cancelled" : "failed");
          } else {
            settleAcceptance(startFailure(error, source));
          }
        } finally {
          if (!acceptanceSettled) {
            settleAcceptance({
              code: null,
              kind: "failed",
              message: "The Claude Code run ended before it was accepted.",
              source,
            });
          }
          if (!completionSettled && accepted) {
            settleCompletion(ended ? "failed" : "cancelled");
          }
          if (current(key, runtime)) {
            runtimesRef.current.delete(key);
            runtime.cancellationController?.abort();
          }
        }
      };

      void execute();
      return acceptance;
    },
    [current, update],
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
      if (existing) discard(key, false);

      const runtime: Runtime = {
        action: response.action,
        cancellationController: null,
        generation: ++generationRef.current,
        headRefOid: pull.headRefOid,
        kind: "repair",
        pull,
        runId: null,
        source: "auto",
        streamController: new AbortController(),
        triggers: null,
      };
      runtimesRef.current.set(key, runtime);
      update(key, runtime, (state) => ({
        ...state,
        actionId: response.action.id,
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
        await cancelClaudeRun(runtime.runId, controller.signal);
      } catch (error) {
        if (current(key, runtime) && !isAbortError(error)) {
          update(key, runtime, (existing) => ({
            ...existing,
            cancelling: false,
            output: append(
              existing.output,
              `[diagnostic] ${error instanceof Error ? error.message : "Claude could not be cancelled."}`,
              true,
            ),
          }));
        }
        return;
      }

      if (!current(key, runtime) || !isRunActive(statesRef.current.get(key))) {
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
      const head = present.get(key);
      const state = statesRef.current.get(key);
      if (
        head === undefined ||
        (state?.kind === "repair" && state.headRefOid !== head)
      ) {
        discard(key, true);
      }
    }
  }, [discard, present]);

  return useMemo(
    () => ({ cancel, observeRepair, setMessage, start, states }),
    [cancel, observeRepair, setMessage, start, states],
  );
}
