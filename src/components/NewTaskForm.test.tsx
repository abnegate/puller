// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPOSITORY_PREFERENCES_STORAGE_KEY } from "../repository-preferences";
import type { Task, TaskOptions } from "../types";
import NewTaskForm from "./NewTaskForm";

const options: TaskOptions = {
  repositories: [
    {
      branches: ["1.9.x", "feature/cloud", "main"],
      defaultBranch: "1.9.x",
      name: "cloud",
      owner: "appwrite",
      repository: "appwrite/cloud",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      branches: ["main", "next"],
      defaultBranch: "main",
      name: "edge",
      owner: "appwrite-labs",
      repository: "appwrite-labs/edge",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-07-22T00:00:00.000Z",
};

const task: Task = {
  base: "1.9.x",
  createdAt: "2026-07-22T00:00:00.000Z",
  id: "12345678-task",
  phase: "queued",
  repository: "appwrite/cloud",
  title: "Add task support",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

afterEach(cleanup);
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
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewTaskForm", () => {
  it("defaults to the repository base, validates input, and submits compact task data", async () => {
    const start = vi.fn(async () => task);
    render(
      <NewTaskForm
        error={null}
        loading={false}
        options={options}
        refreshOptions={vi.fn()}
        start={start}
      />,
    );

    expect(screen.getByRole("form", { name: "New PR" })).toBeInTheDocument();
    const container = screen
      .getByRole("form", { name: "New PR" })
      .closest("[data-new-task-form]");
    expect(container).toHaveClass("rounded-none", "bg-transparent", "ring-0");
    expect(container).not.toHaveClass("rounded-xl", "bg-card", "ring-1");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Repository" }),
      ).toHaveTextContent("appwrite/cloud"),
    );
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("1.9.x");
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "New PR" }), {
      target: { value: "Add task support" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        base: "1.9.x",
        prompt: "Add task support",
        repository: "appwrite/cloud",
      }),
    );
    expect(screen.getByRole("textbox", { name: "New PR" })).toHaveValue("");
  });

  it("selects the first favourite repository when the catalog arrives", async () => {
    window.localStorage.setItem(
      REPOSITORY_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        favorites: ["appwrite-labs/edge"],
        version: 1,
      }),
    );
    const view = render(
      <NewTaskForm
        error={null}
        loading
        options={null}
        refreshOptions={vi.fn()}
        start={vi.fn()}
      />,
    );

    view.rerender(
      <NewTaskForm
        error={null}
        loading={false}
        options={options}
        refreshOptions={vi.fn()}
        start={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Repository" }),
      ).toHaveTextContent("appwrite-labs/edge"),
    );
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("main");
  });

  it("searches and submits an exact nondefault base branch", async () => {
    const start = vi.fn(async () => ({ ...task, base: "feature/cloud" }));
    render(
      <NewTaskForm
        error={null}
        loading={false}
        options={options}
        refreshOptions={vi.fn()}
        start={start}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Base branch" }),
      ).toHaveTextContent("1.9.x"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
    const search = screen.getByRole("textbox", { name: "Search branches" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "FEATURE/CLO" } });
    fireEvent.click(screen.getByRole("option", { name: "feature/cloud" }));
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("feature/cloud");

    fireEvent.change(screen.getByRole("textbox", { name: "New PR" }), {
      target: { value: "Use the selected branch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        base: "feature/cloud",
        prompt: "Use the selected branch",
        repository: "appwrite/cloud",
      }),
    );
  });

  it("switches to each repository default branch and keeps failures editable", async () => {
    const start = vi.fn(async () => {
      throw new Error("GitHub could not open the draft PR.");
    });
    render(
      <NewTaskForm
        error={null}
        loading={false}
        options={options}
        refreshOptions={vi.fn()}
        start={start}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Repository" }),
      ).toHaveTextContent("appwrite/cloud"),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "feature/cloud" },
    });
    fireEvent.click(screen.getByRole("option", { name: "feature/cloud" }));

    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "appwrite-labs/edge" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Base branch" }),
    ).toHaveTextContent("main");
    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
    expect(
      screen.queryByRole("option", { name: "feature/cloud" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "next" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search branches" }),
    ).toHaveValue("");
    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));

    fireEvent.change(screen.getByRole("textbox", { name: "New PR" }), {
      target: { value: "Keep this prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub could not open the draft PR.",
    );
    expect(screen.getByRole("textbox", { name: "New PR" })).toHaveValue(
      "Keep this prompt",
    );
  });

  it("associates catalog errors with the controls and offers an in-place retry", () => {
    const refreshOptions = vi.fn();
    render(
      <NewTaskForm
        error="The repository catalog is unavailable."
        loading={false}
        options={null}
        refreshOptions={refreshOptions}
        start={vi.fn()}
      />,
    );

    const status = screen.getByText("The repository catalog is unavailable.");
    expect(status).toHaveAttribute("id", "new-task-status");
    expect(screen.getByRole("textbox", { name: "New PR" })).toHaveAttribute(
      "aria-describedby",
      "new-task-status",
    );
    expect(
      screen.getByRole("combobox", { name: "Repository" }),
    ).toHaveAttribute("aria-describedby", "new-task-status");
    const branch = screen.getByRole("combobox", { name: "Base branch" });
    expect(branch).toBeDisabled();
    expect(branch).toHaveAttribute("aria-describedby", "new-task-status");
    expect(branch).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Retry repositories" }));
    expect(refreshOptions).toHaveBeenCalledOnce();
  });
});
