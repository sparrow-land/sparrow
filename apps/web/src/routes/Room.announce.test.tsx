import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * Screen-reader announcements for arriving messages (issue #39). A sighted user
 * sees the bubble land; a screen-reader user got nothing at all — the app had no
 * live region anywhere. The room now carries ONE visually-hidden polite
 * announcer, and it speaks only for genuinely NEW inbound arrivals:
 *   - silent on the initial history load and on wake/reconnect reconciles
 *     (nothing "arrived" — the view is just catching up);
 *   - silent for the caller's own sends (they know: they pressed Enter);
 *   - "<sender>: <preview>" for an inbound message that lands while mounted.
 */

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
import { Room, announcePreview, ANNOUNCE_PREVIEW_CHARS } from './Room.js';

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
const BOT: Member = {
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

function message(over: Partial<Message>): Message {
  return {
    id: 'msg_1',
    from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'qa-bot' },
    to: [{ id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
    kind: 'broadcast',
    subject: null,
    body: 'hello',
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: '2026-08-20T10:05:00Z',
    ...over,
  };
}
const own = (over: Partial<Message>) =>
  message({
    from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
    to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'qa-bot' }],
    ...over,
  });

/** A mutable server: tests push messages into `history` then fire a stream event. */
function stubRoom(initial: Message[], inbox: InboxItem[] = []) {
  const state = { history: [...initial], inbox: [...inbox] };
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, BOT], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: state.inbox, nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    const st = url.match(/\/messages\/([^/]+)\/status$/);
    if (st) {
      return json({ id: st[1]!, kind: 'broadcast', createdAt: '2026-08-20T10:05:00Z', recipients: [] });
    }
    const one = url.match(/\/messages\/([^/]+)$/);
    if (one && method === 'GET') {
      const found = state.history.find((m) => m.id === one[1]!);
      return found ? json({ message: found }) : errorJson('not_found', 404);
    }
    if (url.endsWith('/messages') && method === 'GET') {
      const items = [...state.history].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json({ items, nextBefore: null });
    }
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
  return state;
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

function announcer(): HTMLElement {
  return screen.getByTestId('message-announcer');
}

async function pushRoomEvent(ev: unknown) {
  await act(async () => {
    for (const h of [...streamHandlers]) h(ev);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  reportBroadcastUnread.mockClear();
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('announcePreview', () => {
  it('flattens whitespace and truncates long bodies', () => {
    expect(announcePreview('  hello\n\n  world ')).toBe('hello world');
    const long = 'x'.repeat(ANNOUNCE_PREVIEW_CHARS + 50);
    const out = announcePreview(long);
    expect(out.length).toBeLessThanOrEqual(ANNOUNCE_PREVIEW_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('Room — polite live region for arriving messages', () => {
  it('exposes ONE visually-hidden polite announcer, empty after the history load', async () => {
    stubRoom([message({ id: 'msg_old', body: 'old news' })]);
    renderRoom();
    await screen.findByText('old news');

    const live = announcer();
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(live.className).toContain('sr-only');
    // Nothing "arrived" — history is just what was already there.
    expect(live.textContent).toBe('');
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('announces an inbound arrival as "<sender>: <preview>"', async () => {
    const state = stubRoom([message({ id: 'msg_old', body: 'old news' })]);
    renderRoom();
    await screen.findByText('old news');

    state.history.push(
      message({ id: 'msg_new', body: 'deploy finished cleanly', createdAt: '2026-08-20T10:09:00Z' }),
    );
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_new' } });

    await waitFor(() => expect(announcer().textContent).toBe('qa-bot: deploy finished cleanly'));
  });

  it('stays silent for the caller’s own send', async () => {
    const state = stubRoom([message({ id: 'msg_old', body: 'old news' })]);
    renderRoom();
    await screen.findByText('old news');

    state.history.push(own({ id: 'msg_mine', body: 'on it', createdAt: '2026-08-20T10:09:00Z' }));
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_mine' } });

    await screen.findByText('on it');
    expect(announcer().textContent).toBe('');
  });

  it('stays silent on a wake/reconnect reconcile that backfills missed history', async () => {
    const state = stubRoom([message({ id: 'msg_old', body: 'old news' })]);
    renderRoom();
    await screen.findByText('old news');

    // A message we missed while the stream was down, surfaced by the `sync`
    // reconcile — a backfill, not an arrival.
    state.history.push(
      message({ id: 'msg_missed', body: 'missed while asleep', createdAt: '2026-08-20T10:08:00Z' }),
    );
    await pushRoomEvent({ type: 'sync', data: {} });

    await screen.findByText('missed while asleep');
    expect(announcer().textContent).toBe('');
  });

  it('truncates a long inbound body in the announcement', async () => {
    const state = stubRoom([message({ id: 'msg_old', body: 'old news' })]);
    renderRoom();
    await screen.findByText('old news');

    const long = `${'word '.repeat(80)}end`;
    state.history.push(message({ id: 'msg_long', body: long, createdAt: '2026-08-20T10:09:00Z' }));
    await pushRoomEvent({ type: 'message.new', data: { messageId: 'msg_long' } });

    await waitFor(() => expect(announcer().textContent).not.toBe(''));
    expect(announcer().textContent).toBe(`qa-bot: ${announcePreview(long)}`);
    expect(announcer().textContent!.endsWith('…')).toBe(true);
  });
});
