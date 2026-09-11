import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * REVERSE PAGING. A room used to open by listing 100 messages and, on every
 * refetch (reconcile, `message.new`, the re-list after a send), REPLACING the
 * pane's history with a fresh page of 100. Two things follow from that: opening
 * a busy room costs a 100-message page nobody reads, and there is no way to see
 * anything older than the newest page at all.
 *
 * The pane now opens on the newest 50 and walks backwards a page at a time as
 * the reader scrolls up, and every refetch MERGES into what is loaded instead of
 * replacing it.
 */
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: [], agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread: vi.fn() }) }));
const { streamHandlers } = vi.hoisted(() => ({ streamHandlers: [] as ((ev: unknown) => void)[] }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: {
    subscribe: (_roomId: string, cb: (ev: unknown) => void) => {
      streamHandlers.push(cb);
      return () => {};
    },
  },
}));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room, distanceFromOldestEdge } from './Room.js';

const SELF: Member = {
  id: 'mem_self',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_self',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-12T09:00:00Z',
};
const OTHER: Member = {
  id: 'mem_bot',
  kind: 'agent',
  avatarUrl: null,
  principalId: 'agt_bot',
  displayName: 'deploy-bot',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-08-12T09:00:00Z',
};
const ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

const BASE = Date.parse('2026-08-12T10:00:00Z');

/** `n` inbound broadcasts, a minute apart, NEWEST-FIRST (as the server lists). */
function room(n: number): Message[] {
  const items: Message[] = [];
  for (let i = 1; i <= n; i += 1) {
    items.push({
      id: `msg_${String(i).padStart(3, '0')}`,
      from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
      to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
      kind: 'broadcast',
      subject: null,
      body: `message ${String(i).padStart(3, '0')}`,
      attachments: [],
      suggestedReplies: [],
      inReplyTo: null,
      replyValue: null,
      origin: null,
      createdAt: new Date(BASE + i * 60_000).toISOString(),
    });
  }
  return items.reverse();
}

const server: { history: Message[]; inbox: InboxItem[]; stt: boolean } = {
  history: [],
  inbox: [],
  stt: false,
};
let calls: string[] = [];

/** Every `GET /rooms/:id/messages` listing, with its query. */
function listCalls(): string[] {
  return calls.filter((u) => /\/messages(\?|$)/.test(u));
}
/** Every per-message read (`GET /rooms/:id/messages/:id`) — a read-marking call. */
function readCalls(): string[] {
  return calls.filter((u) => /\/messages\/[^/?]+(\?|$)/.test(u));
}
function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '');
}

/**
 * The paged history route, honouring `limit` and the `before` message-id cursor
 * exactly as the API does: newest-first, `before` EXCLUSIVE, and `nextBefore`
 * set to the oldest item returned whenever more remain.
 */
