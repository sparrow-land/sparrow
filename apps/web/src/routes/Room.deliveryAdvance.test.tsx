import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, ReadStatus, Room as RoomResource } from '@sparrow/common-types';

vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ rooms: [], agents: [], reloadRooms: vi.fn() }),
}));
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1' }) }));
vi.mock('../lib/auth.js', () => ({ useAuth: () => ({ sessionExpired: vi.fn() }) }));
vi.mock('../components/AppShell.js', () => ({ useShell: () => ({ reportBroadcastUnread: vi.fn() }) }));
vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: { subscribe: () => () => {} },
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

const INBOUND_ID = 'msg_in1';
function inbound(status: ReadStatus): InboxItem {
  return {
    id: INBOUND_ID,
    from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
    kind: 'broadcast',
    subject: null,
    preview: 'ship it',
    truncated: false,
    attachmentCount: 0,
    status,
    createdAt: '2026-08-20T10:05:00Z',
  };
}
function fullInbound(): Message {
  return {
    id: INBOUND_ID,
    from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
    to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
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
}

/** Capture every request URL (query included) so we can inspect the read's ?peek. */
let calls: string[] = [];
function stubRecipient(status: ReadStatus) {
  calls = [];
  useFetch(async (input, init) => {
    const full = String(input);
    calls.push(full);
    const url = full.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    // The inbox is the caller's OPEN delivery rows (unread + received); an
    // already-read message has none, so the listing is empty in that phase.
    if (url.includes('/inbox')) {
      return json({ items: status === 'read' ? [] : [inbound(status)], nextCursor: null });
    }
    if (url.includes('/drafts')) return json({ items: [] });
    if (new RegExp(`/messages/${INBOUND_ID}$`).test(url) && method === 'GET') {
      return json({ message: fullInbound() });
    }
    // Room history: where the bubble's content comes from.
    if (url.endsWith('/messages') && method === 'GET') {
      return json({ items: [fullInbound()], nextBefore: null });
    }
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

/** The read GET this hydrate issued for the inbound message (query preserved). */
function readCall(): string | undefined {
  return calls.find((u) => new RegExp(`/messages/${INBOUND_ID}(\\?|$)`).test(u));
}

afterEach(() => restoreFetch());

describe('Room recipient delivery advance', () => {
  it('marks a RECEIVED (delivered-but-unread) message read — a non-peek read so the sender advances delivered → read', async () => {
    stubRecipient('received');
    renderRoom();

    // The inbound bubble hydrates via GET /messages/:id.
    await waitFor(() => expect(readCall()).toBeDefined());
    // A received-but-unread message must be READ (peek=false), which is what
    // emits `message.read` back to the sender. Peeking here is the bug that
    // freezes the sender's receipt at "delivered" forever.
    expect(readCall()).not.toContain('peek=true');
  });

  it('still marks an UNREAD message read (peek=false)', async () => {
    stubRecipient('unread');
    renderRoom();
    await waitFor(() => expect(readCall()).toBeDefined());
    expect(readCall()).not.toContain('peek=true');
  });

  it('never re-reads an already-READ message — history carried the body (no read-state rewrite)', async () => {
    // Rewritten with the history route: the bubble's body now arrives with
    // `GET /rooms/:id/messages` (a peek that writes no read state), so an
    // already-read message needs NO per-message fetch at all. The old assertion
    // (a `peek=true` read) checked the weaker version of the same guarantee.
    stubRecipient('read');
    renderRoom();
    await screen.findByText('ship it');
    expect(readCall()).toBeUndefined();
  });
});
