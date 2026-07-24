// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseOptions } from "@/types";

import {
  getReleaseOptionsStorageKey,
  parseReleaseOptionsCache,
  resetReleaseOptionsCacheForTests,
  useReleaseOptions,
} from "./release-options";

const api = vi.hoisted(() => ({
  options: vi.fn(),
}));

vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api")>()),
  getReleaseOptions: api.options,
}));

const options = (
  viewerLogin = "Jake",
  latestTag = "v1.2.3",
): ReleaseOptions => ({
  generatedAt: "2026-07-23T08:02:00.000Z",
  repositories: [
    {
      latestTag,
      nextTag: latestTag === "v1.2.3" ? "v1.2.4" : "v1.2.5",
      previousTags:
        latestTag === "v1.2.3" ? ["v1.2.3", "v1.2.2"] : ["v1.2.4", "v1.2.3"],
      repository: "appwrite/cloud",
      repositoryUrl: "https://github.com/appwrite/cloud",
    },
  ],
  repositoriesUpdatedAt: "2026-07-23T08:00:00.000Z",
  tagsUpdatedAt: "2026-07-23T08:01:00.000Z",
  viewerLogin,
  warnings: [],
});

const stored = (value: ReleaseOptions, viewerLogin = "jake"): string =>
  JSON.stringify({
    options: value,
    storedAt: "2026-07-23T08:03:00.000Z",
    version: 1,
    viewerLogin,
  });

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const strict = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
);

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

