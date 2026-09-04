import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CapabilitiesResponse, Member, Message } from '@sparrow/common-types';
import { useFetch, restoreFetch, json } from '../test/apiStub.js';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { AppShell } from '../components/AppShell.js';
import { Room } from '../routes/Room.js';
import { roomStreams } from '../lib/roomStreams.js';
import { presenceStore } from '../lib/presenceStore.js';

/**
 * THE CONNECTION BUDGET (issue #54). A browser allows ~6 concurrent HTTP/1.1
 * connections per origin, and the README self-host path is plain HTTP/1.1. The
 * web client used to hold one SSE connection PER JOINED ROOM on top of
 * `/me/events`, so a member of four rooms — or two tabs with two rooms each —
 * saturated the pool and every subsequent request queued forever: permanent
 * room skeletons, invite dialogs stuck on "creating invite", and no error
 * anywhere to explain it.
 *
 * The fix is that `/me/events` was ALREADY the multiplexed stream: the server
 * fans every membership into it, room events wrapped `{ room, ...payload }`,
 * with membership recomputed per emit and a per-principal journal cursor. So
 * the whole tab now rides ONE connection, and this file is the budget's guard:
 * a workspace with five rooms may open at most two streams, and the room view
 * must still go live off the shared one.
 */

/** The hard ceiling: three tabs at this budget still fit under HTTP/1.1's six. */
const MAX_STREAMS_PER_TAB = 2;

const ROOM_IDS = ['room_1', 'room_2', 'room_3', 'room_4', 'room_5'];
const ACTIVE = 'room_1';

const CAPS: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

const JAKE = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

const SELF: Member = {
  id: 'mem_me',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_1',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const BOT: Member = {
  id: 'mem_bot',
  kind: 'agent',
  avatarUrl: null,
  principalId: 'agt_1',
  displayName: 'Botty',
  roomRole: 'member',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};

/** One controllable SSE response; `push` feeds raw frames to the client parser. */
interface SseHandle {
  url: string;
  push: (frame: string) => void;
  end: () => void;
}

function sseResponse(url: string, track: SseHandle[]): Response {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  let done = false;
  track.push({
    url,
    push: (frame) => {
      if (!done) ctrl.enqueue(enc.encode(frame));
    },
    end: () => {
      if (done) return;
      done = true;
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

interface Server {
  /** Every SSE response the client opened, oldest first (the budget under test). */
  streams: SseHandle[];
  /** roomId → the room's message history, mutable mid-test. */
  history: Record<string, Message[]>;
  /** roomId → the room's unread inbox previews, mutable mid-test. */
  inbox: Record<string, unknown[]>;
}

function makeServer(): Server {
  return {
    streams: [],
    history: Object.fromEntries(ROOM_IDS.map((id) => [id, [] as Message[]])),
    inbox: Object.fromEntries(ROOM_IDS.map((id) => [id, [] as unknown[]])),
  };
}

function serverFetch(server: Server): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const full = String(input);
    const url = full.split('?')[0]!;
    // Every `text/event-stream` open in the app, whatever its shape.
    if (/\/events$/.test(url)) return sseResponse(url, server.streams);

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: JAKE });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'member' }] });
    }
    if (/\/orgs\/org_1$/.test(url)) {
      return json({
        org: {
          id: 'org_1',
          name: 'Acme',
          slug: 'acme',
          settings: {
            invites: { who: 'members' },
            enroll: { agents: 'approval' },
            rooms: { create: 'members' },
          },
          createdAt: '2026-08-01T00:00:00Z',
        },
      });
    }
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) {
      return json({
        items: [
          {
            agent: {
              id: 'agt_1',
              name: 'Botty',
              orgId: 'org_1',
              online: false,
              lastSeenAt: null,
              createdAt: '2026-08-01T00:00:00Z',
            },
            owner: { id: 'usr_1', displayName: 'Jake' },
            sharedBy: null,
            rooms: [],
            sharedWith: [],
          },
        ],
      });
    }
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) {
      return json({
        items: ROOM_IDS.map((id, i) => ({
          room: {
            id,
            name: `room-${i + 1}`,
            orgId: 'org_1',
            kind: 'project',
            archivedAt: null,
          },
          memberId: 'mem_me',
          roomRole: 'owner',
        })),
      });
    }

    const roomId = /\/rooms\/(room_\d)\b/.exec(url)?.[1];
    if (roomId) {
      if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
      if (url.includes('/inbox')) return json({ items: server.inbox[roomId] ?? [], nextCursor: null });
      if (url.endsWith('/messages')) {
        const items = [...(server.history[roomId] ?? [])].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : -1,
        );
        return json({ items, nextBefore: null });
      }
      if (url.includes('/drafts')) return json({ items: [] });
      if (url.endsWith('/whoami')) return json(SELF);
      if (url.endsWith('/members')) return json({ items: [SELF, BOT], nextCursor: null });
      if (new RegExp(`/rooms/${roomId}$`).test(url)) {
        return json({
          id: roomId,
          orgId: 'org_1',
          name: `room-${roomId.slice(-1)}`,
          kind: 'project',
          archivedAt: null,
          settings: { description: '' },
        });
      }
    }
    if (url.includes('/capabilities')) return json(CAPS);
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  }) as typeof fetch;
}

