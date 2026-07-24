// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_STORAGE_KEY,
  setAgentPreference,
  useAgentPreference,
} from "./agent";
import AgentToggle from "./components/AgentToggle";
import { TooltipProvider } from "./components/ui/tooltip";

vi.stubGlobal(
  "ResizeObserver",
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

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
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("agent preference", () => {
  it("defaults malformed and unversioned storage to Claude", () => {
    window.localStorage.setItem(AGENT_STORAGE_KEY, "{broken");
    const malformed = renderHook(() => useAgentPreference());
    expect(malformed.result.current.agent).toBe("claude");
    malformed.unmount();

    window.localStorage.setItem(
      AGENT_STORAGE_KEY,
      JSON.stringify({ agent: "codex" }),
    );
    const unversioned = renderHook(() => useAgentPreference());
    expect(unversioned.result.current.agent).toBe("claude");
  });

  it("updates same-tab subscribers and synchronizes a storage event", () => {
    const preference = renderHook(() => useAgentPreference());

    act(() => setAgentPreference("codex"));
    expect(preference.result.current.agent).toBe("codex");

    window.localStorage.setItem(
      AGENT_STORAGE_KEY,
      JSON.stringify({ agent: "claude", version: 1 }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: AGENT_STORAGE_KEY }),
      );
    });
    expect(preference.result.current.agent).toBe("claude");
  });

  it("updates the in-memory preference when storage reads and writes throw", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage reads are unavailable.");
    });
    const preference = renderHook(() => useAgentPreference());
    expect(preference.result.current.agent).toBe("claude");

    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage writes are unavailable.");
    });
    act(() => preference.result.current.setAgent("codex"));

    expect(preference.result.current.agent).toBe("codex");
  });

  it("updates the in-memory preference when removing the default throws", () => {
    const preference = renderHook(() => useAgentPreference());
    act(() => preference.result.current.setAgent("codex"));
    expect(preference.result.current.agent).toBe("codex");

    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("Storage removals are unavailable.");
    });
    act(() => preference.result.current.setAgent("claude"));

    expect(preference.result.current.agent).toBe("claude");
  });

  it("treats a cross-tab storage clear as the default Claude preference", () => {
    const preference = renderHook(() => useAgentPreference());
    act(() => preference.result.current.setAgent("codex"));
    expect(preference.result.current.agent).toBe("codex");

    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });

    expect(preference.result.current.agent).toBe("claude");
  });
});

describe("AgentToggle", () => {
  it("offers an accessible Claude and Codex selector for future runs", () => {
    const preference = renderHook(() => useAgentPreference());
    const view = render(
      <TooltipProvider>
        <AgentToggle
          agent={preference.result.current.agent}
          onAgentChange={preference.result.current.setAgent}
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: "Agent: Claude. Choose local coding agent.",
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));

    view.rerender(
      <TooltipProvider>
        <AgentToggle
          agent={preference.result.current.agent}
          onAgentChange={preference.result.current.setAgent}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: "Agent: Codex. Choose local coding agent.",
      }),
    ).toBeInTheDocument();
  });

  it("suppresses its tooltip while the agent menu is open", async () => {
    render(
      <TooltipProvider>
        <AgentToggle agent="claude" onAgentChange={vi.fn()} />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: "Agent: Claude. Choose local coding agent.",
    });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Applies to future runs only",
    );

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(
      screen.getByRole("menuitemradio", { name: "Claude" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Applies to future runs only/),
      ).not.toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitemradio", { name: "Claude" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.pointerLeave(trigger);
    trigger.blur();
    trigger.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Applies to future runs only",
    );
  });
});
