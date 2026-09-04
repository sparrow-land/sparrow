import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Member, Room as RoomResource } from '@sparrow/common-types';

// Same peripheral stubs as Room.test.tsx: Room leans on several contexts + the
// shared SSE manager. Here we exercise the PROJECT-room working bubbles that sit
// above the composer (labelled per member, own excluded, live).
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
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { Room } from './Room.js';

const SELF: Member = {
  id: 'mem_self',
  kind: 'human', avatarUrl: null,
  principalId: 'usr_self',
  displayName: 'Jake',
  roomRole: 'owner',
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

interface StatusItem {
  memberId: string;
  displayName: string;
  note: string | null;
}

/** Boot a project room whose `GET /status` advertises `statusItems` as working. */
function stubProjectRoom(statusItems: StatusItem[]) {
  const future = new Date(Date.now() + 60_000).toISOString();
  const members: Member[] = [
    SELF,
    ...statusItems
      .filter((s) => s.memberId !== SELF.id)
      .map((s) => ({
        id: s.memberId,
        kind: 'agent' as const, avatarUrl: null,
        principalId: `agt_${s.memberId}`,
        displayName: s.displayName,
        roomRole: 'member' as const,
        lastSeenAt: null,
        createdAt: '2026-08-20T10:00:00Z',
      })),
  ];
  useFetch(async (input) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: members, nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    // Room history — the thread's content source (`GET /rooms/:id/messages`).
    if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/status')) {
      return json({
        items: statusItems.map((s) => ({
          memberId: s.memberId,
          displayName: s.displayName,
          state: 'working',
          note: s.note,
          to: null,
          sinceAt: future,
          sticky: false,
          expiresAt: future,
        })),
        presence: { online: statusItems.map((s) => s.memberId) },
      });
    }
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

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
});
afterEach(() => {
  restoreFetch();
});

describe('Room project working bubbles (above composer)', () => {
  it('renders one working member as a name + note bubble, above the composer', async () => {
    stubProjectRoom([{ memberId: 'mem_a', displayName: 'deploy-bot', note: 'reviewing the PR' }]);
    renderRoom();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('deploy-bot');
    expect(status).toHaveTextContent('working');
    expect(status).toHaveTextContent('reviewing the PR');

    // Pinned above the composer: the bubble precedes the textbox in the DOM.
    const textbox = screen.getByRole('textbox');
    expect(status.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders three working members as three bubbles (no collapse)', async () => {
    stubProjectRoom([
      { memberId: 'mem_a', displayName: 'Ann', note: 'a' },
      { memberId: 'mem_b', displayName: 'Bob', note: 'b' },
      { memberId: 'mem_c', displayName: 'Cara', note: 'c' },
    ]);
    renderRoom();

    await screen.findByText('Ann');
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(3);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Cara')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/members working/);
  });

  it('collapses five working members to two bubbles plus a "3 members working…" line', async () => {
    stubProjectRoom([
      { memberId: 'mem_a', displayName: 'Ann', note: 'a' },
      { memberId: 'mem_b', displayName: 'Bob', note: 'b' },
      { memberId: 'mem_c', displayName: 'Cara', note: 'c' },
      { memberId: 'mem_d', displayName: 'Dan', note: 'd' },
      { memberId: 'mem_e', displayName: 'Eve', note: 'e' },
    ]);
    renderRoom();

    await screen.findByText('Ann');
    // First two (alphabetical) shown as bubbles; the rest collapse.
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Cara')).toBeNull();
    expect(screen.getByText(/3 members working…/)).toBeInTheDocument();
  });

  it('excludes the caller’s own working status', async () => {
    stubProjectRoom([
      { memberId: SELF.id, displayName: 'Jake', note: 'my own work' },
      { memberId: 'mem_a', displayName: 'deploy-bot', note: 'reviewing' },
    ]);
    renderRoom();

    await screen.findByText('deploy-bot');
    // Only the other member's bubble renders — never a self bubble.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('my own work');
  });

  it('appears and disappears live with status.changed (working → idle)', async () => {
    stubProjectRoom([]); // no one working at boot
    renderRoom();
    await screen.findByRole('textbox');
    expect(screen.queryByRole('status')).toBeNull();

    const future = new Date(Date.now() + 60_000).toISOString();
    act(() => {
      for (const h of streamHandlers) {
        h({
          type: 'status.changed',
          data: {
            member: { id: 'mem_a', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
            state: 'working',
            note: 'building',
            to: null,
            sinceAt: future,
            sticky: false,
            expiresAt: future,
          },
        });
      }
    });

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('deploy-bot');
    expect(status).toHaveTextContent('building');

    // Idle event removes the bubble live.
    act(() => {
      for (const h of streamHandlers) {
        h({
          type: 'status.changed',
          data: {
            member: { id: 'mem_a', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
            state: 'idle',
            note: null,
            to: null,
            sinceAt: null,
            sticky: false,
            expiresAt: null,
          },
        });
      }
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
