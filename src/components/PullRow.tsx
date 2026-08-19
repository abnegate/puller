import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  SquareTerminal,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

import { agentLabel, alternateAgent, useAgentPreference } from "../agent";
import { getPullDiff, mergePull, PullDiffHttpError } from "../api";
import {
  getPullDiffKey,
  type ToggleViewedFile,
  type ViewedFiles,
} from "../diffs";
import { DEFAULT_FIX_INSTRUCTIONS, DEFAULT_FIX_PLACEHOLDER } from "../fixes";
import { keyboardEventBlocked } from "../keyboard";
import type { PullMovement } from "../movements";
import { getPullKey, type PullKey } from "../preferences";
import { usePullRowContinuity } from "../row-continuity";
import {
  isRunActive,
  isRunPreparing,
  type PullRuns,
  type RunHistoryEntry,
  type RunRateLimit,
  type RunState,
  type RunStatus,
} from "../runs";
import { formatRelativeTime } from "../time";
import type {
  Agent,
  MergePullResponse,
  PullDiff as PullDiffData,
  PullReadiness,
} from "../types";
import BlockerDetails from "./BlockerDetails";
import PullActionsMenu, { PullFavoriteIndicator } from "./PullActionsMenu";
import PullCommits, {
  normalizePullCommitsPersistence,
  type PullCommitsPersistence,
} from "./PullCommits";
import PullDiff from "./PullDiff";
import type { PullDiffPersistence } from "./PullDiff";

type PullRowProps = {
  agent?: Agent;
  artifactEpoch: number;
  cancelRun: PullRuns["cancel"];
  clearReviewRetry: PullRuns["clearReviewRetry"];
  favorite?: boolean;
  hidePull?: (key: PullKey) => void;
  movement?: PullMovement | null;
  onMutationComplete?: (
    pull: PullReadiness,
    response: MergePullResponse,
  ) => void;
  onToggleViewed: ToggleViewedFile;
  loadTranscript: PullRuns["loadTranscript"];
  pull: PullReadiness;
  revealFocusedPull?: (key: PullKey) => boolean;
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

type PersistedRowDiff = {
  persistence?: PullDiffPersistence;
  state?: { diff: PullDiffData; status: "success" };
};

type PersistedRowCommits = {
  persistence: PullCommitsPersistence;
};

const persistedDiff = (value: unknown): PersistedRowDiff | undefined => {
  if (!value || typeof value !== "object") return;
  const persisted = value as {
    persistence?: PullDiffPersistence;
    state?: unknown;
  };
  const state = persisted.state;
  const success =
    state &&
    typeof state === "object" &&
    "status" in state &&
    state.status === "success" &&
    "diff" in state;
  if (!success && persisted.persistence === undefined) return;
  return persisted as PersistedRowDiff;
};

const persistedCommits = (value: unknown): PersistedRowCommits | undefined => {
  if (!value || typeof value !== "object" || !("persistence" in value)) {
    return;
  }
  const persistence = value.persistence;
  if (
    !persistence ||
    typeof persistence !== "object" ||
    !("diffs" in persistence) ||
    !persistence.diffs ||
    typeof persistence.diffs !== "object" ||
    !("selectedSha" in persistence) ||
    (persistence.selectedSha !== null &&
      typeof persistence.selectedSha !== "string") ||
    !("viewed" in persistence) ||
    !persistence.viewed ||
    typeof persistence.viewed !== "object" ||
    ("listVisible" in persistence &&
      typeof persistence.listVisible !== "boolean")
  ) {
    return;
  }
  const normalized = normalizePullCommitsPersistence(
    persistence as PullCommitsPersistence,
  );
  return normalized === persistence
    ? (value as PersistedRowCommits)
    : { persistence: normalized };
};

const hasActivePullIdentity = (identity: PullKey): boolean => {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  return (
    active.closest<HTMLElement>("[data-pull-identity]")?.dataset
      .pullIdentity === identity
  );
};

type FocusScope = "blockers" | "commits" | "diff";

const FOCUS_SCOPE_SEPARATOR = "\0";

type PanelFocusRequest = {
  diffKey: string;
  generation: number;
  identity: PullKey;
  scope: FocusScope;
};

const disclosureToken: Record<FocusScope, string> = {
  blockers: "blockers",
  commits: "commits",
  diff: "diff",
};

const panelSelector: Record<FocusScope, string> = {
  blockers: "[data-blocker-panel]",
  commits: "[data-commits-panel]",
  diff: "[data-diff-panel]",
};

const panelEntry = (
  panel: HTMLElement,
  scope: FocusScope,
): HTMLElement | null => {
  if (scope === "blockers") {
    return panel.querySelector<HTMLElement>(
      "[data-blocker-item][tabindex='0']",
    );
  }

  if (scope === "commits") {
    return (
      panel.querySelector<HTMLElement>("[data-commit-selected]") ??
      panel.querySelector<HTMLElement>(
        "[data-pull-focus-token^='commit:']:not([disabled])",
      )
    );
  }

  return (
    panel.querySelector<HTMLElement>(
      "button[data-file-index][aria-current='true']",
    ) ??
    panel.querySelector<HTMLElement>("button[data-file-index]:not([disabled])")
  );
};

const scopedFocusToken = (target: HTMLElement, token: string): string => {
  const scope: FocusScope | null = target.closest("[data-blocker-panel]")
    ? "blockers"
    : target.closest("[data-commits-panel]")
      ? "commits"
      : target.closest("[data-diff-panel]")
        ? "diff"
        : null;
  return scope === null ? token : `${scope}${FOCUS_SCOPE_SEPARATOR}${token}`;
};

const parseFocusToken = (
  token: string,
): { scope: FocusScope | null; token: string } => {
  const separator = token.indexOf(FOCUS_SCOPE_SEPARATOR);
  if (separator < 0) return { scope: null, token };
  const scope = token.slice(0, separator);
  return scope === "blockers" || scope === "commits" || scope === "diff"
    ? { scope, token: token.slice(separator + 1) }
    : { scope: null, token };
};

const sameDiffState = (left: DiffState, right: DiffState): boolean =>
  left.status === right.status &&
  (left.status !== "error" ||
    right.status !== "error" ||
    left.error === right.error) &&
  (left.status !== "success" ||
    right.status !== "success" ||
    left.diff === right.diff);

const statusLabels: Record<Exclude<RunStatus, "idle">, string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  limited: "Limited",
  preparing: "Preparing",
  running: "Running",
  starting: "Starting",
};

