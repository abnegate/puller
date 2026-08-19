import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  EMPTY_VIEWED_FILES,
  getPullDiffKey,
  type ToggleViewedFile,
  type ViewedFilesByPull,
} from "../diffs";
import type { PullMovement } from "../movements";
import type { PullKey, PullSectionItem } from "../preferences";
import { usePullRowContinuity, type PullRowVariant } from "../row-continuity";
import { IDLE_RUN_STATE, type PullRuns } from "../runs";
import type { Agent, MergePullResponse, PullReadiness } from "../types";
import PullRow from "./PullRow";
import SectionPager, {
  SECTION_PAGE_SIZE,
  useSectionPager,
} from "./SectionPager";
import TaskRow from "./TaskRow";

export type ReadinessSectionProps = {
  agent?: Agent;
  artifactEpoch: number;
  defaultPage?: number;
  emptyMessage: string;
  onMutationComplete?: (
    pull: PullReadiness,
    response: MergePullResponse,
  ) => void;
  hidePull?: (key: PullKey) => void;
  items: readonly PullSectionItem[];
  movements?: ReadonlyMap<string, PullMovement>;
  onToggleViewed: ToggleViewedFile;
  onPageChange?: (page: number) => void;
  page?: number;
  pageResetKey?: unknown;
  runs: PullRuns;
  setFavorite?: (key: PullKey, favorite: boolean) => void;
  taskCancel?: (id: string) => Promise<void>;
  title: string;
  variant: "ready" | "progress" | "blocked";
  visibleItemKeys: ReadonlySet<string>;
  viewerLogin: string | null;
  viewedFiles: ViewedFilesByPull;
};

