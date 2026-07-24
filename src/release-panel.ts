import { useCallback, useEffect, useRef, useState } from "react";

export const RELEASE_PANEL_STORAGE_KEY = "puller.release-panel.v1";

const VERSION = 1;
const DEFAULT_EXPANDED = true;

type StoredReleasePanel = {
  expanded: boolean;
  version: typeof VERSION;
};

const parseReleasePanel = (value: string | null): boolean => {
  if (value === null) return DEFAULT_EXPANDED;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === VERSION &&
      "expanded" in parsed &&
      typeof parsed.expanded === "boolean"
    ) {
      return parsed.expanded;
    }
  } catch {
    // Malformed storage safely falls back to the expanded panel.
  }

  return DEFAULT_EXPANDED;
};

const readReleasePanel = (): boolean => {
  if (typeof window === "undefined") return DEFAULT_EXPANDED;

  try {
    return parseReleasePanel(
      window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_EXPANDED;
  }
};

export function useReleasePanelPreference(): {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
} {
  const [expanded, setExpandedState] = useState(readReleasePanel);
  const expandedRef = useRef(expanded);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== RELEASE_PANEL_STORAGE_KEY) return;

      if (event.storageArea !== null) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }

      const next =
        event.key === null
          ? DEFAULT_EXPANDED
          : parseReleasePanel(event.newValue);
      if (expandedRef.current === next) return;

      expandedRef.current = next;
      setExpandedState(next);
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setExpanded = useCallback((next: boolean): void => {
    if (expandedRef.current === next) return;

    expandedRef.current = next;
    setExpandedState(next);
    const value: StoredReleasePanel = { expanded: next, version: VERSION };
    try {
      window.localStorage.setItem(
        RELEASE_PANEL_STORAGE_KEY,
        JSON.stringify(value),
      );
    } catch {
      // The in-memory preference remains active when storage is unavailable.
    }
  }, []);

  return { expanded, setExpanded };
}
