/**
 * App-wide hotkey registry — the ONE seam GUI keyboard shortcuts go through.
 *
 * v1 exists for exactly one binding (Escape → clawback in the room composer),
 * but it is deliberately shaped for growth (Jake: "I would like to soon
 * introduce more hotkeys into the GUI… let's code the escape-key hotkey as
 * something that we should generalize in the near future"): one window-level
 * keydown listener, declarative registrations with a human-readable
 * `description` (a future help overlay reads {@link registeredHotkeys}), and
 * scope-aware dispatch so a key can mean different things in different places.
 *
 * ## Scopes
 *
 * - `'composer'` — fires only while focus is inside an element carrying
 *   `data-hotkey-scope="composer"` (the attribute is honored on ancestors, so a
 *   wrapper can scope a whole widget). New scopes are added by extending
 *   {@link HotkeyScope} and stamping the attribute — the dispatch is generic.
 * - `'global'` — fires only while focus is NOT in an editable element
 *   (input/textarea/select/contenteditable): while the user is typing, keys are
 *   text, never commands. A scoped element is usually editable too, so global
 *   hotkeys stay quiet there as well.
 *
 * ## Stacking: LAST-REGISTERED-WINS
 *
 * Matching registrations are consulted newest-first; the first handler that
 * does not return `false` consumes the event (preventDefault + stop). Returning
 * `false` declines, passing the key to the next-newest match. This lets an
 * overlay/modal shadow a page-level binding for its lifetime by simply
 * registering later and unregistering on close — no priority numbers.
 *
 * Held-key auto-repeat (`event.repeat`) never fires a hotkey: a command is a
 * keypress, not a stream.
 */

/** The attribute an element stamps to opt its focus subtree into a scope. */
export const HOTKEY_SCOPE_ATTR = 'data-hotkey-scope';

/** Where a hotkey is live. See the module doc for the exact gating rules. */
export type HotkeyScope = 'global' | 'composer';

export interface HotkeyRegistration {
  /** Exact `KeyboardEvent.key` match, e.g. `'Escape'`. (Modifier combos are future work.) */
  key: string;
  scope: HotkeyScope;
  /** Return `false` to decline — the key passes to the next-newest match. */
  handler: (event: KeyboardEvent) => boolean | void;
  /** Human-readable purpose, for a future hotkey-help surface. */
  description: string;
}

/** A registration's public face (what a help overlay would list). */
export interface HotkeyInfo {
  key: string;
  scope: HotkeyScope;
  description: string;
}

// Registration order IS the stacking order (newest last; consulted in reverse).
const registrations: HotkeyRegistration[] = [];
let listening = false;

/** True when `el` takes text input, so plain keys must stay text, not commands. */
function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The scope the focused element (or an ancestor) opted into, if any. */
function activeScopeOf(el: Element | null): string | null {
  return el?.closest(`[${HOTKEY_SCOPE_ATTR}]`)?.getAttribute(HOTKEY_SCOPE_ATTR) ?? null;
}

function matches(reg: HotkeyRegistration, ev: KeyboardEvent, focused: Element | null): boolean {
  if (ev.key !== reg.key) return false;
  if (reg.scope === 'global') return !isEditable(focused);
  return activeScopeOf(focused) === reg.scope;
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.repeat) return;
  const focused = document.activeElement;
  // Newest-first: the last registration wins; `false` declines to the next.
  for (let i = registrations.length - 1; i >= 0; i -= 1) {
    const reg = registrations[i]!;
    if (!matches(reg, ev, focused)) continue;
    if (reg.handler(ev) === false) continue;
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
}

/**
 * Register a hotkey; returns its unregister function. The one window listener
 * is installed with the first registration and removed with the last, so an
 * idle registry costs nothing.
 */
export function registerHotkey(reg: HotkeyRegistration): () => void {
  registrations.push(reg);
  if (!listening) {
    window.addEventListener('keydown', onKeydown);
    listening = true;
  }
  let active = true;
  return () => {
    if (!active) return; // idempotent — a double-unregister must not evict a peer
    active = false;
    const i = registrations.indexOf(reg);
    if (i >= 0) registrations.splice(i, 1);
    if (registrations.length === 0 && listening) {
      window.removeEventListener('keydown', onKeydown);
      listening = false;
    }
  };
}

/** The live registrations, newest last — for tests and a future help overlay. */
export function registeredHotkeys(): HotkeyInfo[] {
  return registrations.map(({ key, scope, description }) => ({ key, scope, description }));
}
