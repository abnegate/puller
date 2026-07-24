import { describe, expect, it, vi } from "vitest";

import {
  createBrowserRunTranscriptStore,
  createIndexedDbRunTranscriptStore,
  createMemoryRunTranscriptStore,
  createUnavailableRunTranscriptStore,
  RunTranscriptStoreError,
} from "./run-transcripts";

type FakeTransaction = {
  abort: () => void;
  complete: () => void;
  transaction: IDBTransaction;
};

type TransactionOutcome = "abort" | "complete";

const createFakeIndexedDb = ({
  automatic = true,
  open = "success",
  outcomes = [],
  transaction = "complete",
}: {
  automatic?: boolean;
  open?: "blocked" | "error" | "success";
  outcomes?: TransactionOutcome[];
  transaction?: TransactionOutcome;
} = {}) => {
  const records = new Map<string, unknown>();
  const transactions: FakeTransaction[] = [];
  const pendingOutcomes = [...outcomes];
  let created = false;

  const database = {
    close: vi.fn(),
    createObjectStore: vi.fn(() => {
      created = true;
      return {};
    }),
    objectStoreNames: {
      contains: vi.fn(() => created),
    },
    onversionchange: null,
    transaction: vi.fn(() => {
      let settled = false;
      let pending = 0;
      let completionScheduled = false;
      const working = new Map(records);
      const outcome = pendingOutcomes.shift() ?? transaction;
      const value = {
        onabort: null,
        oncomplete: null,
        onerror: null,
      } as unknown as IDBTransaction;
      const complete = () => {
        if (settled) return;
        settled = true;
        records.clear();
        for (const [key, record] of working) records.set(key, record);
        value.oncomplete?.(new Event("complete"));
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        value.onabort?.(new Event("abort"));
      };
      const scheduleCompletion = () => {
        if (!automatic || settled || pending > 0 || completionScheduled) return;
        completionScheduled = true;
        queueMicrotask(() => {
          completionScheduled = false;
          if (pending > 0 || settled) return;
          if (outcome === "abort") abort();
          else complete();
        });
      };
      Object.assign(value, {
        abort,
        objectStore: () => ({
          delete: (key: string) => {
            working.delete(key);
            return {};
          },
          get: (key: string) => {
            pending += 1;
            const request = {
              onsuccess: null,
              result: undefined,
            } as unknown as IDBRequest;
            queueMicrotask(() => {
              Object.assign(request, {
                result: working.get(key),
              });
              request.onsuccess?.(new Event("success"));
              pending -= 1;
              scheduleCompletion();
            });
            return request;
          },
          openCursor: () => {
            pending += 1;
            const keys = [...working.keys()];
            let index = 0;
            const request = {
              onsuccess: null,
              result: undefined,
            } as unknown as IDBRequest<IDBCursorWithValue | null>;
            const advance = () => {
              queueMicrotask(() => {
                const key = keys[index];
                if (key === undefined) {
                  Object.assign(request, { result: null });
                  request.onsuccess?.(new Event("success"));
                  pending -= 1;
                  scheduleCompletion();
                  return;
                }

                const cursor = {
                  continue: () => {
                    index += 1;
                    advance();
                  },
                  delete: () => {
                    working.delete(key);
                    return {} as IDBRequest<undefined>;
                  },
                  value: working.get(key),
                } as unknown as IDBCursorWithValue;
                Object.assign(request, { result: cursor });
                request.onsuccess?.(new Event("success"));
              });
            };
            advance();
            return request;
          },
          put: (record: { key: string }) => {
            working.set(record.key, record);
            return {};
          },
        }),
      });
      transactions.push({ abort, complete, transaction: value });
      scheduleCompletion();
      return value;
    }),
  } as unknown as IDBDatabase;

  const factory = {
    open: vi.fn(() => {
      const request = {
        onblocked: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: database,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (open === "blocked") {
          request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
          return;
        }
        if (open === "error") {
          request.onerror?.(new Event("error"));
          return;
        }
        request.onupgradeneeded?.(
          new Event("upgradeneeded") as IDBVersionChangeEvent,
        );
        request.onsuccess?.(new Event("success"));
      });
      return request;
    }),
  } as unknown as IDBFactory;

  return {
    database,
    factory,
    queueOutcome: (outcome: TransactionOutcome) =>
      pendingOutcomes.push(outcome),
    records,
    transactions,
  };
};

