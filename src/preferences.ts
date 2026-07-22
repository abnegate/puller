import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { groupPulls, type RunState } from "./runs";
import { isTaskActive, type TaskState } from "./tasks";
import type { PullReadiness } from "./types";

export const PULL_PREFERENCES_STORAGE_KEY = "puller-pull-preferences";

const PREFERENCES_VERSION = 1;

export type PullKey = string;

type PreferenceSnapshot = {
  favorites: ReadonlySet<PullKey>;
  hidden: ReadonlySet<PullKey>;
};

type StoredPullPreferences = {
  favorites: string[];
  hidden: string[];
  version: typeof PREFERENCES_VERSION;
};

export type PullPreferences = PreferenceSnapshot & {
  hide: (key: PullKey) => void;
  setFavorite: (key: PullKey, favorite: boolean) => void;
  show: (key: PullKey) => void;
  showAll: () => void;
};

export type PullSectionItem =
  | {
      favorite: boolean;
      identity: PullKey;
      key: string;
      kind: "pull";
      pull: PullReadiness;
    }
  | {
      favorite: boolean;
      identity: PullKey | null;
      key: string;
      kind: "task";
      state: TaskState;
    };

export type ReadinessGroups = {
  blocked: readonly PullSectionItem[];
  progress: readonly PullSectionItem[];
  ready: readonly PullSectionItem[];
};

export type PullView = {
  groups: ReadinessGroups;
  hidden: readonly PullSectionItem[];
  hiddenCount: number;
  knownCount: number;
  visibleCount: number;
};

export type PullViewInput = {
  favorites: ReadonlySet<PullKey>;
  hidden: ReadonlySet<PullKey>;
  pulls: readonly PullReadiness[];
  runs: ReadonlyMap<string, RunState>;
  tasks: readonly TaskState[];
};

const emptySnapshot = (): PreferenceSnapshot => ({
  favorites: new Set<PullKey>(),
  hidden: new Set<PullKey>(),
});

const canonicalKey = (value: unknown): PullKey | null => {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return /^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(normalized) ? normalized : null;
};

export const getPullKey = (
  pull: Pick<PullReadiness, "number" | "repository">,
): PullKey => `${pull.repository.trim().toLowerCase()}#${pull.number}`;

const sanitize = (values: unknown[]): ReadonlySet<PullKey> =>
  new Set(
    values
      .map(canonicalKey)
      .filter((value): value is PullKey => value !== null)
      .sort(),
  );

const parseSnapshot = (value: string): PreferenceSnapshot | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== PREFERENCES_VERSION ||
      !("favorites" in parsed) ||
      !Array.isArray(parsed.favorites) ||
      !("hidden" in parsed) ||
      !Array.isArray(parsed.hidden)
    ) {
      return null;
    }

    return {
      favorites: sanitize(parsed.favorites),
      hidden: sanitize(parsed.hidden),
    };
  } catch {
    return null;
  }
};

const readSnapshot = (storageKey: string): PreferenceSnapshot => {
  if (typeof window === "undefined") return emptySnapshot();

  try {
    const value = window.localStorage.getItem(storageKey);
    return value === null
      ? emptySnapshot()
      : (parseSnapshot(value) ?? emptySnapshot());
  } catch {
    return emptySnapshot();
  }
};

const storedSnapshot = (
  snapshot: PreferenceSnapshot,
): StoredPullPreferences => ({
  favorites: [...snapshot.favorites].sort(),
  hidden: [...snapshot.hidden].sort(),
  version: PREFERENCES_VERSION,
});

const equalSets = (
  left: ReadonlySet<PullKey>,
  right: ReadonlySet<PullKey>,
): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

const equalSnapshots = (
  left: PreferenceSnapshot,
  right: PreferenceSnapshot,
): boolean =>
  equalSets(left.favorites, right.favorites) &&
  equalSets(left.hidden, right.hidden);

