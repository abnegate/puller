import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileCode2,
  FileWarning,
  FolderClosed,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  Fragment,
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  isRunActive,
  isRunPreparing,
  type PullRuns,
  type ReviewRetryContext,
  type RunStartOutcome,
  type RunState,
  type RunTerminalStatus,
} from "../runs";
import {
  highlightFile,
  type HighlightedFile,
  type SyntaxToken,
} from "../syntax";
import type {
  Agent,
  DiffLineKind,
  PullDiff as PullDiffData,
  PullDiffFile,
  PullDiffHunk,
  PullDiffLine,
  PullReadiness,
  ReviewCommentSide,
} from "../types";

export type PullDiffProps = {
  agent?: Agent;
  clearReviewRetry: PullRuns["clearReviewRetry"];
  diff: PullDiffData;
  onPersistenceChange?: (persistence: PullDiffPersistence) => void;
  persistence?: PullDiffPersistence;
  pull: PullReadiness;
  readOnly?: boolean;
  run: RunState;
  startRun: PullRuns["start"];
  toggleViewed: (path: string) => void;
  viewed: ReadonlySet<string>;
};

const FILE_BATCH_SIZE = 20;

type FeedbackAgentCopy = {
  feedback: string;
  name: string;
  run: string;
};

const feedbackAgentCopy: Record<Agent, FeedbackAgentCopy> = {
  claude: {
    feedback: "Claude feedback",
    name: "Claude",
    run: "Claude Code run",
  },
  codex: {
    feedback: "Codex feedback",
    name: "Codex",
    run: "Codex run",
  },
};

export type PullDiffCommentAnchor = {
  hunkIndex: number;
  line: number;
  lineIndex: number;
  path: string;
  side: ReviewCommentSide;
};

export type PullDiffCommentSelection = {
  end: PullDiffCommentAnchor;
  origin: PullDiffCommentAnchor;
  start: PullDiffCommentAnchor;
};

export type PullDiffPersistence = Readonly<{
  collapsedDirectories: readonly string[];
  draft: string;
  navigationScrollLeft: number;
  navigationScrollTop: number;
  navigationVisible: boolean;
  navigationWidth: number;
  patchScrollLeft: Readonly<Record<string, number>>;
  selectedPath: string | null;
  selection: PullDiffCommentSelection | null;
  visibleCount: number;
}>;

const NAVIGATION_DEFAULT_WIDTH = 224;
const NAVIGATION_MAX_WIDTH = 420;
const NAVIGATION_MIN_WIDTH = 176;
const SPLIT_LAYOUT_QUERY = "(min-width: 64rem)";

const splitLayoutActive = (): boolean =>
  typeof window.matchMedia !== "function" ||
  window.matchMedia(SPLIT_LAYOUT_QUERY).matches;

type ViewedScroll = {
  diff: PullDiffData;
  owner: HTMLElement;
  sourcePath: string;
  targetPath: string | null;
};

const verticalScrollOwner = (node: HTMLElement): HTMLElement => {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    const overflow = window.getComputedStyle(ancestor).overflowY;
    if (
      /^(auto|overlay|scroll)$/.test(overflow) &&
      ancestor.scrollHeight > ancestor.clientHeight
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }

  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
};

const scrollViewportTop = (owner: HTMLElement): number =>
  owner === document.scrollingElement || owner === document.documentElement
    ? 0
    : owner.getBoundingClientRect().top + owner.clientTop;

const stickyInset = (
  owner: HTMLElement,
  diffRoot: HTMLElement | null,
  anchor: DOMRect,
): number => {
  const top = scrollViewportTop(owner);
  const bottom =
    owner === document.scrollingElement || owner === document.documentElement
      ? window.innerHeight
      : owner.getBoundingClientRect().bottom - owner.clientTop;
  let inset = 0;

  for (const candidate of document.querySelectorAll<HTMLElement>(
    ".fixed, .sticky, [data-sticky]",
  )) {
    if (diffRoot?.contains(candidate)) continue;
    const position = window.getComputedStyle(candidate).position;
    if (
      position !== "fixed" &&
      position !== "sticky" &&
      !candidate.classList.contains("fixed") &&
      !candidate.classList.contains("sticky")
    ) {
      continue;
    }

    const bounds = candidate.getBoundingClientRect();
    if (
      bounds.height <= 0 ||
      bounds.top > top + 1 ||
      bounds.bottom <= top ||
      bounds.top >= bottom ||
      bounds.right <= anchor.left ||
      bounds.left >= anchor.right
    ) {
      continue;
    }
    inset = Math.max(inset, Math.min(bottom, bounds.bottom) - top);
  }

  return inset;
};

type CommentAnchor = PullDiffCommentAnchor;
type CommentSelection = PullDiffCommentSelection;

type ComposerState =
  | {
      kind: "editing";
      message: string | null;
      tone: "error" | "information" | null;
    }
  | { kind: "submitting" }
  | { kind: "started"; message: string };

const lineStyles: Record<DiffLineKind, string> = {
  addition:
    "bg-emerald-50 text-foreground dark:bg-emerald-950/35 [&>[data-gutter]]:bg-emerald-100 [&>[data-gutter]]:text-emerald-800 dark:[&>[data-gutter]]:bg-emerald-950/70 dark:[&>[data-gutter]]:text-emerald-300",
  context: "bg-card text-foreground [&>[data-gutter]]:text-muted-foreground",
  deletion:
    "bg-red-50 text-foreground dark:bg-red-950/35 [&>[data-gutter]]:bg-red-100 [&>[data-gutter]]:text-red-800 dark:[&>[data-gutter]]:bg-red-950/70 dark:[&>[data-gutter]]:text-red-300",
  meta: "bg-muted/45 text-muted-foreground [&>[data-gutter]]:text-muted-foreground",
};

const statusLabels: Record<PullDiffFile["status"], string> = {
  added: "Added",
  changed: "Changed",
  copied: "Copied",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
  unchanged: "Unchanged",
};

const isSafeGitHubUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
};

const lineMarker = (kind: DiffLineKind): string => {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "-";
  return " ";
};

type SyntaxTokenStyle = CSSProperties & {
  "--syntax-dark-font-style": SyntaxToken["darkFontStyle"];
  "--syntax-dark-font-weight": SyntaxToken["darkFontWeight"];
  "--syntax-dark-foreground": string;
  "--syntax-light-font-style": SyntaxToken["lightFontStyle"];
  "--syntax-light-font-weight": SyntaxToken["lightFontWeight"];
  "--syntax-light-foreground": string;
};

const syntaxTokenStyle = (token: SyntaxToken): SyntaxTokenStyle => ({
  "--syntax-dark-font-style": token.darkFontStyle,
  "--syntax-dark-font-weight": token.darkFontWeight,
  "--syntax-dark-foreground": token.darkForeground,
  "--syntax-light-font-style": token.lightFontStyle,
  "--syntax-light-font-weight": token.lightFontWeight,
  "--syntax-light-foreground": token.lightForeground,
});

function SyntaxContent({
  content,
  tokens,
}: {
  content: string;
  tokens: readonly SyntaxToken[] | null;
}) {
  if (tokens === null || tokens.length === 0) {
    return <span data-syntax-content="">{content || "\u00a0"}</span>;
  }

  return (
    <span data-syntax-content="">
      {tokens.map((token, index) => (
        <span
          data-syntax-dark-font-style={token.darkFontStyle}
          data-syntax-dark-font-weight={token.darkFontWeight}
          data-syntax-dark-foreground={token.darkForeground}
          data-syntax-light-font-style={token.lightFontStyle}
          data-syntax-light-font-weight={token.lightFontWeight}
          data-syntax-light-foreground={token.lightForeground}
          data-syntax-token=""
          key={`${index}:${token.content}`}
          style={syntaxTokenStyle(token)}
        >
          {token.content}
        </span>
      ))}
    </span>
  );
}

