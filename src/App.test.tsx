// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { getPulls } from './api';
import { createPullsResponse } from './test/fixtures';

vi.mock('./api', () => ({
  getPulls: vi.fn(),
}));

const REFRESH_INTERVAL = 5 * 60 * 1_000;
const getPullsMock = vi.mocked(getPulls);
const originalVisibility = Object.getOwnPropertyDescriptor(
  document,
  'visibilityState',
);

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const createDeferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
};

const setVisibility = (visibility: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: visibility,
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();

  if (originalVisibility) {
    Object.defineProperty(document, 'visibilityState', originalVisibility);
  }
});

describe('App', () => {
  it('renders the compact shadcn header with exact snapshot controls and metadata', async () => {
    const response = createPullsResponse();
    getPullsMock.mockResolvedValue(response);

    render(<App />);

    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'Pull readiness',
    });
    const toolbar = title.closest('header');
    const card = title.closest('[data-slot="card"]');

    expect(toolbar).not.toBeNull();
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('data-size', 'sm');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const count = within(toolbar as HTMLElement).getByLabelText(
      `${response.counts.total} open pull requests`,
    );
    expect(count).toHaveTextContent(`${response.counts.total} open`);
    expect(count).toHaveAttribute('data-slot', 'badge');
    expect(count).toHaveAttribute('data-variant', 'secondary');
    expect(
      within(toolbar as HTMLElement).getByText(response.query, {
        selector: 'code',
      }),
    ).toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).getByText('updated-desc', {
        selector: 'code',
      }),
    ).toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).getByText('Query'),
    ).toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).getByText('Sort'),
    ).toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).getByText(/Updated/),
    ).toBeInTheDocument();
    expect(toolbar?.querySelector('time')).toHaveAttribute(
      'datetime',
      response.generatedAt,
    );
    const refresh = within(toolbar as HTMLElement).getByRole('button', {
      name: 'Refresh',
    });
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveClass('min-h-11', 'sm:min-h-7');
    expect(refresh).not.toHaveClass('rounded-md');
    expect(refresh).toHaveAttribute('data-slot', 'button');
    expect(refresh.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders both sections with their counts and pull rows', async () => {
    const response = createPullsResponse();
    const secondBlocked = {
      ...response.notReady[0]!,
      number: 103,
      rank: 3,
      title: 'Resolve another blocked pull',
      url: 'https://github.com/appwrite/cloud/pull/103',
    };
    getPullsMock.mockResolvedValue({
      ...response,
      counts: { notReady: 2, ready: 1, total: 3 },
      notReady: [...response.notReady, secondBlocked],
    });

    render(<App />);

    const readyHeading = await screen.findByRole('heading', { name: 'Ready' });
    const blockedHeading = screen.getByRole('heading', { name: 'Not ready' });
    const readySection = readyHeading.closest('section');
    const blockedSection = blockedHeading.closest('section');

    expect(readySection).not.toBeNull();
    expect(blockedSection).not.toBeNull();
    const readyCount = within(readySection as HTMLElement).getByLabelText(
      '1 pull request',
    );
    expect(readyCount).toHaveTextContent('1');
    expect(readyCount).toHaveAttribute('data-slot', 'badge');
    expect(
      within(blockedSection as HTMLElement).getByLabelText('2 pull requests'),
    ).toHaveTextContent('2');
    expect(
      within(readySection as HTMLElement).getByRole('list', {
        name: 'Ready pull requests',
      }),
    ).toBeInTheDocument();
    expect(
      within(blockedSection as HTMLElement).getByRole('list', {
        name: 'Not ready pull requests',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Make readiness signals explicit'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Keep deployment state synchronized'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('CI checks failed')).toHaveLength(2);
  });

  it('renders accessible skeleton cards while the initial snapshot is loading', async () => {
    const pending = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock.mockReturnValue(pending.promise);

    const { container } = render(<App />);

    const loading = await screen.findByRole('heading', {
      name: 'Loading pull requests…',
    });
    const section = loading.closest('section');
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByText(
        'Checking review threads, CI checks, and Greptile confidence.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'is:pr author:@me state:open archived:false sort:updated-desc',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refreshing' })).toBeDisabled();
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
    skeletons.forEach((skeleton) => {
      expect(skeleton.closest('[aria-hidden="true"]')).not.toBeNull();
    });

    await act(async () => {
      pending.resolve(createPullsResponse());
      await pending.promise;
    });
    expect(
      await screen.findByRole('heading', { name: 'Ready' }),
    ).toBeInTheDocument();
  });

  it('retains the last good snapshot and reports every warning when a manual refresh fails', async () => {
    getPullsMock
      .mockResolvedValueOnce({
        ...createPullsResponse(),
        partial: true,
        stale: true,
        warnings: ['One repository could not be evaluated.'],
      })
      .mockRejectedValueOnce(new Error('network down'));

    render(<App />);

    expect(
      await screen.findByText('Make readiness signals explicit'),
    ).toBeInTheDocument();
    const initialNotice = screen
      .getByText('This snapshot is stale.')
      .closest('[role="status"]');
    expect(initialNotice).not.toBeNull();
    expect(
      within(initialNotice as HTMLElement).getByText(
        'Some pull requests could not be fully evaluated.',
      ),
    ).toBeInTheDocument();
    expect(
      within(initialNotice as HTMLElement).getByText(
        'One repository could not be evaluated.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText(/Refresh failed: network down/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Make readiness signals explicit'),
    ).toBeInTheDocument();
  });

  it('renders the initial error with an alert and a manual retry action', async () => {
    getPullsMock.mockRejectedValue(new Error('GitHub is unavailable'));

    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', {
        name: 'The pull request snapshot is unavailable.',
      }),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText('GitHub is unavailable'),
    ).toBeInTheDocument();
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    expect(retry).toHaveClass('min-h-11', 'sm:min-h-7');
    expect(retry).not.toHaveClass('rounded-md');
    fireEvent.click(retry);
    expect(getPullsMock).toHaveBeenNthCalledWith(2, true);
  });

  it('renders global and per-section empty states without losing section semantics', async () => {
    const empty = createPullsResponse();
    getPullsMock.mockResolvedValueOnce({
      ...empty,
      counts: { notReady: 0, ready: 0, total: 0 },
      notReady: [],
      ready: [],
    });

    const view = render(<App />);

    expect(
      await screen.findByRole('heading', {
        name: 'No open authored pull requests.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The current GitHub query returned no results.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Ready' }),
    ).not.toBeInTheDocument();

    view.unmount();
    getPullsMock.mockResolvedValueOnce({
      ...empty,
      counts: { ...empty.counts, ready: 0 },
      ready: [],
    });
    render(<App />);

    const readyHeading = await screen.findByRole('heading', { name: 'Ready' });
    const readySection = readyHeading.closest('section');
    expect(readySection).not.toBeNull();
    expect(
      within(readySection as HTMLElement).getByText(
        'No pulls meet every readiness check.',
      ),
    ).toBeInTheDocument();
    expect(
      within(readySection as HTMLElement).queryByRole('list', {
        name: 'Ready pull requests',
      }),
    ).not.toBeInTheDocument();
  });

  it('bypasses the cache manually and restarts the five-minute deadline on completion', async () => {
    vi.useFakeTimers();
    getPullsMock.mockResolvedValue(createPullsResponse());

    render(<App />);
    await flushPromises();
    expect(getPullsMock).toHaveBeenNthCalledWith(1, false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flushPromises();
    expect(getPullsMock).toHaveBeenNthCalledWith(2, true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL - 1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getPullsMock).toHaveBeenNthCalledWith(3, false);
  });

  it('schedules from completion and never overlaps requests', async () => {
    vi.useFakeTimers();
    const first = createDeferred<ReturnType<typeof createPullsResponse>>();
    const second = createDeferred<ReturnType<typeof createPullsResponse>>();
    const third = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    render(<App />);
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(createPullsResponse());
      await first.promise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL - 1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(createPullsResponse());
      await second.promise;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(3);
  });

  it('pauses hidden-tab work and refreshes when an overdue tab becomes visible', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    getPullsMock.mockResolvedValue(createPullsResponse());

    render(<App />);
    await flushPromises();
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL * 2);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(getPullsMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates the StrictMode lifecycle and leaves no timer after unmount', async () => {
    vi.useFakeTimers();
    const pending = createDeferred<ReturnType<typeof createPullsResponse>>();
    getPullsMock.mockReturnValue(pending.promise);

    const { unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(getPullsMock).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      pending.resolve(createPullsResponse());
      await pending.promise;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL);
    });
    expect(getPullsMock).toHaveBeenCalledTimes(1);
  });
});
