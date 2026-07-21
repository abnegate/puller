import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getPulls } from './api';
import ReadinessSection from './components/ReadinessSection';
import type { PullsResponse } from './types';

const REFRESH_INTERVAL = 5 * 60 * 1_000;
const DEFAULT_QUERY =
  'is:pr author:@me state:open archived:false sort:updated-desc';

const snapshotFormatter = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
});

const formatSnapshot = (snapshotAt: string): string => {
  const date = new Date(snapshotAt);

  return Number.isNaN(date.getTime())
    ? 'time unavailable'
    : snapshotFormatter.format(date);
};

const getErrorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The readiness service could not be reached.';

export default function App() {
  const [data, setData] = useState<PullsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const nextRefreshAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const loadRef = useRef<(manual?: boolean) => Promise<void>>(
    async () => undefined,
  );

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const armRefreshTimer = useCallback(
    (dueAt: number) => {
      clearRefreshTimer();
      nextRefreshAt.current = dueAt;

      if (document.visibilityState !== 'visible') {
        return;
      }

      refreshTimer.current = window.setTimeout(
        () => {
          refreshTimer.current = null;

          if (document.visibilityState === 'visible') {
            void loadRef.current();
          }
        },
        Math.max(0, dueAt - Date.now()),
      );
    },
    [clearRefreshTimer],
  );

  const load = useCallback(
    async (manual = false) => {
      if (inFlight.current) {
        return;
      }

      clearRefreshTimer();
      inFlight.current = true;
      setRefreshing(true);

      try {
        const next = await getPulls(manual);

        if (mounted.current) {
          setData(next);
          setError(null);
        }
      } catch (loadError) {
        if (mounted.current) {
          setError(getErrorText(loadError));
        }
      } finally {
        inFlight.current = false;

        if (mounted.current) {
          setRefreshing(false);
          armRefreshTimer(Date.now() + REFRESH_INTERVAL);
        }
      }
    },
    [armRefreshTimer, clearRefreshTimer],
  );

  loadRef.current = load;

  useEffect(() => {
    mounted.current = true;
    void load();

    return () => {
      mounted.current = false;
      clearRefreshTimer();
    };
  }, [clearRefreshTimer, load]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearRefreshTimer();
        return;
      }

      const dueAt = nextRefreshAt.current;

      if (dueAt === null) {
        return;
      }

      if (Date.now() >= dueAt) {
        void loadRef.current();
      } else {
        armRefreshTimer(dueAt);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      clearRefreshTimer();
    };
  }, [armRefreshTimer, clearRefreshTimer]);

  const query = data?.query || DEFAULT_QUERY;
  const hasGlobalEmptyState = data?.counts.total === 0;
  const notices = [
    error && data
      ? `Refresh failed: ${error} Showing the last successful snapshot.`
      : null,
    data?.stale ? 'This snapshot is stale.' : null,
    data?.partial ? 'Some pull requests could not be fully evaluated.' : null,
    ...(data?.warnings ?? []),
  ].filter((notice): notice is string => Boolean(notice));

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-3 py-4 sm:px-5 sm:py-6">
        <header>
          <Card className="gap-0 py-0" size="sm">
            <CardHeader className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="font-heading text-base leading-none font-semibold tracking-tight">
                  Pull readiness
                </h1>
                <Badge
                  aria-label={
                    data
                      ? `${data.counts.total} open pull requests`
                      : 'Open pull request count unavailable'
                  }
                  className="tabular-nums"
                  variant="secondary"
                >
                  {data ? data.counts.total : '—'} open
                </Badge>
              </div>

              <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
                <div
                  className="min-w-0 text-xs whitespace-nowrap text-muted-foreground"
                  aria-live="polite"
                >
                  {data ? (
                    <>
                      Updated{' '}
                      <time dateTime={data.generatedAt}>
                        {formatSnapshot(data.generatedAt)}
                      </time>
                    </>
                  ) : (
                    'Awaiting snapshot'
                  )}
                </div>
                <Button
                  className="min-h-11 sm:min-h-7"
                  disabled={refreshing}
                  onClick={() => void load(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={refreshing ? 'animate-spin' : undefined}
                    data-icon="inline-start"
                  />
                  {refreshing ? 'Refreshing' : 'Refresh'}
                </Button>
              </div>
            </CardHeader>

            <Separator />

            <CardFooter className="flex flex-col items-start gap-2 border-t-0 bg-muted/30 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-medium text-muted-foreground">
                  Query
                </span>
                <code className="min-w-0 break-all text-foreground/80">
                  {query}
                </code>
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="font-medium text-muted-foreground">Sort</span>
                <code className="text-foreground/80">updated-desc</code>
              </div>
            </CardFooter>
          </Card>
        </header>

        {notices.length > 0 && (
          <Card className="gap-0 bg-muted/40 py-0" role="status" size="sm">
            <CardContent className="space-y-1 px-3 py-2.5 text-xs text-muted-foreground">
              {notices.map((notice, index) => (
                <p key={`${notice}-${index}`}>{notice}</p>
              ))}
            </CardContent>
          </Card>
        )}

        {!data && refreshing && (
          <section
            aria-busy="true"
            aria-live="polite"
            aria-labelledby="loading-heading"
          >
            <div className="sr-only">
              <h2 id="loading-heading">Loading pull requests…</h2>
              <p>
                Checking review threads, CI checks, and Greptile confidence.
              </p>
            </div>
            <div aria-hidden="true" className="grid gap-5">
              {['ready', 'blocked'].map((section) => (
                <div className="space-y-2.5" key={section}>
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

        {!data && error && !refreshing && (
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
                onClick={() => void load(true)}
                size="sm"
                type="button"
              >
                Try again
              </Button>
            </CardFooter>
          </Card>
        )}

        {data && hasGlobalEmptyState && (
          <Card size="sm">
            <CardHeader className="px-3">
              <h2 className="font-heading text-sm font-medium">
                No open authored pull requests.
              </h2>
            </CardHeader>
            <CardContent className="px-3 text-sm text-muted-foreground">
              <p>The current GitHub query returned no results.</p>
            </CardContent>
          </Card>
        )}

        {data && !hasGlobalEmptyState && (
          <div className="flex flex-col gap-5">
            <ReadinessSection
              emptyMessage="No pulls meet every readiness check."
              pulls={data.ready}
              title="Ready"
              variant="ready"
            />
            <ReadinessSection
              emptyMessage="Everything is ready."
              pulls={data.notReady}
              title="Not ready"
              variant="blocked"
            />
          </div>
        )}
      </div>
    </main>
  );
}
