import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  LoaderCircle,
  SquareTerminal,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

import {
  cancelClaudeRun,
  streamClaudeRun,
  type ClaudeRunEvent,
} from '../fixes';
import type { PullReadiness } from '../types';

type PullRowProps = {
  pull: PullReadiness;
  variant: 'ready' | 'blocked';
};

type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limited';

const statusLabels: Record<Exclude<RunStatus, 'idle'>, string> = {
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
  limited: 'Limited',
  running: 'Running',
  starting: 'Starting',
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  timeZoneName: 'short',
  year: 'numeric',
});

const formatUpdatedAt = (updatedAt: string): string => {
  const date = new Date(updatedAt);

  if (Number.isNaN(date.getTime())) {
    return 'Update time unavailable';
  }

  return `Updated ${dateFormatter.format(date)}`;
};

const getFallbackBlockers = (pull: PullReadiness): string[] => {
  const blockers: string[] = [];

  if (pull.unresolved > 0) {
    blockers.push(
      `${pull.unresolved} unresolved review ${pull.unresolved === 1 ? 'comment' : 'comments'}`,
    );
  }

  if (pull.greptile.confidence === null) {
    blockers.push('Greptile confidence is not available');
  } else if (pull.greptile.confidence < 5) {
    blockers.push(`Greptile confidence is ${pull.greptile.confidence}/5`);
  }

  if (
    pull.greptile.reviewedSha &&
    pull.greptile.reviewedSha !== pull.headRefOid
  ) {
    blockers.push('Greptile review is for an older commit');
  }

  if (pull.ci.state === 'pending') {
    blockers.push('CI checks pending');
  } else if (pull.ci.state === 'failure') {
    blockers.push('CI checks failed');
  } else if (pull.ci.state === 'unknown') {
    blockers.push('CI checks could not be fully checked');
  }

  return blockers.length > 0 ? blockers : ['Readiness evidence is incomplete'];
};

const getReadyEvidence = (pull: PullReadiness): string =>
  `${pull.unresolved} unresolved ${pull.unresolved === 1 ? 'comment' : 'comments'} · Greptile ${pull.greptile.confidence}/5 · ${
    pull.ci.state === 'none' ? 'No CI checks reported' : 'CI passed'
  }`;

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  error.name === 'AbortError';

const formatEvent = (event: ClaudeRunEvent): string | null => {
  switch (event.type) {
    case 'text':
      return event.text;
    case 'tool':
      return `[tool] ${event.name}${event.status ? ` — ${event.status}` : ''}`;
    case 'diagnostic':
      return `[diagnostic] ${event.text}`;
    case 'error':
      return `[error] ${event.message}`;
    case 'limit':
      return `[limit] ${event.message}`;
    case 'start':
    case 'complete':
    case 'cancelled':
      return null;
  }
};

