import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";

import { agentLabel } from "@/agent";
import type {
  Agent,
  RecentRelease,
  RecentReleasesResponse,
  ReleasePipelineRunState,
  ReleasedPull,
} from "@/types";
import { formatRelativeTime } from "@/time";
import {
  canVerifyRelease,
  canVerifyEntireRelease,
  IDLE_VERIFICATION_STATE,
  IDLE_RELEASE_VERIFICATION_STATE,
  isVerificationActive,
  releaseVerificationKey,
  useReleaseVerificationBatches,
  useVerificationRuns,
  verificationKey,
  type ReleaseVerificationBatchState,
  type VerificationRunState,
  type VerificationStatus,
} from "@/verifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type RecentReleasesProps = {
  agent?: Agent;
  data: RecentReleasesResponse | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
};

export const PAGE_SIZE = 20;

const statusLabels: Record<VerificationStatus, string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  idle: "Idle",
  limited: "Limited",
  "membership-changed": "Membership changed",
  running: "Running",
  starting: "Starting",
  existing: "Already running",
};

const verificationStatusLabel = (state: VerificationRunState): string => {
  if (state.status !== "completed") return statusLabels[state.status];
  if (state.outcome === "verified") return "Verified";
  if (state.outcome === "unavailable") return "Unavailable";
  return "Not verified";
};

const verificationTerminalText = (
  state: VerificationRunState,
  label: string,
): string => {
  if (state.output) return state.output;

  if (state.status === "starting") {
    return `Starting ${label} verification…`;
  }
  if (state.status === "running") return "Waiting for output…";
  if (state.status === "completed") {
    if (state.outcome === "verified") {
      return "Behavioral verification passed for this released change.";
    }
    if (state.outcome === "not_verified") {
      return "Behavioral verification did not verify this released change.";
    }
    return "Behavioral verification could not exercise this released change safely.";
  }
  if (state.status === "failed") {
    return `${label} verification failed before it could complete.`;
  }
  if (state.status === "limited") {
    return `${label} verification exceeded a technical limit.`;
  }
  if (state.status === "cancelled") return "Verification was cancelled.";
  if (state.status === "existing") {
    return "Another verification is already running for this pull request.";
  }
  if (state.status === "membership-changed") {
    return "This pull request is no longer included in the release.";
  }
  return "";
};

const HIDDEN_HISTORY_WARNINGS = new Set([
  "GitHub truncated the authored merged pull request search.",
  "Some authored merged pull requests could not be loaded for release membership.",
]);

export type DateReleaseGroup = {
  date: string;
  label: string;
  releases: RecentRelease[];
};

type PipelinePresentation = {
  className: string;
  icon: typeof CircleDashed;
  label: string;
  spin?: boolean;
};

const pipelinePresentation = (
  state: ReleasePipelineRunState,
  updatedAt: string,
  name: string,
): PipelinePresentation => {
  const deployment = /\bdeploy(?:ed|ing|ment)?\b/i.test(name);
  if (state === "succeeded") {
    return {
      className:
        "border-emerald-600/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
      icon: CircleCheck,
      label: `${deployment ? "Deployed" : "Succeeded"} ${formatRelativeTime(updatedAt)}`,
    };
  }
  if (state === "running") {
    return {
      className:
        "border-amber-600/25 bg-amber-500/8 text-amber-700 dark:text-amber-300",
      icon: LoaderCircle,
      label: deployment ? "Deploying" : "Running",
      spin: true,
    };
  }
  if (state === "queued") {
    return {
      className:
        "border-amber-600/25 bg-amber-500/8 text-amber-700 dark:text-amber-300",
      icon: Clock3,
      label: "Queued",
    };
  }
  if (state === "failed") {
    return {
      className: "border-destructive/25 bg-destructive/8 text-destructive",
      icon: CircleX,
      label: "Failed",
    };
  }
  if (state === "timed-out") {
    return {
      className: "border-destructive/25 bg-destructive/8 text-destructive",
      icon: Clock3,
      label: "Timed out",
    };
  }
  if (state === "action-required") {
    return {
      className: "border-destructive/25 bg-destructive/8 text-destructive",
      icon: CircleX,
      label: "Action required",
    };
  }
  if (state === "stale") {
    return {
      className: "border-border bg-muted/45 text-muted-foreground",
      icon: CircleDashed,
      label: "Stale",
    };
  }
  if (state === "cancelled") {
    return {
      className: "border-border bg-muted/45 text-muted-foreground",
      icon: CircleX,
      label: "Cancelled",
    };
  }
  if (state === "skipped") {
    return {
      className: "border-border bg-muted/45 text-muted-foreground",
      icon: CircleDashed,
      label: "Skipped",
    };
  }
  if (state === "neutral") {
    return {
      className: "border-border bg-muted/45 text-muted-foreground",
      icon: CircleDashed,
      label: "Neutral",
    };
  }
  return {
    className: "border-border bg-muted/45 text-muted-foreground",
    icon: CircleDashed,
    label: "Unknown",
  };
};

const preciseDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

function PipelineStatus({ release }: { release: RecentRelease }) {
  const pipeline = release.pipeline;
  if (pipeline.runs.length === 0) {
    if (pipeline.lookup === "complete") return null;
    const pending = pipeline.lookup === "pending";
    return (
      <span
        aria-live="polite"
        className={`inline-flex items-center gap-1 text-[11px] ${
          pending
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground"
        }`}
        data-release-pipeline-empty={pipeline.lookup}
        role="status"
      >
        {pending ? (
          <Clock3 aria-hidden="true" className="size-3" />
        ) : (
          <CircleDashed aria-hidden="true" className="size-3" />
        )}
        {pending ? "Waiting for pipeline" : "Pipeline status unavailable"}
      </span>
    );
  }

  return (
    <span
      aria-live="polite"
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1"
      data-release-pipeline=""
    >
      {pipeline.runs.map((run) => {
        const presentation = pipelinePresentation(
          run.state,
          run.updatedAt,
          run.name,
        );
        const Icon = presentation.icon;
        const description = `${run.name}: ${presentation.label}, attempt ${run.attempt}, updated ${preciseDate(run.updatedAt)}`;
        return (
          <Tooltip key={`${run.path}:${run.attempt}:${run.url}`}>
            <TooltipTrigger asChild>
              <a
                aria-label={description}
                className={`release-pipeline-chip inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${presentation.className}`}
                data-pipeline-state={run.state}
                href={run.url}
                rel="noopener noreferrer"
                target="_blank"
                title={description}
              >
                <Icon
                  aria-hidden="true"
                  className={`size-3 shrink-0 ${
                    presentation.spin
                      ? "animate-spin motion-reduce:animate-none"
                      : ""
                  }`}
                />
                <span className="min-w-0 truncate">{run.name}</span>
                <span className="shrink-0">{presentation.label}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">{description}</TooltipContent>
          </Tooltip>
        );
      })}
      {pipeline.lookup === "unavailable" && (
        <span
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          data-release-pipeline-stale=""
          title={`Pipeline status last checked ${preciseDate(pipeline.checkedAt)}`}
        >
          <CircleDashed aria-hidden="true" className="size-3" />
          Status unavailable
        </span>
      )}
    </span>
  );
}

const localDate = (value: Date): string =>
  [
    value.getFullYear().toString().padStart(4, "0"),
    (value.getMonth() + 1).toString().padStart(2, "0"),
    value.getDate().toString().padStart(2, "0"),
  ].join("-");

const dateLabel = (value: Date, now: Date): string => {
  const date = localDate(value);
  if (date === localDate(now)) return "Today";

  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  if (date === localDate(yesterday)) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    weekday: "long",
    ...(value.getFullYear() === now.getFullYear()
      ? {}
      : { year: "numeric" as const }),
  }).format(value);
};

export const groupReleasesByDate = (
  releases: readonly RecentRelease[],
  now = new Date(),
): DateReleaseGroup[] => {
  const groups = new Map<string, DateReleaseGroup>();

  for (const release of releases) {
    const published = new Date(release.publishedAt);
    const date = Number.isNaN(published.getTime())
      ? "unknown"
      : localDate(published);
    const group = groups.get(date);
    if (group) group.releases.push(release);
    else {
      groups.set(date, {
        date,
        label: date === "unknown" ? "Unknown date" : dateLabel(published, now),
        releases: [release],
      });
    }
  }

  return [...groups.values()];
};

