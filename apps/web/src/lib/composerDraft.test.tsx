import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  COMPOSER_DRAFT_MAX_CHARS,
  clearDraft,
  draftKey,
  loadDraft,
  saveDraft,
  useDraft,
} from './composerDraft.js';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('draftKey', () => {
  it('namespaces by org AND room so two orgs never collide', () => {
    expect(draftKey('org_1', 'room_a')).toBe('sparrow:draft:org_1:room_a');
    expect(draftKey('org_2', 'room_a')).toBe('sparrow:draft:org_2:room_a');
    expect(draftKey('org_1', 'room_a')).not.toBe(draftKey('org_2', 'room_a'));
  });

  it('is distinct from the legacy server-draft-queue key', () => {
    expect(draftKey('org_1', 'room_a').startsWith('sparrow:drafts')).toBe(false);
  });
});

describe('load / save / clear', () => {
  it('round-trips text under its key', () => {
    const k = draftKey('org_1', 'room_a');
    expect(loadDraft(k)).toBe('');
    saveDraft(k, 'half a thought');
    expect(loadDraft(k)).toBe('half a thought');
    clearDraft(k);
    expect(loadDraft(k)).toBe('');
  });

  it('saving empty text removes the row rather than storing ""', () => {
    const k = draftKey('org_1', 'room_a');
    saveDraft(k, 'x');
    saveDraft(k, '');
    expect(localStorage.getItem(k)).toBeNull();
  });

  it('keeps rooms independent', () => {
    saveDraft(draftKey('org_1', 'room_a'), 'for A');
    saveDraft(draftKey('org_1', 'room_b'), 'for B');
    expect(loadDraft(draftKey('org_1', 'room_a'))).toBe('for A');
    expect(loadDraft(draftKey('org_1', 'room_b'))).toBe('for B');
  });

  it('drops a save past the cap and keeps the last good value', () => {
    const k = draftKey('org_1', 'room_a');
    saveDraft(k, 'good');
    saveDraft(k, 'x'.repeat(COMPOSER_DRAFT_MAX_CHARS + 1));
    expect(loadDraft(k)).toBe('good');
    // Exactly at the cap still lands.
    saveDraft(k, 'y'.repeat(COMPOSER_DRAFT_MAX_CHARS));
    expect(loadDraft(k)).toHaveLength(COMPOSER_DRAFT_MAX_CHARS);
  });

  it('swallows a throwing store (quota, private mode, no storage at all)', () => {
    const k = draftKey('org_1', 'room_a');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveDraft(k, 'x')).not.toThrow();
    expect(loadDraft(k)).toBe('');
    expect(() => clearDraft(k)).not.toThrow();
  });
});

/* ------------------------------- useDraft -------------------------------- */

/** A minimal composer over `useDraft`, with a Clear button for the third slot. */
function Box({ storageKey, debounceMs }: { storageKey: string; debounceMs?: number }) {
  const [value, setValue, clear] = useDraft(
    storageKey,
    debounceMs === undefined ? undefined : { debounceMs },
  );
  return (
    <div>
      <textarea aria-label="compose" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" onClick={clear}>
        Clear
      </button>
      <button type="button" onClick={() => setValue((cur) => `${cur}!`)}>
        Bang
      </button>
    </div>
  );
}

const KEY_A = draftKey('org_1', 'room_a');
const KEY_B = draftKey('org_1', 'room_b');

