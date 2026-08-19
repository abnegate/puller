import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";

import { useAgentPreference } from "./agent";
import { getPulls, getRecentReleases } from "./api";
import { useAuto, type AutoController } from "./auto";
import AgentToggle from "./components/AgentToggle";
import HiddenPullsMenu, { type HiddenPull } from "./components/HiddenPullsMenu";
import KeyboardShortcuts from "./components/KeyboardShortcuts";
import NewTaskForm from "./components/NewTaskForm";
import ReadinessSection from "./components/ReadinessSection";
import RecentReleases from "./components/RecentReleases";
import ReleaseDialog from "./components/ReleaseDialog";
import { SECTION_PAGE_SIZE } from "./components/SectionPager";
import ThemeToggle from "./components/ThemeToggle";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Skeleton } from "./components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  EMPTY_VIEWED_FILES,
  EMPTY_VIEWED_FILES_BY_PULL,
  getPullDiffKey,
  pruneViewedFiles,
  type ToggleViewedFile,
  type ViewedFilesByPull,
} from "./diffs";
import {
  useDashboardKeyboard,
  type KeyboardItem,
  type KeyboardPages,
  type KeyboardSection,
} from "./keyboard";
import {
  movementPullKey,
  PullMovementTracker,
  type PullMovement,
  type PullMovementEntry,
  type ReadinessRank,
} from "./movements";
import { getPullKey, selectPullView, usePullPreferences } from "./preferences";
import { useReleasePanelPreference } from "./release-panel";
import {
  applyReleasePipelineSnapshot,
  useReleasePipelinePolling,
} from "./release-pipelines";
import {
  PullRowContinuityProvider,
  usePullRowContinuity,
} from "./row-continuity";
import {
  groupPulls,
  isRunExecuting,
  reconcilePulls,
  usePullRuns,
  type RunState,
} from "./runs";
import {
  browserRunTranscriptStore,
  type RunTranscriptStore,
} from "./run-transcripts";
import { ThemeProvider } from "./theme";
import { isTaskActive, useTasks, type TaskState } from "./tasks";
import type {
  CreateReleaseResponse,
  MergePullResponse,
  PullReadiness,
  PullsResponse,
  RecentReleasesResponse,
  ReleasePipelinesResponse,
} from "./types";
import { reconcileRecentReleases } from "./verifications";

const REFRESH_INTERVAL = 10_000;
const REFRESH_CATCH_UP_INTERVAL = 1_000;
const REFRESH_BACKOFFS = [10_000, 20_000, 40_000, 80_000, 120_000] as const;
const RELEASE_REFRESH_INTERVAL = 5 * 60_000;
const CONTINUITY_CONTROL_KEY = "\0pull-row-continuity";
const PULL_ID = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+#[1-9]\d*`;
const SILENT_REVALIDATION_NOTICE = new RegExp(
  String.raw`^GitHub (?:(?:(?:changed CI while refreshing|returned (?:conflicting(?: CI)? state|incomplete evidence) for|could not refresh) ${PULL_ID})|(?:could not completely revalidate (?:this pull request|${PULL_ID})))(?:; (?:readiness|the pull request) was (?:marked incomplete|not updated))?\.$`,
);

const snapshotFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
});

const formatSnapshot = (snapshotAt: string): string => {
  const date = new Date(snapshotAt);

  return Number.isNaN(date.getTime())
    ? "time unavailable"
    : snapshotFormatter.format(date);
};

const refreshBackoff = (failures: number): number =>
  REFRESH_BACKOFFS[Math.min(failures, REFRESH_BACKOFFS.length - 1)]!;

const getErrorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

type PullLoadKind =
  | "automatic"
  | "initial"
  | "manual"
  | "mutation"
  | "visibility";

type PullRequest = {
  controller: AbortController;
  generation: number;
  kind: PullLoadKind;
};

type RecentLoadKind = "background" | "initial" | "manual";

type RecentRequest = {
  controller: AbortController;
  generation: number;
  kind: RecentLoadKind;
};

type ArtifactProof = {
  epoch: number;
  viewerLogin: string | null;
};

const artifactViewer = (snapshot: PullsResponse): string | null => {
  if (snapshot.partial || snapshot.stale || snapshot.viewerLogin === null) {
    return null;
  }

  const viewer = snapshot.viewerLogin.trim().toLowerCase();
  return viewer || null;
};

const pullIdentity = (
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
): string =>
  `${pull.repository.toLowerCase()}#${pull.number}@${pull.headRefOid.toLowerCase()}`;

export const countActiveLocalWork = (
  pulls: readonly PullReadiness[],
  runs: ReadonlyMap<string, RunState>,
  tasks: readonly TaskState[],
): number => {
  const active = new Set<string>();

  for (const pull of pulls) {
    if (isRunExecuting(runs.get(pull.url))) active.add(getPullKey(pull));
  }

  for (const state of tasks) {
    if (!isTaskActive(state.task)) continue;
    const request = state.task.pullRequest;
    active.add(
      request
        ? `${state.task.repository.trim().toLowerCase()}#${request.number}`
        : `task:${state.task.id}`,
    );
  }

  return active.size;
};

