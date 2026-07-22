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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReleaseTagPicker from "./ReleaseTagPicker";

const nextTag = "v2.4.1";
const longTag =
  "release/an-extraordinarily-long-tag-name-that-must-not-expand-the-dialog";

const ControlledPicker = ({ initial = "custom" }: { initial?: string }) => {
  const [value, setValue] = useState(initial);

  return (
    <ReleaseTagPicker
      label="Release tag"
      nextTag={nextTag}
      onValueChange={setValue}
      previousTags={["v2.4.0", "v2.3.9"]}
      value={value}
    />
  );
};

afterEach(cleanup);

describe("ReleaseTagPicker", () => {
  it("renders the suggested tag first and caps discoverable history at ten", () => {
    const previousTags = [
      longTag,
      ...Array.from({ length: 11 }, (_, index) => `v2.3.${10 - index}`),
    ];
    render(
      <ReleaseTagPicker
        label="Release tag"
        nextTag={nextTag}
        onValueChange={vi.fn()}
        previousTags={previousTags}
        value={nextTag}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Release tag" });
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    const list = screen.getByRole("listbox", { name: "Release tag options" });
    const options = within(list).getAllByRole("option");

    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(options).toHaveLength(11);
    expect(options[0]).toHaveTextContent(nextTag);
    expect(options[0]).toHaveTextContent("Suggested");
    expect(options[0]).not.toHaveAttribute("aria-disabled");
    expect(options[0]).toHaveAttribute("tabindex", "-1");
    for (const option of options.slice(1)) {
      expect(option).toHaveTextContent("Existing");
      expect(option).toHaveAttribute("aria-disabled", "true");
      expect(option).toHaveAttribute("tabindex", "-1");
    }
    expect(within(options[1]!).getByTitle(longTag)).toHaveClass("truncate");
    expect(screen.queryByText("v2.3.0")).not.toBeInTheDocument();
  });

  it("keeps existing rows read-only while the suggestion updates the editable input", async () => {
    render(<ControlledPicker />);
    const input = screen.getByRole("combobox", { name: "Release tag" });

    expect(input).toHaveValue("custom");
    fireEvent.change(input, { target: { value: "custom-2" } });
    expect(input).toHaveValue("custom-2");
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "v2.4.0, Existing" }));

    expect(input).toHaveValue("custom-2");
    expect(
      screen.getByRole("listbox", { name: "Release tag options" }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("option", { name: `${nextTag}, Suggested` }),
    );

    expect(input).toHaveValue(nextTag);
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(input).toHaveFocus();
  });

  it("includes read-only rows in keyboard navigation without selecting them", async () => {
    render(<ControlledPicker />);
    const input = screen.getByRole("combobox", { name: "Release tag" });

    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveFocus();

    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1]!, { key: "Enter" });
    expect(input).toHaveValue("custom");
    expect(options[1]).toHaveFocus();

    fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: " " });

    expect(input).toHaveValue(nextTag);
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(input).toHaveFocus();
  });

  it("closes with Escape and returns focus to the input", async () => {
    render(<ControlledPicker />);
    const input = screen.getByRole("combobox", { name: "Release tag" });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(options.at(-1)).toHaveFocus();
    fireEvent.keyDown(options.at(-1)!, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(input).toHaveFocus();

    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(input).toHaveFocus();
  });

  it("does not steal focus after an outside pointer dismissal", async () => {
    render(
      <>
        <ControlledPicker />
        <button type="button">Continue</button>
      </>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    const outside = screen.getByRole("button", { name: "Continue" });

    outside.addEventListener("pointerdown", () => outside.focus(), {
      once: true,
    });
    fireEvent.pointerDown(outside);

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(outside).toHaveFocus();
  });

  it("forwards validation and disabled state to its combobox", () => {
    render(
      <ReleaseTagPicker
        aria-describedby="release-tag-help release-tag-error"
        aria-invalid
        disabled
        label="Release tag"
        nextTag={nextTag}
        onValueChange={vi.fn()}
        previousTags={[]}
        value={longTag}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Release tag" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute(
      "aria-describedby",
      "release-tag-help release-tag-error",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("title", longTag);
    expect(
      screen.getByRole("button", { name: "Show release tag options" }),
    ).toBeDisabled();
  });
});
