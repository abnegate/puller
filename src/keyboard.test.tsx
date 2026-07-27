// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import KeyboardShortcuts from "./components/KeyboardShortcuts";
import {
  dashboardKeyboardCommand,
  keyboardEventBlocked,
  RELEASE_FOCUS_REQUEST,
  useDashboardKeyboard,
  type KeyboardItem,
  type KeyboardPages,
  type KeyboardSection,
} from "./keyboard";

const pull = (
  key: string,
  index: number,
  section: KeyboardSection,
): KeyboardItem => ({
  identity: key,
  index,
  key: `pull:${key}`,
  kind: "pull",
  section,
});

const task = (id: string, index: number): KeyboardItem => ({
  id,
  index,
  key: `task:${id}`,
  kind: "task",
  section: "progress",
});

type HarnessProps = {
  initialMode?: "pulls" | "releases" | "split";
  items: readonly KeyboardItem[];
  onAction?: () => void;
};

function Harness({
  initialMode = "split",
  items,
  onAction = () => undefined,
}: HarnessProps) {
  const [mode, setMode] = useState(initialMode);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pages, setPages] = useState<KeyboardPages>({
    blocked: 1,
    progress: 1,
    ready: 1,
  });
  const restoreFocus = useRef<HTMLElement | null>(null);
  const setPage = useCallback(
    (section: KeyboardSection, page: number) =>
      setPages((current) => ({ ...current, [section]: page })),
    [],
  );
  const revealPulls = useCallback(
    () => setMode((current) => (current === "releases" ? "split" : current)),
    [],
  );
  const revealReleases = useCallback(
    () => setMode((current) => (current === "pulls" ? "split" : current)),
    [],
  );

  useDashboardKeyboard({
    items,
    newPullId: "new-task-prompt",
    onHelp: () => {
      if (document.activeElement instanceof HTMLElement) {
        restoreFocus.current = document.activeElement;
      }
      setHelpOpen(true);
    },
    onRevealPulls: revealPulls,
    onRevealReleases: revealReleases,
    pageSize: 20,
    pages,
    setPage,
  });

  return (
    <>
      <button type="button">Outside</button>
      <input aria-keyshortcuts="n" id="new-task-prompt" />
      <span data-mode="">{mode}</span>
      <div
        aria-hidden={mode === "releases"}
        data-pulls=""
        inert={mode === "releases" || undefined}
      >
        {items.map((item) => {
          if (pages[item.section] !== Math.floor(item.index / 20) + 1)
            return null;
          return item.kind === "pull" ? (
            <div
              aria-label={item.identity}
              data-pull-identity={item.identity}
              key={item.key}
              tabIndex={-1}
            >
              <pre
                aria-label={`Output ${item.identity}`}
                data-keyboard-scroll-region=""
                tabIndex={0}
              >
                Native output
              </pre>
              <button onClick={onAction} type="button">
                Dangerous action {item.identity}
              </button>
            </div>
          ) : (
            <div
              aria-label={item.id}
              data-task-id={item.id}
              key={item.key}
              tabIndex={-1}
            />
          );
        })}
      </div>
      <div
        aria-hidden={mode === "pulls"}
        data-releases=""
        inert={mode === "pulls" || undefined}
      />
      <KeyboardShortcuts
        onOpenChange={setHelpOpen}
        open={helpOpen}
        restoreFocus={restoreFocus}
      />
    </>
  );
}

const keyDown = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { key, ...init });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboardKeyboardCommand", () => {
  it("rejects editable targets, modifiers, composition, handled events, overlays, and non-navigation repeats", () => {
    const input = document.createElement("input");
    const normal = new KeyboardEvent("keydown", { key: "j" });

    expect(
      dashboardKeyboardCommand({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        key: "j",
        metaKey: false,
        repeat: false,
        shiftKey: false,
        target: input,
      }),
    ).toBeNull();
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "j" }),
      ),
    ).toBeNull();
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { isComposing: true, key: "j" }),
      ),
    ).toBeNull();
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { key: "p", repeat: true }),
      ),
    ).toBeNull();
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { key: "j", repeat: true }),
      ),
    ).toBe("next");

    const prevented = new KeyboardEvent("keydown", {
      cancelable: true,
      key: "j",
    });
    prevented.preventDefault();
    expect(dashboardKeyboardCommand(prevented)).toBeNull();

    const overlay = document.createElement("div");
    overlay.dataset.slot = "dialog-content";
    overlay.dataset.state = "open";
    document.body.append(overlay);
    expect(dashboardKeyboardCommand(normal)).toBeNull();
    overlay.remove();
  });

  it("accepts a shifted question mark but rejects shifted navigation", () => {
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { key: "?", shiftKey: true }),
      ),
    ).toBe("help");
    expect(
      dashboardKeyboardCommand(
        new KeyboardEvent("keydown", { key: "J", shiftKey: true }),
      ),
    ).toBeNull();
  });
});

