import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { CapabilitiesResponse, Message, MessageStatus } from '@sparrow/common-types';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { MessageBubble } from './Room.js';

const NOW = Date.parse('2026-08-20T17:10:00Z');

const TTS_ON: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: true },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};
const TTS_OFF: CapabilitiesResponse = { ...TTS_ON, voice: { stt: false, tts: false } };

const OWN: Message = {
  id: 'msg_1',
  from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
  to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }],
  kind: 'broadcast', subject: null, body: 'ship it', attachments: [], suggestedReplies: [],
  inReplyTo: null, replyValue: null, origin: null, createdAt: '2026-08-20T10:05:00Z',
};

/** A receipt with one recipient in the given read state. */
function receipt(status: 'received' | 'read'): MessageStatus {
  return {
    id: 'msg_1', kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z',
    recipients: [{
      id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot',
      status,
      receivedAt: '2026-08-20T10:06:00Z',
      readAt: status === 'read' ? '2026-08-20T10:07:00Z' : null,
    }],
  };
}

function renderBubble(caps: CapabilitiesResponse, r?: MessageStatus) {
  return render(
    <CapabilitiesProvider initial={caps}>
      <MessageBubble roomId="room_1" direction="out" outbox={OWN} receipt={r} nowMs={NOW} />
    </CapabilitiesProvider>,
  );
}

/** The responsive meta/receipt row (stacked on mobile, inline on desktop). */
function metaRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector('[class*="md:flex-row"]') as HTMLElement | null;
  if (!row) throw new Error('meta row not found');
  return row;
}

const DM_OWN: Message = { ...OWN, id: 'msg_dm', kind: 'dm' };

describe('Flat conversation: no directed-message distinction', () => {
  // A room is one flat conversation now — every message reaches the whole room.
  // The "direct" affordance is gone entirely; not even a historical kind:'dm'
  // message renders it.
  it('a historical kind:"dm" bubble shows no "direct" badge', () => {
    render(
      <CapabilitiesProvider initial={TTS_OFF}>
        <MessageBubble roomId="room_1" direction="out" outbox={DM_OWN} nowMs={NOW} />
      </CapabilitiesProvider>,
    );
    expect(screen.queryByText(/^direct$/i)).toBeNull();
  });

  it('a broadcast bubble shows no "direct" badge (still labelled broadcast)', () => {
    render(
      <CapabilitiesProvider initial={TTS_OFF}>
        <MessageBubble roomId="room_1" direction="out" outbox={OWN} nowMs={NOW} />
      </CapabilitiesProvider>,
    );
    expect(screen.queryByText(/^direct$/i)).toBeNull();
    expect(screen.getByText(/^broadcast$/i)).toBeInTheDocument();
  });
});

// The reply echo used to render "You hello qa-bot" — the quoted author ran
// straight into the quoted text with nothing between them, so the line read as
// one garbled sentence. The author now carries a trailing colon separator.
describe('Reply quote', () => {
  const REPLYING: Message = { ...OWN, id: 'msg_2', body: 'sure', inReplyTo: 'msg_1' };
  const quoteFor = () => ({ who: 'You', body: 'hello qa-bot' });

  function renderQuoted() {
    return render(
      <CapabilitiesProvider initial={TTS_OFF}>
        <MessageBubble
          roomId="room_1"
          direction="out"
          outbox={REPLYING}
          quoteFor={quoteFor}
          nowMs={NOW}
        />
      </CapabilitiesProvider>,
    );
  }

  it('separates the quoted author from the quoted text', () => {
    renderQuoted();
    // The author label ends with the separator, so it never merges into the body.
    expect(screen.getByText('You:')).toBeInTheDocument();
    expect(screen.getByText('hello qa-bot')).toBeInTheDocument();
  });

  it('the quote line never reads as one run-together sentence', () => {
    const { container } = renderQuoted();
    const quote = container.querySelector('[class*="border-l-2"]') as HTMLElement;
    // Author and body stay distinct, gapped elements, and the author carries the
    // colon — "You hello qa-bot" can no longer happen.
    expect(quote.className).toContain('gap-1');
    const [author, body] = Array.from(quote.children) as HTMLElement[];
    expect(author!.textContent?.trim()).toBe('You:');
    expect(body!.textContent).toBe('hello qa-bot');
  });
});

describe('Message meta/receipt row', () => {
  it('desktop: the compact speaker icon is the FIRST element of the row, before the delivered label', () => {
    const { container } = renderBubble(TTS_ON, receipt('received'));
    const row = metaRow(container);

    const speaker = within(row).getByRole('button', { name: /play message/i });
    const label = within(row).getByText(/delivered/i);

    // Icon precedes the label in the DOM (left-aligned, first in the row).
    expect(speaker.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the icon is compact + borderless at desktop, but keeps its full 40px prominence on mobile', () => {
    renderBubble(TTS_ON, receipt('received'));
    const speaker = screen.getByRole('button', { name: /play message/i });
    // Mobile prominence preserved (unchanged 40px control)…
    expect(speaker.className).toContain('h-10');
    expect(speaker.className).toContain('w-10');
    // …compact + borderless only at the desktop (md) breakpoint.
    expect(speaker.className).toContain('md:w-4');
    expect(speaker.className).toContain('md:border-0');
  });

  it('mobile keeps its stacked structure (flex-col); desktop reflows inline (md:flex-row)', () => {
    const { container } = renderBubble(TTS_ON, receipt('received'));
    const row = metaRow(container);
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('md:flex-row');
  });

  it('gating preserved: no speaker when TTS is off (receipt still renders)', () => {
    const { container } = renderBubble(TTS_OFF, receipt('received'));
    expect(screen.queryByRole('button', { name: /play message/i })).toBeNull();
    // The delivered label is still present in the row.
    expect(within(metaRow(container)).getByText(/delivered/i)).toBeInTheDocument();
  });

  it('the read state also renders inline after the icon', () => {
    const { container } = renderBubble(TTS_ON, receipt('read'));
    const row = metaRow(container);
    const speaker = within(row).getByRole('button', { name: /play message/i });
    const label = within(row).getByText(/^read/);
    expect(speaker.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
