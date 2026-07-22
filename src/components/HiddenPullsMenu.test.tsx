// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import HiddenPullsMenu, { type HiddenPull } from "./HiddenPullsMenu";

const hidden: HiddenPull[] = [
  {
    identity: "appwrite/cloud#123",
    number: 123,
    repository: "appwrite/cloud",
  },
  {
    identity: "appwrite-labs/edge#45",
    number: 45,
    repository: "appwrite-labs/edge",
  },
];

const openMenu = (): void => {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Manage 2 hidden pull requests" }),
    { button: 0, ctrlKey: false },
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HiddenPullsMenu", () => {
  it("renders nothing when no current hidden pull requests are known", () => {
    const view = render(
      <HiddenPullsMenu hidden={[]} onShow={vi.fn()} onShowAll={vi.fn()} />,
    );

    expect(view.container).toBeEmptyDOMElement();
  });

  it("opens a compact labelled recovery menu with every current hidden pull", () => {
    render(
      <HiddenPullsMenu hidden={hidden} onShow={vi.fn()} onShowAll={vi.fn()} />,
    );

    const trigger = screen.getByRole("button", {
      name: "Manage 2 hidden pull requests",
    });
    expect(trigger).toHaveTextContent("Hidden 2");
    expect(trigger).toHaveAttribute("type", "button");

    openMenu();

    expect(screen.getByText("Hidden pull requests")).toHaveClass("text-xs");
    expect(
      screen.getByRole("menuitem", { name: "Show appwrite/cloud #123" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Show appwrite-labs/edge #45" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Show all" })).toBeInTheDocument();
  });

  it("restores one pull by stable identity without invoking Show all", () => {
    const onShow = vi.fn();
    const onShowAll = vi.fn();
    render(
      <HiddenPullsMenu
        hidden={hidden}
        onShow={onShow}
        onShowAll={onShowAll}
      />,
    );
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Show appwrite-labs/edge #45" }),
    );

    expect(onShow).toHaveBeenCalledOnce();
    expect(onShow).toHaveBeenCalledWith("appwrite-labs/edge#45");
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it("delegates Show all so persistence can clear known and dormant keys", () => {
    const onShow = vi.fn();
    const onShowAll = vi.fn();
    render(
      <HiddenPullsMenu
        hidden={hidden}
        onShow={onShow}
        onShowAll={onShowAll}
      />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Show all" }));

    expect(onShowAll).toHaveBeenCalledOnce();
    expect(onShow).not.toHaveBeenCalled();
  });

  it("isolates recovery actions from surrounding header click handlers", () => {
    const onOuterClick = vi.fn();
    const onShow = vi.fn();
    render(
      <div onClick={onOuterClick}>
        <HiddenPullsMenu
          hidden={hidden}
          onShow={onShow}
          onShowAll={vi.fn()}
        />
      </div>,
    );
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Show appwrite/cloud #123" }),
    );

    expect(onShow).toHaveBeenCalledOnce();
    expect(onOuterClick).not.toHaveBeenCalled();
  });

  it("uses singular accessible copy for one hidden pull request", () => {
    render(
      <HiddenPullsMenu
        hidden={hidden.slice(0, 1)}
        onShow={vi.fn()}
        onShowAll={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Manage 1 hidden pull request" }),
    ).toHaveTextContent("Hidden 1");
  });
});
