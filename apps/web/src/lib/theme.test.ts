import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  DARK_ENABLED_ATTR,
  DARK_MODE_ENABLED,
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
    document.documentElement.removeAttribute(DARK_ENABLED_ATTR);
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  // The three-way mechanism, exercised with dark mode ON (the third argument).
  // What the SHIPPED flag does to it is pinned separately, further down.
  describe('resolveEffective (dark mode enabled)', () => {
    it('dark forces dark, light forces light regardless of system', () => {
      expect(resolveEffective('dark', true, true)).toBe('dark');
      expect(resolveEffective('dark', false, true)).toBe('dark');
      expect(resolveEffective('light', true, true)).toBe('light');
      expect(resolveEffective('light', false, true)).toBe('light');
    });

    it('auto follows the system preference', () => {
      expect(resolveEffective('auto', true, true)).toBe('dark');
      expect(resolveEffective('auto', false, true)).toBe('light');
    });

    it('auto reads a mocked matchMedia when no system flag is passed', () => {
      stubMatchMedia(false);
      expect(resolveEffective('auto', undefined, true)).toBe('light');
      stubMatchMedia(true);
      expect(resolveEffective('auto', undefined, true)).toBe('dark');
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

  describe('applyTheme (dark mode enabled)', () => {
    it('dark sets data-theme=dark and the dark meta color', () => {
      ensureMeta();
      applyTheme('dark', true);
      expect(document.documentElement.hasAttribute(DARK_ENABLED_ATTR)).toBe(true);
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.dark,
      );
    });

    it('light sets data-theme=light and the light meta color', () => {
      ensureMeta();
      applyTheme('light', true);
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.light,
      );
    });

    it('auto removes the override and colors the meta by the system theme', () => {
      stubMatchMedia(false); // system = light
      ensureMeta();
      document.documentElement.dataset.theme = 'dark'; // pre-existing override
      applyTheme('auto', true);
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
      applyTheme('auto', true);
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.dark,
      );
      // Simulate the ThemeProvider wiring: on a system flip under auto, re-apply.
      subscribeSystemTheme(() => applyTheme('auto', true));
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

/**
 * The launch switch: dark mode is disabled app-wide (`DARK_MODE_ENABLED`). The
 * mechanism is untouched — every function still takes the flag, so the tests
 * below pin BOTH paths and flipping the constant back restores dark mode
 * without a single other edit.
 */
describe('DARK_MODE_ENABLED — the light-only switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute(DARK_ENABLED_ATTR);
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  describe('flag OFF', () => {
    it('resolves LIGHT for every preference, whatever the OS prefers', () => {
      for (const pref of ['auto', 'light', 'dark'] as const) {
        expect(resolveEffective(pref, true, false)).toBe('light');
        expect(resolveEffective(pref, false, false)).toBe('light');
      }
    });

    it('applyTheme pins the root to light and leaves no dark gate on it', () => {
      ensureMeta();
      document.documentElement.setAttribute(DARK_ENABLED_ATTR, ''); // stale gate
      applyTheme('dark', false);
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.hasAttribute(DARK_ENABLED_ATTR)).toBe(false);
      expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
        THEME_COLORS.light,
      );
    });

    it('a stored "dark" choice under an OS-dark system still renders light', () => {
      stubMatchMedia(true); // OS prefers dark
      storeTheme('dark'); // and the human once chose dark
      expect(resolveEffective(readStoredTheme(), undefined, false)).toBe('light');
    });
  });

  describe('flag ON (the path that comes back when the switch flips)', () => {
    it('resolves dark for an explicit dark choice and for auto under an OS-dark system', () => {
      expect(resolveEffective('dark', false, true)).toBe('dark');
      expect(resolveEffective('auto', true, true)).toBe('dark');
      expect(resolveEffective('auto', false, true)).toBe('light');
    });

    it('applyTheme sets the dark gate the CSS palette hangs off', () => {
      ensureMeta();
      applyTheme('auto', true);
      expect(document.documentElement.hasAttribute(DARK_ENABLED_ATTR)).toBe(true);
      expect('theme' in document.documentElement.dataset).toBe(false);
    });
  });

  it('the shipped default drives the whole app through one constant', () => {
    stubMatchMedia(true);
    storeTheme('dark');
    expect(resolveEffective(readStoredTheme())).toBe(DARK_MODE_ENABLED ? 'dark' : 'light');
  });
});

/**
 * The palette itself, not just the JS. CSS is the half that can quietly ignore
 * the flag: a bare `@media (prefers-color-scheme: dark)` rule repaints the app
 * for every OS-dark visitor no matter what `applyTheme` wrote on the root. So
 * the dark palette is gated on the same attribute the flag controls, and this
 * test reads the stylesheet to prove no ungated dark rule crept back in.
 */
describe('index.css — the dark palette is gated, not merely unused', () => {
  // jsdom's `URL` resolves a relative href against the DOCUMENT base, not the
  // base it is handed, so the stylesheet is located the way branding.test.ts
  // locates the manifest: src/lib -> src.
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'),
    'utf8',
  );

  it('declares the LIGHT palette as the unconditional default', () => {
    const base = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    expect(base).toContain('color-scheme: light');
    expect(base).toContain('--sparrow-bg: #f7f6f3');
  });

  it('gates every prefers-color-scheme: dark block on the dark-mode attribute', () => {
    const blocks = [...css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g)];
    expect(blocks.length).toBeGreaterThan(0); // the dark path is still here…
    for (const m of blocks) {
      // …and each one only paints a root the provider has explicitly gated.
      const selector = css.slice(m.index! + m[0].length, css.indexOf('{', m.index! + m[0].length));
      expect(selector).toContain(`[${DARK_ENABLED_ATTR}]`);
    }
  });

  it('gates the explicit-dark override on it too', () => {
    expect(css).toContain(`:root[${DARK_ENABLED_ATTR}][data-theme='dark']`);
    expect(css).not.toMatch(/^:root\[data-theme='dark'\]/m);
  });
});
