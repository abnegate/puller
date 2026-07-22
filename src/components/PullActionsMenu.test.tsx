// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PullActionsMenu, { PullFavoriteIndicator } from "./PullActionsMenu";

type HarnessProps = {
  favorite?: boolean;
  onHide?: () => void;
  onOuterClick?: () => void;
};

function Harness({
  favorite: initialFavorite = false,
  onHide = () => undefined,
  onOuterClick = () => undefined,
}: HarnessProps) {
  const [favorite, setFavorite] = useState(initialFavorite);

  return (
    <div onClick={onOuterClick}>
      <PullActionsMenu
        className="summary"
        favorite={favorite}
        onFavoriteChange={setFavorite}
        onHide={onHide}
      >
        <a href="https://github.com/appwrite/cloud/pull/123">
          appwrite/cloud #123
        </a>
        {favorite ? <PullFavoriteIndicator /> : null}
      </PullActionsMenu>
    </div>
  );
}

const getTrigger = (): HTMLElement => {
  const trigger = document.querySelector<HTMLElement>(
    "[data-slot='pull-actions-trigger']",
  );
  if (!trigger) throw new Error("Pull actions trigger was not rendered");
  return trigger;
};

const openWithRightClick = (): void => {
  fireEvent.contextMenu(getTrigger(), { clientX: 20, clientY: 24 });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PullActionsMenu", () => {
  it("opens the labelled action menu on native right click", () => {
    render(<Harness />);

    expect(
      fireEvent.contextMenu(getTrigger(), { clientX: 20, clientY: 24 }),
    ).toBe(false);

    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pull request actions")).toHaveClass("text-xs");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Favourite" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    ).toBeInTheDocument();
  });

  it("opens from Shift+F10 at a point inside the structural trigger", () => {
    render(<Harness />);
    const trigger = getTrigger();
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 90,
      height: 60,
      left: 10,
      right: 110,
      toJSON: () => ({}),
      top: 30,
      width: 100,
      x: 10,
      y: 30,
    });
    const dispatch = vi.spyOn(trigger, "dispatchEvent");

    expect(
      fireEvent.keyDown(screen.getByRole("link"), {
        key: "F10",
        shiftKey: true,
      }),
    ).toBe(false);

    const contextEvent = dispatch.mock.calls.find(
      ([event]) => event.type === "contextmenu",
    )?.[0] as MouseEvent | undefined;
    expect(contextEvent).toBeInstanceOf(MouseEvent);
    expect(contextEvent?.bubbles).toBe(true);
    expect(contextEvent?.cancelable).toBe(true);
    expect(contextEvent?.clientX).toBe(60);
    expect(contextEvent?.clientY).toBe(60);
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
  });

  it("opens from the ContextMenu key without hijacking plain keyboard actions", () => {
    const view = render(<Harness />);
    const link = screen.getByRole("link");

    expect(fireEvent.keyDown(link, { key: "F10" })).toBe(true);
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(link, { key: " " })).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    expect(fireEvent.keyDown(link, { key: "ContextMenu" })).toBe(false);
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();

    view.unmount();
  });

  it("toggles the checked favourite action and exposes a compact amber marker", () => {
    render(<Harness favorite />);
    expect(screen.getByLabelText("Favourite pull request")).toHaveClass(
      "text-amber-500",
    );

    openWithRightClick();
    const favorite = screen.getByRole("menuitemcheckbox", {
      name: "Favourite",
    });
    expect(favorite).toHaveAttribute("aria-checked", "true");

    fireEvent.click(favorite);

    expect(
      screen.queryByLabelText("Favourite pull request"),
    ).not.toBeInTheDocument();
  });

  it("isolates menu actions from the row and invokes Hide once", () => {
    const onHide = vi.fn();
    const onOuterClick = vi.fn();
    render(<Harness onHide={onHide} onOuterClick={onOuterClick} />);
    openWithRightClick();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Hide pull request" }),
    );

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onOuterClick).not.toHaveBeenCalled();
  });

  it("keeps Radix touch long-press support on the safe trigger boundary", () => {
    vi.useFakeTimers();
    class TestPointerEvent extends MouseEvent {
      pointerType: string;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    render(<Harness />);

    fireEvent.pointerDown(getTrigger(), {
      clientX: 12,
      clientY: 14,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(699));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
  });

  it.each(["move", "up", "cancel"] as const)(
    "cancels a pending touch long-press on pointer %s",
    (event) => {
      vi.useFakeTimers();
      class TestPointerEvent extends MouseEvent {
        pointerType: string;

        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "";
        }
      }
      vi.stubGlobal("PointerEvent", TestPointerEvent);
      render(<Harness />);
      const trigger = getTrigger();

      fireEvent.pointerDown(trigger, { pointerType: "touch" });
      if (event === "move") {
        fireEvent.pointerMove(trigger, { pointerType: "touch" });
      } else if (event === "up") {
        fireEvent.pointerUp(trigger, { pointerType: "touch" });
      } else {
        fireEvent.pointerCancel(trigger, { pointerType: "touch" });
      }
      act(() => vi.advanceTimersByTime(700));

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );
});
