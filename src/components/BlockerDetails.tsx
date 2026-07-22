import {
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  MessageSquareText,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { getCheckLog, parseGitHubActionsJobUrl } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

import type {
  CICheck,
  GitHubActionsJob,
  PullReadiness,
  ReviewThread,
} from "../types";

type BlockerDetailsProps = {
  pull: PullReadiness;
  viewerLogin: string | null;
};

const shortSha = (value: string | null): string =>
  value ? value.slice(0, 7) : "unknown";

const BREAK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tr",
  "ul",
]);

const OMIT_ELEMENTS = new Set([
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "math",
  "noscript",
  "object",
  "picture",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "video",
]);

const appendBreak = (parts: string[]): void => {
  if (parts.length > 0 && !parts.at(-1)?.endsWith("\n")) {
    parts.push("\n");
  }
};

const appendText = (node: Node, parts: string[]): void => {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.nodeValue ?? "");
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (OMIT_ELEMENTS.has(tag)) {
    return;
  }

  if (tag === "br" || tag === "hr") {
    appendBreak(parts);
    return;
  }

  if (BREAK_ELEMENTS.has(tag)) {
    appendBreak(parts);
  }

  for (const child of element.childNodes) {
    appendText(child, parts);
  }

  if (BREAK_ELEMENTS.has(tag)) {
    appendBreak(parts);
  }
};

export const cleanCommentText = (value: string): string => {
  if (!value) {
    return "";
  }

  const document = new DOMParser().parseFromString(value, "text/html");
  const parts: string[] = [];

  for (const child of document.body.childNodes) {
    appendText(child, parts);
  }

  return parts
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const CHECK_LOG_BODY_BUDGET_BYTES = 1024 * 1024;
export const CHECK_LOG_LINE_BATCH_SIZE = 200;

const CHECK_LOG_CHARACTER_BYTES = 2;
const CHECK_LOG_OMISSION =
  "\n… log output omitted to keep this view responsive …\n";
const logDecoder = new TextDecoder();
const logEncoder = new TextEncoder();

const appendFormattedLogLine = (
  value: string,
  start: number,
  end: number,
  prefix: string,
  parts: string[],
): void => {
  let contentStart = start;

  if (value.startsWith(prefix, start) && start + prefix.length <= end) {
    contentStart += prefix.length;
    const unknownStep = "UNKNOWN STEP\t";

    if (
      value.startsWith(unknownStep, contentStart) &&
      contentStart + unknownStep.length <= end
    ) {
      contentStart += unknownStep.length;
    }
  }

  parts.push(value.slice(contentStart, end));
};

export const formatCheckLog = (value: string, checkName: string): string => {
  if (!value || !checkName) {
    return value;
  }

  const prefix = `${checkName}\t`;
  const parts: string[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\r" && character !== "\n") continue;

    appendFormattedLogLine(value, start, index, prefix, parts);
    if (character === "\r" && value[index + 1] === "\n") {
      parts.push("\r\n");
      index += 1;
    } else {
      parts.push(character);
    }
    start = index + 1;
  }

  if (start < value.length) {
    appendFormattedLogLine(value, start, value.length, prefix, parts);
  }

  return parts.join("");
};

type RetainedCheckLog = {
  body: string;
  lines: number;
  truncated: boolean;
};

export const materializeCheckLog = (value: string): string =>
  logDecoder.decode(logEncoder.encode(value));

const countLogLines = (value: string): number => {
  if (!value) return 0;

  let lines = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") {
      lines += 1;
      if (value[index + 1] === "\n") index += 1;
    } else if (character === "\n") {
      lines += 1;
    }
  }

  const last = value.at(-1);
  return lines + (last === "\r" || last === "\n" ? 0 : 1);
};

const createRetainedCheckLog = (
  value: string,
  truncated: boolean,
): RetainedCheckLog => {
  const body = materializeCheckLog(value);
  return { body, lines: countLogLines(body), truncated };
};

