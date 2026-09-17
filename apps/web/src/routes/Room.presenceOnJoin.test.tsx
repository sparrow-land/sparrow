import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Member, Room as RoomResource } from '@sparrow/common-types';

/**
 * Issue #4 — the header member strip showed a just-added agent OFFLINE while the
 * sidebar and `GET /rooms/:id/status` both said online. The strip reads the
 * presence snapshot seeded at load and patched by `presence.changed`; a member
 * that was ALREADY online before the membership existed produces no event at
 * join, so the strip kept the stale (absent) entry until a page reload.
 *
 * The server now announces that member (see `onMemberJoined`); this pins the
 * client half: a `member.joined` re-reads the presence snapshot alongside the
 * roster, so the dot is right even with no `presence.changed` at all.
 */
const wsState: { rooms: unknown[] } = { rooms: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: vi.fn() }),
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

/** The room the reader is standing in; `server` is mutated to add the agent. */
const server: { members: Member[]; online: string[] } = { members: [SELF], online: [] };

function stubRoom() {
  useFetch(async (input) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: server.members, nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
    if (url.endsWith('/status')) return json({ items: [], presence: { online: server.online } });
    if (/\/rooms\/room_abc$/.test(url)) return json(ROOM);
    return errorJson('not_found', 404);
  });
}

function renderRoom() {
  render(
    <MemoryRouter initialEntries={['/rooms/room_abc']}>
      <CapabilitiesProvider>
        <Routes>
          <Route path="/rooms/:roomId" element={<Room />} />
        </Routes>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

/** The presence word rendered on a member-strip avatar ("online"/"offline"/…). */
function stripDot(displayName: string): string {
  const avatar = document.querySelector(`[title="${displayName}"]`);
  if (!avatar) throw new Error(`no member-strip avatar for ${displayName}`);
  // The avatar art is an `img` too; the presence glyph is the one whose label is
  // a presence word (optionally "+ working").
  const labels = within(avatar as HTMLElement)
    .getAllByRole('img')
    .map((el) => el.getAttribute('aria-label') ?? '');
  const dot = labels.find((l) => /^(online|offline|active)\b/.test(l));
  if (dot === undefined) throw new Error(`no presence glyph for ${displayName}: ${labels.join(', ')}`);
  return dot;
}

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  server.members = [SELF];
  server.online = [];
});
afterEach(() => {
  restoreFetch();
});

describe('Room header member strip — a member added while already online', () => {
  it('shows the new member online after member.joined, with no presence.changed', async () => {
    stubRoom();
    renderRoom();
    await waitFor(() => expect(screen.getByText('#general')).toBeInTheDocument());

    // "Add agent" lands the membership server-side; the agent was already online
    // (a heartbeat mark planted before it was a member), so the status snapshot
    // already lists it — but no presence event describes the join.
    server.members = [SELF, BOT];
    server.online = [BOT.id];
    await act(async () => {
      for (const h of streamHandlers) h({ type: 'member.joined', data: { member: BOT } });
    });

    await waitFor(() => expect(stripDot('qa-bot')).toBe('online'));
  });

  it('leaves an offline newcomer offline', async () => {
    stubRoom();
    renderRoom();
    await waitFor(() => expect(screen.getByText('#general')).toBeInTheDocument());

    server.members = [SELF, BOT];
    await act(async () => {
      for (const h of streamHandlers) h({ type: 'member.joined', data: { member: BOT } });
    });

    await waitFor(() => expect(stripDot('qa-bot')).toBe('offline'));
  });
});