const anchorFor = (
  file: PullDiffFile,
  hunkIndex: number,
  lineIndex: number,
  line: PullDiffLine,
  side: ReviewCommentSide,
): CommentAnchor | null => {
  const coordinate =
    side === "RIGHT" && (line.kind === "addition" || line.kind === "context")
      ? line.newLine
      : side === "LEFT" && line.kind === "deletion"
        ? line.oldLine
        : null;
  return coordinate === null
    ? null
    : {
        hunkIndex,
        line: coordinate,
        lineIndex,
        path: file.path,
        side,
      };
};

const sideAnchors = (
  file: PullDiffFile,
  hunk: PullDiffHunk,
  hunkIndex: number,
  side: ReviewCommentSide,
): CommentAnchor[] =>
  hunk.lines.flatMap((line, lineIndex) => {
    const anchor = anchorFor(file, hunkIndex, lineIndex, line, side);
    return anchor === null ? [] : [anchor];
  });

const sameAnchorScope = (left: CommentAnchor, right: CommentAnchor): boolean =>
  left.path === right.path &&
  left.hunkIndex === right.hunkIndex &&
  left.side === right.side;

const extendSelection = (
  selection: CommentSelection,
  target: CommentAnchor,
  file: PullDiffFile,
): CommentSelection | null => {
  if (!sameAnchorScope(selection.origin, target)) return null;
  const hunk = file.hunks[target.hunkIndex];
  if (!hunk) return null;
  const anchors = sideAnchors(file, hunk, target.hunkIndex, target.side);
  const firstIndex = anchors.findIndex(
    (anchor) => anchor.lineIndex === selection.origin.lineIndex,
  );
  const targetIndex = anchors.findIndex(
    (anchor) => anchor.lineIndex === target.lineIndex,
  );
  if (firstIndex < 0 || targetIndex < 0) return null;

  const startIndex = Math.min(firstIndex, targetIndex);
  const endIndex = Math.max(firstIndex, targetIndex);
  const range = anchors.slice(startIndex, endIndex + 1);
  if (
    range.length === 0 ||
    range.some(
      (anchor, index) =>
        index > 0 && anchor.line !== range[index - 1]!.line + 1,
    )
  ) {
    return null;
  }

  return { start: range[0]!, end: range.at(-1)!, origin: selection.origin };
};

const selectionLabel = (selection: CommentSelection): string => {
  const location = selection.start.side === "RIGHT" ? "new" : "old";
  return selection.start.line === selection.end.line
    ? `${location} line ${selection.start.line}`
    : `${location} lines ${selection.start.line}–${selection.end.line}`;
};

const selectedAnchor = (
  selection: CommentSelection | null,
  anchor: CommentAnchor | null,
): boolean =>
  selection !== null &&
  anchor !== null &&
  sameAnchorScope(selection.start, anchor) &&
  anchor.line >= selection.start.line &&
  anchor.line <= selection.end.line;

const sameAnchor = (left: CommentAnchor, right: CommentAnchor): boolean =>
  left.hunkIndex === right.hunkIndex &&
  left.line === right.line &&
  left.lineIndex === right.lineIndex &&
  left.path === right.path &&
  left.side === right.side;

const sameSelection = (
  left: CommentSelection | null,
  right: CommentSelection | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    sameAnchor(left.start, right.start) &&
    sameAnchor(left.end, right.end) &&
    sameAnchor(left.origin, right.origin));

const validSelection = (
  diff: PullDiffData,
  selection: CommentSelection | null,
): CommentSelection | null => {
  if (selection === null) return null;
  const file = diff.files.find(({ path }) => path === selection.start.path);
  if (
    !file ||
    file.truncated ||
    !sameAnchorScope(selection.start, selection.end) ||
    !sameAnchorScope(selection.start, selection.origin)
  ) {
    return null;
  }

  const hunk = file.hunks[selection.origin.hunkIndex];
  if (!hunk) return null;
  const anchors = sideAnchors(
    file,
    hunk,
    selection.origin.hunkIndex,
    selection.origin.side,
  );
  const origin = anchors.find((anchor) => sameAnchor(anchor, selection.origin));
  const start = anchors.find((anchor) => sameAnchor(anchor, selection.start));
  const end = anchors.find((anchor) => sameAnchor(anchor, selection.end));
  if (!origin || !start || !end) return null;

  const target = sameAnchor(origin, start) ? end : start;
  const restored = extendSelection(
    { end: origin, origin, start: origin },
    target,
    file,
  );
  return sameSelection(restored, selection) ? selection : null;
};

const scrollOffset = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const navigationWidth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(NAVIGATION_MAX_WIDTH, Math.max(NAVIGATION_MIN_WIDTH, value))
    : NAVIGATION_DEFAULT_WIDTH;

type FileTreeDirectory = {
  directories: Map<string, FileTreeDirectory>;
  files: { file: PullDiffFile; index: number }[];
  name: string;
  path: string;
};

const createFileTree = (files: PullDiffFile[]): FileTreeDirectory => {
  const root: FileTreeDirectory = {
    directories: new Map(),
    files: [],
    name: "",
    path: "",
  };

  files.forEach((file, index) => {
    const parts = file.path.split("/");
    parts.pop();
    let directory = root;
    for (const part of parts) {
      const path = directory.path === "" ? part : `${directory.path}/${part}`;
      let child = directory.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [], name: part, path };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ file, index });
  });

  return root;
};

const treeDirectories = (directory: FileTreeDirectory): FileTreeDirectory[] =>
  [...directory.directories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

const treeFiles = (files: PullDiffFile[]): PullDiffFile[] => {
  const ordered: PullDiffFile[] = [];
  const append = (directory: FileTreeDirectory): void => {
    treeDirectories(directory).forEach(append);
    ordered.push(...directory.files.map(({ file }) => file));
  };
  append(createFileTree(files));
  return ordered;
};

const directoriesFor = (diff: PullDiffData): Set<string> => {
  const directories = new Set<string>();
  for (const file of diff.files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return directories;
};

export const createPullDiffPersistence = (
  diff: PullDiffData,
): PullDiffPersistence => ({
  collapsedDirectories: [],
  draft: "",
  navigationScrollLeft: 0,
  navigationScrollTop: 0,
  navigationVisible: true,
  navigationWidth: NAVIGATION_DEFAULT_WIDTH,
  patchScrollLeft: {},
  selectedPath: treeFiles(diff.files)[0]?.path ?? null,
  selection: null,
  visibleCount: Math.min(FILE_BATCH_SIZE, diff.files.length),
});

export const normalizePullDiffPersistence = (
  diff: PullDiffData,
  persistence: PullDiffPersistence,
): PullDiffPersistence => {
  const paths = new Set(diff.files.map(({ path }) => path));
  const directories = directoriesFor(diff);
  const selection = validSelection(diff, persistence.selection);
  const selectedPath = selection
    ? selection.start.path
    : persistence.selectedPath !== null && paths.has(persistence.selectedPath)
      ? persistence.selectedPath
      : (treeFiles(diff.files)[0]?.path ?? null);
  const minimum = Math.min(FILE_BATCH_SIZE, diff.files.length);
  const visibleCount =
    diff.files.length === 0
      ? 0
      : Math.min(
          diff.files.length,
          Math.max(
            minimum,
            Number.isInteger(persistence.visibleCount)
              ? persistence.visibleCount
              : minimum,
          ),
        );
  const patchScrollLeft = Object.fromEntries(
    Object.entries(persistence.patchScrollLeft)
      .filter(([path]) => paths.has(path))
      .map(([path, value]) => [path, scrollOffset(value)]),
  );

  return {
    collapsedDirectories: [
      ...new Set(
        Array.isArray(persistence.collapsedDirectories)
          ? persistence.collapsedDirectories.filter(
              (path): path is string =>
                typeof path === "string" && directories.has(path),
            )
          : [],
      ),
    ].sort(),
    draft: selection === null ? "" : persistence.draft,
    navigationScrollLeft: scrollOffset(persistence.navigationScrollLeft),
    navigationScrollTop: scrollOffset(persistence.navigationScrollTop),
    navigationVisible: true,
    navigationWidth: navigationWidth(persistence.navigationWidth),
    patchScrollLeft,
    selectedPath,
    selection,
    visibleCount,
  };
};

const samePatchScroll = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean => {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([path, value]) => right[path] === value)
  );
};