describe('useDraft', () => {
  it('initializes from the stored draft for its key', () => {
    saveDraft(KEY_A, 'saved earlier');
    render(<Box storageKey={KEY_A} />);
    expect(screen.getByLabelText('compose')).toHaveValue('saved earlier');
  });

  it('persists typing after the debounce', () => {
    vi.useFakeTimers();
    render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'hi' } });
    // Not yet — the write is debounced.
    expect(loadDraft(KEY_A)).toBe('');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(loadDraft(KEY_A)).toBe('hi');
  });

  it('honours a custom debounce window', () => {
    vi.useFakeTimers();
    render(<Box storageKey={KEY_A} debounceMs={1000} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'slow' } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(loadDraft(KEY_A)).toBe('');
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(loadDraft(KEY_A)).toBe('slow');
  });

  it('debounces: only the final value lands, not every keystroke', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<Box storageKey={KEY_A} />);
    const ta = screen.getByLabelText('compose');
    for (const v of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
      fireEvent.change(ta, { target: { value: v } });
    }
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadDraft(KEY_A)).toBe('abcdef');
  });

  it('flushes the pending write on unmount', () => {
    const { unmount } = render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'mid-thought' } });
    // The debounce has not elapsed — nothing is stored yet.
    expect(loadDraft(KEY_A)).toBe('');
    unmount();
    expect(loadDraft(KEY_A)).toBe('mid-thought');
  });

  it('restores on remount — navigate away mid-draft and come back', () => {
    const first = render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'half a thought' } });
    first.unmount();

    render(<Box storageKey={KEY_A} />);
    expect(screen.getByLabelText('compose')).toHaveValue('half a thought');
  });

  it('flushes the pending write on pagehide and beforeunload', () => {
    render(<Box storageKey={KEY_A} />);
    const ta = screen.getByLabelText('compose');
    fireEvent.change(ta, { target: { value: 'tab closing' } });
    expect(loadDraft(KEY_A)).toBe('');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(loadDraft(KEY_A)).toBe('tab closing');

    fireEvent.change(ta, { target: { value: 'tab closing now' } });
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });
    expect(loadDraft(KEY_A)).toBe('tab closing now');
  });

  it('re-initializes when the key changes — each room shows its own draft', () => {
    saveDraft(KEY_B, 'B had something');
    const view = render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'A text' } });

    view.rerender(<Box storageKey={KEY_B} />);
    expect(screen.getByLabelText('compose')).toHaveValue('B had something');
    // A's in-flight text was flushed on the way out, not carried over.
    expect(loadDraft(KEY_A)).toBe('A text');

    view.rerender(<Box storageKey={KEY_A} />);
    expect(screen.getByLabelText('compose')).toHaveValue('A text');
    expect(loadDraft(KEY_B)).toBe('B had something');
  });

  it('shows an empty box for a room with no draft of its own', () => {
    const view = render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'A text' } });
    view.rerender(<Box storageKey={KEY_B} />);
    expect(screen.getByLabelText('compose')).toHaveValue('');
  });

  it('clear() empties the box and removes the stored row', async () => {
    render(<Box storageKey={KEY_A} />);
    await userEvent.type(screen.getByLabelText('compose'), 'sent now');
    await waitFor(() => expect(loadDraft(KEY_A)).toBe('sent now'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText('compose')).toHaveValue('');
    expect(localStorage.getItem(KEY_A)).toBeNull();
  });

  it('clear() also cancels a write still in flight', () => {
    vi.useFakeTimers();
    render(<Box storageKey={KEY_A} />);
    fireEvent.change(screen.getByLabelText('compose'), { target: { value: 'about to send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(localStorage.getItem(KEY_A)).toBeNull();
  });

  it('supports a functional update', async () => {
    render(<Box storageKey={KEY_A} />);
    await userEvent.type(screen.getByLabelText('compose'), 'hey');
    await userEvent.click(screen.getByRole('button', { name: 'Bang' }));
    expect(screen.getByLabelText('compose')).toHaveValue('hey!');
    await waitFor(() => expect(loadDraft(KEY_A)).toBe('hey!'));
  });

  it('keeps working when storage throws on every access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { unmount } = render(<Box storageKey={KEY_A} />);
    await userEvent.type(screen.getByLabelText('compose'), 'still typeable');
    expect(screen.getByLabelText('compose')).toHaveValue('still typeable');
    expect(() => unmount()).not.toThrow();
  });
});
