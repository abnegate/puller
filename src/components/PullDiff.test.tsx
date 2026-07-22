// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IDLE_RUN_STATE,
  type PullRuns,
  type RunStartOutcome,
  type RunState,
} from "../runs";
import { createPullsResponse } from "../test/fixtures";
import type {
  PullDiff as PullDiffData,
  PullDiffFile,
  PullReadiness,
} from "../types";
import PullDiff from "./PullDiff";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const file = (change: Partial<PullDiffFile> = {}): PullDiffFile => ({
  additions: 1,
  binary: false,
  blobUrl: `https://github.com/appwrite/cloud/blob/${HEAD}/src/readiness.ts`,
  changes: 2,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@ readiness",
      lines: [
        { content: "keep()", kind: "context", newLine: 1, oldLine: 1 },
        { content: "before()", kind: "deletion", newLine: null, oldLine: 2 },
        { content: "after()", kind: "addition", newLine: 2, oldLine: null },
        {
          content: "\\ No newline at end of file",
          kind: "meta",
          newLine: null,
          oldLine: null,
        },
      ],
      newLines: 2,
      newStart: 1,
      oldLines: 2,
      oldStart: 1,
    },
  ],
  path: "src/readiness.ts",
  previousPath: null,
  rawUrl: `https://github.com/appwrite/cloud/raw/${HEAD}/src/readiness.ts`,
  status: "modified",
  truncated: false,
  ...change,
});

const diff = (change: Partial<PullDiffData> = {}): PullDiffData => ({
  baseRefOid: BASE,
  complete: true,
  files: [file()],
  headRefOid: HEAD,
  number: 101,
  repository: "appwrite/cloud",
  warning: null,
  ...change,
});

const pullFor = (data: PullDiffData): PullReadiness => ({
  ...createPullsResponse().ready[0]!,
  baseRefOid: data.baseRefOid,
  headRefOid: data.headRefOid,
  number: data.number,
  repository: data.repository,
  repositoryUrl: `https://github.com/${data.repository}`,
  url: `https://github.com/${data.repository}/pull/${data.number}`,
});

const acceptedReviewRun = (): RunStartOutcome => ({
  completion: Promise.resolve("completed"),
  kind: "accepted",
  runId: "review-fix-1",
  source: "review",
  status: "running",
});

const defaultStartRun = vi.fn(async () => acceptedReviewRun());

function ControlledPullDiff({
  data,
  initialViewed = [],
  run = IDLE_RUN_STATE,
  startRun = defaultStartRun,
}: {
  data: PullDiffData;
  initialViewed?: string[];
  run?: RunState;
  startRun?: PullRuns["start"];
}) {
  const [viewed, setViewed] = useState(() => new Set(initialViewed));

  return (
    <PullDiff
      diff={data}
      pull={pullFor(data)}
      run={run}
      startRun={startRun}
      toggleViewed={(path) =>
        setViewed((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        })
      }
      viewed={viewed}
    />
  );
}

const renderPullDiff = (
  data = diff(),
  initialViewed: string[] = [],
  startRun: PullRuns["start"] = vi.fn(async () => acceptedReviewRun()),
  run: RunState = IDLE_RUN_STATE,
) => ({
  startRun,
  ...render(
    <ControlledPullDiff
      data={data}
      initialViewed={initialViewed}
      run={run}
      startRun={startRun}
    />,
  ),
});

const expectAriaControlsToResolve = (container: HTMLElement): void => {
  for (const element of container.querySelectorAll("[aria-controls]")) {
    for (const id of element.getAttribute("aria-controls")!.split(/\s+/)) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
  }
};

afterEach(() => {
  cleanup();
  defaultStartRun.mockClear();
  vi.restoreAllMocks();
});

