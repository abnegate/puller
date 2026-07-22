import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  FileCode2,
  FileWarning,
  LoaderCircle,
  MessageSquare,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  memo,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
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
  type PullRuns,
  type RunStartOutcome,
  type RunState,
} from "../runs";
import type {
  DiffLineKind,
  PullDiff as PullDiffData,
  PullDiffFile,
  PullDiffHunk,
  PullDiffLine,
  PullReadiness,
  ReviewCommentSide,
} from "../types";

type PullDiffProps = {
  diff: PullDiffData;
  pull: PullReadiness;
  run: RunState;
  startRun: PullRuns["start"];
  toggleViewed: (path: string) => void;
  viewed: ReadonlySet<string>;
};

const FILE_BATCH_SIZE = 20;

type CommentAnchor = {
  hunkIndex: number;
  line: number;
  lineIndex: number;
  path: string;
  side: ReviewCommentSide;
};

type CommentSelection = {
  end: CommentAnchor;
  origin: CommentAnchor;
  start: CommentAnchor;
};

type ComposerState =
  | { kind: "editing"; message: string | null }
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

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return "The review fix could not be started.";
  return (
    error.message.replace(/\s+/g, " ").trim().slice(0, 500) ||
    "The review fix could not be started."
  );
};

const runErrorMessage = (outcome: RunStartOutcome): string | null =>
  outcome.kind === "accepted" || outcome.kind === "accepted-equivalent"
    ? null
    : outcome.message;

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
    <div className="flex min-h-24 items-center justify-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
      <FileWarning aria-hidden="true" className="size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
});

