// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTaskEvent, useTasks } from "./tasks";
import type { Task, TaskEvent, TaskOptions } from "./types";

const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  list: vi.fn(),
  options: vi.fn(),
  start: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("./api", () => ({
  cancelTask: api.cancel,
  getTaskOptions: api.options,
  getTasks: api.list,
  startTask: api.start,
  streamTaskEvents: api.stream,
  TaskStartError: class TaskStartError extends Error {},
}));

const options: TaskOptions = {
  repositories: [],
  updatedAt: "2026-07-22T00:00:00.000Z",
};

const task = (phase: Task["phase"] = "running"): Task => ({
  base: "main",
  branch: "puller/task-support-12345678",
  createdAt: "2026-07-22T00:00:00.000Z",
  id: "12345678-task",
  phase,
  repository: "appwrite/cloud",
  title: "Add task support",
  updatedAt: "2026-07-22T00:01:00.000Z",
});

beforeEach(() => {
  api.options.mockResolvedValue(options);
  api.list.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("useTasks", () => {
  it("restores task state and replayed output without cancelling on unmount", async () => {
    let streamSignal: AbortSignal | undefined;
    api.list.mockResolvedValue([task()]);
    api.stream.mockImplementation(async function* (
      _id: string,
      _after: number,
      signal?: AbortSignal,
    ): AsyncGenerator<TaskEvent, void, undefined> {
      streamSignal = signal;
      yield { sequence: 1, task: task(), type: "task" };
      yield {
        id: "12345678-task",
        sequence: 2,
        stream: "stdout",
        text: "Restored terminal output.\n",
        type: "output",
      };
      await new Promise((resolve) =>
        signal?.addEventListener("abort", resolve, { once: true }),
      );
    });

    const hook = renderHook(() => useTasks());
    await waitFor(() =>
      expect(hook.result.current.states[0]?.output).toContain(
        "Restored terminal output.",
      ),
    );
    expect(api.stream).toHaveBeenCalledWith(
      "12345678-task",
      0,
      expect.any(AbortSignal),
    );

    hook.unmount();
    expect(streamSignal?.aborted).toBe(true);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("inserts an optimistic row and applies a PR link plus streamed output", async () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
    let resolveStart!: (value: Task) => void;
    api.start.mockReturnValue(
      new Promise<Task>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const queued: Task = { ...task("queued"), branch: undefined, id };
    const running: Task = {
      ...task(),
      id,
      pullRequest: {
        number: 42,
        url: "https://github.com/appwrite/cloud/pull/42",
      },
    };
    api.stream.mockImplementation(async function* (): AsyncGenerator<
      TaskEvent,
      void,
      undefined
    > {
      yield { sequence: 1, task: running, type: "task" };
      yield {
        id,
        sequence: 2,
        stream: "stdout",
        text: "Implementing now.\n",
        type: "output",
      };
      yield {
        sequence: 3,
        task: { ...running, phase: "completed" },
        type: "task",
      };
    });
    const hook = renderHook(() => useTasks());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    let started!: Promise<Task>;
    act(() => {
      started = hook.result.current.start({
        base: "main",
        prompt: "Add task support",
        repository: "appwrite/cloud",
      });
    });
    expect(hook.result.current.states[0]?.task.phase).toBe("queued");
    expect(hook.result.current.states[0]?.task.id).toBe(id);

    await act(async () => {
      resolveStart(queued);
      await started;
    });
    await waitFor(() =>
      expect(hook.result.current.states[0]?.task.pullRequest?.number).toBe(42),
    );
    expect(hook.result.current.states[0]?.output).toContain(
      "Implementing now.",
    );
    expect(hook.result.current.states[0]?.task.phase).toBe("completed");
  });

  it("reconnects from the last sequence and cancels only after an explicit action", async () => {
    api.list.mockResolvedValue([task()]);
    api.stream
      .mockImplementationOnce(async function* (): AsyncGenerator<
        TaskEvent,
        void,
        undefined
      > {
        yield {
          id: "12345678-task",
          sequence: 1,
          stream: "stdout",
          text: "First chunk.\n",
          type: "output",
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        TaskEvent,
        void,
        undefined
      > {
        yield {
          id: "12345678-task",
          sequence: 2,
          stream: "stdout",
          text: "Second chunk.\n",
          type: "output",
        };
      })
      .mockImplementation(async function* (
        _id: string,
        _after: number,
        signal?: AbortSignal,
      ): AsyncGenerator<TaskEvent, void, undefined> {
        await new Promise((resolve) =>
          signal?.addEventListener("abort", resolve, { once: true }),
        );
      });
    api.cancel.mockResolvedValue(task("cancelled"));
    const hook = renderHook(() => useTasks());

    await waitFor(
      () =>
        expect(hook.result.current.states[0]?.output).toContain(
          "Second chunk.",
        ),
      { timeout: 2_000 },
    );
    expect(api.stream.mock.calls.slice(0, 2).map((call) => call[1])).toEqual([
      0, 1,
    ]);
    expect(api.cancel).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.cancel("12345678-task");
    });
    expect(api.cancel).toHaveBeenCalledWith(
      "12345678-task",
      expect.any(AbortSignal),
    );
    expect(hook.result.current.states[0]?.task.phase).toBe("cancelled");
  });

  it("recovers an accepted task by its stable id when the start response is lost", async () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
    api.start.mockRejectedValue(new Error("The response was lost."));
    api.stream.mockImplementation(async function* (
      _id: string,
      _after: number,
      signal?: AbortSignal,
    ): AsyncGenerator<TaskEvent, void, undefined> {
      await new Promise((resolve) =>
        signal?.addEventListener("abort", resolve, { once: true }),
      );
    });
    const hook = renderHook(() => useTasks());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const recovered = { ...task(), id };
    api.list.mockResolvedValueOnce([recovered]);

    await expect(
      act(() =>
        hook.result.current.start({
          base: "main",
          prompt: "Add task support",
          repository: "appwrite/cloud",
        }),
      ),
    ).resolves.toEqual(recovered);
    expect(hook.result.current.states[0]?.task).toEqual(recovered);
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it("reuses the idempotency id after an unreconciled start failure", async () => {
    const id = "12345678-1234-4234-8234-123456789abc";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
    api.start.mockRejectedValue(new Error("The response was lost."));
    api.list.mockResolvedValue([]);
    const hook = renderHook(() => useTasks());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const request = {
      base: "main",
      prompt: "Add task support",
      repository: "appwrite/cloud",
    };

    await expect(act(() => hook.result.current.start(request))).rejects.toThrow(
      "The response was lost.",
    );
    await expect(act(() => hook.result.current.start(request))).rejects.toThrow(
      "The response was lost.",
    );
    expect(api.start.mock.calls.map(([value]) => value.id)).toEqual([id, id]);
  });

  it("keeps a terminal list snapshot authoritative while replaying older events", async () => {
    const completed = task("completed");
    api.list.mockResolvedValue([completed]);
    api.stream.mockImplementation(async function* (): AsyncGenerator<
      TaskEvent,
      void,
      undefined
    > {
      yield {
        sequence: 1,
        task: {
          ...task("queued"),
          updatedAt: "2026-07-22T00:00:30.000Z",
        },
        type: "task",
      };
      yield {
        id: completed.id,
        sequence: 2,
        stream: "stdout",
        text: "Recovered output.\n",
        type: "output",
      };
      throw new Error("Replay disconnected.");
    });
    const hook = renderHook(() => useTasks());

    await waitFor(() =>
      expect(hook.result.current.states[0]?.output).toContain(
        "Recovered output.",
      ),
    );
    expect(hook.result.current.states[0]?.task.phase).toBe("completed");
    expect(api.stream).toHaveBeenCalledOnce();
  });

  it("bounds retained browser output while keeping the latest text", () => {
    const current = {
      cancelling: false,
      connectionError: null,
      output: "",
      sequence: 0,
      task: task(),
    };
    const next = applyTaskEvent(current, {
      id: current.task.id,
      sequence: 1,
      stream: "stdout",
      text: `first${"x".repeat(300_000)}latest`,
      type: "output",
    });

    expect(next.output.length).toBeLessThanOrEqual(256 * 1024);
    expect(next.output.startsWith("[Earlier task output truncated.]\n")).toBe(
      true,
    );
    expect(next.output.endsWith("latest")).toBe(true);
  });
});