const getStatusLabel = (status: RunStatus): string =>
  status === "idle" ? "Idle" : statusLabels[status];

const getRunLabel = (run: RunState): string => {
  if (run.kind === "repair") return "Conflict repair";
  const label = agentLabel(run.agent);
  if (run.source === "auto") return `${label} auto fix`;
  return run.source === "review" ? `${label} review fix` : label;
};

const historySourceLabels: Record<RunHistoryEntry["source"], string> = {
  auto: "Auto fix",
  manual: "Manual fix",
  review: "Review fix",
};

const getHistoryLabel = (entry: RunHistoryEntry): string =>
  `${agentLabel(entry.agent)} ${historySourceLabels[entry.source].toLowerCase()}`;

const getHistoryInstructions = (entry: RunHistoryEntry): string => {
  const { instructions } = entry;
  if (instructions.kind === "manual") return instructions.text;
  if (instructions.kind === "auto") {
    return instructions.message || DEFAULT_FIX_INSTRUCTIONS;
  }

  const feedback = instructions.feedback.body;
  if (!instructions.message || instructions.message === feedback) {
    return feedback;
  }
  return `${feedback}\n\nAdditional context: ${instructions.message}`;
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

const getCIOverview = (
  pull: PullReadiness,
): {
  failed: number;
  inProgress: number;
  queued: number;
  successful: number;
  total: number;
  unknown: number;
} => {
  const checks = pull.ci.checks ?? [];
  const count = (...states: string[]): number =>
    checks.filter((check) => states.includes(check.state)).length;
  const inProgress =
    pull.ci.inProgress ??
    (checks.length > 0 ? count("in_progress") : (pull.ci.running ?? 0));
  const queued = pull.ci.queued ?? count("pending", "queued");
  const successful = pull.ci.passed ?? count("success", "neutral", "skipped");
  const failed = pull.ci.failed ?? count("failure");
  const unknown = pull.ci.unknown ?? count("unknown");
  const total =
    pull.ci.total ?? inProgress + queued + successful + failed + unknown;

  return { failed, inProgress, queued, successful, total, unknown };
};

function CIProgress({ pull }: { pull: PullReadiness }) {
  const overview = getCIOverview(pull);
  if (overview.total === 0) return "No CI checks reported";

  const segments = [
    {
      key: "in-progress",
      label: `${overview.inProgress} in progress`,
    },
    {
      key: "queued",
      label: `${overview.queued} queued`,
    },
    {
      key: "successful",
      label: `${overview.successful} successful`,
    },
    {
      key: "failed",
      label: `${overview.failed} failed`,
    },
  ];
  if (overview.unknown > 0 || pull.ci.complete === false) {
    segments.push({
      key: "unknown",
      label: `${overview.unknown} unknown`,
    });
  }

  return segments.map((segment, index) => (
    <span data-ci-count={segment.key} key={segment.key}>
      {index > 0 && (
        <span aria-hidden="true" className="text-muted-foreground">
          {" · "}
        </span>
      )}
      {segment.label}
    </span>
  ));
}

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
                ? `${agentLabel(run.agent)} auto fix`
                : run.source === "review"
                  ? `${agentLabel(run.agent)} review fix`
                  : `${agentLabel(run.agent)} output`}
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
        data-keyboard-scroll-region=""
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

type TranscriptLoadState =
  | { status: "idle" | "loading" }
  | { message: string; status: "error" }
  | { status: "missing" }
  | { status: "success"; transcript: string };

