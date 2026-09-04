import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { InboxItem, Member, Message, Room as RoomResource } from '@sparrow/common-types';

// Wake/reconnect reconciliation: when a room stream (re)connects after being
// down, or the tab regains visibility/focus/network after sleeping, the ACTIVE
// room must reconcile against the server — REPLACE its status/presence snapshot
// (clearing anything stale, e.g. a sticky "working" whose idle event was missed
// while asleep) and refetch the message page (missed messages appear, deduped).
//
// Same peripheral stubs as Room.test.tsx. `streamHandlers` captures the room's
// stream subscriber so a test can drive a synthetic `sync` (reconnect) event.
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

interface StatusItem {
  memberId: string;
  displayName: string;
  note: string | null;
  sticky?: boolean;
}

/** Mutable server view a test rewrites mid-flight, then reconciles against. */
const server: {
  inbox: InboxItem[];
  statuses: StatusItem[];
  online: string[];
  statusCalls: number;
  inboxCalls: number;
  /** Simulate the room's IDENTITY routes being briefly unavailable (a 500). */
  identityDown: boolean;
} = { inbox: [], statuses: [], online: [], statusCalls: 0, inboxCalls: 0, identityDown: false };

function inbound(id: string, body: string): InboxItem {
  return {
    id,
    from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
    kind: 'broadcast',
    subject: null,
    preview: body,
    truncated: false,
    attachmentCount: 0,
    status: 'read',
    createdAt: `2026-08-20T10:0${id.length}:00Z`,
  };
}

/** The same message as the room-history route returns it (a full Message). */
function historyItem(it: InboxItem): Message {
  return {
    id: it.id,
    from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
    to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
    kind: 'broadcast',
    subject: null,
    body: it.preview,
    attachments: [],
    suggestedReplies: [],
    inReplyTo: null,
    replyValue: null,
    origin: null,
    createdAt: it.createdAt,
  };
}