const samePersistence = (
  left: PullDiffPersistence,
  right: PullDiffPersistence,
): boolean => {
  const leftDirectories = Array.isArray(left.collapsedDirectories)
    ? left.collapsedDirectories
    : [];
  const rightDirectories = Array.isArray(right.collapsedDirectories)
    ? right.collapsedDirectories
    : [];
  return (
    leftDirectories.length === rightDirectories.length &&
    leftDirectories.every((path, index) => path === rightDirectories[index]) &&
    left.draft === right.draft &&
    left.navigationScrollLeft === right.navigationScrollLeft &&
    left.navigationScrollTop === right.navigationScrollTop &&
    left.navigationVisible === right.navigationVisible &&
    left.navigationWidth === right.navigationWidth &&
    left.selectedPath === right.selectedPath &&
    left.visibleCount === right.visibleCount &&
    sameSelection(left.selection, right.selection) &&
    samePatchScroll(left.patchScrollLeft, right.patchScrollLeft)
  );
};

const selectionForRetry = (
  diff: PullDiffData,
  retry: ReviewRetryContext,
): CommentSelection | null => {
  if (
    diff.baseRefOid.toLowerCase() !== retry.baseRefOid.toLowerCase() ||
    diff.headRefOid.toLowerCase() !== retry.headRefOid.toLowerCase()
  ) {
    return null;
  }

  const file = diff.files.find(({ path }) => path === retry.feedback.path);
  if (!file || file.truncated) return null;
  const side = retry.feedback.side;
  const startSide = retry.feedback.startSide ?? side;
  if (startSide !== side) return null;
  const startLine = retry.feedback.startLine ?? retry.feedback.line;
  const endLine = retry.feedback.line;
  if (startLine > endLine) return null;

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const anchors = sideAnchors(file, hunk, hunkIndex, side);
    const startIndex = anchors.findIndex(({ line }) => line === startLine);
    const endIndex = anchors.findIndex(({ line }) => line === endLine);
    if (startIndex < 0 || endIndex < startIndex) continue;
    const range = anchors.slice(startIndex, endIndex + 1);
    if (
      range.length !== endLine - startLine + 1 ||
      range.some(
        (anchor, index) =>
          index > 0 && anchor.line !== range[index - 1]!.line + 1,
      )
    ) {
      continue;
    }

    const start = range[0]!;
    return { end: range.at(-1)!, origin: start, start };
  }

  return null;
};

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return "The review fix could not be started.";
  return (
    error.message.replace(/\s+/g, " ").trim().slice(0, 500) ||
    "The review fix could not be started."
  );
};

const terminalMessage = (
  status: Exclude<RunTerminalStatus, "completed">,
  agent: Agent,
): string => {
  if (status === "cancelled") {
    return "The review fix was cancelled. Retry this feedback when you are ready.";
  }
  if (status === "limited") {
    return `The review fix reached its run limit. Review the ${feedbackAgentCopy[agent].name} output, then retry this feedback.`;
  }
  return `The review fix failed. Review the ${feedbackAgentCopy[agent].name} output, then retry this feedback.`;
};

