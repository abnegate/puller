import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  GitMerge,
  LoaderCircle,
  SquareTerminal,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  type MouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

import { getPullDiff, mergePull, PullDiffHttpError } from "../api";
import {
  getPullDiffKey,
  type ToggleViewedFile,
  type ViewedFiles,
} from "../diffs";
import type { PullMovement } from "../movements";
import { getPullKey, type PullKey } from "../preferences";
import {
  isRunActive,
  type PullRuns,
  type RunState,
  type RunStatus,
} from "../runs";
import { formatRelativeTime } from "../time";
import type {
  MergePullResponse,
  PullDiff as PullDiffData,
  PullReadiness,
} from "../types";
import BlockerDetails from "./BlockerDetails";
import PullActionsMenu, { PullFavoriteIndicator } from "./PullActionsMenu";
import PullDiff from "./PullDiff";

type PullRowProps = {
  artifactEpoch: number;
  cancelRun: PullRuns["cancel"];
  favorite?: boolean;
  hidePull?: (key: PullKey) => void;
  movement?: PullMovement | null;
  onMutationComplete?: (
    pull: PullReadiness,
    response: MergePullResponse,
  ) => void;
  onToggleViewed: ToggleViewedFile;
  pull: PullReadiness;
  run: RunState;
  setFavorite?: (key: PullKey, favorite: boolean) => void;
  setRunMessage: PullRuns["setMessage"];
  startRun: PullRuns["start"];
  variant: "ready" | "progress" | "blocked";
  viewerLogin: string | null;
  viewedFiles: ViewedFiles;
};

type DiffState =
  | { status: "idle" | "loading" }
  | { error: string; status: "error" }
  | { diff: PullDiffData; status: "success" };

type MergeState = "idle" | "loading" | "success";

const statusLabels: Record<Exclude<RunStatus, "idle">, string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  limited: "Limited",
  running: "Running",
  starting: "Starting",
};

const getStatusLabel = (status: RunStatus): string =>
  status === "idle" ? "Idle" : statusLabels[status];

const getRunLabel = (run: RunState): string => {
  if (run.kind === "repair") return "Conflict repair";
  if (run.source === "auto") return "Auto fix";
  return run.source === "review" ? "Review fix" : "Claude";
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatAbsoluteDate = (updatedAt: string): string | undefined => {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? undefined : dateFormatter.format(date);
};

const safeError = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;

  const message = error.message.replace(/\s+/g, " ").trim().slice(0, 300);
  return message || fallback;
};

const getFallbackBlockers = (pull: PullReadiness): string[] => {
  const blockers: string[] = [];

  if (pull.unresolved > 0) {
    blockers.push(
      `${pull.unresolved} unresolved review ${pull.unresolved === 1 ? "comment" : "comments"}`,
    );
  }

  if (pull.greptile.confidence === null) {
    blockers.push("Greptile confidence is not available");
  } else if (pull.greptile.confidence < 5) {
    blockers.push(`Greptile confidence is ${pull.greptile.confidence}/5`);
  }

  if (
    pull.greptile.reviewedSha &&
    pull.greptile.reviewedSha.toLowerCase() !== pull.headRefOid.toLowerCase()
  ) {
    blockers.push("Greptile review is for an older commit");
  }

  if (pull.ci.state === "pending") {
    blockers.push("CI checks pending");
  } else if (pull.ci.state === "failure") {
    blockers.push("CI checks failed");
  } else if (pull.ci.state === "unknown") {
    blockers.push("CI checks could not be fully checked");
  }

  return blockers.length > 0 ? blockers : ["Readiness evidence is incomplete"];
};

const getReadyEvidence = (pull: PullReadiness): string =>
  `${pull.unresolved} unresolved ${pull.unresolved === 1 ? "comment" : "comments"} · Greptile ${pull.greptile.confidence}/5 · ${
    pull.ci.state === "none" ? "No CI checks reported" : "CI passed"
  }`;

