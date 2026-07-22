// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, THEME_STORAGE_KEY } from '@/theme';
import ThemeToggle from './ThemeToggle';

type Listener = (event: MediaQueryListEvent) => void;

let dark = true;
const listeners = new Set<Listener>();
const storage = new Map<string, string>();

const matchMedia = vi.fn((query: string): MediaQueryList => ({
  addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.add(listener as Listener);
  },
  addListener: vi.fn(),
  dispatchEvent: vi.fn(),
  matches: query === '(prefers-color-scheme: dark)' && dark,
  media: query,
  onchange: null,
  removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.delete(listener as Listener);
  },
  removeListener: vi.fn(),
}));

beforeEach(() => {
  dark = true;
  listeners.clear();
  storage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: matchMedia,
  });
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark', 'light');
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  vi.clearAllMocks();
});

describe('ThemeToggle', () => {
  it('defaults to System, follows live OS changes, and exposes the current choice', async () => {
    render(
      <ThemeProvider defaultTheme="system">
        <ThemeToggle />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement).toHaveClass('dark'),
    );
    expect(screen.getByRole('button', { name: 'Theme: System' })).toBeInTheDocument();

    dark = false;
    listeners.forEach((listener) =>
      listener({ matches: false } as MediaQueryListEvent),
    );
    await waitFor(() =>
      expect(document.documentElement).toHaveClass('light'),
    );
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('persists an accessible Light/Dark/System menu selection', async () => {
    render(
      <ThemeProvider defaultTheme="system">
        <ThemeToggle />
      </ThemeProvider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Theme: System' }), {
      button: 0,
      ctrlKey: false,
    });
    const light = await screen.findByRole('menuitemradio', { name: 'Light' });
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(light);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeInTheDocument();
      expect(document.documentElement).toHaveClass('light');
    });
    expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
  });
});