const FilePlaceholder = memo(function FilePlaceholder({
  file,
}: {
  file: PullDiffFile;
}) {
  let message = "No textual changes to display.";

  if (file.binary) {
    message = "Binary file changed. GitHub does not provide a text patch.";
  } else if (
    (file.status === "renamed" || file.status === "copied") &&
    file.changes === 0
  ) {
    message = "File renamed without textual changes.";
  } else if (file.truncated) {
    message = "The text patch is unavailable or incomplete.";
  }

  return (
    <div className="flex min-h-24 flex-1 items-center justify-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
      <FileWarning aria-hidden="true" className="size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
});

function ReviewComposer({
  agent,
  diff,
  draft,
  focusRequest,
  onCancel,
  onDraftChange,
  pull,
  retryStatus,
  run,
  selection,
  startRun,
}: {
  agent: Agent;
  diff: PullDiffData;
  draft: string;
  focusRequest: number;
  onCancel: () => void;
  onDraftChange: (draft: string) => void;
  pull: PullReadiness;
  retryStatus: Exclude<RunTerminalStatus, "completed"> | null;
  run: RunState;
  selection: CommentSelection;
  startRun: PullRuns["start"];
}) {
  const copy = feedbackAgentCopy[agent];
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const submission = useRef(0);
  const active = isRunActive(run);
  const preparing = isRunPreparing(run);
  const [state, setState] = useState<ComposerState>({
    kind: "editing",
    message: retryStatus === null ? null : terminalMessage(retryStatus, agent),
    tone: retryStatus === null ? null : "error",
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    if (focusRequest === 0) return;
    input.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const submit = async () => {
    if (
      pending.current ||
      active ||
      draft.trim() === "" ||
      state.kind === "started"
    ) {
      return;
    }

    pending.current = true;
    const token = ++submission.current;
    const submittedDraft = draft;
    const submittedSelection: CommentSelection = {
      end: { ...selection.end },
      origin: { ...selection.origin },
      start: { ...selection.start },
    };
    setState({ kind: "submitting" });
    let outcome: RunStartOutcome;
    try {
      outcome = await startRun(pull, {
        draft: submittedDraft,
        expectedBaseRefOid: diff.baseRefOid,
        feedback: {
          body: submittedDraft.trim(),
          line: submittedSelection.end.line,
          path: submittedSelection.start.path,
          side: submittedSelection.start.side,
          ...(submittedSelection.start.line === submittedSelection.end.line
            ? {}
            : {
                startLine: submittedSelection.start.line,
                startSide: submittedSelection.start.side,
              }),
        },
        source: "review",
      });
    } catch (error) {
      if (mounted.current && submission.current === token) {
        onDraftChange(submittedDraft);
        setState({
          kind: "editing",
          message: errorMessage(error),
          tone: "error",
        });
      }
      return;
    } finally {
      if (submission.current === token) pending.current = false;
    }

    if (!mounted.current || submission.current !== token) return;

    if (outcome.kind === "accepted-equivalent") {
      onDraftChange(submittedDraft);
      setState({
        kind: "editing",
        message: outcome.message,
        tone: "information",
      });
      return;
    }

    if (outcome.kind !== "accepted") {
      onDraftChange(submittedDraft);
      setState({
        kind: "editing",
        message: outcome.message,
        tone: "error",
      });
      return;
    }

    setState({
      kind: "started",
      message: `${copy.name} is addressing this feedback, then will commit and push it to the existing pull request.`,
    });
  };

  if (state.kind === "started") {
    return (
      <div
        className="box-border w-full min-w-0 space-y-2 border-t bg-emerald-50/70 px-3 py-3 text-xs dark:bg-emerald-950/25"
        role="status"
      >
        <div className="flex flex-wrap items-center gap-2 text-emerald-800 dark:text-emerald-300">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-medium">Review fix started</span>
          <Button
            className="ml-auto min-h-8"
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            Done
          </Button>
        </div>
        <p className="m-0 text-emerald-800 dark:text-emerald-300">
          {state.message}
        </p>
      </div>
    );
  }

  const submitting = state.kind === "submitting";
  return (
    <form
      className="box-border w-full min-w-0 space-y-2 border-t bg-muted/20 px-3 py-3"
      data-review-fix-composer=""
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <MessageSquare
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
        <label className="font-medium" htmlFor={inputId}>
          {copy.feedback} on {selectionLabel(selection)}
        </label>
        <code className="min-w-0 truncate text-[11px] text-muted-foreground">
          {selection.start.path}
        </code>
      </div>
      <Textarea
        className="box-border w-full min-w-0 max-w-full"
        data-pull-focus-token="feedback-composer"
        disabled={submitting}
        id={inputId}
        onChange={(event) => {
          onDraftChange(event.target.value);
          if (state.kind === "editing" && state.message !== null) {
            setState({ kind: "editing", message: null, tone: null });
          }
        }}
        placeholder={`Tell ${copy.name} what to change…`}
        ref={input}
        required
        rows={3}
        value={draft}
      />
      {state.kind === "editing" && state.message !== null && (
        <p
          className={`m-0 text-xs ${
            state.tone === "information"
              ? "text-muted-foreground"
              : "text-destructive"
          }`}
          role={state.tone === "information" ? "status" : "alert"}
        >
          {state.message}
        </p>
      )}
      {active && !submitting && (
        <p
          className="m-0 text-xs text-amber-700 dark:text-amber-300"
          role="status"
        >
          {preparing
            ? "Another review fix is being prepared for this pull request. Wait for preparation to finish before starting another."
            : `Another ${copy.run} is already active for this pull request. Wait for it to finish before starting another review fix.`}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          data-pull-focus-token="feedback-cancel"
          disabled={submitting}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          data-pull-focus-token="feedback-submit"
          disabled={active || submitting || draft.trim() === ""}
          size="sm"
          type="submit"
        >
          {submitting && (
            <LoaderCircle
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          )}
          {submitting ? "Preparing review fix" : "Run review fix"}
        </Button>
      </div>
    </form>
  );
}

function DiffGutter({
  agent,
  anchor,
  gutter,
  onSelect,
  selected,
  value,
}: {
  agent: Agent;
  anchor: CommentAnchor | null;
  gutter: "new" | "old";
  onSelect: (anchor: CommentAnchor, shift: boolean) => void;
  selected: boolean;
  value: number | null;
}) {
  const classes =
    "block min-h-5 w-full select-none border-r border-foreground/8 px-2 text-right tabular-nums";
  if (anchor === null) {
    return (
      <span
        aria-label={
          value === null
            ? undefined
            : `${gutter === "old" ? "Old" : "New"} line ${value}`
        }
        className={classes}
        data-gutter={gutter}
      >
        {value ?? ""}
      </span>
    );
  }

  return (
    <button
      aria-label={`Give ${feedbackAgentCopy[agent].name} feedback on ${gutter} line ${anchor.line}`}
      aria-pressed={selected}
      className={`${classes} cursor-pointer outline-none hover:bg-blue-200/70 focus-visible:bg-blue-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-blue-900/60 dark:focus-visible:bg-blue-900 ${selected ? "bg-blue-200 text-blue-950 dark:bg-blue-900 dark:text-blue-100" : ""}`}
      data-comment-gutter={gutter}
      data-gutter={gutter}
      data-pull-focus-token={`feedback:${anchor.path}:${anchor.side}:${anchor.line}`}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onSelect(anchor, event.shiftKey)
      }
      title={`Click to give ${feedbackAgentCopy[agent].name} feedback. Shift-click to select a range.`}
      type="button"
    >
      {anchor.line}
    </button>
  );
}

const FilePatch = memo(function FilePatch({
  agent,
  composer,
  file,
  onSelect,
  onScrollLeftChange,
  readOnly,
  scrollLeft,
  selection,
}: {
  agent: Agent;
  composer: ReactNode;
  file: PullDiffFile;
  onSelect: (anchor: CommentAnchor, shift: boolean) => void;
  onScrollLeftChange: (scrollLeft: number) => void;
  readOnly: boolean;
  scrollLeft: number;
  selection: CommentSelection | null;
}) {
  const patch = useRef<HTMLDivElement>(null);
  const syntaxRequest = useRef(0);
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [syntax, setSyntax] = useState<{
    file: PullDiffFile;
    highlighted: HighlightedFile | null;
  } | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const highlighted = syntax?.file === file ? syntax.highlighted : null;

  useEffect(() => {
    const node = patch.current;
    if (node === null || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry?.isIntersecting ?? false),
      { rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    const request = ++syntaxRequest.current;
    const controller = new AbortController();

    void highlightFile(file, controller.signal).then(
      (result) => {
        if (syntaxRequest.current !== request) return;
        setSyntax({ file, highlighted: result });
      },
      () => {
        if (syntaxRequest.current !== request) return;
        setSyntax({ file, highlighted: null });
      },
    );

    return () => {
      controller.abort();
      if (syntaxRequest.current === request) syntaxRequest.current += 1;
    };
  }, [file, nearViewport]);

  useLayoutEffect(() => {
    if (patch.current && patch.current.scrollLeft !== scrollLeft) {
      patch.current.scrollLeft = scrollLeft;
    }
  }, [scrollLeft]);

  useLayoutEffect(() => {
    const node = patch.current;
    if (node === null) return;

    const measure = (): void => {
      const width = node.clientWidth;
      if (width <= 0) return;
      setViewportWidth((current) => (current === width ? current : width));
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  if (file.hunks.length === 0) {
    return <FilePlaceholder file={file} />;
  }

  const composerStyle: CSSProperties | undefined =
    viewportWidth === null
      ? undefined
      : { maxWidth: viewportWidth, width: viewportWidth };

  return (
    <div
      className="min-h-0 w-full min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-5 [container-type:inline-size] sm:text-xs"
      data-diff-file-patch=""
      onScroll={(event) => onScrollLeftChange(event.currentTarget.scrollLeft)}
      ref={patch}
    >
      <div className="w-max min-w-full" data-diff-patch-canvas="">
        {file.hunks.map((hunk, hunkIndex) => (
          <div className="min-w-full" key={`${hunk.header}-${hunkIndex}`}>
            <div className="w-full min-w-full border-y border-blue-200 bg-blue-50 px-3 py-1 text-blue-800 first:border-t-0 dark:border-blue-900/70 dark:bg-blue-950/45 dark:text-blue-300">
              {hunk.header}
            </div>
            {hunk.lines.map((line, lineIndex) => {
              const left =
                file.truncated || readOnly
                  ? null
                  : anchorFor(file, hunkIndex, lineIndex, line, "LEFT");
              const right =
                file.truncated || readOnly
                  ? null
                  : anchorFor(file, hunkIndex, lineIndex, line, "RIGHT");
              const lineSelected =
                selectedAnchor(selection, left) ||
                selectedAnchor(selection, right);

              return (
                <Fragment
                  key={`${hunkIndex}-${lineIndex}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
                >
                  <div
                    className={`grid w-full min-w-full grid-cols-[3rem_3rem_minmax(max-content,1fr)] ${lineStyles[line.kind]} ${lineSelected ? "outline-1 -outline-offset-1 outline-blue-500" : ""}`}
                    data-comment-selected={lineSelected ? "" : undefined}
                    data-line-kind={line.kind}
                  >
                    <DiffGutter
                      agent={agent}
                      anchor={left}
                      gutter="old"
                      onSelect={onSelect}
                      selected={selectedAnchor(selection, left)}
                      value={line.oldLine}
                    />
                    <DiffGutter
                      agent={agent}
                      anchor={right}
                      gutter="new"
                      onSelect={onSelect}
                      selected={selectedAnchor(selection, right)}
                      value={line.newLine}
                    />
                    <code className="inline-block min-w-full whitespace-pre px-3">
                      <span aria-hidden="true" className="mr-2 select-none">
                        {lineMarker(line.kind)}
                      </span>
                      <SyntaxContent
                        content={line.content}
                        tokens={
                          highlighted?.hunks[hunkIndex]?.lines[lineIndex] ??
                          null
                        }
                      />
                    </code>
                  </div>
                  {composer !== null &&
                    selection?.end.hunkIndex === hunkIndex &&
                    selection.end.lineIndex === lineIndex && (
                      <div
                        className="sticky left-0 box-border w-[100cqw] min-w-0 max-w-[100cqw] border-y bg-card font-sans text-sm"
                        data-inline-review-composer=""
                        style={composerStyle}
                      >
                        {composer}
                      </div>
                    )}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
});

const DiffFile = memo(function DiffFile({
  agent,
  composerFocusRequest,
  diff,
  draft,
  file,
  id,
  onCancelComment,
  onDraftChange,
  onPatchScrollLeftChange,
  onSelectComment,
  patchScrollLeft,
  pull,
  readOnly,
  register,
  run,
  selection,
  startRun,
  toggleViewed,
  viewed,
}: {
  agent: Agent;
  composerFocusRequest: number;
  diff: PullDiffData;
  draft: string;
  file: PullDiffFile;
  id: string;
  onCancelComment: () => void;
  onDraftChange: (draft: string) => void;
  onPatchScrollLeftChange: (path: string, scrollLeft: number) => void;
  onSelectComment: (anchor: CommentAnchor, shift: boolean) => void;
  patchScrollLeft: number;
  pull: PullReadiness;
  readOnly: boolean;
  register: (path: string, node: HTMLElement | null) => void;
  run: RunState;
  selection: CommentSelection | null;
  startRun: PullRuns["start"];
  toggleViewed: (path: string, viewed: boolean) => void;
  viewed: boolean;
}) {
  const bodyId = `${id}-body`;
  const checkboxId = `${id}-viewed`;
  const registerSection = useCallback(
    (node: HTMLElement | null) => register(file.path, node),
    [file.path, register],
  );
  const handleViewedChange = useCallback(
    (checked: boolean | "indeterminate") =>
      toggleViewed(file.path, checked === true),
    [file.path, toggleViewed],
  );
  const handlePatchScrollLeftChange = useCallback(
    (scrollLeft: number) => onPatchScrollLeftChange(file.path, scrollLeft),
    [file.path, onPatchScrollLeftChange],
  );
  const composer =
    !readOnly && selection !== null && selection.start.path === file.path ? (
      <ReviewComposer
        agent={agent}
        diff={diff}
        draft={draft}
        focusRequest={composerFocusRequest}
        key={`${selection.origin.hunkIndex}:${selection.origin.side}:${selection.origin.lineIndex}:${selection.start.line}:${selection.end.line}:${run.reviewRetry?.attemptToken ?? "new"}`}
        onCancel={onCancelComment}
        onDraftChange={onDraftChange}
        pull={pull}
        retryStatus={run.reviewRetry?.status ?? null}
        run={run}
        selection={selection}
        startRun={startRun}
      />
    ) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex w-full min-w-0 scroll-mt-0 flex-col rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-diff-file=""
      id={id}
      ref={registerSection}
      tabIndex={-1}
    >
      <header
        className={`sticky top-0 z-50 -mx-px w-[calc(100%+2px)] min-w-0 border-x border-b bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
          viewed ? "rounded-lg" : "rounded-t-lg"
        }`}
        data-diff-file-header=""
        tabIndex={-1}
      >
        <div className="flex min-h-10 w-full min-w-0 flex-wrap items-center gap-2 overflow-clip rounded-[inherit] bg-muted/35 px-3 py-2">
          <FileCode2
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <h4
            className="m-0 min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs font-medium"
            data-diff-file-name=""
            id={`${id}-title`}
          >
            {file.previousPath && file.previousPath !== file.path ? (
              <span className="inline-flex items-center gap-1">
                <span>{file.previousPath}</span>
                <ArrowRight aria-hidden="true" className="size-3" />
                <span>{file.path}</span>
              </span>
            ) : (
              file.path
            )}
          </h4>
          <Badge variant="outline">{statusLabels[file.status]}</Badge>
          <span
            aria-label={`${file.additions} additions and ${file.deletions} deletions`}
            className="flex items-center gap-1 font-mono text-[11px] tabular-nums"
          >
            <span className="text-emerald-700 dark:text-emerald-400">
              +{file.additions}
            </span>
            <span className="text-red-700 dark:text-red-400">
              -{file.deletions}
            </span>
          </span>
          {isSafeGitHubUrl(file.blobUrl) && (
            <a
              className="relative z-20 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={file.blobUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              View file
            </a>
          )}
          <div className="flex shrink-0 items-center gap-1.5 border-l pl-2">
            <Checkbox
              aria-controls={viewed ? undefined : bodyId}
              aria-label={`Viewed ${file.path}`}
              checked={viewed}
              data-pull-focus-token={`viewed:${file.path}`}
              id={checkboxId}
              onCheckedChange={handleViewedChange}
            />
            <Label
              className="cursor-pointer text-xs font-normal text-muted-foreground"
              htmlFor={checkboxId}
            >
              Viewed
            </Label>
          </div>
        </div>
      </header>
      {!viewed && (
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-lg"
          data-diff-file-body=""
          id={bodyId}
        >
          <FilePatch
            agent={agent}
            composer={composer}
            file={file}
            onSelect={onSelectComment}
            onScrollLeftChange={handlePatchScrollLeftChange}
            readOnly={readOnly}
            scrollLeft={patchScrollLeft}
            selection={selection}
          />
          {file.truncated && file.hunks.length > 0 && (
            <div className="flex items-center gap-2 border-t bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              GitHub returned only part of this file's patch.
            </div>
          )}
        </div>
      )}
    </section>
  );
});

type FileNavigationProps = {
  activate: (path: string) => void;
  collapsedDirectories: readonly string[];
  fileIds: readonly string[];
  files: PullDiffFile[];
  navigate: (path: string) => void;
  onScrollChange: (scrollLeft: number, scrollTop: number) => void;
  onToggleDirectory: (path: string) => void;
  scrollLeft: number;
  scrollTop: number;
  selected: string | null;
  visibleCount: number;
};

const FileNavigation = memo(function FileNavigation({
  activate,
  collapsedDirectories,
  fileIds,
  files,
  navigate,
  onScrollChange,
  onToggleDirectory,
  scrollLeft,
  scrollTop,
  selected,
  visibleCount,
}: FileNavigationProps) {
  const navigation = useRef<HTMLElement>(null);
  const tree = useMemo(() => createFileTree(files), [files]);
  const collapsed = useMemo(
    () => new Set(collapsedDirectories),
    [collapsedDirectories],
  );

  useLayoutEffect(() => {
    if (!navigation.current) return;
    if (navigation.current.scrollLeft !== scrollLeft) {
      navigation.current.scrollLeft = scrollLeft;
    }
    if (navigation.current.scrollTop !== scrollTop) {
      navigation.current.scrollTop = scrollTop;
    }
  }, [scrollLeft, scrollTop]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-tree-item]",
      );
      if (!item || !event.currentTarget.contains(item)) return;
      const items = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          item.dataset.filePath
            ? "button[data-file-index]"
            : "button[data-tree-item]",
        ),
      ];
      const index = items.indexOf(item);
      let next = index;

      if (event.key === "ArrowDown") {
        next = Math.min(items.length - 1, index + 1);
      } else if (event.key === "ArrowUp") {
        next = Math.max(0, index - 1);
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        item.dataset.directory
      ) {
        const isCollapsed =
          item.parentElement?.getAttribute("aria-expanded") === "false";
        if (
          (event.key === "ArrowLeft" && !isCollapsed) ||
          (event.key === "ArrowRight" && isCollapsed)
        ) {
          event.preventDefault();
          item.click();
        }
        return;
      } else {
        return;
      }

      event.preventDefault();
      const target = items[next];
      if (!target) return;
      const path = target.dataset.filePath;
      if (path) navigate(path);
      target.focus();
    },
    [navigate],
  );

  const renderDirectory = (
    directory: FileTreeDirectory,
    depth: number,
  ): ReactNode => {
    const directories = treeDirectories(directory);
    const directoryFiles = directory.files;
    const children = [
      ...directories.map((child) => ({
        key: `directory:${child.path}`,
        node: (() => {
          const closed = collapsed.has(child.path);
          return (
            <li
              aria-expanded={!closed}
              className="min-w-full"
              key={child.path}
              role="treeitem"
            >
              <button
                className="flex min-h-9 w-max min-w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                data-directory={child.path}
                data-tree-item=""
                onClick={() => onToggleDirectory(child.path)}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                type="button"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={`size-3 shrink-0 transition-transform ${closed ? "" : "rotate-90"}`}
                />
                {closed ? (
                  <FolderClosed aria-hidden="true" className="size-3.5" />
                ) : (
                  <FolderOpen aria-hidden="true" className="size-3.5" />
                )}
                <span className="whitespace-nowrap font-mono">
                  {child.name}
                </span>
              </button>
              {!closed && renderDirectory(child, depth + 1)}
            </li>
          );
        })(),
      })),
      ...directoryFiles.map(({ file, index }) => {
        const name = file.path.split("/").pop() ?? file.path;
        return {
          key: `file:${file.path}`,
          node: (
            <li
              aria-selected={selected === file.path}
              className="min-w-full"
              key={file.path}
              role="treeitem"
            >
              <button
                aria-controls={
                  index < visibleCount || selected === file.path
                    ? fileIds[index]
                    : undefined
                }
                aria-current={selected === file.path ? "true" : undefined}
                className="flex min-h-11 w-max min-w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
                data-file-index={index}
                data-file-path={file.path}
                data-pull-focus-token={`file:${file.path}`}
                data-tree-item=""
                onClick={() => activate(file.path)}
                style={{ paddingLeft: `${depth * 12 + 25}px` }}
                tabIndex={selected === file.path ? 0 : -1}
                type="button"
              >
                <FileCode2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="flex-1 whitespace-nowrap font-mono">
                  {name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{file.additions}
                  </span>{" "}
                  <span className="text-red-700 dark:text-red-400">
                    -{file.deletions}
                  </span>
                </span>
              </button>
            </li>
          ),
        };
      }),
    ];

    return (
      <ul
        className="m-0 min-w-full list-none p-0"
        role={depth === 0 ? "tree" : "group"}
      >
        {children.map(({ key, node }) => (
          <Fragment key={key}>{node}</Fragment>
        ))}
      </ul>
    );
  };

  return (
    <nav
      aria-label="Changed files"
      className="flex max-w-full gap-1 overflow-x-auto p-2 lg:max-h-[70vh] lg:flex-col lg:overflow-auto lg:[max-height:calc(100vh-3rem)]"
      onKeyDown={handleKeyDown}
      onScroll={(event) =>
        onScrollChange(
          event.currentTarget.scrollLeft,
          event.currentTarget.scrollTop,
        )
      }
      ref={navigation}
    >
      {renderDirectory(tree, 0)}
    </nav>
  );
});

function PullDiff({
  agent = "claude",
  clearReviewRetry,
  diff,
  onPersistenceChange,
  persistence,
  pull,
  readOnly = false,
  run,
  startRun,
  toggleViewed,
  viewed,
}: PullDiffProps) {
  const retryAgent =
    run.reviewRetry === null
      ? null
      : (run.history.find(({ id }) => id === run.reviewRetry?.runId)?.agent ??
        null);
  const feedbackAgent =
    run.source === "review" && isRunActive(run)
      ? run.agent
      : (retryAgent ?? agent);
  const copy = feedbackAgentCopy[feedbackAgent];
  const identifier = useId();
  const reducedMotion = useReducedMotion();
  const files = useRef(new Map<string, HTMLElement>());
  const layout = useRef<HTMLDivElement>(null);
  const resize = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const toggleViewedRef = useRef(toggleViewed);
  const [localPersistence, setLocalPersistence] = useState(() =>
    createPullDiffPersistence(diff),
  );
  const persistenceSource = persistence ?? localPersistence;
  const currentPersistence = useMemo(
    () => normalizePullDiffPersistence(diff, persistenceSource),
    [diff, persistenceSource],
  );
  const persistenceRef = useRef(currentPersistence);
  const normalizationNotice = useRef<PullDiffPersistence | null>(null);
  const controlled = persistence !== undefined;
  persistenceRef.current = currentPersistence;
  const selected = currentPersistence.selectedPath;
  const commentSelection = currentPersistence.selection;
  const visibleCount = currentPersistence.visibleCount;
  const [selectionAnnouncement, setSelectionAnnouncement] = useState("");
  const pendingSelection = useRef<string | null>(null);
  const pendingViewedScroll = useRef<ViewedScroll | null>(null);
  const observedAttempt = useRef<string | null>(
    readOnly ? null : run.reviewAttemptToken,
  );
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  toggleViewedRef.current = toggleViewed;

  const updatePersistence = useCallback(
    (update: (current: PullDiffPersistence) => PullDiffPersistence): void => {
      const previous = persistenceRef.current;
      const next = normalizePullDiffPersistence(diff, update(previous));
      if (samePersistence(previous, next)) return;

      persistenceRef.current = next;
      normalizationNotice.current = null;
      if (!controlled) setLocalPersistence(next);
      onPersistenceChange?.(next);
    },
    [controlled, diff, onPersistenceChange],
  );

  useEffect(() => {
    if (samePersistence(persistenceSource, currentPersistence)) {
      normalizationNotice.current = null;
      return;
    }
    if (
      normalizationNotice.current !== null &&
      samePersistence(normalizationNotice.current, currentPersistence)
    ) {
      return;
    }

    persistenceRef.current = currentPersistence;
    normalizationNotice.current = currentPersistence;
    if (!controlled) setLocalPersistence(currentPersistence);
    onPersistenceChange?.(currentPersistence);
  }, [controlled, currentPersistence, onPersistenceChange, persistenceSource]);
  const orderedFiles = useMemo(() => treeFiles(diff.files), [diff.files]);
  const fileIds = useMemo(
    () =>
      orderedFiles.map(
        (_file, index) => `pull-diff-${identifier}-file-${index}`,
      ),
    [identifier, orderedFiles],
  );
  const totals = useMemo(
    () =>
      diff.files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [diff.files],
  );
  const viewedCount = useMemo(
    () =>
      diff.files.reduce(
        (count, file) => count + (viewed.has(file.path) ? 1 : 0),
        0,
      ),
    [diff.files, viewed],
  );
  const revision =
    "commitSha" in diff && typeof diff.commitSha === "string"
      ? diff.commitSha
      : diff.headRefOid;

  useEffect(() => {
    if (readOnly) return;
    const retry = run.reviewRetry;
    if (!retry) return;
    const restored = selectionForRetry(diff, retry);
    if (restored === null) {
      clearReviewRetry(pull.url, retry.attemptToken);
      updatePersistence((current) => ({
        ...current,
        draft: "",
        selection: null,
      }));
      setSelectionAnnouncement(
        `The saved ${copy.feedback} no longer matches this pull request diff.`,
      );
      return;
    }

    updatePersistence((current) => ({
      ...current,
      draft: retry.draft,
      selectedPath: restored.start.path,
      selection: restored,
    }));
    setSelectionAnnouncement(`Restored ${selectionLabel(restored)} for retry.`);
  }, [
    clearReviewRetry,
    copy.feedback,
    diff,
    pull.url,
    readOnly,
    run.reviewRetry,
    updatePersistence,
  ]);

  useEffect(() => {
    if (readOnly) return;
    if (run.reviewAttemptToken !== null) {
      if (observedAttempt.current !== run.reviewAttemptToken) {
        updatePersistence((current) => ({
          ...current,
          draft: "",
          selection: null,
        }));
        setSelectionAnnouncement(
          `${copy.name} is addressing the selected feedback.`,
        );
      }
      observedAttempt.current = run.reviewAttemptToken;
      return;
    }
    if (
      observedAttempt.current !== null &&
      !isRunActive(run) &&
      run.reviewRetry === null
    ) {
      observedAttempt.current = null;
      updatePersistence((current) => ({
        ...current,
        draft: "",
        selection: null,
      }));
      setSelectionAnnouncement(`${copy.feedback} selection cleared.`);
    }
  }, [copy.feedback, copy.name, readOnly, run, updatePersistence]);

  const registerFile = useCallback((path: string, node: HTMLElement | null) => {
    if (node) files.current.set(path, node);
    else files.current.delete(path);
  }, []);
  const handleToggleViewed = useCallback(
    (path: string, nextViewed: boolean) => {
      if (!nextViewed) {
        if (pendingViewedScroll.current?.sourcePath === path) {
          pendingViewedScroll.current = null;
        }
      } else {
        const source = files.current.get(path);
        const index = orderedFiles.findIndex((file) => file.path === path);
        if (source !== undefined && index >= 0) {
          const targetPath = orderedFiles[index + 1]?.path ?? null;
          pendingViewedScroll.current = {
            diff,
            owner: verticalScrollOwner(source),
            sourcePath: path,
            targetPath,
          };
          if (
            targetPath !== null &&
            index + 1 >= persistenceRef.current.visibleCount
          ) {
            updatePersistence((current) => ({
              ...current,
              visibleCount: Math.max(current.visibleCount, index + 2),
            }));
          }
        }
      }

      if (!readOnly) {
        const retry = run.reviewRetry;
        if (retry?.feedback.path === path) {
          clearReviewRetry(pull.url, retry.attemptToken);
        }
        updatePersistence((current) =>
          current.selection?.start.path === path
            ? { ...current, draft: "", selection: null }
            : current,
        );
      }
      toggleViewedRef.current(path);
    },
    [
      clearReviewRetry,
      diff,
      orderedFiles,
      pull.url,
      readOnly,
      run.reviewRetry,
      updatePersistence,
    ],
  );
  useLayoutEffect(() => {
    const pending = pendingViewedScroll.current;
    if (
      pending === null ||
      pending.diff !== diff ||
      !viewed.has(pending.sourcePath)
    ) {
      return;
    }

    const anchor =
      pending.targetPath === null
        ? files.current.get(pending.sourcePath)
        : files.current.get(pending.targetPath);
    if (anchor === undefined) return;

    const root =
      layout.current?.closest<HTMLElement>("[data-pull-diff]") ?? null;
    const anchorBounds = anchor.getBoundingClientRect();
    const top =
      scrollViewportTop(pending.owner) +
      stickyInset(pending.owner, root, anchorBounds);
    const delta = anchorBounds.top - top;
    pending.owner.scrollTop = Math.max(0, pending.owner.scrollTop + delta);
    (
      anchor.querySelector<HTMLElement>("[data-diff-file-header]") ?? anchor
    ).focus({ preventScroll: true });
    pendingViewedScroll.current = null;
  }, [diff, currentPersistence.visibleCount, viewed]);
  useEffect(
    () => () => {
      pendingViewedScroll.current = null;
    },
    [diff],
  );
  const cancelComment = useCallback(() => {
    if (readOnly) return;
    if (run.reviewRetry) {
      clearReviewRetry(pull.url, run.reviewRetry.attemptToken);
    }
    updatePersistence((current) => ({
      ...current,
      draft: "",
      selection: null,
    }));
    setSelectionAnnouncement(`${copy.feedback} selection cleared.`);
  }, [
    clearReviewRetry,
    copy.feedback,
    pull.url,
    readOnly,
    run.reviewRetry,
    updatePersistence,
  ]);
  const selectComment = useCallback(
    (anchor: CommentAnchor, shift: boolean) => {
      if (readOnly) return;
      if (run.reviewRetry) {
        clearReviewRetry(pull.url, run.reviewRetry.attemptToken);
      }
      if (!shift || commentSelection === null) {
        const next = { end: anchor, origin: anchor, start: anchor };
        updatePersistence((current) => ({
          ...current,
          draft: "",
          selectedPath: anchor.path,
          selection: next,
        }));
        setComposerFocusRequest((request) => request + 1);
        setSelectionAnnouncement(`Selected ${selectionLabel(next)}.`);
        return;
      }
      if (commentSelection.origin.path !== anchor.path) {
        setSelectionAnnouncement(
          `Keep the ${copy.feedback} selection within one file.`,
        );
        return;
      }
      if (commentSelection.origin.hunkIndex !== anchor.hunkIndex) {
        setSelectionAnnouncement(
          `Keep the ${copy.feedback} selection within one diff hunk.`,
        );
        return;
      }
      if (commentSelection.origin.side !== anchor.side) {
        setSelectionAnnouncement(
          `Keep the ${copy.feedback} selection on the same side of the diff.`,
        );
        return;
      }

      const file = diff.files.find(({ path }) => path === anchor.path);
      const next = file
        ? extendSelection(commentSelection, anchor, file)
        : null;
      if (next === null) {
        setSelectionAnnouncement(
          "Choose contiguous displayed lines with consecutive line numbers.",
        );
        return;
      }
      updatePersistence((current) => ({
        ...current,
        selectedPath: anchor.path,
        selection: next,
      }));
      setComposerFocusRequest((request) => request + 1);
      setSelectionAnnouncement(`Selected ${selectionLabel(next)}.`);
    },
    [
      clearReviewRetry,
      commentSelection,
      copy.feedback,
      diff.files,
      pull.url,
      readOnly,
      run.reviewRetry,
      updatePersistence,
    ],
  );
  const focusFile = useCallback(
    (path: string) => {
      const section = files.current.get(path);
      if (!section) return false;

      section.scrollIntoView?.({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
      section.focus({ preventScroll: true });
      return true;
    },
    [reducedMotion],
  );
  const selectFile = useCallback(
    (path: string) => {
      updatePersistence((current) => {
        const keepFeedback = current.selection?.start.path === path;
        return {
          ...current,
          draft: keepFeedback ? current.draft : "",
          selectedPath: path,
          selection: keepFeedback ? current.selection : null,
        };
      });
      pendingSelection.current = null;
      if (focusFile(path)) return;

      const index = orderedFiles.findIndex((file) => file.path === path);
      if (index < 0) return;

      pendingSelection.current = path;
    },
    [focusFile, orderedFiles, updatePersistence],
  );
  const navigateFile = useCallback(
    (path: string) => {
      pendingSelection.current = null;
      updatePersistence((current) => {
        const keepFeedback = current.selection?.start.path === path;
        return {
          ...current,
          draft: keepFeedback ? current.draft : "",
          selectedPath: path,
          selection: keepFeedback ? current.selection : null,
        };
      });
    },
    [updatePersistence],
  );
  const changeDraft = useCallback(
    (draft: string) => {
      updatePersistence((current) => ({ ...current, draft }));
    },
    [updatePersistence],
  );
  const updatePersistenceRef = useRef(updatePersistence);
  const pendingScroll = useRef<{
    navigationScrollLeft?: number;
    navigationScrollTop?: number;
    patchScrollLeft: Record<string, number>;
  }>({ patchScrollLeft: {} });
  const scrollFrame = useRef<number | null>(null);
  updatePersistenceRef.current = updatePersistence;
  const flushScrollPersistence = useCallback(() => {
    const pending = pendingScroll.current;
    const patchScrollLeft = pending.patchScrollLeft;
    if (
      pending.navigationScrollLeft === undefined &&
      pending.navigationScrollTop === undefined &&
      Object.keys(patchScrollLeft).length === 0
    ) {
      return;
    }

    pendingScroll.current = { patchScrollLeft: {} };
    updatePersistenceRef.current((current) => ({
      ...current,
      ...(pending.navigationScrollLeft === undefined
        ? {}
        : { navigationScrollLeft: pending.navigationScrollLeft }),
      ...(pending.navigationScrollTop === undefined
        ? {}
        : { navigationScrollTop: pending.navigationScrollTop }),
      patchScrollLeft:
        Object.keys(patchScrollLeft).length === 0
          ? current.patchScrollLeft
          : { ...current.patchScrollLeft, ...patchScrollLeft },
    }));
  }, []);
  const scheduleScrollPersistence = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      flushScrollPersistence();
    });
  }, [flushScrollPersistence]);
  const changeNavigationScroll = useCallback(
    (navigationScrollLeft: number, navigationScrollTop: number) => {
      pendingScroll.current.navigationScrollLeft = navigationScrollLeft;
      pendingScroll.current.navigationScrollTop = navigationScrollTop;
      scheduleScrollPersistence();
    },
    [scheduleScrollPersistence],
  );
  const changePatchScrollLeft = useCallback(
    (path: string, patchScrollLeft: number) => {
      pendingScroll.current.patchScrollLeft[path] = patchScrollLeft;
      scheduleScrollPersistence();
    },
    [scheduleScrollPersistence],
  );
  useEffect(
    () => () => {
      if (scrollFrame.current !== null) {
        window.cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
      }
      flushScrollPersistence();
    },
    [flushScrollPersistence],
  );
  const showMoreFiles = useCallback(() => {
    updatePersistence((current) => ({
      ...current,
      visibleCount: Math.min(
        orderedFiles.length,
        current.visibleCount + FILE_BATCH_SIZE,
      ),
    }));
  }, [orderedFiles.length, updatePersistence]);
  const toggleDirectory = useCallback(
    (path: string) => {
      updatePersistence((current) => {
        const collapsed = new Set(current.collapsedDirectories);
        if (collapsed.has(path)) collapsed.delete(path);
        else collapsed.add(path);
        return { ...current, collapsedDirectories: [...collapsed].sort() };
      });
    },
    [updatePersistence],
  );
  const maximumNavigationWidth = useCallback((): number => {
    const width = layout.current?.getBoundingClientRect().width ?? 0;
    return width > 0
      ? Math.max(
          NAVIGATION_MIN_WIDTH,
          Math.min(NAVIGATION_MAX_WIDTH, width - 320),
        )
      : NAVIGATION_MAX_WIDTH;
  }, []);
  const setNavigationWidth = useCallback(
    (width: number) => {
      const maximum = maximumNavigationWidth();
      updatePersistence((current) => ({
        ...current,
        navigationWidth: Math.min(
          maximum,
          Math.max(NAVIGATION_MIN_WIDTH, width),
        ),
      }));
    },
    [maximumNavigationWidth, updatePersistence],
  );
  useLayoutEffect(() => {
    const reclamp = (): void => {
      if (!splitLayoutActive()) return;
      setNavigationWidth(persistenceRef.current.navigationWidth);
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    const observer =
      typeof ResizeObserver === "undefined" || layout.current === null
        ? null
        : new ResizeObserver(reclamp);
    if (observer && layout.current) observer.observe(layout.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reclamp);
    };
  }, [setNavigationWidth]);
  const beginNavigationResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      resize.current = {
        pointerId: event.pointerId,
        startWidth: persistenceRef.current.navigationWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [],
  );
  const resizeNavigation = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = resize.current;
      if (!current || current.pointerId !== event.pointerId) return;
      setNavigationWidth(current.startWidth + event.clientX - current.startX);
    },
    [setNavigationWidth],
  );
  const finishNavigationResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (resize.current?.pointerId !== event.pointerId) return;
      resize.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [],
  );
  const handleSeparatorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      let width: number | null = null;
      if (event.key === "ArrowLeft") {
        width = persistenceRef.current.navigationWidth - 16;
      } else if (event.key === "ArrowRight") {
        width = persistenceRef.current.navigationWidth + 16;
      } else if (event.key === "Home") {
        width = NAVIGATION_MIN_WIDTH;
      } else if (event.key === "End") {
        width = maximumNavigationWidth();
      } else {
        return;
      }
      event.preventDefault();
      setNavigationWidth(width);
    },
    [maximumNavigationWidth, setNavigationWidth],
  );

  useEffect(() => {
    const path = pendingSelection.current;
    if (path && focusFile(path)) pendingSelection.current = null;
  }, [focusFile, selected, visibleCount]);

  const shown = Math.min(visibleCount, orderedFiles.length);
  const selectedIndex = orderedFiles.findIndex(
    (file) => file.path === selected,
  );
  const renderedCount =
    shown +
    (selectedIndex >= shown && selectedIndex < orderedFiles.length ? 1 : 0);
  const remaining = orderedFiles.length - renderedCount;
  const nextShown = Math.min(orderedFiles.length, shown + FILE_BATCH_SIZE);
  const nextRenderedCount =
    nextShown +
    (selectedIndex >= nextShown && selectedIndex < orderedFiles.length ? 1 : 0);
  const revealCount = nextRenderedCount - renderedCount;

  return (
    <div
      aria-label={`Files changed for ${diff.repository} pull request ${diff.number}`}
      className="mt-3 w-full min-w-0 rounded-xl border bg-background"
      data-pull-diff=""
      role="region"
    >
      {selectionAnnouncement !== "" && (
        <p
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-comment-selection-status=""
          role="status"
        >
          {selectionAnnouncement}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-t-xl border-b bg-muted/30 px-3 py-2 text-xs">
        <span className="font-medium">
          {diff.files.length} {diff.files.length === 1 ? "file" : "files"}{" "}
          changed
        </span>
        <span className="text-emerald-700 dark:text-emerald-400">
          +{totals.additions}
        </span>
        <span className="text-red-700 dark:text-red-400">
          -{totals.deletions}
        </span>
        <span
          aria-atomic="true"
          aria-live="polite"
          className="text-muted-foreground"
        >
          {viewedCount} of {diff.files.length} files viewed
        </span>
        <code
          className="ml-auto text-[11px] text-muted-foreground"
          data-diff-revision=""
          title={revision}
        >
          {revision.slice(0, 7)}
        </code>
      </div>

      {!diff.complete && (
        <div
          className="flex items-start gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950/35 dark:text-amber-100"
          role="status"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>
            {diff.warning ??
              "GitHub could not return the complete diff. The files below are the available portion."}
          </span>
        </div>
      )}

      {diff.files.length === 0 ? (
        <p className="m-0 px-4 py-8 text-center text-sm text-muted-foreground">
          No changed files were returned for this pull request.
        </p>
      ) : (
        <div
          className="grid w-full min-w-0"
          data-diff-layout=""
          data-navigation-visible="true"
          ref={layout}
          style={
            {
              "--diff-navigation-width": `${currentPersistence.navigationWidth}px`,
            } as CSSProperties
          }
        >
          <>
            <div
              className="min-w-0 self-stretch border-b bg-muted/15 lg:border-r lg:border-b-0"
              data-diff-navigation-pane=""
            >
              <div
                className="lg:sticky lg:top-0 lg:max-h-[calc(100vh-3rem)]"
                data-diff-navigation-sticky=""
              >
                <aside data-diff-navigation="">
                  <FileNavigation
                    activate={selectFile}
                    collapsedDirectories={
                      currentPersistence.collapsedDirectories
                    }
                    fileIds={fileIds}
                    files={orderedFiles}
                    navigate={navigateFile}
                    onScrollChange={changeNavigationScroll}
                    onToggleDirectory={toggleDirectory}
                    scrollLeft={currentPersistence.navigationScrollLeft}
                    scrollTop={currentPersistence.navigationScrollTop}
                    selected={selected}
                    visibleCount={shown}
                  />
                </aside>
              </div>
            </div>
            <div
              aria-label="Resize changed files pane"
              aria-orientation="vertical"
              aria-valuemax={Math.round(maximumNavigationWidth())}
              aria-valuemin={NAVIGATION_MIN_WIDTH}
              aria-valuenow={Math.round(currentPersistence.navigationWidth)}
              className="group relative hidden cursor-col-resize touch-none bg-border outline-none hover:bg-ring focus-visible:bg-ring lg:block"
              data-diff-navigation-resizer=""
              onKeyDown={handleSeparatorKeyDown}
              onPointerCancel={finishNavigationResize}
              onPointerDown={beginNavigationResize}
              onPointerMove={resizeNavigation}
              onPointerUp={finishNavigationResize}
              role="separator"
              tabIndex={0}
            >
              <span className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
            </div>
          </>

          <div className="min-w-0 space-y-3 p-2 sm:p-3" data-diff-content="">
            {orderedFiles.map((file, index) =>
              index < shown || file.path === selected ? (
                <DiffFile
                  composerFocusRequest={composerFocusRequest}
                  diff={diff}
                  agent={feedbackAgent}
                  draft={currentPersistence.draft}
                  file={file}
                  id={fileIds[index]!}
                  key={file.path}
                  onCancelComment={cancelComment}
                  onDraftChange={changeDraft}
                  onPatchScrollLeftChange={changePatchScrollLeft}
                  onSelectComment={selectComment}
                  patchScrollLeft={
                    currentPersistence.patchScrollLeft[file.path] ?? 0
                  }
                  pull={pull}
                  readOnly={readOnly}
                  register={registerFile}
                  run={run}
                  selection={
                    commentSelection?.start.path === file.path
                      ? commentSelection
                      : null
                  }
                  startRun={startRun}
                  toggleViewed={handleToggleViewed}
                  viewed={viewed.has(file.path)}
                />
              ) : null,
            )}
            {remaining > 0 && (
              <div className="flex justify-center py-1">
                <Button
                  aria-label={`Show more changed files. ${renderedCount} of ${diff.files.length} shown.`}
                  onClick={showMoreFiles}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Show {revealCount} more files
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(PullDiff);
