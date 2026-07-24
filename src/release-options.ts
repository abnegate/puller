import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { getReleaseOptions, isReleaseOptions } from "@/api";
import type { ReleaseOptions } from "@/types";

export const RELEASE_OPTIONS_STORAGE_PREFIX = "puller-release-options-v1:";

const CACHE_VERSION = 1;

type StoredReleaseOptions = {
  options: ReleaseOptions;
  storedAt: string;
  version: typeof CACHE_VERSION;
  viewerLogin: string;
};

export type ReleaseOptionsSnapshot = {
  error: string | null;
  loading: boolean;
  options: ReleaseOptions | null;
  refreshing: boolean;
  viewerLogin: string | null;
};

export type ReleaseOptionsResource = ReleaseOptionsSnapshot & {
  forceRefresh: () => Promise<ReleaseOptions | null>;
  refresh: () => Promise<ReleaseOptions | null>;
};

type NetworkWork = {
  controller: AbortController;
  generation: number;
  promise: Promise<ReleaseOptions | null>;
};

type RefreshWork = {
  cancelled: boolean;
  controller: AbortController | null;
  promise: Promise<ReleaseOptions | null>;
};

type CacheEntry = {
  activeGenerations: Set<number>;
  error: string | null;
  generation: number;
  initialStarted: boolean;
  initialWork: NetworkWork | null;
  options: ReleaseOptions | null;
  refreshPending: boolean;
  refreshWork: RefreshWork | null;
  snapshot: ReleaseOptionsSnapshot;
  subscribers: Set<() => void>;
  viewerLogin: string;
};

const entries = new Map<string, CacheEntry>();

const EMPTY_SNAPSHOT: ReleaseOptionsSnapshot = Object.freeze({
  error: null,
  loading: false,
  options: null,
  refreshing: false,
  viewerLogin: null,
});

const normalizeViewer = (viewerLogin: string): string =>
  viewerLogin.trim().toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
};

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
};

export const getReleaseOptionsStorageKey = (viewerLogin: string): string => {
  const viewer = normalizeViewer(viewerLogin);
  if (!viewer) throw new TypeError("A GitHub viewer is required.");
  return `${RELEASE_OPTIONS_STORAGE_PREFIX}${encodeURIComponent(viewer)}`;
};

export const parseReleaseOptionsCache = (
  value: string,
  viewerLogin: string,
): ReleaseOptions | null => {
  const viewer = normalizeViewer(viewerLogin);
  if (!viewer) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, [
        "options",
        "storedAt",
        "version",
        "viewerLogin",
      ]) ||
      parsed.version !== CACHE_VERSION ||
      parsed.viewerLogin !== viewer ||
      !isCanonicalTimestamp(parsed.storedAt) ||
      !isReleaseOptions(parsed.options) ||
      normalizeViewer(parsed.options.viewerLogin) !== viewer
    ) {
      return null;
    }
    return parsed.options;
  } catch {
    return null;
  }
};

const readOptions = (viewerLogin: string): ReleaseOptions | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(
      getReleaseOptionsStorageKey(viewerLogin),
    );
    return value === null ? null : parseReleaseOptionsCache(value, viewerLogin);
  } catch {
    return null;
  }
};

const writeOptions = (entry: CacheEntry, options: ReleaseOptions): void => {
  if (typeof window === "undefined") return;
  const stored: StoredReleaseOptions = {
    options,
    storedAt: new Date().toISOString(),
    version: CACHE_VERSION,
    viewerLogin: entry.viewerLogin,
  };
  try {
    window.localStorage.setItem(
      getReleaseOptionsStorageKey(entry.viewerLogin),
      JSON.stringify(stored),
    );
  } catch {
    // The viewer-scoped cache remains available in memory for this page.
  }
};

const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "Release options could not be loaded.";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const createSnapshot = (entry: CacheEntry): ReleaseOptionsSnapshot => {
  const busy =
    entry.activeGenerations.has(entry.generation) ||
    entry.refreshPending;
  return Object.freeze({
    error: entry.error,
    loading: busy && entry.options === null,
    options: entry.options,
    refreshing: busy && entry.options !== null,
    viewerLogin: entry.viewerLogin,
  });
};

const publish = (entry: CacheEntry): void => {
  entry.snapshot = createSnapshot(entry);
  for (const subscriber of entry.subscribers) subscriber();
};

const entryFor = (viewerLogin: string): CacheEntry => {
  const viewer = normalizeViewer(viewerLogin);
  const existing = entries.get(viewer);
  if (existing) return existing;

  const entry: CacheEntry = {
    activeGenerations: new Set(),
    error: null,
    generation: 0,
    initialStarted: false,
    initialWork: null,
    options: readOptions(viewer),
    refreshPending: false,
    refreshWork: null,
    snapshot: EMPTY_SNAPSHOT,
    subscribers: new Set(),
    viewerLogin: viewer,
  };
  entry.snapshot = createSnapshot(entry);
  entries.set(viewer, entry);
  return entry;
};

