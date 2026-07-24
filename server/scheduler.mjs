import { ActionError, createRunCoordinator } from "./claude.mjs";

function cancelled() {
  return new ActionError(
    499,
    "run_cancelled",
    "The queued agent run was cancelled.",
  );
}

function shuttingDown() {
  return new ActionError(503, "shutting_down", "The server is shutting down.");
}

export function createRunScheduler({
  coordinator = createRunCoordinator({ limit: 5 }),
} = {}) {
  if (
    !coordinator ||
    typeof coordinator.reserveRun !== "function" ||
    typeof coordinator.activeCount !== "function" ||
    typeof coordinator.shutdown !== "function"
  ) {
    throw new TypeError("An agent run coordinator is required.");
  }

  const keys = new Set();
  const queue = [];
  let stopping = false;
  let draining = false;

  function duplicate(options) {
    return new ActionError(
      409,
      options.duplicateCode,
      options.duplicateMessage,
    );
  }

  function validate(options) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      typeof options.key !== "string" ||
      options.key === "" ||
      typeof options.duplicateCode !== "string" ||
      options.duplicateCode === "" ||
      typeof options.duplicateMessage !== "string" ||
      options.duplicateMessage === ""
    ) {
      throw new TypeError("Run reservation options are invalid.");
    }
    return options;
  }

  function wrap(options, reservation) {
    let released = false;
    return Object.freeze({
      reserveWorkspace: reservation.reserveWorkspace.bind(reservation),
      releaseWorkspace: reservation.releaseWorkspace.bind(reservation),
      release() {
        if (released) return;
        released = true;
        reservation.release();
        keys.delete(options.key);
        drain();
      },
    });
  }

  function reject(entry, error) {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal?.removeEventListener("abort", entry.abort);
    keys.delete(entry.options.key);
    entry.reject(error);
  }

  function drain() {
    if (draining || stopping) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue[0];
        if (entry.settled) {
          queue.shift();
          continue;
        }
        let reservation;
        try {
          reservation = coordinator.reserveRun(entry.options);
        } catch (error) {
          if (error instanceof ActionError && error.code === "run_limit")
            return;
          queue.shift();
          reject(entry, error);
          continue;
        }
        queue.shift();
        entry.settled = true;
        entry.signal?.removeEventListener("abort", entry.abort);
        entry.resolve(wrap(entry.options, reservation));
      }
    } finally {
      draining = false;
    }
  }

  function reserveRun(rawOptions) {
    const options = validate(rawOptions);
    if (stopping) throw shuttingDown();
    if (keys.has(options.key)) throw duplicate(options);
    keys.add(options.key);
    try {
      return wrap(options, coordinator.reserveRun(options));
    } catch (error) {
      keys.delete(options.key);
      throw error;
    }
  }

  function reserveKey(rawOptions) {
    const options = validate(rawOptions);
    if (stopping) throw shuttingDown();
    if (keys.has(options.key)) throw duplicate(options);
    keys.add(options.key);
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        keys.delete(options.key);
        drain();
      },
    });
  }

  function reserveQueued(rawOptions, { signal } = {}) {
    const options = validate(rawOptions);
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      return Promise.reject(new TypeError("The queued run signal is invalid."));
    }
    if (stopping) return Promise.reject(shuttingDown());
    if (signal?.aborted) return Promise.reject(cancelled());
    if (keys.has(options.key)) return Promise.reject(duplicate(options));
    keys.add(options.key);

    return new Promise((resolve, rejectPromise) => {
      const entry = {
        abort: null,
        options,
        reject: rejectPromise,
        resolve,
        settled: false,
        signal,
      };
      entry.abort = () => {
        if (entry.settled) return;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(entry, cancelled());
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      queue.push(entry);
      drain();
    });
  }

  function shutdown() {
    if (stopping) return;
    stopping = true;
    while (queue.length > 0) reject(queue.shift(), shuttingDown());
    coordinator.shutdown();
  }

  return Object.freeze({
    activeCount: coordinator.activeCount.bind(coordinator),
    activeWorkspaceCount:
      typeof coordinator.activeWorkspaceCount === "function"
        ? coordinator.activeWorkspaceCount.bind(coordinator)
        : () => 0,
    queuedCount: () => queue.length,
    reserveKey,
    reserveQueued,
    reserveRun,
    shutdown,
  });
}
