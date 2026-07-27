import {
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  ExternalLink,
  LoaderCircle,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, type UIEvent, useLayoutEffect, useRef } from "react";

import { agentLabel } from "../agent";
import { getPullKey, type PullKey } from "../preferences";
import { isTaskActive, type TaskState } from "../tasks";
import { formatRelativeTime } from "../time";
import type { TaskPhase } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import PullActionsMenu, { PullFavoriteIndicator } from "./PullActionsMenu";

type TaskRowProps = {
  cancel: (id: string) => Promise<void>;
  favorite?: boolean;
  hidePull?: (key: PullKey) => void;
  setFavorite?: (key: PullKey, favorite: boolean) => void;
  state: TaskState;
};

const labels: Record<TaskPhase, string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  "opening-pr": "Opening PR",
  preparing: "Creating worktree",
  pushing: "Pushing branch",
  queued: "Queued",
  running: "Running",
};

const phaseBadge = (
  phase: TaskPhase,
): "destructive" | "outline" | "secondary" =>
  phase === "failed"
    ? "destructive"
    : phase === "completed" || phase === "cancelled"
      ? "secondary"
      : "outline";

function TaskRow({
  cancel,
  favorite = false,
  hidePull,
  setFavorite,
  state,
}: TaskRowProps) {
  const reducedMotion = useReducedMotion();
  const terminal = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const active = isTaskActive(state.task);
  const label = agentLabel(state.task.agent);
  const codeLabel = state.task.agent === "codex" ? "Codex" : "Claude Code";
  const phaseLabel =
    state.task.phase === "running"
      ? `${label} running`
      : labels[state.task.phase];
  const identity = state.task.pullRequest
    ? getPullKey({
        number: state.task.pullRequest.number,
        repository: state.task.repository,
      })
    : null;

  useLayoutEffect(() => {
    if (terminal.current && follow.current) {
      terminal.current.scrollTop = terminal.current.scrollHeight;
    }
  }, [state.output]);

  const handleScroll = (event: UIEvent<HTMLPreElement>) => {
    const element = event.currentTarget;
    follow.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 32;
  };

  const icon =
    state.task.phase === "completed" ? (
      <CircleCheck
        aria-hidden="true"
        className="size-4 shrink-0 self-center text-emerald-600 dark:text-emerald-400"
        data-status-active="false"
        data-status-icon="task"
      />
    ) : state.task.phase === "failed" ? (
      <CircleAlert
        aria-hidden="true"
        className="size-4 shrink-0 self-center text-destructive"
        data-status-active="false"
        data-status-icon="task"
      />
    ) : active ? (
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 self-center text-amber-600 motion-safe:animate-spin dark:text-amber-400"
        data-status-active="true"
        data-status-icon="task"
      />
    ) : (
      <CircleDotDashed
        aria-hidden="true"
        className="size-4 shrink-0 self-center text-amber-600 dark:text-amber-400"
        data-status-active="false"
        data-status-icon="task"
      />
    );
  const header = (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="m-0 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {state.task.repository}
          </span>
          <span aria-hidden="true"> · </span>
          <code>{state.task.base}</code>
          {state.task.branch && (
            <>
              <span aria-hidden="true"> → </span>
              <code className="wrap-anywhere">{state.task.branch}</code>
            </>
          )}
          <span aria-hidden="true"> · </span>
          <time dateTime={state.task.updatedAt}>
            {formatRelativeTime(state.task.updatedAt)}
          </time>
        </p>
        {state.task.pullRequest ? (
          <a
            className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            href={state.task.pullRequest.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="min-w-0 wrap-anywhere">{state.task.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              #{state.task.pullRequest.number}
            </span>
            <ExternalLink
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </a>
        ) : (
          <p className="m-0 text-sm font-medium wrap-anywhere sm:text-base">
            {state.task.title}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {favorite && <PullFavoriteIndicator />}
        <Badge
          className={
            active
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              : undefined
          }
          variant={phaseBadge(state.task.phase)}
        >
          {active && (
            <LoaderCircle
              aria-hidden="true"
              className="motion-safe:animate-spin"
              data-icon="inline-start"
            />
          )}
          {phaseLabel}
        </Badge>
      </div>
    </div>
  );
  const headerBoundary =
    identity !== null && hidePull && setFavorite ? (
      <PullActionsMenu
        favorite={favorite}
        onFavoriteChange={(next) => setFavorite(identity, next)}
        onHide={() => hidePull(identity)}
      >
        {header}
      </PullActionsMenu>
    ) : (
      header
    );

  return (
    <motion.li
      aria-label={`Task: ${state.task.title}`}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      data-keyboard-item="task"
      data-task-id={state.task.id}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      layout
      layoutId={`task-row-${state.task.id}`}
      tabIndex={-1}
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
      <Card className="gap-0 py-0" size="sm">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-stretch gap-3">
            {icon}
            <span className="sr-only" role="status">
              {active
                ? `Task active: ${phaseLabel}`
                : `Task status: ${phaseLabel}`}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              {headerBoundary}

              {state.task.error && (
                <p
                  className="m-0 text-xs text-destructive wrap-anywhere"
                  role="alert"
                >
                  {state.task.error}
                </p>
              )}

              {(active || state.output || state.connectionError) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {label} output
                    </span>
                    {state.connectionError && active && (
                      <span
                        className="text-xs text-muted-foreground"
                        role="status"
                      >
                        {state.connectionError}
                      </span>
                    )}
                  </div>
                  <pre
                    aria-label={`${label} output for ${state.task.title}`}
                    aria-busy={active}
                    aria-live="polite"
                    className="max-h-56 min-h-20 overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-100"
                    data-keyboard-scroll-region=""
                    data-task-terminal=""
                    onScroll={handleScroll}
                    ref={terminal}
                    role="log"
                    tabIndex={0}
                  >
                    {state.output || `Waiting for ${codeLabel}…`}
                  </pre>
                </div>
              )}

              {active && (
                <div className="flex justify-end">
                  <Button
                    className="min-h-11 sm:min-h-7"
                    disabled={state.cancelling}
                    onClick={() =>
                      void cancel(state.task.id).catch(() => undefined)
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <X aria-hidden="true" />
                    {state.cancelling ? "Cancelling" : "Cancel task"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.li>
  );
}

export default memo(TaskRow);
