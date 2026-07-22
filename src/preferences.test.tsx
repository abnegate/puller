// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPullKey,
  PULL_PREFERENCES_STORAGE_KEY,
  selectPullView,
  usePullPreferences,
  type PullKey,
  type PullSectionItem,
} from "./preferences";
import type { RunState } from "./runs";
import type { TaskState } from "./tasks";
import { createPendingPull, createPullsResponse } from "./test/fixtures";
import type { PullReadiness, Task, TaskPhase } from "./types";

const EMPTY_KEYS: ReadonlySet<PullKey> = new Set();
const EMPTY_RUNS: ReadonlyMap<string, RunState> = new Map();

const pullWith = (
  pull: PullReadiness,
  changes: Partial<PullReadiness>,
): PullReadiness => ({
  ...pull,
  ci: { ...pull.ci, ...changes.ci },
  greptile: { ...pull.greptile, ...changes.greptile },
  ...changes,
});

const taskState = ({
  createdAt = "2026-07-22T00:00:00.000Z",
  id,
  number,
  output = "",
  phase = "running",
  repository = "appwrite/cloud",
}: {
  createdAt?: string;
  id: string;
  number?: number;
  output?: string;
  phase?: TaskPhase;
  repository?: string;
}): TaskState => {
  const task: Task = {
    base: "main",
    createdAt,
    id,
    phase,
    ...(number === undefined
      ? {}
      : {
          pullRequest: {
            number,
            url: `https://github.com/${repository}/pull/${number}`,
          },
        }),
    repository,
    title: `Task ${id}`,
    updatedAt: createdAt,
  };

  return {
    cancelling: false,
    connectionError: null,
    output,
    sequence: 3,
    task,
  };
};

const select = ({
  favorites = EMPTY_KEYS,
  hidden = EMPTY_KEYS,
  pulls = [],
  runs = EMPTY_RUNS,
  tasks = [],
}: {
  favorites?: ReadonlySet<PullKey>;
  hidden?: ReadonlySet<PullKey>;
  pulls?: readonly PullReadiness[];
  runs?: ReadonlyMap<string, RunState>;
  tasks?: readonly TaskState[];
}) => selectPullView({ favorites, hidden, pulls, runs, tasks });

const itemNumbers = (items: readonly PullSectionItem[]): Array<number | null> =>
  items.map((item) =>
    item.kind === "pull"
      ? item.pull.number
      : (item.state.task.pullRequest?.number ?? null),
  );

const stored = (favorites: unknown[], hidden: unknown[]): string =>
  JSON.stringify({ favorites, hidden, version: 1 });

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