function AutoControl({
  auto,
  trusted,
}: {
  auto: AutoController;
  trusted: boolean;
}) {
  const descriptionId = useId();
  const disabled = !auto.available || !trusted;
  const description =
    auto.available && !trusted
      ? "Auto will be available after a complete, current pull request snapshot loads."
      : auto.description;
  const showIndicator =
    auto.enabled && (auto.leader || auto.paused || auto.queued > 0);
  const waiting = auto.paused || auto.status === "queued";
  const active = auto.enabled
    ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300 dark:hover:bg-emerald-400/15 dark:hover:text-emerald-200"
    : "";

  return (
    <div className="min-w-0 flex-1 sm:flex-none">
      <Tooltip>
        <div
          aria-describedby={descriptionId}
          aria-label="Auto fix controls"
          className="inline-flex min-h-11 w-full min-w-0 items-stretch overflow-hidden rounded-md border bg-background shadow-xs sm:min-h-7 sm:w-auto"
          data-auto-control=""
          role="group"
        >
          <TooltipTrigger asChild>
            <span className="flex min-w-0 flex-1 sm:flex-none">
              <Button
                aria-describedby={descriptionId}
                aria-pressed={auto.enabled}
                className={`min-h-0 min-w-0 flex-1 rounded-none border-0 shadow-none sm:flex-none ${active}`}
                data-auto-status={auto.status}
                disabled={disabled}
                onClick={() => auto.setEnabled(!auto.enabled)}
                size="sm"
                type="button"
                variant="outline"
              >
                {showIndicator && (
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${
                      waiting
                        ? "bg-amber-500"
                        : "bg-emerald-500 dark:bg-emerald-400"
                    } ${auto.status === "running" ? "animate-pulse" : ""}`}
                    data-auto-indicator=""
                  />
                )}
                Auto
              </Button>
            </span>
          </TooltipTrigger>
          <Select
            onValueChange={(value) => {
              const parallelism = Number(value);
              if (
                parallelism === 1 ||
                parallelism === 2 ||
                parallelism === 3 ||
                parallelism === 4
              ) {
                auto.setParallelism(parallelism);
              }
            }}
            value={String(auto.parallelism)}
          >
            <SelectTrigger
              aria-label="Auto maximum parallelism"
              className={`h-auto min-h-0 w-[3.75rem] rounded-none border-0 border-l px-2 tabular-nums shadow-none focus-visible:z-10 ${active}`}
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-16" position="popper">
              {[1, 2, 3, 4].map((parallelism) => (
                <SelectItem key={parallelism} value={String(parallelism)}>
                  {parallelism}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TooltipContent sideOffset={6}>{description}</TooltipContent>
      </Tooltip>
      <span className="sr-only" id={descriptionId}>
        Status: {auto.status}. {description}
        {auto.error && auto.error !== description ? ` ${auto.error}` : ""}
      </span>
    </div>
  );
}

function Dashboard({
  runTranscriptStore,
}: {
  runTranscriptStore: RunTranscriptStore;
}) {
  const reducedMotion = useReducedMotion();
  const { agent, setAgent } = useAgentPreference();
  const releasePanel = useReleasePanelPreference();
  const { prune: pruneRowContinuity, remove: removeRowContinuity } =
    usePullRowContinuity(CONTINUITY_CONTROL_KEY);
  const [artifactProof, setArtifactProof] = useState<ArtifactProof>({
    epoch: 0,
    viewerLogin: null,
  });
  const [data, setData] = useState<PullsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPulls, setCurrentPulls] = useState<PullReadiness[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recent, setRecent] = useState<RecentReleasesResponse | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [pipelineRefreshRevision, setPipelineRefreshRevision] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sectionPages, setSectionPages] = useState<KeyboardPages>({
    blocked: 1,
    progress: 1,
    ready: 1,
  });
  const [viewedFiles, setViewedFiles] = useState<ViewedFilesByPull>(
    () => EMPTY_VIEWED_FILES_BY_PULL,
  );
  const helpRestoreFocus = useRef<HTMLElement | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const pullDeadline = useRef<number | null>(null);
  const pullFailures = useRef(0);
  const pullGeneratedAt = useRef<string | null>(null);
  const pullRequest = useRef<PullRequest | null>(null);
  const pullGeneration = useRef(0);
  const recentTimer = useRef<number | null>(null);
  const recentDeadline = useRef<number | null>(null);
  const recentRequest = useRef<RecentRequest | null>(null);
  const recentGeneration = useRef(0);
  const movementTimer = useRef<number | null>(null);
  const movementTracker = useRef(new PullMovementTracker());
  const mounted = useRef(true);
  const mergedPulls = useRef(new Set<string>());
  const loadRef = useRef<(kind?: PullLoadKind) => Promise<void>>(
    async () => undefined,
  );
  const loadRecentRef = useRef<(kind?: RecentLoadKind) => Promise<void>>(
    async () => undefined,
  );
  const applyPipelineSnapshot = useCallback(
    (snapshot: ReleasePipelinesResponse) => {
      setRecent((current) => applyReleasePipelineSnapshot(current, snapshot));
    },
    [],
  );
  useReleasePipelinePolling({
    enabled: releasePanel.pipelinePollingEnabled,
    onSnapshot: applyPipelineSnapshot,
    refreshRevision: pipelineRefreshRevision,
    releases: recent?.releases ?? [],
  });

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(
    (deadline = Date.now() + REFRESH_INTERVAL) => {
      clearRefreshTimer();
      pullDeadline.current = deadline;
      if (document.visibilityState !== "visible") return;

      refreshTimer.current = window.setTimeout(
        () => {
          refreshTimer.current = null;
          if (document.visibilityState === "visible") {
            void loadRef.current("automatic");
          }
        },
        Math.max(0, deadline - Date.now()),
      );
    },
    [clearRefreshTimer],
  );

  const clearRecentTimer = useCallback(() => {
    if (recentTimer.current !== null) {
      window.clearTimeout(recentTimer.current);
      recentTimer.current = null;
    }
  }, []);

  const scheduleRecentRefresh = useCallback(
    (deadline = Date.now() + RELEASE_REFRESH_INTERVAL) => {
      clearRecentTimer();
      recentDeadline.current = deadline;
      if (document.visibilityState !== "visible") return;

      recentTimer.current = window.setTimeout(
        () => {
          recentTimer.current = null;
          if (document.visibilityState === "visible") {
            void loadRecentRef.current("background");
          }
        },
        Math.max(0, deadline - Date.now()),
      );
    },
    [clearRecentTimer],
  );

  const load = useCallback(
    async (kind: PullLoadKind = "initial") => {
      const active = pullRequest.current;
      if (active) {
        if (
          kind === "automatic" ||
          kind === "initial" ||
          kind === "visibility"
        ) {
          return;
        }
        if (active.kind === "manual") setRefreshing(false);
        active.controller.abort();
      }

      clearRefreshTimer();
      const controller = new AbortController();
      const generation = ++pullGeneration.current;
      pullRequest.current = { controller, generation, kind };
      if (kind === "initial") setInitialLoading(true);
      if (kind === "manual") setRefreshing(true);
      let deadline: number | undefined;

      try {
        const next = await getPulls(
          kind === "manual" || kind === "mutation",
          controller.signal,
        );
        const completedAt = Date.now();
        if (
          !mounted.current ||
          pullRequest.current?.generation !== generation
        ) {
          return;
        }

        if (next.stale) {
          deadline = completedAt + refreshBackoff(pullFailures.current);
          pullFailures.current = Math.min(
            pullFailures.current + 1,
            REFRESH_BACKOFFS.length,
          );
        } else {
          const generatedDeadline =
            Date.parse(next.generatedAt) + REFRESH_INTERVAL;
          deadline =
            generatedDeadline <= completedAt &&
            pullGeneratedAt.current === next.generatedAt
              ? completedAt + REFRESH_CATCH_UP_INTERVAL
              : generatedDeadline;
          pullGeneratedAt.current = next.generatedAt;
          pullFailures.current = 0;
        }

        const pulls = [...next.ready, ...next.notReady];
        const ready = next.ready.filter(
          (pull) => !mergedPulls.current.has(pullIdentity(pull)),
        );
        const notReady = next.notReady.filter(
          (pull) => !mergedPulls.current.has(pullIdentity(pull)),
        );
        const visible = [...ready, ...notReady];
        const snapshot =
          visible.length === pulls.length
            ? next
            : {
                ...next,
                counts: {
                  notReady: notReady.length,
                  ready: ready.length,
                  total: visible.length,
                },
                notReady,
                ready,
              };

        const viewer = artifactViewer(next);
        setArtifactProof((current) => {
          if (current.viewerLogin === viewer) return current;
          return { epoch: current.epoch + 1, viewerLogin: viewer };
        });

        if (!next.partial && !next.stale && viewer !== null) {
          pruneRowContinuity(new Set(visible.map(getPullKey)));
        }
        setCurrentPulls((current) =>
          reconcilePulls(current, visible, !next.partial && !next.stale),
        );
        setData(snapshot);
        setError(null);
      } catch (loadError) {
        if (mounted.current && pullRequest.current?.generation === generation) {
          deadline = Date.now() + refreshBackoff(pullFailures.current);
          pullFailures.current = Math.min(
            pullFailures.current + 1,
            REFRESH_BACKOFFS.length,
          );
          if (!isAbortError(loadError)) {
            setArtifactProof((current) =>
              current.viewerLogin === null
                ? current
                : { epoch: current.epoch + 1, viewerLogin: null },
            );
            setError(
              getErrorText(
                loadError,
                "The readiness service could not be reached.",
              ),
            );
          }
        }
      } finally {
        if (mounted.current && pullRequest.current?.generation === generation) {
          pullRequest.current = null;
          if (kind === "manual") setRefreshing(false);
          setInitialLoading(false);
          scheduleRefresh(deadline);
        }
      }
    },
    [clearRefreshTimer, pruneRowContinuity, scheduleRefresh],
  );

  loadRef.current = load;

  const loadRecent = useCallback(
    async (kind: RecentLoadKind = "initial") => {
      const active = recentRequest.current;
      if (active) {
        if (kind !== "manual" || active.kind === "manual") return;
        active.controller.abort();
      }

      clearRecentTimer();
      const controller = new AbortController();
      const generation = ++recentGeneration.current;
      recentRequest.current = { controller, generation, kind };
      if (kind !== "background") setRecentLoading(true);

      try {
        const next = await getRecentReleases(
          kind === "manual",
          controller.signal,
        );
        if (
          !mounted.current ||
          recentRequest.current?.generation !== generation
        ) {
          return;
        }

        setRecent((current) => reconcileRecentReleases(current, next));
        setPipelineRefreshRevision((revision) => revision + 1);
        setRecentError(null);
      } catch (loadError) {
        if (
          kind !== "background" &&
          mounted.current &&
          recentRequest.current?.generation === generation &&
          !isAbortError(loadError)
        ) {
          setRecentError(
            getErrorText(
              loadError,
              "The release service could not be reached.",
            ),
          );
        }
      } finally {
        if (
          mounted.current &&
          recentRequest.current?.generation === generation
        ) {
          recentRequest.current = null;
          if (kind !== "background") setRecentLoading(false);
          scheduleRecentRefresh();
        }
      }
    },
    [clearRecentTimer, scheduleRecentRefresh],
  );

  loadRecentRef.current = loadRecent;

  useEffect(() => {
    mounted.current = true;
    void loadRef.current("initial");
    void loadRecentRef.current("initial");

    return () => {
      mounted.current = false;
      clearRefreshTimer();
      clearRecentTimer();
      queueMicrotask(() => {
        if (mounted.current) return;

        pullGeneration.current += 1;
        pullRequest.current?.controller.abort();
        pullRequest.current = null;
        pullDeadline.current = null;
        pullGeneratedAt.current = null;
        recentGeneration.current += 1;
        recentRequest.current?.controller.abort();
        recentRequest.current = null;
        recentDeadline.current = null;
      });
    };
  }, [clearRecentTimer, clearRefreshTimer]);

  useEffect(() => {
    const handleVisibleResume = () => {
      clearRefreshTimer();
      clearRecentTimer();
      if (document.visibilityState !== "visible") return;

      const pullDue = pullDeadline.current;
      if (pullDue === null || pullDue <= Date.now()) {
        void loadRef.current("visibility");
      } else {
        scheduleRefresh(pullDue);
      }

      const recentDue = recentDeadline.current;
      if (recentDue === null || recentDue <= Date.now()) {
        void loadRecentRef.current("background");
      } else {
        scheduleRecentRefresh(recentDue);
      }
    };

    document.addEventListener("visibilitychange", handleVisibleResume);
    window.addEventListener("focus", handleVisibleResume);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibleResume);
      window.removeEventListener("focus", handleVisibleResume);
      clearRefreshTimer();
      clearRecentTimer();
    };
  }, [
    clearRecentTimer,
    clearRefreshTimer,
    scheduleRecentRefresh,
    scheduleRefresh,
  ]);

  const refreshAfterRepair = useCallback(() => {
    void loadRef.current("mutation");
  }, []);
  const viewerLogin = artifactProof.viewerLogin;
  const autoAuthoritative =
    data !== null &&
    !initialLoading &&
    error === null &&
    !data.partial &&
    !data.stale &&
    viewerLogin !== null;
  const runs = usePullRuns(currentPulls, refreshAfterRepair, {
    agent,
    authoritative: autoAuthoritative,
    transcriptStore: runTranscriptStore,
  });
  const tasks = useTasks(agent);
  const preferences = usePullPreferences();
  const groupedPulls = useMemo(
    () => groupPulls(currentPulls, runs.states),
    [currentPulls, runs.states],
  );
  const movementEntries = useMemo<readonly PullMovementEntry[]>(
    () =>
      (Object.entries(groupedPulls) as [ReadinessRank, PullReadiness[]][])
        .flatMap(([rank, pulls]) =>
          pulls.map((pull) => ({
            number: pull.number,
            rank,
            repository: pull.repository,
          })),
        )
        .sort((left, right) => {
          const leftKey = movementPullKey(left) ?? "";
          const rightKey = movementPullKey(right) ?? "";
          return leftKey.localeCompare(rightKey);
        }),
    [groupedPulls],
  );
  const view = useMemo(
    () =>
      selectPullView({
        favorites: preferences.favorites,
        hidden: preferences.hidden,
        pulls: currentPulls,
        runs: runs.states,
        tasks: tasks.states,
      }),
    [
      currentPulls,
      preferences.favorites,
      preferences.hidden,
      runs.states,
      tasks.states,
    ],
  );
  const hiddenPulls = useMemo<HiddenPull[]>(
    () =>
      view.hidden.flatMap((item) => {
        if (item.identity === null) return [];
        if (item.kind === "pull") {
          return [
            {
              identity: item.identity,
              number: item.pull.number,
              repository: item.pull.repository,
            },
          ];
        }

        const pullRequest = item.state.task.pullRequest;
        return pullRequest
          ? [
              {
                identity: item.identity,
                number: pullRequest.number,
                repository: item.state.task.repository,
              },
            ]
          : [];
      }),
    [view.hidden],
  );
  const visibleItemKeys = useMemo(
    () =>
      new Set(
        [
          ...view.groups.ready,
          ...view.groups.progress,
          ...view.groups.blocked,
        ].map((item) => item.key),
      ),
    [view.groups.blocked, view.groups.progress, view.groups.ready],
  );
  const keyboardItems = useMemo<readonly KeyboardItem[]>(() => {
    const sectionItems = (
      section: KeyboardSection,
      items: typeof view.groups.ready,
    ): KeyboardItem[] =>
      items.map((item, index) =>
        item.kind === "pull"
          ? {
              identity: item.identity,
              index,
              key: item.key,
              kind: "pull",
              section,
            }
          : {
              id: item.state.task.id,
              index,
              key: item.key,
              kind: "task",
              section,
            },
      );

    return [
      ...sectionItems("ready", view.groups.ready),
      ...sectionItems("progress", view.groups.progress),
      ...sectionItems("blocked", view.groups.blocked),
    ];
  }, [view.groups.blocked, view.groups.progress, view.groups.ready]);
  const artifactEpoch = artifactProof.epoch;
  const refreshAuto = useCallback(
    async (): Promise<void> => loadRef.current("mutation"),
    [],
  );
  const auto = useAuto({
    agent,
    authoritative: autoAuthoritative,
    pulls: currentPulls,
    refresh: refreshAuto,
    runs,
    tasks: tasks.states,
    viewerLogin,
  });
  const [movements, setMovements] = useState<ReadonlyMap<string, PullMovement>>(
    () => new Map(),
  );

  useEffect(() => {
    const tracker = movementTracker.current;
    let cancelled = false;

    const scheduleExpiration = (): void => {
      if (movementTimer.current !== null) {
        window.clearTimeout(movementTimer.current);
        movementTimer.current = null;
      }
      const expiration = tracker.nextExpiration();
      if (expiration === null || cancelled) return;
      movementTimer.current = window.setTimeout(
        () => {
          movementTimer.current = null;
          if (cancelled) return;
          setMovements(tracker.current());
          scheduleExpiration();
        },
        Math.max(0, expiration - Date.now()),
      );
    };

    setMovements(
      tracker.observe({
        complete: autoAuthoritative,
        pulls: movementEntries,
        viewerLogin,
      }),
    );
    scheduleExpiration();

    return () => {
      cancelled = true;
      if (movementTimer.current !== null) {
        window.clearTimeout(movementTimer.current);
        movementTimer.current = null;
      }
    };
  }, [autoAuthoritative, movementEntries, viewerLogin]);

  useEffect(() => {
    setViewedFiles((current) =>
      pruneViewedFiles(current, currentPulls, viewerLogin, artifactEpoch),
    );
  }, [artifactEpoch, currentPulls, viewerLogin]);

  const toggleViewedFile = useCallback<ToggleViewedFile>(
    (pull, path) => {
      if (viewerLogin === null) return;

      const key = getPullDiffKey(pull, viewerLogin, artifactEpoch);

      setViewedFiles((current) => {
        const files = new Set(current.get(key) ?? EMPTY_VIEWED_FILES);

        if (files.has(path)) files.delete(path);
        else files.add(path);

        const next = new Map(current);
        if (files.size === 0) next.delete(key);
        else next.set(key, files);
        return next;
      });
    },
    [artifactEpoch, viewerLogin],
  );

  const observeRepair = runs.observeRepair;

  const handleMerge = useCallback(
    (pull: PullReadiness, response: MergePullResponse) => {
      if (
        response.repository.toLowerCase() !== pull.repository.toLowerCase() ||
        response.number !== pull.number
      ) {
        return;
      }

      if (response.merged) {
        const matches = (candidate: PullReadiness) =>
          candidate.repository.toLowerCase() ===
            pull.repository.toLowerCase() &&
          candidate.number === pull.number &&
          candidate.headRefOid.toLowerCase() === pull.headRefOid.toLowerCase();
        mergedPulls.current.add(pullIdentity(pull));
        removeRowContinuity(getPullKey(pull));
        setCurrentPulls((current) => current.filter((item) => !matches(item)));
        setData((current) => {
          if (!current) return current;
          const ready = current.ready.filter((item) => !matches(item));
          const notReady = current.notReady.filter((item) => !matches(item));
          return {
            ...current,
            counts: {
              notReady: notReady.length,
              ready: ready.length,
              total: ready.length + notReady.length,
            },
            notReady,
            ready,
          };
        });
        void loadRecent("manual");
      } else {
        void observeRepair(pull, response);
      }

      void loadRef.current("mutation");
    },
    [loadRecent, observeRepair, removeRowContinuity],
  );

  const handleManualRefresh = () => {
    void loadRef.current("manual");
    void loadRecent("manual");
  };

  const handleReleaseCreated = useCallback(
    async (_release: CreateReleaseResponse) => {
      await Promise.allSettled([
        loadRef.current("mutation"),
        loadRecent("manual"),
      ]);
    },
    [loadRecent],
  );

  const handleRecentRefresh = useCallback(() => {
    void loadRecent("manual");
  }, [loadRecent]);

  const stats = useMemo(
    () => ({
      active: countActiveLocalWork(currentPulls, runs.states, tasks.states),
      blocked: view.groups.blocked.length,
      open: new Set(currentPulls.map(getPullKey)).size,
      ready: view.groups.ready.length,
    }),
    [currentPulls, runs.states, tasks.states, view.groups],
  );
  const hasGlobalEmptyState = view.visibleCount === 0 && !tasks.loading;
  const allCurrentPullsHidden = hasGlobalEmptyState && view.hiddenCount > 0;
  const notices = [
    tasks.error ? `Task restore failed: ${tasks.error}` : null,
    error && data
      ? `Refresh failed: ${error} Showing the last successful snapshot.`
      : null,
    data?.stale ? "This snapshot is stale." : null,
    data?.partial ? "Some pull requests could not be fully evaluated." : null,
    ...(data?.warnings ?? []).filter(
      (warning) => !SILENT_REVALIDATION_NOTICE.test(warning),
    ),
  ].filter((notice): notice is string => Boolean(notice));
  const setSectionPage = useCallback(
    (section: KeyboardSection, page: number): void => {
      setSectionPages((current) =>
        current[section] === page ? current : { ...current, [section]: page },
      );
    },
    [],
  );
  const setBlockedPage = useCallback(
    (page: number): void => setSectionPage("blocked", page),
    [setSectionPage],
  );
  const setProgressPage = useCallback(
    (page: number): void => setSectionPage("progress", page),
    [setSectionPage],
  );
  const setReadyPage = useCallback(
    (page: number): void => setSectionPage("ready", page),
    [setSectionPage],
  );
  const revealPulls = useCallback((): void => {
    if (!releasePanel.pulls.visible) releasePanel.showSplit();
  }, [releasePanel.pulls.visible, releasePanel.showSplit]);
  const revealReleases = useCallback((): void => {
    if (!releasePanel.releases.visible) releasePanel.showSplit();
  }, [releasePanel.releases.visible, releasePanel.showSplit]);
  const handleHelpOpenChange = useCallback((open: boolean): void => {
    if (open && document.activeElement instanceof HTMLElement) {
      helpRestoreFocus.current = document.activeElement;
    }
    setHelpOpen(open);
  }, []);
  const openHelp = useCallback(
    (): void => handleHelpOpenChange(true),
    [handleHelpOpenChange],
  );

  useDashboardKeyboard({
    items: keyboardItems,
    newPullId: "new-task-prompt",
    onHelp: openHelp,
    onRevealPulls: revealPulls,
    onRevealReleases: revealReleases,
    pageSize: SECTION_PAGE_SIZE,
    pages: sectionPages,
    setPage: setSectionPage,
  });

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-3 py-4 sm:px-5 sm:py-6">
        <header>
          <Card
            className="gap-0 overflow-visible py-0"
            data-dashboard-header=""
            size="sm"
          >
            <CardHeader className="flex flex-col gap-3 px-3 py-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <h1 className="font-heading text-base leading-none font-semibold tracking-tight">
                  Pull readiness
                </h1>
                <dl
                  aria-label="Pull request stats"
                  className="flex min-w-0 items-center divide-x overflow-hidden rounded-md border bg-muted/30 text-xs"
                  data-dashboard-stats=""
                >
                  {(
                    [
                      ["Open", stats.open],
                      ["Ready", stats.ready],
                      ["Blocked", stats.blocked],
                      ["Active", stats.active],
                    ] as const
                  ).map(([label, value]) => (
                    <div
                      aria-label={`${label} ${data ? value : "unavailable"}`}
                      className="flex items-baseline gap-1.5 px-2 py-1"
                      key={label}
                    >
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="m-0 font-medium tabular-nums">
                        {data || label === "Active" ? value : "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:w-auto">
                <div
                  aria-live="polite"
                  className="min-w-0 text-xs whitespace-nowrap text-muted-foreground sm:mr-auto xl:mr-1"
                >
                  {data ? (
                    <>
                      Updated{" "}
                      <time dateTime={data.generatedAt}>
                        {formatSnapshot(data.generatedAt)}
                      </time>
                    </>
                  ) : (
                    "Awaiting snapshot"
                  )}
                </div>
                <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:flex-nowrap">
                  <HiddenPullsMenu
                    hidden={hiddenPulls}
                    onShow={preferences.show}
                    onShowAll={preferences.showAll}
                  />
                  <ReleaseDialog
                    onCreated={handleReleaseCreated}
                    viewerLogin={autoAuthoritative ? viewerLogin : null}
                  />
                  <AutoControl auto={auto} trusted={autoAuthoritative} />
                  <AgentToggle agent={agent} onAgentChange={setAgent} />
                  <ThemeToggle />
                  <KeyboardShortcuts
                    onOpenChange={handleHelpOpenChange}
                    open={helpOpen}
                    restoreFocus={helpRestoreFocus}
                  />
                  <Button
                    aria-controls="pull-requests-panel"
                    aria-expanded={releasePanel.pulls.visible}
                    aria-label={
                      releasePanel.pulls.visible
                        ? "Hide pull requests"
                        : "Show pull requests"
                    }
                    className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
                    data-pull-panel-toggle=""
                    onClick={releasePanel.togglePulls}
                    size="icon-sm"
                    title={
                      releasePanel.pulls.visible
                        ? "Focus recent releases"
                        : "Show pull requests"
                    }
                    type="button"
                    variant="outline"
                  >
                    {releasePanel.pulls.visible ? (
                      <PanelLeftClose aria-hidden="true" />
                    ) : (
                      <PanelLeftOpen aria-hidden="true" />
                    )}
                  </Button>
                  <Button
                    aria-controls="recent-releases-panel"
                    aria-expanded={releasePanel.releases.visible}
                    aria-label={
                      releasePanel.releases.visible
                        ? "Hide recent releases"
                        : "Show recent releases"
                    }
                    className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
                    data-release-panel-toggle=""
                    onClick={releasePanel.toggleReleases}
                    size="icon-sm"
                    title={
                      releasePanel.releases.visible
                        ? "Focus pull requests"
                        : "Show recent releases"
                    }
                    type="button"
                    variant="outline"
                  >
                    {releasePanel.releases.visible ? (
                      <PanelRightClose aria-hidden="true" />
                    ) : (
                      <PanelRightOpen aria-hidden="true" />
                    )}
                  </Button>
                  <Button
                    aria-busy={refreshing}
                    className="min-h-11 flex-1 sm:min-h-7 sm:flex-none"
                    disabled={initialLoading || refreshing}
                    onClick={handleManualRefresh}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={refreshing ? "animate-spin" : undefined}
                      data-icon="inline-start"
                    />
                    {refreshing ? "Refreshing" : "Refresh"}
                  </Button>
                </div>
              </div>
            </CardHeader>

            <Separator />
            <CardContent className="bg-muted/20 p-0">
              <NewTaskForm
                error={tasks.optionsError}
                loading={tasks.optionsLoading}
                options={tasks.options}
                refreshOptions={tasks.refreshOptions}
                start={tasks.start}
              />
            </CardContent>
          </Card>
        </header>

        {notices.length > 0 && (
          <Card
            className="gap-0 bg-muted/40 py-0"
            data-dashboard-notices=""
            role="status"
            size="sm"
          >
            <CardContent className="space-y-1 px-3 py-2.5 text-xs text-muted-foreground">
              {notices.map((notice, index) => (
                <p key={`${notice}-${index}`}>{notice}</p>
              ))}
            </CardContent>
          </Card>
        )}

        <div
          className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.8fr)] xl:grid-cols-[minmax(0,2fr)_minmax(24rem,0.9fr)]"
          data-dashboard-columns=""
          data-dashboard-mode={releasePanel.mode}
        >
          <div
            aria-hidden={releasePanel.pulls.ariaHidden}
            className="min-w-0 space-y-5"
            data-pull-column=""
            data-state={releasePanel.pulls.dataState}
            id="pull-requests-panel"
            inert={releasePanel.pulls.inert}
          >
            {!data && initialLoading && (
              <section
                aria-busy="true"
                aria-labelledby="loading-heading"
                aria-live="polite"
              >
                <div className="sr-only">
                  <h2 id="loading-heading">Loading pull requests…</h2>
                  <p>
                    Checking review threads, CI checks, and Greptile confidence.
                  </p>
                </div>
                <div aria-hidden="true" className="grid gap-5">
                  {["Ready", "In progress", "Not ready"].map((section) => (
                    <div
                      className="space-y-2.5"
                      data-loading-section={section}
                      key={section}
                    >
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-5 w-8 rounded-full" />
                      </div>
                      <Card className="gap-3" size="sm">
                        <CardContent className="space-y-3 px-3">
                          <Skeleton className="h-3 w-32" />
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </CardContent>
                      </Card>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!data && error && !initialLoading && (
              <Card role="alert" size="sm">
                <CardHeader className="px-3">
                  <h2 className="font-heading text-sm font-medium">
                    The pull request snapshot is unavailable.
                  </h2>
                </CardHeader>
                <CardContent className="px-3 text-sm text-muted-foreground">
                  <p>{error}</p>
                </CardContent>
                <CardFooter className="justify-end px-3 py-2.5">
                  <Button
                    className="min-h-11 sm:min-h-7"
                    onClick={() => void loadRef.current("manual")}
                    size="sm"
                    type="button"
                  >
                    Try again
                  </Button>
                </CardFooter>
              </Card>
            )}

            <AnimatePresence initial={false}>
              {!data && !tasks.loading && view.visibleCount > 0 && (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  key="task-readiness"
                  layout
                  transition={reducedMotion ? { duration: 0 } : undefined}
                >
                  <LayoutGroup id="task-readiness">
                    <ReadinessSection
                      agent={agent}
                      artifactEpoch={artifactEpoch}
                      emptyMessage="No CI checks or local fixes are in progress."
                      hidePull={preferences.hide}
                      items={view.groups.progress}
                      movements={movements}
                      onMutationComplete={handleMerge}
                      onToggleViewed={toggleViewedFile}
                      onPageChange={setProgressPage}
                      page={sectionPages.progress}
                      runs={runs}
                      setFavorite={preferences.setFavorite}
                      taskCancel={tasks.cancel}
                      title="In progress"
                      variant="progress"
                      visibleItemKeys={visibleItemKeys}
                      viewerLogin={viewerLogin}
                      viewedFiles={EMPTY_VIEWED_FILES_BY_PULL}
                    />
                  </LayoutGroup>
                </motion.div>
              )}

              {!data && !tasks.loading && allCurrentPullsHidden && (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  key="tasks-hidden"
                  layout
                  transition={reducedMotion ? { duration: 0 } : undefined}
                >
                  <Card size="sm">
                    <CardHeader className="px-3">
                      <h2 className="font-heading text-sm font-medium">
                        All open pull requests are hidden.
                      </h2>
                    </CardHeader>
                    <CardContent className="px-3 text-sm text-muted-foreground">
                      <p>Use the Hidden menu above to show them again.</p>
                    </CardContent>
                  </Card>
                </motion.div>
              )}

              {data && hasGlobalEmptyState && (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  key={allCurrentPullsHidden ? "all-hidden" : "global-empty"}
                  layout
                  transition={reducedMotion ? { duration: 0 } : undefined}
                >
                  <Card size="sm">
                    <CardHeader className="px-3">
                      <h2 className="font-heading text-sm font-medium">
                        {allCurrentPullsHidden
                          ? "All open pull requests are hidden."
                          : "No open authored pull requests."}
                      </h2>
                    </CardHeader>
                    <CardContent className="px-3 text-sm text-muted-foreground">
                      <p>
                        {allCurrentPullsHidden
                          ? "Use the Hidden menu above to show them again."
                          : "The current GitHub query returned no results."}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              )}

              {data && !hasGlobalEmptyState && (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  key="pull-readiness"
                  layout="position"
                  transition={reducedMotion ? { duration: 0 } : undefined}
                >
                  <LayoutGroup id="pull-readiness">
                    <div className="flex flex-col gap-5">
                      <ReadinessSection
                        agent={agent}
                        artifactEpoch={artifactEpoch}
                        emptyMessage="No pulls meet every readiness check."
                        hidePull={preferences.hide}
                        items={view.groups.ready}
                        movements={movements}
                        onMutationComplete={handleMerge}
                        onToggleViewed={toggleViewedFile}
                        onPageChange={setReadyPage}
                        page={sectionPages.ready}
                        runs={runs}
                        setFavorite={preferences.setFavorite}
                        title="Ready"
                        variant="ready"
                        visibleItemKeys={visibleItemKeys}
                        viewerLogin={viewerLogin}
                        viewedFiles={viewedFiles}
                      />
                      <ReadinessSection
                        agent={agent}
                        artifactEpoch={artifactEpoch}
                        emptyMessage="No CI checks or local fixes are in progress."
                        hidePull={preferences.hide}
                        items={view.groups.progress}
                        movements={movements}
                        onMutationComplete={handleMerge}
                        onToggleViewed={toggleViewedFile}
                        onPageChange={setProgressPage}
                        page={sectionPages.progress}
                        runs={runs}
                        setFavorite={preferences.setFavorite}
                        taskCancel={tasks.cancel}
                        title="In progress"
                        variant="progress"
                        visibleItemKeys={visibleItemKeys}
                        viewerLogin={viewerLogin}
                        viewedFiles={viewedFiles}
                      />
                      <ReadinessSection
                        agent={agent}
                        artifactEpoch={artifactEpoch}
                        emptyMessage="No pull requests are waiting on fixes."
                        hidePull={preferences.hide}
                        items={view.groups.blocked}
                        movements={movements}
                        onMutationComplete={handleMerge}
                        onToggleViewed={toggleViewedFile}
                        onPageChange={setBlockedPage}
                        page={sectionPages.blocked}
                        runs={runs}
                        setFavorite={preferences.setFavorite}
                        title="Not ready"
                        variant="blocked"
                        visibleItemKeys={visibleItemKeys}
                        viewerLogin={viewerLogin}
                        viewedFiles={viewedFiles}
                      />
                    </div>
                  </LayoutGroup>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <aside
            aria-hidden={releasePanel.releases.ariaHidden}
            className="min-w-0"
            data-release-column=""
            data-state={releasePanel.releases.dataState}
            id="recent-releases-panel"
            inert={releasePanel.releases.inert}
          >
            <RecentReleases
              agent={agent}
              data={recent}
              error={recentError}
              loading={recentLoading}
              onRefresh={handleRecentRefresh}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}

export type AppProps = {
  runTranscriptStore?: RunTranscriptStore;
};

export default function App({
  runTranscriptStore = browserRunTranscriptStore,
}: AppProps) {
  return (
    <ThemeProvider defaultTheme="system">
      <TooltipProvider>
        <PullRowContinuityProvider>
          <Dashboard runTranscriptStore={runTranscriptStore} />
        </PullRowContinuityProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