describe("PullDiff", () => {
  it("renders a compact GitHub-like unified patch with file navigation and gutters", () => {
    const { container } = renderPullDiff();

    expect(
      screen.getByRole("region", {
        name: "Files changed for appwrite/cloud pull request 101",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Changed files" }),
    ).toHaveClass(
      "overflow-x-auto",
      "lg:max-h-[70vh]",
      "lg:flex-col",
      "lg:overflow-auto",
    );
    expect(
      screen.getByRole("button", { name: /src\/readiness\.ts/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("@@ -1,2 +1,2 @@ readiness")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Give Claude feedback on old line 2",
      }),
    ).toHaveTextContent("2");
    expect(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    ).toHaveTextContent("2");
    expect(container.querySelector('[data-line-kind="addition"]')).toHaveClass(
      "bg-emerald-50",
    );
    expect(container.querySelector('[data-line-kind="deletion"]')).toHaveClass(
      "bg-red-50",
    );
    expect(screen.getByRole("link", { name: "View file" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("selects, scrolls to, and focuses a file without moving the whole page", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const second = file({
      blobUrl: `https://github.com/appwrite/cloud/blob/${HEAD}/src/second.ts`,
      path: "src/second.ts",
      rawUrl: `https://github.com/appwrite/cloud/raw/${HEAD}/src/second.ts`,
    });
    renderPullDiff(diff({ files: [file(), second] }), [second.path]);

    fireEvent.click(screen.getByRole("button", { name: /src\/second\.ts/ }));

    const secondButton = screen.getByRole("button", {
      name: /src\/second\.ts/,
    });
    const section = document.getElementById(
      secondButton.getAttribute("aria-controls")!,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(section).toHaveFocus();
    expect(
      screen.getByRole("checkbox", { name: `Viewed ${second.path}` }),
    ).not.toHaveAttribute("aria-controls");
    expect(
      screen.getByRole("button", { name: /src\/second\.ts/ }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("scrolls long file names within the fixed rail without truncating them", () => {
    const path =
      "src/platform/modules/database/reviews/a-very-long-file-name-that-stays-readable.ts";
    renderPullDiff(diff({ files: [file({ path })] }));

    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    const button = screen.getByRole("button", { name: new RegExp(path) });
    const name = within(button).getByText(path);

    expect(navigation).toHaveClass("overflow-x-auto", "lg:overflow-auto");
    expect(button).toHaveClass("w-max", "min-w-full");
    expect(name).toHaveClass("whitespace-nowrap");
    expect(name).not.toHaveClass("truncate");
  });

  it("unmounts only a viewed file body and restores it when unviewed", () => {
    const second = file({
      blobUrl: `https://github.com/appwrite/cloud/blob/${HEAD}/src/second.ts`,
      path: "src/second.ts",
      rawUrl: `https://github.com/appwrite/cloud/raw/${HEAD}/src/second.ts`,
    });
    renderPullDiff(diff({ files: [file(), second] }));

    const count = screen.getByText("0 of 2 files viewed");
    const firstToggle = screen.getByRole("checkbox", {
      name: "Viewed src/readiness.ts",
    });
    const secondToggle = screen.getByRole("checkbox", {
      name: "Viewed src/second.ts",
    });
    const firstBodyId = firstToggle.getAttribute("aria-controls")!;
    const secondBodyId = secondToggle.getAttribute("aria-controls")!;
    const firstBody = document.getElementById(firstBodyId);
    const secondBody = document.getElementById(secondBodyId);

    expect(count).toHaveAttribute("aria-live", "polite");
    expect(firstToggle).toHaveAttribute("aria-checked", "false");
    expect(firstBody).toBeInTheDocument();
    expect(secondBody).toBeInTheDocument();

    fireEvent.click(firstToggle);

    expect(screen.getByText("1 of 2 files viewed")).toBeInTheDocument();
    expect(firstToggle).toHaveAttribute("aria-checked", "true");
    expect(firstToggle).not.toHaveAttribute("aria-controls");
    expect(document.getElementById(firstBodyId)).toBeNull();
    expect(firstBody).not.toBeInTheDocument();
    expect(secondToggle).toHaveAttribute("aria-checked", "false");
    expect(document.getElementById(secondBodyId)).toBe(secondBody);

    fireEvent.click(firstToggle);

    expect(screen.getByText("0 of 2 files viewed")).toBeInTheDocument();
    expect(firstToggle).toHaveAttribute("aria-checked", "false");
    expect(document.getElementById(firstBodyId)).toBeInTheDocument();
    expect(document.getElementById(firstBodyId)).not.toBe(firstBody);
    expect(document.getElementById(firstBodyId)).toHaveTextContent("after()");
  });

  it("does not recompute unaffected patches when selection or viewed state changes", () => {
    const second = file({
      blobUrl: `https://github.com/appwrite/cloud/blob/${HEAD}/src/second.ts`,
      path: "src/second.ts",
      rawUrl: `https://github.com/appwrite/cloud/raw/${HEAD}/src/second.ts`,
    });
    const hunks = second.hunks;
    let reads = 0;
    Object.defineProperty(second, "hunks", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return hunks;
      },
    });
    renderPullDiff(diff({ files: [file(), second] }));
    const initialReads = reads;

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Viewed src/readiness.ts" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /src\/second\.ts/ }));

    expect(reads).toBe(initialReads);
  });

  it("progressively renders file bodies while keeping every file navigable", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const files = Array.from({ length: 45 }, (_, index) =>
      file({
        path: `src/file-${index + 1}.ts`,
      }),
    );
    renderPullDiff(diff({ files }));

    expect(
      screen.getByRole("button", { name: /src\/file-45\.ts/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Viewed src/file-45.ts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show more changed files. 20 of 45 shown.",
      }),
    ).toHaveTextContent("Show 20 more files");

    fireEvent.click(screen.getByRole("button", { name: /src\/file-45\.ts/ }));

    const checkbox = screen.getByRole("checkbox", {
      name: "Viewed src/file-45.ts",
    });
    const navigation = screen.getByRole("button", {
      name: /src\/file-45\.ts/,
    });
    expect(navigation).toHaveAttribute("aria-current", "true");
    expect(navigation).toHaveAttribute("aria-controls");
    expect(
      document.getElementById(navigation.getAttribute("aria-controls")!),
    ).toHaveFocus();
    expect(checkbox).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show more changed files. 21 of 45 shown.",
      }),
    ).toHaveTextContent("Show 20 more files");
  });

  it("uses roving keyboard navigation and reveals a distant selected file", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const files = Array.from({ length: 45 }, (_, index) =>
      file({ path: `src/file-${index + 1}.ts` }),
    );
    renderPullDiff(diff({ files }));

    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    const buttons = within(navigation).getAllByRole("button");
    const first = buttons[0]!;
    const second = buttons[1]!;
    const last = buttons.at(-1)!;

    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([first]);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-current", "true");
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([second]);

    fireEvent.keyDown(second, { key: "End" });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute("aria-current", "true");
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([last]);
    expect(
      screen.getByRole("checkbox", { name: "Viewed src/file-45.ts" }),
    ).toBeInTheDocument();

    fireEvent.click(last);
    expect(
      document.getElementById(last.getAttribute("aria-controls")!),
    ).toHaveFocus();
    last.focus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });

  it("only emits aria-controls references for mounted elements", () => {
    const files = Array.from({ length: 45 }, (_, index) =>
      file({ path: `src/file-${index + 1}.ts` }),
    );
    const { container } = renderPullDiff(diff({ files }));

    expectAriaControlsToResolve(container);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Viewed src/file-1.ts" }),
    );
    expectAriaControlsToResolve(container);
    fireEvent.click(screen.getByRole("button", { name: /src\/file-45\.ts/ }));
    expectAriaControlsToResolve(container);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Viewed src/file-45.ts" }),
    );
    expectAriaControlsToResolve(container);
  });

  it("reports incomplete, binary, renamed, and truncated evidence honestly", () => {
    const binary = file({
      additions: 0,
      binary: true,
      changes: 0,
      deletions: 0,
      hunks: [],
      path: "public/logo.png",
    });
    const renamed = file({
      additions: 0,
      changes: 0,
      deletions: 0,
      hunks: [],
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
    });
    const truncated = file({
      hunks: [],
      path: "src/large.ts",
      truncated: true,
    });
    renderPullDiff(
      diff({
        complete: false,
        files: [binary, renamed, truncated],
        warning: "GitHub returned only the available file boundary.",
      }),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "GitHub returned only the available file boundary.",
    );
    expect(screen.getByText(/Binary file changed/)).toBeInTheDocument();
    expect(
      screen.getByText("File renamed without textual changes."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The text patch is unavailable or incomplete."),
    ).toBeInTheDocument();
    expect(screen.getByText("src/old.ts")).toBeInTheDocument();
    expect(screen.getAllByText("src/new.ts")).toHaveLength(2);
  });

  it("renders diff content as text rather than executable markup", () => {
    const malicious = '<img src=x onerror="window.hacked=true">';
    const unsafe = file({
      hunks: [
        {
          header: "@@ -0,0 +1 @@",
          lines: [
            {
              content: malicious,
              kind: "addition",
              newLine: 1,
              oldLine: null,
            },
          ],
          newLines: 1,
          newStart: 1,
          oldLines: 0,
          oldStart: 0,
        },
      ],
    });
    const { container } = renderPullDiff(diff({ files: [unsafe] }));

    expect(screen.getByText(malicious)).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("offers comment gutters only for provable sides, even in an incomplete overall diff", () => {
    const view = renderPullDiff(
      diff({
        complete: false,
        warning: "Only part of the file list was returned.",
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Give Claude feedback on old line 2",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: "Give Claude feedback on old line 1",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /No newline/ })).toBeNull();

    view.rerender(
      <ControlledPullDiff
        data={diff({ files: [file({ truncated: true })] })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Give Claude feedback on/ }),
    ).toBeNull();
  });

  it("starts a review fix for the exact selected RIGHT range without posting to GitHub", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container, startRun } = renderPullDiff();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
      { shiftKey: true },
    );
    expect(
      screen.getByRole("textbox", {
        name: "Claude feedback on new lines 1–2",
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll("[data-comment-selected]")).toHaveLength(
      2,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Please cover the transition." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRefOid: BASE,
        headRefOid: HEAD,
        number: 101,
        repository: "appwrite/cloud",
      }),
      {
        expectedBaseRefOid: BASE,
        feedback: {
          body: "Please cover the transition.",
          line: 2,
          path: "src/readiness.ts",
          side: "RIGHT",
          startLine: 1,
          startSide: "RIGHT",
        },
        source: "review",
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await screen.findByText("Review fix started")).toBeInTheDocument();
    expect(
      screen.getByText(/commit and push it to the existing/),
    ).toBeInTheDocument();
  });

  it("maps a single LEFT line without range fields", async () => {
    const { startRun } = renderPullDiff();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on old line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Preserve the previous behavior.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    await screen.findByText("Review fix started");
    expect(startRun).toHaveBeenCalledWith(expect.any(Object), {
      expectedBaseRefOid: BASE,
      feedback: {
        body: "Preserve the previous behavior.",
        line: 2,
        path: "src/readiness.ts",
        side: "LEFT",
      },
      source: "review",
    });
  });

  it("preserves the draft and selection when a mixed-side extension is invalid", () => {
    renderPullDiff();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this draft." },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on old line 2",
      }),
      { shiftKey: true },
    );

    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft.");
    expect(
      screen.getByText(
        "Keep the Claude feedback selection on the same side of the diff.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Claude feedback on new line 1" }),
    ).toBeInTheDocument();
  });

  it("preserves the selection across invalid hunk and nonconsecutive extensions", () => {
    const split = file({
      additions: 2,
      changes: 2,
      deletions: 0,
      hunks: [
        {
          header: "@@ -1 +1 @@",
          lines: [
            { content: "first()", kind: "addition", newLine: 1, oldLine: null },
          ],
          newLines: 1,
          newStart: 1,
          oldLines: 0,
          oldStart: 1,
        },
        {
          header: "@@ -10 +10 @@",
          lines: [
            {
              content: "later()",
              kind: "addition",
              newLine: 10,
              oldLine: null,
            },
          ],
          newLines: 1,
          newStart: 10,
          oldLines: 0,
          oldStart: 10,
        },
      ],
    });
    const view = renderPullDiff(diff({ files: [split] }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 10",
      }),
      { shiftKey: true },
    );
    expect(
      screen.getByText(
        "Keep the Claude feedback selection within one diff hunk.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAccessibleName(
      "Claude feedback on new line 1",
    );

    const gap = file({
      additions: 2,
      changes: 2,
      deletions: 0,
      hunks: [
        {
          header: "@@ -1 +1,3 @@",
          lines: [
            { content: "first()", kind: "addition", newLine: 1, oldLine: null },
            { content: "third()", kind: "addition", newLine: 3, oldLine: null },
          ],
          newLines: 3,
          newStart: 1,
          oldLines: 0,
          oldStart: 1,
        },
      ],
    });
    view.rerender(<ControlledPullDiff data={diff({ files: [gap] })} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 3",
      }),
      { shiftKey: true },
    );
    expect(
      screen.getByText(
        "Choose contiguous displayed lines with consecutive line numbers.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps rejected review-fix starts editable with the actionable error", async () => {
    const startRun = vi.fn(
      async (): Promise<RunStartOutcome> => ({
        code: "review_fork_unsupported",
        kind: "failed",
        message:
          "Review fixes are only supported for same-repository branches.",
        source: "review",
      }),
    );
    renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep editing this." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review fixes are only supported for same-repository branches.",
    );
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("Keep editing this.");
    expect(
      screen.getByRole("button", { name: "Run review fix" }),
    ).toBeEnabled();
  });

  it("suppresses duplicate starts while the review fix is pending", async () => {
    let resolve!: (value: RunStartOutcome) => void;
    const pending = new Promise<RunStartOutcome>((promiseResolve) => {
      resolve = promiseResolve;
    });
    const startRun = vi.fn(() => pending);
    renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "One comment only." },
    });
    const form = screen.getByRole("textbox").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(startRun).toHaveBeenCalledOnce();
    resolve(acceptedReviewRun());
    expect(await screen.findByText("Review fix started")).toBeInTheDocument();
  });

  it("surfaces a duplicate active-run outcome without losing the draft", async () => {
    const startRun = vi.fn(
      async (): Promise<RunStartOutcome> => ({
        code: "pull_running",
        kind: "retryable",
        message: "A Claude Code run is already active for this pull request.",
        source: "review",
      }),
    );
    renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Address this after the other task." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A Claude Code run is already active for this pull request.",
    );
    expect(screen.getByRole("textbox")).toHaveValue(
      "Address this after the other task.",
    );
    expect(startRun).toHaveBeenCalledOnce();
  });

  it("disables review-fix submission while this pull already has an active run", () => {
    const startRun = vi.fn(async () => acceptedReviewRun());
    renderPullDiff(diff(), [], startRun, {
      ...IDLE_RUN_STATE,
      source: "review",
      status: "running",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Do this too." },
    });

    expect(
      screen.getByText(/run is already active for this pull request/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run review fix" }),
    ).toBeDisabled();
    expect(startRun).not.toHaveBeenCalled();
  });
});
