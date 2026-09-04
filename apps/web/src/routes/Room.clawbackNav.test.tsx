import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * Regression (issue #34): a clawback used to EJECT you from the room and destroy
 * the recovered draft.
 *
 * The chain was: Escape → clawback → the pane re-hydrates → a per-message
 * `GET /rooms/:id/messages/:mid/status` for the now-dead message 404s → that 404
 * hit the room view's blanket `403 || 404` handler, which navigated to the org
 * home. The composer (holding the just-recovered body) went with it.
 *
 * The contract now: a per-message failure is BENIGN — it never navigates — and
 * only a ROOM-level load failure (the room/history/inbox listing itself saying
 * gone/forbidden) sends you back to the org home. 401 still expires the session.
 */

const wsState: { rooms: unknown[]; reloadRooms: ReturnType<typeof vi.fn> } = {
  rooms: [],
  reloadRooms: vi.fn(),
};
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: wsState.reloadRooms }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
const { sessionExpired } = vi.hoisted(() => ({ sessionExpired: vi.fn() }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired }) }));
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
  displayName: 'qa-bot',
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
    to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'qa-bot' }],
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

interface Opts {
  outbox?: Message[];
  inbox?: InboxItem[];
  /** Fail `GET /whoami` with this status (a ROOM-level load failure). */
  whoamiStatus?: number;
  /** Fail every per-message status/read call with this status. */
  perMessageStatus?: number;
}

/**
 * A deliberately STALE server: a clawed-back message keeps coming back in the
 * history listing (the race the bug rode in on) while its per-message status
 * route already 404s. The client must survive that without navigating.
 */
function stubRoom(opts: Opts = {}) {
  const outbox = opts.outbox ?? [];
  const statusCalls: string[] = [];
  const readCalls: string[] = [];
  const clawbacks: string[] = [];
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) {
      if (opts.whoamiStatus) return errorJson('not_found', opts.whoamiStatus);
      return json(SELF);
    }
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: opts.inbox ?? [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    const claw = url.match(/\/messages\/([^/]+)\/clawback$/);
    if (claw && method === 'POST') {
      const id = claw[1]!;
      clawbacks.push(id);
      const msg = outbox.find((m) => m.id === id);
      if (!msg) return errorJson('not_found', 404);
      return json({ message: msg });
    }
    const st = url.match(/\/messages\/([^/]+)\/status$/);
    if (st) {
      statusCalls.push(st[1]!);
      if (opts.perMessageStatus) return errorJson('not_found', opts.perMessageStatus);
      return json({ id: st[1]!, kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z', recipients: [] });
    }
    // `readMessage` is a plain GET of the message (marks read unless `peek`).
    const read = url.match(/\/messages\/([^/]+)$/);
    if (read && method === 'GET') {
      readCalls.push(read[1]!);
      if (opts.perMessageStatus) return errorJson('not_found', opts.perMessageStatus);
      return json({ message: ownMessage({ id: read[1]! }) });
    }
    if (url.endsWith('/messages') && method === 'GET') {
      // Never drops the clawed message — the stale listing the fix must tolerate.
      const history = [...outbox].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json({ items: history, nextBefore: null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
  return { statusCalls, readCalls, clawbacks };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

function renderRoom() {
  render(
    <MemoryRouter initialEntries={['/rooms/abc']}>
      <CapabilitiesProvider>
        <LocationProbe />
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
          <Route path="/org/1" element={<div>ORG HOME</div>} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

function path(): string {
  return screen.getByTestId('path').textContent ?? '';
}

function composerBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Broadcast to everyone/i) as HTMLTextAreaElement;
}

async function pushRoomEvent(ev: unknown) {
  await act(async () => {
    for (const h of [...streamHandlers]) h(ev);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const clawbackFrame = (messageId: string) => ({
  type: 'message.clawback',
  data: {
    messageId,
    by: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    clawedBackAt: '2026-08-20T10:07:00Z',
  },
});

const TWO_SENT = [
  ownMessage({ id: 'msg_a', body: 'first sent', createdAt: '2026-08-20T10:01:00Z' }),
  ownMessage({ id: 'msg_b', body: 'second sent', createdAt: '2026-08-20T10:05:00Z' }),
];

beforeEach(() => {
  wsState.rooms = [];
  wsState.reloadRooms = vi.fn();
  streamHandlers.length = 0;
  reportBroadcastUnread.mockClear();
  sessionExpired.mockClear();
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('Room — a per-message failure never ejects you from the room', () => {
  it('a 404 on a single message status leaves you in the room', async () => {
    stubRoom({ outbox: TWO_SENT, perMessageStatus: 404 });
    renderRoom();
    await screen.findByText('second sent');

    // The per-message status calls have had every chance to blow up by now.
    await act(async () => {
      await Promise.resolve();
    });
    expect(path()).toBe('/rooms/abc');
    expect(screen.queryByText('ORG HOME')).toBeNull();
    expect(wsState.reloadRooms).not.toHaveBeenCalled();
  });

  it('clawback keeps the recovered body in the composer and stays in the room', async () => {
    const stub = stubRoom({ outbox: TWO_SENT, perMessageStatus: 404 });
    renderRoom();
    await screen.findByText('second sent');

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.type(box, 'wip');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(stub.clawbacks).toEqual(['msg_b']));
    // Still in the room, with the recovered text intact above the draft.
    expect(path()).toBe('/rooms/abc');
    expect(composerBox().value).toBe('second sent\nwip');

    // The server's own clawback frame, then a fresh message event that
    // re-hydrates against a STALE listing still holding the dead message.
    await pushRoomEvent(clawbackFrame('msg_b'));
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_a' } });

    await waitFor(() => expect(path()).toBe('/rooms/abc'));
    expect(composerBox().value).toBe('second sent\nwip');
  });

  it('never re-fetches status for a clawed-back message', async () => {
    const stub = stubRoom({ outbox: TWO_SENT });
    renderRoom();
    await screen.findByText('second sent');

    const box = composerBox();
    await userEvent.click(box);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(stub.clawbacks).toEqual(['msg_b']));

    stub.statusCalls.length = 0;
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_a' } });

    await waitFor(() => expect(stub.statusCalls).toContain('msg_a'));
    expect(stub.statusCalls).not.toContain('msg_b');
    // …and the dead bubble does not come back with the stale listing (the body
    // is still in the composer, which is why the textarea is ignored here).
    expect(screen.queryByText('second sent', { ignore: 'script, style, textarea' })).toBeNull();
  });
});

describe('Room — room-level failures still redirect', () => {
  it('a 404 on the room load itself goes to the org home and resyncs', async () => {
    stubRoom({ outbox: TWO_SENT, whoamiStatus: 404 });
    renderRoom();

    await waitFor(() => expect(path()).toBe('/org/1'));
    expect(screen.getByText('ORG HOME')).toBeInTheDocument();
    expect(wsState.reloadRooms).toHaveBeenCalled();
  });

  it('a 401 anywhere still expires the session and goes to /login', async () => {
    stubRoom({ outbox: TWO_SENT, whoamiStatus: 401 });
    renderRoom();

    await waitFor(() => expect(path()).toBe('/login'));
    expect(sessionExpired).toHaveBeenCalled();
  });
});
