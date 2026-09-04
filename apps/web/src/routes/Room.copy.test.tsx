import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CapabilitiesResponse, Message } from '@sparrow/common-types';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { MessageBubble } from './Room.js';

/**
 * Every chat bubble — theirs and yours — carries a copy affordance that yields
 * the message's ORIGINAL markdown, so a wall of text does not have to be
 * selected by hand (Jake, 2026-09-02).
 */

const NOW = Date.parse('2026-08-20T17:10:00Z');

const CAPS: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

/** jsdom's Blob implements neither text() nor arrayBuffer(); FileReader works. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const MARKDOWN = '## Findings\n\n- **one**\n- two\n\nSee `docs/ops.md`.';

const INCOMING: Message = {
  id: 'msg_in',
  from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
  to: [{ id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
  kind: 'broadcast',
  subject: null,
  body: MARKDOWN,
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-08-20T10:05:00Z',
};

const OUTGOING: Message = { ...INCOMING, id: 'msg_out', body: 'ship **it**' };

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
});

function renderIncoming() {
  return render(
    <CapabilitiesProvider initial={CAPS}>
      <MessageBubble roomId="room_1" direction="in" full={INCOMING} nowMs={NOW} />
    </CapabilitiesProvider>,
  );
}

describe('Copy button on a chat bubble', () => {
  it('appears on a message from someone else', () => {
    stubClipboard();
    renderIncoming();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });

  it('appears on your own message too', () => {
    stubClipboard();
    render(
      <CapabilitiesProvider initial={CAPS}>
        <MessageBubble roomId="room_1" direction="out" outbox={OUTGOING} nowMs={NOW} />
      </CapabilitiesProvider>,
    );
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });

  it('copies the raw markdown body, not the rendered plain text', async () => {
    const writeText = stubClipboard();
    renderIncoming();
    // The bubble renders markdown, so the visible text has lost the syntax…
    expect(screen.getByText('Findings')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    // …but the clipboard gets the source.
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
  });

  it('confirms with "Copied"', async () => {
    stubClipboard();
    renderIncoming();
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('is absent when the browser has no clipboard API', () => {
    renderIncoming();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('offers the rendered bubble HTML as the rich flavor', async () => {
    const writeText = vi.fn(async () => {});
    const write = vi.fn(async (_items: unknown[]) => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, write },
      configurable: true,
      writable: true,
    });
    class ClipboardItemStub {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = ClipboardItemStub;
    try {
      renderIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
      const item = write.mock.calls[0]![0][0] as { items: Record<string, Blob> };
      await expect(readBlob(item.items['text/plain']!)).resolves.toBe(MARKDOWN);
      const html = await readBlob(item.items['text/html']!);
      expect(html).toContain('<h2');
      expect(html).toContain('<strong>one</strong>');
    } finally {
      delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    }
  });
});