function ReviewComposer({
  diff,
  onCancel,
  pull,
  run,
  selection,
  startRun,
}: {
  diff: PullDiffData;
  onCancel: () => void;
  pull: PullReadiness;
  run: RunState;
  selection: CommentSelection;
  startRun: PullRuns["start"];
}) {
  const inputId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const active = isRunActive(run);
  const [body, setBody] = useState("");
  const [state, setState] = useState<ComposerState>({
    kind: "editing",
    message: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async () => {
    if (
      pending.current ||
      active ||
      body.trim() === "" ||
      state.kind === "started"
    ) {
      return;
    }

    pending.current = true;
    setState({ kind: "submitting" });
    try {
      const outcome = await startRun(pull, {
        expectedBaseRefOid: diff.baseRefOid,
        feedback: {
          body: body.trim(),
          line: selection.end.line,
          path: selection.start.path,
          side: selection.start.side,
          ...(selection.start.line === selection.end.line
            ? {}
            : {
                startLine: selection.start.line,
                startSide: selection.start.side,
              }),
        },
        source: "review",
      });
      if (!mounted.current) return;

      const message = runErrorMessage(outcome);
      if (message !== null) {
        setState({ kind: "editing", message });
        return;
      }

      setState({
        kind: "started",
        message:
          outcome.kind === "accepted-equivalent"
            ? outcome.message
            : "Claude is addressing this feedback, then will commit and push it to the existing pull request.",
      });
    } catch (error) {
      if (!mounted.current) return;
      setState({ kind: "editing", message: errorMessage(error) });
    } finally {
      pending.current = false;
    }
  };

  if (state.kind === "started") {
    return (
      <div
        className="space-y-2 border-t bg-emerald-50/70 px-3 py-3 text-xs dark:bg-emerald-950/25"
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
      className="space-y-2 border-t bg-muted/20 px-3 py-3"
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
          Claude feedback on {selectionLabel(selection)}
        </label>
        <code className="min-w-0 truncate text-[11px] text-muted-foreground">
          {selection.start.path}
        </code>
      </div>
      <Textarea
        autoFocus
        disabled={submitting}
        id={inputId}
        onChange={(event) => {
          setBody(event.target.value);
          if (state.kind === "editing" && state.message !== null) {
            setState({ kind: "editing", message: null });
          }
        }}
        placeholder="Tell Claude what to change…"
        required
        rows={3}
        value={body}
      />
      {state.kind === "editing" && state.message !== null && (
        <p className="m-0 text-xs text-destructive" role="alert">
          {state.message}
        </p>
      )}
      {active && (
        <p
          className="m-0 text-xs text-amber-700 dark:text-amber-300"
          role="status"
        >
          A Claude Code run is already active for this pull request. Wait for it
          to finish before starting another review fix.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          disabled={submitting}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={active || submitting || body.trim() === ""}
          size="sm"
          type="submit"
        >
          {submitting && (
            <LoaderCircle
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          )}
          {submitting ? "Starting review fix" : "Run review fix"}
        </Button>
      </div>
    </form>
  );
}

function DiffGutter({
  anchor,
  gutter,
  onSelect,
  selected,
  value,
}: {
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
      aria-label={`Give Claude feedback on ${gutter} line ${anchor.line}`}
      aria-pressed={selected}
      className={`${classes} cursor-pointer outline-none hover:bg-blue-200/70 focus-visible:bg-blue-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-blue-900/60 dark:focus-visible:bg-blue-900 ${selected ? "bg-blue-200 text-blue-950 dark:bg-blue-900 dark:text-blue-100" : ""}`}
      data-comment-gutter={gutter}
      data-gutter={gutter}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onSelect(anchor, event.shiftKey)
      }
      title="Click to give Claude feedback. Shift-click to select a range."
      type="button"
    >
      {anchor.line}
    </button>
  );
}

const FilePatch = memo(function FilePatch({
  file,
  onSelect,
  selection,
}: {
  file: PullDiffFile;
  onSelect: (anchor: CommentAnchor, shift: boolean) => void;
  selection: CommentSelection | null;
}) {
  if (file.hunks.length === 0) {
    return <FilePlaceholder file={file} />;
  }

  return (
    <div className="overflow-x-auto font-mono text-[11px] leading-5 sm:text-xs">
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunkIndex}`}>
          <div className="min-w-max border-y border-blue-200 bg-blue-50 px-3 py-1 text-blue-800 first:border-t-0 dark:border-blue-900/70 dark:bg-blue-950/45 dark:text-blue-300">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => {
            const left = file.truncated
              ? null
              : anchorFor(file, hunkIndex, lineIndex, line, "LEFT");
            const right = file.truncated
              ? null
              : anchorFor(file, hunkIndex, lineIndex, line, "RIGHT");
            const lineSelected =
              selectedAnchor(selection, left) ||
              selectedAnchor(selection, right);

            return (
              <div
                className={`grid min-w-max grid-cols-[3rem_3rem_minmax(max-content,1fr)] ${lineStyles[line.kind]} ${lineSelected ? "outline-1 -outline-offset-1 outline-blue-500" : ""}`}
                data-comment-selected={lineSelected ? "" : undefined}
                data-line-kind={line.kind}
                key={`${hunkIndex}-${lineIndex}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
              >
                <DiffGutter
                  anchor={left}
                  gutter="old"
                  onSelect={onSelect}
                  selected={selectedAnchor(selection, left)}
                  value={line.oldLine}
                />
                <DiffGutter
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
                  {line.content || "\u00a0"}
                </code>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

const DiffFile = memo(function DiffFile({
  diff,
  file,
  id,
  onCancelComment,
  onSelectComment,
  pull,
  register,
  run,
  selection,
  startRun,
  toggleViewed,
  viewed,
}: {
  diff: PullDiffData;
  file: PullDiffFile;
  id: string;
  onCancelComment: () => void;
  onSelectComment: (anchor: CommentAnchor, shift: boolean) => void;
  pull: PullReadiness;
  register: (path: string, node: HTMLElement | null) => void;
  run: RunState;
  selection: CommentSelection | null;
  startRun: PullRuns["start"];
  toggleViewed: (path: string) => void;
  viewed: boolean;
}) {
  const bodyId = `${id}-body`;
  const checkboxId = `${id}-viewed`;
  const registerSection = useCallback(
    (node: HTMLElement | null) => register(file.path, node),
    [file.path, register],
  );
  const handleViewedChange = useCallback(
    () => toggleViewed(file.path),
    [file.path, toggleViewed],
  );

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="scroll-mt-3 overflow-hidden rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      id={id}
      ref={registerSection}
      tabIndex={-1}
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 border-b bg-muted/35 px-3 py-2">
        <FileCode2
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <h4
          className="m-0 min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs font-medium"
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
      </header>
      {!viewed && (
        <div id={bodyId}>
          <FilePatch
            file={file}
            onSelect={onSelectComment}
            selection={selection}
          />
          {file.truncated && file.hunks.length > 0 && (
            <div className="flex items-center gap-2 border-t bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              GitHub returned only part of this file's patch.
            </div>
          )}
          {selection !== null && selection.start.path === file.path && (
            <ReviewComposer
              diff={diff}
              key={`${selection.origin.hunkIndex}:${selection.origin.side}:${selection.origin.lineIndex}:${selection.start.line}:${selection.end.line}`}
              onCancel={onCancelComment}
              pull={pull}
              run={run}
              selection={selection}
              startRun={startRun}
            />
          )}
        </div>
      )}
    </section>
  );
});

type FileNavigationProps = {
  activate: (path: string) => void;
  fileIds: readonly string[];
  files: PullDiffFile[];
  navigate: (path: string) => void;
  selected: string | null;
  visibleCount: number;
};

const FileNavigation = memo(function FileNavigation({
  activate,
  fileIds,
  files,
  navigate,
  selected,
  visibleCount,
}: FileNavigationProps) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-file-index]",
      );
      if (!button || !event.currentTarget.contains(button)) return;

      const index = Number(button.dataset.fileIndex);
      let next = index;

      if (event.key === "ArrowDown") {
        next = Math.min(files.length - 1, index + 1);
      } else if (event.key === "ArrowUp") {
        next = Math.max(0, index - 1);
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = files.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const file = files[next];
      if (!file) return;

      navigate(file.path);
      event.currentTarget
        .querySelector<HTMLButtonElement>(`button[data-file-index="${next}"]`)
        ?.focus();
    },
    [files, navigate],
  );

  return (
    <nav
      aria-label="Changed files"
      className="flex max-w-full gap-1 overflow-x-auto p-2 lg:max-h-[70vh] lg:flex-col lg:overflow-auto"
      onKeyDown={handleKeyDown}
    >
      {files.map((file, index) => (
        <button
          aria-controls={
            index < visibleCount || selected === file.path
              ? fileIds[index]
              : undefined
          }
          aria-current={selected === file.path ? "true" : undefined}
          className="flex min-h-11 w-max min-w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
          data-file-index={index}
          key={file.path}
          onClick={() => activate(file.path)}
          tabIndex={selected === file.path ? 0 : -1}
          type="button"
        >
          <FileCode2
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex-1 whitespace-nowrap font-mono">
            {file.path}
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
      ))}
    </nav>
  );
});

function PullDiff({
  diff,
  pull,
  run,
  startRun,
  toggleViewed,
  viewed,
}: PullDiffProps) {
  const identifier = useId();
  const reducedMotion = useReducedMotion();
  const files = useRef(new Map<string, HTMLElement>());
  const toggleViewedRef = useRef(toggleViewed);
  const [selected, setSelected] = useState(diff.files[0]?.path ?? null);
  const [commentSelection, setCommentSelection] =
    useState<CommentSelection | null>(null);
  const [selectionAnnouncement, setSelectionAnnouncement] = useState("");
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(FILE_BATCH_SIZE, diff.files.length),
  );
  const pendingSelection = useRef<string | null>(null);
  toggleViewedRef.current = toggleViewed;
  const fileIds = useMemo(
    () =>
      diff.files.map((_file, index) => `pull-diff-${identifier}-file-${index}`),
    [diff.files, identifier],
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

  useEffect(() => {
    if (!diff.files.some(({ path }) => path === selected)) {
      setSelected(diff.files[0]?.path ?? null);
    }
  }, [diff.files, selected]);

  useEffect(() => {
    if (commentSelection === null) return;
    const current = diff.files.find(
      ({ path }) => path === commentSelection.start.path,
    );
    if (!current || current.truncated) {
      setCommentSelection(null);
      setSelectionAnnouncement(
        "The selected Claude feedback lines are no longer available.",
      );
    }
  }, [commentSelection, diff.files]);

  const registerFile = useCallback((path: string, node: HTMLElement | null) => {
    if (node) files.current.set(path, node);
    else files.current.delete(path);
  }, []);
  const handleToggleViewed = useCallback((path: string) => {
    setCommentSelection((current) =>
      current?.start.path === path ? null : current,
    );
    toggleViewedRef.current(path);
  }, []);
  const cancelComment = useCallback(() => {
    setCommentSelection(null);
    setSelectionAnnouncement("Claude feedback selection cleared.");
  }, []);
  const selectComment = useCallback(
    (anchor: CommentAnchor, shift: boolean) => {
      setSelected(anchor.path);
      if (!shift || commentSelection === null) {
        const next = { end: anchor, origin: anchor, start: anchor };
        setCommentSelection(next);
        setSelectionAnnouncement(`Selected ${selectionLabel(next)}.`);
        return;
      }
      if (commentSelection.origin.path !== anchor.path) {
        setSelectionAnnouncement(
          "Keep the Claude feedback selection within one file.",
        );
        return;
      }
      if (commentSelection.origin.hunkIndex !== anchor.hunkIndex) {
        setSelectionAnnouncement(
          "Keep the Claude feedback selection within one diff hunk.",
        );
        return;
      }
      if (commentSelection.origin.side !== anchor.side) {
        setSelectionAnnouncement(
          "Keep the Claude feedback selection on the same side of the diff.",
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
      setCommentSelection(next);
      setSelectionAnnouncement(`Selected ${selectionLabel(next)}.`);
    },
    [commentSelection, diff.files],
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
      setSelected(path);
      setCommentSelection((current) =>
        current?.start.path === path ? current : null,
      );
      pendingSelection.current = null;
      if (focusFile(path)) return;

      const index = diff.files.findIndex((file) => file.path === path);
      if (index < 0) return;

      pendingSelection.current = path;
    },
    [diff.files, focusFile],
  );
  const navigateFile = useCallback((path: string) => {
    pendingSelection.current = null;
    setSelected(path);
    setCommentSelection((current) =>
      current?.start.path === path ? current : null,
    );
  }, []);

  useEffect(() => {
    const path = pendingSelection.current;
    if (path && focusFile(path)) pendingSelection.current = null;
  }, [focusFile, selected, visibleCount]);

  const shown = Math.min(visibleCount, diff.files.length);
  const selectedIndex = diff.files.findIndex((file) => file.path === selected);
  const renderedCount =
    shown +
    (selectedIndex >= shown && selectedIndex < diff.files.length ? 1 : 0);
  const remaining = diff.files.length - renderedCount;
  const nextShown = Math.min(diff.files.length, shown + FILE_BATCH_SIZE);
  const nextRenderedCount =
    nextShown +
    (selectedIndex >= nextShown && selectedIndex < diff.files.length ? 1 : 0);
  const revealCount = nextRenderedCount - renderedCount;

  return (
    <div
      aria-label={`Files changed for ${diff.repository} pull request ${diff.number}`}
      className="mt-3 overflow-hidden rounded-xl border bg-background"
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
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
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
        <code className="ml-auto text-[11px] text-muted-foreground">
          {diff.headRefOid.slice(0, 7)}
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
        <div className="grid min-w-0 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="min-w-0 border-b bg-muted/15 lg:sticky lg:top-3 lg:self-start lg:border-r lg:border-b-0">
            <FileNavigation
              activate={selectFile}
              fileIds={fileIds}
              files={diff.files}
              navigate={navigateFile}
              selected={selected}
              visibleCount={shown}
            />
          </aside>

          <div className="min-w-0 space-y-3 p-2 sm:p-3">
            {diff.files.map((file, index) =>
              index < shown || file.path === selected ? (
                <DiffFile
                  diff={diff}
                  file={file}
                  id={fileIds[index]!}
                  key={file.path}
                  onCancelComment={cancelComment}
                  onSelectComment={selectComment}
                  pull={pull}
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
                  onClick={() =>
                    setVisibleCount((count) =>
                      Math.min(diff.files.length, count + FILE_BATCH_SIZE),
                    )
                  }
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
