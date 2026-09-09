import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MESSAGE_STATUS_IDS_MAX } from '@sparrow/common-types';
import type { Member, Message, ReadStatus, Room as RoomResource } from '@sparrow/common-types';

/**
 * BULK RECEIPTS. Rendering a screen of your own messages used to cost one
 * `GET …/messages/:id/status` per bubble — 50 requests to open a room you had
 * been talking in, and one more burst per reconcile, per new message, and per
 * send. The pane now hydrates the whole screen through ONE
 * `GET …/messages/status?ids=` (chunked at the route's cap when the reader has
 * scrolled back far enough to hold more).
 *
 * The single-message route keeps exactly one caller: the `message.received` /
 * `message.read` delivery events, where one message genuinely IS the subject.
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
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room } from './Room.js';

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

/**
 * `n` messages a minute apart, NEWEST-FIRST. `mine` decides which are the
 * caller's own — those are the ones that carry a receipt.
 */
function room(n: number, mine: (i: number) => boolean): Message[] {
  const items: Message[] = [];
  for (let i = 1; i <= n; i += 1) {
    const own = mine(i);
    items.push({
      id: `msg_${String(i).padStart(3, '0')}`,
      from: own
        ? { id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }
        : { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
      to: own
        ? [{ id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }]
        : [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
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

/** The single-route payload the bulk entries carry verbatim. */
function statusOf(id: string, phase: ReadStatus) {
  return {
    id,
    kind: 'broadcast',
    createdAt: '2026-08-12T10:05:00Z',
    recipients: [
      {
        id: OTHER.id,
        kind: 'agent',
        avatarUrl: null,
        displayName: 'deploy-bot',
        status: phase,
        receivedAt: phase === 'received' || phase === 'read' ? '2026-08-12T10:06:00Z' : null,
        readAt: phase === 'read' ? '2026-08-12T10:07:00Z' : null,
      },
    ],
  };
}

const server: {
  history: Message[];
  phase: ReadStatus;
  /** Ids the bulk route pretends it cannot see (absent from `items`). */
  hidden: Set<string>;
  bulkStatus: number;
} = { history: [], phase: 'read', hidden: new Set(), bulkStatus: 200 };

let calls: string[] = [];
/** Every BULK receipts lookup, with its query. */
function bulkCalls(): string[] {
  return calls.filter((u) => /\/messages\/status(\?|$)/.test(u));
}
/** Every PER-MESSAGE receipts lookup — the thing this replaces. */
function perMessageCalls(): string[] {
  return calls.filter((u) => /\/messages\/[^/?]+\/status(\?|$)/.test(u));
}
function idsOf(url: string): string[] {
  const raw = new URLSearchParams(url.split('?')[1] ?? '').get('ids') ?? '';
  return raw.split(',').filter((s) => s.length > 0);
}

function stubRoom() {
  calls = [];
  useFetch(async (input, init) => {
    const full = String(input);
    calls.push(full);
    const url = full.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    // BULK receipts — checked before the per-message route it shadows.
    if (url.endsWith('/messages/status')) {
      if (server.bulkStatus !== 200) return errorJson('internal', server.bulkStatus);
      const ids = idsOf(full).filter((id) => !server.hidden.has(id));
      return json({ items: ids.map((id) => ({ messageId: id, status: statusOf(id, server.phase) })) });
    }
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json(statusOf(url.split('/').at(-2)!, server.phase));
    }
    if (/\/messages\/[^/]+$/.test(url) && method === 'GET') {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const msg = server.history.find((m) => m.id === id);
      return msg ? json({ message: msg }) : errorJson('not_found', 404);
    }
    if (url.endsWith('/messages') && method === 'GET') {
      const q = new URLSearchParams(full.split('?')[1] ?? '');
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
  render(
    <MemoryRouter initialEntries={['/rooms/abc']}>
      <CapabilitiesProvider>
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

function scrollToOldest() {
  fireEvent.scroll(screen.getByTestId('message-pane'));
}
function fireSync() {
  act(() => {
    for (const h of [...streamHandlers]) h({ type: 'sync' });
  });
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  streamHandlers.length = 0;
  server.history = room(50, (i) => i % 2 === 1);
  server.phase = 'read';
  server.hidden = new Set();
  server.bulkStatus = 200;
});
afterEach(() => restoreFetch());

describe('Room hydrates receipts in one request', () => {
  it('opens with ONE bulk lookup carrying exactly the own-message ids, in thread order', async () => {
    stubRoom();
    renderRoom();

    await screen.findByText('message 050');
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    // 25 own messages on screen — formerly 25 separate requests.
    const asked = idsOf(bulkCalls()[0]!);
    const own = [...server.history].reverse().filter((m) => m.from.id === SELF.id).map((m) => m.id);
    expect(own).toHaveLength(25);
    expect(asked).toEqual(own);
    expect(perMessageCalls()).toEqual([]);

    // And the receipts actually land.
    await waitFor(() => expect(screen.getAllByText(/^read/).length).toBe(25));
  });

  it('never asks about a message that is not the caller\'s own', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('message 050');
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));

    expect(idsOf(bulkCalls()[0]!).some((id) => id === 'msg_002')).toBe(false);
  });

  it('a reconcile over two older pages is still ONE request, never one per bubble', async () => {
    server.history = room(150, (i) => i % 2 === 1);
    stubRoom();
    renderRoom();
    await screen.findByText('message 150');

    scrollToOldest();
    await screen.findByText('message 100');
    scrollToOldest();
    await screen.findByText('message 050');
    const before = bulkCalls().length;

    fireSync();
    await waitFor(() => expect(bulkCalls().length).toBe(before + 1));
    await settle();
    // 75 own messages across three loaded pages, one request.
    expect(idsOf(bulkCalls().at(-1)!)).toHaveLength(75);
    expect(perMessageCalls()).toEqual([]);
  });

  it('chunks at the route cap once more ids are loaded than one call may carry', async () => {
    // Five pages of own messages: 250 ids, which the route caps at 200 per call.
    server.history = room(250, () => true);
    stubRoom();
    renderRoom();
    await screen.findByText('message 250');
    for (const oldest of ['message 200', 'message 150', 'message 100', 'message 050']) {
      scrollToOldest();
      await screen.findByText(oldest);
    }
    const before = bulkCalls().length;

    fireSync();
    await waitFor(() => expect(bulkCalls().length).toBe(before + 2));
    await settle();
    const [first, second] = bulkCalls().slice(-2);
    expect(idsOf(first!)).toHaveLength(MESSAGE_STATUS_IDS_MAX);
    expect(idsOf(second!)).toHaveLength(250 - MESSAGE_STATUS_IDS_MAX);
    expect(perMessageCalls()).toEqual([]);
  });

  it('leaves a receipt alone when its id is ABSENT from the response', async () => {
    server.history = room(2, (i) => i === 1);
    stubRoom();
    renderRoom();

    // msg_001 is the caller's own, and the server says it was read.
    await waitFor(() => expect(screen.getByText(/^read/)).toBeInTheDocument());

    // The next lookup no longer carries it (clawed, or no longer visible).
    // Absence is not "no receipt": what we already knew stands.
    server.hidden = new Set(['msg_001']);
    fireSync();
    await settle();
    expect(screen.getByText(/^read/)).toBeInTheDocument();
  });

  it('survives a bulk lookup that fails — the room renders and stays usable', async () => {
    server.bulkStatus = 500;
    stubRoom();
    renderRoom();

    await screen.findByText('message 050');
    await waitFor(() => expect(bulkCalls().length).toBeGreaterThan(0));
    await settle();
    // No receipts, but the conversation and composer are entirely unaffected.
    expect(screen.queryByText(/^read/)).toBeNull();
    expect(screen.getByText('message 049')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  });

  it('keeps the single-message route for a live delivery event about ONE message', async () => {
    server.history = room(2, (i) => i === 1);
    server.phase = 'unread';
    stubRoom();
    renderRoom();
    await screen.findByText('message 001');
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    expect(perMessageCalls()).toEqual([]);

    // A `message.read` names exactly one message: asking about that one is the
    // right shape, and the bulk lookup must not be dragged in for it.
    server.phase = 'read';
    act(() => {
      for (const h of [...streamHandlers]) {
        h({ type: 'message.read', data: { messageId: 'msg_001', by: OTHER, readAt: '2026-08-12T10:07:00Z' } });
      }
    });

    await waitFor(() => expect(screen.getByText(/^read/)).toBeInTheDocument());
    expect(perMessageCalls()).toHaveLength(1);
    expect(perMessageCalls()[0]).toContain('/messages/msg_001/status');
    expect(bulkCalls()).toHaveLength(1);
  });
});