describe("keyboardEventBlocked", () => {
  it("blocks handled, composing, modified, repeated, editable, and overlaid events", () => {
    const input = document.createElement("input");
    const editable = document.createElement("span");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.append(child);
    expect(
      keyboardEventBlocked({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        target: input,
      }),
    ).toBe(true);
    expect(
      keyboardEventBlocked({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        target: child,
      }),
    ).toBe(true);
    expect(
      keyboardEventBlocked(
        new KeyboardEvent("keydown", { altKey: true, key: "f" }),
      ),
    ).toBe(true);
    expect(
      keyboardEventBlocked(
        new KeyboardEvent("keydown", { isComposing: true, key: "f" }),
      ),
    ).toBe(true);
    expect(
      keyboardEventBlocked(
        new KeyboardEvent("keydown", { key: "f", repeat: true }),
      ),
    ).toBe(true);

    const overlay = document.createElement("div");
    overlay.dataset.slot = "dialog-content";
    overlay.dataset.state = "open";
    document.body.append(overlay);
    expect(
      keyboardEventBlocked(new KeyboardEvent("keydown", { key: "f" })),
    ).toBe(true);
    overlay.remove();
  });

  it("allows unmodified non-editable events and explicit repeats", () => {
    expect(
      keyboardEventBlocked(new KeyboardEvent("keydown", { key: "f" })),
    ).toBe(false);
    expect(
      keyboardEventBlocked(
        new KeyboardEvent("keydown", { key: "ArrowDown", repeat: true }),
        document,
        { allowRepeat: true },
      ),
    ).toBe(false);

    const overlay = document.createElement("div");
    overlay.dataset.slot = "popover-content";
    overlay.dataset.state = "open";
    document.body.append(overlay);
    expect(
      keyboardEventBlocked(new KeyboardEvent("keydown", { key: "Escape" })),
    ).toBe(true);
    overlay.remove();
  });

  it("reserves navigation keys for a focused native scroll region without blocking its owning row", () => {
    const row = document.createElement("div");
    const terminal = document.createElement("pre");
    const line = document.createElement("span");
    terminal.dataset.keyboardScrollRegion = "";
    terminal.append(line);
    row.append(terminal);
    document.body.append(row);

    expect(
      keyboardEventBlocked(
        new KeyboardEvent("keydown", { key: "Home" }),
        document,
      ),
    ).toBe(false);
    expect(
      keyboardEventBlocked({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        target: row,
      }),
    ).toBe(false);
    expect(
      keyboardEventBlocked({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        target: terminal,
      }),
    ).toBe(true);
    expect(
      keyboardEventBlocked({
        altKey: false,
        ctrlKey: false,
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        target: line,
      }),
    ).toBe(true);
  });
});

