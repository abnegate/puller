// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPOSITORY_PREFERENCES_STORAGE_KEY } from "@/repository-preferences";

import RepositoryPicker from "./RepositoryPicker";

const repositories = [
  { repository: "Appwrite-Labs/Edge" },
  { repository: "appwrite/cloud" },
  { repository: "appwrite/website" },
];

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RepositoryPicker", () => {
  it("searches owner/name locally and renders a restrained no-results state", () => {
    render(
      <RepositoryPicker
        label="Repository"
        onValueChange={vi.fn()}
        options={repositories}
        value="appwrite/cloud"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Repository" });
    expect(trigger).toHaveTextContent("appwrite/cloud");
    fireEvent.click(trigger);

    const search = screen.getByRole("textbox", {
      name: "Search repositories",
    });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "labs/ed" } });
    expect(
      screen.getByRole("option", { name: "Appwrite-Labs/Edge" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "appwrite/cloud" }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No repositories found.",
    );
  });

  it("favorites without selecting or closing and moves favorites first", () => {
    const select = vi.fn();
    render(
      <RepositoryPicker
        label="Repository"
        onValueChange={select}
        options={repositories}
        value="appwrite/cloud"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    const list = screen.getByRole("listbox", { name: "Repositories" });
    const favorite = screen.getByRole("button", {
      name: "Add favourite repository appwrite/website",
    });
    expect(list).not.toContainElement(favorite);
    favorite.focus();
    expect(favorite).toHaveFocus();
    fireEvent.click(favorite);

    expect(select).not.toHaveBeenCalled();
    expect(list).toBeVisible();
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["appwrite/website", "Appwrite-Labs/Edge", "appwrite/cloud"]);
    expect(
      screen.getByRole("button", {
        name: "Remove favourite repository appwrite/website",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      JSON.parse(
        window.localStorage.getItem(REPOSITORY_PREFERENCES_STORAGE_KEY)!,
      ),
    ).toEqual({ favorites: ["appwrite/website"], version: 1 });
  });

  it("preserves catalog casing and supports keyboard option navigation", () => {
    const select = vi.fn();
    render(
      <RepositoryPicker
        label="Repository"
        onValueChange={select}
        options={repositories}
        value="appwrite/cloud"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    const search = screen.getByRole("textbox", {
      name: "Search repositories",
    });
    expect(
      screen.getByRole("combobox", { name: "Repository" }),
    ).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(search).toHaveAttribute(
      "aria-controls",
      screen.getByRole("listbox").id,
    );
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "Enter" });

    expect(select).toHaveBeenCalledWith("Appwrite-Labs/Edge");
    expect(
      screen.queryByRole("textbox", { name: "Search repositories" }),
    ).not.toBeInTheDocument();
  });

  it("forwards accessible state to its combobox trigger", () => {
    render(
      <RepositoryPicker
        aria-describedby="repository-status"
        aria-invalid
        disabled
        label="Release repository"
        loading
        onValueChange={vi.fn()}
        options={[]}
        value=""
      />,
    );

    const trigger = screen.getByRole("combobox", {
      name: "Release repository",
    });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-describedby", "repository-status");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveTextContent("Loading repositories…");
  });
});
