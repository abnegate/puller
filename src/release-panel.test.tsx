// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RELEASE_PANEL_STORAGE_KEY,
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
      <output aria-label="Release panel state">
        {panel.expanded ? "expanded" : "collapsed"}
      </output>
      <button onClick={() => panel.setExpanded(!panel.expanded)} type="button">
        Toggle
      </button>
    </>
  );
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

describe("useReleasePanelPreference", () => {
  it("defaults to expanded and safely ignores malformed or outdated storage", () => {
    for (const value of [
      "{",
      JSON.stringify({ expanded: false, version: 2 }),
      JSON.stringify({ expanded: "false", version: 1 }),
    ]) {
      window.localStorage.setItem(RELEASE_PANEL_STORAGE_KEY, value);
      const view = render(<Harness />);

      expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
        "expanded",
      );

      view.unmount();
    }
  });

  it("persists a versioned preference and restores it after remount", () => {
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "collapsed",
    );
    expect(
      JSON.parse(window.localStorage.getItem(RELEASE_PANEL_STORAGE_KEY)!),
    ).toEqual({ expanded: false, version: 1 });

    view.unmount();
    render(<Harness />);
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "collapsed",
    );
  });

  it("synchronizes valid cross-tab updates and resets after storage is cleared", () => {
    render(<Harness />);

    fireEvent(
      window,
      new StorageEvent("storage", {
        key: RELEASE_PANEL_STORAGE_KEY,
        newValue: JSON.stringify({ expanded: false, version: 1 }),
      }),
    );
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "collapsed",
    );

    fireEvent(
      window,
      new StorageEvent("storage", {
        key: null,
        newValue: null,
      }),
    );
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "expanded",
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
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "expanded",
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByLabelText("Release panel state")).toHaveTextContent(
      "collapsed",
    );
  });
});
