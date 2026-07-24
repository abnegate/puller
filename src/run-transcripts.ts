export type RunTranscriptFailureCode =
  | "indexeddb_unavailable"
  | "indexeddb_open_failed"
  | "indexeddb_blocked"
  | "indexeddb_initialize_failed"
  | "indexeddb_read_failed"
  | "indexeddb_write_failed"
  | "indexeddb_delete_failed";

export class RunTranscriptStoreError extends Error {
  readonly code: RunTranscriptFailureCode;

  constructor(code: RunTranscriptFailureCode, message: string) {
    super(message);
    this.name = "RunTranscriptStoreError";
    this.code = code;
  }
}

export interface RunTranscriptStore {
  readonly retriesFailedDeletes: boolean;
  delete(keys: readonly string[]): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<string | null>;
  initialize(): Promise<void>;
  put(key: string, transcript: string): Promise<void>;
}

type TranscriptRecord = {
  createdAt: string;
  key: string;
  schemaVersion: number;
  sessionId: string;
  transcript: string;
};

const DATABASE_NAME = "puller-run-history";
const DATABASE_VERSION = 1;
const RECORD_SCHEMA_VERSION = 1;
const STORE_NAME = "transcripts";

const abortError = (): DOMException =>
  new DOMException("The transcript request was aborted.", "AbortError");

const withAbort = async <Value>(
  promise: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  if (!signal) return await promise;
  if (signal.aborted) throw abortError();

  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
};

const transactionError = (
  code: RunTranscriptFailureCode,
  operation: string,
): RunTranscriptStoreError =>
  new RunTranscriptStoreError(
    code,
    `The run transcript could not be ${operation} in browser storage.`,
  );

export const createMemoryRunTranscriptStore = (): RunTranscriptStore => {
  const transcripts = new Map<string, string>();

  return {
    retriesFailedDeletes: false,
    async delete(keys) {
      for (const key of keys) transcripts.delete(key);
    },
    async get(key, signal) {
      if (signal?.aborted) throw abortError();
      return transcripts.get(key) ?? null;
    },
    async initialize() {},
    async put(key, transcript) {
      transcripts.set(key, transcript);
    },
  };
};

export const createUnavailableRunTranscriptStore = (
  code: RunTranscriptFailureCode,
  message: string,
): RunTranscriptStore => {
  const unavailable = (): RunTranscriptStoreError =>
    new RunTranscriptStoreError(code, message);

  return {
    retriesFailedDeletes: false,
    async delete() {
      throw unavailable();
    },
    async get(_key, signal) {
      if (signal?.aborted) throw abortError();
      throw unavailable();
    },
    async initialize() {
      throw unavailable();
    },
    async put() {
      throw unavailable();
    },
  };
};

export type IndexedDbRunTranscriptStoreOptions = {
  now?: () => Date;
  sessionId?: string;
};

const newSessionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const random = new Uint32Array(4);
  globalThis.crypto?.getRandomValues(random);
  return `${Date.now()}-${[...random].join("-")}`;
};

const isTranscriptRecord = (value: unknown): value is TranscriptRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TranscriptRecord>;
  return (
    typeof record.createdAt === "string" &&
    record.createdAt.length > 0 &&
    typeof record.key === "string" &&
    record.schemaVersion === RECORD_SCHEMA_VERSION &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.transcript === "string"
  );
};