const getCIProgress = (pull: PullReadiness): string => {
  const { passed, total } = pull.ci;

  if (typeof passed === "number" && typeof total === "number") {
    if (total === 0) return "No CI checks reported";
    return `${passed} of ${total} checks passed`;
  }

  if (pull.ci.state === "pending") return "CI checks running";
  if (pull.ci.state === "success") return "CI checks passed";
  if (pull.ci.state === "failure") return "CI checks failed";
  if (pull.ci.state === "none") return "No CI checks reported";
  return "CI check progress unavailable";
};

const stopControlClick = (event: MouseEvent<HTMLElement>) => {
  event.stopPropagation();
};

function MovementIndicator({ movement }: { movement?: PullMovement | null }) {
  if (!movement) return null;
  const Icon = movement.direction === "up" ? ArrowUp : ArrowDown;

  return (
    <span
      aria-label={movement.label}
      className={`inline-flex shrink-0 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 ${
        movement.direction === "up"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-500/80 dark:text-red-400/80"
      }`}
      data-movement-direction={movement.direction}
      data-pull-movement=""
      role="status"
      title={movement.label}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
  );
}

function PullSummary({ pull }: { pull: PullReadiness }) {
  const relative = formatRelativeTime(pull.updatedAt);
  const absolute = formatAbsoluteDate(pull.updatedAt);

  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="m-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{pull.repository}</span>
        <span aria-hidden="true"> · </span>
        <span>#{pull.number}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={pull.updatedAt} title={absolute}>
          Updated {relative}
        </time>
      </p>
      <a
        className="inline-flex min-h-11 max-w-full items-center py-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:text-base"
        href={pull.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        <span className="min-w-0 wrap-anywhere">{pull.title}</span>
      </a>
    </div>
  );
}

function BlockerList({
  blockers,
  tone = "danger",
}: {
  blockers: string[];
  tone?: "danger" | "warning";
}) {
  return (
    <ul aria-label="Blockers" className="mt-2 grid gap-1">
      {blockers.map((blocker, index) => (
        <li
          className="flex items-start gap-2 text-xs text-foreground"
          key={`${blocker}-${index}`}
        >
          <CircleAlert
            aria-hidden="true"
            className={`mt-0.5 size-3.5 shrink-0 ${
              tone === "warning"
                ? "text-amber-600 dark:text-amber-400"
                : "text-destructive"
            }`}
          />
          <span className="min-w-0 wrap-anywhere">{blocker}</span>
        </li>
      ))}
    </ul>
  );
}

function RunOutput({ pull, run }: { pull: PullReadiness; run: RunState }) {
  const terminalRef = useRef<HTMLPreElement>(null);
  const followOutputRef = useRef(true);
  const active = isRunActive(run);
  const visible = run.status !== "idle";

  useLayoutEffect(() => {
    if (run.status === "starting") {
      followOutputRef.current = true;
    }

    const terminal = terminalRef.current;
    if (terminal && followOutputRef.current) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }, [run.output, run.status]);

  const handleScroll = (event: UIEvent<HTMLPreElement>) => {
    const terminal = event.currentTarget;
    followOutputRef.current =
      terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 32;
  };

  return (
    <Card
      className={visible ? "mt-3 w-full gap-0 py-0" : "hidden"}
      data-output-card=""
      hidden={!visible}
      size="sm"
    >
      {visible && (
        <div className="flex min-h-9 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
          {active ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
          ) : (
            <SquareTerminal aria-hidden="true" className="size-3.5" />
          )}
          <span className="font-medium text-foreground">
            {run.kind === "repair"
              ? "Conflict repair"
              : run.source === "auto"
                ? "Auto fix"
                : run.source === "review"
                  ? "Review fix"
                  : "Claude output"}
          </span>
          <Badge
            aria-live="polite"
            className="ml-auto"
            role="status"
            variant={
              run.status === "failed" || run.status === "limited"
                ? "destructive"
                : "outline"
            }
          >
            {getStatusLabel(run.status)}
          </Badge>
        </div>
      )}
      <pre
        aria-busy={active}
        aria-label={`${getRunLabel(run)} output for ${pull.repository} pull request ${pull.number}`}
        aria-live="polite"
        className="max-h-56 min-h-16 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-foreground"
        hidden={!visible}
        onScroll={handleScroll}
        ref={terminalRef}
        role="log"
        tabIndex={0}
      >
        {run.output}
      </pre>
    </Card>
  );
}