describe("run transcript stores", () => {
  it("stores, replaces, reads, and idempotently deletes exact memory transcripts", async () => {
    const store = createMemoryRunTranscriptStore();

    expect(await store.get("missing")).toBeNull();
    await store.put("run-1", "first\nexact transcript");
    expect(await store.get("run-1")).toBe("first\nexact transcript");
    await store.put("run-1", "replacement");
    expect(await store.get("run-1")).toBe("replacement");
    await store.delete(["missing", "run-1", "run-1"]);
    expect(await store.get("run-1")).toBeNull();
  });

  it("rejects an aborted memory read without returning stored bytes", async () => {
    const store = createMemoryRunTranscriptStore();
    const controller = new AbortController();
    await store.put("run-1", "private transcript");
    controller.abort();

    await expect(store.get("run-1", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("uses an explicit unavailable store instead of retaining transcript bytes", async () => {
    const store = createUnavailableRunTranscriptStore(
      "indexeddb_unavailable",
      "Browser transcript storage is unavailable.",
    );

    await expect(store.put("run-1", "must not leak")).rejects.toEqual(
      expect.objectContaining({
        code: "indexeddb_unavailable",
        message: "Browser transcript storage is unavailable.",
      }),
    );
    await expect(store.get("run-1")).rejects.toBeInstanceOf(
      RunTranscriptStoreError,
    );
    await expect(store.delete(["run-1"])).rejects.toBeInstanceOf(
      RunTranscriptStoreError,
    );
    await expect(
      store.put("run-1", "must not leak"),
    ).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("must not leak"),
    );
  });

  it("returns an unavailable browser store when IndexedDB is absent", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    try {
      await expect(
        createBrowserRunTranscriptStore().put("run-1", "transcript"),
      ).rejects.toMatchObject({ code: "indexeddb_unavailable" });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "indexedDB", descriptor);
      } else {
        delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      }
    }
  });

  it.each([
    ["blocked", "indexeddb_blocked"],
    ["error", "indexeddb_open_failed"],
  ] as const)("settles an IndexedDB %s open", async (open, code) => {
    const { factory } = createFakeIndexedDb({ open });
    const store = createIndexedDbRunTranscriptStore(factory);

    await expect(store.put("run-1", "transcript")).rejects.toMatchObject({
      code,
    });
  });

  it("creates the object store and round-trips exact IndexedDB transcripts", async () => {
    const { database, factory } = createFakeIndexedDb();
    const store = createIndexedDbRunTranscriptStore(factory, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      sessionId: "session-round-trip",
    });

    await store.put("run-1", "line one\nline two");
    expect(await store.get("run-1")).toBe("line one\nline two");
    expect(store.retriesFailedDeletes).toBe(true);
    expect(database.createObjectStore).toHaveBeenCalledWith("transcripts", {
      keyPath: "key",
    });
    await store.delete(["missing", "run-1"]);
    expect(await store.get("run-1")).toBeNull();
  });

  it("resolves an IndexedDB write only after the transaction commits", async () => {
    const { factory, transactions } = createFakeIndexedDb({
      automatic: false,
    });
    const store = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-manual-commit",
    });
    let resolved = false;
    const writing = store.put("run-1", "transcript").then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(transactions).toHaveLength(1));
    expect(resolved).toBe(false);
    transactions[0]!.complete();
    await vi.waitFor(() => expect(transactions).toHaveLength(2));
    expect(resolved).toBe(false);
    transactions[1]!.complete();
    await writing;
    expect(resolved).toBe(true);
  });

  it("rejects transaction aborts with an operation-specific safe error", async () => {
    const { factory } = createFakeIndexedDb({
      outcomes: ["complete", "abort"],
    });
    const store = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-write-abort",
    });

    await expect(store.put("run-1", "secret output")).rejects.toMatchObject({
      code: "indexeddb_write_failed",
      message: expect.not.stringContaining("secret output"),
    });
  });

  it("aborts an in-flight IndexedDB read", async () => {
    const { factory, transactions } = createFakeIndexedDb({
      automatic: false,
    });
    const store = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-read-abort",
    });
    const controller = new AbortController();

    await vi.waitFor(() => expect(transactions).toHaveLength(1));
    transactions[0]!.complete();
    await store.initialize();

    const reading = store.get("run-1", controller.signal);
    await vi.waitFor(() => expect(transactions).toHaveLength(2));
    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stores session, creation, and schema metadata and sweeps it on session rotation", async () => {
    const { factory, records } = createFakeIndexedDb();
    const first = createIndexedDbRunTranscriptStore(factory, {
      now: () => new Date("2026-07-23T01:02:03.000Z"),
      sessionId: "session-first",
    });

    await first.put("run-first", "first transcript");
    expect(records.get("run-first")).toEqual({
      createdAt: "2026-07-23T01:02:03.000Z",
      key: "run-first",
      schemaVersion: 1,
      sessionId: "session-first",
      transcript: "first transcript",
    });

    const second = createIndexedDbRunTranscriptStore(factory, {
      now: () => new Date("2026-07-23T02:03:04.000Z"),
      sessionId: "session-second",
    });
    await second.initialize();

    expect(records.has("run-first")).toBe(false);
    expect(await first.get("run-first")).toBeNull();
    await second.put("run-second", "second transcript");
    expect(records.get("run-second")).toEqual({
      createdAt: "2026-07-23T02:03:04.000Z",
      key: "run-second",
      schemaVersion: 1,
      sessionId: "session-second",
      transcript: "second transcript",
    });
  });

  it("atomically removes legacy and malformed orphan records before accepting writes", async () => {
    const { factory, records } = createFakeIndexedDb();
    records.set("legacy", {
      key: "legacy",
      transcript: "legacy transcript",
    });
    records.set("malformed", {
      createdAt: "",
      key: "malformed",
      schemaVersion: 1,
      sessionId: "old-session",
      transcript: "malformed transcript",
    });
    const store = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-current",
    });

    await store.put("current", "current transcript");

    expect(records.has("legacy")).toBe(false);
    expect(records.has("malformed")).toBe(false);
    expect(await store.get("current")).toBe("current transcript");
  });

  it("leaves a failed current-session delete tagged for deterministic next-session cleanup", async () => {
    const { factory, queueOutcome, records } = createFakeIndexedDb();
    const first = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-delete-failure",
    });
    await first.put("run-delete", "private transcript");
    queueOutcome("abort");

    await expect(first.delete(["run-delete"])).rejects.toMatchObject({
      code: "indexeddb_delete_failed",
    });
    expect(records.get("run-delete")).toEqual(
      expect.objectContaining({
        sessionId: "session-delete-failure",
        transcript: "private transcript",
      }),
    );

    const second = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-delete-retry",
    });
    await second.initialize();

    expect(records.has("run-delete")).toBe(false);
  });

  it("fails closed when the startup sweep aborts and accepts no current-session writes", async () => {
    const { factory, records, transactions } = createFakeIndexedDb({
      outcomes: ["abort"],
    });
    records.set("legacy", {
      key: "legacy",
      transcript: "must survive the aborted transaction",
    });
    const store = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-aborted-sweep",
    });

    await expect(store.initialize()).rejects.toMatchObject({
      code: "indexeddb_initialize_failed",
    });
    await expect(
      store.put("current", "must not be written"),
    ).rejects.toMatchObject({
      code: "indexeddb_initialize_failed",
    });
    await expect(store.get("legacy")).rejects.toMatchObject({
      code: "indexeddb_initialize_failed",
    });
    expect(transactions).toHaveLength(1);
    expect(records.has("legacy")).toBe(true);
    expect(records.has("current")).toBe(false);
  });

  it("retries the untouched startup sweep on every later browser session until it commits", async () => {
    const { factory, records } = createFakeIndexedDb({
      outcomes: ["abort", "abort", "complete"],
    });
    records.set("orphan", {
      key: "orphan",
      transcript: "retry cleanup",
    });

    const first = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-retry-one",
    });
    await expect(first.initialize()).rejects.toMatchObject({
      code: "indexeddb_initialize_failed",
    });
    expect(records.has("orphan")).toBe(true);

    const second = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-retry-two",
    });
    await expect(second.initialize()).rejects.toMatchObject({
      code: "indexeddb_initialize_failed",
    });
    expect(records.has("orphan")).toBe(true);

    const third = createIndexedDbRunTranscriptStore(factory, {
      sessionId: "session-retry-three",
    });
    await third.initialize();
    expect(records.has("orphan")).toBe(false);
  });
});