function VerificationTerminal({
  pull,
  state,
}: {
  pull: ReleasedPull;
  state: VerificationRunState;
}) {
  const terminal = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const element = terminal.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.output, state.status]);

  if (state.status === "idle") return null;
  const label = agentLabel(state.agent);

  return (
    <div className="mt-2 overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100 dark:bg-black">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-2.5 py-1.5 text-[11px] text-zinc-400">
        <span>{label} verification</span>
        <span aria-live="polite">{verificationStatusLabel(state)}</span>
      </div>
      <pre
        aria-label={`${label} verification output for ${pull.repository} #${pull.number}`}
        aria-live="polite"
        className="max-h-56 min-h-16 overflow-auto p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        ref={terminal}
        role="log"
        tabIndex={0}
      >
        {verificationTerminalText(state, label)}
      </pre>
    </div>
  );
}

const batchStatusLabel = (batch: ReleaseVerificationBatchState): string => {
  if (batch.status === "starting") return "Starting release verification";
  if (batch.status === "running") return "Verifying release";
  if (batch.status === "cancelled") return "Release verification cancelled";
  if (batch.status === "failed") return "Release verification failed";
  if (batch.status === "completed" && batch.errors > 0) {
    return "Release verification finished with errors";
  }
  if (
    batch.status === "completed" &&
    batch.total > 0 &&
    batch.verified === batch.total
  ) {
    return "Release verified";
  }
  return "Release verification finished";
};

const batchTotalsLabel = (batch: ReleaseVerificationBatchState): string => {
  const counts = [
    `${batch.settled}/${batch.total} settled`,
    `${batch.verified} verified`,
    `${batch.notVerified} not verified`,
    `${batch.unavailable} unavailable`,
    `${batch.errors} failed`,
  ];
  if (batch.existing > 0) {
    counts.push(`${batch.existing} already running`);
  }
  return counts.join(" · ");
};

function provenance(release: RecentRelease): {
  description: string;
  label: string;
  variant: "outline" | "secondary";
} | null {
  if (release.source === "unavailable") {
    return {
      description:
        "Release membership could not be established, so verification is unavailable.",
      label: "Unavailable",
      variant: "outline",
    };
  }
  if (release.source === "notes-fallback") {
    return {
      description:
        "Pull requests were discovered from GitHub release notes. Verification rechecks exact release membership.",
      label: "Release notes",
      variant: "secondary",
    };
  }
  if (!release.complete) {
    return {
      description:
        "Release membership may be incomplete. Verification rechecks exact release membership.",
      label: "Partial",
      variant: "outline",
    };
  }
  return null;
}

function ProvenanceBadge({ release }: { release: RecentRelease }) {
  const source = provenance(release);
  if (!source) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild variant={source.variant}>
          <button
            aria-label={source.label}
            className="cursor-help"
            type="button"
          >
            {source.label}
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{source.description}</TooltipContent>
    </Tooltip>
  );
}

const verifyAllDisabledReason = (
  release: RecentRelease,
  active: boolean,
): string | null => {
  if (active) return "Verify all is unavailable while verification is running.";
  if (release.source === "unavailable") {
    return "Verify all is unavailable because release membership could not be established.";
  }
  if (release.pulls.length === 0) {
    return "Verify all is unavailable because this release has no authored pull requests.";
  }
  if (!canVerifyEntireRelease(release)) {
    return "Verify all is unavailable because this release has an invalid repository, tag, or pull request identity.";
  }
  return null;
};

