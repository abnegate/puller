// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RELEASE_PANEL_MODE,
  LEGACY_RELEASE_PANEL_STORAGE_KEY,
  parseReleasePanelPreference,
  RELEASE_PANEL_MODES,
  RELEASE_PANEL_STORAGE_KEY,
  releasePanelState,
  serializeReleasePanelPreference,
  useReleasePanelPreference,
} from "./release-panel";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

function Harness() {
  const panel = useReleasePanelPreference();

  return (
    <>
      <output aria-label="Dashboard mode">{panel.mode}</output>
      <output aria-label="Pull requests visible">
        {String(panel.pulls.visible)}
      </output>
      <output aria-label="Releases visible">
        {String(panel.releases.visible)}
      </output>
      <output aria-label="Pipeline polling enabled">
        {String(panel.pipelinePollingEnabled)}
      </output>
      <button onClick={panel.showSplit} type="button">
        Split
      </button>
      <button onClick={panel.focusPulls} type="button">
        Focus pulls
      </button>
      <button onClick={panel.focusReleases} type="button">
        Focus releases
      </button>
      <button onClick={panel.togglePulls} type="button">
        Toggle pulls
      </button>
      <button onClick={panel.toggleReleases} type="button">
        Toggle releases
      </button>
    </>
  );
}

function SubscriptionRaceHarness() {
  const panel = useReleasePanelPreference();

  useLayoutEffect(() => {
    window.localStorage.setItem(
      RELEASE_PANEL_STORAGE_KEY,
      serializeReleasePanelPreference("releases"),
    );
  }, []);

  return <output aria-label="Dashboard mode">{panel.mode}</output>;
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
});

describe("release panel serialization", () => {
  it("round-trips every supported dashboard mode", () => {
    for (const mode of RELEASE_PANEL_MODES) {
      expect(
        parseReleasePanelPreference(serializeReleasePanelPreference(mode)),
      ).toBe(mode);
    }
  });

  it("defaults malformed, incomplete, and unknown preferences to split", () => {
    for (const value of [
      null,
      "{",
      JSON.stringify({ mode: "neither", version: 2 }),
      JSON.stringify({ mode: "pulls", version: 3 }),
      JSON.stringify({ expanded: "false", version: 1 }),
    ]) {
      expect(parseReleasePanelPreference(value)).toBe(
        DEFAULT_RELEASE_PANEL_MODE,
      );
    }
  });

  it("maps the previous expanded preference and raw booleans without hiding both panes", () => {
    expect(
      parseReleasePanelPreference(
        JSON.stringify({ expanded: true, version: 1 }),
      ),
    ).toBe("split");
    expect(
      parseReleasePanelPreference(
        JSON.stringify({ expanded: false, version: 1 }),
      ),
    ).toBe("pulls");
    expect(parseReleasePanelPreference("true")).toBe("split");
    expect(parseReleasePanelPreference("false")).toBe("pulls");
  });
});

describe("releasePanelState", () => {
  it.each([
    ["split", true, true, true],
    ["pulls", true, false, false],
    ["releases", false, true, true],
  ] as const)(
    "derives mounted pane and pipeline visibility for %s mode",
    (mode, pullsVisible, releasesVisible, pollingEnabled) => {
      const state = releasePanelState(mode);

      expect(state.pulls).toEqual({
        ariaHidden: !pullsVisible,
        dataState: pullsVisible ? "visible" : "hidden",
        inert: !pullsVisible,
        visible: pullsVisible,
      });
      expect(state.releases).toEqual({
        ariaHidden: !releasesVisible,
        dataState: releasesVisible ? "visible" : "hidden",
        inert: !releasesVisible,
        visible: releasesVisible,
      });
      expect(state.pipelinePollingEnabled).toBe(pollingEnabled);
      expect(state.pulls.visible || state.releases.visible).toBe(true);
    },
  );
});

describe("useReleasePanelPreference", () => {
  it("defaults to split and moves between every focus state without hiding both panes", () => {
    render(<Harness />);

    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");
    expect(screen.getByLabelText("Pull requests visible")).toHaveTextContent(
      "true",
    );
    expect(screen.getByLabelText("Releases visible")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "Focus releases" }));
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent(
      "releases",
    );
    expect(screen.getByLabelText("Pull requests visible")).toHaveTextContent(
      "false",
    );
    expect(screen.getByLabelText("Releases visible")).toHaveTextContent("true");
    expect(screen.getByLabelText("Pipeline polling enabled")).toHaveTextContent(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle pulls" }));
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");

    fireEvent.click(screen.getByRole("button", { name: "Focus pulls" }));
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("pulls");
    expect(screen.getByLabelText("Pull requests visible")).toHaveTextContent(
      "true",
    );
    expect(screen.getByLabelText("Releases visible")).toHaveTextContent(
      "false",
    );
    expect(screen.getByLabelText("Pipeline polling enabled")).toHaveTextContent(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle releases" }));
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");
  });

  it("persists a versioned mode and restores it after remount", () => {
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Focus releases" }));
    expect(
      JSON.parse(window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY)!),
    ).toEqual({ mode: "releases", version: 2 });

    view.unmount();
    render(<Harness />);
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent(
      "releases",
    );
  });

  it("migrates the previous storage key and collapsed boolean to pulls mode", async () => {
    window.localStorage.setItem(
      LEGACY_RELEASE_PANEL_STORAGE_KEY,
      JSON.stringify({ expanded: false, version: 1 }),
    );

    render(<Harness />);

    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("pulls");
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY)!),
      ).toEqual({ mode: "pulls", version: 2 }),
    );
    expect(
      window.localStorage.getItem(LEGACY_RELEASE_PANEL_STORAGE_KEY),
    ).toBeNull();
  });

  it("normalizes a legacy value already stored under the current key", async () => {
    window.localStorage.setItem(
      RELEASE_PANEL_STORAGE_KEY,
      JSON.stringify({ expanded: true, version: 1 }),
    );

    render(<Harness />);

    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY)!),
      ).toEqual({ mode: "split", version: 2 }),
    );
  });

  it("synchronizes current and legacy cross-tab updates and resets after storage is cleared", () => {
    render(<Harness />);

    fireEvent(
      window,
      new StorageEvent("storage", {
        key: RELEASE_PANEL_STORAGE_KEY,
        newValue: serializeReleasePanelPreference("releases"),
      }),
    );
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent(
      "releases",
    );

    fireEvent(
      window,
      new StorageEvent("storage", {
        key: LEGACY_RELEASE_PANEL_STORAGE_KEY,
        newValue: JSON.stringify({ expanded: false, version: 1 }),
      }),
    );
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("pulls");

    fireEvent(
      window,
      new StorageEvent("storage", {
        key: null,
        newValue: null,
      }),
    );
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");
  });

  it("rereads storage after subscribing so an update between render and the passive effect is not missed", async () => {
    render(<SubscriptionRaceHarness />);

    await waitFor(() =>
      expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent(
        "releases",
      ),
    );
  });

  it("keeps an in-memory selection when local storage is unavailable", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });

    render(<Harness />);
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent("split");

    fireEvent.click(screen.getByRole("button", { name: "Focus releases" }));
    expect(screen.getByLabelText("Dashboard mode")).toHaveTextContent(
      "releases",
    );
  });
});
