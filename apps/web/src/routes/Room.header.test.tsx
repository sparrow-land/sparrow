import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Member, Message, Room as RoomResource } from '@sparrow/common-types';

/**
 * Room header + entry affordances (issues #47, #49).
 *   - Opening a conversation puts the caret in the composer: the pane was three
 *     Tab stops from the sidebar before, so every open started with a hunt.
 *   - Room settings has a header entry point. The only route in was a gear that
 *     appeared on hover over a sidebar row — undiscoverable, and unreachable on
 *     touch. It sits with the other room-level actions ("Add people" / "Add
 *     agent"), under the same gating: broadcast rooms only, not archived.
 */

const wsState: { rooms: unknown[] } = { rooms: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: wsState.rooms, agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
const { reportBroadcastUnread } = vi.hoisted(() => ({ reportBroadcastUnread: vi.fn() }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread }) }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: { subscribe: () => () => {} },
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
const PROJECT_ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

function stubRoom(room: RoomResource, history: Message[] = []) {
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, BOT], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/messages') && method === 'GET') return json({ items: history, nextBefore: null });
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url)) return json(room);
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

beforeEach(() => {
  wsState.rooms = [];
  reportBroadcastUnread.mockClear();
});
afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('Room — opening a conversation focuses the composer', () => {
  it('moves focus into the composer textarea once the room is composable', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    const box = await screen.findByPlaceholderText(/Broadcast to everyone/i);
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('never steals focus from something the user already focused', async () => {
    stubRoom(PROJECT_ROOM);
    // A control that already has focus when the room mounts (e.g. the sidebar
    // search the user is typing in).
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    renderRoom();
    const box = await screen.findByPlaceholderText(/Broadcast to everyone/i);
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('does not focus an archived (read-only) room', async () => {
    stubRoom({ ...PROJECT_ROOM, archivedAt: '2026-08-21T00:00:00Z' });
    renderRoom();
    const box = await screen.findByPlaceholderText(/archived/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument());
    expect(document.activeElement).not.toBe(box);
  });
});

describe('Room — room settings entry in the header', () => {
  it('offers a "Room settings" link next to Add people / Add agent', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    await screen.findByRole('button', { name: 'Add people' });

    const gear = screen.getByRole('link', { name: 'Room settings' });
    expect(gear).toHaveAttribute('href', '/org/1/rooms/abc/settings');
  });

  it('is not offered on an archived room (matching Add people / Add agent)', async () => {
    stubRoom({ ...PROJECT_ROOM, archivedAt: '2026-08-21T00:00:00Z' });
    renderRoom();
    await screen.findByText(/This room is archived/i);

    expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Room settings' })).toBeNull();
  });

  it('is not offered in a DM (room settings does not apply)', async () => {
    wsState.rooms = [
      {
        room: {
          id: 'room_abc',
          counterpart: { id: 'agt_bot', type: 'agent', displayName: 'qa-bot', avatarUrl: null },
        },
      },
    ];
    stubRoom({ ...PROJECT_ROOM, kind: 'dm', name: '' });
    renderRoom();
    await screen.findByText('qa-bot');

    expect(screen.queryByRole('link', { name: 'Room settings' })).toBeNull();
  });
});

// Every route used to leave index.html's marketing title in the tab, so a
// browser history list, a window switcher, and a screen reader's page
// announcement all read "sparrow — message rooms for AI agents" (#48).
describe('Room — document title', () => {
  it('names the broadcast room', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    await screen.findByRole('button', { name: 'Add people' });
    expect(document.title).toBe('#general — sparrow');
  });

  it('names the counterpart in a DM', async () => {
    wsState.rooms = [
      {
        room: {
          id: 'room_abc',
          counterpart: { id: 'agt_bot', type: 'agent', displayName: 'qa-bot', avatarUrl: null },
        },
      },
    ];
    stubRoom({ ...PROJECT_ROOM, kind: 'dm', name: '' });
    renderRoom();
    await screen.findByText('qa-bot');
    expect(document.title).toBe('@qa-bot — sparrow');
  });
});

/**
 * Issue #58 — the narrow (<430px) room header. A wrapping name + the
 * "broadcasts to everyone here" subtitle grew the header until roughly 340px of
 * a phone screen was chrome before the first message. jsdom lays nothing out,
 * so this asserts the sizing contract the fix rests on.
 */
describe('Room header — the narrow layout is deliberate', () => {
  it('keeps the room name on ONE line, truncated', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    const name = await screen.findByText('#general');
    expect(name.className).toContain('truncate');
    // Its holder must not wrap the name/subtitle pair onto extra lines.
    expect(name.parentElement!.className).not.toContain('flex-wrap');
  });

  it('drops the broadcast subtitle at narrow widths', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    const subtitle = await screen.findByText('broadcasts to everyone here');
    expect(subtitle.className).toContain('hidden');
    expect(subtitle.className).toMatch(/sm:inline/);
  });

  it('spends less vertical padding on a phone than on a desktop', async () => {
    stubRoom(PROJECT_ROOM);
    renderRoom();
    const name = await screen.findByText('#general');
    const header = name.closest('div.border-b')!;
    expect(header.className).toMatch(/\bpy-1\.5\b/);
    expect(header.className).toMatch(/sm:py-2\.5/);
  });
});
