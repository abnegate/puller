import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelTask,
  getTaskOptions,
  getTasks,
  startTask,
  streamTaskEvents,
  TaskStartError,
} from "./api";
import type {
  StartTaskRequest,
  Task,
  TaskEvent,
  TaskOptions,
  TaskPhase,
} from "./types";

export type TaskState = {
  cancelling: boolean;
  connectionError: string | null;
  output: string;
  replaying?: boolean;
  sequence: number;
  task: Task;
};

export type NewTaskRequest = Omit<StartTaskRequest, "id">;

export type Tasks = {
  cancel: (id: string) => Promise<void>;
  error: string | null;
  loading: boolean;
  options: TaskOptions | null;
  optionsError: string | null;
  optionsLoading: boolean;
  refreshOptions: () => void;
  start: (request: NewTaskRequest) => Promise<Task>;
  states: readonly TaskState[];
};

type Observation = {
  controller: AbortController;
  generation: number;
};

const TERMINAL = new Set<TaskPhase>(["completed", "failed", "cancelled"]);
const PHASE_ORDER: Record<TaskPhase, number> = {
  cancelled: 5,
  completed: 5,
  failed: 5,
  "opening-pr": 3,
  preparing: 1,
  pushing: 2,
  queued: 0,
  running: 4,
};
const RECONNECT_DELAY = 500;
const OUTPUT_LIMIT = 256 * 1024;
const OUTPUT_TRUNCATED = "[Earlier task output truncated.]\n";

export const isTaskActive = (task: Pick<Task, "phase">): boolean =>
  !TERMINAL.has(task.phase);

const errorText = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/\s+/g, " ").trim().slice(0, 500) || fallback;
};

const titleFor = (prompt: string): string => {
  const title =
    prompt
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || "New task";
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
};

const appendOutput = (output: string, text: string): string => {
  const next = output + text;
  if (next.length <= OUTPUT_LIMIT) return next;
  return `${OUTPUT_TRUNCATED}${next.slice(-(OUTPUT_LIMIT - OUTPUT_TRUNCATED.length))}`;
};

const appendError = (output: string, message: string): string => {
  const prefix = output && !output.endsWith("\n") ? "\n" : "";
  return appendOutput(output, `${prefix}[error] ${message}\n`);
};

const sameTask = (left: Task, right: Task): boolean =>
  left.base === right.base &&
  left.branch === right.branch &&
  left.createdAt === right.createdAt &&
  left.error === right.error &&
  left.id === right.id &&
  left.phase === right.phase &&
  left.pullRequest?.number === right.pullRequest?.number &&
  left.pullRequest?.url === right.pullRequest?.url &&
  left.repository === right.repository &&
  left.title === right.title &&
  left.updatedAt === right.updatedAt &&
  left.worktree === right.worktree;

const wait = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(finish, RECONNECT_DELAY);
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });

export const applyTaskEvent = (
  state: TaskState,
  event: TaskEvent,
): TaskState => {
  if (event.sequence <= state.sequence) return state;
  if (event.type === "task") {
    if (state.replaying) {
      const synchronized = sameTask(state.task, event.task);
      const newer =
        !TERMINAL.has(state.task.phase) &&
        (Date.parse(event.task.updatedAt) > Date.parse(state.task.updatedAt) ||
          (event.task.updatedAt === state.task.updatedAt &&
            PHASE_ORDER[event.task.phase] > PHASE_ORDER[state.task.phase]));
      return {
        ...state,
        cancelling:
          newer && event.task.phase === "cancelled" ? false : state.cancelling,
        connectionError: null,
        replaying: !synchronized && !newer,
        sequence: event.sequence,
        task: newer ? event.task : state.task,
      };
    }
    return {
      ...state,
      cancelling: event.task.phase === "cancelled" ? false : state.cancelling,
      connectionError: null,
      sequence: event.sequence,
      task: event.task,
    };
  }
  return {
    ...state,
    connectionError: null,
    output: appendOutput(state.output, event.text),
    sequence: event.sequence,
  };
};

