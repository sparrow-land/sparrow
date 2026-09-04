/**
 * Theme (dark / light / auto) — the single mechanism the whole app themes off.
 *
 * How it works end to end:
 *  - The palette lives in CSS variables (`--sparrow-*`, see index.css). Those
 *    tokens resolve to the DARK palette by default and by `:root[data-theme=dark]`,
 *    and to the LIGHT palette under `@media (prefers-color-scheme: light)` (when
 *    NO override is set) and under `:root[data-theme=light]`. So every existing
 *    surface follows the theme for free — nothing keys off a `.dark` class.
 *  - `auto` = remove the `data-theme` attribute → the media query governs, live.
 *  - `dark` / `light` = set `data-theme` → the override wins in both directions.
 *  - The mobile status-bar `<meta name="theme-color">` is JS-only (CSS can't set
 *    it), so `applyTheme` updates it to the *effective* theme's color.
 *
 * The choice is mirrored to localStorage so an inline snippet in index.html can
 * apply it before first paint (no flash), then reconciled with the server value
 * once `/me` loads (see ThemeProvider).
 */
import { ThemePreferenceSchema, type ThemePreference } from '@sparrow/common-types';

export type { ThemePreference };

/** localStorage key. Kept in sync with the inline pre-paint snippet in index.html. */
export const THEME_STORAGE_KEY = 'sparrow:theme';

/** The two concrete themes the app can resolve to. */
export type EffectiveTheme = 'dark' | 'light';

/**
 * The mobile browser chrome / PWA status-bar color per effective theme. Kept in
 * sync with the inline snippet in index.html and the manifest's default.
 */
export const THEME_COLORS: Record<EffectiveTheme, string> = {
  dark: '#0a0c0f',
  light: '#f7f6f3',
};

/** The system media query. Returns `true` when the OS prefers dark. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    // No media-query support (SSR/old engines) → assume dark, the app's default.
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a preference to the concrete theme that should render right now. */
export function resolveEffective(
  pref: ThemePreference,
  systemDark: boolean = systemPrefersDark(),
): EffectiveTheme {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

/** Read the mirrored preference from localStorage; unknown/missing → `auto`. */
export function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const parsed = ThemePreferenceSchema.safeParse(raw);
    return parsed.success ? parsed.data : 'auto';
  } catch {
    return 'auto';
  }
}

/** Mirror the preference to localStorage (best-effort; storage may be unavailable). */
export function storeTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — the server value is still authoritative */
  }
}

/**
 * Apply a preference to the document: set/clear the `data-theme` override on the
 * root element and update the `theme-color` meta to the effective theme. Idempotent
 * and safe to call repeatedly (the inline snippet may have already applied it).
 */
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'auto') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolveEffective(pref)]);
}

/**
 * Subscribe to OS `prefers-color-scheme` changes. Invoked with the new
 * `systemDark` boolean whenever the system theme flips. Returns an unsubscribe
 * function. No-op where matchMedia is unavailable.
 */
export function subscribeSystemTheme(onChange: (systemDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
