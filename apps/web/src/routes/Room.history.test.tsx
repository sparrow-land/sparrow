import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: [], agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
const reportBroadcastUnread = vi.fn();
vi.mock('../components/AppShell.js', () => ({
  useShell: () => ({ reportBroadcastUnread }),
}));
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
  id: 'mem_late',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_late',
  displayName: 'Robin',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-09-03T12:00:00Z',
};
const OWNER: Member = {
  id: 'mem_owner',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_owner',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-09-03T10:00:00Z',
};
const ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

function message(over: Partial<Message>): Message {
  return {
    id: 'msg_x',
    from: { id: OWNER.id, kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Robin' }],
    kind: 'broadcast',
    subject: null,
    body: 'body',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-09-03T10:05:00Z',
    ...over,
  };
}

/** Five pre-join broadcasts from the owner — the room's history before Robin joined. */
const PRE_JOIN: Message[] = [
  message({ id: 'msg_1', body: 'first broadcast', createdAt: '2026-09-03T10:01:00Z' }),
  message({ id: 'msg_2', body: 'second broadcast', createdAt: '2026-09-03T10:02:00Z' }),
  message({ id: 'msg_3', body: 'third broadcast', createdAt: '2026-09-03T10:03:00Z' }),
  message({ id: 'msg_4', body: 'fourth broadcast', createdAt: '2026-09-03T10:04:00Z' }),
  message({ id: 'msg_5', body: 'fifth broadcast', createdAt: '2026-09-03T10:05:00Z' }),
];

interface Opts {
  /** Room history, newest-first (as the server returns it). */
  history?: Message[];
  /** Delivery rows the caller actually has (the inbox is unread-only). */
  inbox?: InboxItem[];
  recipients?: { id: string; kind: 'human' | 'agent'; displayName: string; status: string; receivedAt: string | null; readAt: string | null }[];
}

let calls: string[] = [];
const server: { history: Message[]; inbox: InboxItem[] } = { history: [], inbox: [] };

function stubRoom(opts: Opts = {}) {
  calls = [];
  server.history = opts.history ?? [...PRE_JOIN].reverse();
  server.inbox = opts.inbox ?? [];
  useFetch(async (input, init) => {
    const full = String(input);
    calls.push(full);
    const url = full.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OWNER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: server.inbox, nextCursor: null });
    if (url.includes('/outbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json({
        id: url.split('/').at(-2),
        kind: 'broadcast',
        createdAt: '2026-09-03T10:05:00Z',
        recipients: opts.recipients ?? [],
      });
    }
    if (url.includes('/messages/') && method === 'GET') {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const msg = server.history.find((m) => m.id === id);
      return msg ? json({ message: msg }) : errorJson('not_found', 404);
    }
    if (url.endsWith('/messages') && method === 'GET') {
      return json({ items: server.history, nextBefore: null });
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

/** Every per-message read GET (`/messages/:id`), query preserved. */
function readCalls(): string[] {
  return calls.filter((u) => /\/messages\/[^/]+$/.test(u.split('?')[0]!));
}

beforeEach(() => {
  streamHandlers.length = 0;
  reportBroadcastUnread.mockClear();
});
afterEach(() => restoreFetch());

describe('Room thread reads the room history route (late joiner, QA S9 step 6)', () => {
  it('renders every pre-join message for a member with NO delivery rows', async () => {
    // The reported bug: a human added to a project room after the conversation
    // started saw the empty state forever, because the thread was assembled from
    // the per-member delivery rows (inbox + outbox) — which a late joiner has
    // none of. `GET /rooms/:id/messages` is the room-scoped history route: any
    // current member reads EVERY message, including ones sent before they joined.
    stubRoom();
    renderRoom();

    await screen.findByText('first broadcast');
    for (const body of ['second broadcast', 'third broadcast', 'fourth broadcast', 'fifth broadcast']) {
      expect(screen.getByText(body)).toBeInTheDocument();
    }
    // The empty state must be gone.
    expect(screen.queryByText(/No broadcasts yet/i)).toBeNull();

    // Oldest-first in the DOM (the transcript order).
    const nodes = ['first', 'second', 'third', 'fourth', 'fifth'].map((w) =>
      screen.getByText(`${w} broadcast`),
    );
    for (let i = 1; i < nodes.length; i += 1) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('history is a PEEK: pre-join messages are never marked read, and no unread is reported', async () => {
    stubRoom();
    renderRoom();

    await screen.findByText('fifth broadcast');
    // No per-message read fetch at all: the history route already carried the
    // bodies, and marking a pre-join message read would write delivery state the
    // caller does not even have (SPEC: listing is a peek).
    expect(readCalls()).toEqual([]);
    await waitFor(() => expect(reportBroadcastUnread).toHaveBeenCalledWith('room_abc', 0));
  });

  it('still marks a genuinely unread message read (the sender receipt must advance)', async () => {
    const unread: InboxItem = {
      id: 'msg_5',
      from: { id: OWNER.id, kind: 'human', avatarUrl: null, displayName: 'Jake' },
      kind: 'broadcast',
      subject: null,
      preview: 'fifth broadcast',
      truncated: false,
      attachmentCount: 0,
      status: 'unread',
      createdAt: '2026-09-03T10:05:00Z',
    };
    stubRoom({ inbox: [unread] });
    renderRoom();

    await screen.findByText('fifth broadcast');
    await waitFor(() => expect(readCalls().length).toBeGreaterThan(0));
    const read = readCalls().find((u) => u.includes('/messages/msg_5'));
    expect(read).toBeDefined();
    expect(read).not.toContain('peek=true');
    // Only the unread one is touched; the four already-delivered-free ones are not.
    expect(readCalls().filter((u) => !u.includes('msg_5'))).toEqual([]);
  });

  it('shows a receipt on the caller\'s OWN messages, sourced from message status', async () => {
    const own = message({
      id: 'msg_own',
      from: { id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Robin' },
      to: [{ id: OWNER.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
      body: 'my own words',
      createdAt: '2026-09-03T10:06:00Z',
    });
    stubRoom({
      history: [own, ...[...PRE_JOIN].reverse()],
      recipients: [
        {
          id: OWNER.id,
          kind: 'human',
          displayName: 'Jake',
          status: 'read',
          receivedAt: '2026-09-03T10:07:00Z',
          readAt: '2026-09-03T10:08:00Z',
        },
      ],
    });
    renderRoom();

    await screen.findByText('my own words');
    await waitFor(() => expect(screen.getByText(/^read/)).toBeInTheDocument());
  });

  it('appends a live message.new to the history-sourced thread', async () => {
    stubRoom();
    renderRoom();
    await screen.findByText('fifth broadcast');

    server.history = [
      message({ id: 'msg_6', body: 'sixth broadcast', createdAt: '2026-09-03T10:09:00Z' }),
      ...server.history,
    ];
    await act(async () => {
      for (const h of [...streamHandlers]) h({ type: 'message.new', data: { messageId: 'msg_6', kind: 'broadcast', from: OWNER } });
      await Promise.resolve();
    });

    await screen.findByText('sixth broadcast');
    expect(screen.getAllByText('fifth broadcast')).toHaveLength(1);
  });
});
