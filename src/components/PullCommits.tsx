import {
  ChevronRight,
  CircleAlert,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import {
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  getPullCommitDiff,
  getPullCommits,
  PullCommitsHttpError,
} from "../api";
import type { PullRuns, RunState } from "../runs";
import { formatRelativeTime } from "../time";
import type {
  Agent,
  PullCommit,
  PullCommitDiff,
  PullCommits as PullCommitsData,
  PullReadiness,
} from "../types";
import PullDiff, { type PullDiffPersistence } from "./PullDiff";

export type PullCommitsPersistence = Readonly<{
  diffs: Readonly<Record<string, PullDiffPersistence>>;
  listWidth: number;
  listVisible: boolean;
  selectedSha: string | null;
  viewed: Readonly<Record<string, readonly string[]>>;
}>;

export type PullCommitsProps = {
  agent?: Agent;
  clearReviewRetry: PullRuns["clearReviewRetry"];
  onPersistenceChange?: (persistence: PullCommitsPersistence) => void;
  persistence?: PullCommitsPersistence;
  pull: PullReadiness;
  run: RunState;
  startRun: PullRuns["start"];
  viewerLogin: string;
};

type CommitsState =
  | { status: "idle" }
  | { status: "loading" }
  | { message: string; status: "error" }
  | { commits: PullCommitsData; status: "success" };

type CommitDiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { message: string; status: "error" }
  | { diff: PullCommitDiff; status: "success" };

type CommitDiffIdentity = {
  sha: string | null;
  state: CommitDiffState;
};

const LIST_DEFAULT_WIDTH = 240;
const LIST_MAX_WIDTH = 420;
const LIST_MIN_WIDTH = 176;
const SPLIT_LAYOUT_QUERY = "(min-width: 64rem)";

const splitLayoutActive = (): boolean =>
  typeof window.matchMedia !== "function" ||
  window.matchMedia(SPLIT_LAYOUT_QUERY).matches;

const createPersistence = (): PullCommitsPersistence => ({
  diffs: {},
  listWidth: LIST_DEFAULT_WIDTH,
  listVisible: true,
  selectedSha: null,
  viewed: {},
});

const listWidth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, value))
    : LIST_DEFAULT_WIDTH;

export const normalizePullCommitsPersistence = (
  persistence: PullCommitsPersistence,
): PullCommitsPersistence => {
  const normalizedVisible = true;
  const normalizedWidth = listWidth(persistence.listWidth);
  return normalizedVisible === persistence.listVisible &&
    normalizedWidth === persistence.listWidth
    ? persistence
    : {
        ...persistence,
        listVisible: normalizedVisible,
        listWidth: normalizedWidth,
      };
};

const safeError = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/\s+/g, " ").trim().slice(0, 300);
  return message || fallback;
};

const commitTitle = (commit: PullCommit): string =>
  commit.message.split(/\r?\n/, 1)[0]?.trim() || "Untitled commit";

const absoluteDate = (value: string): string | undefined => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
};

const samePersistence = (
  left: PullCommitsPersistence,
  right: PullCommitsPersistence,
): boolean =>
  left.listVisible === right.listVisible &&
  left.listWidth === right.listWidth &&
  left.selectedSha === right.selectedSha &&
  left.diffs === right.diffs &&
  left.viewed === right.viewed;

