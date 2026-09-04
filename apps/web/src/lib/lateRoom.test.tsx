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
 * A ROOM THE CACHE NEVER SAW CREATED (issue #59).
 *
 * `sparrow dm botty` run on another machine creates the DM room server-side.
 * This tab's `/me/rooms` was fetched before it existed, so the workspace does
 * not know it — and under the multiplexed architecture that was fatal twice
 * over: {@link roomStreams} tracked only rooms the cache listed, so every
 * wrapped frame for the new room was dropped (the open Room view got no
 * messages and not even the synthetic `sync` that would have made it
 * reconcile), and nothing ever told the workspace its rooms list was stale, so
 * the DM header stayed a nameless generic room until a full page reload.
 *
 * The contract asserted here: an event for a room id the cache does not know
 * both ROUTES to the open view and drives a refetch that hydrates it fully.
 */

const CAPS: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

/** The DM room the CLI created out-of-band, absent from the first rooms load. */
const DM_ROOM = 'room_dm';

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
  streams: SseHandle[];
  /** False until the CLI's DM shows up in `GET /me/rooms` (it exists all along). */
  dmListed: boolean;
  /** How many times the client re-read its rooms list. */
  roomsReads: number;
  history: Message[];
}

function serverFetch(server: Server): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const full = String(input);
    const url = full.split('?')[0]!;
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
              roleTitle: null,
              emailAddress: null,
              createdAt: '2026-08-01T00:00:00Z',
            },
            owner: { id: 'usr_1', displayName: 'Jake' },
            sharedBy: null,
            rooms: [],
            sharedWith: [],
            emailUnreadCount: null,
          },
        ],
      });
    }
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) {
      server.roomsReads += 1;
      return json({
        items: server.dmListed
          ? [
              {
                room: {
                  id: DM_ROOM,
                  name: '',
                  orgId: 'org_1',
                  kind: 'dm',
                  archivedAt: null,
                  counterpart: { type: 'agent', id: 'agt_1', displayName: 'Botty', avatarUrl: null },
                },
                memberId: 'mem_me',
                roomRole: 'member',
              },
            ]
          : [],
      });
    }

    if (url.includes(`/rooms/${DM_ROOM}`)) {
      if (url.endsWith('/status')) return json({ items: [], presence: { online: [] } });
      if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
      if (url.endsWith('/messages')) {
        return json({ items: [...server.history].reverse(), nextBefore: null });
      }
      if (url.includes('/drafts')) return json({ items: [] });
      if (url.endsWith('/whoami')) return json(SELF);
      if (url.endsWith('/members')) return json({ items: [SELF, BOT], nextCursor: null });
      if (new RegExp(`/rooms/${DM_ROOM}$`).test(url)) {
        return json({
          id: DM_ROOM,
          orgId: 'org_1',
          name: '',
          kind: 'dm',
          archivedAt: null,
          settings: { description: '' },
        });
      }
    }
    if (url.includes('/capabilities')) return json(CAPS);
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  }) as typeof fetch;
}

/** Push one room-wrapped frame onto the newest `/me/events` stream. */
function pushMe(server: Server, event: string, data: unknown, roomId: string): void {
  const me = server.streams.filter((s) => s.url.endsWith('/me/events')).at(-1)!;
  const payload = {
    room: { id: roomId, name: '', orgId: 'org_1', kind: 'dm' },
    ...(data as object),
  };
  me.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function renderShell(): void {
  render(
    <MemoryRouter initialEntries={[`/org/org_1/rooms/${DM_ROOM}`]}>
      <AuthProvider>
        <CapabilitiesProvider initial={CAPS}>
          <OrgProvider orgId="org_1">
            <WorkspaceProvider activeRoomId={DM_ROOM}>
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

const ARRIVAL: Message = {
  id: 'msg_oob',
  from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
  to: [{ id: 'mem_me', kind: 'human', avatarUrl: null, displayName: 'Jake' }],
  kind: 'dm',
  subject: null,
  body: 'out-of-band hello',
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-09-01T10:05:00Z',
} as Message;

describe('a room the workspace cache never learned (issue #59)', () => {
  let server: Server;

  beforeEach(() => {
    localStorage.clear();
    presenceStore.reset();
    server = { streams: [], dmListed: false, roomsReads: 0, history: [] };
    useFetch(serverFetch(server));
  });

  afterEach(() => {
    roomStreams.dispose();
    for (const s of server.streams) s.end();
    restoreFetch();
  });

  it('routes an event for an unknown room and refetches until the view is whole', async () => {
    renderShell();
    await waitFor(() => expect(server.streams.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
    // The cache does not list this room, yet we are standing in it: the header
    // has no counterpart to name, and the pane has no message.
    await waitFor(() => expect(screen.getByPlaceholderText(/Enter to send/)).toBeEnabled());
    expect(screen.getByText('Direct message')).toBeInTheDocument();

    // The CLI's message lands. The server has it (and now lists the room); the
    // wrapped frames are the news — a membership gain and the message itself.
    server.history = [ARRIVAL];
    server.dmListed = true;
    act(() => {
      pushMe(server, 'member.joined', { member: { ...BOT } }, DM_ROOM);
      pushMe(
        server,
        'message.new',
        {
          messageId: ARRIVAL.id,
          from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
          preview: 'out-of-band hello',
          kind: 'dm',
        },
        DM_ROOM,
      );
    });

    // The frame reached the open view even though the cache never listed the
    // room — this is the leg that used to be dropped on the floor.
    await waitFor(() => expect(screen.getByText('out-of-band hello')).toBeInTheDocument());
    // ...and the refetch landed, so the DM is a NAMED conversation (header +
    // composer placeholder), not a nameless generic room.
    await waitFor(() => expect(screen.getByPlaceholderText(/Message Botty/)).toBeEnabled());
    expect(screen.queryByText('Direct message')).not.toBeInTheDocument();
  });

  /**
   * The same staleness, for a room we are NOT standing in and never saw a
   * membership event for (its `member.joined` fell outside the journal's
   * replay window, say). Nothing tracked it, so its frame was dropped in
   * silence: the router now reports the id and the workspace re-reads.
   */
  it('refetches the rooms list when a frame names a room it does not track', async () => {
    renderShell();
    await waitFor(() => expect(server.streams.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText(/Enter to send/)).toBeEnabled());
    const before = server.roomsReads;

    act(() =>
      pushMe(
        server,
        'message.new',
        {
          messageId: 'msg_elsewhere',
          from: { id: 'mem_bot', kind: 'agent', avatarUrl: null, displayName: 'Botty' },
          preview: 'in a room you do not know',
          kind: 'broadcast',
        },
        'room_stranger',
      ),
    );

    await waitFor(() => expect(server.roomsReads).toBeGreaterThan(before));
  });
});