/** Route the client's fetch off the mutable `server` view. */
function stubRoom() {
  const far = new Date(Date.now() + 60_000).toISOString();
  useFetch(async (input) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false } });
    if (server.identityDown && (url.includes('/whoami') || url.includes('/members') || /\/rooms\/room_abc$/.test(url))) {
      return errorJson('internal', 500);
    }
    if (url.includes('/whoami')) return json(SELF);
    if (url.includes('/members')) return json({ items: [SELF, OTHER], nextCursor: null });
    if (/\/messages\/[^/]+$/.test(url)) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const it = server.inbox.find((i) => i.id === id);
      return json({
        message: {
          id,
          from: { id: OTHER.id, kind: 'agent', avatarUrl: null, displayName: 'deploy-bot' },
          to: [{ id: SELF.id, kind: 'human', avatarUrl: null, displayName: 'Jake' }],
          kind: 'broadcast',
          subject: null,
          body: it?.preview ?? 'body',
          attachments: [],
          suggestedReplies: [],
          inReplyTo: null,
          replyValue: null,
          origin: null,
          createdAt: it?.createdAt ?? '2026-08-20T10:05:00Z',
        },
      });
    }
    if (url.includes('/inbox')) {
      server.inboxCalls += 1;
      // Unread-only listing: these fixtures are already-read history, so the
      // caller's OPEN delivery rows are empty — the thread comes from history.
      return json({ items: server.inbox.filter((i) => i.status !== 'read'), nextCursor: null });
    }
    // Room history, newest-first — the thread's content source.
    if (url.endsWith('/messages')) {
      return json({ items: [...server.inbox].reverse().map(historyItem), nextBefore: null });
    }
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/status')) {
      server.statusCalls += 1;
      return json({
        items: server.statuses.map((s) => ({
          memberId: s.memberId,
          displayName: s.displayName,
          state: 'working',
          note: s.note,
          to: null,
          sinceAt: far,
          sticky: s.sticky ?? false,
          expiresAt: s.sticky ? null : far,
        })),
        presence: { online: server.online },
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

/** Fire a `visibilitychange` with the document reported as visible. */
function fireVisible() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Deliver a synthetic reconnect `sync` to the room's stream subscriber. */
function fireSync() {
  act(() => {
    for (const h of streamHandlers) h({ type: 'sync' });
  });
}

beforeEach(() => {
  wsState.rooms = [];
  streamHandlers.length = 0;
  server.inbox = [];
  server.statuses = [];
  server.online = [];
  server.statusCalls = 0;
  server.inboxCalls = 0;
  server.identityDown = false;
});
afterEach(() => {
  restoreFetch();
});

describe('Room wake/reconnect reconciliation', () => {
  it('REPLACES a stale sticky "working" with the refetched snapshot on visibility-regain', async () => {
    // Boot with a sticky working status live in the room (the agent held it while
    // the owner was present). A sticky status never self-expires client-side.
    server.statuses = [{ memberId: OTHER.id, displayName: 'deploy-bot', note: 'shipping it', sticky: true }];
    server.online = [OTHER.id];
    stubRoom();
    renderRoom();

    const bubble = await screen.findByRole('status');
    expect(bubble).toHaveTextContent('deploy-bot');
    expect(bubble).toHaveTextContent('shipping it');

    // While the laptop slept the agent went idle; the `status.changed → idle` was
    // missed. The server snapshot now reports no active status.
    server.statuses = [];
    server.online = [OTHER.id];

    fireVisible();

    // The stale sticky bubble is cleared by the replaced snapshot (not by TTL —
    // a sticky status carries no expiry, so only a REPLACE can drop it).
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('surfaces messages missed while asleep, deduped and time-ordered, after reconcile', async () => {
    server.inbox = [inbound('m1', 'first message')];
    stubRoom();
    renderRoom();

    await screen.findByText('first message');

    // Two more messages arrived during sleep; the original is still present (dedupe
    // by id must not duplicate it).
    server.inbox = [inbound('m1', 'first message'), inbound('m22', 'second message'), inbound('m333', 'third message')];

    fireVisible();

    await screen.findByText('third message');
    expect(screen.getByText('second message')).toBeInTheDocument();
    // The original appears exactly once (no duplicate bubble).
    expect(screen.getAllByText('first message')).toHaveLength(1);

    // Time order preserved: first precedes second precedes third in the DOM.
    const first = screen.getByText('first message');
    const second = screen.getByText('second message');
    const third = screen.getByText('third message');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('debounces rapid visibility events into a single reconcile (≥5s apart)', async () => {
    stubRoom();
    renderRoom();
    await screen.findByRole('textbox');

    // Let the boot's own status fetch settle, then measure only reconcile-driven fetches.
    await waitFor(() => expect(server.statusCalls).toBeGreaterThan(0));
    const before = server.statusCalls;

    fireVisible();
    fireVisible();

    await waitFor(() => expect(server.statusCalls).toBe(before + 1));
    // No trailing second run: the throttle keeps runs ≥5s apart.
    await new Promise((r) => setTimeout(r, 60));
    expect(server.statusCalls).toBe(before + 1);
  });

  it('reconnect (`sync`) reconciles the status snapshot the same way visibility does', async () => {
    server.statuses = [{ memberId: OTHER.id, displayName: 'deploy-bot', note: 'sticky work', sticky: true }];
    server.online = [OTHER.id];
    stubRoom();
    renderRoom();

    await screen.findByText('sticky work');

    // Stream dropped while asleep, agent went idle, missed the event; on reconnect
    // RoomStreams emits a synthetic `sync`.
    server.statuses = [];

    fireSync();

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

/**
 * Issue #59, the composer half. A room's IDENTITY load (`whoami` + the room
 * resource + the roster) happens exactly once, on mount. If it fails — the
 * server was restarting, or the caller's membership had not committed yet for a
 * room created out-of-band — the pane was stranded for the session: no `self`
 * (the composer stays DISABLED) and no room (the header renders a generic
 * `#room`), with no path back but a full page reload. A reconcile is precisely
 * the moment to try that half again.
 */
describe('Room heals an identity load that failed at mount', () => {
  it('refetches self + room on reconcile, enabling the composer', async () => {
    server.identityDown = true;
    stubRoom();
    renderRoom();

    // The pane rendered, but degraded: nameless header, composer refusing input.
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(box).toBeDisabled());
    expect(screen.getByText('#room')).toBeInTheDocument();

    // The blip passes; the stream reconnects and the pane reconciles.
    server.identityDown = false;
    fireSync();

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(screen.getByText('#general')).toBeInTheDocument();
  });
});
