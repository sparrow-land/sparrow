import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyMessageButton } from './CopyMessageButton.js';

/**
 * The bubble's copy affordance. The contract Jake asked for (2026-09-02):
 * copy the ORIGINAL markdown source, not the rendered text; offer rich HTML
 * alongside it when the platform can carry two flavors; say "Copied" briefly;
 * and never pull focus out of the composer.
 */

/** jsdom's Blob implements neither text() nor arrayBuffer(); FileReader works. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const MARKDOWN = '# Deploy plan\n\n- **step one**\n- step two\n\n`make ship`';

/** Install a fake async clipboard; returns the spies and a restore function. */
function stubClipboard(opts: { write?: boolean } = {}) {
  const writeText = vi.fn(async () => {});
  const write = vi.fn(async (_items: unknown[]) => {});
  const clipboard = opts.write ? { writeText, write } : { writeText };
  Object.defineProperty(navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
    writable: true,
  });
  return { writeText, write };
}

function removeClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** Install a minimal ClipboardItem so the rich path is taken. */
function stubClipboardItem() {
  class ClipboardItemStub {
    constructor(public readonly items: Record<string, Blob>) {}
  }
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = ClipboardItemStub;
  return ClipboardItemStub;
}

afterEach(() => {
  removeClipboard();
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  vi.useRealTimers();
});

describe('CopyMessageButton', () => {
  it('renders an accessible "Copy message" button', () => {
    stubClipboard();
    render(<CopyMessageButton text={MARKDOWN} />);
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });

  it('copies the ORIGINAL markdown source, not the rendered text', async () => {
    const { writeText } = stubClipboard();
    render(<CopyMessageButton text={MARKDOWN} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
  });

  it('flips to "Copied" and reverts after ~1.5s', async () => {
    stubClipboard();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyMessageButton text={MARKDOWN} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('writes text/plain markdown AND text/html when ClipboardItem exists', async () => {
    const { write, writeText } = stubClipboard({ write: true });
    stubClipboardItem();
    render(<CopyMessageButton text={MARKDOWN} getHtml={() => '<p><strong>step one</strong></p>'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0]![0][0] as { items: Record<string, Blob> };
    expect(Object.keys(item.items).sort()).toEqual(['text/html', 'text/plain']);
    // text/plain MUST be the raw markdown — that is the whole point.
    await expect(readBlob(item.items['text/plain']!)).resolves.toBe(MARKDOWN);
    await expect(readBlob(item.items['text/html']!)).resolves.toBe(
      '<p><strong>step one</strong></p>',
    );
  });

  it('falls back to writeText(markdown) when the rich write rejects', async () => {
    const { writeText } = stubClipboard({ write: true });
    (navigator.clipboard.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('nope'),
    );
    stubClipboardItem();
    render(<CopyMessageButton text={MARKDOWN} getHtml={() => '<p>hi</p>'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('renders nothing when the clipboard API is missing', () => {
    removeClipboard();
    const { container } = render(<CopyMessageButton text={MARKDOWN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not crash or claim success when writeText rejects', async () => {
    const { writeText } = stubClipboard();
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<CopyMessageButton text={MARKDOWN} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('never steals focus from the composer', async () => {
    stubClipboard();
    render(
      <>
        <textarea aria-label="composer" />
        <CopyMessageButton text={MARKDOWN} />
      </>,
    );
    const composer = screen.getByLabelText('composer');
    composer.focus();
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(document.activeElement).toBe(composer);
  });
});