function stubRoom() {
  calls = [];
  useFetch(async (input, init) => {
    const full = String(input);
    calls.push(full);
    const url = full.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) {
      return json({ voice: { stt: server.stt, tts: false, sttStreaming: false } });
    }
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: server.inbox, nextCursor: null });
    // Receipts hydrate for a whole screen at once (`GET …/messages/status?ids=`);
    // answered before the per-message route whose prefix it shares.
    if (url.endsWith('/messages/status')) {
      const asked = (new URLSearchParams(full.split('?')[1] ?? '').get('ids') ?? '')
        .split(',')
        .filter((id) => id.length > 0);
      return json({ items: asked.map((id) => ({ messageId: id, status: { id, kind: 'broadcast', createdAt: '2026-08-12T10:00:00Z', recipients: [] } })) });
    }
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json({ id: url.split('/').at(-2), kind: 'broadcast', createdAt: '2026-08-12T10:00:00Z', recipients: [] });
    }
    if (/\/messages\/[^/]+$/.test(url) && method === 'GET') {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const msg = server.history.find((m) => m.id === id);
      return msg ? json({ message: msg }) : errorJson('not_found', 404);
    }
    if (url.endsWith('/messages') && method === 'GET') {
      const q = queryOf(full);
      const limit = Number(q.get('limit') ?? 50);
      const before = q.get('before');
      const start = before ? server.history.findIndex((m) => m.id === before) + 1 : 0;
      const page = server.history.slice(start, start + limit);
      const more = server.history.length > start + limit;
      return json({ items: page, nextBefore: more && page.length > 0 ? page[page.length - 1]!.id : null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/rooms/abc']}>
      <CapabilitiesProvider>
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

/** The scrollable conversation pane (`flex-col-reverse`). */
function pane(): HTMLElement {
  return screen.getByTestId('message-pane');
}

/**
 * Scroll to the OLDEST edge. jsdom has no layout — `scrollHeight`/`clientHeight`
 * are both 0 — so the pane reports its oldest edge as already visible and the
 * event alone is the "reader reached the top" signal the component reacts to.
 */
function scrollToOldest() {
  fireEvent.scroll(pane());
}

beforeEach(() => {
  streamHandlers.length = 0;
  server.history = room(120);
  server.inbox = [];
  server.stt = false;
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
  });
});
afterEach(() => {
  restoreFetch();
  vi.unstubAllGlobals();
});

describe('distanceFromOldestEdge', () => {
  it('measures from the oldest edge with the modern NEGATIVE column-reverse scrollTop', () => {
    // 0 is the newest end (where the pane rests); -(scrollHeight - clientHeight)
    // is the oldest.
    expect(distanceFromOldestEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(600);
    expect(distanceFromOldestEdge({ scrollTop: -600, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
    expect(distanceFromOldestEdge({ scrollTop: -560, scrollHeight: 1000, clientHeight: 400 })).toBe(40);
  });

  it('measures the same way under the legacy POSITIVE convention', () => {
    expect(distanceFromOldestEdge({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(600);
    expect(distanceFromOldestEdge({ scrollTop: 30, scrollHeight: 1000, clientHeight: 400 })).toBe(30);
  });

  it('calls the oldest edge visible when nothing overflows', () => {
    expect(distanceFromOldestEdge({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(0);
  });
});

describe('Room opens on the newest page', () => {
  it('lists the tail of 50, not the whole room', async () => {
    stubRoom();
    renderRoom();

    await screen.findByText('message 120');
    expect(queryOf(listCalls()[0]!).get('limit')).toBe('50');
    expect(queryOf(listCalls()[0]!).get('before')).toBeNull();
    // The 50 newest are on screen; message 070 is the 51st back and is not.
    expect(screen.getByText('message 071')).toBeInTheDocument();
    expect(screen.queryByText('message 070')).toBeNull();
  });
});

describe('Room loads earlier messages as the reader scrolls up', () => {
  it('fetches the previous page with `before` and PREPENDS it above the loaded tail', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');
    expect(listCalls()).toHaveLength(1);

    scrollToOldest();

    await screen.findByText('message 070');
    const older = listCalls()[1]!;
    // The cursor is the listing's `nextBefore` — the oldest item we hold.
    expect(queryOf(older).get('before')).toBe('msg_071');
    expect(queryOf(older).get('limit')).toBe('50');
    // The older page renders ABOVE the tail, and the tail is still there.
    expect(screen.getByText('message 021')).toBeInTheDocument();
    expect(screen.getByText('message 120')).toBeInTheDocument();
    const first = screen.getByText('message 021');
    const mid = screen.getByText('message 071');
    expect(first.compareDocumentPosition(mid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('walks back page by page until the beginning, then stops fetching', async () => {
    server.history = room(60);
    stubRoom();
    renderRoom();
    await screen.findByText('message 060');

    scrollToOldest();
    await screen.findByText('message 001');
    expect(listCalls()).toHaveLength(2);

    // `nextBefore` came back null: the room's beginning is loaded and further
    // scrolling must never ask again.
    scrollToOldest();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listCalls()).toHaveLength(2);
  });

  it('never asks for an older page when the first listing already reached the beginning', async () => {
    server.history = room(10);
    stubRoom();
    renderRoom();
    await screen.findByText('message 001');
    expect(listCalls()).toHaveLength(1);

    scrollToOldest();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listCalls()).toHaveLength(1);
  });

  it('never fires overlapping page fetches', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');

    scrollToOldest();
    scrollToOldest();
    scrollToOldest();

    await screen.findByText('message 070');
    expect(listCalls()).toHaveLength(2);
  });

  it('shows an unobtrusive indicator while a page is in flight', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');
    expect(screen.queryByTestId('loading-earlier')).toBeNull();

    scrollToOldest();
    expect(screen.getByTestId('loading-earlier')).toHaveTextContent(/loading earlier messages/i);

    await screen.findByText('message 070');
    await waitFor(() => expect(screen.queryByTestId('loading-earlier')).toBeNull());
  });

  it('is BACKFILL: an older page never announces, and never marks anything read', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');
    const readsBefore = readCalls().length;

    scrollToOldest();
    await screen.findByText('message 070');

    expect(screen.getByTestId('message-announcer')).toHaveTextContent('');
    expect(readCalls().length).toBe(readsBefore);
  });

  it('is BACKFILL for hands-free mode too: an older page is never spoken', async () => {
    server.stt = true;
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');

    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    await screen.findByRole('dialog', { name: /hands-free/i });

    scrollToOldest();
    await screen.findByText('message 070');

    // 50 backlog messages would otherwise be queued up to be read aloud.
    expect(screen.queryByTestId('hands-free-last-reply')).toBeNull();
  });

  it('a later reconcile does not read an already-loaded older page aloud either', async () => {
    // The reconcile hands hands-free mode the MERGED history (a reply the stream
    // was down for is exactly what it waits on) — so an older page that joined
    // that set after the mode opened must already count as seen, or waking the
    // tab would start narrating the room's backlog.
    server.stt = true;
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');

    await userEvent.click(await screen.findByRole('button', { name: /hands-free/i }));
    await screen.findByRole('dialog', { name: /hands-free/i });
    scrollToOldest();
    await screen.findByText('message 070');

    act(() => {
      for (const h of [...streamHandlers]) h({ type: 'sync' });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('hands-free-last-reply')).toBeNull();
  });
});

describe('Room refetches MERGE into the loaded history', () => {
  /** Load the tail plus one older page. */
  async function withOlderPageLoaded() {
    stubRoom();
    renderRoom();
    await screen.findByText('message 120');
    scrollToOldest();
    await screen.findByText('message 070');
  }

  it('a reconcile keeps the older pages and folds in what arrived', async () => {
    await withOlderPageLoaded();

    server.history = [...room(121).slice(0, 1), ...server.history];
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await screen.findByText('message 121');
    // The older page the reader scrolled back for survives the refetch.
    expect(screen.getByText('message 021')).toBeInTheDocument();
    expect(screen.getAllByText('message 120')).toHaveLength(1);
  });

  it('takes the tail\'s version of a message it already holds', async () => {
    await withOlderPageLoaded();

    server.history = server.history.map((m) =>
      m.id === 'msg_120' ? { ...m, body: 'message 120 (edited)' } : m,
    );
    act(() => {
      for (const h of [...streamHandlers]) h({ type: 'sync' });
    });

    await screen.findByText('message 120 (edited)');
    expect(screen.getByText('message 021')).toBeInTheDocument();
  });

  it('drops a clawed-back message the refetched tail no longer carries', async () => {
    await withOlderPageLoaded();

    server.history = server.history.filter((m) => m.id !== 'msg_119');
    act(() => {
      for (const h of [...streamHandlers]) h({ type: 'sync' });
    });

    await waitFor(() => expect(screen.queryByText('message 119')).toBeNull());
    // Only the clawed one goes: its neighbours and the older page stay.
    expect(screen.getByText('message 120')).toBeInTheDocument();
    expect(screen.getByText('message 021')).toBeInTheDocument();
  });
});

describe('Switching rooms starts over', () => {
  it('a remount opens on a fresh tail with no older pages carried over', async () => {
    stubRoom();
    const view = renderRoom();
    await screen.findByText('message 120');
    scrollToOldest();
    await screen.findByText('message 070');

    view.unmount();
    cleanup();
    calls = [];
    renderRoom();

    await screen.findByText('message 120');
    // A fresh tail, and nothing from the previous room's older pages.
    expect(queryOf(listCalls()[0]!).get('before')).toBeNull();
    expect(queryOf(listCalls()[0]!).get('limit')).toBe('50');
    expect(screen.queryByText('message 070')).toBeNull();
  });
});
