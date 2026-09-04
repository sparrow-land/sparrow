import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { SparrowEvent } from '@sparrow/client';
import type { Member, Message, ReadStatus, Room as RoomResource } from '@sparrow/common-types';

vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: [], agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread: vi.fn() }) }));
vi.mock('../lib/drafts.js', () => ({ migrateLocalDrafts: async () => 0 }));

// Controllable stream: capture the Room's subscribe callback so a test can emit
// live SSE events (message.received / message.read) into the running component.
let emit: ((ev: SparrowEvent) => void) | null = null;
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: {
    subscribe: (_roomId: string, fn: (ev: SparrowEvent) => void) => {
      emit = fn;
      return () => {
        emit = null;
      };
    },
  },
}));

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
const OTHER: Member = {
  id: 'mem_bot',
  kind: 'agent', avatarUrl: null,
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
const OWN: Message = {
  id: 'msg_1',
  from: { id: 'mem_self', kind: 'human', avatarUrl: null, displayName: 'Jake' },
  to: [{ id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' }],
  kind: 'broadcast',
  subject: null,
  body: 'ship it',
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-08-20T10:05:00Z',
};

// The receipt the /status endpoint returns, mutated by the test to model the
// server-observed delivery progression the SSE events announce.
let phase: ReadStatus = 'unread';
function statusBody() {
  return {
    id: 'msg_1',
    kind: 'broadcast',
    createdAt: '2026-08-20T10:05:00Z',
    recipients: [
      {
        id: 'mem_bot',
        kind: 'agent', avatarUrl: null,
        displayName: 'deploy-bot',
        status: phase,
        receivedAt: phase === 'received' || phase === 'read' ? '2026-08-20T10:06:00Z' : null,
        readAt: phase === 'read' ? '2026-08-20T10:07:00Z' : null,
      },
    ],
  };
}

function stubRoom() {
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.includes('/messages/') && url.endsWith('/status')) return json(statusBody());
    // The room history the thread renders — the caller's own message included.
    if (url.endsWith('/messages') && method === 'GET') return json({ items: [OWN], nextBefore: null });
    if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
    if (/\/rooms\/room_abc$/.test(url) && method === 'GET') return json(ROOM);
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
  phase = 'unread';
  emit = null;
});
afterEach(() => {
  restoreFetch();
});

describe('Room live delivery receipts', () => {
  it('message.received flips the own bubble to delivered; message.read flips it to read', async () => {
    stubRoom();
    renderRoom();

    // Own message loads; nothing delivered yet → sent (no marker).
    expect(await screen.findByText('ship it')).toBeInTheDocument();
    await waitFor(() => expect(emit).not.toBeNull());
    expect(screen.queryByText(/delivered|^read/)).toBeNull();

    // Recipient's client has it → message.received refreshes the receipt.
    phase = 'received';
    emit!({ type: 'message.received', data: { messageId: 'msg_1', by: OTHER, receivedAt: '2026-08-20T10:06:00Z' } } as SparrowEvent);
    expect(await screen.findByText(/delivered/i)).toBeInTheDocument();

    // Recipient read it → message.read flips to the read indicator.
    phase = 'read';
    emit!({ type: 'message.read', data: { messageId: 'msg_1', by: OTHER, readAt: '2026-08-20T10:07:00Z' } } as SparrowEvent);
    await waitFor(() => expect(screen.getByText(/^read/)).toBeInTheDocument());
    expect(screen.queryByText(/delivered/i)).toBeNull();
  });
});