/** Push one frame onto the newest `/me/events` stream, room-wrapped like the API. */
function pushMe(server: Server, event: string, data: unknown, roomId?: string): void {
  const me = server.streams.filter((s) => s.url.endsWith('/me/events')).at(-1)!;
  const payload = roomId
    ? { room: { id: roomId, name: `room-${roomId.slice(-1)}`, orgId: 'org_1', kind: 'project' }, ...(data as object) }
    : data;
  me.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function renderShell(): void {
  render(
    <MemoryRouter initialEntries={[`/org/org_1/rooms/${ACTIVE}`]}>
      <AuthProvider>
        <CapabilitiesProvider initial={CAPS}>
          <OrgProvider orgId="org_1">
            <WorkspaceProvider activeRoomId={ACTIVE}>
              <Routes>
                <Route path="/org/:orgId" element={<AppShell />}>
                  <Route path="rooms/:roomId" element={<Room />} />
                </Route>
              </Routes>
            </WorkspaceProvider>
          </OrgProvider>
        </CapabilitiesProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SSE connection budget — one multiplexed stream, whatever the room count', () => {
  let server: Server;

  beforeEach(() => {
    localStorage.clear();
    presenceStore.reset();
    server = makeServer();
    useFetch(serverFetch(server));
  });

  afterEach(() => {
    roomStreams.dispose();
    for (const s of server.streams) s.end();
    restoreFetch();
  });

  it('opens at most 2 streams for a workspace with 5 rooms — and no per-room stream', async () => {
    renderShell();

    // Let the shell settle: sidebar sources loaded and the active room mounted.
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
    await waitFor(() => expect(server.streams.length).toBeGreaterThan(0));
    // Give any straggling per-room effect a chance to fire before we count.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(server.streams.length).toBeLessThanOrEqual(MAX_STREAMS_PER_TAB);
    // The one stream is the multiplexed fan-in; `/rooms/:id/events` is gone.
    expect(server.streams.map((s) => s.url).filter((u) => u.endsWith('/me/events'))).toHaveLength(1);
    expect(server.streams.filter((s) => /\/rooms\/room_\d\/events$/.test(s.url))).toHaveLength(0);
  });

  it('a live message in the ACTIVE room still renders off the shared stream', async () => {
    renderShell();
    await waitFor(() => expect(server.streams.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());

    // The server now holds the message; the wrapped frame is what tells us.
    server.history[ACTIVE] = [
      {
        id: 'msg_live',
        from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
        to: [{ id: 'mem_me', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
        kind: 'broadcast',
        subject: null,
        body: 'multiplexed hello',
        attachments: [],
        suggestedReplies: [],
        inReplyTo: null,
        replyValue: null,
        origin: null,
        createdAt: '2026-09-01T10:05:00Z',
      } as Message,
    ];
    act(() =>
      pushMe(
        server,
        'message.new',
        {
          messageId: 'msg_live',
          from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
          preview: 'multiplexed hello',
          kind: 'broadcast',
        },
        ACTIVE,
      ),
    );

    await waitFor(() => expect(screen.getByText('multiplexed hello')).toBeInTheDocument());
  });

  it('a live message in a BACKGROUND room still badges its sidebar row', async () => {
    renderShell();
    await waitFor(() => expect(server.streams.length).toBeGreaterThan(0));
    await waitFor(() => expect(Object.keys(roomStreams.snapshot())).toHaveLength(ROOM_IDS.length));

    // room_5 is the FIFTH room — past the old six-socket cap's usefulness and
    // definitely not the active one. Its unread badge must still move live.
    act(() =>
      pushMe(
        server,
        'message.new',
        {
          messageId: 'msg_bg',
          from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
          preview: 'background',
          kind: 'broadcast',
        },
        'room_5',
      ),
    );

    await waitFor(() => expect(roomStreams.snapshot()['room_5']?.unread).toEqual({ all: 1 }));
  });
});
