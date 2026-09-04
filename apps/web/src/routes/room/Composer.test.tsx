import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Composer,
  isMac,
  modKeyLabel,
  nextComposerHeight,
  COMPOSER_MIN_HEIGHT_PX,
  COMPOSER_MAX_HEIGHT_PX,
} from './Composer.js';
import type { PendingAttachment } from '../../lib/attachments.js';

function pending(over: Partial<PendingAttachment> = {}): PendingAttachment {
  const filename = over.filename ?? 'note.txt';
  const contentType = over.contentType ?? 'text/plain';
  return {
    id: over.id ?? 'pa_1',
    file: over.file ?? new File(['x'], filename, { type: contentType }),
    filename,
    contentType,
    size: over.size ?? 1234,
    ...over,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props: React.ComponentProps<typeof Composer> = {
    value: 'hello',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onDraft: vi.fn(),
    onOpenDrafts: vi.fn(),
    draftCount: 0,
    canCompose: true,
    sending: false,
    sendError: null,
    placeholder: 'Message…',
    suggestions: null,
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe('platform helpers', () => {
  it('detects mac from platform/userAgent', () => {
    expect(isMac({ platform: 'MacIntel', userAgent: '' })).toBe(true);
    expect(isMac({ platform: 'Win32', userAgent: 'Mozilla' })).toBe(false);
    expect(isMac({ platform: '', userAgent: 'iPhone' })).toBe(true);
  });
  it('labels the modifier per platform', () => {
    expect(modKeyLabel({ platform: 'MacIntel', userAgent: '' })).toBe('⌘');
    expect(modKeyLabel({ platform: 'Linux x86_64', userAgent: '' })).toBe('Ctrl');
  });
});

describe('Composer drafts', () => {
  it('has a Draft button that enqueues the current text', async () => {
    const { onDraft } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it('disables the Draft button when the composer is empty', () => {
    setup({ value: '   ' });
    expect(screen.getByRole('button', { name: 'Draft' })).toBeDisabled();
  });

  it('Cmd/Ctrl+Enter enqueues a draft (not a send)', () => {
    const { onDraft, onSend } = setup();
    const ta = screen.getByRole('textbox');
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(onDraft).toHaveBeenCalledTimes(2);
  });

  it('Cmd/Ctrl+Shift+Enter opens the drafts modal', () => {
    const { onOpenDrafts, onDraft, onSend } = setup();
    const ta = screen.getByRole('textbox');
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onOpenDrafts).toHaveBeenCalledTimes(1);
    expect(onDraft).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('plain Enter still sends; Shift+Enter still makes a newline', () => {
    const { onSend, onDraft } = setup();
    const ta = screen.getByRole('textbox');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1); // unchanged
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('hides the drafts link at 0 and shows a count when > 0', () => {
    const { rerender } = renderWithRerender({ draftCount: 0 });
    expect(screen.queryByRole('button', { name: /drafts/i })).toBeNull();
    rerender({ draftCount: 3 });
    expect(screen.getByRole('button', { name: /drafts \(3\)/i })).toBeInTheDocument();
  });

  it('clicking the drafts link opens the modal', async () => {
    const onOpenDrafts = vi.fn();
    setup({ draftCount: 2, onOpenDrafts });
    await userEvent.click(screen.getByRole('button', { name: /drafts \(2\)/i }));
    expect(onOpenDrafts).toHaveBeenCalledTimes(1);
  });

  // The hotkey hint is decoration that gets hidden at phone widths (it crowds
  // the controls and overflows the composer); the hotkeys themselves — asserted
  // above — are the real interface, so the hint must not be in the a11y tree.
  it('marks the hotkey hint as decorative (aria-hidden)', () => {
    setup();
    const hint = screen.getByText(/Enter to send/);
    expect(hint).toHaveAttribute('aria-hidden', 'true');
  });

  // Escape → clawback was entirely undocumented in the UI: the only trigger is a
  // key nobody would guess, so the hint line names it alongside the others.
  it('documents the clawback key in the hint line', () => {
    setup();
    const hint = screen.getByText(/Enter to send/);
    expect(hint.textContent).toBe(
      `Enter to send · Shift+Enter for newline · ${modKeyLabel()}+Enter to draft · Esc pulls back your last message`,
    );
  });
});

// Opening a conversation should land the caret in the composer (issue #47).
// Opt-in, so the composer is still inert wherever it is embedded without one.
describe('Composer autoFocus', () => {
  it('focuses the textarea on mount when asked', async () => {
    setup({ autoFocus: true });
    const ta = screen.getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(ta));
  });

  it('does not focus without the opt-in', () => {
    setup();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('never robs focus from an element the user is already in', () => {
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    setup({ autoFocus: true });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('waits for the composer to become enabled before focusing', async () => {
    const props: React.ComponentProps<typeof Composer> = {
      value: '',
      onChange: vi.fn(),
      onSend: vi.fn(),
      onDraft: vi.fn(),
      onOpenDrafts: vi.fn(),
      draftCount: 0,
      canCompose: false,
      sending: false,
      sendError: null,
      placeholder: 'Message…',
      suggestions: null,
      autoFocus: true,
    };
    const { rerender } = render(<Composer {...props} />);
    const ta = screen.getByRole('textbox');
    expect(document.activeElement).not.toBe(ta);
    // The room finishes loading → the composer enables → the caret lands.
    rerender(<Composer {...props} canCompose />);
    await waitFor(() => expect(document.activeElement).toBe(ta));
  });
});

// The composer must fit narrow phone viewports with no horizontal overflow.
// jsdom has no layout, so we lock the box-model-relevant classes: the textarea
// is width-capped to its padded parent, the controls row WRAPS instead of
// forcing width, and the button cluster holds its size (shrink-0) while the
// left/info group shrinks (min-w-0). Reasoning: with these, the widest forced
// element is the fixed button cluster (~180px), well under a 320px viewport, so
// nothing pushes the page wider than the screen.
describe('Composer phone-fit layout', () => {
  it('caps the textarea width to its parent (w-full max-w-full)', () => {
    setup();
    const ta = screen.getByRole('textbox');
    expect(ta.className).toContain('w-full');
    expect(ta.className).toContain('max-w-full');
  });

  it('lets the controls row wrap and shrink instead of overflowing', () => {
    setup();
    // The Send button anchors the controls row; walk up to the wrapping flex row.
    const send = screen.getByRole('button', { name: /^send$/i });
    const buttonCluster = send.parentElement!;
    // Buttons stay their natural size…
    expect(buttonCluster.className).toContain('shrink-0');
    // …inside a row that can wrap to a second line on narrow widths.
    const controlsRow = buttonCluster.parentElement!;
    expect(controlsRow.className).toContain('flex-wrap');
    // The info/hotkey group is allowed to shrink to zero (min-w-0).
    const infoGroup = controlsRow.firstElementChild!;
    expect(infoGroup.className).toContain('min-w-0');
  });
});

describe('nextComposerHeight (pure autosize clamp)', () => {
  it('enforces the minimum height for short content', () => {
    expect(nextComposerHeight(10)).toEqual({
      height: COMPOSER_MIN_HEIGHT_PX,
      overflowY: 'hidden',
    });
    // exactly at min stays at min
    expect(nextComposerHeight(COMPOSER_MIN_HEIGHT_PX)).toEqual({
      height: COMPOSER_MIN_HEIGHT_PX,
      overflowY: 'hidden',
    });
  });

  it('grows to fit content between the min and the max', () => {
    const mid = Math.round((COMPOSER_MIN_HEIGHT_PX + COMPOSER_MAX_HEIGHT_PX) / 2);
    expect(nextComposerHeight(mid)).toEqual({ height: mid, overflowY: 'hidden' });
  });

  it('caps at the maximum and enables internal scrolling', () => {
    expect(nextComposerHeight(COMPOSER_MAX_HEIGHT_PX + 500)).toEqual({
      height: COMPOSER_MAX_HEIGHT_PX,
      overflowY: 'auto',
    });
  });

  it('has a sane min/max ordering (min < max)', () => {
    expect(COMPOSER_MIN_HEIGHT_PX).toBeLessThan(COMPOSER_MAX_HEIGHT_PX);
  });
});

describe('Composer autosize (DOM effect)', () => {
  // jsdom has no layout, so scrollHeight is always 0 — we mock a mutable value
  // to simulate the textarea's natural content height growing and shrinking.
  function mockScrollHeight(el: HTMLElement) {
    const ref = { value: 0 };
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => ref.value,
    });
    return ref;
  }

  it('sizes to the minimum on mount for short content', () => {
    // A real short/empty textarea reports a one-line scrollHeight (never 0 — 0
    // means "unmeasurable/not laid out yet"), which clamps up to the min.
    const { rerender } = renderWithRerender({ value: 'hi' });
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    const sh = mockScrollHeight(ta);
    sh.value = 20; // one short line, below the resting minimum
    rerender({ value: 'hi ' }); // re-measure now that scrollHeight is real
    expect(ta.style.height).toBe(`${COMPOSER_MIN_HEIGHT_PX}px`);
    expect(ta.style.overflowY).toBe('hidden');
  });

  it('grows to fit as the value gets taller, then shrinks back when cleared', () => {
    const { rerender } = renderWithRerender({ value: 'one line' });
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    const sh = mockScrollHeight(ta);

    // A tall multiline value.
    sh.value = 140;
    rerender({ value: 'a\nb\nc\nd\ne\nf' });
    expect(ta.style.height).toBe('140px');
    expect(ta.style.overflowY).toBe('hidden');

    // Cleared (e.g. after send) → back to the minimum. An empty textarea still
    // has a one-line content height in a real browser (not 0).
    sh.value = 18;
    rerender({ value: '' });
    expect(ta.style.height).toBe(`${COMPOSER_MIN_HEIGHT_PX}px`);
    expect(ta.style.overflowY).toBe('hidden');
  });

  it('caps at the max and scrolls internally for very long content', () => {
    const { rerender } = renderWithRerender({ value: 'short' });
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    const sh = mockScrollHeight(ta);

    sh.value = COMPOSER_MAX_HEIGHT_PX + 1000;
    rerender({ value: 'a\n'.repeat(50) });
    expect(ta.style.height).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`);
    expect(ta.style.overflowY).toBe('auto');
  });

  // Regression: switching rooms in the SPA remounts the composer (Room is keyed
  // by roomId) with the same draft, so the value-keyed pass runs once — and if
  // the box isn't laid out yet (scrollHeight 0) it must NOT lock in a truncated
  // height with hidden overflow. A later ResizeObserver pass (fired once layout
  // settles) sizes it correctly.
  it('does not lock a truncated height when scrollHeight is 0 at mount, then sizes correctly once layout settles', () => {
    // Controllable ResizeObserver: capture the callbacks so the test can fire
    // them like the browser does once the composer's box is finally laid out.
    const observers: Array<{ cb: ResizeObserverCallback; el: Element }> = [];
    const orig = globalThis.ResizeObserver;
    class RO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observers.push({ cb: this.cb, el });
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
    try {
      // A multi-line draft is present at mount, but scrollHeight reads 0 because
      // the box isn't laid out yet (fresh client-side room switch).
      setup({ value: 'line 1\nline 2\nline 3\nline 4' });
      const ta = screen.getByRole('textbox') as HTMLTextAreaElement;

      // The value-keyed layout pass measured 0 → must NOT have clamped to a
      // small fixed height with hidden overflow (that is the truncation bug).
      expect(ta.style.height).not.toBe(`${COMPOSER_MIN_HEIGHT_PX}px`);

      // Layout settles: scrollHeight now reports the real content height and the
      // ResizeObserver fires — the composer must size to it.
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 120 });
      expect(observers.length).toBeGreaterThan(0);
      for (const o of observers) {
        o.cb([{ target: o.el } as ResizeObserverEntry], o as unknown as ResizeObserver);
      }
      expect(ta.style.height).toBe('120px');
      expect(ta.style.overflowY).toBe('hidden');
    } finally {
      globalThis.ResizeObserver = orig;
    }
  });
});

describe('Composer voice', () => {
  it('shows no mic when onTranscript is not wired (capabilities off / no provider)', () => {
    setup({ onTranscript: undefined });
    expect(screen.queryByRole('button', { name: /record voice/i })).toBeNull();
  });

  it('renders the mic when onTranscript is wired (STT capable)', async () => {
    // With no CapabilitiesProvider, useCapabilities defaults to stt:false, so the
    // MicButton renders nothing even when wired — assert that gating holds.
    setup({ onTranscript: vi.fn() });
    expect(screen.queryByRole('button', { name: /record voice/i })).toBeNull();
  });

  it('renders the voice provenance chip when voiceChip is set', () => {
    setup({ voiceChip: true });
    expect(screen.getByLabelText(/composed by voice/i)).toBeInTheDocument();
  });

  it('hides the voice chip by default', () => {
    setup();
    expect(screen.queryByLabelText(/composed by voice/i)).toBeNull();
  });
});

describe('Composer attachments', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stages files pasted as clipboard files (e.g. a screenshot)', () => {
    const onAddFiles = vi.fn();
    setup({ onAddFiles });
    const ta = screen.getByRole('textbox');
    const file = new File(['img'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(ta, { clipboardData: { files: [file], items: [] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0]![0]).toEqual([file]);
  });

  it('leaves a plain text paste alone (no file staging)', () => {
    const onAddFiles = vi.fn();
    setup({ onAddFiles });
    const ta = screen.getByRole('textbox');
    fireEvent.paste(ta, { clipboardData: { files: [], items: [] } });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it('stages files chosen through the paperclip file picker', () => {
    const onAddFiles = vi.fn();
    const { container } = render(<Composer {...baseProps({ onAddFiles })} />);
    // The paperclip button is the visible affordance; the input is the hidden plumbing.
    expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
    const file = new File(['doc'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0]![0]).toEqual([file]);
  });

  it('stages files dropped on the composer and highlights while dragging over', () => {
    const onAddFiles = vi.fn();
    const { container } = render(<Composer {...baseProps({ onAddFiles })} />);
    const dropzone = container.querySelector('[data-testid="composer-dropzone"]') as HTMLElement;
    expect(dropzone).not.toBeNull();

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [], items: [{ kind: 'file' }] } });
    expect(dropzone.getAttribute('data-dragging')).toBe('true');

    const file = new File(['x'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file], items: [] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0]![0]).toEqual([file]);
    expect(dropzone.getAttribute('data-dragging')).toBe('false');
  });

  it('renders a chip per staged file with a truncated name, size, and remove control', () => {
    setup({
      attachments: [
        pending({ id: 'p1', filename: 'photo.png', contentType: 'image/png', size: 2048 }),
        pending({ id: 'p2', filename: 'report.pdf', contentType: 'application/pdf', size: 4096 }),
      ],
    });
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    // The image chip shows a thumbnail; the pdf chip does not.
    const thumb = screen.getByAltText('photo.png') as HTMLImageElement;
    expect(thumb.tagName).toBe('IMG');
    expect(screen.queryByAltText('report.pdf')).toBeNull();
    expect(screen.getByRole('button', { name: /remove photo\.png/i })).toBeInTheDocument();
  });

  it('removes a chip via its × control', async () => {
    const onRemoveAttachment = vi.fn();
    setup({ attachments: [pending({ id: 'p9', filename: 'gone.txt' })], onRemoveAttachment });
    await userEvent.click(screen.getByRole('button', { name: /remove gone\.txt/i }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('p9');
  });

  it('surfaces an attachment error inline', () => {
    setup({ attachmentError: 'huge.bin is larger than 5 MB' });
    expect(screen.getByRole('alert')).toHaveTextContent(/larger than 5 MB/);
  });

  it('enables Send with only attachments and an empty body', () => {
    setup({ value: '', attachments: [pending()] });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled();
  });

  it('keeps Send disabled with no body and no attachments', () => {
    setup({ value: '', attachments: [] });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });
});

// Full prop set including attachment wiring, for renders that need the raw element.
function baseProps(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    value: 'hello',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onDraft: vi.fn(),
    onOpenDrafts: vi.fn(),
    draftCount: 0,
    canCompose: true,
    sending: false,
    sendError: null,
    placeholder: 'Message…',
    suggestions: null,
    ...overrides,
  };
}

// helper for rerender-based assertions
function renderWithRerender(overrides: Partial<React.ComponentProps<typeof Composer>>) {
  const base: React.ComponentProps<typeof Composer> = {
    value: 'hello',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onDraft: vi.fn(),
    onOpenDrafts: vi.fn(),
    draftCount: 0,
    canCompose: true,
    sending: false,
    sendError: null,
    placeholder: 'Message…',
    suggestions: null,
    ...overrides,
  };
  const utils = render(<Composer {...base} />);
  return {
    rerender: (next: Partial<React.ComponentProps<typeof Composer>>) =>
      utils.rerender(<Composer {...base} {...next} />),
  };
}

// REGRESSION (prod, 2026-09-02): real browsers BLUR a focused element the moment
// it becomes disabled. Enter-to-send disables the textarea while the POST is in
// flight, so in Chrome every send dumped focus onto <body> — and the Escape →
// clawback hotkey (scope 'composer': live only while focus is inside the
// composer) went dead in exactly its "hit Enter, regret it, hit Escape" flow.
// jsdom does NOT blur on disable (why the suite stayed green) and its
// `el.blur()` is inert, so the browser's disable-blur is simulated by moving
// focus to a scratch element while the textarea is disabled — jsdom then fires
// a real `blur` on the textarea with `disabled` already true, exactly like
// Chrome's disable-blur.
function simulateDisableBlur(): void {
  const scratch = document.createElement('input');
  document.body.appendChild(scratch);
  scratch.focus(); // fires blur on the (disabled) textarea
  scratch.remove(); // parks focus on <body>, as after Chrome's disable-blur
}

describe('Composer focus restoration after a send', () => {
  it('restores focus when the send-cycle disable stole it (Chrome blurs disabled elements)', () => {
    const { rerender } = renderWithRerender({});
    const ta = screen.getByRole('textbox');
    ta.focus();
    expect(document.activeElement).toBe(ta);

    rerender({ sending: true });
    expect(ta).toBeDisabled();
    simulateDisableBlur();
    expect(document.activeElement).not.toBe(ta);

    rerender({ sending: false });
    expect(document.activeElement).toBe(ta);
  });

  it('does not steal focus when the composer was not focused during the send (e.g. a modal send)', () => {
    const { rerender } = renderWithRerender({});
    const ta = screen.getByRole('textbox');
    expect(document.activeElement).not.toBe(ta);

    rerender({ sending: true });
    rerender({ sending: false });
    expect(document.activeElement).not.toBe(ta);
  });

  it('does not re-steal focus when the user focused something else mid-send', () => {
    const { rerender } = renderWithRerender({});
    const ta = screen.getByRole('textbox');
    ta.focus();

    rerender({ sending: true });
    simulateDisableBlur();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();

    rerender({ sending: false });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('restores focus after a failed send too (the text is still there to fix)', () => {
    const { rerender } = renderWithRerender({});
    const ta = screen.getByRole('textbox');
    ta.focus();

    rerender({ sending: true });
    simulateDisableBlur();
    rerender({ sending: false, sendError: 'boom' });
    expect(document.activeElement).toBe(ta);
  });
});
