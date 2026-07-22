// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BranchPicker from "./BranchPicker";

const longBranch =
  "feature/an-extraordinarily-long-branch-name-that-must-not-expand-the-form";
const branches = ["main", "Release/1.9.x", longBranch];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BranchPicker", () => {
  it("filters trimmed case-insensitive branch paths without reordering them", () => {
    render(
      <BranchPicker
        label="Base branch"
        onValueChange={vi.fn()}
        options={branches}
        value="main"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Base branch" });
    fireEvent.click(trigger);

    const search = screen.getByRole("textbox", { name: "Search branches" });
    const list = screen.getByRole("listbox", { name: "Branches" });
    expect(search).toHaveFocus();
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(branches);

    fireEvent.change(search, { target: { value: "  release/1.9  " } });
    expect(screen.getByRole("option", { name: "Release/1.9.x" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "main" }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No branches found.");
  });

  it("links its combobox and search to the list and supports keyboard navigation", () => {
    const select = vi.fn();
    render(
      <BranchPicker
        label="Base branch"
        onValueChange={select}
        options={branches}
        value="main"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Base branch" });
    fireEvent.click(trigger);
    const search = screen.getByRole("textbox", { name: "Search branches" });
    const list = screen.getByRole("listbox", { name: "Branches" });
    const options = within(list).getAllByRole("option");

    expect(trigger).toHaveAttribute("aria-controls", list.id);
    expect(search).toHaveAttribute("aria-controls", list.id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "End" });
    expect(options[2]).toHaveFocus();
    fireEvent.keyDown(options[2]!, { key: "Home" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(options[1]!, { key: "Enter" });

    expect(select).toHaveBeenCalledWith("Release/1.9.x");
    expect(
      screen.queryByRole("textbox", { name: "Search branches" }),
    ).not.toBeInTheDocument();
  });

  it("selects the focused exact branch with Space", () => {
    const select = vi.fn();
    render(
      <BranchPicker
        label="Base branch"
        onValueChange={select}
        options={branches}
        value="main"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search branches" }),
      { key: "ArrowDown" },
    );
    fireEvent.keyDown(screen.getByRole("option", { name: "main" }), {
      key: " ",
    });

    expect(select).toHaveBeenCalledWith("main");
  });

  it("clears a filtered query after selecting and reopening the same options", () => {
    const select = vi.fn();
    render(
      <BranchPicker
        label="Base branch"
        onValueChange={select}
        options={branches}
        value="main"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Base branch" });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Release/1.9.x" }));
    expect(select).toHaveBeenCalledWith("Release/1.9.x");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("textbox", { name: "Search branches" }),
    ).toHaveValue("");
    expect(
      within(screen.getByRole("listbox", { name: "Branches" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(branches);
  });

  it("forwards accessible state and truncates long selected branches", () => {
    render(
      <BranchPicker
        aria-describedby="branch-status"
        aria-invalid
        disabled
        label="Base branch"
        onValueChange={vi.fn()}
        options={branches}
        value={longBranch}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Base branch" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-describedby", "branch-status");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(longBranch)).toHaveClass("truncate");
    expect(screen.getByText(longBranch)).toHaveAttribute("title", longBranch);
  });

  it("resets its query when closed and when branch options change", async () => {
    const next = ["next", "preview"];
    const view = render(
      <BranchPicker
        label="Base branch"
        onValueChange={vi.fn()}
        options={branches}
        value="main"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Base branch" });

    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "release" },
    });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(
      screen.getByRole("textbox", { name: "Search branches" }),
    ).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "main" },
    });
    view.rerender(
      <BranchPicker
        label="Base branch"
        onValueChange={vi.fn()}
        options={next}
        value="next"
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Search branches" }),
      ).not.toBeInTheDocument(),
    );

    const updated = screen.getByRole("combobox", { name: "Base branch" });
    expect(updated).toHaveTextContent("next");
    fireEvent.click(updated);
    expect(
      screen.getByRole("textbox", { name: "Search branches" }),
    ).toHaveValue("");
    expect(
      within(screen.getByRole("listbox", { name: "Branches" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(next);
  });
});