describe("usePullPreferences", () => {
  it("reads and sanitizes a versioned snapshot synchronously", () => {
    window.localStorage.setItem(
      PULL_PREFERENCES_STORAGE_KEY,
      stored(
        [
          " Appwrite/Website#8 ",
          "appwrite/cloud#12",
          "appwrite/cloud#12",
          "not-a-pull",
          14,
        ],
        ["APPWRITE/EDGE#2", "appwrite/cloud#0", null],
      ),
    );

    const { result } = renderHook(() => usePullPreferences());

    expect([...result.current.favorites]).toEqual([
      "appwrite/cloud#12",
      "appwrite/website#8",
    ]);
    expect([...result.current.hidden]).toEqual(["appwrite/edge#2"]);
  });

  it.each([
    "not json",
    JSON.stringify({ favorites: [], hidden: [], version: 2 }),
    JSON.stringify({ favorites: "appwrite/cloud#1", hidden: [], version: 1 }),
    JSON.stringify({ favorites: [], version: 1 }),
  ])("uses empty preferences for malformed initial data: %s", (value) => {
    window.localStorage.setItem(PULL_PREFERENCES_STORAGE_KEY, value);

    const { result } = renderHook(() => usePullPreferences());

    expect([...result.current.favorites]).toEqual([]);
    expect([...result.current.hidden]).toEqual([]);
  });

  it("applies rapid actions from an authoritative snapshot and writes each change once", () => {
    const write = vi.spyOn(storage, "setItem");
    const { result } = renderHook(() => usePullPreferences(), {
      wrapper: StrictMode,
    });

    act(() => {
      result.current.setFavorite("APPWRITE/CLOUD#12", true);
      result.current.hide("appwrite/cloud#12");
      result.current.setFavorite("appwrite/edge#7", true);
      result.current.show("appwrite/cloud#12");
    });

    expect([...result.current.favorites]).toEqual([
      "appwrite/cloud#12",
      "appwrite/edge#7",
    ]);
    expect([...result.current.hidden]).toEqual([]);
    expect(write).toHaveBeenCalledTimes(4);
    expect(
      JSON.parse(window.localStorage.getItem(PULL_PREFERENCES_STORAGE_KEY)!),
    ).toEqual({
      favorites: ["appwrite/cloud#12", "appwrite/edge#7"],
      hidden: [],
      version: 1,
    });
  });

  it("keeps favourite state while hiding, showing, and showing all pulls", () => {
    window.localStorage.setItem(
      PULL_PREFERENCES_STORAGE_KEY,
      stored(
        ["appwrite/cloud#12"],
        ["appwrite/edge#8", "dormant/repository#99"],
      ),
    );
    const { result } = renderHook(() => usePullPreferences());

    act(() => result.current.hide("appwrite/cloud#12"));
    expect(result.current.favorites.has("appwrite/cloud#12")).toBe(true);
    expect(result.current.hidden.has("appwrite/cloud#12")).toBe(true);

    act(() => result.current.show("appwrite/cloud#12"));
    expect(result.current.favorites.has("appwrite/cloud#12")).toBe(true);
    expect(result.current.hidden.has("appwrite/cloud#12")).toBe(false);

    act(() => result.current.showAll());
    expect([...result.current.hidden]).toEqual([]);
    expect([...result.current.favorites]).toEqual(["appwrite/cloud#12"]);
    expect(
      JSON.parse(window.localStorage.getItem(PULL_PREFERENCES_STORAGE_KEY)!),
    ).toEqual({
      favorites: ["appwrite/cloud#12"],
      hidden: [],
      version: 1,
    });
  });

  it("keeps in-memory changes when local storage writes fail", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const { result } = renderHook(() => usePullPreferences());

    act(() => {
      result.current.setFavorite("appwrite/cloud#12", true);
      result.current.hide("appwrite/cloud#12");
    });

    expect(result.current.favorites.has("appwrite/cloud#12")).toBe(true);
    expect(result.current.hidden.has("appwrite/cloud#12")).toBe(true);
  });

  it("accepts valid cross-tab updates without echoing them to storage", () => {
    const write = vi.spyOn(storage, "setItem");
    const { result } = renderHook(() => usePullPreferences());

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PULL_PREFERENCES_STORAGE_KEY,
          newValue: stored(
            ["APPWRITE/WEBSITE#4", "invalid"],
            ["appwrite/cloud#12"],
          ),
        }),
      );
    });

    expect([...result.current.favorites]).toEqual(["appwrite/website#4"]);
    expect([...result.current.hidden]).toEqual(["appwrite/cloud#12"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores same-named updates from a different storage area", () => {
    const { result } = renderHook(() => usePullPreferences());
    const event = new StorageEvent("storage", {
      key: PULL_PREFERENCES_STORAGE_KEY,
      newValue: stored(["appwrite/cloud#12"], []),
    });
    Object.defineProperty(event, "storageArea", {
      value: {} as Storage,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect([...result.current.favorites]).toEqual([]);
    expect([...result.current.hidden]).toEqual([]);
  });

  it("ignores malformed cross-tab data and resets when the key is removed", () => {
    window.localStorage.setItem(
      PULL_PREFERENCES_STORAGE_KEY,
      stored(["appwrite/cloud#12"], ["appwrite/edge#8"]),
    );
    const { result } = renderHook(() => usePullPreferences());

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PULL_PREFERENCES_STORAGE_KEY,
          newValue: "broken",
        }),
      );
    });
    expect([...result.current.favorites]).toEqual(["appwrite/cloud#12"]);
    expect([...result.current.hidden]).toEqual(["appwrite/edge#8"]);

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PULL_PREFERENCES_STORAGE_KEY,
          newValue: null,
        }),
      );
    });
    expect([...result.current.favorites]).toEqual([]);
    expect([...result.current.hidden]).toEqual([]);
  });

  it("resets preferences when another tab clears the same storage area", () => {
    window.localStorage.setItem(
      PULL_PREFERENCES_STORAGE_KEY,
      stored(["appwrite/cloud#12"], ["appwrite/edge#8"]),
    );
    const { result } = renderHook(() => usePullPreferences());
    const event = new StorageEvent("storage", { key: null, newValue: null });
    Object.defineProperty(event, "storageArea", { value: storage });

    act(() => {
      window.dispatchEvent(event);
    });

    expect([...result.current.favorites]).toEqual([]);
    expect([...result.current.hidden]).toEqual([]);
  });

  it("ignores clear events from a different storage area", () => {
    window.localStorage.setItem(
      PULL_PREFERENCES_STORAGE_KEY,
      stored(["appwrite/cloud#12"], ["appwrite/edge#8"]),
    );
    const { result } = renderHook(() => usePullPreferences());
    const event = new StorageEvent("storage", { key: null, newValue: null });
    Object.defineProperty(event, "storageArea", { value: {} as Storage });

    act(() => {
      window.dispatchEvent(event);
    });

    expect([...result.current.favorites]).toEqual(["appwrite/cloud#12"]);
    expect([...result.current.hidden]).toEqual(["appwrite/edge#8"]);
  });

  it("ignores invalid action identities", () => {
    const write = vi.spyOn(storage, "setItem");
    const { result } = renderHook(() => usePullPreferences());

    act(() => {
      result.current.setFavorite("not-a-pull", true);
      result.current.hide("appwrite/cloud#0");
      result.current.show("missing/repository#-1");
    });

    expect([...result.current.favorites]).toEqual([]);
    expect([...result.current.hidden]).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("selectPullView", () => {
  it("uses the existing pull grouping, rank order, and task order without preferences", () => {
    const response = createPullsResponse();
    const pending = createPendingPull(3);
    const newerTask = taskState({
      createdAt: "2026-07-22T02:00:00.000Z",
      id: "newer",
    });
    const olderTask = taskState({
      createdAt: "2026-07-22T01:00:00.000Z",
      id: "older",
    });

    const view = select({
      pulls: [response.notReady[0]!, pending, response.ready[0]!],
      tasks: [olderTask, newerTask],
    });

    expect(itemNumbers(view.groups.ready)).toEqual([101]);
    expect(view.groups.progress.map((item) => item.key)).toEqual([
      "task:newer",
      "task:older",
      `pull:${pending.url}`,
    ]);
    expect(itemNumbers(view.groups.blocked)).toEqual([102]);
    expect(view.knownCount).toBe(5);
    expect(view.visibleCount).toBe(5);
    expect(view.hiddenCount).toBe(0);
  });

  it("stable-partitions favourites ahead of non-favourites inside each section", () => {
    const ready = createPullsResponse().ready[0]!;
    const pulls = [
      pullWith(ready, { number: 11, rank: 1, url: `${ready.url}-11` }),
      pullWith(ready, { number: 12, rank: 2, url: `${ready.url}-12` }),
      pullWith(ready, { number: 13, rank: 3, url: `${ready.url}-13` }),
      pullWith(ready, { number: 14, rank: 4, url: `${ready.url}-14` }),
    ];

    const view = select({
      favorites: new Set([getPullKey(pulls[1]!), getPullKey(pulls[2]!)]),
      pulls,
    });

    expect(itemNumbers(view.groups.ready)).toEqual([12, 13, 11, 14]);
  });

  it("puts a favourite pull before a non-favourite task in progress", () => {
    const pending = createPendingPull();
    const task = taskState({ id: "without-pr" });

    const view = select({
      favorites: new Set([getPullKey(pending)]),
      pulls: [pending],
      tasks: [task],
    });

    expect(view.groups.progress.map((item) => item.kind)).toEqual([
      "pull",
      "task",
    ]);
  });

  it("keeps tasks without a pull request visible and outside preferences", () => {
    const task = taskState({ id: "preparing" });

    const view = select({
      favorites: new Set(["appwrite/cloud#999"]),
      hidden: new Set(["appwrite/cloud#999"]),
      tasks: [task],
    });

    expect(view.groups.progress).toHaveLength(1);
    expect(view.groups.progress[0]).toMatchObject({
      favorite: false,
      identity: null,
      kind: "task",
    });
    expect(view.hiddenCount).toBe(0);
  });

  it("deduplicates an active task from its canonical pull before hiding", () => {
    const pull = createPullsResponse().ready[0]!;
    const task = taskState({
      id: "repair",
      number: pull.number,
      output: "Repair is still running.\n",
    });
    const identity = getPullKey(pull);

    const hidden = select({
      hidden: new Set([identity]),
      pulls: [pull],
      tasks: [task],
    });

    expect(hidden.groups.ready).toEqual([]);
    expect(hidden.groups.progress).toEqual([]);
    expect(hidden.hidden).toHaveLength(1);
    expect(hidden.hidden[0]).toMatchObject({
      key: "task:repair",
      kind: "task",
    });
    expect(hidden.hiddenCount).toBe(1);
    expect(hidden.knownCount).toBe(1);

    const restored = select({ pulls: [pull], tasks: [task] });
    expect(restored.groups.progress).toHaveLength(1);
    const item = restored.groups.progress[0];
    expect(item?.kind).toBe("task");
    if (item?.kind === "task") {
      expect(item.state).toBe(task);
      expect(item.state.output).toBe("Repair is still running.\n");
    }
  });

  it("deduplicates multiple task rows for one pull and prefers the active task", () => {
    const completed = taskState({
      createdAt: "2026-07-22T02:00:00.000Z",
      id: "completed",
      number: 700,
      phase: "completed",
    });
    const active = taskState({
      createdAt: "2026-07-22T01:00:00.000Z",
      id: "active",
      number: 700,
      phase: "running",
    });

    const view = select({ tasks: [active, completed] });

    expect(view.groups.progress).toHaveLength(1);
    expect(view.groups.progress[0]).toMatchObject({ key: "task:active" });
    expect(view.knownCount).toBe(1);
  });

  it("drops a terminal task when its authored canonical pull is available", () => {
    const pull = createPullsResponse().ready[0]!;
    const task = taskState({
      id: "completed",
      number: pull.number,
      phase: "completed",
    });

    const view = select({ pulls: [pull], tasks: [task] });

    expect(view.groups.progress).toEqual([]);
    expect(itemNumbers(view.groups.ready)).toEqual([pull.number]);
    expect(view.knownCount).toBe(1);
  });

  it("retains preference identity across head and readiness changes", () => {
    const pull = createPullsResponse().ready[0]!;
    const identity = getPullKey(pull);
    const changed = pullWith(pull, {
      blockers: ["CI checks pending"],
      ci: {
        ...pull.ci,
        running: 1,
        state: "pending",
      },
      headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      ready: false,
    });

    const view = select({
      favorites: new Set([identity]),
      pulls: [changed],
    });

    expect(view.groups.ready).toEqual([]);
    expect(view.groups.progress[0]).toMatchObject({
      favorite: true,
      identity,
      kind: "pull",
    });
  });

  it("restores a hidden favourite at the top of its section", () => {
    const ready = createPullsResponse().ready[0]!;
    const first = pullWith(ready, {
      number: 50,
      rank: 1,
      url: `${ready.url}-50`,
    });
    const favorite = pullWith(ready, {
      number: 51,
      rank: 2,
      url: `${ready.url}-51`,
    });
    const identity = getPullKey(favorite);

    const hidden = select({
      favorites: new Set([identity]),
      hidden: new Set([identity]),
      pulls: [first, favorite],
    });
    expect(itemNumbers(hidden.groups.ready)).toEqual([50]);
    expect(hidden.hidden[0]).toMatchObject({ favorite: true, identity });

    const restored = select({
      favorites: new Set([identity]),
      pulls: [first, favorite],
    });
    expect(itemNumbers(restored.groups.ready)).toEqual([51, 50]);
  });

  it("counts only known hidden rows while preserving dormant hidden preferences", () => {
    const response = createPullsResponse();
    const identity = getPullKey(response.ready[0]!);

    const view = select({
      hidden: new Set([identity, "dormant/repository#99"]),
      pulls: [response.ready[0]!, response.notReady[0]!],
    });

    expect(view.hidden.map((item) => item.identity)).toEqual([identity]);
    expect(view.hiddenCount).toBe(1);
    expect(view.knownCount).toBe(2);
    expect(view.visibleCount).toBe(1);
  });
});