const retainCheckLog = (
  value: string,
  checkName: string,
  budget: number,
): RetainedCheckLog => {
  const characters = Math.max(
    0,
    Math.floor(budget / CHECK_LOG_CHARACTER_BYTES),
  );

  if (value.length <= characters) {
    const body = formatCheckLog(value, checkName);
    return createRetainedCheckLog(body, false);
  }

  if (characters === 0) {
    return createRetainedCheckLog("", value.length > 0);
  }

  if (characters <= CHECK_LOG_OMISSION.length) {
    const body = formatCheckLog(value.slice(-characters), checkName);
    return createRetainedCheckLog(body, true);
  }

  const available = characters - CHECK_LOG_OMISSION.length;
  const headLength = Math.floor(available / 4);
  const tailLength = available - headLength;
  const head = formatCheckLog(value.slice(0, headLength), checkName);
  const tail = formatCheckLog(value.slice(-tailLength), checkName);
  const body = `${head}${CHECK_LOG_OMISSION}${tail}`;

  return createRetainedCheckLog(body, true);
};

const getLogWindow = (value: string, lines: number): string => {
  if (!value || lines <= 0) return "";

  let remaining = lines;
  let index = value.length - 1;

  if (value[index] === "\n") {
    index -= 1;
    if (index >= 0 && value[index] === "\r") index -= 1;
  } else if (value[index] === "\r") {
    index -= 1;
  }

  for (; index >= 0; index -= 1) {
    const character = value[index];
    if (character !== "\r" && character !== "\n") continue;
    const start = index + 1;
    if (character === "\n" && index > 0 && value[index - 1] === "\r") {
      index -= 1;
    }

    remaining -= 1;
    if (remaining === 0) return value.slice(start);
  }

  return value;
};

const isCurrentGreptileReview = (pull: PullReadiness): boolean => {
  if (typeof pull.greptile.current === "boolean") {
    return pull.greptile.current;
  }

  return (
    pull.greptile.reviewedSha !== null &&
    pull.greptile.reviewedSha.toLowerCase() === pull.headRefOid.toLowerCase()
  );
};

const DetailLink = memo(function DetailLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
});

type CheckLogState =
  | { key: string; status: "loading" }
  | { key: string; log: RetainedCheckLog; status: "success" }
  | { error: string; key: string; status: "error" };

type FailedCheckEntry = {
  check: CICheck;
  job: GitHubActionsJob | null;
  key: string;
};

const getFailedChecks = (
  checks: readonly CICheck[],
  repository: string,
): FailedCheckEntry[] => {
  const unique = new Map<string, FailedCheckEntry>();

  for (const check of checks) {
    if (check.state !== "failure") continue;

    const job = parseGitHubActionsJobUrl(check.detailsUrl, repository);
    const key = job
      ? `job:${repository.toLowerCase()}:${job.runId}:${job.jobId}`
      : `check:${check.workflow ?? ""}\u0000${check.name}\u0000${check.detailsUrl ?? ""}`;

    if (!unique.has(key)) unique.set(key, { check, job, key });
  }

  return [...unique.values()];
};

