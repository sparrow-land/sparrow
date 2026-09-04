import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  readStoredTheme,
  resolveEffective,
  storeTheme,
  subscribeSystemTheme,
  systemPrefersDark,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from './theme.js';

/**
 * Install a controllable `window.matchMedia` stub. `dark` sets the initial
 * `(prefers-color-scheme: dark)` match; the returned `emit(next)` fires a
 * `change` event to every registered listener with the new value.
 */
function stubMatchMedia(dark: boolean) {
  let matches = dark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    emit(next: boolean) {
      matches = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

/** Ensure a theme-color meta exists in the jsdom document. */
function ensureMeta(initial = '#000000') {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', initial);
  return meta;
}

describe('theme logic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  describe('resolveEffective', () => {
    it('dark forces dark, light forces light regardless of system', () => {
      expect(resolveEffective('dark', true)).toBe('dark');
      expect(resolveEffective('dark', false)).toBe('dark');
      expect(resolveEffective('light', true)).toBe('light');
      expect(resolveEffective('light', false)).toBe('light');
    });

    it('auto follows the system preference', () => {
      expect(resolveEffective('auto', true)).toBe('dark');
      expect(resolveEffective('auto', false)).toBe('light');
    });

    it('auto reads a mocked matchMedia when no system flag is passed', () => {
      stubMatchMedia(false);
      expect(resolveEffective('auto')).toBe('light');
      stubMatchMedia(true);
      expect(resolveEffective('auto')).toBe('dark');
    });
  });

  describe('systemPrefersDark', () => {
    it('reflects the media query', () => {
      stubMatchMedia(true);
      expect(systemPrefersDark()).toBe(true);
      stubMatchMedia(false);
      expect(systemPrefersDark()).toBe(false);
    });
  });

  describe('applyTheme', () => {
    it('dark sets data-theme=dark and the dark meta color', () => {
      ensureMeta();
      applyTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.dark,
      );
    });

    it('light sets data-theme=light and the light meta color', () => {
      ensureMeta();
      applyTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.light,
      );
    });

    it('auto removes the override and colors the meta by the system theme', () => {
      stubMatchMedia(false); // system = light
      ensureMeta();
      document.documentElement.dataset.theme = 'dark'; // pre-existing override
      applyTheme('auto');
      expect('theme' in document.documentElement.dataset).toBe(false);
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.light,
      );
    });
  });

  describe('subscribeSystemTheme (live media change under auto)', () => {
    it('invokes the callback with the new value and unsubscribes cleanly', () => {
      const media = stubMatchMedia(true);
      const seen: boolean[] = [];
      const unsubscribe = subscribeSystemTheme((dark) => seen.push(dark));

      media.emit(false);
      media.emit(true);
      expect(seen).toEqual([false, true]);

      unsubscribe();
      expect(media.listenerCount()).toBe(0);
      media.emit(false);
      expect(seen).toEqual([false, true]); // no further calls after unsubscribe
    });

    it('re-applying under auto tracks the live system flip end to end', () => {
      const media = stubMatchMedia(true); // system starts dark
      ensureMeta();
      applyTheme('auto');
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.dark,
      );
      // Simulate the ThemeProvider wiring: on a system flip under auto, re-apply.
      subscribeSystemTheme(() => applyTheme('auto'));
      media.emit(false); // system flips to light
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.light,
      );
    });
  });

  describe('storage round-trip', () => {
    it('stores and reads a preference; unknown/missing → auto', () => {
      expect(readStoredTheme()).toBe('auto');
      storeTheme('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      expect(readStoredTheme()).toBe('dark');
      localStorage.setItem(THEME_STORAGE_KEY, 'nonsense');
      expect(readStoredTheme()).toBe('auto');
    });
  });
});
