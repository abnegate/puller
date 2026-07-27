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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDLE_RUN_STATE,
  type PullRuns,
  type RunStartOutcome,
  type RunState,
  type RunTerminalStatus,
} from "../runs";
import {
  highlightFile,
  type HighlightedFile,
  type SyntaxToken,
} from "../syntax";
import { createPullsResponse } from "../test/fixtures";
import type {
  Agent,
  PullCommitDiff,
  PullDiff as PullDiffData,
  PullDiffFile,
  PullReadiness,
} from "../types";

vi.mock("../syntax", () => ({
  highlightFile: vi.fn(() => Promise.resolve(null)),
}));

import PullDiff, {
  createPullDiffPersistence,
  normalizePullDiffPersistence,
  type PullDiffPersistence,
} from "./PullDiff";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMIT = "cccccccccccccccccccccccccccccccccccccccc";

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

const commitDiff = (change: Partial<PullCommitDiff> = {}): PullCommitDiff => ({
  ...diff(),
  commitSha: COMMIT,
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

const neverCompletes = new Promise<RunTerminalStatus>(() => undefined);

const acceptedReviewRun = (
  completion: Promise<RunTerminalStatus> = neverCompletes,
): RunStartOutcome => ({
  completion,
  kind: "accepted",
  runId: "review-fix-1",
  source: "review",
  status: "running",
});

const runningReviewState = (
  attemptToken = "review-attempt-1",
  agent: Agent = "claude",
): RunState => ({
  ...IDLE_RUN_STATE,
  actionId: "review-fix-1",
  agent,
  headRefOid: HEAD,
  reviewAttemptToken: attemptToken,
  source: "review",
  status: "running",
});

const retryReviewState = (
  status: Exclude<RunTerminalStatus, "completed">,
  draft: string,
  feedback: {
    body: string;
    line: number;
    path: string;
    side: "LEFT" | "RIGHT";
    startLine?: number;
    startSide?: "LEFT" | "RIGHT";
  },
  attemptToken = "review-attempt-1",
): RunState => ({
  ...IDLE_RUN_STATE,
  reviewRetry: {
    attemptToken,
    baseRefOid: BASE,
    draft,
    feedback,
    headRefOid: HEAD,
    runId: "review-fix-1",
    status,
  },
});

const defaultStartRun = vi.fn(async () => acceptedReviewRun());
const defaultClearReviewRetry = vi.fn();

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const bounds = (top: number, bottom: number, left = 0, right = 800): DOMRect =>
  ({
    bottom,
    height: bottom - top,
    left,
    right,
    toJSON: () => ({}),
    top,
    width: right - left,
    x: left,
    y: top,
  }) as DOMRect;

const syntaxFile = (content: string, path = "src/highlight.ts"): PullDiffFile =>
  file({
    additions: 1,
    changes: 1,
    deletions: 0,
    hunks: [
      {
        header: "@@ -0,0 +1 @@",
        lines: [
          {
            content,
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
    path,
  });

const syntaxToken = (
  content: string,
  change: Partial<SyntaxToken> = {},
): SyntaxToken => ({
  content,
  darkFontStyle: "normal",
  darkFontWeight: 400,
  darkForeground: "#79c0ff",
  lightFontStyle: "normal",
  lightFontWeight: 400,
  lightForeground: "#0550ae",
  ...change,
});

const syntaxHighlight = (tokens: readonly SyntaxToken[]): HighlightedFile => ({
  hunks: [{ lines: [tokens] }],
  language: "typescript",
});

function ControlledPullDiff({
  agent = "claude",
  clearReviewRetry = defaultClearReviewRetry,
  data,
  initialViewed = [],
  onPersistenceChange,
  persistence,
  readOnly = false,
  run = IDLE_RUN_STATE,
  startRun = defaultStartRun,
}: {
  agent?: Agent;
  clearReviewRetry?: PullRuns["clearReviewRetry"];
  data: PullDiffData;
  initialViewed?: string[];
  onPersistenceChange?: (persistence: PullDiffPersistence) => void;
  persistence?: PullDiffPersistence;
  readOnly?: boolean;
  run?: RunState;
  startRun?: PullRuns["start"];
}) {
  const [viewed, setViewed] = useState(() => new Set(initialViewed));

  return (
    <PullDiff
      agent={agent}
      clearReviewRetry={clearReviewRetry}
      diff={data}
      onPersistenceChange={onPersistenceChange}
      persistence={persistence}
      pull={pullFor(data)}
      readOnly={readOnly}
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

function PersistentPullDiff({ data }: { data: PullDiffData }) {
  const [mounted, setMounted] = useState(true);
  const [persistence, setPersistence] = useState(() =>
    createPullDiffPersistence(data),
  );

  return (
    <>
      <button onClick={() => setMounted((current) => !current)} type="button">
        Toggle diff
      </button>
      {mounted && (
        <ControlledPullDiff
          data={data}
          onPersistenceChange={setPersistence}
          persistence={persistence}
        />
      )}
    </>
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

beforeEach(() => {
  vi.mocked(highlightFile).mockReset();
  vi.mocked(highlightFile).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  defaultStartRun.mockClear();
  defaultClearReviewRetry.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PullDiff", () => {
  it("renders plain text first, then replaces only line content with themed syntax tokens", async () => {
    const source = "const answer = 42;";
    const changed = syntaxFile(source);
    const pending = deferred<HighlightedFile | null>();
    vi.mocked(highlightFile).mockReturnValueOnce(pending.promise);
    const { container } = renderPullDiff(diff({ files: [changed] }));
    const row = container.querySelector<HTMLElement>(
      '[data-line-kind="addition"]',
    )!;
    const code = row.querySelector("code")!;
    const rowClasses = row.className;

    expect(code).toHaveTextContent(`+${source}`);
    expect(code.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-syntax-token]")).toBeNull();

    await act(async () => {
      pending.resolve(
        syntaxHighlight([
          syntaxToken("const", {
            darkFontWeight: 700,
            lightFontWeight: 700,
          }),
          syntaxToken(" answer = 42;", {
            darkForeground: "#ffa657",
            darkFontStyle: "italic",
            lightFontStyle: "italic",
            lightForeground: "#953800",
          }),
        ]),
      );
      await pending.promise;
    });

    const tokens = [
      ...container.querySelectorAll<HTMLElement>("[data-syntax-token]"),
    ];
    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.textContent).join("")).toBe(source);
    expect(code).toHaveTextContent(`+${source}`);
    expect(row).toHaveClass(...rowClasses.split(" "));
    expect(code.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(tokens[0]).toHaveAttribute(
      "data-syntax-light-foreground",
      "#0550ae",
    );
    expect(tokens[0]).toHaveAttribute("data-syntax-dark-foreground", "#79c0ff");
    expect(tokens[0]).toHaveAttribute("data-syntax-dark-font-weight", "700");
    expect(tokens[0]).toHaveAttribute("data-syntax-light-font-weight", "700");
    expect(tokens[1]).toHaveAttribute("data-syntax-dark-font-style", "italic");
    expect(tokens[1]).toHaveAttribute("data-syntax-light-font-style", "italic");
    expect(tokens[1]).toHaveStyle({
      "--syntax-dark-font-style": "italic",
      "--syntax-dark-font-weight": "400",
      "--syntax-dark-foreground": "#ffa657",
      "--syntax-light-font-style": "italic",
      "--syntax-light-font-weight": "400",
      "--syntax-light-foreground": "#953800",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    expect(
      screen.getByRole("textbox", {
        name: "Claude feedback on new line 1",
      }),
    ).toBeInTheDocument();
  });

  it("ignores a stale async result when the same path receives a new file object", async () => {
    const first = syntaxFile("const version = 'old';");
    const second = syntaxFile("const version = 'new';");
    const firstPending = deferred<HighlightedFile | null>();
    const secondPending = deferred<HighlightedFile | null>();
    vi.mocked(highlightFile)
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);

    const view = render(<ControlledPullDiff data={diff({ files: [first] })} />);
    expect(
      view.container.querySelector('[data-line-kind="addition"] code'),
    ).toHaveTextContent("+const version = 'old';");

    view.rerender(<ControlledPullDiff data={diff({ files: [second] })} />);
    expect(
      view.container.querySelector('[data-line-kind="addition"] code'),
    ).toHaveTextContent("+const version = 'new';");
    expect(view.container.querySelector("[data-syntax-token]")).toBeNull();

    await act(async () => {
      secondPending.resolve(
        syntaxHighlight([syntaxToken("const version = 'new';")]),
      );
      await secondPending.promise;
    });
    expect(
      view.container.querySelector("[data-syntax-token]"),
    ).toHaveTextContent("const version = 'new';");

    await act(async () => {
      firstPending.resolve(
        syntaxHighlight([syntaxToken("const version = 'old';")]),
      );
      await firstPending.promise;
    });
    expect(
      view.container.querySelector('[data-line-kind="addition"] code'),
    ).toHaveTextContent("+const version = 'new';");
    expect(
      view.container.querySelector("[data-syntax-token]"),
    ).toHaveTextContent("const version = 'new';");
  });

  it("schedules only near-viewport files and cancels work that leaves the margin", async () => {
    type Observation = {
      callback: IntersectionObserverCallback;
      element: Element | null;
      observer: IntersectionObserver;
      rootMargin: string;
    };
    const observations: Observation[] = [];

    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds = [0];
      readonly observation: Observation;

      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        this.rootMargin = options?.rootMargin ?? "0px";
        this.observation = {
          callback,
          element: null,
          observer: this as unknown as IntersectionObserver,
          rootMargin: this.rootMargin,
        };
        observations.push(this.observation);
      }

      disconnect(): void {}

      observe(element: Element): void {
        this.observation.element = element;
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      unobserve(): void {}
    }

    const intersect = (
      observation: Observation,
      isIntersecting: boolean,
    ): void => {
      observation.callback(
        [
          {
            isIntersecting,
            target: observation.element!,
          } as IntersectionObserverEntry,
        ],
        observation.observer,
      );
    };

    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.mocked(highlightFile).mockReturnValue(
      new Promise<HighlightedFile | null>(() => undefined),
    );
    const files = Array.from({ length: 20 }, (_, index) =>
      syntaxFile(`const value${index} = ${index};`, `src/file-${index}.ts`),
    );
    renderPullDiff(diff({ files }));

    expect(observations).toHaveLength(20);
    expect(
      observations.every(({ rootMargin }) => rootMargin === "800px 0px"),
    ).toBe(true);
    expect(highlightFile).not.toHaveBeenCalled();

    act(() => intersect(observations[0]!, true));
    await waitFor(() => expect(highlightFile).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(highlightFile).mock.calls[0]?.[1];
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal?.aborted).toBe(false);

    act(() => intersect(observations[0]!, false));
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));

    act(() => intersect(observations[1]!, true));
    await waitFor(() => expect(highlightFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(highlightFile).mock.calls[1]?.[1]?.aborted).toBe(false);
  });

  it("keeps unsupported files as exact plain text without token wrappers", async () => {
    const changed = syntaxFile("opaque \t content", "fixtures/readiness.data");
    renderPullDiff(diff({ files: [changed] }));

    await waitFor(() =>
      expect(highlightFile).toHaveBeenCalledWith(
        changed,
        expect.any(AbortSignal),
      ),
    );
    const content = document.querySelector("[data-syntax-content]")!;
    expect(content).toHaveAttribute("data-syntax-content", "");
    expect(content.querySelector("[data-syntax-token]")).toBeNull();
    expect(content.textContent).toBe("opaque \t content");
  });

  it("preserves the non-breaking-space placeholder for an empty diff line", async () => {
    const changed = syntaxFile("");
    vi.mocked(highlightFile).mockResolvedValueOnce(syntaxHighlight([]));
    const { container } = renderPullDiff(diff({ files: [changed] }));

    await waitFor(() =>
      expect(highlightFile).toHaveBeenCalledWith(
        changed,
        expect.any(AbortSignal),
      ),
    );
    const content = container.querySelector("[data-syntax-content]")!;
    expect(content.textContent).toBe("\u00a0");
    expect(
      container.querySelector('[data-line-kind="addition"] code')
        ?.firstElementChild,
    ).toHaveTextContent("+");
  });

  it("switches syntax themes through CSS state without tokenizing again", async () => {
    const changed = syntaxFile("return true;");
    vi.mocked(highlightFile).mockResolvedValueOnce(
      syntaxHighlight([syntaxToken("return true;")]),
    );
    const data = diff({ files: [changed] });
    const view = render(<ControlledPullDiff data={data} />);

    await waitFor(() =>
      expect(
        view.container.querySelector("[data-syntax-token]"),
      ).toBeInTheDocument(),
    );
    expect(highlightFile).toHaveBeenCalledTimes(1);
    document.documentElement.classList.add("dark");
    view.rerender(<ControlledPullDiff data={data} />);
    expect(highlightFile).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("[data-syntax-token]")).toHaveStyle({
      "--syntax-dark-foreground": "#79c0ff",
      "--syntax-light-foreground": "#0550ae",
    });
    document.documentElement.classList.remove("dark");
  });

  it("highlights selected commit diffs through the shared renderer", async () => {
    const changed = syntaxFile("let committed = true;");
    vi.mocked(highlightFile).mockResolvedValueOnce(
      syntaxHighlight([
        syntaxToken("let", {
          darkFontWeight: 700,
          lightFontWeight: 700,
        }),
        syntaxToken(" committed = true;"),
      ]),
    );
    const { container } = renderPullDiff(commitDiff({ files: [changed] }));

    await waitFor(() =>
      expect(container.querySelectorAll("[data-syntax-token]")).toHaveLength(2),
    );
    expect(container.querySelector("[data-diff-revision]")).toHaveTextContent(
      COMMIT.slice(0, 7),
    );
    expect(
      container.querySelector('[data-line-kind="addition"] code'),
    ).toHaveTextContent("+let committed = true;");
  });

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
      screen.getByRole("button", { name: /^readiness\.ts/ }),
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

  it("labels a pull diff with its head and a selected commit diff with its commit SHA", () => {
    const pullView = renderPullDiff();
    const pullRevision = pullView.container.querySelector(
      "[data-diff-revision]",
    );
    expect(pullRevision).toHaveTextContent(HEAD.slice(0, 7));
    expect(pullRevision).toHaveAttribute("title", HEAD);
    pullView.unmount();

    const commitView = renderPullDiff(commitDiff());
    const commitRevision = commitView.container.querySelector(
      "[data-diff-revision]",
    );
    expect(commitRevision).toHaveTextContent(COMMIT.slice(0, 7));
    expect(commitRevision).toHaveAttribute("title", COMMIT);
  });

  it("keeps every short file flush and content-sized without width traps", () => {
    const second = file({
      blobUrl: `https://github.com/appwrite/cloud/blob/${HEAD}/src/a-very-long-second-file-name-that-scrolls-independently.ts`,
      path: "src/a-very-long-second-file-name-that-scrolls-independently.ts",
      rawUrl: `https://github.com/appwrite/cloud/raw/${HEAD}/src/a-very-long-second-file-name-that-scrolls-independently.ts`,
    });
    const { container } = renderPullDiff(diff({ files: [file(), second] }));
    const region = screen.getByRole("region", {
      name: "Files changed for appwrite/cloud pull request 101",
    });
    const files = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file]"),
    ];
    const headers = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file-header]"),
    ];
    const names = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file-name]"),
    ];
    const patches = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file-patch]"),
    ];
    const bodies = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file-body]"),
    ];
    const navigation = container.querySelector<HTMLElement>(
      "[data-diff-navigation-pane]",
    );
    const stickyNavigation = container.querySelector<HTMLElement>(
      "[data-diff-navigation-sticky]",
    );

    expect(region).toHaveClass(
      "w-full",
      "min-w-0",
      "rounded-xl",
      "bg-background",
    );
    expect(region).not.toHaveClass("overflow-hidden");
    expect(files).toHaveLength(2);
    expect(headers).toHaveLength(2);
    expect(names).toHaveLength(2);
    expect(patches).toHaveLength(2);
    expect(bodies).toHaveLength(2);
    expect(navigation).toHaveClass(
      "self-stretch",
      "bg-muted/15",
      "lg:border-r",
    );
    expect(navigation).not.toHaveClass("lg:self-start", "lg:sticky");
    expect(stickyNavigation).toHaveClass("lg:sticky", "lg:top-0");

    for (const [index, header] of headers.entries()) {
      expect(files[index]).toContainElement(header);
      expect(files[index]).toHaveClass(
        "flex",
        "flex-col",
        "w-full",
        "min-w-0",
        "scroll-mt-0",
        "rounded-lg",
      );
      expect(files[index]).not.toHaveClass("min-h-svh");
      expect(files[index]).not.toHaveClass("scroll-mt-10");
      expect(files[index]).not.toHaveClass("overflow-hidden");
      expect(header).toHaveClass(
        "sticky",
        "top-0",
        "z-50",
        "-mx-px",
        "w-[calc(100%+2px)]",
        "min-w-0",
        "border-x",
        "rounded-t-lg",
        "bg-card",
      );
      expect(header).not.toHaveClass("w-full");
      expect(header.firstElementChild).toHaveClass(
        "overflow-clip",
        "rounded-[inherit]",
      );

      let ancestor = header.parentElement;
      while (ancestor && ancestor !== region.parentElement) {
        expect(ancestor).not.toHaveClass("overflow-hidden");
        if (ancestor === region) break;
        ancestor = ancestor.parentElement;
      }

      expect(names[index]).toHaveClass(
        "min-w-0",
        "flex-1",
        "overflow-x-auto",
        "whitespace-nowrap",
      );
      expect(patches[index]).toHaveClass(
        "min-h-0",
        "w-full",
        "min-w-0",
        "flex-1",
        "overflow-x-auto",
      );
      expect(bodies[index]).toHaveClass(
        "flex",
        "min-h-0",
        "min-w-0",
        "flex-1",
        "flex-col",
      );
      expect(names[index]).not.toContainElement(patches[index]!);
    }

    expect(
      headers[0]!.compareDocumentPosition(headers[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Changed files" }),
    ).toHaveClass("overflow-x-auto", "lg:overflow-auto");
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

    fireEvent.click(screen.getByRole("button", { name: /^second\.ts/ }));

    const secondButton = screen.getByRole("button", {
      name: /^second\.ts/,
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
    expect(screen.getByRole("button", { name: /^second\.ts/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("scrolls long file names within the fixed rail without truncating them", () => {
    const path =
      "src/platform/modules/database/reviews/a-very-long-file-name-that-stays-readable.ts";
    renderPullDiff(diff({ files: [file({ path })] }));

    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    const button = screen.getByRole("button", {
      name: /^a-very-long-file-name-that-stays-readable\.ts/,
    });
    const name = within(button).getByText(
      "a-very-long-file-name-that-stays-readable.ts",
    );

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
    expect(firstToggle.closest("[data-diff-file-header]")).toHaveClass(
      "sticky",
      "top-0",
      "rounded-lg",
    );
    expect(firstToggle.closest("[data-diff-file-header]")).not.toHaveClass(
      "rounded-t-lg",
    );
    expect(firstToggle.closest("[data-diff-file]")).not.toHaveClass(
      "min-h-svh",
    );
    expect(secondToggle).toHaveAttribute("aria-checked", "false");
    expect(document.getElementById(secondBodyId)).toBe(secondBody);

    fireEvent.click(firstToggle);

    expect(screen.getByText("0 of 2 files viewed")).toBeInTheDocument();
    expect(firstToggle).toHaveAttribute("aria-checked", "false");
    expect(firstToggle.closest("[data-diff-file]")).not.toHaveClass(
      "min-h-svh",
    );
    expect(document.getElementById(firstBodyId)).toBeInTheDocument();
    expect(document.getElementById(firstBodyId)).not.toBe(firstBody);
    expect(document.getElementById(firstBodyId)).toHaveTextContent("after()");
  });

  it("anchors the next file beneath sticky headers after collapsing a viewed file", () => {
    const current = file({ path: "a/current.ts" });
    const next = file({ path: "b/next.ts" });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-scroll-owner")) return bounds(100, 500);
        if (this.hasAttribute("data-test-sticky")) return bounds(100, 144);
        if (this.hasAttribute("data-test-other-sticky")) {
          return bounds(100, 300, 900, 1_200);
        }
        const path = this.querySelector<HTMLElement>(
          "[data-diff-file-name]",
        )?.textContent;
        if (path === current.path) return bounds(180, 220);
        if (path === next.path) return bounds(260, 400);
        return bounds(0, 0);
      },
    );

    const view = render(
      <div data-scroll-owner="" style={{ height: 400, overflowY: "auto" }}>
        <div
          className="sticky"
          data-test-sticky=""
          style={{ position: "sticky", top: 0 }}
        />
        <div
          className="sticky"
          data-test-other-sticky=""
          style={{ position: "sticky", top: 0 }}
        />
        <ControlledPullDiff data={diff({ files: [next, current] })} />
      </div>,
    );
    const owner = view.container.querySelector<HTMLElement>(
      "[data-scroll-owner]",
    )!;
    Object.defineProperties(owner, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
    });
    owner.scrollLeft = 53;
    owner.scrollTop = 400;
    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    navigation.scrollLeft = 81;
    const nextSection = screen
      .getByRole("checkbox", { name: `Viewed ${next.path}` })
      .closest<HTMLElement>("[data-diff-file]")!;
    const nextHeader = nextSection.querySelector<HTMLElement>(
      "[data-diff-file-header]",
    )!;
    const nextPatch = nextSection.querySelector<HTMLElement>(
      "[data-diff-file-patch]",
    )!;
    nextPatch.scrollLeft = 117;
    const viewed = screen.getByRole("checkbox", {
      name: `Viewed ${current.path}`,
    });
    viewed.focus();

    fireEvent.click(viewed);

    expect(owner.scrollTop).toBe(516);
    expect(owner.scrollLeft).toBe(53);
    expect(navigation.scrollLeft).toBe(81);
    expect(nextPatch.scrollLeft).toBe(117);
    expect(nextHeader).toHaveAttribute("tabindex", "-1");
    expect(nextHeader).toHaveClass(
      "outline-none",
      "focus-visible:ring-3",
      "focus-visible:ring-ring/50",
    );
    expect(nextHeader).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("materializes a virtualized next file before anchoring it", () => {
    const files = Array.from({ length: 21 }, (_, index) =>
      file({ path: `src/file-${String(index + 1).padStart(2, "0")}.ts` }),
    );
    const target = files[20]!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-scroll-owner")) return bounds(50, 450);
        const path = this.querySelector<HTMLElement>(
          "[data-diff-file-name]",
        )?.textContent;
        return path === target.path ? bounds(310, 410) : bounds(0, 0);
      },
    );

    const view = render(
      <div data-scroll-owner="" style={{ height: 400, overflowY: "auto" }}>
        <ControlledPullDiff data={diff({ files })} />
      </div>,
    );
    const owner = view.container.querySelector<HTMLElement>(
      "[data-scroll-owner]",
    )!;
    Object.defineProperties(owner, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    owner.scrollTop = 200;
    expect(
      screen.queryByRole("checkbox", { name: `Viewed ${target.path}` }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: `Viewed ${files[19]!.path}`,
      }),
    );

    expect(
      screen.getByRole("checkbox", { name: `Viewed ${target.path}` }),
    ).toBeInTheDocument();
    expect(owner.scrollTop).toBe(460);
    expect(
      screen
        .getByRole("checkbox", { name: `Viewed ${target.path}` })
        .closest("[data-diff-file]")
        ?.querySelector("[data-diff-file-header]"),
    ).toHaveFocus();
  });

  it("anchors the collapsed current header for the last file and never scrolls when unchecking", () => {
    const only = file({ path: "src/only.ts" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-scroll-owner")) return bounds(100, 500);
        if (this.hasAttribute("data-test-sticky")) return bounds(100, 145);
        if (this.hasAttribute("data-diff-file")) return bounds(215, 255);
        return bounds(0, 0);
      },
    );

    const view = render(
      <div data-scroll-owner="" style={{ height: 400, overflowY: "auto" }}>
        <div
          className="sticky"
          data-test-sticky=""
          style={{ position: "sticky", top: 0 }}
        />
        <ControlledPullDiff data={diff({ files: [only] })} />
      </div>,
    );
    const owner = view.container.querySelector<HTMLElement>(
      "[data-scroll-owner]",
    )!;
    Object.defineProperties(owner, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    owner.scrollTop = 400;
    const viewed = screen.getByRole("checkbox", {
      name: `Viewed ${only.path}`,
    });
    const currentHeader = viewed
      .closest("[data-diff-file]")
      ?.querySelector("[data-diff-file-header]");

    fireEvent.click(viewed);

    expect(owner.scrollTop).toBe(470);
    expect(currentHeader).toHaveFocus();

    owner.scrollTop = 333;
    fireEvent.click(viewed);

    expect(owner.scrollTop).toBe(333);
  });

  it("anchors an already-viewed next file in a read-only commit diff without review mutations", () => {
    const current = file({ path: "a/current.ts" });
    const next = file({ path: "b/next.ts" });
    const clearReviewRetry = vi.fn();
    const startRun = vi.fn(async () => acceptedReviewRun());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-scroll-owner")) return bounds(40, 440);
        const path = this.querySelector<HTMLElement>(
          "[data-diff-file-name]",
        )?.textContent;
        return path === next.path ? bounds(220, 260) : bounds(0, 0);
      },
    );

    const data = commitDiff({ files: [next, current] });
    const view = render(
      <div data-scroll-owner="" style={{ height: 400, overflowY: "auto" }}>
        <ControlledPullDiff
          clearReviewRetry={clearReviewRetry}
          data={data}
          initialViewed={[next.path]}
          readOnly
          startRun={startRun}
        />
      </div>,
    );
    const owner = view.container.querySelector<HTMLElement>(
      "[data-scroll-owner]",
    )!;
    Object.defineProperties(owner, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    owner.scrollTop = 100;

    fireEvent.click(
      screen.getByRole("checkbox", { name: `Viewed ${current.path}` }),
    );

    expect(owner.scrollTop).toBe(280);
    const nextViewed = screen.getByRole("checkbox", {
      name: `Viewed ${next.path}`,
    });
    expect(nextViewed).toBeChecked();
    expect(
      nextViewed
        .closest("[data-diff-file]")
        ?.querySelector("[data-diff-file-header]"),
    ).toHaveFocus();
    expect(clearReviewRetry).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("cancels a pending viewed anchor when the diff revision changes", () => {
    const first = file({ path: "src/first.ts" });
    const next = file({ path: "src/next.ts" });
    const toggleViewed = vi.fn();
    const data = diff({ files: [first, next] });
    const view = render(
      <PullDiff
        clearReviewRetry={defaultClearReviewRetry}
        diff={data}
        pull={pullFor(data)}
        run={IDLE_RUN_STATE}
        startRun={defaultStartRun}
        toggleViewed={toggleViewed}
        viewed={new Set()}
      />,
    );
    const scrolling = (document.scrollingElement ??
      document.documentElement) as HTMLElement;
    scrolling.scrollTop = 271;

    fireEvent.click(
      screen.getByRole("checkbox", { name: `Viewed ${first.path}` }),
    );
    const replacement = diff({
      files: [first, next],
      headRefOid: "dddddddddddddddddddddddddddddddddddddddd",
    });
    view.rerender(
      <PullDiff
        clearReviewRetry={defaultClearReviewRetry}
        diff={replacement}
        pull={pullFor(replacement)}
        run={IDLE_RUN_STATE}
        startRun={defaultStartRun}
        toggleViewed={toggleViewed}
        viewed={new Set([first.path])}
      />,
    );

    expect(scrolling.scrollTop).toBe(271);
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
    fireEvent.click(screen.getByRole("button", { name: /^second\.ts/ }));

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
      screen.getByRole("button", { name: /^file-45\.ts/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Viewed src/file-45.ts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show more changed files. 20 of 45 shown.",
      }),
    ).toHaveTextContent("Show 20 more files");

    fireEvent.click(screen.getByRole("button", { name: /^file-45\.ts/ }));

    const checkbox = screen.getByRole("checkbox", {
      name: "Viewed src/file-45.ts",
    });
    const navigation = screen.getByRole("button", {
      name: /^file-45\.ts/,
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

  it("restores controlled diff continuity without scrolling the page during hydration", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const files = Array.from({ length: 21 }, (_, index) =>
      file({ path: `src/file-${index + 1}.ts` }),
    );
    const data = diff({ files });
    const { container } = render(<PersistentPullDiff data={data} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show more changed files. 20 of 21 shown.",
      }),
    );
    const fileButton = screen.getByRole("button", {
      name: /^file-21\.ts/,
    });
    fireEvent.click(fileButton);
    const selectedFile = screen
      .getByRole("checkbox", { name: "Viewed src/file-21.ts" })
      .closest<HTMLElement>("[data-diff-file]")!;
    fireEvent.click(
      within(selectedFile).getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this unsaved feedback." },
    });

    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    navigation.scrollLeft = 84;
    fireEvent.scroll(navigation);
    const patch = selectedFile.querySelector<HTMLElement>(
      "[data-diff-file-patch]",
    )!;
    patch.scrollLeft = 132;
    fireEvent.scroll(patch);

    expect(fileButton).toHaveAttribute(
      "data-pull-focus-token",
      "file:src/file-21.ts",
    );
    expect(
      within(selectedFile).getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    ).toHaveAttribute(
      "data-pull-focus-token",
      "feedback:src/file-21.ts:RIGHT:2",
    );
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "data-pull-focus-token",
      "feedback-composer",
    );
    expect(
      screen.getByRole("button", { name: "Run review fix" }),
    ).toHaveAttribute("data-pull-focus-token", "feedback-submit");
    expect(
      screen.getByRole("checkbox", { name: "Viewed src/file-21.ts" }),
    ).toHaveAttribute("data-pull-focus-token", "viewed:src/file-21.ts");

    const scrollCallsBeforeHydration = scrollIntoView.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Toggle diff" }));
    expect(
      screen.queryByRole("region", {
        name: "Files changed for appwrite/cloud pull request 101",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle diff" }));

    expect(
      screen.getByRole("button", { name: /^file-21\.ts/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox")).toHaveValue(
      "Keep this unsaved feedback.",
    );
    expect(
      screen.queryByRole("button", {
        name: /Show more changed files/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Changed files" }).scrollLeft,
    ).toBe(84);
    const restoredFile = screen
      .getByRole("checkbox", { name: "Viewed src/file-21.ts" })
      .closest<HTMLElement>("[data-diff-file]")!;
    expect(
      restoredFile.querySelector<HTMLElement>("[data-diff-file-patch]")
        ?.scrollLeft,
    ).toBe(132);
    expect(container.querySelectorAll("[data-comment-selected]")).toHaveLength(
      1,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(scrollCallsBeforeHydration);
  });

  it("keeps outside focus when a persisted composer unmounts and remounts", () => {
    render(<PersistentPullDiff data={diff()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this draft across the move." },
    });

    const toggle = screen.getByRole("button", { name: "Toggle diff" });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(toggle).toHaveFocus();
    expect(screen.getByRole("textbox")).toHaveValue(
      "Keep this draft across the move.",
    );
  });

  it("coalesces scroll persistence and flushes the latest offsets", () => {
    let frame: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frame = callback;
        return 42;
      });
    const onPersistenceChange = vi.fn();
    const data = diff();
    const persistence = createPullDiffPersistence(data);
    const view = render(
      <ControlledPullDiff
        data={data}
        onPersistenceChange={onPersistenceChange}
        persistence={persistence}
      />,
    );
    const navigation = screen.getByRole("navigation", {
      name: "Changed files",
    });
    const patch = view.container.querySelector<HTMLElement>(
      "[data-diff-file-patch]",
    )!;

    navigation.scrollLeft = 12;
    fireEvent.scroll(navigation);
    navigation.scrollLeft = 48;
    navigation.scrollTop = 32;
    fireEvent.scroll(navigation);
    patch.scrollLeft = 27;
    fireEvent.scroll(patch);
    patch.scrollLeft = 91;
    fireEvent.scroll(patch);

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(onPersistenceChange).not.toHaveBeenCalled();
    act(() => frame?.(0));
    expect(onPersistenceChange).toHaveBeenCalledOnce();
    expect(onPersistenceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        navigationScrollLeft: 48,
        navigationScrollTop: 32,
        patchScrollLeft: { "src/readiness.ts": 91 },
      }),
    );

    navigation.scrollLeft = 73;
    fireEvent.scroll(navigation);
    view.unmount();
    expect(onPersistenceChange).toHaveBeenCalledTimes(2);
    expect(onPersistenceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ navigationScrollLeft: 73 }),
    );
  });

  it("normalizes stale persistence to the current diff boundary", () => {
    const data = diff();
    const stale: PullDiffPersistence = {
      collapsedDirectories: ["missing", "src", "src"],
      draft: "This draft no longer has a valid anchor.",
      navigationScrollLeft: Number.NaN,
      navigationScrollTop: -50,
      navigationVisible: "yes" as unknown as boolean,
      navigationWidth: Number.POSITIVE_INFINITY,
      patchScrollLeft: {
        "missing/file.ts": 120,
        "src/readiness.ts": -10,
      },
      selectedPath: "missing/file.ts",
      selection: {
        end: {
          hunkIndex: 0,
          line: 999,
          lineIndex: 999,
          path: "missing/file.ts",
          side: "RIGHT",
        },
        origin: {
          hunkIndex: 0,
          line: 999,
          lineIndex: 999,
          path: "missing/file.ts",
          side: "RIGHT",
        },
        start: {
          hunkIndex: 0,
          line: 999,
          lineIndex: 999,
          path: "missing/file.ts",
          side: "RIGHT",
        },
      },
      visibleCount: 999,
    };

    expect(normalizePullDiffPersistence(data, stale)).toEqual({
      collapsedDirectories: ["src"],
      draft: "",
      navigationScrollLeft: 0,
      navigationScrollTop: 0,
      navigationVisible: true,
      navigationWidth: 224,
      patchScrollLeft: { "src/readiness.ts": 0 },
      selectedPath: "src/readiness.ts",
      selection: null,
      visibleCount: 1,
    });
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
    const buttons = [
      ...navigation.querySelectorAll<HTMLButtonElement>(
        "button[data-file-index]",
      ),
    ];
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
    fireEvent.click(screen.getByRole("button", { name: /^file-45\.ts/ }));
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
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("new.ts")).toBeInTheDocument();
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

  it("uses Codex terminology for gutter labels, the composer, and accepted feedback", async () => {
    const startRun = vi.fn(async () => acceptedReviewRun());
    render(
      <ControlledPullDiff agent="codex" data={diff()} startRun={startRun} />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Codex feedback on new line 2",
      }),
    );

    const input = screen.getByRole("textbox", {
      name: "Codex feedback on new line 2",
    });
    expect(input).toHaveAttribute("placeholder", "Tell Codex what to change…");
    fireEvent.change(input, {
      target: { value: "Apply this with Codex." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(
      await screen.findByText(
        "Codex is addressing this feedback, then will commit and push it to the existing pull request.",
      ),
    ).toBeInTheDocument();
    expect(startRun).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ agent: expect.anything() }),
    );
  });

  it("keeps active review feedback bound to its snapshotted agent when the selector changes", () => {
    const active = runningReviewState("review-attempt-claude", "claude");
    const view = render(
      <ControlledPullDiff agent="claude" data={diff()} run={active} />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    expect(
      screen.getByRole("textbox", {
        name: "Claude feedback on new line 2",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Another Claude Code run is already active for this pull request/,
      ),
    ).toBeInTheDocument();

    view.rerender(
      <ControlledPullDiff agent="codex" data={diff()} run={active} />,
    );

    expect(
      screen.getByRole("textbox", {
        name: "Claude feedback on new line 2",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", {
        name: "Codex feedback on new line 2",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Another Claude Code run is already active for this pull request/,
      ),
    ).toBeInTheDocument();
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
        draft: "Please cover the transition.",
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

  it("keeps completion promises presentation-neutral and clears only from authoritative run state", async () => {
    const completion = deferred<RunTerminalStatus>();
    const startRun = vi.fn(async () => acceptedReviewRun(completion.promise));
    const view = renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Finish this exact fix." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(await screen.findByText("Review fix started")).toBeInTheDocument();
    expect(
      view.container.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(1);

    await act(async () => completion.resolve("completed"));

    expect(screen.getByText("Review fix started")).toBeInTheDocument();
    expect(
      view.container.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(1);

    view.rerender(
      <ControlledPullDiff
        data={diff()}
        run={runningReviewState()}
        startRun={startRun}
      />,
    );

    expect(screen.queryByText("Review fix started")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      view.container.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(0);

    view.rerender(
      <ControlledPullDiff
        data={diff()}
        run={IDLE_RUN_STATE}
        startRun={startRun}
      />,
    );

    expect(
      screen.getByText("Claude feedback selection cleared."),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "failed",
      "The review fix failed. Review the Claude output, then retry this feedback.",
    ],
    [
      "cancelled",
      "The review fix was cancelled. Retry this feedback when you are ready.",
    ],
    [
      "limited",
      "The review fix reached its run limit. Review the Claude output, then retry this feedback.",
    ],
  ] as const)(
    "restores the exact submitted draft and selection when completion is %s",
    async (status, message) => {
      const completion = deferred<RunTerminalStatus>();
      const startRun = vi.fn(async () => acceptedReviewRun(completion.promise));
      const view = renderPullDiff(diff(), [], startRun);
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
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "  Keep this exact retry draft.  " },
      });
      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));
      await screen.findByText("Review fix started");

      view.rerender(
        <ControlledPullDiff
          data={diff()}
          run={retryReviewState(status, "  Keep this exact retry draft.  ", {
            body: "Keep this exact retry draft.",
            line: 2,
            path: "src/readiness.ts",
            side: "RIGHT",
            startLine: 1,
            startSide: "RIGHT",
          })}
          startRun={startRun}
        />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(
        screen.getByRole("textbox", {
          name: "Claude feedback on new lines 1–2",
        }),
      ).toHaveValue("  Keep this exact retry draft.  ");
      expect(
        view.container.querySelectorAll("[data-comment-selected]"),
      ).toHaveLength(2);
      expect(
        screen.getByRole("button", { name: "Run review fix" }),
      ).toBeEnabled();
      expect(startRun).toHaveBeenCalledOnce();
    },
  );

  it("keeps accepted-equivalent feedback editable with an informational outcome", async () => {
    const startRun = vi.fn(
      async (): Promise<RunStartOutcome> => ({
        code: "auto_triggers_running",
        kind: "accepted-equivalent",
        message: "This feedback is already assigned to the active run.",
        source: "review",
      }),
    );
    const view = renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this informational draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    const information = await screen.findByText(
      "This feedback is already assigned to the active run.",
    );
    expect(information).toHaveAttribute("role", "status");
    expect(screen.queryByText("Review fix started")).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", {
        name: "Claude feedback on new line 2",
      }),
    ).toHaveValue("Keep this informational draft.");
    expect(
      view.container.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(1);
  });

  it("ignores old and current completion promises until the state owner publishes the retry", async () => {
    const firstCompletion = deferred<RunTerminalStatus>();
    const secondCompletion = deferred<RunTerminalStatus>();
    const startRun = vi
      .fn<() => Promise<RunStartOutcome>>()
      .mockResolvedValueOnce(acceptedReviewRun(firstCompletion.promise))
      .mockResolvedValueOnce(acceptedReviewRun(secondCompletion.promise));
    const view = renderPullDiff(diff(), [], startRun);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Old feedback." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));
    await screen.findByText("Review fix started");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 2",
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "New feedback." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));
    await screen.findByText("Review fix started");

    await act(async () => firstCompletion.resolve("completed"));

    expect(screen.getByText("Review fix started")).toBeInTheDocument();
    expect(
      view.container.querySelectorAll("[data-comment-selected]"),
    ).toHaveLength(1);
    expect(startRun).toHaveBeenCalledTimes(2);

    await act(async () => secondCompletion.resolve("failed"));
    expect(screen.getByText("Review fix started")).toBeInTheDocument();

    view.rerender(
      <ControlledPullDiff
        data={diff()}
        run={retryReviewState(
          "failed",
          "New feedback.",
          {
            body: "New feedback.",
            line: 2,
            path: "src/readiness.ts",
            side: "RIGHT",
          },
          "review-attempt-2",
        )}
        startRun={startRun}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("New feedback.");
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
      draft: "  Preserve the previous behavior.  ",
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

  it("keeps preflight failures editable with the precise error and allows an immediate retry", async () => {
    const startRun = vi
      .fn<() => Promise<RunStartOutcome>>()
      .mockResolvedValueOnce({
        code: "workspace_head_mismatch",
        kind: "failed",
        message:
          "No clean worktree is checked out at the current pull request head.",
        source: "review",
      })
      .mockResolvedValueOnce(acceptedReviewRun());
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
      "No clean worktree is checked out at the current pull request head.",
    );
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("Keep editing this.");
    expect(
      screen.getByRole("button", { name: "Run review fix" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

    expect(await screen.findByText("Review fix started")).toBeInTheDocument();
    expect(startRun).toHaveBeenCalledTimes(2);
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

  it("shows truthful preparation state and suppresses duplicate starts without warning about itself", async () => {
    let resolve!: (value: RunStartOutcome) => void;
    const pending = new Promise<RunStartOutcome>((promiseResolve) => {
      resolve = promiseResolve;
    });
    const startRun = vi.fn(() => pending);
    const view = renderPullDiff(diff(), [], startRun);
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
    expect(
      screen.getByRole("button", { name: "Preparing review fix" }),
    ).toBeDisabled();
    view.rerender(
      <ControlledPullDiff
        data={diff()}
        run={{
          ...IDLE_RUN_STATE,
          source: "review",
          status: "preparing",
        }}
        startRun={startRun}
      />,
    );
    expect(
      screen.queryByText(/Another Claude Code run is already active/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preparing review fix" }),
    ).toBeDisabled();
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
      screen.getByText(/Another Claude Code run is already active/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run review fix" }),
    ).toBeDisabled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("renders a deterministic directory tree and persists collapsed folders", () => {
    const data = diff({
      files: [
        file({ path: "src/z.ts" }),
        file({ path: "docs/readme.md" }),
        file({ path: "src/core/a.ts" }),
      ],
    });
    const { container } = render(<PersistentPullDiff data={data} />);

    const tree = screen.getByRole("tree");
    const directories = [
      ...tree.querySelectorAll<HTMLButtonElement>("button[data-directory]"),
    ];
    expect(directories.map(({ dataset }) => dataset.directory)).toEqual([
      "docs",
      "src",
      "src/core",
    ]);
    expect(within(tree).getByText("readme.md")).toBeInTheDocument();
    expect(within(tree).getByText("z.ts")).toBeInTheDocument();
    expect(within(tree).getByText("a.ts")).toBeInTheDocument();
    expect(within(tree).queryByText("src/core/a.ts")).not.toBeInTheDocument();
    const treeOrder = [
      ...tree.querySelectorAll<HTMLButtonElement>("button[data-file-path]"),
    ].map(({ dataset }) => dataset.filePath);
    const cardOrder = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-file-name]"),
    ].map((name) => name.textContent);
    expect(treeOrder).toEqual(["docs/readme.md", "src/core/a.ts", "src/z.ts"]);
    expect(cardOrder).toEqual(treeOrder);

    fireEvent.click(screen.getByRole("button", { name: /^src$/ }));
    expect(
      screen.queryByRole("button", { name: /^a\.ts/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle diff" }));
    expect(
      screen
        .getByRole("button", { name: /^src$/ })
        .closest('[role="treeitem"]'),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the file pane visible and resizable without visibility controls", () => {
    const { container } = render(<PersistentPullDiff data={diff()} />);
    const separator = screen.getByRole("separator", {
      name: "Resize changed files pane",
    });
    const pane = separator.previousElementSibling as HTMLElement;

    expect(pane).toHaveAttribute("data-diff-navigation-pane");
    expect(
      screen.getByRole("navigation", { name: "Changed files" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Hide|Show) files$/ }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector("[data-diff-navigation-mobile-toggle]"),
    ).not.toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-valuenow", "224");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "240");
    fireEvent.pointerDown(separator, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 140, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 140, pointerId: 7 });
    expect(separator).toHaveAttribute("aria-valuenow", "280");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "420");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "420");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "176");
    fireEvent.pointerDown(separator, { clientX: 100, pointerId: 8 });
    fireEvent.pointerMove(separator, { clientX: 1000, pointerId: 8 });
    fireEvent.pointerUp(separator, { clientX: 1000, pointerId: 8 });
    expect(separator).toHaveAttribute("aria-valuenow", "420");

    fireEvent.keyDown(separator, { key: " " });
    expect(
      screen.getByRole("navigation", { name: "Changed files" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(
      screen.getByRole("navigation", { name: "Changed files" }),
    ).toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-valuenow", "420");
  });

  it("preserves the preferred desktop file width while the split layout is inactive", () => {
    let splitLayout = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(
        (query: string): MediaQueryList =>
          ({
            addEventListener: vi.fn(),
            addListener: vi.fn(),
            dispatchEvent: vi.fn(),
            matches: query === "(min-width: 64rem)" && splitLayout,
            media: query,
            onchange: null,
            removeEventListener: vi.fn(),
            removeListener: vi.fn(),
          }) as MediaQueryList,
      ),
    );
    let layoutWidth = 420;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: layoutWidth,
          toJSON: () => ({}),
          top: 0,
          width: this.hasAttribute("data-diff-layout") ? layoutWidth : 0,
          x: 0,
          y: 0,
        };
      },
    );
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    const data = diff();
    const onPersistenceChange = vi.fn();
    render(
      <ControlledPullDiff
        data={data}
        onPersistenceChange={onPersistenceChange}
        persistence={{
          ...createPullDiffPersistence(data),
          navigationWidth: 360,
        }}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize changed files pane",
    });
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    act(() => resize?.([], {} as ResizeObserver));
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(onPersistenceChange).not.toHaveBeenCalled();

    splitLayout = true;
    layoutWidth = 900;
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(onPersistenceChange).not.toHaveBeenCalled();
  });

  it("places the composer directly after the selected range end", () => {
    const { container } = renderPullDiff();
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

    const composer = container.querySelector<HTMLElement>(
      "[data-inline-review-composer]",
    )!;
    expect(composer).toBeInTheDocument();
    expect(composer.closest("[data-diff-patch-canvas]")).toBeInTheDocument();
    expect(composer.previousElementSibling).toHaveAttribute(
      "data-comment-selected",
      "",
    );
    expect(composer).toContainElement(screen.getByRole("textbox"));
  });

  it("matches the inline composer to the visible patch width instead of the wide canvas", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-diff-file-patch") ? 612 : 0;
      },
    );
    const { container } = renderPullDiff(
      diff({
        files: [
          file({
            hunks: [
              {
                header: "@@ -1 +1 @@ wide",
                lines: [
                  {
                    content: `render("${"wide code ".repeat(80)}")`,
                    kind: "addition",
                    newLine: 1,
                    oldLine: null,
                  },
                ],
                newLines: 1,
                newStart: 1,
                oldLines: 0,
                oldStart: 1,
              },
            ],
          }),
        ],
      }),
    );
    const patch = container.querySelector<HTMLElement>(
      "[data-diff-file-patch]",
    )!;
    patch.scrollLeft = 480;
    fireEvent.scroll(patch);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );

    const composer = container.querySelector<HTMLElement>(
      "[data-inline-review-composer]",
    )!;
    expect(composer).toHaveStyle({
      maxWidth: "612px",
      width: "612px",
    });
    expect(composer).toHaveClass("sticky", "left-0", "min-w-0");
    expect(composer).not.toHaveClass("w-full", "min-w-full");
    expect(composer.querySelector("form")).toHaveClass(
      "box-border",
      "w-full",
      "min-w-0",
    );
    expect(screen.getByRole("textbox")).toHaveClass(
      "box-border",
      "w-full",
      "min-w-0",
      "max-w-full",
    );
  });

  it("remeasures the inline composer when its patch viewport is resized", () => {
    let width = 640;
    const resize = new Map<Element, () => void>();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-diff-file-patch") ? width : 0;
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        disconnect() {}

        observe(target: Element) {
          resize.set(target, () =>
            this.callback([], this as unknown as ResizeObserver),
          );
        }

        unobserve(target: Element) {
          resize.delete(target);
        }
      },
    );

    const { container } = renderPullDiff();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    const patch = container.querySelector<HTMLElement>(
      "[data-diff-file-patch]",
    )!;
    const composer = container.querySelector<HTMLElement>(
      "[data-inline-review-composer]",
    )!;
    expect(composer).toHaveStyle({ maxWidth: "640px", width: "640px" });

    width = 516;
    act(() => resize.get(patch)?.());

    expect(composer).toHaveStyle({ maxWidth: "516px", width: "516px" });
  });

  it("remeasures the inline composer on window resize without ResizeObserver", () => {
    let width = 700;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-diff-file-patch") ? width : 0;
      },
    );

    const { container } = renderPullDiff();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Give Claude feedback on new line 1",
      }),
    );
    const composer = container.querySelector<HTMLElement>(
      "[data-inline-review-composer]",
    )!;
    expect(composer).toHaveStyle({ maxWidth: "700px", width: "700px" });

    width = 548;
    fireEvent(window, new Event("resize"));

    expect(composer).toHaveStyle({ maxWidth: "548px", width: "548px" });
  });

  it("uses a full-width shared patch canvas and a dark checked viewed control", () => {
    const { container } = renderPullDiff();
    expect(container.querySelector("[data-diff-patch-canvas]")).toHaveClass(
      "w-max",
      "min-w-full",
    );
    for (const line of container.querySelectorAll("[data-line-kind]")) {
      expect(line).toHaveClass("w-full", "min-w-full");
    }

    const viewed = screen.getByRole("checkbox", {
      name: "Viewed src/readiness.ts",
    });
    expect(viewed).toHaveClass(
      "dark:data-[state=checked]:bg-primary",
      "dark:data-[state=checked]:text-primary-foreground",
    );
  });

  it("supports a read-only diff without exposing review controls", () => {
    const { container } = render(<ControlledPullDiff data={diff()} readOnly />);
    expect(
      screen.queryByRole("button", {
        name: /Give Claude feedback/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-line-kind="addition"]'),
    ).toBeInTheDocument();
  });

  it("keeps main-diff review retry state isolated from a read-only commit diff", () => {
    const data = commitDiff();
    const clearReviewRetry = vi.fn();
    const onPersistenceChange = vi.fn();
    const anchor = {
      hunkIndex: 0,
      line: 2,
      lineIndex: 2,
      path: "src/readiness.ts",
      side: "RIGHT" as const,
    };
    const persistence: PullDiffPersistence = {
      ...createPullDiffPersistence(data),
      draft: "Keep the main diff draft untouched.",
      selection: { end: anchor, origin: anchor, start: anchor },
    };
    const run = retryReviewState("failed", "Retry this main-diff feedback.", {
      body: "Retry this main-diff feedback.",
      line: 99,
      path: "src/readiness.ts",
      side: "RIGHT",
    });

    const view = render(
      <ControlledPullDiff
        clearReviewRetry={clearReviewRetry}
        data={data}
        onPersistenceChange={onPersistenceChange}
        persistence={persistence}
        readOnly
        run={run}
      />,
    );

    expect(clearReviewRetry).not.toHaveBeenCalled();
    expect(onPersistenceChange).not.toHaveBeenCalled();
    const viewed = screen.getByRole("checkbox", {
      name: "Viewed src/readiness.ts",
    });
    fireEvent.click(viewed);
    expect(viewed).toBeChecked();
    expect(clearReviewRetry).not.toHaveBeenCalled();
    expect(onPersistenceChange).not.toHaveBeenCalled();

    view.rerender(
      <ControlledPullDiff
        clearReviewRetry={clearReviewRetry}
        data={data}
        onPersistenceChange={onPersistenceChange}
        persistence={persistence}
        readOnly
        run={runningReviewState("main-review-attempt")}
      />,
    );
    expect(clearReviewRetry).not.toHaveBeenCalled();
    expect(onPersistenceChange).not.toHaveBeenCalled();
  });
});
