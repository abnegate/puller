import { describe, expect, it } from "vitest";

import { createRunCoordinator } from "../claude.mjs";
import { createRunScheduler } from "../scheduler.mjs";

const options = (key) => ({
  duplicateCode: "duplicate",
  duplicateMessage: "Duplicate run.",
  key,
});

describe("shared run scheduler", () => {
  it("admits five runs by default before queueing shared work", async () => {
    const scheduler = createRunScheduler();
    const active = Array.from({ length: 5 }, (_, index) =>
      scheduler.reserveRun(options(`active-${index}`)),
    );
    const waiting = scheduler.reserveQueued(options("waiting"));

    await Promise.resolve();
    expect(scheduler.activeCount()).toBe(5);
    expect(scheduler.queuedCount()).toBe(1);

    active[0].release();
    const admitted = await waiting;
    expect(scheduler.activeCount()).toBe(5);
    for (const reservation of active.slice(1)) reservation.release();
    admitted.release();
    expect(scheduler.activeCount()).toBe(0);
  });

  it("queues FIFO behind the one shared coordinator without exceeding its limit", async () => {
    const coordinator = createRunCoordinator({ limit: 2 });
    const scheduler = createRunScheduler({ coordinator });
    const first = scheduler.reserveRun(options("first"));
    const second = scheduler.reserveRun(options("second"));
    const order = [];
    const thirdPromise = scheduler
      .reserveQueued(options("third"))
      .then((reservation) => {
        order.push("third");
        return reservation;
      });
    const fourthPromise = scheduler
      .reserveQueued(options("fourth"))
      .then((reservation) => {
        order.push("fourth");
        return reservation;
      });

    await Promise.resolve();
    expect(scheduler.activeCount()).toBe(2);
    expect(scheduler.queuedCount()).toBe(2);

    first.release();
    const third = await thirdPromise;
    expect(order).toEqual(["third"]);
    expect(scheduler.activeCount()).toBe(2);
    expect(scheduler.queuedCount()).toBe(1);

    second.release();
    const fourth = await fourthPromise;
    expect(order).toEqual(["third", "fourth"]);
    expect(scheduler.activeCount()).toBe(2);
    third.release();
    fourth.release();
    expect(scheduler.activeCount()).toBe(0);
  });

  it("deduplicates queued and active keys and releases a queued abort safely", async () => {
    const scheduler = createRunScheduler({
      coordinator: createRunCoordinator({ limit: 1 }),
    });
    const first = scheduler.reserveRun(options("same"));
    await expect(
      scheduler.reserveQueued(options("same")),
    ).rejects.toMatchObject({
      code: "duplicate",
      status: 409,
    });

    const controller = new AbortController();
    const waiting = scheduler.reserveQueued(options("waiting"), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "run_cancelled",
      message: "The queued agent run was cancelled.",
      status: 499,
    });
    expect(scheduler.queuedCount()).toBe(0);

    first.release();
    expect(() => scheduler.reserveRun(options("waiting"))).not.toThrow();
  });

  it("uses provider-neutral capacity and workspace errors", () => {
    const limited = createRunCoordinator({ limit: 1 });
    const active = limited.reserveRun(options("codex-active"));
    expect(() => limited.reserveRun(options("claude-active"))).toThrowError(
      expect.objectContaining({
        code: "run_limit",
        message: "1 agent run is already active.",
      }),
    );
    active.release();

    const shared = createRunCoordinator({ limit: 2 });
    const codex = shared.reserveRun(options("codex"));
    const claude = shared.reserveRun(options("claude"));
    codex.reserveWorkspace("/trusted/worktree");
    expect(() => claude.reserveWorkspace("/trusted/worktree")).toThrowError(
      expect.objectContaining({
        code: "workspace_running",
        message: "An agent run is already active in this worktree.",
      }),
    );
    codex.release();
    claude.release();
  });

  it("uses key reservations for atomic non-run exclusion without consuming capacity", () => {
    const scheduler = createRunScheduler({
      coordinator: createRunCoordinator({ limit: 1 }),
    });
    const lock = scheduler.reserveKey(options("same"));

    expect(scheduler.activeCount()).toBe(0);
    expect(() => scheduler.reserveRun(options("same"))).toThrowError(
      expect.objectContaining({ code: "duplicate" }),
    );
    const unrelated = scheduler.reserveRun(options("other"));
    expect(scheduler.activeCount()).toBe(1);

    unrelated.release();
    lock.release();
    expect(() => scheduler.reserveRun(options("same"))).not.toThrow();
  });

  it("rejects queued work during shutdown and leaves no key reserved", async () => {
    const scheduler = createRunScheduler({
      coordinator: createRunCoordinator({ limit: 1 }),
    });
    const active = scheduler.reserveRun(options("active"));
    const waiting = scheduler.reserveQueued(options("waiting"));
    scheduler.shutdown();

    await expect(waiting).rejects.toMatchObject({
      code: "shutting_down",
      status: 503,
    });
    expect(scheduler.queuedCount()).toBe(0);
    active.release();
    expect(() => scheduler.reserveRun(options("new"))).toThrowError(
      expect.objectContaining({ code: "shutting_down" }),
    );
  });
});