beforeEach(() => {
  resetReleaseOptionsCacheForTests();
  const values = new Map<string, string>();
  const storage: Storage = {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  api.options.mockReset();
});

afterEach(() => {
  cleanup();
  resetReleaseOptionsCacheForTests();
  vi.restoreAllMocks();
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
});

describe("release options cache", () => {
  it("strictly validates a canonical viewer-scoped versioned envelope", () => {
    const value = options();
    const valid = stored(value);

    expect(getReleaseOptionsStorageKey("  Jake ")).toBe(
      "puller-release-options-v1:jake",
    );
    expect(parseReleaseOptionsCache(valid, "JAKE")).toEqual(value);

    const extra = JSON.parse(valid) as Record<string, unknown>;
    extra.unexpected = true;
    expect(parseReleaseOptionsCache(JSON.stringify(extra), "jake")).toBeNull();

    const nonCanonicalViewer = JSON.parse(valid) as Record<string, unknown>;
    nonCanonicalViewer.viewerLogin = "Jake";
    expect(
      parseReleaseOptionsCache(JSON.stringify(nonCanonicalViewer), "jake"),
    ).toBeNull();

    expect(
      parseReleaseOptionsCache(stored(options("octocat")), "jake"),
    ).toBeNull();
    expect(
      parseReleaseOptionsCache(
        stored(value).replace('"version":1', '"version":2'),
        "jake",
      ),
    ).toBeNull();
    expect(parseReleaseOptionsCache("not-json", "jake")).toBeNull();
  });

  it("does not hydrate or prefetch without an authoritative viewer", async () => {
    const { result } = renderHook(() => useReleaseOptions(null, true));

    await act(async () => Promise.resolve());

    expect(result.current).toMatchObject({
      error: null,
      loading: false,
      options: null,
      refreshing: false,
      viewerLogin: null,
    });
    expect(api.options).not.toHaveBeenCalled();
  });

  it("hydrates without network and coalesces the first active load in StrictMode", async () => {
    const cached = options("Jake", "v1.2.3");
    const refreshed = options("JAKE", "v1.2.4");
    const request = deferred<ReleaseOptions>();
    window.localStorage.setItem(
      getReleaseOptionsStorageKey("jake"),
      stored(cached),
    );
    api.options.mockReturnValue(request.promise);

    const { rerender, result } = renderHook(
      ({ active }: { active: boolean }) =>
        useReleaseOptions("Jake", active),
      {
        initialProps: { active: false },
        wrapper: strict,
      },
    );

    expect(result.current.options).toEqual(cached);
    expect(result.current.loading).toBe(false);
    await act(async () => Promise.resolve());
    expect(api.options).not.toHaveBeenCalled();

    rerender({ active: true });
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));
    expect(api.options).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(result.current.refreshing).toBe(true);
    rerender({ active: false });
    rerender({ active: true });
    expect(api.options).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve(refreshed));

    await waitFor(() => expect(result.current.options).toEqual(refreshed));
    expect(result.current.refreshing).toBe(false);
    expect(
      parseReleaseOptionsCache(
        window.localStorage.getItem(getReleaseOptionsStorageKey("jake"))!,
        "jake",
      ),
    ).toEqual(refreshed);
  });

  it("coalesces background refreshes and retains cached options on failure", async () => {
    const cached = options();
    const request = deferred<ReleaseOptions>();
    api.options
      .mockResolvedValueOnce(cached)
      .mockReturnValueOnce(request.promise);
    const { result } = renderHook(() => useReleaseOptions("jake", true));
    await waitFor(() => expect(result.current.options).toEqual(cached));

    let left!: Promise<ReleaseOptions | null>;
    let right!: Promise<ReleaseOptions | null>;
    act(() => {
      left = result.current.refresh();
      right = result.current.refresh();
    });

    expect(left).toBe(right);
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));
    expect(api.options).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
    expect(result.current).toMatchObject({
      loading: false,
      options: cached,
      refreshing: true,
    });

    await act(async () => request.reject(new Error("GitHub is unavailable.")));

    await expect(left).resolves.toBeNull();
    expect(result.current).toMatchObject({
      error: "GitHub is unavailable.",
      loading: false,
      options: cached,
      refreshing: false,
    });
    expect(
      parseReleaseOptionsCache(
        window.localStorage.getItem(getReleaseOptionsStorageKey("jake"))!,
        "jake",
      ),
    ).toEqual(cached);
  });

  it("forces a post-mutation generation and ignores the older response", async () => {
    const initial = options("jake", "v1.2.3");
    const stale = options("jake", "v1.2.4");
    const current = {
      ...options("jake", "v1.2.4"),
      generatedAt: "2026-07-23T08:04:00.000Z",
      tagsUpdatedAt: "2026-07-23T08:04:00.000Z",
    };
    const background = deferred<ReleaseOptions>();
    const forced = deferred<ReleaseOptions>();
    api.options
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(background.promise)
      .mockReturnValueOnce(forced.promise);
    const { result } = renderHook(() => useReleaseOptions("jake", true));
    await waitFor(() => expect(result.current.options).toEqual(initial));

    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));
    const backgroundSignal = api.options.mock.calls[1]![1] as AbortSignal;

    let forcedPromise!: Promise<ReleaseOptions | null>;
    act(() => {
      forcedPromise = result.current.forceRefresh();
    });
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(3));
    expect(backgroundSignal.aborted).toBe(true);

    await act(async () => forced.resolve(current));
    await expect(forcedPromise).resolves.toEqual(current);
    await waitFor(() => expect(result.current.options).toEqual(current));
    expect(result.current.refreshing).toBe(false);

    await act(async () => background.resolve(stale));
    expect(result.current.options).toEqual(current);
    expect(result.current.refreshing).toBe(false);
  });

  it("invalidates late request results before resetting the module cache", async () => {
    const request = deferred<ReleaseOptions>();
    api.options.mockReturnValue(request.promise);
    const { unmount } = renderHook(() => useReleaseOptions("jake", true));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));

    unmount();
    resetReleaseOptionsCacheForTests();
    await act(async () => {
      request.resolve(options());
      await request.promise;
      await Promise.resolve();
    });

    expect(
      window.localStorage.getItem(getReleaseOptionsStorageKey("jake")),
    ).toBeNull();
  });

  it("keeps viewer caches isolated when an earlier viewer finishes late", async () => {
    const alice = deferred<ReleaseOptions>();
    const bob = deferred<ReleaseOptions>();
    api.options
      .mockReturnValueOnce(alice.promise)
      .mockReturnValueOnce(bob.promise);
    const { rerender, result } = renderHook(
      ({ viewer }: { viewer: string }) => useReleaseOptions(viewer, true),
      { initialProps: { viewer: "alice" } },
    );
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));

    rerender({ viewer: "bob" });
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));
    await act(async () => bob.resolve(options("Bob")));
    await waitFor(() => expect(result.current.viewerLogin).toBe("bob"));
    expect(result.current.options?.viewerLogin).toBe("Bob");

    await act(async () => alice.resolve(options("Alice")));
    expect(result.current.viewerLogin).toBe("bob");
    expect(result.current.options?.viewerLogin).toBe("Bob");
    expect(
      parseReleaseOptionsCache(
        window.localStorage.getItem(getReleaseOptionsStorageKey("alice"))!,
        "alice",
      )?.viewerLogin,
    ).toBe("Alice");
    expect(
      parseReleaseOptionsCache(
        window.localStorage.getItem(getReleaseOptionsStorageKey("bob"))!,
        "bob",
      )?.viewerLogin,
    ).toBe("Bob");
  });

  it("rejects a network response for a different viewer", async () => {
    api.options.mockResolvedValue(options("octocat"));

    const { result } = renderHook(() => useReleaseOptions("jake", true));

    await waitFor(() =>
      expect(result.current.error).toBe(
        "Release options returned for a different GitHub viewer.",
      ),
    );
    expect(result.current.options).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps successful options in memory when localStorage is unavailable", async () => {
    const value = options();
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    api.options.mockResolvedValue(value);

    const { result } = renderHook(() => useReleaseOptions("jake", true));

    await waitFor(() => expect(result.current.options).toEqual(value));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
