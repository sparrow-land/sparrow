import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * Clawback (SPEC "Clawback", Jake's escape-hatch): Escape in the composer pulls
 * back the caller's MOST RECENT own message while it is still unread by
 * everyone — the bubble leaves the pane and the body lands back in the composer
 * (prepended above any in-progress draft). Every other member's client drops
 * the message live on `message.clawback`, unread badge included.
 */

// Peripheral contexts + the room SSE manager, stubbed as Room.test does. The
// stream handler is captured so tests can push `message.clawback` at the room.
const wsState: { rooms: unknown[] } = { rooms: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
const { streamHandlers, reportBroadcastUnread } = vi.hoisted(() => ({
  streamHandlers: [] as ((ev: unknown) => void)[],
  reportBroadcastUnread: vi.fn(),
}));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread }) }));
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
  createdAt: '2026-08-20T10:00:00Z',
};
const OTHER: Member = {
  id: 'mem_bot',
  kind: 'agent',
  avatarUrl: null,
  principalId: 'agt_bot',
  displayName: 'deploy-bot',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

function ownMessage(over: Partial<Message>): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }],
    kind: 'broadcast',
    subject: null,
    body: 'hi',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-20T10:05:00Z',
    ...over,
  };
}

function inboxItem(over: Partial<InboxItem>): InboxItem {
  return {
    id: 'msg_in',
    from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
    kind: 'broadcast',
    subject: null,
    preview: 'incoming words',
    truncated: false,
    attachmentCount: 0,
    status: 'unread',
    createdAt: '2026-08-20T10:06:00Z',
    ...over,
  } as InboxItem;
}

interface Opts {
  /** The caller's own messages (they ride the room history like everything else). */
  outbox?: Message[];
  inbox?: InboxItem[];
  /** Fail every clawback call with this HTTP status (e.g. 409 once read). */
  clawbackStatus?: number;
}

/** The inbound preview as the room-history route returns it (a full Message). */
function inboundMessage(it: InboxItem): Message {
  return ownMessage({
    id: it.id,
    from: it.from,
    to: [{ id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
    kind: it.kind,
    body: it.preview,
    createdAt: it.createdAt,
  });
}

function stubRoom(opts: Opts = {}) {
  const outbox = opts.outbox ?? [];
  // Room history is newest-first and holds BOTH halves — the caller's own sends
  // and what others sent — which is what the thread renders.
  const history = [...outbox, ...(opts.inbox ?? []).map(inboundMessage)].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  const clawbacks: string[] = [];
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: opts.inbox ?? [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    const claw = url.match(/\/messages\/([^/]+)\/clawback$/);
    if (claw && method === 'POST') {
      const id = claw[1]!;
      clawbacks.push(id);
      if (opts.clawbackStatus) return errorJson('conflict', opts.clawbackStatus);
      const msg = outbox.find((m) => m.id === id);
      if (!msg) return errorJson('not_found', 404);
      return json({ message: msg });
    }
    if (url.includes('/messages/') && url.endsWith('/status')) {
      return json({ id: 'msg_1', kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z', recipients: [] });
    }
    if (url.includes('/messages/') && method === 'GET') {
      return json({
        message: ownMessage({
          id: 'msg_in',
          from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
          body: 'incoming words',
          createdAt: '2026-08-20T10:06:00Z',
        }),
      });
    }
    if (url.endsWith('/messages') && method === 'GET') {
      return json({ items: history, nextBefore: null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
  return { clawbacks };
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

function composerBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Broadcast to everyone/i) as HTMLTextAreaElement;
}

async function pushRoomEvent(ev: unknown) {
  await act(async () => {
    for (const h of [...streamHandlers]) h(ev);
    await Promise.resolve();
  });
}

const clawbackFrame = (messageId: string) => ({
  type: 'message.clawback',
  data: { messageId, by: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }, clawedBackAt: '2026-08-20T10:07:00Z' },
});

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  reportBroadcastUnread.mockClear();
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('Room — Escape claws back the last own message', () => {
  const TWO_SENT = [
    ownMessage({ id: 'msg_a', body: 'first sent', createdAt: '2026-08-20T10:01:00Z' }),
    ownMessage({ id: 'msg_b', body: 'second sent', createdAt: '2026-08-20T10:05:00Z' }),
  ];

  it('removes the bubble and restores the body above the in-progress draft', async () => {
    const stub = stubRoom({ outbox: TWO_SENT });
    renderRoom();
    await screen.findByText('second sent');

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.type(box, 'wip');
    await userEvent.keyboard('{Escape}');

    // The NEWEST own message was clawed, exactly once.
    await waitFor(() => expect(stub.clawbacks).toEqual(['msg_b']));
    // Bubble gone; body prepended above the preserved draft; focus kept.
    await waitFor(() => expect(screen.queryByText('second sent')).toBeNull());
    expect(box.value).toBe('second sent\nwip');
    expect(document.activeElement).toBe(box);
    // The transient, muted note (no persistent artifact).
    expect(await screen.findByText('Message pulled back')).toBeInTheDocument();
  });

  it('a second Escape pulls the previous message; contents stack oldest-first', async () => {
    const stub = stubRoom({ outbox: TWO_SENT });
    renderRoom();
    await screen.findByText('second sent');

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.type(box, 'wip');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(box.value).toBe('second sent\nwip'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(stub.clawbacks).toEqual(['msg_b', 'msg_a']));
    // Each pull PREPENDS: the oldest pulled ends up on top.
    await waitFor(() => expect(box.value).toBe('first sent\nsecond sent\nwip'));
    expect(screen.queryByText('first sent')).toBeNull();
  });

  it('on 409 (already read) the message stays sent and the composer is untouched', async () => {
    const stub = stubRoom({ outbox: TWO_SENT, clawbackStatus: 409 });
    renderRoom();
    await screen.findByText('second sent');

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.type(box, 'wip');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(stub.clawbacks).toEqual(['msg_b']));
    // Nothing further was tried; the pane and draft are exactly as they were.
    expect(stub.clawbacks).toHaveLength(1);
    expect(screen.getByText('second sent')).toBeInTheDocument();
    expect(box.value).toBe('wip');
    expect(screen.queryByText('Message pulled back')).toBeNull();
  });

  it('with no own messages, Escape does nothing — the draft is never cleared', async () => {
    const stub = stubRoom({ outbox: [] });
    renderRoom();
    await screen.findByText(/No broadcasts yet|No one else is here yet/);

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.type(box, 'precious draft');
    await userEvent.keyboard('{Escape}');

    expect(stub.clawbacks).toEqual([]);
    expect(box.value).toBe('precious draft');
  });
});

describe('Room — incoming message.clawback (another member pulled a message)', () => {
  it('drops the bubble live and reports the corrected unread count', async () => {
    stubRoom({
      inbox: [inboxItem({ id: 'msg_in', preview: 'incoming words', status: 'unread' })],
    });
    renderRoom();
    await screen.findByText('incoming words');
    // Boot accounting saw the unread message.
    await waitFor(() =>
      expect(reportBroadcastUnread).toHaveBeenCalledWith('room_abc', 1),
    );

    await pushRoomEvent(clawbackFrame('msg_in'));

    // The message is dead: dropped from the pane…
    await waitFor(() => expect(screen.queryByText('incoming words')).toBeNull());
    // …and the unread badge it contributed to is corrected (no phantom badge).
    expect(reportBroadcastUnread).toHaveBeenLastCalledWith('room_abc', 0);
  });
});
