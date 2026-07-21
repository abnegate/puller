import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { PullReadiness } from '../types';
import PullRow from './PullRow';

type ReadinessSectionProps = {
  emptyMessage: string;
  pulls: PullReadiness[];
  title: string;
  variant: 'ready' | 'blocked';
};

export default function ReadinessSection({
  emptyMessage,
  pulls,
  title,
  variant,
}: ReadinessSectionProps) {
  const headingId = `${variant}-heading`;
  const label = `${pulls.length} pull ${pulls.length === 1 ? 'request' : 'requests'}`;

  return (
    <section className="space-y-2.5" aria-labelledby={headingId}>
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2
          className="font-heading text-sm leading-none font-semibold"
          id={headingId}
        >
          {title}
        </h2>
        <Badge aria-label={label} className="tabular-nums" variant="secondary">
          {pulls.length}
        </Badge>
      </header>

      {pulls.length > 0 ? (
        <ul
          className="grid list-none gap-2 p-0"
          aria-label={`${title} pull requests`}
        >
          {pulls.map((pull) => (
            <PullRow
              key={`${pull.repository}-${pull.number}`}
              pull={pull}
              variant={variant}
            />
          ))}
        </ul>
      ) : (
        <Card size="sm">
          <CardContent className="px-3 py-1 text-sm text-muted-foreground">
            <p>{emptyMessage}</p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
