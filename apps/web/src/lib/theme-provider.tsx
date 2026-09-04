import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '@sparrow/client';
import { useAuth } from './auth.js';
import { updateMe } from './client.js';
import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  subscribeSystemTheme,
  type ThemePreference,
} from './theme.js';

/**
 * App-wide theme state. The initial value was already applied to the document by
 * the inline snippet in index.html (before first paint, from localStorage); this
 * provider takes over at mount:
 *  - keeps the `data-theme` override + status-bar color in sync with the choice,
 *  - re-applies live when the OS theme flips while the choice is `auto`,
 *  - reconciles with the signed-in human's server value once `/me` loads
 *    (server wins across devices),
 *  - and persists changes both to localStorage and to the server (`PATCH /me`).
 */
export interface ThemeState {
  theme: ThemePreference;
  /** Change the theme: apply instantly, mirror to localStorage, and persist to the server. */
  setTheme(pref: ThemePreference): void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [theme, setThemeState] = useState<ThemePreference>(() => readStoredTheme());

  // Track the latest preference so the (once-installed) system-media listener
  // can decide whether to re-apply without re-subscribing on every change.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Apply on mount and whenever the preference changes (idempotent).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Live OS-theme changes only matter while the choice is `auto` — the CSS media
  // query re-colors the palette on its own, but the status-bar meta is JS-only.
  useEffect(() => {
    return subscribeSystemTheme(() => {
      if (themeRef.current === 'auto') applyTheme('auto');
    });
  }, []);

  // Reconcile with the server value once /me resolves (or when it changes on
  // another device). Adopt it locally WITHOUT re-writing it back to the server.
  const serverTheme = auth.user?.theme;
  useEffect(() => {
    if (serverTheme && serverTheme !== themeRef.current) {
      themeRef.current = serverTheme;
      setThemeState(serverTheme);
      storeTheme(serverTheme);
      applyTheme(serverTheme);
    }
  }, [serverTheme]);

  const setTheme = useCallback(
    (pref: ThemePreference) => {
      const previous = themeRef.current;
      if (pref === previous) return;
      // Optimistic: apply + mirror instantly so the UI never lags the click.
      themeRef.current = pref;
      setThemeState(pref);
      storeTheme(pref);
      applyTheme(pref);

      const user = auth.user;
      if (!user) return; // signed-out: local-only (no account to persist against)
      auth.updateUser({ ...user, theme: pref });
      void updateMe({ theme: pref }).catch((err) => {
        // Revert to the previous choice on failure so local + server stay honest.
        themeRef.current = previous;
        setThemeState(previous);
        storeTheme(previous);
        applyTheme(previous);
        auth.updateUser({ ...user, theme: previous });
        if (!(err instanceof ApiError)) throw err;
      });
    },
    [auth],
  );

  const value = useMemo<ThemeState>(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
