// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalRepository,
  parseRepositoryPreferences,
  REPOSITORY_PREFERENCES_STORAGE_KEY,
  useRepositoryPreferences,
} from "./repository-preferences";

const stored = (favorites: unknown[]): string =>
  JSON.stringify({ favorites, version: 1 });

let storage: Storage;

beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("repository preferences", () => {
  it("canonicalizes repository identities and rejects unsafe values", () => {
    expect(canonicalRepository(" Appwrite/Cloud ")).toBe("appwrite/cloud");
    expect(canonicalRepository("appwrite/../cloud")).toBeNull();
    expect(canonicalRepository("appwrite/cloud/extra")).toBeNull();
    expect(canonicalRepository(14)).toBeNull();
  });

  it("parses a strict versioned snapshot and sanitizes its favorites", () => {
    expect(
      parseRepositoryPreferences(
        stored([
          " Appwrite/Website ",
          "appwrite/cloud",
          "APPWRITE/CLOUD",
          "invalid",
          null,
        ]),
      )?.favorites,
    ).toEqual(new Set(["appwrite/cloud", "appwrite/website"]));

    expect(parseRepositoryPreferences("not json")).toBeNull();
    expect(
      parseRepositoryPreferences(JSON.stringify({ favorites: [], version: 2 })),
    ).toBeNull();
    expect(
      parseRepositoryPreferences(
        JSON.stringify({ extra: true, favorites: [], version: 1 }),
      ),
    ).toBeNull();
  });

  it("persists unavailable favorites and synchronizes hooks in this page", () => {
    window.localStorage.setItem(
      REPOSITORY_PREFERENCES_STORAGE_KEY,
      stored(["dormant/repository"]),
    );
    const first = renderHook(() => useRepositoryPreferences());
    const second = renderHook(() => useRepositoryPreferences());

    act(() => first.result.current.setFavorite("APPWRITE/CLOUD", true));

    expect([...first.result.current.favorites]).toEqual([
      "dormant/repository",
      "appwrite/cloud",
    ]);
    expect([...second.result.current.favorites]).toEqual([
      "dormant/repository",
      "appwrite/cloud",
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem(REPOSITORY_PREFERENCES_STORAGE_KEY)!,
      ),
    ).toEqual({
      favorites: ["appwrite/cloud", "dormant/repository"],
      version: 1,
    });
  });

  it("accepts valid cross-tab updates, ignores malformed data, and handles removal", () => {
    const write = vi.spyOn(storage, "setItem");
    const { result } = renderHook(() => useRepositoryPreferences());

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: REPOSITORY_PREFERENCES_STORAGE_KEY,
          newValue: stored(["APPWRITE/EDGE", "invalid"]),
        }),
      );
    });
    expect([...result.current.favorites]).toEqual(["appwrite/edge"]);
    expect(write).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: REPOSITORY_PREFERENCES_STORAGE_KEY,
          newValue: "broken",
        }),
      );
    });
    expect([...result.current.favorites]).toEqual(["appwrite/edge"]);

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: REPOSITORY_PREFERENCES_STORAGE_KEY,
          newValue: null,
        }),
      );
    });
    expect([...result.current.favorites]).toEqual([]);
  });

  it("resets favorites when another tab clears local storage", () => {
    const { result } = renderHook(() => useRepositoryPreferences());
    act(() => result.current.setFavorite("appwrite/cloud", true));
    expect([...result.current.favorites]).toEqual(["appwrite/cloud"]);

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, newValue: null }),
      );
    });

    expect([...result.current.favorites]).toEqual([]);
  });

  it("keeps in-memory changes when local storage is unavailable", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const { result } = renderHook(() => useRepositoryPreferences());

    act(() => result.current.setFavorite("appwrite/cloud", true));

    expect(result.current.favorites.has("appwrite/cloud")).toBe(true);
  });
});