describe("useDashboardKeyboard", () => {
  it("traverses sections, tasks, and controlled page boundaries without invoking row actions", async () => {
    const action = vi.fn();
    const items = [
      ...Array.from({ length: 21 }, (_, index) =>
        pull(`repo#${index + 1}`, index, "ready"),
      ),
      task("active-task", 0),
      pull("repo#blocked", 0, "blocked"),
    ];
    render(<Harness items={items} onAction={action} />);

    keyDown("p");
    expect(document.activeElement).toHaveAttribute(
      "data-pull-identity",
      "repo#1",
    );

    for (let index = 0; index < 20; index += 1) keyDown("j");
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-identity",
        "repo#21",
      ),
    );
    expect(screen.queryByLabelText("repo#1")).not.toBeInTheDocument();

    keyDown("j");
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-task-id",
        "active-task",
      ),
    );
    keyDown("j");
    expect(document.activeElement).toHaveAttribute(
      "data-pull-identity",
      "repo#blocked",
    );
    keyDown("Home");
    expect(document.activeElement).toHaveAttribute(
      "data-pull-identity",
      "repo#1",
    );
    keyDown("End");
    expect(document.activeElement).toHaveAttribute(
      "data-pull-identity",
      "repo#blocked",
    );
    keyDown("k");
    expect(document.activeElement).toHaveAttribute(
      "data-task-id",
      "active-task",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("reveals hidden panes, focuses New PR, and emits a generation-safe release focus request", async () => {
    const item = pull("repo#1", 0, "ready");
    const releases = vi.fn();
    document.addEventListener(RELEASE_FOCUS_REQUEST, releases);
    const view = render(<Harness initialMode="releases" items={[item]} />);

    keyDown("n");
    expect(screen.getByText("split")).toBeInTheDocument();
    expect(document.activeElement).toBe(
      view.container.querySelector("#new-task-prompt"),
    );

    act(() => {
      screen.getByText("Outside").focus();
      keyDown("r");
    });
    await waitFor(() => expect(releases).toHaveBeenCalledTimes(1));
    expect((releases.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      generation: 1,
    });
    document.removeEventListener(RELEASE_FOCUS_REQUEST, releases);
  });

  it("leaves dashboard navigation and row actions untouched while native output owns focus", () => {
    const action = vi.fn();
    render(
      <Harness
        items={[pull("repo#1", 0, "ready"), pull("repo#2", 1, "ready")]}
        onAction={action}
      />,
    );
    const output = screen.getByRole("generic", { name: "Output repo#1" });
    output.focus();

    fireEvent.keyDown(output, { key: "Home" });
    fireEvent.keyDown(output, { key: "End" });
    fireEvent.keyDown(output, { key: "j" });
    fireEvent.keyDown(output, { key: "k" });

    expect(output).toHaveFocus();
    expect(action).not.toHaveBeenCalled();
  });

  it("preserves a focused identity when it moves and falls forward then backward when it disappears", async () => {
    const first = pull("repo#1", 0, "ready");
    const second = pull("repo#2", 1, "ready");
    const third = pull("repo#3", 2, "ready");
    const view = render(<Harness items={[first, second, third]} />);

    keyDown("p");
    keyDown("j");
    expect(document.activeElement).toHaveAttribute(
      "data-pull-identity",
      "repo#2",
    );

    const moved = { ...second, index: 0, section: "blocked" as const };
    view.rerender(<Harness items={[first, third, moved]} />);
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-identity",
        "repo#2",
      ),
    );

    view.rerender(<Harness items={[first, third]} />);
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-identity",
        "repo#3",
      ),
    );

    view.rerender(<Harness items={[first]} />);
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-pull-identity",
        "repo#1",
      ),
    );
  });

  it("does not steal focus after the user leaves a selected row", async () => {
    const first = pull("repo#1", 0, "ready");
    const second = pull("repo#2", 1, "ready");
    const view = render(<Harness items={[first, second]} />);

    keyDown("p");
    act(() => screen.getByText("Outside").focus());
    view.rerender(<Harness items={[second]} />);
    await act(async () => Promise.resolve());

    expect(document.activeElement).toHaveTextContent("Outside");
  });

  it("opens a focus-trapped Radix shortcut dialog and returns focus on close", async () => {
    render(<Harness items={[pull("repo#1", 0, "ready")]} />);
    const outside = screen.getByText("Outside");
    const trigger = screen.getByRole("button", {
      name: "Keyboard shortcuts",
    });
    act(() => outside.focus());

    keyDown("?");
    const dialog = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    expect(dialog).toHaveTextContent("Next / previous pull request or task");
    expect(
      within(dialog).getByRole("region", {
        name: "Keyboard shortcut reference",
      }),
    ).toHaveClass("overflow-y-auto");
    for (const name of [
      "Global",
      "Pull requests",
      "Files",
      "Commits",
      "Blockers",
      "Releases",
    ]) {
      expect(
        within(dialog).getByRole("heading", { name, level: 3 }),
      ).toBeVisible();
    }
    expect(dialog).toHaveTextContent("Open files, blockers, or commits");
    expect(dialog).toHaveTextContent("Collapse file and move to the next file");
    expect(dialog).toHaveTextContent("Enter the selected commit diff");
    expect(dialog).toHaveTextContent(
      "Return to the blocker, then Blocker details",
    );
    expect(dialog).toHaveTextContent("Enter the release’s pull requests");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "?");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(document.activeElement).toBe(outside);
  });
});