function ReadyCard({
  pull,
  updatedAt,
}: {
  pull: PullReadiness;
  updatedAt: string;
}) {
  return (
    <Card
      className="h-full gap-0 py-0 transition-colors group-hover/ready:bg-muted/40"
      size="sm"
    >
      <CardContent className="flex items-start gap-3 p-3 sm:p-4">
        <CircleCheck
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {pull.repository}
              </span>
              <span aria-hidden="true"> · </span>
              <span>#{pull.number}</span>
              <span aria-hidden="true"> · </span>
              <time dateTime={pull.updatedAt}>{updatedAt}</time>
            </p>
            <Badge variant="secondary">All checks passed</Badge>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-sm font-medium text-foreground sm:text-base">
              {pull.title}
            </span>
            <ExternalLink
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
          </div>
          <p className="m-0 text-xs text-muted-foreground">
            <span className="sr-only">Ready evidence: </span>
            {getReadyEvidence(pull)}
          </p>
          <span className="sr-only">
            Current head {pull.headRefOid} reviewed
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function PullSummary({
  pull,
  updatedAt,
}: {
  pull: PullReadiness;
  updatedAt: string;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="m-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{pull.repository}</span>
        <span aria-hidden="true"> · </span>
        <span>#{pull.number}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={pull.updatedAt}>{updatedAt}</time>
      </p>
      <a
        className="group/title inline-flex min-h-11 max-w-full items-center gap-1.5 py-1 text-sm font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0 sm:text-base"
        href={pull.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        <span className="min-w-0 wrap-anywhere">{pull.title}</span>
        <ExternalLink
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/title:text-foreground"
        />
      </a>
    </div>
  );
}

function BlockerList({ blockers }: { blockers: string[] }) {
  return (
    <ul aria-label="Blockers" className="mt-3 grid gap-1.5">
      {blockers.map((blocker, index) => (
        <li
          className="flex items-start gap-2 text-sm text-foreground"
          key={`${blocker}-${index}`}
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
          />
          <span className="min-w-0 wrap-anywhere">{blocker}</span>
        </li>
      ))}
    </ul>
  );
}

function FixPanel({ pull }: { pull: PullReadiness }) {
  const inputId = useId();
  const terminalRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const followOutputRef = useRef(true);
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<RunStatus>('idle');
  const [cancelling, setCancelling] = useState(false);
  const active = status === 'starting' || status === 'running';
  const visible = status !== 'idle';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (terminal && followOutputRef.current) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }, [output]);

  const appendOutput = useCallback((text: string, line = false) => {
    if (!text) {
      return;
    }

    const terminal = terminalRef.current;
    if (terminal) {
      followOutputRef.current =
        terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 32;
    }

    setOutput((current) => {
      if (!line) {
        return current + text;
      }

      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      return `${current}${prefix}${text}\n`;
    });
  }, []);

  const handleFix = async () => {
    const instructions = message.trim();
    if (!instructions || active) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    runIdRef.current = null;
    setOutput('');
    setStatus('starting');
    setCancelling(false);
    followOutputRef.current = true;
    let ended = false;

    try {
      for await (const event of streamClaudeRun(
        {
          expectedHeadRefOid: pull.headRefOid,
          message: instructions,
          number: pull.number,
          repository: pull.repository,
        },
        controller.signal,
      )) {
        if (!mountedRef.current) {
          return;
        }

        if (event.type === 'start') {
          runIdRef.current = event.runId;
          setStatus('running');
          continue;
        }

        const formatted = formatEvent(event);
        if (formatted !== null) {
          appendOutput(formatted, event.type !== 'text');
        }

        if (event.type === 'complete') {
          ended = true;
          setStatus(event.exitCode === 0 ? 'completed' : 'failed');
        } else if (event.type === 'error') {
          ended = true;
          setStatus('failed');
        } else if (event.type === 'cancelled') {
          ended = true;
          setStatus('cancelled');
        } else if (event.type === 'limit') {
          ended = true;
          setStatus('limited');
        }
      }

      if (!ended && mountedRef.current) {
        appendOutput(
          '[error] Claude disconnected before reporting completion.',
          true,
        );
        setStatus('failed');
      }
    } catch (error) {
      if (mountedRef.current && !isAbortError(error)) {
        appendOutput(
          `[error] ${error instanceof Error ? error.message : 'Claude could not be reached.'}`,
          true,
        );
        setStatus('failed');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const handleCancel = async () => {
    const currentRunId = runIdRef.current;
    if (cancelling) {
      return;
    }

    setCancelling(true);
    if (!currentRunId) {
      abortRef.current?.abort();
      if (mountedRef.current) {
        setStatus('cancelled');
        setCancelling(false);
      }
      return;
    }

    try {
      await cancelClaudeRun(currentRunId);
      if (mountedRef.current) {
        setStatus('cancelled');
        abortRef.current?.abort();
      }
    } catch (error) {
      if (mountedRef.current) {
        appendOutput(
          `[diagnostic] ${error instanceof Error ? error.message : 'Claude could not be cancelled.'}`,
          true,
        );
      }
    } finally {
      if (mountedRef.current) {
        setCancelling(false);
      }
    }
  };

  return (
    <div>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleFix();
        }}
      >
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={inputId}
        >
          Fix instructions for {pull.repository} #{pull.number}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Textarea
            className="field-sizing-content min-h-11 max-h-32 resize-none overflow-y-auto sm:min-h-8 sm:py-1 sm:text-sm"
            disabled={active}
            id={inputId}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Resolve the blockers and leave the PR ready for review."
            rows={1}
            value={message}
          />
          <div className="flex shrink-0 gap-2">
            <Button
              className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
              disabled={active || !message.trim()}
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
                disabled={cancelling}
                onClick={() => void handleCancel()}
                type="button"
                variant="outline"
              >
                <X aria-hidden="true" />
                {cancelling ? 'Cancelling' : 'Cancel'}
              </Button>
            )}
          </div>
        </div>
      </form>

      <Card
        className={visible ? 'mt-3 w-full gap-0 py-0' : 'hidden'}
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
            <span className="font-medium text-foreground">Claude output</span>
            <Badge
              aria-live="polite"
              className="ml-auto"
              role="status"
              variant={
                status === 'failed' || status === 'limited'
                  ? 'destructive'
                  : 'outline'
              }
            >
              {statusLabels[status]}
            </Badge>
          </div>
        )}
        <pre
          aria-busy={active}
          aria-label={`Claude output for ${pull.repository} pull request ${pull.number}`}
          aria-live="polite"
          className="max-h-56 min-h-16 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-foreground"
          hidden={!visible}
          ref={terminalRef}
          role="log"
          tabIndex={0}
        >
          {output}
        </pre>
      </Card>
    </div>
  );
}

export default function PullRow({ pull, variant }: PullRowProps) {
  const updatedAt = formatUpdatedAt(pull.updatedAt);

  if (variant === 'ready') {
    const reviewUrl = pull.greptile.commentUrl;
    if (!reviewUrl) {
      return null;
    }

    return (
      <li>
        <a
          className="group/ready block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          href={reviewUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ReadyCard pull={pull} updatedAt={updatedAt} />
        </a>
      </li>
    );
  }

  const blockers = pull.blockers.length
    ? pull.blockers
    : getFallbackBlockers(pull);

  return (
    <li>
      <Card className="gap-0 py-0" size="sm">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <PullSummary pull={pull} updatedAt={updatedAt} />
            <Badge className="mt-0.5" variant="destructive">
              {blockers.length} {blockers.length === 1 ? 'blocker' : 'blockers'}
            </Badge>
          </div>
          <BlockerList blockers={blockers} />
          <Separator className="my-3" />
          <FixPanel pull={pull} />
        </CardContent>
      </Card>
    </li>
  );
}