function FixPanel({
  cancelRun,
  pull,
  run,
  setRunMessage,
  startRun,
}: Omit<
  PullRowProps,
  | "artifactEpoch"
  | "favorite"
  | "hidePull"
  | "onMutationComplete"
  | "onToggleViewed"
  | "setFavorite"
  | "variant"
  | "viewerLogin"
  | "viewedFiles"
>) {
  const inputId = useId();
  const active = isRunActive(run);

  return (
    <div>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void startRun(pull);
        }}
      >
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={inputId}
        >
          Fix instructions for {pull.repository} #{pull.number}
          <span
            aria-hidden="true"
            className="ml-1 font-normal text-muted-foreground"
          >
            (optional)
          </span>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Textarea
            className="field-sizing-content min-h-11 max-h-32 resize-none overflow-y-auto sm:min-h-8 sm:py-1 sm:text-sm"
            disabled={active}
            id={inputId}
            onChange={(event) => setRunMessage(pull.url, event.target.value)}
            placeholder="Leave blank to fix every readiness blocker."
            rows={1}
            value={run.message}
          />
          <div className="flex shrink-0 gap-2">
            <Button
              className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
              disabled={active}
              type="submit"
            >
              {active && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              Run fix
            </Button>
            {active && (
              <Button
                className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
                disabled={run.cancelling}
                onClick={() => void cancelRun(pull.url)}
                type="button"
                variant="outline"
              >
                <X aria-hidden="true" />
                {run.cancelling ? "Cancelling" : "Cancel"}
              </Button>
            )}
          </div>
        </div>
      </form>

      <RunOutput pull={pull} run={run} />
    </div>
  );
}

function ProgressBadge({ run }: { run: RunState }) {
  const active = isRunActive(run);

  return (
    <Badge
      className="border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      variant="outline"
    >
      {active ? (
        <LoaderCircle
          aria-hidden="true"
          className="animate-spin"
          data-icon="inline-start"
        />
      ) : (
        <CircleDotDashed aria-hidden="true" data-icon="inline-start" />
      )}
      {active
        ? `${getRunLabel(run)} ${getStatusLabel(run.status).toLowerCase()}`
        : "CI running"}
    </Badge>
  );
}

type DiffDisclosure = {
  available: boolean;
  contentId: string;
  expanded: boolean;
  retry: (event: MouseEvent<HTMLElement>) => void;
  state: DiffState;
  toggle: (event: MouseEvent<HTMLElement>) => void;
  toggleViewed: (path: string) => void;
  viewed: ReadonlySet<string>;
};

type DiffIdentityState = {
  key: string;
  state: DiffState;
};

