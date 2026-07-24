import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";

import type { PullKey } from "./preferences";

export type PullRowVariant = "ready" | "progress" | "blocked";

export type PullRowFocus = {
  generation: number;
  pending: boolean;
  token: string;
  variant: PullRowVariant;
};

export type PersistedDiffView = Record<string, unknown>;
export type PersistedCommitsView = Record<string, unknown>;

export type PullRowContinuityEntry = {
  blockersExpanded: boolean;
  commits?: PersistedCommitsView;
  commitsExpanded: boolean;
  diff?: PersistedDiffView;
  diffExpanded: boolean;
  diffKey: string | null;
  focus: PullRowFocus | null;
  variant: PullRowVariant | null;
};

export type PullRowContinuityUpdate =
  | Partial<PullRowContinuityEntry>
  | ((entry: PullRowContinuityEntry) => PullRowContinuityEntry);

const emptyEntry = (): PullRowContinuityEntry => ({
  blockersExpanded: false,
  commitsExpanded: false,
  diffExpanded: false,
  diffKey: null,
  focus: null,
  variant: null,
});

const sameEntry = (
  left: PullRowContinuityEntry,
  right: PullRowContinuityEntry,
): boolean =>
  left.blockersExpanded === right.blockersExpanded &&
  left.commits === right.commits &&
  left.commitsExpanded === right.commitsExpanded &&
  left.diff === right.diff &&
  left.diffExpanded === right.diffExpanded &&
  left.diffKey === right.diffKey &&
  left.focus === right.focus &&
  left.variant === right.variant;

class PullRowContinuityStore {
  private readonly empty = emptyEntry();

  private entries = new Map<PullKey, PullRowContinuityEntry>();

  private listeners = new Map<PullKey, Set<() => void>>();

  get = (key: PullKey): PullRowContinuityEntry =>
    this.entries.get(key) ?? this.empty;

  subscribe = (key: PullKey, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  };

  update = (key: PullKey, update: PullRowContinuityUpdate): void => {
    const current = this.get(key);
    const next =
      typeof update === "function"
        ? update(current)
        : { ...current, ...update };

    if (next === current || sameEntry(current, next)) return;
    this.entries.set(key, next);
    this.notify(key);
  };

  ensureDiffKey = (
    key: PullKey,
    diffKey: string | null,
    variant: PullRowVariant,
  ): PullRowContinuityEntry => {
    const current = this.get(key);
    const keyChanged = current.diffKey !== diffKey;
    const moved = current.variant !== null && current.variant !== variant;
    const focus = keyChanged
      ? null
      : moved && current.focus?.variant === current.variant
        ? {
            ...current.focus,
            generation: current.focus.generation + 1,
            pending: true,
            variant,
          }
        : current.focus;
    const next: PullRowContinuityEntry = {
      ...current,
      ...(keyChanged
        ? {
            commits: undefined,
            commitsExpanded: false,
            diff: undefined,
          }
        : {}),
      diffKey,
      focus,
      variant,
    };

    if (
      current.diffKey === next.diffKey &&
      current.focus === next.focus &&
      current.variant === next.variant
    ) {
      return current;
    }

    this.entries.set(key, next);
    this.notify(key);
    return next;
  };

  claimFocus = (key: PullKey, focus: PullRowFocus): boolean => {
    const current = this.get(key);
    const pending = current.focus;
    if (
      pending === null ||
      !pending.pending ||
      pending.generation !== focus.generation ||
      pending.token !== focus.token ||
      pending.variant !== focus.variant
    ) {
      return false;
    }

    this.entries.set(key, { ...current, focus: null });
    this.notify(key);
    return true;
  };

  remove = (key: PullKey): void => {
    if (!this.entries.delete(key)) return;
    this.notify(key);
  };

  prune = (keys: ReadonlySet<PullKey>): void => {
    const removed: PullKey[] = [];
    for (const key of this.entries.keys()) {
      if (keys.has(key)) continue;
      this.entries.delete(key);
      removed.push(key);
    }
    for (const key of removed) this.notify(key);
  };

  private notify(key: PullKey): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}

const PullRowContinuityContext = createContext<PullRowContinuityStore | null>(
  null,
);

export const PullRowContinuityProvider = ({
  children,
}: {
  children: ReactNode;
}): ReactNode => {
  const store = useRef<PullRowContinuityStore | null>(null);
  store.current ??= new PullRowContinuityStore();

  return (
    <PullRowContinuityContext.Provider value={store.current}>
      {children}
    </PullRowContinuityContext.Provider>
  );
};

export type PullRowContinuity = {
  claimFocus: (focus: PullRowFocus) => boolean;
  ensureDiffKey: (
    diffKey: string | null,
    variant: PullRowVariant,
  ) => PullRowContinuityEntry;
  entry: PullRowContinuityEntry;
  prune: (keys: ReadonlySet<PullKey>) => void;
  remove: (key: PullKey) => void;
  update: (update: PullRowContinuityUpdate) => void;
};

export const usePullRowContinuity = (key: PullKey): PullRowContinuity => {
  const store = useContext(PullRowContinuityContext);
  if (store === null) {
    throw new Error(
      "usePullRowContinuity must be used inside PullRowContinuityProvider.",
    );
  }

  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [key, store],
  );
  const entry = useSyncExternalStore(subscribe, () => store.get(key));
  const update = useCallback(
    (next: PullRowContinuityUpdate) => store.update(key, next),
    [key, store],
  );
  const ensureDiffKey = useCallback(
    (diffKey: string | null, variant: PullRowVariant) =>
      store.ensureDiffKey(key, diffKey, variant),
    [key, store],
  );
  const claimFocus = useCallback(
    (focus: PullRowFocus) => store.claimFocus(key, focus),
    [key, store],
  );
  const prune = useCallback(
    (keys: ReadonlySet<PullKey>) => store.prune(keys),
    [store],
  );
  const remove = useCallback(
    (target: PullKey) => store.remove(target),
    [store],
  );

  return { claimFocus, ensureDiffKey, entry, prune, remove, update };
};