export const createIndexedDbRunTranscriptStore = (
  factory: IDBFactory,
  {
    now = () => new Date(),
    sessionId = newSessionId(),
  }: IndexedDbRunTranscriptStoreOptions = {},
): RunTranscriptStore => {
  let databasePromise: Promise<IDBDatabase> | null = null;
  let initializationPromise: Promise<void> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let settled = false;
      try {
        request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      } catch {
        reject(
          new RunTranscriptStoreError(
            "indexeddb_open_failed",
            "Run transcript browser storage could not be opened.",
          ),
        );
        return;
      }

      const fail = (
        code: Extract<
          RunTranscriptFailureCode,
          "indexeddb_blocked" | "indexeddb_open_failed"
        >,
        message: string,
      ) => {
        if (settled) return;
        settled = true;
        reject(new RunTranscriptStoreError(code, message));
      };

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onblocked = () =>
        fail(
          "indexeddb_blocked",
          "Run transcript browser storage is blocked by another page.",
        );
      request.onerror = () =>
        fail(
          "indexeddb_open_failed",
          "Run transcript browser storage could not be opened.",
        );
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });

    return databasePromise;
  };

  const transact = async <Value>({
    code,
    mode,
    operation,
    signal,
    start,
  }: {
    code: RunTranscriptFailureCode;
    mode: IDBTransactionMode;
    operation: string;
    signal?: AbortSignal;
    start: (store: IDBObjectStore, setValue: (value: Value) => void) => void;
  }): Promise<Value> => {
    const database = await withAbort(open(), signal);
    if (signal?.aborted) throw abortError();

    return await new Promise<Value>((resolve, reject) => {
      let transaction: IDBTransaction;
      let value: Value;
      let hasValue = false;
      let settled = false;

      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", aborted);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const aborted = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have completed.
        }
        fail(abortError());
      };

      try {
        transaction = database.transaction(STORE_NAME, mode);
        start(transaction.objectStore(STORE_NAME), (next) => {
          value = next;
          hasValue = true;
        });
      } catch {
        fail(transactionError(code, operation));
        return;
      }

      if (signal) signal.addEventListener("abort", aborted, { once: true });
      transaction.onabort = () => {
        if (signal?.aborted) fail(abortError());
        else fail(transactionError(code, operation));
      };
      transaction.onerror = () => fail(transactionError(code, operation));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(hasValue ? value : (undefined as Value));
      };
    });
  };

  const initialize = (): Promise<void> => {
    if (initializationPromise) return initializationPromise;

    initializationPromise = transact<void>({
      code: "indexeddb_initialize_failed",
      mode: "readwrite",
      operation: "initialized",
      start: (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;

          const record = cursor.value;
          if (!isTranscriptRecord(record) || record.sessionId !== sessionId) {
            cursor.delete();
          }
          cursor.continue();
        };
      },
    }).catch(async (error: unknown) => {
      try {
        const database = await databasePromise;
        database?.close();
      } catch {
        // The original initialization error remains authoritative.
      }
      throw error;
    });
    void initializationPromise.catch(() => undefined);
    return initializationPromise;
  };

  const store: RunTranscriptStore = {
    retriesFailedDeletes: true,
    async delete(keys) {
      if (keys.length === 0) return;
      await initialize();
      await transact<void>({
        code: "indexeddb_delete_failed",
        mode: "readwrite",
        operation: "deleted",
        start: (store) => {
          for (const key of new Set(keys)) {
            const request = store.get(key);
            request.onsuccess = () => {
              const record = request.result;
              if (
                isTranscriptRecord(record) &&
                record.sessionId === sessionId
              ) {
                store.delete(key);
              }
            };
          }
        },
      });
    },
    async get(key, signal) {
      await withAbort(initialize(), signal);
      return await transact<string | null>({
        code: "indexeddb_read_failed",
        mode: "readonly",
        operation: "read",
        signal,
        start: (store, setValue) => {
          const request = store.get(key);
          request.onsuccess = () => {
            const record: unknown = request.result;
            setValue(
              isTranscriptRecord(record) && record.sessionId === sessionId
                ? record.transcript
                : null,
            );
          };
        },
      });
    },
    initialize,
    async put(key, transcript) {
      await initialize();
      await transact<void>({
        code: "indexeddb_write_failed",
        mode: "readwrite",
        operation: "saved",
        start: (store) => {
          store.put({
            createdAt: now().toISOString(),
            key,
            schemaVersion: RECORD_SCHEMA_VERSION,
            sessionId,
            transcript,
          } satisfies TranscriptRecord);
        },
      });
    },
  };

  void initialize();
  return store;
};

export const createBrowserRunTranscriptStore = (): RunTranscriptStore => {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return createUnavailableRunTranscriptStore(
      "indexeddb_unavailable",
      "Run transcript browser storage is unavailable.",
    );
  }

  return createIndexedDbRunTranscriptStore(factory);
};

export const browserRunTranscriptStore = createBrowserRunTranscriptStore();
