/**
 * Theme (dark / light / auto) — the single mechanism the whole app themes off.
 *
 * DARK MODE IS OFF (see `DARK_MODE_ENABLED` below). The mechanism is intact and
 * the dark palette still ships; one constant decides whether any of it applies.
 *
 * How it works end to end:
 *  - The palette lives in CSS variables (`--sparrow-*`, see index.css). Those
 *    tokens resolve to the LIGHT palette by default, and to the DARK palette
 *    only on a root carrying BOTH the dark-mode gate (`DARK_ENABLED_ATTR`, which
 *    this module writes only when the flag is on) and either `data-theme=dark`
 *    or no `data-theme` under `@media (prefers-color-scheme: dark)`. So every
 *    existing surface follows the theme for free — nothing keys off a `.dark`
 *    class, and with the flag off no dark rule can match at all.
 *  - `auto` = remove the `data-theme` attribute → the media query governs, live.
 *  - `dark` / `light` = set `data-theme` → the override wins in both directions.
 *  - The mobile status-bar `<meta name="theme-color">` is JS-only (CSS can't set
 *    it), so `applyTheme` updates it to the *effective* theme's color.
 *
 * The choice is mirrored to localStorage so an inline snippet in index.html can
 * apply it before first paint (no flash), then reconciled with the server value
 * once `/me` loads (see ThemeProvider).
 */
import { ThemePreferenceSchema, type ThemePreference } from '@sparrow-land/sdk/types';

export type { ThemePreference };

/**
 * Master switch for dark mode. OFF for launch: the app renders light for
 * everyone, whatever they stored and whatever their OS prefers.
 *
 * Flip this to `true` and dark mode comes back whole — nothing else needs an
 * edit. It gates three things, and only these three:
 *   1. `resolveEffective` (and therefore the status-bar color),
 *   2. the `DARK_ENABLED_ATTR` gate `applyTheme` writes on `<html>`, which every
 *      dark rule in index.css hangs off (and the pre-paint snippet in
 *      index.html mirrors — keep the two in sync),
 *   3. the Appearance control in My settings, which hides while it is off.
 *
 * Typed `boolean` rather than the literal `false` on purpose: the call sites
 * stay live code under `tsc` instead of being narrowed away as unreachable.
 */
export const DARK_MODE_ENABLED: boolean = false;

/**
 * The root attribute the dark palette in index.css is gated on. Present only
 * while {@link DARK_MODE_ENABLED} is true, so an OS-dark visitor gets the light
 * palette rather than a half-applied dark one.
 */
export const DARK_ENABLED_ATTR = 'data-dark-enabled';

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

/**
 * Resolve a preference to the concrete theme that should render right now.
 *
 * `darkEnabled` defaults to the shipped flag and is a parameter only so both
 * paths stay testable while dark mode is off. With it false the answer is
 * always `light` — a stored `dark` and an OS-dark system alike.
 */
export function resolveEffective(
  pref: ThemePreference,
  systemDark?: boolean,
  darkEnabled: boolean = DARK_MODE_ENABLED,
): EffectiveTheme {
  if (!darkEnabled) return 'light';
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return (systemDark ?? systemPrefersDark()) ? 'dark' : 'light';
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
 * Apply a preference to the document: set/clear the `data-theme` override and
 * the dark-mode gate on the root element, and update the `theme-color` meta to
 * the effective theme. Idempotent and safe to call repeatedly (the inline
 * snippet may have already applied it).
 *
 * With dark mode off the root is PINNED to light and the gate is removed, so a
 * stored `dark` choice (or an OS-dark system) cannot leak a dark rule through.
 */
export function applyTheme(pref: ThemePreference, darkEnabled: boolean = DARK_MODE_ENABLED): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!darkEnabled) {
    root.removeAttribute(DARK_ENABLED_ATTR);
    root.dataset.theme = 'light';
  } else {
    root.setAttribute(DARK_ENABLED_ATTR, '');
    if (pref === 'auto') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = pref;
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolveEffective(pref, undefined, darkEnabled)]);
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