const startNetwork = (entry: CacheEntry, refresh: boolean): NetworkWork => {
  const controller = new AbortController();
  const generation = ++entry.generation;
  entry.activeGenerations.add(generation);
  entry.error = null;
  publish(entry);

  const promise = getReleaseOptions(refresh, controller.signal)
    .then((options) => {
      if (generation !== entry.generation) return null;
      if (normalizeViewer(options.viewerLogin) !== entry.viewerLogin) {
        entry.error = "Release options returned for a different GitHub viewer.";
        return null;
      }
      entry.options = options;
      entry.error = null;
      writeOptions(entry, options);
      return options;
    })
    .catch((error: unknown) => {
      if (generation === entry.generation && !isAbortError(error)) {
        entry.error = errorText(error);
      }
      return null;
    })
    .finally(() => {
      entry.activeGenerations.delete(generation);
      if (generation === entry.generation) publish(entry);
    });

  return { controller, generation, promise };
};

const prefetch = (entry: CacheEntry): Promise<ReleaseOptions | null> => {
  if (entry.initialStarted) {
    return entry.initialWork?.promise ?? Promise.resolve(entry.options);
  }

  entry.initialStarted = true;
  const work = startNetwork(entry, false);
  entry.initialWork = work;
  void work.promise.finally(() => {
    if (entry.initialWork === work) entry.initialWork = null;
  });
  return work.promise;
};

const cancelRefresh = (entry: CacheEntry): void => {
  const current = entry.refreshWork;
  if (!current) return;
  current.cancelled = true;
  current.controller?.abort();
  entry.refreshWork = null;
  entry.refreshPending = false;
};

const refresh = (entry: CacheEntry): Promise<ReleaseOptions | null> => {
  if (entry.refreshWork) return entry.refreshWork.promise;

  const current: RefreshWork = {
    cancelled: false,
    controller: null,
    promise: Promise.resolve(null),
  };
  entry.refreshPending = true;
  publish(entry);

  const wait = entry.initialWork?.promise ?? Promise.resolve(entry.options);
  current.promise = wait
    .then(() => {
      if (current.cancelled) return null;
      const work = startNetwork(entry, true);
      current.controller = work.controller;
      return work.promise;
    })
    .finally(() => {
      if (entry.refreshWork !== current) return;
      entry.refreshWork = null;
      entry.refreshPending = false;
      publish(entry);
    });
  entry.refreshWork = current;
  return current.promise;
};

const forceRefresh = (entry: CacheEntry): Promise<ReleaseOptions | null> => {
  entry.initialStarted = true;
  entry.initialWork?.controller.abort();
  entry.initialWork = null;
  cancelRefresh(entry);

  const work = startNetwork(entry, true);
  const current: RefreshWork = {
    cancelled: false,
    controller: work.controller,
    promise: work.promise,
  };
  entry.refreshWork = current;
  void current.promise.finally(() => {
    if (entry.refreshWork === current) {
      entry.refreshWork = null;
      publish(entry);
    }
  });
  return current.promise;
};

export function useReleaseOptions(
  viewerLogin: string | null,
  active = false,
): ReleaseOptionsResource {
  const viewer = viewerLogin ? normalizeViewer(viewerLogin) : "";
  const entry = useMemo(() => (viewer ? entryFor(viewer) : null), [viewer]);
  const subscribe = useCallback(
    (subscriber: () => void): (() => void) => {
      if (!entry) return () => undefined;
      entry.subscribers.add(subscriber);
      return () => entry.subscribers.delete(subscriber);
    },
    [entry],
  );
  const getSnapshot = useCallback(
    (): ReleaseOptionsSnapshot => entry?.snapshot ?? EMPTY_SNAPSHOT,
    [entry],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!active || !entry) return;
    if (!entry.initialStarted) {
      void prefetch(entry);
      return;
    }
    if (!entry.initialWork) void refresh(entry);
  }, [active, entry]);

  const regularRefresh = useCallback(
    (): Promise<ReleaseOptions | null> =>
      entry
        ? entry.initialStarted
          ? refresh(entry)
          : prefetch(entry)
        : Promise.resolve(null),
    [entry],
  );
  const forcedRefresh = useCallback(
    (): Promise<ReleaseOptions | null> =>
      entry ? forceRefresh(entry) : Promise.resolve(null),
    [entry],
  );

  return useMemo(
    () => ({
      ...snapshot,
      forceRefresh: forcedRefresh,
      refresh: regularRefresh,
    }),
    [forcedRefresh, regularRefresh, snapshot],
  );
}

export const resetReleaseOptionsCacheForTests = (): void => {
  for (const entry of entries.values()) {
    entry.generation += 1;
    entry.initialWork?.controller.abort();
    entry.refreshWork?.controller?.abort();
    entry.subscribers.clear();
  }
  entries.clear();
};