export function usePullPreferences(): PullPreferences {
  const [snapshot, setSnapshot] = useState<PreferenceSnapshot>(() =>
    readSnapshot(PULL_PREFERENCES_STORAGE_KEY),
  );
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== PULL_PREFERENCES_STORAGE_KEY)
        return;

      if (event.storageArea !== null) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }

      const next =
        event.key === null || event.newValue === null
          ? emptySnapshot()
          : parseSnapshot(event.newValue);
      if (next === null || equalSnapshots(snapshotRef.current, next)) return;

      snapshotRef.current = next;
      setSnapshot(next);
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const commit = useCallback(
    (update: (current: PreferenceSnapshot) => PreferenceSnapshot): void => {
      const current = snapshotRef.current;
      const next = update(current);
      if (equalSnapshots(current, next)) return;

      snapshotRef.current = next;
      setSnapshot(next);
      try {
        window.localStorage.setItem(
          PULL_PREFERENCES_STORAGE_KEY,
          JSON.stringify(storedSnapshot(next)),
        );
      } catch {
        // Preferences remain active for this page when storage is unavailable.
      }
    },
    [],
  );

  const hide = useCallback(
    (key: PullKey): void => {
      const identity = canonicalKey(key);
      if (identity === null) return;

      commit((current) => ({
        favorites: current.favorites,
        hidden: new Set(current.hidden).add(identity),
      }));
    },
    [commit],
  );

  const setFavorite = useCallback(
    (key: PullKey, favorite: boolean): void => {
      const identity = canonicalKey(key);
      if (identity === null) return;

      commit((current) => {
        const favorites = new Set(current.favorites);
        if (favorite) favorites.add(identity);
        else favorites.delete(identity);
        return { favorites, hidden: current.hidden };
      });
    },
    [commit],
  );

  const show = useCallback(
    (key: PullKey): void => {
      const identity = canonicalKey(key);
      if (identity === null) return;

      commit((current) => {
        const hidden = new Set(current.hidden);
        hidden.delete(identity);
        return { favorites: current.favorites, hidden };
      });
    },
    [commit],
  );

  const showAll = useCallback((): void => {
    commit((current) => ({
      favorites: current.favorites,
      hidden: new Set<PullKey>(),
    }));
  }, [commit]);

  return useMemo(
    () => ({
      favorites: snapshot.favorites,
      hidden: snapshot.hidden,
      hide,
      setFavorite,
      show,
      showAll,
    }),
    [hide, setFavorite, show, showAll, snapshot],
  );
}

const compareTasks = (left: TaskState, right: TaskState): number =>
  Date.parse(right.task.createdAt) - Date.parse(left.task.createdAt) ||
  left.task.id.localeCompare(right.task.id);

const taskIdentity = (state: TaskState): PullKey | null => {
  const pull = state.task.pullRequest;
  return pull ? canonicalKey(`${state.task.repository}#${pull.number}`) : null;
};

const stableFavoritesFirst = (
  items: readonly PullSectionItem[],
): PullSectionItem[] => [
  ...items.filter((item) => item.favorite),
  ...items.filter((item) => !item.favorite),
];

export const selectPullView = ({
  favorites,
  hidden,
  pulls,
  runs,
  tasks,
}: PullViewInput): PullView => {
  const grouped = groupPulls(pulls, runs);
  const authored = new Set(pulls.map(getPullKey));
  const orderedTasks = [...tasks].sort(compareTasks);
  const visibleTasks = orderedTasks.filter((state) => {
    const identity = taskIdentity(state);
    return (
      identity === null || !authored.has(identity) || isTaskActive(state.task)
    );
  });
  const selectedTasks: TaskState[] = [];
  const taskIndexes = new Map<PullKey, number>();

  for (const state of visibleTasks) {
    const identity = taskIdentity(state);
    if (identity === null) {
      selectedTasks.push(state);
      continue;
    }

    const index = taskIndexes.get(identity);
    if (index === undefined) {
      taskIndexes.set(identity, selectedTasks.length);
      selectedTasks.push(state);
      continue;
    }

    const selected = selectedTasks[index];
    if (selected && !isTaskActive(selected.task) && isTaskActive(state.task)) {
      selectedTasks[index] = state;
    }
  }

  const taskRows = new Set(
    selectedTasks.flatMap((state) => {
      const identity = taskIdentity(state);
      return identity !== null && isTaskActive(state.task) ? [identity] : [];
    }),
  );
  const pullVisible = (pull: PullReadiness): boolean =>
    !taskRows.has(getPullKey(pull));
  const pullItem = (pull: PullReadiness): PullSectionItem => {
    const identity = getPullKey(pull);
    return {
      favorite: favorites.has(identity),
      identity,
      key: `pull:${pull.url}`,
      kind: "pull",
      pull,
    };
  };
  const taskItem = (state: TaskState): PullSectionItem => {
    const identity = taskIdentity(state);
    return {
      favorite: identity !== null && favorites.has(identity),
      identity,
      key: `task:${state.task.id}`,
      kind: "task",
      state,
    };
  };
  const base: ReadinessGroups = {
    blocked: grouped.blocked.filter(pullVisible).map(pullItem),
    progress: [
      ...selectedTasks.map(taskItem),
      ...grouped.progress.filter(pullVisible).map(pullItem),
    ],
    ready: grouped.ready.filter(pullVisible).map(pullItem),
  };
  const all = [...base.ready, ...base.progress, ...base.blocked];
  const hiddenItems = all.filter(
    (item) => item.identity !== null && hidden.has(item.identity),
  );
  const visible = (items: readonly PullSectionItem[]): PullSectionItem[] =>
    stableFavoritesFirst(
      items.filter(
        (item) => item.identity === null || !hidden.has(item.identity),
      ),
    );
  const groups: ReadinessGroups = {
    blocked: visible(base.blocked),
    progress: visible(base.progress),
    ready: visible(base.ready),
  };

  return {
    groups,
    hidden: hiddenItems,
    hiddenCount: hiddenItems.length,
    knownCount: all.length,
    visibleCount:
      groups.ready.length + groups.progress.length + groups.blocked.length,
  };
};