const FailedCheck = memo(function FailedCheck({
  budget,
  entry,
  pull,
  viewerLogin,
}: {
  budget: number;
  entry: FailedCheckEntry;
  pull: PullReadiness;
  viewerLogin: string | null;
}) {
  const { check, job } = entry;
  const [attempt, setAttempt] = useState(0);
  const [visibleLines, setVisibleLines] = useState(CHECK_LOG_LINE_BATCH_SIZE);
  const [state, setState] = useState<CheckLogState | null>(null);
  const requestKey = job
    ? [
        pull.repository.toLowerCase(),
        pull.number,
        pull.baseRefOid.toLowerCase(),
        pull.headRefOid.toLowerCase(),
        viewerLogin?.trim().toLowerCase() ?? "viewer-unavailable",
        entry.key,
        check.name,
        budget,
        attempt,
      ].join(":")
    : null;

  useEffect(() => {
    if (!job || requestKey === null) return;

    const controller = new AbortController();
    let active = true;
    setVisibleLines(CHECK_LOG_LINE_BATCH_SIZE);
    setState({ key: requestKey, status: "loading" });

    void getCheckLog({ ...pull, viewerLogin }, job, controller.signal)
      .then((log) => {
        if (active) {
          setState({
            key: requestKey,
            log: retainCheckLog(log.log, check.name, budget),
            status: "success",
          });
        }
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;

        setState({
          error:
            error instanceof Error
              ? error.message
              : "The check log could not be loaded.",
          key: requestKey,
          status: "error",
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    budget,
    check.name,
    job?.jobId,
    job?.runId,
    pull.baseRefOid,
    pull.headRefOid,
    pull.number,
    pull.repository,
    requestKey,
    viewerLogin,
  ]);

  const current = state?.key === requestKey ? state : null;
  const visibleLog = useMemo(
    () =>
      current?.status === "success"
        ? getLogWindow(current.log.body, visibleLines)
        : null,
    [current, visibleLines],
  );
  const hiddenLines =
    current?.status === "success"
      ? Math.max(0, current.log.lines - visibleLines)
      : 0;
  const revealLines = Math.min(CHECK_LOG_LINE_BATCH_SIZE, hiddenLines);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const reveal = useCallback(
    () => setVisibleLines((lines) => lines + CHECK_LOG_LINE_BATCH_SIZE),
    [],
  );

  return (
    <li className="min-w-0 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 text-xs font-medium wrap-anywhere">
          {check.name}
        </span>
        {check.workflow && (
          <span className="text-[11px] text-muted-foreground">
            {check.workflow}
          </span>
        )}
        {check.detailsUrl && (
          <DetailLink href={check.detailsUrl} label="Open check" />
        )}
      </div>

      {job === null ? (
        <p className="m-0 mt-1 text-[11px] text-muted-foreground">
          Logs unavailable
          <span className="sr-only"> for {check.name}</span>
        </p>
      ) : current?.status === "success" ? (
        <div className="mt-2 space-y-2">
          <pre
            aria-label={`${check.name} logs`}
            className="max-h-72 w-full max-w-full overflow-auto rounded-lg border border-border/70 bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-100 shadow-inner dark:bg-black/60"
            role="region"
            tabIndex={0}
          >
            {visibleLog}
          </pre>
          {(hiddenLines > 0 || current.log.truncated) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {hiddenLines > 0 && (
                <Button
                  aria-label={`Show ${revealLines} earlier ${check.name} log lines`}
                  onClick={reveal}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  Show {revealLines} earlier lines
                </Button>
              )}
              {current.log.truncated && (
                <p className="m-0 text-[11px] text-muted-foreground">
                  Showing a bounded start-and-end preview. Open the check for
                  the complete log.
                </p>
              )}
            </div>
          )}
        </div>
      ) : current?.status === "error" ? (
        <div
          className="mt-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">
            Logs unavailable: {current.error}
          </span>
          <Button
            aria-label={`Retry ${check.name} logs`}
            onClick={retry}
            size="xs"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : (
        <p
          aria-label={`Loading ${check.name} logs`}
          className="m-0 mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          Loading logs…
        </p>
      )}
    </li>
  );
});

const FailedChecks = memo(function FailedChecks({
  checks,
  pull,
  viewerLogin,
}: {
  checks: FailedCheckEntry[];
  pull: PullReadiness;
  viewerLogin: string | null;
}) {
  const supported = checks.reduce(
    (count, entry) => count + (entry.job === null ? 0 : 1),
    0,
  );
  const budget =
    supported === 0 ? 0 : Math.floor(CHECK_LOG_BODY_BUDGET_BYTES / supported);

  return (
    <section className="min-w-0 rounded-lg border bg-muted/15">
      <div className="flex items-center gap-2 px-3 py-2">
        <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />
        <h4 className="m-0 text-xs font-medium">Failed checks</h4>
        <Badge className="ml-auto" variant="destructive">
          {checks.length}
        </Badge>
      </div>
      <Separator />
      {checks.length === 0 ? (
        <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">
          GitHub reported a CI failure, but did not return the failing check
          details.
        </p>
      ) : (
        <ul className="divide-y">
          {checks.map((entry) => (
            <FailedCheck
              budget={budget}
              entry={entry}
              key={entry.key}
              pull={pull}
              viewerLogin={viewerLogin}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

const Thread = memo(function Thread({ thread }: { thread: ReviewThread }) {
  const location = thread.path
    ? `${thread.path}${thread.line === null ? "" : `:${thread.line}`}`
    : null;
  const body = useMemo(() => cleanCommentText(thread.body), [thread.body]);

  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">
          @{thread.author ?? "unknown reviewer"}
        </span>
        {location && <code className="min-w-0 wrap-anywhere">{location}</code>}
        {thread.outdated && <Badge variant="outline">Outdated</Badge>}
        <span className="ml-auto">
          <DetailLink href={thread.url} label="Open thread" />
        </span>
      </div>
      <p className="m-0 max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs leading-relaxed text-foreground">
        {body || "No comment body was returned."}
      </p>
    </li>
  );
});

const ReviewThreads = memo(function ReviewThreads({
  expected,
  threads,
}: {
  expected: number;
  threads: ReviewThread[];
}) {
  return (
    <section className="rounded-lg border bg-muted/15">
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageSquareText
          aria-hidden="true"
          className="size-3.5 text-destructive"
        />
        <h4 className="m-0 text-xs font-medium">Unresolved comments</h4>
        <Badge className="ml-auto" variant="destructive">
          {expected}
        </Badge>
      </div>
      <Separator />
      {threads.length === 0 ? (
        <p className="m-0 px-3 py-2.5 text-xs text-muted-foreground">
          GitHub reported unresolved comments, but their thread details were not
          available.
        </p>
      ) : (
        <ul className="divide-y">
          {threads.map((thread) => (
            <Thread key={thread.id} thread={thread} />
          ))}
        </ul>
      )}
      {threads.length > 0 && threads.length < expected && (
        <p className="m-0 border-t px-3 py-2 text-xs text-muted-foreground">
          Showing {threads.length} of {expected} unresolved comments because
          GitHub returned incomplete review evidence.
        </p>
      )}
    </section>
  );
});

const GreptileReview = memo(function GreptileReview({
  pull,
}: {
  pull: PullReadiness;
}) {
  const current = isCurrentGreptileReview(pull);
  const passing = current && pull.greptile.confidence === 5;
  const body = useMemo(
    () => cleanCommentText(pull.greptile.body ?? ""),
    [pull.greptile.body],
  );

  return (
    <section className="rounded-lg border bg-muted/15">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <GitPullRequest
          aria-hidden="true"
          className={
            passing
              ? "size-3.5 text-emerald-600 dark:text-emerald-400"
              : "size-3.5 text-destructive"
          }
        />
        <h4 className="m-0 text-xs font-medium">Greptile review</h4>
        <Badge
          className="ml-auto"
          variant={passing ? "outline" : "destructive"}
        >
          {pull.greptile.confidence === null
            ? "Confidence unavailable"
            : `${pull.greptile.confidence}/5 confidence`}
        </Badge>
      </div>
      <Separator />
      <div className="space-y-2 px-3 py-2.5">
        <p className="m-0 text-[11px] text-muted-foreground">
          {current ? (
            <>
              Current head <code>{shortSha(pull.headRefOid)}</code> reviewed
            </>
          ) : (
            <>
              Reviewed <code>{shortSha(pull.greptile.reviewedSha)}</code>, but
              current head is <code>{shortSha(pull.headRefOid)}</code>
            </>
          )}
        </p>
        <p className="m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs leading-relaxed text-foreground">
          {body || "Greptile confidence comment was not available."}
        </p>
        {pull.greptile.commentUrl ? (
          <DetailLink
            href={pull.greptile.commentUrl}
            label="Open Greptile comment"
          />
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            Greptile comment link was not available.
          </p>
        )}
      </div>
    </section>
  );
});

function BlockerDetails({ pull, viewerLogin }: BlockerDetailsProps) {
  const failedChecks = useMemo(
    () => getFailedChecks(pull.ci.checks ?? [], pull.repository),
    [pull.ci.checks, pull.repository],
  );
  const threads = pull.unresolvedThreads ?? [];
  const greptileBlocking =
    pull.greptile.confidence !== 5 || !isCurrentGreptileReview(pull);
  const failedCI = pull.ci.state === "failure" || failedChecks.length > 0;
  const unresolved = pull.unresolved > 0;
  const missingEvidence =
    !pull.checks.commentsComplete || !pull.checks.threadsComplete;
  const ciEvidenceIncomplete =
    pull.ci.state === "unknown" || pull.ci.complete === false;

  return (
    <div className="grid grid-cols-1 gap-2">
      {failedCI && (
        <FailedChecks
          checks={failedChecks}
          pull={pull}
          viewerLogin={viewerLogin}
        />
      )}
      {unresolved && (
        <ReviewThreads expected={pull.unresolved} threads={threads} />
      )}
      <GreptileReview pull={pull} />
      {(missingEvidence ||
        ciEvidenceIncomplete ||
        (!failedCI && !unresolved && !greptileBlocking)) && (
        <section className="rounded-lg border bg-muted/15 px-3 py-2.5 text-xs text-muted-foreground">
          <h4 className="mb-1 font-medium text-foreground">
            Evidence unavailable
          </h4>
          GitHub could not return complete readiness evidence. Refresh the pull
          request before acting on it.
        </section>
      )}
    </div>
  );
}

export default memo(BlockerDetails);