function HistoryTranscript({
  entry,
  loadTranscript,
}: {
  entry: RunHistoryEntry;
  loadTranscript: PullRuns["loadTranscript"];
}) {
  const contentId = useId();
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TranscriptLoadState>({
    status: "idle",
  });
  const label = `${getHistoryLabel(entry)} ${statusLabels[
    entry.status
  ].toLowerCase()} from ${formatRelativeTime(entry.finishedAt)}`;

  const load = useCallback(() => {
    if (entry.transcript.availability === "unavailable") return;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const token = ++request.current;
    setState({ status: "loading" });
    void loadTranscript(entry, nextController.signal).then(
      (transcript) => {
        if (nextController.signal.aborted || request.current !== token) {
          return;
        }
        setState(
          transcript === null
            ? { status: "missing" }
            : { status: "success", transcript },
        );
      },
      (error: unknown) => {
        if (nextController.signal.aborted || request.current !== token) {
          return;
        }
        setState({
          message: safeError(
            error,
            "The saved transcript could not be loaded.",
          ),
          status: "error",
        });
      },
    );
  }, [entry, loadTranscript]);

  useEffect(
    () => () => {
      request.current += 1;
      controller.current?.abort();
    },
    [],
  );

  if (entry.transcript.availability === "unavailable") {
    return (
      <div className="border-t px-3 py-3 text-xs text-muted-foreground">
        <p className="m-0 font-medium text-foreground">
          Transcript unavailable
        </p>
        <p className="mt-1 mb-0">{entry.transcript.message}</p>
      </div>
    );
  }

  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          load();
          return;
        }
        request.current += 1;
        controller.current?.abort();
        controller.current = null;
        setState({ status: "idle" });
      }}
      open={open}
    >
      <div className="border-t px-3 py-2">
        <CollapsibleTrigger asChild>
          <Button
            aria-controls={contentId}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} transcript for ${label}`}
            className="min-h-9 gap-2 px-2 text-muted-foreground sm:min-h-7"
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform motion-reduce:transition-none ${
                open ? "rotate-180" : ""
              }`}
            />
            Transcript
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent
        aria-label={`Transcript for ${label}`}
        id={contentId}
        role="region"
      >
        {state.status === "loading" && (
          <div className="flex min-h-16 items-center gap-2 border-t px-3 py-3 text-xs text-muted-foreground">
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
            Loading transcript…
          </div>
        )}
        {state.status === "missing" && (
          <p className="m-0 border-t px-3 py-3 text-xs text-muted-foreground">
            The saved transcript is no longer available.
          </p>
        )}
        {state.status === "error" && (
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-3 text-xs text-destructive">
            <span className="min-w-0 flex-1 wrap-anywhere">
              {state.message}
            </span>
            <Button onClick={load} size="sm" type="button" variant="outline">
              Retry
            </Button>
          </div>
        )}
        {state.status === "success" && (
          <pre
            aria-label={`${getHistoryLabel(entry)} transcript from ${formatRelativeTime(entry.finishedAt)}`}
            className="max-h-56 min-h-12 max-w-full overflow-auto whitespace-pre-wrap border-t p-3 font-mono text-xs leading-relaxed text-foreground wrap-anywhere"
            data-keyboard-scroll-region=""
            data-run-history-transcript=""
            tabIndex={0}
          >
            {state.transcript}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PreviousFixes({
  loadTranscript,
  pull,
  run,
}: {
  loadTranscript: PullRuns["loadTranscript"];
  pull: PullReadiness;
  run: RunState;
}) {
  const contentId = useId();
  const [open, setOpen] = useState(false);
  if (run.history.length === 0) return null;
  const count = run.history.length;

  return (
    <Collapsible
      className="relative z-20 mt-3 w-full min-w-0"
      data-run-history=""
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger asChild>
        <Button
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`Previous fixes, ${count} ${count === 1 ? "run" : "runs"}`}
          className="group min-h-9 max-w-full gap-2 px-2 text-muted-foreground sm:min-h-7"
          data-run-history-trigger=""
          onClick={stopControlClick}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
          <span>Previous fixes</span>
          <Badge
            aria-hidden="true"
            className="tabular-nums"
            variant="secondary"
          >
            {count}
          </Badge>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        aria-label={`Previous fixes for ${pull.repository} pull request ${pull.number}`}
        className="min-w-0"
        id={contentId}
        role="region"
      >
        <div className="mt-2 grid min-w-0 gap-2 overflow-hidden">
          {open &&
            run.history.map((entry) => {
              const absolute = formatAbsoluteDate(entry.finishedAt);
              return (
                <Card
                  className="min-w-0 gap-0 overflow-hidden py-0"
                  data-run-history-entry={entry.id}
                  key={`${entry.id}:${entry.finishedAt}`}
                  size="sm"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-xs">
                    <SquareTerminal
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="font-medium text-foreground">
                      {getHistoryLabel(entry)}
                    </span>
                    <Badge
                      className="shrink-0"
                      variant={
                        entry.status === "failed" || entry.status === "limited"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {statusLabels[entry.status]}
                    </Badge>
                    <time
                      className="ml-auto text-muted-foreground"
                      dateTime={entry.finishedAt}
                      title={absolute}
                    >
                      {formatRelativeTime(entry.finishedAt)}
                    </time>
                  </div>
                  <div className="min-w-0 border-b px-3 py-2">
                    <p className="m-0 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                      Instructions
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground wrap-anywhere">
                      {getHistoryInstructions(entry)}
                    </p>
                  </div>
                  <HistoryTranscript
                    entry={entry}
                    loadTranscript={loadTranscript}
                  />
                </Card>
              );
            })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RateLimitNotice({
  preferredAgent,
  rateLimit,
  onSwitch,
}: {
  onSwitch: (agent: Agent) => void;
  preferredAgent: Agent;
  rateLimit: RunRateLimit;
}) {
  const failed = agentLabel(rateLimit.agent);
  const next = alternateAgent(rateLimit.agent);
  const nextLabel = agentLabel(next);
  const switched = preferredAgent === next;

  return (
    <div
      aria-label={`${failed} hit a rate limit`}
      className="mb-3 flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-950 sm:flex-row sm:items-center dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
      data-rate-limit-notice=""
      role="status"
    >
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium">{failed} hit a rate limit</p>
        <p className="m-0 mt-0.5 text-xs leading-relaxed wrap-anywhere">
          {rateLimit.message}
        </p>
      </div>
      {switched ? (
        <p className="m-0 text-xs text-amber-900 dark:text-amber-200">
          Using {nextLabel}. Run fix to continue.
        </p>
      ) : (
        <Button
          className="min-h-11 shrink-0 sm:min-h-8"
          onClick={() => onSwitch(next)}
          size="sm"
          type="button"
          variant="outline"
        >
          Switch to {nextLabel}
        </Button>
      )}
    </div>
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
  | "agent"
  | "clearReviewRetry"
  | "favorite"
  | "hidePull"
  | "loadTranscript"
  | "onMutationComplete"
  | "onToggleViewed"
  | "setFavorite"
  | "variant"
  | "viewerLogin"
  | "viewedFiles"
>) {
  const inputId = useId();
  const active = isRunActive(run);
  const { agent: preferredAgent, setAgent } = useAgentPreference();

  return (
    <div>
      {run.rateLimit !== null && (
        <RateLimitNotice
          onSwitch={setAgent}
          preferredAgent={preferredAgent}
          rateLimit={run.rateLimit}
        />
      )}
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
            placeholder={DEFAULT_FIX_PLACEHOLDER}
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
              {isRunPreparing(run) ? "Preparing review fix" : "Run fix"}
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

type CommitsDisclosure = {
  available: boolean;
  contentId: string;
  expanded: boolean;
  toggle: (event: MouseEvent<HTMLElement>) => void;
};

type DiffIdentityState = {
  key: string;
  state: DiffState;
};

type DiffContinuity = {
  diff?: PullDiffData;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSuccess: (diff: PullDiffData) => void;
};

export function useDiffDisclosure(
  pull: PullReadiness,
  viewerLogin: string | null,
  artifactEpoch: number,
  viewed: ViewedFiles,
  onToggleViewed: ToggleViewedFile,
  continuity?: DiffContinuity,
): DiffDisclosure {
  const contentId = useId();
  const pullRef = useRef(pull);
  const continuityRef = useRef(continuity);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const available = viewerLogin !== null;
  const key = getPullDiffKey(pull, viewerLogin, artifactEpoch);
  const keyRef = useRef(key);
  keyRef.current = key;
  pullRef.current = pull;
  continuityRef.current = continuity;
  const [identity, setIdentity] = useState<DiffIdentityState>(() => ({
    key,
    state: continuity?.diff
      ? { diff: continuity.diff, status: "success" }
      : { status: "idle" },
  }));
  const expanded = continuity?.expanded ?? localExpanded;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const setExpanded = useCallback(
    (next: boolean | ((value: boolean) => boolean)) => {
      const value =
        typeof next === "function" ? next(expandedRef.current) : next;
      const current = continuityRef.current;
      if (current) current.onExpandedChange(value);
      else setLocalExpanded(value);
    },
    [],
  );

  if (identity.key !== key) {
    setIdentity({
      key,
      state: continuity?.diff
        ? { diff: continuity.diff, status: "success" }
        : { status: "idle" },
    });
  }

  const currentIdentity: DiffIdentityState =
    identity.key === key ? identity : { key, state: { status: "idle" } };
  const currentState =
    currentIdentity.state.status === "idle" && continuity?.diff
      ? ({ diff: continuity.diff, status: "success" } as const)
      : currentIdentity.state;
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  const setState = useCallback(
    (state: DiffState) => {
      if (sameDiffState(stateRef.current, state)) return;
      stateRef.current = state;
      setIdentity((value) => (value.key === key ? { ...value, state } : value));
      if (state.status === "success") {
        continuityRef.current?.onSuccess(state.diff);
      }
    },
    [key],
  );

  useEffect(() => {
    if (!expanded || !available) return;
    if (continuity?.diff) return;

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
    continuity?.diff,
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
    [available, expanded, setExpanded, setState],
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
    state: currentState,
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
      aria-keyshortcuts="f"
      className="min-h-11 sm:min-h-7"
      data-pull-focus-token="diff"
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

function CommitsTrigger({ disclosure }: { disclosure: CommitsDisclosure }) {
  return (
    <Button
      aria-controls={disclosure.contentId}
      aria-expanded={disclosure.expanded}
      aria-keyshortcuts="c"
      className="min-h-11 sm:min-h-7"
      data-pull-focus-token="commits"
      disabled={!disclosure.available}
      onClick={disclosure.toggle}
      size="sm"
      type="button"
      variant="outline"
    >
      <GitCommitHorizontal aria-hidden="true" />
      Commits
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
      aria-keyshortcuts="b"
      className="min-h-11 sm:min-h-7"
      data-pull-focus-token="blockers"
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
  agent,
  clearReviewRetry,
  disclosure,
  onPersistenceChange,
  persistence,
  pull,
  run,
  startRun,
}: {
  agent: Agent;
  clearReviewRetry: PullRuns["clearReviewRetry"];
  disclosure: DiffDisclosure;
  onPersistenceChange?: (persistence: PullDiffPersistence) => void;
  persistence?: PullDiffPersistence;
  pull: PullReadiness;
  run: RunState;
  startRun: PullRuns["start"];
}) {
  if (!disclosure.expanded) return null;

  return (
    <div
      className="relative mt-3 w-full min-w-0"
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
            agent={agent}
            clearReviewRetry={clearReviewRetry}
            diff={disclosure.state.diff}
            key={`${disclosure.state.diff.baseRefOid}:${disclosure.state.diff.headRefOid}`}
            onPersistenceChange={onPersistenceChange}
            persistence={persistence}
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

function CommitsPanel({
  agent,
  clearReviewRetry,
  disclosure,
  onPersistenceChange,
  persistence,
  pull,
  run,
  startRun,
  viewerLogin,
}: {
  agent: Agent;
  clearReviewRetry: PullRuns["clearReviewRetry"];
  disclosure: CommitsDisclosure;
  onPersistenceChange?: (persistence: PullCommitsPersistence) => void;
  persistence?: PullCommitsPersistence;
  pull: PullReadiness;
  run: RunState;
  startRun: PullRuns["start"];
  viewerLogin: string | null;
}) {
  if (!disclosure.expanded || viewerLogin === null) return null;

  return (
    <div
      className="relative mt-3 w-full min-w-0"
      data-commits-panel=""
      id={disclosure.contentId}
    >
      <PullCommits
        agent={agent}
        clearReviewRetry={clearReviewRetry}
        onPersistenceChange={onPersistenceChange}
        persistence={persistence}
        pull={pull}
        run={run}
        startRun={startRun}
        viewerLogin={viewerLogin}
      />
    </div>
  );
}

function MergeControl({
  agent,
  disabled = false,
  onMutationComplete,
  pull,
}: {
  agent: Agent;
  disabled?: boolean;
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
    if (disabled || pending.current || state === "success") return;

    pending.current = true;
    setError(null);
    setState("loading");
    const request = new AbortController();
    controller.current = request;

    try {
      const response = await mergePull(
        {
          agent,
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
          disabled={disabled || state === "success"}
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
  agent = "claude",
  clearReviewRetry,
  commitsDisclosure,
  commitsPersistence,
  disclosure,
  favorite = false,
  hidePull,
  movement,
  onCommitsPersistenceChange,
  onMutationComplete,
  onPersistenceChange,
  persistence,
  pull,
  run,
  setFavorite,
  startRun,
  viewerLogin,
}: Pick<
  PullRowProps,
  | "agent"
  | "favorite"
  | "clearReviewRetry"
  | "hidePull"
  | "movement"
  | "onMutationComplete"
  | "pull"
  | "run"
  | "setFavorite"
  | "startRun"
  | "viewerLogin"
> & {
  commitsDisclosure: CommitsDisclosure;
  commitsPersistence?: PullCommitsPersistence;
  disclosure: DiffDisclosure;
  onCommitsPersistenceChange?: (persistence: PullCommitsPersistence) => void;
  onPersistenceChange?: (persistence: PullDiffPersistence) => void;
  persistence?: PullDiffPersistence;
}) {
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
            {isRunPreparing(run) ? (
              <Badge
                className="border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                variant="outline"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  data-icon="inline-start"
                />
                Review fix preparing
              </Badge>
            ) : (
              <Badge variant="secondary">All checks passed</Badge>
            )}
            <div
              className="flex flex-wrap items-center justify-end gap-2"
              data-ready-actions=""
            >
              <CommitsTrigger disclosure={commitsDisclosure} />
              <DiffTrigger disclosure={disclosure} />
              <MergeControl
                agent={agent}
                disabled={isRunActive(run)}
                onMutationComplete={onMutationComplete}
                pull={pull}
              />
            </div>
          </div>
        </div>
        {(commitsDisclosure.expanded || disclosure.expanded) && (
          <CardContent
            className="px-3 pb-3 sm:px-4 sm:pb-4"
            data-ready-diff-content=""
          >
            <CommitsPanel
              agent={agent}
              clearReviewRetry={clearReviewRetry}
              disclosure={commitsDisclosure}
              onPersistenceChange={onCommitsPersistenceChange}
              persistence={commitsPersistence}
              pull={pull}
              run={run}
              startRun={startRun}
              viewerLogin={viewerLogin}
            />
            <DiffPanel
              agent={agent}
              clearReviewRetry={clearReviewRetry}
              disclosure={disclosure}
              onPersistenceChange={onPersistenceChange}
              persistence={persistence}
              pull={pull}
              run={run}
              startRun={startRun}
            />
          </CardContent>
        )}
      </Card>
      {run.rateLimit !== null && (
        <div className="mt-3">
          <ReadyRateLimitNotice rateLimit={run.rateLimit} />
        </div>
      )}
      {terminal && <RunOutput pull={pull} run={run} />}
    </>
  );
}

function ReadyRateLimitNotice({ rateLimit }: { rateLimit: RunRateLimit }) {
  const { agent, setAgent } = useAgentPreference();
  return (
    <RateLimitNotice
      onSwitch={setAgent}
      preferredAgent={agent}
      rateLimit={rateLimit}
    />
  );
}

function PullRow({
  agent = "claude",
  artifactEpoch,
  cancelRun,
  clearReviewRetry,
  favorite = false,
  hidePull,
  loadTranscript,
  movement,
  onMutationComplete,
  onToggleViewed,
  pull,
  revealFocusedPull,
  run,
  setFavorite,
  setRunMessage,
  startRun,
  variant,
  viewerLogin,
  viewedFiles,
}: PullRowProps) {
  const reducedMotion = useReducedMotion();
  const identity = getPullKey(pull);
  const continuity = usePullRowContinuity(identity);
  const { claimFocus, ensureDiffKey, entry, update } = continuity;
  const diffKey = getPullDiffKey(pull, viewerLogin, artifactEpoch);
  useLayoutEffect(() => {
    ensureDiffKey(diffKey, variant);
  }, [diffKey, ensureDiffKey, variant]);
  const savedDiff =
    entry.diffKey === diffKey ? persistedDiff(entry.diff) : undefined;
  const savedCommits =
    entry.diffKey === diffKey ? persistedCommits(entry.commits) : undefined;
  const changeDiffExpanded = useCallback(
    (expanded: boolean) =>
      update((current) => {
        const previous = persistedDiff(current.diff);
        const diff = expanded
          ? current.diff
          : previous?.persistence === undefined
            ? undefined
            : { persistence: previous.persistence };
        if (
          current.diffExpanded === expanded &&
          (expanded || current.diff === diff)
        ) {
          return current;
        }
        return { ...current, diff, diffExpanded: expanded };
      }),
    [update],
  );
  const saveDiff = useCallback(
    (diff: PullDiffData) =>
      update((current) => {
        if (current.diffKey !== diffKey) return current;
        const previous = persistedDiff(current.diff);
        if (previous?.state?.diff === diff) return current;
        return {
          ...current,
          diff: {
            ...(previous?.persistence
              ? { persistence: previous.persistence }
              : {}),
            state: { diff, status: "success" },
          },
        };
      }),
    [diffKey, update],
  );
  const diffContinuity = useMemo(
    () => ({
      diff: savedDiff?.state?.diff,
      expanded: entry.diffExpanded,
      onExpandedChange: changeDiffExpanded,
      onSuccess: saveDiff,
    }),
    [changeDiffExpanded, entry.diffExpanded, saveDiff, savedDiff?.state?.diff],
  );
  const disclosure = useDiffDisclosure(
    pull,
    viewerLogin,
    artifactEpoch,
    viewedFiles,
    onToggleViewed,
    diffContinuity,
  );
  const blockerContentId = useId();
  const commitsContentId = useId();
  const blockersExpanded = entry.blockersExpanded;
  const commitsExpanded = entry.commitsExpanded;
  const saveDiffPersistence = useCallback(
    (persistence: PullDiffPersistence) =>
      update((current) => {
        if (current.diffKey !== diffKey) return current;
        const previous = persistedDiff(current.diff);
        if (!previous || previous.persistence === persistence) {
          return current;
        }
        return {
          ...current,
          diff: {
            ...previous,
            persistence,
          },
        };
      }),
    [diffKey, update],
  );
  const blockerAvailable = viewerLogin !== null;
  const toggleCommits = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      stopControlClick(event);
      if (!blockerAvailable) return;
      update({ commitsExpanded: !commitsExpanded });
    },
    [blockerAvailable, commitsExpanded, update],
  );
  const commitsDisclosure = useMemo<CommitsDisclosure>(
    () => ({
      available: blockerAvailable,
      contentId: commitsContentId,
      expanded: commitsExpanded,
      toggle: toggleCommits,
    }),
    [blockerAvailable, commitsContentId, commitsExpanded, toggleCommits],
  );
  const saveCommitsPersistence = useCallback(
    (persistence: PullCommitsPersistence) =>
      update((current) => {
        if (current.diffKey !== diffKey) return current;
        const previous = persistedCommits(current.commits);
        if (previous?.persistence === persistence) return current;
        return { ...current, commits: { persistence } };
      }),
    [diffKey, update],
  );
  const toggleBlockers = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      stopControlClick(event);
      if (!blockerAvailable) return;
      update({ blockersExpanded: !blockersExpanded });
    },
    [blockerAvailable, blockersExpanded, update],
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
  const row = useRef<HTMLLIElement>(null);
  const panelFocusGeneration = useRef(0);
  const panelFocusRequest = useRef<PanelFocusRequest | null>(null);
  const requestPanelEntry = useCallback(
    (scope: FocusScope) => {
      panelFocusRequest.current = {
        diffKey,
        generation: ++panelFocusGeneration.current,
        identity,
        scope,
      };
    },
    [diffKey, identity],
  );
  const disclosureFor = useCallback((scope: FocusScope): HTMLElement | null => {
    return (
      row.current?.querySelector<HTMLElement>(
        `[data-pull-focus-token="${disclosureToken[scope]}"]`,
      ) ?? null
    );
  }, []);
  const togglePanel = useCallback(
    (scope: FocusScope, focusEntry: boolean): void => {
      const trigger = disclosureFor(scope);
      if (
        trigger === null ||
        trigger.matches(":disabled") ||
        trigger.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      if (focusEntry && trigger.getAttribute("aria-expanded") !== "true") {
        requestPanelEntry(scope);
      }
      trigger.click();
    },
    [disclosureFor, requestPanelEntry],
  );
  useLayoutEffect(() => {
    const request = panelFocusRequest.current;
    if (
      request === null ||
      request.identity !== identity ||
      request.diffKey !== diffKey
    ) {
      return;
    }
    const expanded =
      request.scope === "blockers"
        ? blockersExpanded
        : request.scope === "commits"
          ? commitsExpanded
          : disclosure.expanded;
    if (!expanded) {
      panelFocusRequest.current = null;
      return;
    }

    const finish = (): boolean => {
      if (
        panelFocusRequest.current?.generation !== request.generation ||
        panelFocusRequest.current.identity !== identity ||
        panelFocusRequest.current.diffKey !== diffKey
      ) {
        return true;
      }
      const panel =
        row.current?.querySelector<HTMLElement>(panelSelector[request.scope]) ??
        null;
      if (panel === null) return false;
      const target = panelEntry(panel, request.scope);
      if (target !== null) {
        panelFocusRequest.current = null;
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: "nearest" });
        return true;
      }
      if (panel.querySelector('[role="alert"]') !== null) {
        panelFocusRequest.current = null;
        return true;
      }
      return false;
    };

    if (finish() || row.current === null) return;
    const observer = new MutationObserver(() => {
      if (finish()) observer.disconnect();
    });
    observer.observe(row.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [
    blockersExpanded,
    commitsExpanded,
    diffKey,
    disclosure.expanded,
    disclosure.state,
    identity,
  ]);
  useEffect(
    () => () => {
      panelFocusRequest.current = null;
    },
    [diffKey, identity],
  );
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>): void => {
      const nestedPanel = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-blocker-panel], [data-commits-panel], [data-diff-panel]",
      );
      const trigger = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-pull-focus-token="blockers"], [data-pull-focus-token="commits"], [data-pull-focus-token="diff"]',
      );
      const rowFocused = event.target === event.currentTarget;
      const allowRepeat =
        rowFocused && (event.key === "ArrowLeft" || event.key === "ArrowRight");
      if (keyboardEventBlocked(event.nativeEvent, document, { allowRepeat })) {
        return;
      }

      if (event.key === "Escape") {
        if (nestedPanel !== null) {
          const scope: FocusScope = nestedPanel.matches("[data-blocker-panel]")
            ? "blockers"
            : nestedPanel.matches("[data-commits-panel]")
              ? "commits"
              : "diff";
          event.preventDefault();
          event.stopPropagation();
          disclosureFor(scope)?.focus({ preventScroll: true });
          return;
        }
        if (trigger !== null) {
          event.preventDefault();
          event.stopPropagation();
          row.current?.focus({ preventScroll: true });
        }
        return;
      }

      if (!rowFocused || event.shiftKey) return;
      const shortcut: FocusScope | null =
        event.key === "f"
          ? "diff"
          : event.key === "b"
            ? "blockers"
            : event.key === "c"
              ? "commits"
              : null;
      if (shortcut !== null) {
        event.preventDefault();
        event.stopPropagation();
        togglePanel(shortcut, true);
        return;
      }

      if (event.key === "ArrowRight") {
        const first = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            '[data-row-actions] [data-pull-focus-token="blockers"], [data-row-actions] [data-pull-focus-token="commits"], [data-row-actions] [data-pull-focus-token="diff"]',
          ),
        ].find(
          (candidate) =>
            !candidate.matches(":disabled") &&
            candidate.getAttribute("aria-disabled") !== "true",
        );
        if (first === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        first.focus({ preventScroll: true });
        return;
      }

      if (event.key === "ArrowLeft") {
        const expanded = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            '[data-row-actions] [aria-expanded="true"]',
          ),
        ];
        if (expanded.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        panelFocusRequest.current = null;
        expanded.forEach((control) => control.click());
      }
    },
    [disclosureFor, togglePanel],
  );
  const focusWasActive = useRef(false);
  if (hasActivePullIdentity(identity)) focusWasActive.current = true;
  if (entry.focus === null) focusWasActive.current = false;
  const focusGeneration = useRef(0);
  focusGeneration.current = Math.max(
    focusGeneration.current,
    entry.focus?.generation ?? 0,
  );
  const captureFocus = useCallback(
    (target: HTMLElement) => {
      const semantic =
        target.closest<HTMLElement>("[data-pull-focus-token]")?.dataset
          .pullFocusToken ?? "row";
      const token = scopedFocusToken(target, semantic);
      update({
        focus: {
          generation: ++focusGeneration.current,
          pending: false,
          token,
          variant,
        },
      });
    },
    [update, variant],
  );
  const releaseFocus = useCallback(() => {
    queueMicrotask(() => {
      if (hasActivePullIdentity(identity)) return;
      focusWasActive.current = false;
      update((current) =>
        current.focus === null ? current : { ...current, focus: null },
      );
    });
  }, [identity, update]);
  useLayoutEffect(() => {
    const focus = entry.focus;
    if (!focus?.pending || focus.variant !== variant) return;
    if (!focusWasActive.current && !hasActivePullIdentity(identity)) return;
    if (revealFocusedPull && !revealFocusedPull(identity)) return;
    const semantic = parseFocusToken(focus.token);
    const panel =
      semantic.scope === null
        ? row.current
        : row.current?.querySelector<HTMLElement>(
            `[data-${semantic.scope === "blockers" ? "blocker" : semantic.scope}-panel]`,
          );
    const findExact = (): HTMLElement | null =>
      semantic.token === "row"
        ? row.current
        : (Array.from(
            panel?.querySelectorAll<HTMLElement>("[data-pull-focus-token]") ??
              [],
          ).find(
            (element) => element.dataset.pullFocusToken === semantic.token,
          ) ?? null);
    const exact = findExact();
    if (
      exact === null &&
      commitsExpanded &&
      (semantic.scope === "commits" ||
        (semantic.scope === null && semantic.token.startsWith("commit:"))) &&
      row.current
    ) {
      const observer = new MutationObserver(() => {
        const restored = findExact();
        if (!restored || !claimFocus(focus)) return;
        observer.disconnect();
        focusWasActive.current = false;
        restored.focus({ preventScroll: true });
      });
      observer.observe(row.current, { childList: true, subtree: true });
      return () => observer.disconnect();
    }
    const files = row.current?.querySelector<HTMLElement>(
      '[data-pull-focus-token="diff"]',
    );
    const blocker = row.current?.querySelector<HTMLElement>(
      '[data-pull-focus-token="blockers"]',
    );
    const commits = row.current?.querySelector<HTMLElement>(
      '[data-pull-focus-token="commits"]',
    );
    const target =
      exact ??
      (semantic.scope === "blockers" || semantic.token.startsWith("blocker:")
        ? (blocker ?? files ?? commits ?? row.current)
        : semantic.scope === "commits" || semantic.token.startsWith("commit")
          ? (commits ?? files ?? blocker ?? row.current)
          : (files ?? commits ?? blocker ?? row.current));
    if (!target || !claimFocus(focus)) return;
    focusWasActive.current = false;
    target.focus({ preventScroll: true });
  }, [
    claimFocus,
    commitsExpanded,
    entry.focus,
    identity,
    revealFocusedPull,
    variant,
  ]);
  const exiting = entry.variant !== null && entry.variant !== variant;
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
        {variant !== "ready" && (
          <>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-ci-progress=""
            >
              <CIProgress pull={pull} />
              {variant === "progress" && active && (
                <>
                  <span aria-hidden="true"> · </span>
                  {getRunLabel(run)} {getStatusLabel(run.status).toLowerCase()}
                </>
              )}
            </p>
            {variant === "progress" && (
              <span className="sr-only" role="status">
                {active
                  ? isRunPreparing(run)
                    ? `${getRunLabel(run)} is preparing`
                    : `${getRunLabel(run)} is active`
                  : "CI checks are still in progress"}
              </span>
            )}
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
      aria-label={`${pull.repository} pull request ${pull.number}: ${pull.title}`}
      aria-hidden={exiting || undefined}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      data-pull-identity={identity}
      data-pull-focus-token="row"
      inert={exiting || undefined}
      onBlurCapture={releaseFocus}
      onFocusCapture={(event) => captureFocus(event.target)}
      onKeyDown={handleRowKeyDown}
      ref={row}
      tabIndex={-1}
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
        <>
          <ReadyRow
            agent={agent}
            clearReviewRetry={clearReviewRetry}
            commitsDisclosure={commitsDisclosure}
            commitsPersistence={savedCommits?.persistence}
            disclosure={disclosure}
            onCommitsPersistenceChange={saveCommitsPersistence}
            onPersistenceChange={saveDiffPersistence}
            persistence={savedDiff?.persistence}
            favorite={favorite}
            hidePull={hidePull}
            movement={movement}
            onMutationComplete={onMutationComplete}
            pull={pull}
            run={run}
            setFavorite={setFavorite}
            startRun={startRun}
            viewerLogin={viewerLogin}
          />
          <PreviousFixes
            loadTranscript={loadTranscript}
            pull={pull}
            run={run}
          />
        </>
      ) : (
        <Card className="gap-0 overflow-visible py-0" size="sm">
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
                {variant === "progress" || isRunPreparing(run) ? (
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
                  {variant === "progress" && (
                    <CommitsTrigger disclosure={commitsDisclosure} />
                  )}
                  <BlockerTrigger
                    available={blockerAvailable}
                    contentId={blockerContentId}
                    expanded={blockersExpanded}
                    toggle={toggleBlockers}
                  />
                  {variant === "blocked" && (
                    <CommitsTrigger disclosure={commitsDisclosure} />
                  )}
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
              agent={agent}
              clearReviewRetry={clearReviewRetry}
              disclosure={disclosure}
              onPersistenceChange={saveDiffPersistence}
              persistence={savedDiff?.persistence}
              pull={pull}
              run={run}
              startRun={startRun}
            />
            <CommitsPanel
              agent={agent}
              clearReviewRetry={clearReviewRetry}
              disclosure={commitsDisclosure}
              onPersistenceChange={saveCommitsPersistence}
              persistence={savedCommits?.persistence}
              pull={pull}
              run={run}
              startRun={startRun}
              viewerLogin={viewerLogin}
            />
            <Separator className="my-3" />
            <FixPanel
              cancelRun={cancelRun}
              pull={pull}
              run={run}
              setRunMessage={setRunMessage}
              startRun={startRun}
            />
            <PreviousFixes
              loadTranscript={loadTranscript}
              pull={pull}
              run={run}
            />
          </CardContent>
        </Card>
      )}
    </motion.li>
  );
}

export default memo(PullRow);