function CommitList({
  commits,
  onSelect,
  selectedSha,
}: {
  commits: PullCommit[];
  onSelect: (sha: string) => void;
  selectedSha: string | null;
}) {
  const ordered = useMemo(() => [...commits].reverse(), [commits]);

  return (
    <ul
      aria-label="Pull request commits"
      className="m-0 grid min-w-0 max-w-full list-none gap-1 overflow-hidden p-2"
    >
      {ordered.map((commit) => {
        const selected = commit.sha === selectedSha;
        const title = commitTitle(commit);
        return (
          <li className="min-w-0 max-w-full overflow-hidden" key={commit.sha}>
            <Button
              aria-current={selected ? "true" : undefined}
              aria-label={`${title}, commit ${commit.sha.slice(0, 7)}`}
              aria-pressed={selected}
              className="h-auto w-full min-w-0 max-w-full justify-start gap-2 overflow-hidden px-2.5 py-2 text-left"
              data-commit-selected={selected ? "" : undefined}
              data-pull-focus-token={`commit:${commit.sha}`}
              onClick={() => onSelect(commit.sha)}
              type="button"
              variant={selected ? "secondary" : "ghost"}
            >
              <GitCommitHorizontal
                aria-hidden="true"
                className="size-3.5 shrink-0 self-start text-muted-foreground"
              />
              <span className="min-w-0 max-w-full flex-1 overflow-hidden">
                <span
                  className="block max-w-full truncate text-xs font-medium text-foreground"
                  title={title}
                >
                  {title}
                </span>
                <span className="mt-1 flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
                  <code className="shrink-0 font-mono">
                    {commit.sha.slice(0, 7)}
                  </code>
                  <span aria-hidden="true">·</span>
                  <span className="min-w-0 truncate">{commit.authorName}</span>
                  <span aria-hidden="true">·</span>
                  <time
                    className="shrink-0"
                    dateTime={commit.authoredAt}
                    title={absoluteDate(commit.authoredAt)}
                  >
                    {formatRelativeTime(commit.authoredAt)}
                  </time>
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function LoadState({
  label,
  message,
  retry,
  status,
}: {
  label: string;
  message?: string;
  retry?: () => void;
  status: "error" | "loading";
}) {
  if (status === "loading") {
    return (
      <div
        aria-live="polite"
        className="flex min-h-24 items-center justify-center gap-2 rounded-xl border text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        {label}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-16 flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 wrap-anywhere">{message}</span>
      <Button onClick={retry} size="sm" type="button" variant="outline">
        Retry
      </Button>
    </div>
  );
}

function PullCommits({
  agent = "claude",
  clearReviewRetry,
  onPersistenceChange,
  persistence,
  pull,
  run,
  startRun,
  viewerLogin,
}: PullCommitsProps) {
  const [localPersistence, setLocalPersistence] =
    useState<PullCommitsPersistence>(createPersistence);
  const persistenceSource = persistence ?? localPersistence;
  const currentPersistence = normalizePullCommitsPersistence(persistenceSource);
  const persistenceRef = useRef(currentPersistence);
  const controlled = persistence !== undefined;
  persistenceRef.current = currentPersistence;
  const layout = useRef<HTMLDivElement>(null);
  const resize = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);

  const updatePersistence = useCallback(
    (
      update: (current: PullCommitsPersistence) => PullCommitsPersistence,
    ): void => {
      const previous = persistenceRef.current;
      const next = update(previous);
      if (samePersistence(previous, next)) return;
      persistenceRef.current = next;
      if (!controlled) setLocalPersistence(next);
      onPersistenceChange?.(next);
    },
    [controlled, onPersistenceChange],
  );

  const [reloadCommits, setReloadCommits] = useState(0);
  const [reloadDiff, setReloadDiff] = useState(0);
  const [commitsState, setCommitsState] = useState<CommitsState>({
    status: "idle",
  });
  const [diffIdentity, setDiffIdentity] = useState<CommitDiffIdentity>({
    sha: null,
    state: { status: "idle" },
  });
  const identity = useMemo(
    () => ({
      baseRefOid: pull.baseRefOid,
      headRefOid: pull.headRefOid,
      number: pull.number,
      repository: pull.repository,
      viewerLogin,
    }),
    [
      pull.baseRefOid,
      pull.headRefOid,
      pull.number,
      pull.repository,
      viewerLogin,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setCommitsState({ status: "loading" });
    void getPullCommits(identity, controller.signal).then(
      (commits) => {
        if (!controller.signal.aborted) {
          setCommitsState({ commits, status: "success" });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const fallback =
          error instanceof PullCommitsHttpError &&
          error.code === "pull_incomplete"
            ? "The pull request changed while its commits were loading."
            : "The pull request commits could not be loaded.";
        setCommitsState({
          message: safeError(error, fallback),
          status: "error",
        });
      },
    );
    return () => controller.abort();
  }, [identity, reloadCommits]);

  const commits =
    commitsState.status === "success" ? commitsState.commits.commits : [];
  const selectedSha = useMemo(() => {
    if (commits.length === 0) return null;
    const persisted = currentPersistence.selectedSha;
    return persisted !== null &&
      commits.some((commit) => commit.sha === persisted)
      ? persisted
      : commits.at(-1)!.sha;
  }, [commits, currentPersistence.selectedSha]);

  useEffect(() => {
    if (
      commitsState.status !== "success" ||
      selectedSha === currentPersistence.selectedSha
    ) {
      return;
    }
    updatePersistence((current) => ({ ...current, selectedSha }));
  }, [
    commitsState.status,
    currentPersistence.selectedSha,
    selectedSha,
    updatePersistence,
  ]);

  const currentDiffState =
    diffIdentity.sha === selectedSha
      ? diffIdentity.state
      : ({ status: "idle" } as const);

  useEffect(() => {
    if (selectedSha === null) {
      setDiffIdentity({ sha: null, state: { status: "idle" } });
      return;
    }
    const controller = new AbortController();
    setDiffIdentity({ sha: selectedSha, state: { status: "loading" } });
    void getPullCommitDiff(identity, selectedSha, controller.signal).then(
      (diff) => {
        if (!controller.signal.aborted) {
          setDiffIdentity({
            sha: selectedSha,
            state: { diff, status: "success" },
          });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setDiffIdentity({
            sha: selectedSha,
            state: {
              message: safeError(
                error,
                "The selected commit diff could not be loaded.",
              ),
              status: "error",
            },
          });
        }
      },
    );
    return () => controller.abort();
  }, [identity, reloadDiff, selectedSha]);

  const selectCommit = useCallback(
    (sha: string) => {
      updatePersistence((current) => ({
        ...current,
        selectedSha: sha,
      }));
    },
    [updatePersistence],
  );
  const maximumListWidth = useCallback((): number => {
    const width = layout.current?.getBoundingClientRect().width ?? 0;
    return width > 0
      ? Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, width - 320))
      : LIST_MAX_WIDTH;
  }, []);
  const setListWidth = useCallback(
    (width: number) => {
      const maximum = maximumListWidth();
      updatePersistence((current) => ({
        ...current,
        listWidth: Math.min(maximum, Math.max(LIST_MIN_WIDTH, width)),
      }));
    },
    [maximumListWidth, updatePersistence],
  );
  useLayoutEffect(() => {
    const reclamp = (): void => {
      if (!splitLayoutActive()) return;
      setListWidth(persistenceRef.current.listWidth);
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
  }, [commitsState.status, setListWidth]);
  const beginListResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    resize.current = {
      pointerId: event.pointerId,
      startWidth: persistenceRef.current.listWidth,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);
  const resizeList = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = resize.current;
      if (!current || current.pointerId !== event.pointerId) return;
      setListWidth(current.startWidth + event.clientX - current.startX);
    },
    [setListWidth],
  );
  const finishListResize = useCallback(
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
        width = persistenceRef.current.listWidth - 16;
      } else if (event.key === "ArrowRight") {
        width = persistenceRef.current.listWidth + 16;
      } else if (event.key === "Home") {
        width = LIST_MIN_WIDTH;
      } else if (event.key === "End") {
        width = maximumListWidth();
      } else {
        return;
      }
      event.preventDefault();
      setListWidth(width);
    },
    [maximumListWidth, setListWidth],
  );

  const saveDiffPersistence = useCallback(
    (next: PullDiffPersistence) => {
      if (selectedSha === null) return;
      updatePersistence((current) =>
        current.diffs[selectedSha] === next
          ? current
          : {
              ...current,
              diffs: { ...current.diffs, [selectedSha]: next },
            },
      );
    },
    [selectedSha, updatePersistence],
  );
  const viewed = useMemo(
    () =>
      new Set(
        selectedSha === null
          ? []
          : (currentPersistence.viewed[selectedSha] ?? []),
      ),
    [currentPersistence.viewed, selectedSha],
  );
  const toggleViewed = useCallback(
    (path: string) => {
      if (selectedSha === null) return;
      updatePersistence((current) => {
        const paths = new Set(current.viewed[selectedSha] ?? []);
        if (paths.has(path)) paths.delete(path);
        else paths.add(path);
        const next = { ...current.viewed };
        if (paths.size === 0) delete next[selectedSha];
        else next[selectedSha] = [...paths].sort();
        return { ...current, viewed: next };
      });
    },
    [selectedSha, updatePersistence],
  );

  if (commitsState.status === "idle" || commitsState.status === "loading") {
    return <LoadState label="Loading commits…" status="loading" />;
  }

  if (commitsState.status === "error") {
    return (
      <LoadState
        label="Loading commits…"
        message={commitsState.message}
        retry={() => setReloadCommits((value) => value + 1)}
        status="error"
      />
    );
  }

  return (
    <section
      aria-label={`Commits for ${pull.repository} pull request ${pull.number}`}
      className="w-full min-w-0 rounded-xl border bg-background"
      data-pull-commits=""
    >
      <header className="flex min-h-10 items-center gap-2 rounded-t-xl border-b bg-muted/30 px-3 py-2 text-xs">
        <GitCommitHorizontal
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
        <span className="font-medium">Commits</span>
        <Badge className="tabular-nums" variant="secondary">
          {commitsState.commits.count}
        </Badge>
        {!commitsState.commits.complete && (
          <span className="text-amber-700 dark:text-amber-300">
            {commits.length} shown
          </span>
        )}
      </header>

      {!commitsState.commits.complete && (
        <div
          className="flex items-start gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950/35 dark:text-amber-100"
          role="status"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>
            {commitsState.commits.warning ??
              "GitHub returned only part of this pull request's commit history."}
          </span>
        </div>
      )}

      {commits.length === 0 ? (
        <p className="m-0 px-4 py-8 text-center text-sm text-muted-foreground">
          No commits were returned for this pull request.
        </p>
      ) : (
        <div
          className="grid min-w-0"
          data-commit-layout=""
          data-list-visible="true"
          ref={layout}
          style={
            {
              "--commit-list-width": `${currentPersistence.listWidth}px`,
            } as CSSProperties
          }
        >
          <>
            <div
              className="w-full min-w-0 max-w-full overflow-hidden border-b bg-muted/15 lg:sticky lg:top-10 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-auto lg:border-r lg:border-b-0"
              data-commit-list-pane=""
            >
              <aside className="w-full min-w-0 max-w-full overflow-hidden">
                <CommitList
                  commits={commits}
                  onSelect={selectCommit}
                  selectedSha={selectedSha}
                />
              </aside>
            </div>
            <div
              aria-label="Resize commits pane"
              aria-orientation="vertical"
              aria-valuemax={Math.round(maximumListWidth())}
              aria-valuemin={LIST_MIN_WIDTH}
              aria-valuenow={Math.round(currentPersistence.listWidth)}
              className="group relative hidden cursor-col-resize touch-none bg-border outline-none hover:bg-ring focus-visible:bg-ring lg:block"
              data-commit-list-resizer=""
              onKeyDown={handleSeparatorKeyDown}
              onPointerCancel={finishListResize}
              onPointerDown={beginListResize}
              onPointerMove={resizeList}
              onPointerUp={finishListResize}
              role="separator"
              tabIndex={0}
            >
              <span className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
            </div>
          </>
          <div
            aria-busy={
              currentDiffState.status === "idle" ||
              currentDiffState.status === "loading"
            }
            className="min-w-0 p-2 sm:p-3 [&_[data-pull-diff]]:mt-0"
          >
            {(currentDiffState.status === "idle" ||
              currentDiffState.status === "loading") && (
              <LoadState label="Loading commit changes…" status="loading" />
            )}
            {currentDiffState.status === "error" && (
              <LoadState
                label="Loading commit changes…"
                message={currentDiffState.message}
                retry={() => setReloadDiff((value) => value + 1)}
                status="error"
              />
            )}
            {currentDiffState.status === "success" &&
              selectedSha !== null &&
              currentDiffState.diff.commitSha === selectedSha && (
                <PullDiff
                  agent={agent}
                  clearReviewRetry={clearReviewRetry}
                  diff={currentDiffState.diff}
                  key={selectedSha}
                  onPersistenceChange={saveDiffPersistence}
                  persistence={currentPersistence.diffs[selectedSha]}
                  pull={pull}
                  readOnly
                  run={run}
                  startRun={startRun}
                  toggleViewed={toggleViewed}
                  viewed={viewed}
                />
              )}
          </div>
        </div>
      )}
    </section>
  );
}

export default memo(PullCommits);