export function useDiffDisclosure(
  pull: PullReadiness,
  viewerLogin: string | null,
  artifactEpoch: number,
  viewed: ViewedFiles,
  onToggleViewed: ToggleViewedFile,
): DiffDisclosure {
  const contentId = useId();
  const pullRef = useRef(pull);
  const [expanded, setExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const available = viewerLogin !== null;
  const key = getPullDiffKey(pull, viewerLogin, artifactEpoch);
  const keyRef = useRef(key);
  keyRef.current = key;
  pullRef.current = pull;
  const [identity, setIdentity] = useState<DiffIdentityState>(() => ({
    key,
    state: { status: "idle" },
  }));

  if (identity.key !== key) {
    setIdentity({ key, state: { status: "idle" } });
  }

  const current: DiffIdentityState =
    identity.key === key ? identity : { key, state: { status: "idle" } };
  const setState = useCallback(
    (state: DiffState) => {
      setIdentity((value) => (value.key === key ? { ...value, state } : value));
    },
    [key],
  );

  useEffect(() => {
    if (!expanded || !available) return;

    const controller = new AbortController();
    let current = true;
    setState({ status: "loading" });

    void getPullDiff(
      {
        baseRefOid: pull.baseRefOid,
        headRefOid: pull.headRefOid,
        number: pull.number,
        repository: pull.repository,
        viewerLogin,
      },
      controller.signal,
    )
      .then((diff) => {
        if (!current) return;
        setState({ diff, status: "success" });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted || keyRef.current !== key)
          return;
        if (
          error instanceof PullDiffHttpError &&
          error.code === "pull_incomplete"
        ) {
          setState({ status: "idle" });
          setExpanded(false);
          return;
        }
        setState({
          error: safeError(error, "The pull request diff could not be loaded."),
          status: "error",
        });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [
    expanded,
    available,
    key,
    pull.baseRefOid,
    pull.headRefOid,
    pull.number,
    pull.repository,
    reload,
    setState,
    viewerLogin,
  ]);

  const retry = useCallback((event: MouseEvent<HTMLElement>) => {
    stopControlClick(event);
    setReload((value) => value + 1);
  }, []);
  const toggle = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      stopControlClick(event);
      if (!available) return;
      if (expanded) setState({ status: "idle" });
      setExpanded((value) => !value);
    },
    [available, expanded, setState],
  );
  const toggleViewed = useCallback(
    (path: string) => onToggleViewed(pullRef.current, path),
    [onToggleViewed],
  );

  return {
    available,
    contentId,
    expanded,
    retry,
    state: current.state,
    toggle,
    toggleViewed,
    viewed,
  };
}

function DiffTrigger({ disclosure }: { disclosure: DiffDisclosure }) {
  return (
    <Button
      aria-controls={disclosure.contentId}
      aria-expanded={disclosure.expanded}
      className="min-h-11 sm:min-h-7"
      disabled={!disclosure.available}
      onClick={disclosure.toggle}
      size="sm"
      type="button"
      variant="outline"
    >
      <ChevronDown
        aria-hidden="true"
        className={`transition-transform motion-reduce:transition-none ${disclosure.expanded ? "rotate-180" : ""}`}
      />
      Files changed
    </Button>
  );
}

function BlockerTrigger({
  available,
  contentId,
  expanded,
  toggle,
}: {
  available: boolean;
  contentId: string;
  expanded: boolean;
  toggle: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <Button
      aria-label={expanded ? "Hide blocker details" : "Show blocker details"}
      aria-controls={contentId}
      aria-expanded={expanded}
      className="min-h-11 sm:min-h-7"
      disabled={!available}
      onClick={toggle}
      size="sm"
      type="button"
      variant="outline"
    >
      <ChevronDown
        aria-hidden="true"
        className={`transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
      />
      Blocker details
    </Button>
  );
}

function DiffPanel({
  disclosure,
  pull,
  run,
  startRun,
}: {
  disclosure: DiffDisclosure;
  pull: PullReadiness;
  run: RunState;
  startRun: PullRuns["start"];
}) {
  if (!disclosure.expanded) return null;

  return (
    <div
      className="relative z-20 mt-3 w-full min-w-0"
      data-diff-panel=""
      id={disclosure.contentId}
    >
      {disclosure.state.status === "loading" && (
        <div
          aria-live="polite"
          className="flex min-h-24 items-center justify-center gap-2 rounded-xl border text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading files changed…
        </div>
      )}
      {disclosure.state.status === "error" && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 wrap-anywhere">
            {disclosure.state.error}
          </span>
          <Button
            onClick={disclosure.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}
      {disclosure.state.status === "success" &&
        disclosure.state.diff.baseRefOid.toLowerCase() ===
          pull.baseRefOid.toLowerCase() &&
        disclosure.state.diff.headRefOid.toLowerCase() ===
          pull.headRefOid.toLowerCase() && (
          <PullDiff
            diff={disclosure.state.diff}
            key={`${disclosure.state.diff.baseRefOid}:${disclosure.state.diff.headRefOid}`}
            pull={pull}
            run={run}
            startRun={startRun}
            toggleViewed={disclosure.toggleViewed}
            viewed={disclosure.viewed}
          />
        )}
    </div>
  );
}

function MergeControl({
  onMutationComplete,
  pull,
}: {
  onMutationComplete?: (
    pull: PullReadiness,
    response: MergePullResponse,
  ) => void;
  pull: PullReadiness;
}) {
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<MergeState>("idle");

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const confirm = async () => {
    if (pending.current || state === "success") return;

    pending.current = true;
    setError(null);
    setState("loading");
    const request = new AbortController();
    controller.current = request;

    try {
      const response = await mergePull(
        {
          expectedHeadRefOid: pull.headRefOid,
          number: pull.number,
          repository: pull.repository,
        },
        request.signal,
      );
      setState("success");
      setOpen(false);
      try {
        onMutationComplete?.(pull, response);
      } catch {
        // The merge succeeded; a parent refresh failure must not claim otherwise.
      }
    } catch (caught: unknown) {
      if (!request.signal.aborted) {
        setError(safeError(caught, "The pull request could not be merged."));
        setState("idle");
      }
    } finally {
      pending.current = false;
      if (controller.current === request) controller.current = null;
    }
  };

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (state !== "loading") {
          setOpen(next);
          if (next) setError(null);
        }
      }}
      open={open}
    >
      <AlertDialogTrigger asChild>
        <Button
          className="relative z-20 min-h-11 sm:min-h-7"
          disabled={state === "success"}
          onClick={stopControlClick}
          size="sm"
          type="button"
        >
          <GitMerge aria-hidden="true" />
          {state === "success" ? "Merged" : "Merge"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={stopControlClick}>
        <AlertDialogHeader>
          <AlertDialogTitle>Admin merge this pull request?</AlertDialogTitle>
          <AlertDialogDescription>
            This will admin-merge {pull.repository} #{pull.number} at head{" "}
            <code className="font-mono text-foreground">
              {pull.headRefOid.slice(0, 7)}
            </code>
            . The server will re-check that this exact head is still Ready
            before merging.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p
            className="m-0 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive wrap-anywhere"
            role="alert"
          >
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={state === "loading"}>
            Cancel
          </AlertDialogCancel>
          <Button
            disabled={state === "loading"}
            onClick={(event) => {
              stopControlClick(event);
              void confirm();
            }}
            type="button"
          >
            {state === "loading" && (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            )}
            {state === "loading" ? "Merging" : "Admin merge"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReadyRow({
  disclosure,
  favorite = false,
  hidePull,
  movement,
  onMutationComplete,
  pull,
  run,
  setFavorite,
  startRun,
}: Pick<
  PullRowProps,
  | "favorite"
  | "hidePull"
  | "movement"
  | "onMutationComplete"
  | "pull"
  | "run"
  | "setFavorite"
  | "startRun"
> & { disclosure: DiffDisclosure }) {
  const reviewUrl = pull.greptile.commentUrl;
  if (!reviewUrl) return null;

  const relative = formatRelativeTime(pull.updatedAt);
  const absolute = formatAbsoluteDate(pull.updatedAt);
  const terminal = run.status !== "idle" && !isRunActive(run);
  const identity = getPullKey(pull);
  const summary = (
    <div className="flex items-stretch gap-3" data-ready-summary="">
      <div
        className="flex w-4 shrink-0 flex-col items-center justify-center gap-1"
        data-status-rail=""
      >
        {movement?.direction === "up" && (
          <MovementIndicator movement={movement} />
        )}
        <CircleCheck
          aria-hidden="true"
          className="size-4 shrink-0 self-center text-emerald-600 dark:text-emerald-400"
          data-status-icon="ready"
        />
        {movement?.direction === "down" && (
          <MovementIndicator movement={movement} />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="m-0 min-w-0 flex-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {pull.repository}
            </span>
            <span aria-hidden="true"> · </span>
            <span>#{pull.number}</span>
            <span aria-hidden="true"> · </span>
            <time dateTime={pull.updatedAt} title={absolute}>
              Updated {relative}
            </time>
          </p>
          {favorite && <PullFavoriteIndicator />}
        </div>
        <div className="min-w-0">
          <span className="min-w-0 wrap-anywhere text-sm font-medium text-foreground sm:text-base">
            {pull.title}
          </span>
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          <span className="sr-only">Ready evidence: </span>
          {getReadyEvidence(pull)}
        </p>
        <span className="sr-only">Current head {pull.headRefOid} reviewed</span>
      </div>
    </div>
  );
  const summaryBoundary =
    hidePull && setFavorite ? (
      <PullActionsMenu
        className="relative min-w-0 flex-1"
        favorite={favorite}
        onFavoriteChange={(next) => setFavorite(identity, next)}
        onHide={() => hidePull(identity)}
      >
        <a
          aria-label={`Open Greptile review for ${pull.repository} pull request ${pull.number}: ${pull.title}`}
          className="absolute inset-0 z-10 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-row-link=""
          href={reviewUrl}
          rel="noopener noreferrer"
          target="_blank"
        />
        {summary}
      </PullActionsMenu>
    ) : (
      <div className="relative min-w-0 flex-1">
        <a
          aria-label={`Open Greptile review for ${pull.repository} pull request ${pull.number}: ${pull.title}`}
          className="absolute inset-0 z-10 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-row-link=""
          href={reviewUrl}
          rel="noopener noreferrer"
          target="_blank"
        />
        {summary}
      </div>
    );

  return (
    <>
      <Card
        className="relative gap-0 overflow-visible py-0 transition-colors hover:bg-muted/25"
        size="sm"
      >
        <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-stretch sm:p-4">
          {summaryBoundary}
          <div
            className="relative z-20 ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 sm:self-stretch sm:flex-col sm:flex-nowrap sm:items-end sm:justify-between"
            data-row-actions=""
            data-ready-controls=""
          >
            <Badge variant="secondary">All checks passed</Badge>
            <div
              className="flex flex-wrap items-center justify-end gap-2"
              data-ready-actions=""
            >
              <DiffTrigger disclosure={disclosure} />
              <MergeControl
                onMutationComplete={onMutationComplete}
                pull={pull}
              />
            </div>
          </div>
        </div>
        {disclosure.expanded && (
          <CardContent
            className="px-3 pb-3 sm:px-4 sm:pb-4"
            data-ready-diff-content=""
          >
            <DiffPanel
              disclosure={disclosure}
              pull={pull}
              run={run}
              startRun={startRun}
            />
          </CardContent>
        )}
      </Card>
      {terminal && <RunOutput pull={pull} run={run} />}
    </>
  );
}

function PullRow({
  artifactEpoch,
  cancelRun,
  favorite = false,
  hidePull,
  movement,
  onMutationComplete,
  onToggleViewed,
  pull,
  run,
  setFavorite,
  setRunMessage,
  startRun,
  variant,
  viewerLogin,
  viewedFiles,
}: PullRowProps) {
  const reducedMotion = useReducedMotion();
  const disclosure = useDiffDisclosure(
    pull,
    viewerLogin,
    artifactEpoch,
    viewedFiles,
    onToggleViewed,
  );
  const blockerContentId = useId();
  const [blockersExpanded, setBlockersExpanded] = useState(false);
  const blockerAvailable = viewerLogin !== null;
  const toggleBlockers = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      stopControlClick(event);
      if (!blockerAvailable) return;
      setBlockersExpanded((value) => !value);
    },
    [blockerAvailable],
  );
  const blockers = pull.blockers.length
    ? pull.blockers
    : run.kind === "repair" && run.status === "failed"
      ? [
          run.repairState === "conflict"
            ? "Automatic conflict repair still has unresolved conflicts"
            : "Automatic conflict repair failed",
        ]
      : run.kind === "repair" && run.status === "cancelled"
        ? ["Automatic conflict repair was cancelled"]
        : variant === "blocked"
          ? getFallbackBlockers(pull)
          : [];
  const identity = getPullKey(pull);
  const active = variant === "progress" && isRunActive(run);
  const summary = (
    <div className="flex items-stretch gap-3" data-pull-summary="">
      <div
        className="flex w-4 shrink-0 flex-col items-center justify-center gap-1"
        data-status-rail=""
      >
        {movement?.direction === "up" && (
          <MovementIndicator movement={movement} />
        )}
        {variant === "progress" ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-4 shrink-0 self-center text-amber-600 motion-safe:animate-spin dark:text-amber-400"
            data-status-active={active ? "true" : "false"}
            data-status-icon="progress"
          />
        ) : (
          <CircleAlert
            aria-hidden="true"
            className="size-4 shrink-0 self-center text-destructive"
            data-status-icon="blocked"
          />
        )}
        {movement?.direction === "down" && (
          <MovementIndicator movement={movement} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <PullSummary pull={pull} />
          {favorite && <PullFavoriteIndicator />}
        </div>
        {variant === "progress" && (
          <>
            <p
              className="mt-1 text-xs text-amber-800 dark:text-amber-300"
              data-ci-progress=""
            >
              {getCIProgress(pull)}
              {active && (
                <>
                  <span aria-hidden="true"> · </span>
                  {getRunLabel(run)} {getStatusLabel(run.status).toLowerCase()}
                </>
              )}
            </p>
            <span className="sr-only" role="status">
              {active
                ? `${getRunLabel(run)} is active`
                : "CI checks are still in progress"}
            </span>
          </>
        )}
        {blockers.length > 0 && (
          <BlockerList
            blockers={blockers}
            tone={variant === "progress" ? "warning" : "danger"}
          />
        )}
      </div>
    </div>
  );
  const summaryBoundary =
    hidePull && setFavorite ? (
      <PullActionsMenu
        favorite={favorite}
        onFavoriteChange={(next) => setFavorite(identity, next)}
        onHide={() => hidePull(identity)}
      >
        {summary}
      </PullActionsMenu>
    ) : (
      summary
    );

  return (
    <motion.li
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      layout="position"
      layoutId={`pull-row-${artifactEpoch}-${viewerLogin ?? "viewer-unavailable"}-${pull.url}`}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: 0.18,
              ease: [0.22, 1, 0.36, 1],
              layout: { duration: 0.24 },
            }
      }
    >
      {variant === "ready" ? (
        <ReadyRow
          disclosure={disclosure}
          favorite={favorite}
          hidePull={hidePull}
          movement={movement}
          onMutationComplete={onMutationComplete}
          pull={pull}
          run={run}
          setFavorite={setFavorite}
          startRun={startRun}
        />
      ) : (
        <Card className="gap-0 py-0" size="sm">
          <CardContent className="p-3 sm:p-4">
            <div
              className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
              data-pull-header=""
            >
              <div className="min-w-0 flex-1">{summaryBoundary}</div>
              <div
                className="relative z-20 ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 sm:self-stretch sm:flex-col sm:flex-nowrap sm:items-end sm:justify-between"
                data-pull-controls=""
                data-row-actions=""
              >
                {variant === "progress" ? (
                  <ProgressBadge run={run} />
                ) : (
                  <Badge variant="destructive">
                    {blockers.length}{" "}
                    {blockers.length === 1 ? "blocker" : "blockers"}
                  </Badge>
                )}
                <div
                  className="flex flex-wrap items-center justify-end gap-2"
                  data-pull-actions=""
                >
                  <BlockerTrigger
                    available={blockerAvailable}
                    contentId={blockerContentId}
                    expanded={blockersExpanded}
                    toggle={toggleBlockers}
                  />
                  <DiffTrigger disclosure={disclosure} />
                </div>
              </div>
            </div>
            {blockersExpanded && viewerLogin !== null && (
              <div
                className="relative z-20 mt-3 w-full min-w-0"
                data-blocker-panel=""
                id={blockerContentId}
              >
                <BlockerDetails pull={pull} viewerLogin={viewerLogin} />
              </div>
            )}
            <DiffPanel
              disclosure={disclosure}
              pull={pull}
              run={run}
              startRun={startRun}
            />
            <Separator className="my-3" />
            <FixPanel
              cancelRun={cancelRun}
              pull={pull}
              run={run}
              setRunMessage={setRunMessage}
              startRun={startRun}
            />
          </CardContent>
        </Card>
      )}
    </motion.li>
  );
}

export default memo(PullRow);
