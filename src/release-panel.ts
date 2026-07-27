import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const RELEASE_PANEL_STORAGE_KEY = "puller.release-panel.v2";
export const LEGACY_RELEASE_PANEL_STORAGE_KEY = "puller.release-panel.v1";

const VERSION = 2;

export const RELEASE_PANEL_MODES = ["split", "pulls", "releases"] as const;
export type ReleasePanelMode = (typeof RELEASE_PANEL_MODES)[number];

export const DEFAULT_RELEASE_PANEL_MODE: ReleasePanelMode = "split";

type StoredReleasePanel = {
  mode: ReleasePanelMode;
  version: typeof VERSION;
};

type DecodedReleasePanel = {
  legacy: boolean;
  mode: ReleasePanelMode;
  valid: boolean;
};

export type DashboardPaneState = {
  ariaHidden: boolean;
  dataState: "hidden" | "visible";
  inert: boolean;
  visible: boolean;
};

export type ReleasePanelState = {
  mode: ReleasePanelMode;
  pipelinePollingEnabled: boolean;
  pulls: DashboardPaneState;
  releases: DashboardPaneState;
};

export type ReleasePanelPreference = ReleasePanelState & {
  focusPulls: () => void;
  focusReleases: () => void;
  setMode: (mode: ReleasePanelMode) => void;
  showSplit: () => void;
  togglePulls: () => void;
  toggleReleases: () => void;
};

export const isReleasePanelMode = (value: unknown): value is ReleasePanelMode =>
  typeof value === "string" &&
  RELEASE_PANEL_MODES.some((mode) => mode === value);

const decodeReleasePanelPreference = (
  value: string | null,
): DecodedReleasePanel => {
  if (value === null) {
    return {
      legacy: false,
      mode: DEFAULT_RELEASE_PANEL_MODE,
      valid: false,
    };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === VERSION &&
      "mode" in parsed &&
      isReleasePanelMode(parsed.mode)
    ) {
      return { legacy: false, mode: parsed.mode, valid: true };
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1 &&
      "expanded" in parsed &&
      typeof parsed.expanded === "boolean"
    ) {
      return {
        legacy: true,
        mode: parsed.expanded ? "split" : "pulls",
        valid: true,
      };
    }

    if (typeof parsed === "boolean") {
      return {
        legacy: true,
        mode: parsed ? "split" : "pulls",
        valid: true,
      };
    }
  } catch {
    // Malformed storage safely falls back to the split dashboard.
  }

  return {
    legacy: false,
    mode: DEFAULT_RELEASE_PANEL_MODE,
    valid: false,
  };
};

export const parseReleasePanelPreference = (
  value: string | null,
): ReleasePanelMode => decodeReleasePanelPreference(value).mode;

export const serializeReleasePanelPreference = (
  mode: ReleasePanelMode,
): string => {
  const value: StoredReleasePanel = { mode, version: VERSION };
  return JSON.stringify(value);
};

const paneState = (visible: boolean): DashboardPaneState => ({
  ariaHidden: !visible,
  dataState: visible ? "visible" : "hidden",
  inert: !visible,
  visible,
});

export const releasePanelState = (
  mode: ReleasePanelMode,
): ReleasePanelState => {
  const pullsVisible = mode !== "releases";
  const releasesVisible = mode !== "pulls";

  return {
    mode,
    pipelinePollingEnabled: releasesVisible,
    pulls: paneState(pullsVisible),
    releases: paneState(releasesVisible),
  };
};

const readReleasePanel = (): ReleasePanelMode => {
  if (typeof window === "undefined") return DEFAULT_RELEASE_PANEL_MODE;

  try {
    const current = window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY);
    if (current !== null) return parseReleasePanelPreference(current);

    return parseReleasePanelPreference(
      window.localStorage.getItem(LEGACY_RELEASE_PANEL_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_RELEASE_PANEL_MODE;
  }
};

const migrateReleasePanel = (): void => {
  try {
    const current = window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY);
    if (current !== null) {
      const decoded = decodeReleasePanelPreference(current);
      if (decoded.valid) {
        if (decoded.legacy) {
          window.localStorage.setItem(
            RELEASE_PANEL_STORAGE_KEY,
            serializeReleasePanelPreference(decoded.mode),
          );
        }
        window.localStorage.removeItem(LEGACY_RELEASE_PANEL_STORAGE_KEY);
      }
      return;
    }

    const legacy = window.localStorage.getItem(
      LEGACY_RELEASE_PANEL_STORAGE_KEY,
    );
    const decoded = decodeReleasePanelPreference(legacy);
    if (!decoded.valid) return;

    window.localStorage.setItem(
      RELEASE_PANEL_STORAGE_KEY,
      serializeReleasePanelPreference(decoded.mode),
    );
    window.localStorage.removeItem(LEGACY_RELEASE_PANEL_STORAGE_KEY);
  } catch {
    // The in-memory preference remains active when storage is unavailable.
  }
};

export function useReleasePanelPreference(): ReleasePanelPreference {
  const [mode, setModeState] = useState(readReleasePanel);
  const modeRef = useRef(mode);

  useEffect(() => {
    migrateReleasePanel();
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (
        event.key !== null &&
        event.key !== RELEASE_PANEL_STORAGE_KEY &&
        event.key !== LEGACY_RELEASE_PANEL_STORAGE_KEY
      ) {
        return;
      }

      if (event.storageArea !== null) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }

      let next: ReleasePanelMode;
      if (event.key === null) {
        next = DEFAULT_RELEASE_PANEL_MODE;
      } else if (event.key === RELEASE_PANEL_STORAGE_KEY) {
        next = parseReleasePanelPreference(event.newValue);
      } else {
        try {
          const current = window.localStorage.getItem(
            RELEASE_PANEL_STORAGE_KEY,
          );
          next =
            current === null
              ? parseReleasePanelPreference(event.newValue)
              : parseReleasePanelPreference(current);
        } catch {
          next = parseReleasePanelPreference(event.newValue);
        }
      }

      if (modeRef.current === next) return;

      modeRef.current = next;
      setModeState(next);
    };

    window.addEventListener("storage", handleStorage);
    const next = readReleasePanel();
    if (modeRef.current !== next) {
      modeRef.current = next;
      setModeState(next);
    }
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setMode = useCallback((next: ReleasePanelMode): void => {
    if (modeRef.current === next) return;

    modeRef.current = next;
    setModeState(next);
    try {
      window.localStorage.setItem(
        RELEASE_PANEL_STORAGE_KEY,
        serializeReleasePanelPreference(next),
      );
      window.localStorage.removeItem(LEGACY_RELEASE_PANEL_STORAGE_KEY);
    } catch {
      // The in-memory preference remains active when storage is unavailable.
    }
  }, []);

  const showSplit = useCallback(() => setMode("split"), [setMode]);
  const focusPulls = useCallback(() => setMode("pulls"), [setMode]);
  const focusReleases = useCallback(() => setMode("releases"), [setMode]);
  const togglePulls = useCallback(
    () => setMode(modeRef.current === "releases" ? "split" : "releases"),
    [setMode],
  );
  const toggleReleases = useCallback(
    () => setMode(modeRef.current === "pulls" ? "split" : "pulls"),
    [setMode],
  );
  const state = useMemo(() => releasePanelState(mode), [mode]);

  return {
    ...state,
    focusPulls,
    focusReleases,
    setMode,
    showSplit,
    togglePulls,
    toggleReleases,
  };
}
