import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export const THEME_STORAGE_KEY = 'puller-theme';

export type Theme = 'dark' | 'light' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;

type ThemeContextValue = {
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  theme: Theme;
};

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isTheme = (value: unknown): value is Theme =>
  value === 'dark' || value === 'light' || value === 'system';

const systemTheme = (): ResolvedTheme =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light';

const storedTheme = (storageKey: string, fallback: Theme): Theme => {
  if (typeof window === 'undefined') return fallback;

  try {
    const value = window.localStorage.getItem(storageKey);
    return isTheme(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

const applyTheme = (theme: ResolvedTheme): void => {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
  root.style.colorScheme = theme;
  root.dataset.theme = theme;

  const color = theme === 'dark' ? '#18181b' : '#ffffff';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', color);
};

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = THEME_STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme(storageKey, defaultTheme));
  const [preferredTheme, setPreferredTheme] = useState<ResolvedTheme>(systemTheme);
  const resolvedTheme = theme === 'system' ? preferredTheme : theme;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setPreferredTheme(event.matches ? 'dark' : 'light');
    };

    setPreferredTheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === storageKey && isTheme(event.newValue)) {
        setThemeState(event.newValue);
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  const setTheme = useCallback(
    (nextTheme: Theme): void => {
      setThemeState(nextTheme);
      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch {
        // Theme selection remains active for this page when storage is unavailable.
      }
    },
    [storageKey],
  );

  const value = useMemo(
    () => ({ resolvedTheme, setTheme, theme }),
    [resolvedTheme, setTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
};