export function useTasks(): Tasks {
  const [states, setStates] = useState<Map<string, TaskState>>(() => new Map());
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const statesRef = useRef(states);
  const observations = useRef(new Map<string, Observation>());
  const cancellations = useRef(new Set<AbortController>());
  const optionsRequest = useRef<AbortController | null>(null);
  const retryIds = useRef(new Map<string, string>());
  const generation = useRef(0);
  const mounted = useRef(true);

  const publish = useCallback(
    (
      update: (
        current: ReadonlyMap<string, TaskState>,
      ) => Map<string, TaskState>,
    ) => {
      const next = update(statesRef.current);
      if (next === statesRef.current) return;
      statesRef.current = next;
      if (mounted.current) setStates(next);
    },
    [],
  );

  const update = useCallback(
    (id: string, change: (state: TaskState) => TaskState) => {
      publish((current) => {
        const state = current.get(id);
        if (!state) return current as Map<string, TaskState>;
        const nextState = change(state);
        if (nextState === state) return current as Map<string, TaskState>;
        const next = new Map(current);
        next.set(id, nextState);
        return next;
      });
    },
    [publish],
  );

  const observe = useCallback(
    (id: string) => {
      if (observations.current.has(id)) return;
      const observation: Observation = {
        controller: new AbortController(),
        generation: ++generation.current,
      };
      observations.current.set(id, observation);

      void (async () => {
        try {
          while (!observation.controller.signal.aborted) {
            const before = statesRef.current.get(id);
            if (!before) return;
            try {
              for await (const event of streamTaskEvents(
                id,
                before.sequence,
                observation.controller.signal,
              )) {
                if (observations.current.get(id) !== observation) return;
                update(id, (state) => applyTaskEvent(state, event));
              }
              const current = statesRef.current.get(id);
              if (!current || !isTaskActive(current.task)) return;
              update(id, (state) => ({
                ...state,
                connectionError: "Reconnecting to task output…",
              }));
            } catch (streamError) {
              if (observation.controller.signal.aborted) return;
              const current = statesRef.current.get(id);
              if (!current || !isTaskActive(current.task)) return;
              update(id, (state) => ({
                ...state,
                connectionError: errorText(
                  streamError,
                  "Reconnecting to task output…",
                ),
              }));
            }
            await wait(observation.controller.signal);
          }
        } finally {
          if (observations.current.get(id) === observation) {
            observations.current.delete(id);
          }
        }
      })();
    },
    [update],
  );

  const refreshOptions = useCallback(() => {
    optionsRequest.current?.abort();
    const controller = new AbortController();
    optionsRequest.current = controller;
    setOptionsLoading(true);

    void getTaskOptions(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setOptions(value);
          setOptionsError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setOptionsError(
            errorText(loadError, "Task options could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (optionsRequest.current === controller) {
          optionsRequest.current = null;
          if (!controller.signal.aborted) setOptionsLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const listController = new AbortController();
    refreshOptions();

    void getTasks(listController.signal)
      .then((tasks) => {
        if (listController.signal.aborted) return;
        publish((current) => {
          const next = new Map(current);
          for (const task of tasks) {
            const previous = next.get(task.id);
            next.set(task.id, {
              cancelling: previous?.cancelling ?? false,
              connectionError: null,
              output: previous?.output ?? "",
              replaying: true,
              sequence: previous?.sequence ?? 0,
              task,
            });
          }
          return next;
        });
        setError(null);
        for (const task of tasks) observe(task.id);
      })
      .catch((loadError: unknown) => {
        if (!listController.signal.aborted) {
          setError(errorText(loadError, "Tasks could not be restored."));
        }
      })
      .finally(() => {
        if (!listController.signal.aborted) setLoading(false);
      });

    return () => {
      mounted.current = false;
      optionsRequest.current?.abort();
      optionsRequest.current = null;
      listController.abort();
      for (const observation of observations.current.values()) {
        observation.controller.abort();
      }
      observations.current.clear();
      for (const controller of cancellations.current) controller.abort();
      cancellations.current.clear();
    };
  }, [observe, publish, refreshOptions]);

  const start = useCallback(
    async (request: NewTaskRequest): Promise<Task> => {
      const prompt = request.prompt.trim();
      const now = new Date().toISOString();
      const retryKey = JSON.stringify([
        request.repository.toLowerCase(),
        request.base,
        prompt,
      ]);
      const id = retryIds.current.get(retryKey) ?? crypto.randomUUID();
      retryIds.current.set(retryKey, id);
      const optimistic: Task = {
        base: request.base,
        createdAt: now,
        id,
        phase: "queued",
        repository: request.repository,
        title: titleFor(prompt),
        updatedAt: now,
      };
      publish((current) => {
        const next = new Map(current);
        next.set(id, {
          cancelling: false,
          connectionError: null,
          output: "",
          sequence: 0,
          task: optimistic,
        });
        return next;
      });

      try {
        const task = await startTask({ ...request, id, prompt });
        retryIds.current.delete(retryKey);
        update(id, (state) => ({ ...state, replaying: true, task }));
        observe(id);
        return task;
      } catch (startError) {
        if (startError instanceof TaskStartError) {
          retryIds.current.delete(retryKey);
        } else {
          try {
            const recovered = (await getTasks()).find(
              (task) =>
                task.id === id &&
                task.repository.toLowerCase() ===
                  request.repository.toLowerCase() &&
                task.base === request.base,
            );
            if (recovered) {
              retryIds.current.delete(retryKey);
              update(id, (state) => ({
                ...state,
                replaying: true,
                task: recovered,
              }));
              observe(id);
              return recovered;
            }
          } catch {
            // Keep the stable identifier so a manual retry remains idempotent.
          }
        }
        const message = errorText(startError, "The task could not be started.");
        const failed: Task = {
          ...optimistic,
          error: message,
          phase: "failed",
          updatedAt: new Date().toISOString(),
        };
        update(id, (state) => ({
          ...state,
          output: appendError(state.output, message),
          task: failed,
        }));
        throw startError;
      }
    },
    [observe, publish, update],
  );

  const cancel = useCallback(
    async (id: string) => {
      const state = statesRef.current.get(id);
      if (!state || !isTaskActive(state.task) || state.cancelling) return;

      update(id, (current) => ({ ...current, cancelling: true }));
      const controller = new AbortController();
      cancellations.current.add(controller);
      try {
        const task = await cancelTask(id, controller.signal);
        if (task) {
          update(id, (current) => ({
            ...current,
            cancelling: false,
            task,
          }));
        } else {
          update(id, (current) => ({ ...current, cancelling: false }));
        }
      } catch (cancelError) {
        if (!controller.signal.aborted) {
          const message = errorText(
            cancelError,
            "The task could not be cancelled.",
          );
          update(id, (current) => ({
            ...current,
            cancelling: false,
            output: appendError(current.output, message),
          }));
        }
        throw cancelError;
      } finally {
        cancellations.current.delete(controller);
      }
    },
    [update],
  );

  const ordered = useMemo(
    () =>
      [...states.values()].sort(
        (left, right) =>
          Date.parse(right.task.createdAt) - Date.parse(left.task.createdAt) ||
          left.task.id.localeCompare(right.task.id),
      ),
    [states],
  );

  return {
    cancel,
    error,
    loading,
    options,
    optionsError,
    optionsLoading,
    refreshOptions,
    start,
    states: ordered,
  };
}