type ListTransition = {
  keys: readonly string[];
  showList: boolean;
  signature: string;
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

function FocusedPageReveal({
  index,
  pull,
  reveal,
  variant,
}: {
  index: number;
  pull: PullKey;
  reveal: (key: PullKey) => boolean;
  variant: PullRowVariant;
}) {
  const { entry } = usePullRowContinuity(pull);
  const focusWasActive = useRef(false);
  if (hasActivePullIdentity(pull)) focusWasActive.current = true;
  if (entry.focus === null) focusWasActive.current = false;

  useLayoutEffect(() => {
    if (entry.focus === null || entry.variant === variant) return;
    if (!focusWasActive.current && !hasActivePullIdentity(pull)) return;
    reveal(pull);
  }, [entry.focus, entry.variant, index, pull, reveal, variant]);

  return null;
}

function ReadinessSection({
  agent = "claude",
  artifactEpoch,
  defaultPage,
  emptyMessage,
  hidePull,
  items,
  movements,
  onMutationComplete,
  onToggleViewed,
  onPageChange,
  page,
  pageResetKey,
  runs,
  setFavorite,
  taskCancel,
  title,
  variant,
  visibleItemKeys,
  viewerLogin,
  viewedFiles,
}: ReadinessSectionProps) {
  const headingId = `${variant}-heading`;
  const count = items.length;
  const hasTasks = items.some((item) => item.kind === "task");
  const label = hasTasks
    ? `${count} in progress ${count === 1 ? "item" : "items"}`
    : `${count} pull ${count === 1 ? "request" : "requests"}`;
  const pagination = useSectionPager({
    count,
    defaultPage,
    onPageChange,
    page,
    resetKey: pageResetKey,
  });
  const itemsRef = useRef(items);
  const setPageRef = useRef(pagination.setPage);
  itemsRef.current = items;
  setPageRef.current = pagination.setPage;
  const revealFocusedPull = useCallback((key: PullKey): boolean => {
    const index = itemsRef.current.findIndex(
      (item) => item.kind === "pull" && item.identity === key,
    );
    if (index < 0) return false;

    setPageRef.current(Math.floor(index / SECTION_PAGE_SIZE) + 1);
    return true;
  }, []);
  const pageItems = items.slice(pagination.start, pagination.end);
  const keys = pageItems.map((item) => item.key);
  const signature = JSON.stringify(keys);
  const [transition, setTransition] = useState<ListTransition>(() => ({
    keys,
    showList: count > 0,
    signature,
  }));
  let currentTransition = transition;

  if (transition.signature !== signature) {
    const removed = transition.keys.filter((key) => !keys.includes(key));
    const moved = removed.some((key) => visibleItemKeys.has(key));
    currentTransition = {
      keys,
      showList: count > 0 || (removed.length > 0 && !moved),
      signature,
    };
    setTransition(currentTransition);
  }

  const finishExit = useCallback(() => {
    setTransition((current) =>
      current.keys.length === 0 && current.showList
        ? { ...current, showList: false }
        : current,
    );
  }, []);
  const updateFavorite = useCallback(
    (key: PullKey, favorite: boolean): void => {
      if (favorite) pagination.setPage(1);
      setFavorite?.(key, favorite);
    },
    [pagination.setPage, setFavorite],
  );
  const rowSetFavorite = setFavorite ? updateFavorite : undefined;

  return (
    <section
      aria-labelledby={headingId}
      className="readiness-section relative"
      data-readiness-section={variant}
    >
      <header
        className="readiness-section-header sticky top-0 z-40 flex items-center justify-between gap-3 bg-background/95 px-0.5 py-2 shadow-none backdrop-blur-sm"
        data-readiness-section-header=""
      >
        <h2
          className="font-heading text-sm leading-none font-semibold"
          id={headingId}
        >
          {title}
        </h2>
        <Badge aria-label={label} className="tabular-nums" variant="secondary">
          {count}
        </Badge>
      </header>

      <div
        className="readiness-section-body relative space-y-2.5 pt-2"
        data-readiness-section-body=""
        data-section-page={pagination.page}
      >
        {items.map((item, index) =>
          item.kind === "pull" ? (
            <FocusedPageReveal
              index={index}
              key={`focus:${item.identity}`}
              pull={item.identity}
              reveal={revealFocusedPull}
              variant={variant}
            />
          ) : null,
        )}
        {currentTransition.showList ? (
          <ul
            className="relative grid list-none gap-2 p-0"
            aria-label={hasTasks ? `${title} items` : `${title} pull requests`}
          >
            <AnimatePresence initial={false} onExitComplete={finishExit}>
              {pageItems.map((item) =>
                item.kind === "task" ? (
                  taskCancel ? (
                    <TaskRow
                      cancel={taskCancel}
                      favorite={item.favorite}
                      hidePull={hidePull}
                      key={item.key}
                      setFavorite={rowSetFavorite}
                      state={item.state}
                    />
                  ) : null
                ) : (
                  <PullRow
                    agent={agent}
                    artifactEpoch={artifactEpoch}
                    cancelRun={runs.cancel}
                    clearReviewRetry={runs.clearReviewRetry}
                    favorite={item.favorite}
                    hidePull={hidePull}
                    key={item.key}
                    loadTranscript={runs.loadTranscript}
                    movement={movements?.get(item.identity) ?? null}
                    onMutationComplete={onMutationComplete}
                    onToggleViewed={onToggleViewed}
                    pull={item.pull}
                    revealFocusedPull={revealFocusedPull}
                    run={runs.states.get(item.pull.url) ?? IDLE_RUN_STATE}
                    setFavorite={rowSetFavorite}
                    startRun={runs.start}
                    variant={variant}
                    viewerLogin={viewerLogin}
                    viewedFiles={
                      viewedFiles.get(
                        getPullDiffKey(item.pull, viewerLogin, artifactEpoch),
                      ) ?? EMPTY_VIEWED_FILES
                    }
                  />
                ),
              )}
            </AnimatePresence>
          </ul>
        ) : (
          <Card size="sm">
            <CardContent className="px-3 py-1 text-sm text-muted-foreground">
              <p>{emptyMessage}</p>
            </CardContent>
          </Card>
        )}
        <SectionPager label={title} {...pagination} />
      </div>
    </section>
  );
}

export default memo(ReadinessSection);
