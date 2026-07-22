import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const REPOSITORY_PREFERENCES_STORAGE_KEY =
  "puller-repository-preferences";

const PREFERENCES_VERSION = 1;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type RepositoryPreferencesSnapshot = {
  favorites: ReadonlySet<string>;
};

type StoredRepositoryPreferences = {
  favorites: string[];
  version: typeof PREFERENCES_VERSION;
};

export type RepositoryPreferences = RepositoryPreferencesSnapshot & {
  setFavorite: (repository: string, favorite: boolean) => void;
};

const subscribers = new Set<
  (snapshot: RepositoryPreferencesSnapshot) => void
>();

const emptySnapshot = (): RepositoryPreferencesSnapshot => ({
  favorites: new Set<string>(),
});

export const canonicalRepository = (value: unknown): string | null => {
  if (typeof value !== "string") return null;

  const repository = value.trim().toLowerCase();
  if (
    !REPOSITORY.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }

  return repository;
};

const sanitize = (values: unknown[]): ReadonlySet<string> =>
  new Set(
    values
      .map(canonicalRepository)
      .filter((value): value is string => value !== null)
      .sort(),
  );

export const parseRepositoryPreferences = (
  value: string,
): RepositoryPreferencesSnapshot | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== PREFERENCES_VERSION ||
      !("favorites" in parsed) ||
      !Array.isArray(parsed.favorites) ||
      Object.keys(parsed).some(
        (key) => key !== "favorites" && key !== "version",
      )
    ) {
      return null;
    }

    return { favorites: sanitize(parsed.favorites) };
  } catch {
    return null;
  }
};

const readSnapshot = (): RepositoryPreferencesSnapshot => {
  if (typeof window === "undefined") return emptySnapshot();

  try {
    const value = window.localStorage.getItem(
      REPOSITORY_PREFERENCES_STORAGE_KEY,
    );
    return value === null
      ? emptySnapshot()
      : (parseRepositoryPreferences(value) ?? emptySnapshot());
  } catch {
    return emptySnapshot();
  }
};

const equalSnapshots = (
  left: RepositoryPreferencesSnapshot,
  right: RepositoryPreferencesSnapshot,
): boolean =>
  left.favorites.size === right.favorites.size &&
  [...left.favorites].every((repository) => right.favorites.has(repository));

const storedSnapshot = (
  snapshot: RepositoryPreferencesSnapshot,
): StoredRepositoryPreferences => ({
  favorites: [...snapshot.favorites].sort(),
  version: PREFERENCES_VERSION,
});

const publish = (snapshot: RepositoryPreferencesSnapshot): void => {
  for (const subscriber of subscribers) subscriber(snapshot);
};

export function useRepositoryPreferences(): RepositoryPreferences {
  const [snapshot, setSnapshot] =
    useState<RepositoryPreferencesSnapshot>(readSnapshot);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    const receive = (next: RepositoryPreferencesSnapshot): void => {
      if (equalSnapshots(snapshotRef.current, next)) return;
      snapshotRef.current = next;
      setSnapshot(next);
    };
    const handleStorage = (event: StorageEvent): void => {
      if (
        event.key !== null &&
        event.key !== REPOSITORY_PREFERENCES_STORAGE_KEY
      )
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
          : parseRepositoryPreferences(event.newValue);
      if (next !== null) publish(next);
    };

    subscribers.add(receive);
    window.addEventListener("storage", handleStorage);
    return () => {
      subscribers.delete(receive);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setFavorite = useCallback(
    (repository: string, favorite: boolean): void => {
      const canonical = canonicalRepository(repository);
      if (canonical === null) return;

      const favorites = new Set(snapshotRef.current.favorites);
      if (favorite) favorites.add(canonical);
      else favorites.delete(canonical);
      const next = { favorites };
      if (equalSnapshots(snapshotRef.current, next)) return;

      snapshotRef.current = next;
      setSnapshot(next);
      try {
        window.localStorage.setItem(
          REPOSITORY_PREFERENCES_STORAGE_KEY,
          JSON.stringify(storedSnapshot(next)),
        );
      } catch {
        // Favorites remain active for this page when storage is unavailable.
      }
      publish(next);
    },
    [],
  );

  return useMemo(
    () => ({ favorites: snapshot.favorites, setFavorite }),
    [setFavorite, snapshot.favorites],
  );
}
