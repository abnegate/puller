// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskState } from "../tasks";
import TaskRow from "./TaskRow";

const state = (phase: TaskState["task"]["phase"] = "running"): TaskState => ({
  cancelling: false,
  connectionError: null,
  output: "Claude Code started.\nUpdating files…\n",
  sequence: 8,
  task: {
    base: "main",
    branch: "puller/add-support-12345678",
    createdAt: "2026-07-22T00:00:00.000Z",
    id: "12345678-task",
    phase,
    pullRequest: {
      number: 42,
      url: "https://github.com/appwrite/cloud/pull/42",
    },
    repository: "appwrite/cloud",
    title: "Add task support",
    updatedAt: "2026-07-22T00:01:00.000Z",
  },
});

afterEach(cleanup);

describe("TaskRow", () => {
  it.each(["queued", "preparing", "pushing", "opening-pr", "running"] as const)(
    "spins the yellow primary icon during %s",
    (phase) => {
      const { container } = render(
        <ul>
          <TaskRow cancel={vi.fn()} state={state(phase)} />
        </ul>,
      );
      const icon = container.querySelector('[data-status-icon="task"]');

      expect(icon).toHaveClass(
        "lucide-loader-circle",
        "motion-safe:animate-spin",
        "text-amber-600",
      );
      expect(icon).toHaveAttribute("data-status-active", "true");
      expect(container.querySelector('[role="status"]')).toHaveTextContent(
        "Task active:",
      );
    },
  );

  it.each(["cancelled", "completed", "failed"] as const)(
    "keeps a static primary icon after %s",
    (phase) => {
      const { container } = render(
        <ul>
          <TaskRow cancel={vi.fn()} state={state(phase)} />
        </ul>,
      );
      const icon = container.querySelector('[data-status-icon="task"]');

      expect(icon).toHaveAttribute("data-status-active", "false");
      expect(icon).not.toHaveClass("motion-safe:animate-spin");
      expect(container.querySelector('[role="status"]')).toHaveTextContent(
        "Task status:",
      );
    },
  );

  it("exposes actions only on a task-backed PR header", () => {
    const current = state();
    current.task.error = "A recoverable task warning.";
    const hidePull = vi.fn();
    const setFavorite = vi.fn();
    const { container } = render(
      <ul>
        <TaskRow
          cancel={vi.fn(async () => undefined)}
          favorite
          hidePull={hidePull}
          setFavorite={setFavorite}
          state={current}
        />
      </ul>,
    );
    const trigger = container.querySelector<HTMLElement>(
      "[data-slot='pull-actions-trigger']",
    );
    const link = screen.getByRole("link", { name: /Add task support/ });
    const error = screen.getByRole("alert");
    const terminal = screen.getByRole("log");
    const cancel = screen.getByRole("button", { name: "Cancel task" });

    expect(trigger).not.toBeNull();
    expect(trigger).toContainElement(link);
    expect(trigger).not.toContainElement(error);
    expect(trigger).not.toContainElement(terminal);
    expect(trigger).not.toContainElement(cancel);
    expect(screen.getByLabelText("Favourite pull request")).toBeInTheDocument();

    fireEvent.contextMenu(error);
    fireEvent.contextMenu(terminal);
    fireEvent.contextMenu(cancel);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(trigger as HTMLElement);
    expect(
      screen.getByRole("menu", { name: "Pull request actions" }),
    ).toBeInTheDocument();
  });

  it("does not offer pull request actions before a task has opened its PR", () => {
    const preparing = state();
    delete preparing.task.pullRequest;
    const { container } = render(
      <ul>
        <TaskRow
          cancel={vi.fn(async () => undefined)}
          hidePull={vi.fn()}
          setFavorite={vi.fn()}
          state={preparing}
        />
      </ul>,
    );

    expect(
      container.querySelector("[data-slot='pull-actions-trigger']"),
    ).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText("Add task support"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows worktree progress, the early PR link, live output, and explicit cancellation", () => {
    const cancel = vi.fn(async () => undefined);
    const view = render(
      <ul>
        <TaskRow cancel={cancel} state={state()} />
      </ul>,
    );
    const row = view.container.querySelector("[data-task-id]");

    expect(row).toHaveAttribute("aria-label", "Task: Add task support");
    expect(row).toHaveAttribute("data-keyboard-item", "task");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveClass("focus-visible:ring-2");
    expect(screen.getByText("appwrite/cloud")).toBeInTheDocument();
    expect(screen.getByText("puller/add-support-12345678")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add task support/ }),
    ).toHaveAttribute("href", "https://github.com/appwrite/cloud/pull/42");
    expect(screen.getByRole("log")).toHaveTextContent("Updating files…");
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("log")).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("log")).toHaveAttribute(
      "data-keyboard-scroll-region",
      "",
    );
    expect(screen.getByText("Claude running")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(cancel).toHaveBeenCalledWith("12345678-task");
  });

  it("retains failed recovery output without presenting a cancellation action", () => {
    const failed = state("failed");
    failed.task.error = "Claude Code exited with an error.";
    render(
      <ul>
        <TaskRow cancel={vi.fn()} state={failed} />
      </ul>,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Claude Code exited with an error.",
    );
    expect(screen.getByRole("log")).toHaveTextContent("Claude Code started.");
    expect(
      screen.queryByRole("button", { name: "Cancel task" }),
    ).not.toBeInTheDocument();
  });
});
