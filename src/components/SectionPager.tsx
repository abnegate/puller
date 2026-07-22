import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

export const SECTION_PAGE_SIZE = 20;

export type SectionPageState = {
  end: number;
  page: number;
  pageCount: number;
  paginated: boolean;
  setPage: (page: number) => void;
  start: number;
};

export type UseSectionPagerOptions = {
  count: number;
  defaultPage?: number;
  onPageChange?: (page: number) => void;
  page?: number;
  resetKey?: unknown;
};

const clampPage = (page: number, pageCount: number): number =>
  Math.max(1, Math.min(pageCount, Number.isInteger(page) ? page : 1));

export function useSectionPager({
  count,
  defaultPage = 1,
  onPageChange,
  page: controlledPage,
  resetKey,
}: UseSectionPagerOptions): SectionPageState {
  const pageCount = Math.max(1, Math.ceil(count / SECTION_PAGE_SIZE));
  const controlled = controlledPage !== undefined;
  const [internalPage, setInternalPage] = useState(() =>
    clampPage(defaultPage, pageCount),
  );
  const requestedPage = controlled ? controlledPage : internalPage;
  const page = clampPage(requestedPage, pageCount);
  const resetKeyRef = useRef(resetKey);

  const setPage = useCallback(
    (nextPage: number): void => {
      const next = clampPage(nextPage, pageCount);
      if (next === page) return;
      if (!controlled) setInternalPage(next);
      onPageChange?.(next);
    },
    [controlled, onPageChange, page, pageCount],
  );

  useEffect(() => {
    if (requestedPage === page) return;
    if (!controlled) setInternalPage(page);
    onPageChange?.(page);
  }, [controlled, onPageChange, page, requestedPage]);

  useEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    setPage(1);
  }, [resetKey, setPage]);

  const start = (page - 1) * SECTION_PAGE_SIZE;

  return {
    end: Math.min(count, start + SECTION_PAGE_SIZE),
    page,
    pageCount,
    paginated: count > SECTION_PAGE_SIZE,
    setPage,
    start,
  };
}

type SectionPagerProps = Pick<
  SectionPageState,
  "page" | "pageCount" | "paginated" | "setPage"
> & {
  label: string;
};

export default function SectionPager({
  label,
  page,
  pageCount,
  paginated,
  setPage,
}: SectionPagerProps) {
  if (!paginated) return null;

  return (
    <nav
      aria-label={`${label} pagination`}
      className="section-pager flex items-center justify-between gap-2 pt-0.5"
      data-page={page}
      data-pages={pageCount}
      data-section-pager=""
    >
      <Button
        aria-label={`Previous ${label.toLowerCase()} page`}
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
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
        Page {page} of {pageCount}
      </span>
      <Button
        aria-label={`Next ${label.toLowerCase()} page`}
        disabled={page === pageCount}
        onClick={() => setPage(page + 1)}
        size="sm"
        type="button"
        variant="outline"
      >
        Next
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
