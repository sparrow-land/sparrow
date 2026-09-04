import { describe, it, expect, afterEach, vi } from 'vitest';
import { registerHotkey, registeredHotkeys, HOTKEY_SCOPE_ATTR } from './hotkeys.js';

/**
 * The app-wide hotkey registry (v1: Escape→clawback; deliberately shaped for
 * more hotkeys later — Jake: "let's code the escape-key hotkey as something
 * that we should generalize in the near future").
 *
 * Contract under test:
 *  - `registerHotkey({key, scope, handler, description})` → unregister fn;
 *  - ONE window keydown listener regardless of registration count;
 *  - scope gating: a `composer`-scoped hotkey fires only while focus is inside
 *    an element carrying `data-hotkey-scope="composer"`; a `global` hotkey
 *    fires only while focus is NOT in an editable element;
 *  - stacking: LAST-REGISTERED-WINS — the newest matching registration is
 *    consulted first and consumes the event unless its handler returns `false`,
 *    which passes the key on to the next-newest;
 *  - held-key auto-repeat (`event.repeat`) never fires a hotkey.
 */

const cleanups: Array<() => void> = [];
function reg(opts: Parameters<typeof registerHotkey>[0]): () => void {
  const off = registerHotkey(opts);
  cleanups.push(off);
  return off;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function press(key: string, opts: { repeat?: boolean } = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    repeat: opts.repeat ?? false,
  });
  (document.activeElement ?? window).dispatchEvent(ev);
  return ev;
}

/** A focusable composer-scoped textarea, like the room composer's. */
function mountComposer(): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.setAttribute(HOTKEY_SCOPE_ATTR, 'composer');
  document.body.appendChild(ta);
  return ta;
}

describe('registerHotkey — register/unregister', () => {
  it('fires a matching hotkey and stops after unregister', () => {
    const handler = vi.fn();
    const off = reg({ key: 'Escape', scope: 'composer', handler, description: 'test' });
    const ta = mountComposer();
    ta.focus();

    press('Escape');
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    press('Escape');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exposes registrations for future help surfaces, and drops them on unregister', () => {
    const off = reg({
      key: 'Escape',
      scope: 'composer',
      handler: () => {},
      description: 'Pull back your last message',
    });
    expect(registeredHotkeys()).toEqual([
      { key: 'Escape', scope: 'composer', description: 'Pull back your last message' },
    ]);
    off();
    expect(registeredHotkeys()).toEqual([]);
  });

  it('installs ONE window keydown listener across registrations, removed when empty', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const off1 = reg({ key: 'Escape', scope: 'composer', handler: () => {}, description: 'a' });
    const off2 = reg({ key: 'k', scope: 'global', handler: () => {}, description: 'b' });
    const keydownAdds = add.mock.calls.filter(([type]) => type === 'keydown');
    expect(keydownAdds).toHaveLength(1);

    off1();
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    off2();
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });

  it('never fires on key auto-repeat (a held Escape must not machine-gun the handler)', () => {
    const handler = vi.fn();
    reg({ key: 'Escape', scope: 'composer', handler, description: 'test' });
    mountComposer().focus();

    press('Escape', { repeat: true });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('registerHotkey — scope gating', () => {
  it("a 'composer' hotkey fires only while focus is inside the composer scope", () => {
    const handler = vi.fn();
    reg({ key: 'Escape', scope: 'composer', handler, description: 'test' });

    // Focus on the body: no fire.
    press('Escape');
    expect(handler).not.toHaveBeenCalled();

    // Focus in a NON-composer input: no fire.
    const stray = document.createElement('input');
    document.body.appendChild(stray);
    stray.focus();
    press('Escape');
    expect(handler).not.toHaveBeenCalled();

    // Focus in the composer: fires.
    mountComposer().focus();
    press('Escape');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the scope attribute is honored on an ancestor, not just the focused element itself', () => {
    const handler = vi.fn();
    reg({ key: 'Escape', scope: 'composer', handler, description: 'test' });
    const wrap = document.createElement('div');
    wrap.setAttribute(HOTKEY_SCOPE_ATTR, 'composer');
    const ta = document.createElement('textarea');
    wrap.appendChild(ta);
    document.body.appendChild(wrap);
    ta.focus();

    press('Escape');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a 'global' hotkey fires outside editables and stays quiet while typing", () => {
    const handler = vi.fn();
    reg({ key: 'k', scope: 'global', handler, description: 'test' });

    // Body focus: fires.
    press('k');
    expect(handler).toHaveBeenCalledTimes(1);

    // Typing in an input: the key is TEXT, not a command.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('k');
    expect(handler).toHaveBeenCalledTimes(1);

    // The composer is an editable too — global hotkeys stay quiet there.
    mountComposer().focus();
    press('k');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a consumed hotkey preventDefaults; a non-matching key is left untouched', () => {
    reg({ key: 'Escape', scope: 'composer', handler: () => {}, description: 'test' });
    mountComposer().focus();

    expect(press('Escape').defaultPrevented).toBe(true);
    expect(press('Enter').defaultPrevented).toBe(false);
  });
});

describe('registerHotkey — stacking (last-registered-wins)', () => {
  it('the newest matching registration consumes the event; older ones stay quiet', () => {
    const older = vi.fn();
    const newer = vi.fn();
    reg({ key: 'Escape', scope: 'composer', handler: older, description: 'older' });
    reg({ key: 'Escape', scope: 'composer', handler: newer, description: 'newer' });
    mountComposer().focus();

    press('Escape');
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it('a handler returning false declines, passing the key to the next-newest', () => {
    const older = vi.fn();
    const newer = vi.fn(() => false as const);
    reg({ key: 'Escape', scope: 'composer', handler: older, description: 'older' });
    reg({ key: 'Escape', scope: 'composer', handler: newer, description: 'newer' });
    mountComposer().focus();

    press('Escape');
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('when every handler declines, the event is not consumed', () => {
    reg({ key: 'Escape', scope: 'composer', handler: () => false, description: 'a' });
    mountComposer().focus();
    expect(press('Escape').defaultPrevented).toBe(false);
  });
});