function ReleasedPullRow({
  pull,
  release,
  run,
  batchActive,
  directActive,
  cancel,
  start,
}: {
  cancel: (key: string) => Promise<void>;
  batchActive: boolean;
  directActive: boolean;
  pull: ReleasedPull;
  release: RecentRelease;
  run: VerificationRunState;
  start: (release: RecentRelease, pull: ReleasedPull) => Promise<void>;
}) {
  const key = verificationKey(release, pull);
  const active = isVerificationActive(run);
  const supported = canVerifyRelease(release, pull);

  return (
    <li className="px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] leading-4 text-muted-foreground">
            {pull.repository} #{pull.number}
          </p>
          <a
            className="block truncate text-sm font-medium underline-offset-4 hover:underline"
            href={pull.url}
            rel="noreferrer"
            target="_blank"
          >
            {pull.title}
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {run.status === "completed" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {run.outcome === "verified" ? (
                <CircleCheck aria-hidden="true" className="size-3.5" />
              ) : run.outcome === "unavailable" ? (
                <CircleDashed aria-hidden="true" className="size-3.5" />
              ) : (
                <CircleX aria-hidden="true" className="size-3.5" />
              )}
              {verificationStatusLabel(run)}
            </span>
          )}
          <Button
            disabled={batchActive || active || !supported}
            onClick={() => void start(release, pull)}
            size="sm"
            title={
              !supported
                ? "Verification requires a listed pull request and available release membership."
                : release.source === "notes-fallback"
                  ? "Discovered from GitHub release notes. Verify will recheck exact adjacent-tag membership before the selected agent runs."
                  : undefined
            }
            type="button"
            variant="outline"
          >
            {active ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
            {active
              ? "Verifying…"
              : run.status === "idle"
                ? "Verify"
                : "Verify again"}
          </Button>
          {active && (directActive || !batchActive) && (
            <Button
              aria-label={`Cancel verification for ${pull.repository} #${pull.number}`}
              disabled={run.cancelling}
              onClick={() => void cancel(key)}
              size="icon-sm"
              title="Cancel verification"
              type="button"
              variant="ghost"
            >
              <Square aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <VerificationTerminal pull={pull} state={run} />
    </li>
  );
}

function ReleaseGroup({
  batches,
  release,
  runs,
}: {
  batches: ReturnType<typeof useReleaseVerificationBatches>;
  release: RecentRelease;
  runs: ReturnType<typeof useVerificationRuns>;
}) {
  const batch =
    batches.states.get(releaseVerificationKey(release)) ??
    IDLE_RELEASE_VERIFICATION_STATE;
  const batchActive = batch.status === "starting" || batch.status === "running";
  const directActive = release.pulls.some((pull) =>
    isVerificationActive(runs.states.get(verificationKey(release, pull))),
  );
  const disabledReason = verifyAllDisabledReason(
    release,
    batchActive || directActive,
  );
  const disabledReasonId = useId();
  const pullListId = useId();
  const [open, setOpen] = useState(false);
  const [individual, setIndividual] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pullCount = release.pulls.length;
  const pullLabel = pullCount === 1 ? "pull request" : "pull requests";
  const startBatch = (): void => {
    if (directActive) return;
    setIndividual(new Set());
    void batches.start(release);
  };
  const startPull = async (
    selectedRelease: RecentRelease,
    pull: ReleasedPull,
  ): Promise<void> => {
    const key = verificationKey(selectedRelease, pull);
    setIndividual((current) => new Set(current).add(key));
    await runs.start(selectedRelease, pull);
  };

  return (
    <Collapsible className="min-w-0 w-full" onOpenChange={setOpen} open={open}>
      <Card className="min-w-0 w-full gap-0 overflow-hidden py-0" size="sm">
        <CardHeader className="gap-2 px-3 py-2.5">
          <div className="min-w-0 overflow-hidden">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <a
                className="truncate text-sm font-semibold underline-offset-4 hover:underline"
                href={release.url}
                rel="noreferrer"
                target="_blank"
              >
                {release.name}
                <ExternalLink
                  aria-hidden="true"
                  className="ml-1 inline size-3"
                />
              </a>
              <Badge className="font-mono" variant="secondary">
                {release.tag}
              </Badge>
              <ProvenanceBadge release={release} />
            </div>
            <div className="mt-1 flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <a
                  className="min-w-0 truncate underline-offset-4 hover:text-foreground hover:underline"
                  href={release.repositoryUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {release.repository}
                </a>
                <span aria-hidden="true">·</span>
                <time className="shrink-0" dateTime={release.publishedAt}>
                  {formatRelativeTime(release.publishedAt)}
                </time>
              </span>
              <PipelineStatus release={release} />
            </div>
          </div>
          <CardAction className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5 self-center">
            <Badge
              aria-label={`${pullCount} authored ${pullLabel}`}
              className="tabular-nums"
              variant="outline"
            >
              {pullCount} PR{pullCount === 1 ? "" : "s"}
            </Badge>
            <Button
              aria-describedby={disabledReason ? disabledReasonId : undefined}
              aria-label={`Verify all pull requests in ${release.name}`}
              disabled={disabledReason !== null}
              onClick={startBatch}
              size="sm"
              type="button"
              variant="outline"
            >
              {batchActive ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              {batchActive
                ? `${batch.settled}/${batch.total}`
                : batch.status === "idle"
                  ? "Verify all"
                  : "Verify all again"}
            </Button>
            {disabledReason && (
              <span className="sr-only" id={disabledReasonId}>
                {disabledReason}
              </span>
            )}
            {batchActive && (
              <Button
                aria-label={`Cancel verification of all pull requests in ${release.name}`}
                disabled={batch.cancelling}
                onClick={() => void batches.cancel(release)}
                size="icon-sm"
                title="Cancel all verifications"
                type="button"
                variant="ghost"
              >
                <Square aria-hidden="true" />
              </Button>
            )}
            {pullCount > 0 && (
              <CollapsibleTrigger asChild>
                <Button
                  aria-controls={pullListId}
                  aria-label={`${open ? "Hide" : "Show"} ${pullCount} ${pullLabel} in ${release.tag}`}
                  size="icon-sm"
                  title={`${open ? "Hide" : "Show"} ${pullLabel}`}
                  type="button"
                  variant="ghost"
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={`transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                  />
                </Button>
              </CollapsibleTrigger>
            )}
          </CardAction>
        </CardHeader>

        {batch.status !== "idle" && (
          <div
            aria-live="polite"
            className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
            role="status"
          >
            <span>{batchStatusLabel(batch)}</span>
            <span className="tabular-nums">{batchTotalsLabel(batch)}</span>
            {batch.error && (
              <span className="basis-full text-destructive">{batch.error}</span>
            )}
          </div>
        )}

        {pullCount > 0 ? (
          <CollapsibleContent
            aria-hidden={!open}
            className="release-pulls-content min-w-0 w-full overflow-hidden data-[state=closed]:h-0 data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:animate-[release-pulls-up_160ms_ease-in] data-[state=open]:animate-[release-pulls-down_180ms_ease-out] motion-reduce:animate-none"
            forceMount
            id={pullListId}
            inert={!open}
          >
            <Separator />
            <ul
              aria-label={`Pull requests in ${release.name}`}
              className="min-w-0 w-full divide-y"
            >
              {release.pulls.map((pull) =>
                (() => {
                  const key = verificationKey(release, pull);
                  const direct = runs.states.get(key);
                  const batched = batches.pullStates.get(key);
                  const activeDirect =
                    direct !== undefined && isVerificationActive(direct);
                  return (
                    <ReleasedPullRow
                      batchActive={batchActive}
                      cancel={runs.cancel}
                      directActive={activeDirect}
                      key={pull.url}
                      pull={pull}
                      release={release}
                      run={
                        activeDirect || individual.has(key)
                          ? (direct ?? IDLE_VERIFICATION_STATE)
                          : (batched ?? direct ?? IDLE_VERIFICATION_STATE)
                      }
                      start={startPull}
                    />
                  );
                })(),
              )}
            </ul>
          </CollapsibleContent>
        ) : (
          <>
            <Separator />
            <CardContent className="px-3 py-2.5 text-sm text-muted-foreground">
              <p>
                {release.source === "unavailable"
                  ? "Authored pull request membership could not be verified for this release."
                  : "No authored pull requests were found in this release."}
              </p>
            </CardContent>
          </>
        )}
      </Card>
    </Collapsible>
  );
}

export default function RecentReleases({
  agent = "claude",
  data,
  error,
  loading,
  onRefresh,
}: RecentReleasesProps) {
  const releases = data?.releases ?? [];
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(releases.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginated =
    releases.length > PAGE_SIZE
      ? releases.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
      : releases;
  const runs = useVerificationRuns(releases, data?.partial !== true, agent);
  const batches = useReleaseVerificationBatches(
    releases,
    data?.partial !== true,
    agent,
    runs.states,
  );
  const dates = groupReleasesByDate(paginated);
  const headingId = "recent-releases-heading";
  const rawWarnings = [
    ...new Set(
      (data?.warnings ?? [])
        .map((warning) => warning.trim())
        .filter((warning) => warning.length > 0),
    ),
  ];
  const warnings = rawWarnings.filter(
    (warning) => !HIDDEN_HISTORY_WARNINGS.has(warning),
  );
  const suppressedWarningsOnly =
    rawWarnings.length > 0 && warnings.length === 0;
  const hasPartialHistory =
    warnings.length > 0 || (data?.partial === true && !suppressedWarningsOnly);

  useEffect(() => {
    if (data === null) return;
    setPage((current) => Math.min(current, pageCount));
  }, [data, pageCount]);

  return (
    <TooltipProvider>
      <section
        aria-labelledby={headingId}
        className="recent-releases flex min-h-0 flex-col gap-2.5"
        data-recent-releases=""
      >
        <Collapsible
          className="recent-releases-header shrink-0"
          data-release-header=""
        >
          <header className="flex items-center justify-between gap-2 px-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                className="font-heading truncate text-sm leading-none font-semibold"
                id={headingId}
              >
                Recently released
              </h2>
              <Badge
                aria-label={`${releases.length} recent ${releases.length === 1 ? "release" : "releases"}`}
                className="tabular-nums"
                variant="secondary"
              >
                {releases.length}
              </Badge>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {hasPartialHistory && (
                <CollapsibleTrigger asChild>
                  <Button
                    className="text-muted-foreground"
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Partial history
                    <ChevronDown
                      aria-hidden="true"
                      className="transition-transform group-aria-expanded/button:rotate-180"
                    />
                  </Button>
                </CollapsibleTrigger>
              )}
              <Button
                aria-label="Refresh recent releases"
                disabled={loading}
                onClick={onRefresh}
                size="icon-sm"
                title="Refresh recent releases"
                type="button"
                variant="ghost"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={loading ? "animate-spin" : undefined}
                />
              </Button>
            </div>
          </header>
          {hasPartialHistory && (
            <CollapsibleContent>
              <div className="mx-0.5 mt-2 border-l-2 border-border px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground">
                <p>History may be incomplete.</p>
                {warnings.length > 0 && (
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>

        <div
          className="recent-releases-body min-h-0 flex-1 space-y-2.5 lg:overflow-y-auto lg:overscroll-contain"
          data-release-page={currentPage}
          data-release-scroll-body=""
        >
          {error && (
            <Card className="gap-2 py-3" role="status" size="sm">
              <CardContent className="flex flex-col items-start gap-2 px-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground">
                  Recent releases could not be loaded: {error}
                </p>
                <Button
                  onClick={onRefresh}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </CardContent>
            </Card>
          )}

          {!data && loading && (
            <div
              aria-label="Loading recent releases"
              className="grid gap-2"
              role="status"
            >
              <Card className="gap-3" size="sm">
                <CardContent className="space-y-3 px-3">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-9 w-full" />
                </CardContent>
              </Card>
            </div>
          )}

          {data && releases.length === 0 && (
            <Card size="sm">
              <CardContent className="px-3 py-1 text-sm text-muted-foreground">
                <p>No authored pull requests were found in recent releases.</p>
              </CardContent>
            </Card>
          )}

          {releases.length > 0 && (
            <div className="grid gap-4" data-release-list="">
              {dates.map((date) => (
                <section
                  aria-labelledby={`release-date-${date.date}`}
                  className="space-y-2"
                  data-release-date={date.date}
                  key={date.date}
                >
                  <header
                    className="release-date-heading sticky top-0 z-10 flex items-center justify-between gap-2 bg-background px-0.5 py-1"
                    data-release-date-heading=""
                  >
                    <h3
                      className="text-xs font-medium text-foreground"
                      id={`release-date-${date.date}`}
                    >
                      {date.date === "unknown" ? (
                        date.label
                      ) : (
                        <time dateTime={date.date}>{date.label}</time>
                      )}
                    </h3>
                    <Badge className="tabular-nums" variant="outline">
                      {date.releases.length}
                    </Badge>
                  </header>
                  <div className="grid gap-2 pl-1">
                    {date.releases.map((release) => (
                      <ReleaseGroup
                        batches={batches}
                        key={releaseVerificationKey(release)}
                        release={release}
                        runs={runs}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {releases.length > PAGE_SIZE && (
            <nav
              aria-label="Recent releases pagination"
              className="release-pagination flex items-center justify-between gap-2 pt-0.5"
              data-release-pagination=""
            >
              <Button
                aria-label="Previous releases page"
                disabled={currentPage === 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                size="sm"
                type="button"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <span
                aria-live="polite"
                className="text-xs text-muted-foreground tabular-nums"
              >
                Page {currentPage} of {pageCount}
              </span>
              <Button
                aria-label="Next releases page"
                disabled={currentPage === pageCount}
                onClick={() =>
                  setPage((current) => Math.min(pageCount, current + 1))
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}
