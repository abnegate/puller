// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeRunEvent, ClaudeRunRequest } from '../fixes';
import { createPullsResponse } from '../test/fixtures';
import type { PullReadiness } from '../types';
import PullRow from './PullRow';
import ReadinessSection from './ReadinessSection';

const fixes = vi.hoisted(() => ({
  cancel: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('../fixes', () => ({
  cancelClaudeRun: fixes.cancel,
  streamClaudeRun: fixes.stream,
}));

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const getBlockedPull = (): PullReadiness => createPullsResponse().notReady[0]!;
const getReadyPull = (): PullReadiness => createPullsResponse().ready[0]!;

const renderRow = (pull: PullReadiness, variant: 'ready' | 'blocked') =>
  render(
    <ul>
      <PullRow pull={pull} variant={variant} />
    </ul>,
  );

const startRun = async (message = 'Resolve the open comments.') => {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Run fix' }));
  await screen.findByText('Running');
};

afterEach(() => {
  cleanup();
  fixes.cancel.mockReset();
  fixes.stream.mockReset();
});

describe('PullRow links and controls', () => {
  it('renders a ready row as one full-row Greptile anchor without nested links or controls', () => {
    const pull = getReadyPull();
    const { container } = renderRow(pull, 'ready');
    const anchor = screen.getByRole('link', { name: new RegExp(pull.title) });
    const row = anchor.closest('li');

    expect(row).not.toBeNull();
    expect(anchor).toHaveAttribute('href', pull.greptile.commentUrl);
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect((row as HTMLElement).children).toHaveLength(1);
    expect((row as HTMLElement).firstElementChild).toBe(anchor);
    expect(anchor.children).toHaveLength(1);
    expect(anchor.firstElementChild).toHaveAttribute('data-slot', 'card');
    expect(anchor).toHaveClass('rounded-xl');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(within(anchor).queryByRole('link')).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByRole('textbox'),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByRole('button'),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByRole('log', { hidden: true }),
    ).not.toBeInTheDocument();
    expect(within(anchor).getByText('All checks passed')).toHaveAttribute(
      'data-variant',
      'secondary',
    );
    const evidencePrefix = within(anchor).getByText('Ready evidence:');
    expect(evidencePrefix).toHaveClass('sr-only');
    expect(evidencePrefix.closest('p')).toHaveTextContent(
      'Ready evidence: 0 unresolved comments · Greptile 5/5 · CI passed',
    );
    expect(within(anchor).queryByLabelText('Ready evidence')).not.toBeInTheDocument();
    expect(
      within(anchor).getByText(`Current head ${pull.headRefOid} reviewed`),
    ).toHaveClass('sr-only');
    expect(anchor.querySelector('.lucide-external-link')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('shows that no CI checks were reported without changing ready-row anchor semantics', () => {
    const pull = getReadyPull();
    pull.ci.state = 'none';
    const { container } = renderRow(pull, 'ready');
    const anchor = screen.getByRole('link', { name: new RegExp(pull.title) });

    expect(within(anchor).getByText('Ready evidence:').closest('p')).toHaveTextContent(
      'Ready evidence: 0 unresolved comments · Greptile 5/5 · No CI checks reported',
    );
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(anchor).toHaveAttribute('href', pull.greptile.commentUrl);
    expect(anchor).toHaveAttribute('target', '_blank');
  });

  it('preserves server-provided CI blockers instead of replacing their wording', () => {
    const pull = getBlockedPull();
    pull.blockers = ['CI provider reported a required check failure'];
    renderRow(pull, 'blocked');

    const blocker = screen.getByText(
      'CI provider reported a required check failure',
    );
    expect(blocker).toBeInTheDocument();
    expect(blocker.closest('li')).toHaveClass('text-foreground');
    expect(
      blocker.closest('li')?.querySelector('.lucide-circle-alert'),
    ).toHaveClass('text-destructive');
    expect(screen.queryByText('CI checks failed')).not.toBeInTheDocument();
    expect(screen.getByText('1 blocker')).toHaveAttribute(
      'data-variant',
      'destructive',
    );
  });

  it.each([
    ['pending', 'CI checks pending'],
    ['failure', 'CI checks failed'],
    ['unknown', 'CI checks could not be fully checked'],
  ] as const)(
    'derives the %s CI blocker when a row is rendered without server blockers',
    (state, blocker) => {
      const pull = getBlockedPull();
      pull.blockers = [];
      pull.ci.state = state;
      pull.unresolved = 0;
      pull.greptile.confidence = 5;
      pull.greptile.reviewedSha = pull.headRefOid;

      renderRow(pull, 'blocked');

      expect(screen.getByText(blocker)).toBeInTheDocument();
      expect(
        screen.queryByText('Readiness evidence is incomplete'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('1 blocker')).toHaveAttribute(
        'data-variant',
        'destructive',
      );
    },
  );

  it('exposes independently labelled fix controls and a live terminal only on blocked rows', () => {
    const pull = getBlockedPull();
    renderRow(pull, 'blocked');

    const pullLink = screen.getByRole('link', { name: pull.title });
    const row = pullLink.closest('li');

    expect(row).not.toBeNull();
    const input = within(row as HTMLElement).getByRole('textbox', {
      name: `Fix instructions for ${pull.repository} #${pull.number}`,
    });
    const terminal = within(row as HTMLElement).getByRole('log', {
      hidden: true,
    });

    expect(pullLink).toHaveAttribute('href', pull.url);
    expect(pullLink).toHaveAttribute('target', '_blank');
    expect(pullLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(pullLink.closest('li')).toBe(row);
    expect(pullLink).not.toContainElement(input);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('rows', '1');
    expect(input).toHaveClass(
      'field-sizing-content',
      'min-h-11',
      'max-h-32',
      'resize-none',
      'overflow-y-auto',
      'sm:min-h-8',
      'sm:py-1',
      'sm:text-sm',
    );
    expect(input).not.toHaveClass('rounded-md');
    const run = within(row as HTMLElement).getByRole('button', { name: 'Run fix' });
    expect(run).toBeDisabled();
    expect(run).not.toHaveClass('rounded-md');
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
    expect(terminal).toHaveAttribute('aria-live', 'polite');
    expect(terminal).toHaveAttribute(
      'aria-label',
      `Claude output for ${pull.repository} pull request ${pull.number}`,
    );
    expect(terminal).toHaveAttribute('aria-busy', 'false');
    expect(terminal).toHaveAttribute('tabindex', '0');
    expect(terminal).toHaveAttribute('hidden');
    const blockerBadge = within(row as HTMLElement).getByText('3 blockers');
    expect(blockerBadge).toHaveAttribute('data-variant', 'destructive');
    expect(
      within(row as HTMLElement).getByRole('list', { name: 'Blockers' }),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText('Claude output'),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText('Idle'),
    ).not.toBeInTheDocument();
    expect(row?.querySelector('[data-output-card]')).toHaveAttribute('hidden');
  });

  it('keeps Run fix disabled for blank instructions and enables it for content', () => {
    renderRow(getBlockedPull(), 'blocked');
    const input = screen.getByRole('textbox');
    const run = screen.getByRole('button', { name: 'Run fix' });

    expect(run).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(run).toBeDisabled();
    fireEvent.change(input, {
      target: { value: 'Resolve CI and review blockers.' },
    });
    expect(run).toBeEnabled();
  });

  it('reveals the mounted terminal when a run starts and keeps it visible when the run ends', async () => {
    const gate = createDeferred();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: 'run-visible',
        type: 'start',
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { exitCode: 0, type: 'complete' } satisfies ClaudeRunEvent;
    });

    renderRow(getBlockedPull(), 'blocked');
    const idleTerminal = screen.getByRole('log', { hidden: true });
    expect(idleTerminal).toHaveAttribute('hidden');

    await startRun();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveClass('rounded-md');
    expect(screen.getByRole('log')).toBe(idleTerminal);
    expect(idleTerminal).not.toHaveAttribute('hidden');
    expect(screen.getByText('Claude output')).toBeInTheDocument();
    expect(idleTerminal.closest('[data-output-card]')).not.toHaveAttribute(
      'hidden',
    );

    await act(async () => gate.resolve());
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByRole('log')).toBe(idleTerminal);
    expect(idleTerminal).not.toHaveAttribute('hidden');
    expect(idleTerminal.closest('[data-output-card]')).not.toHaveAttribute(
      'hidden',
    );
  });
});

describe('PullRow Claude runs', () => {
  it('streams incremental text safely, captures the start event, and preserves completed output', async () => {
    const gate = createDeferred();
    const pull = getBlockedPull();
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: 'run-incremental',
        type: 'start',
      } satisfies ClaudeRunEvent;
      yield {
        text: '<strong>first</strong>',
        type: 'text',
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { text: ' second', type: 'text' } satisfies ClaudeRunEvent;
      yield { exitCode: 0, type: 'complete' } satisfies ClaudeRunEvent;
    });

    renderRow(pull, 'blocked');
    await startRun('Address every unresolved thread.');

    const terminal = screen.getByRole('log');
    expect(terminal).toHaveTextContent('<strong>first</strong>');
    expect(terminal.querySelector('strong')).toBeNull();
    expect(terminal).toHaveAttribute('aria-busy', 'true');
    expect(fixes.stream).toHaveBeenCalledWith(
      {
        expectedHeadRefOid: pull.headRefOid,
        message: 'Address every unresolved thread.',
        number: pull.number,
        repository: pull.repository,
      },
      expect.any(AbortSignal),
    );

    await act(async () => gate.resolve());
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(terminal).toHaveTextContent('<strong>first</strong> second');
    expect(terminal).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps message and run state independent for each blocked row', async () => {
    const gate = createDeferred();
    const first = getBlockedPull();
    const second: PullReadiness = {
      ...first,
      number: 103,
      rank: 3,
      title: 'Repair a separate pull request',
      url: 'https://github.com/appwrite/cloud/pull/103',
    };
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
    ) {
      yield {
        number: request.number,
        repository: request.repository,
        runId: `run-${request.number}`,
        type: 'start',
      } satisfies ClaudeRunEvent;
      await gate.promise;
      yield { exitCode: 0, type: 'complete' } satisfies ClaudeRunEvent;
    });

    render(
      <ReadinessSection
        emptyMessage="Empty"
        pulls={[first, second]}
        title="Not ready"
        variant="blocked"
      />,
    );

    const firstInput = screen.getByRole('textbox', {
      name: `Fix instructions for ${first.repository} #${first.number}`,
    });
    const secondInput = screen.getByRole('textbox', {
      name: `Fix instructions for ${second.repository} #${second.number}`,
    });
    fireEvent.change(firstInput, {
      target: { value: 'Fix only the first PR.' },
    });
    fireEvent.change(secondInput, {
      target: { value: 'Keep this draft independent.' },
    });
    const firstRow = firstInput.closest('li');
    const secondRow = secondInput.closest('li');
    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    fireEvent.click(
      within(firstRow as HTMLElement).getByRole('button', { name: 'Run fix' }),
    );

    await within(firstRow as HTMLElement).findByText('Running');
    expect(firstInput).toBeDisabled();
    expect(secondInput).toBeEnabled();
    expect(secondInput).toHaveValue('Keep this draft independent.');
    expect(
      within(firstRow as HTMLElement).getByRole('button', { name: 'Cancel' }),
    ).toBeEnabled();
    expect(
      within(secondRow as HTMLElement).queryByRole('button', {
        name: 'Cancel',
      }),
    ).not.toBeInTheDocument();
    expect(within(firstRow as HTMLElement).getByRole('log')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(
      within(secondRow as HTMLElement).getByRole('log', { hidden: true }),
    ).toHaveAttribute('aria-busy', 'false');
    expect(screen.getAllByText('Running')).toHaveLength(1);

    await act(async () => gate.resolve());
  });

  it('cancels the captured run id and aborts its stream', async () => {
    let signal: AbortSignal | undefined;
    fixes.cancel.mockResolvedValue(undefined);
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: 'run-to-cancel',
        type: 'start',
      } satisfies ClaudeRunEvent;
      await new Promise<void>((_resolve, reject) => {
        runSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Run cancelled', 'AbortError')),
          { once: true },
        );
      });
    });

    renderRow(getBlockedPull(), 'blocked');
    await startRun();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(fixes.cancel).toHaveBeenCalledWith('run-to-cancel');
    expect(signal?.aborted).toBe(true);
  });

  it('can cancel while the run is still starting', async () => {
    let signal: AbortSignal | undefined;
    fixes.stream.mockImplementation(async function* (
      _request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      await new Promise<void>((_resolve, reject) => {
        runSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Run cancelled', 'AbortError')),
          { once: true },
        );
      });
    });

    renderRow(getBlockedPull(), 'blocked');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Fix this PR.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run fix' }));
    expect(await screen.findByText('Starting')).toBeInTheDocument();
    expect(screen.getByRole('log')).not.toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    expect(fixes.cancel).not.toHaveBeenCalled();
  });

  it.each<[ClaudeRunEvent, string, string | null]>([
    [{ exitCode: 1, type: 'complete' }, 'Failed', null],
    [
      { message: 'The worker failed.', type: 'error' },
      'Failed',
      '[error] The worker failed.',
    ],
    [
      { message: 'Run capacity reached.', type: 'limit' },
      'Limited',
      '[limit] Run capacity reached.',
    ],
    [{ type: 'cancelled' }, 'Cancelled', null],
  ])(
    'maps $type events to a terminal status',
    async (terminalEvent, label, output) => {
      fixes.stream.mockImplementation(async function* (
        request: ClaudeRunRequest,
      ) {
        yield {
          number: request.number,
          repository: request.repository,
          runId: 'run-terminal',
          type: 'start',
        } satisfies ClaudeRunEvent;
        yield terminalEvent;
      });

      renderRow(getBlockedPull(), 'blocked');
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Fix this PR.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run fix' }));

      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.getByRole('log')).not.toHaveAttribute('hidden');
      if (output) {
        expect(screen.getByRole('log')).toHaveTextContent(output);
      }
    },
  );

  it('aborts an active stream when its row unmounts', async () => {
    let signal: AbortSignal | undefined;
    fixes.stream.mockImplementation(async function* (
      request: ClaudeRunRequest,
      runSignal: AbortSignal,
    ) {
      signal = runSignal;
      yield {
        number: request.number,
        repository: request.repository,
        runId: 'run-unmount',
        type: 'start',
      } satisfies ClaudeRunEvent;
      await new Promise<void>((_resolve, reject) => {
        runSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Unmounted', 'AbortError')),
          { once: true },
        );
      });
    });

    const view = renderRow(getBlockedPull(), 'blocked');
    await startRun();
    view.unmount();

    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
