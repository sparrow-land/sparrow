import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CapabilitiesResponse, Member } from '@sparrow/common-types';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { AppShell } from '../components/AppShell.js';
import { Room } from '../routes/Room.js';
import { json } from './apiStub.js';

/**
 * Full shell + active DM-room harness for presence tests: real AuthProvider,
 * WorkspaceProvider, RoomStreams (SSE over a controllable fetch stream), the
 * real AppShell sidebar AND the real Room view — so a test can drive one
 * `presence.changed` frame and observe BOTH surfaces, or flip the "server"
 * state and fire a visibility signal to observe the wake reconcile.
 *
 * Fixture: org `org_1` (Acme), caller Jake (`usr_1`, member `mem_me`), one
 * owned agent Botty (`agt_1`, member `mem_bot`) with a DM room `room_dm`.
 */

/** Presence is medium-independent: the email medium is off in this fixture. */
export const CAPS: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};

const JAKE = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

export const SELF_MEMBER: Member = {
  id: 'mem_me',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_1',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
export const BOT_MEMBER: Member = {
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
  push: (frame: string) => void;
  end: () => void;
}

function sseResponse(track: SseHandle[]): Response {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  let done = false;
  track.push({
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

/** Mutable "server" the fetch mock serves from; tests rewrite it mid-flight. */
export interface PresenceServer {
  /** Principal-level snapshot flag returned by `GET /orgs/:orgId/me/agents`. */
  agentOnline: boolean;
  /** Member ids `GET /rooms/room_dm/status` reports online. */
  statusOnline: string[];
  /** The agent's name as the FETCHED sources report it (rename tests rewrite it). */
  agentName: string;
  /**
   * An extra PROJECT room in `GET /me/rooms`, or null for the DM-only fixture
   * every presence test uses. Opt-in so adding one cannot shift those counts.
   */
  projectRoom: { id: string; name: string; archivedAt: string | null } | null;
  agentsCalls: number;
  humansCalls: number;
  roomsCalls: number;
  statusCalls: number;
  membersCalls: number;
  /**
   * Every opened `/rooms/room_dm/events` stream. The web client no longer opens
   * one (issue #54) — the route stays mocked so a regression shows up here as a
   * non-empty array rather than an unmocked-URL 404.
   */
  roomEvents: SseHandle[];
  /** Every opened `/me/events` stream (kept open; closed in teardown). */
  meEvents: SseHandle[];
}

export function makeServer(over: Partial<PresenceServer> = {}): PresenceServer {
  return {
    agentOnline: false,
    statusOnline: [],
    agentName: 'Botty',
    projectRoom: null,
    agentsCalls: 0,
    humansCalls: 0,
    roomsCalls: 0,
    statusCalls: 0,
    membersCalls: 0,
    roomEvents: [],
    meEvents: [],
    ...over,
  };
}

/**
 * Push one `presence.changed` frame for Botty into the DM room — over the
 * MULTIPLEXED `/me/events` stream, which is the app's only connection (issue
 * #54): the server wraps every room event `{ room, ...payload }` there, and
 * RoomStreams routes it back out by room id.
 */
export function pushBotPresence(server: PresenceServer, state: 'online' | 'offline'): void {
  const member = { id: 'mem_bot', kind: 'agent', displayName: 'Botty', avatarUrl: null, principalId: 'agt_1' };
  pushMeEvent(server, 'presence.changed', { member, state }, DM_ROOM_REF);
}

/**
 * Push one frame onto the newest `/me/events` stream — the workspace-level
 * fan-in. `room` is the wrapper the API adds to ROOM events delivered here.
 */
export function pushMeEvent(
  server: PresenceServer,
  event: string,
  data: unknown,
  room?: { id: string; name: string; kind: 'dm' | 'project' },
): void {
  const payload = room ? { room, ...(data as Record<string, unknown>) } : data;
  server.meEvents.at(-1)!.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** The DM room's wrapper ref, as `/me/events` stamps it onto room events. */
export const DM_ROOM_REF = { id: 'room_dm', name: '', kind: 'dm' as const };

/** Close every live stream so no reader dangles past the test. */
export function closeStreams(server: PresenceServer): void {
  for (const s of [...server.roomEvents, ...server.meEvents]) s.end();
}

export function presenceFetch(server: PresenceServer): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input).split('?')[0]!;
    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: JAKE });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'member' }] });
    }
    if (url.includes('/me/events')) return sseResponse(server.meEvents);
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
    if (url.includes('/orgs/org_1/me/humans')) {
      server.humansCalls += 1;
      return json({ items: [] });
    }
    if (url.includes('/orgs/org_1/me/agents')) {
      server.agentsCalls += 1;
      return json({
        items: [
          {
            agent: {
              id: 'agt_1',
              name: server.agentName,
              orgId: 'org_1',
              online: server.agentOnline,
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
      server.roomsCalls += 1;
      return json({
        items: [
          {
            room: {
              id: 'room_dm',
              name: '',
              orgId: 'org_1',
              kind: 'dm',
              archivedAt: null,
              counterpart: {
                type: 'agent',
                id: 'agt_1',
                displayName: server.agentName,
                avatarUrl: null,
              },
            },
            memberId: 'mem_me',
            roomRole: 'owner',
          },
          ...(server.projectRoom
            ? [
                {
                  room: {
                    id: server.projectRoom.id,
                    name: server.projectRoom.name,
                    orgId: 'org_1',
                    kind: 'project',
                    archivedAt: server.projectRoom.archivedAt,
                  },
                  memberId: 'mem_me',
                  roomRole: 'owner',
                },
              ]
            : []),
        ],
      });
    }
    if (url.endsWith('/rooms/room_dm/events')) return sseResponse(server.roomEvents);
    // A second room's stream: opened by the workspace, never driven by a test.
    if (/\/rooms\/room_p\/(events|status)$/.test(url)) {
      return url.endsWith('/status')
        ? json({ items: [], presence: { online: [] } })
        : sseResponse([]);
    }
    if (url.includes('/rooms/room_p/inbox')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/rooms/room_p/messages')) return json({ items: [], nextBefore: null });
    if (url.endsWith('/whoami')) return json(SELF_MEMBER);
    if (url.endsWith('/members')) {
      server.membersCalls += 1;
      return json({
        items: [SELF_MEMBER, { ...BOT_MEMBER, displayName: server.agentName }],
        nextCursor: null,
      });
    }
    if (url.includes('/inbox')) return json({ items: [], nextCursor: null });
    // Room history (`GET /rooms/:id/messages`) — the thread's content source.
    if (url.endsWith('/messages')) return json({ items: [], nextBefore: null });
    if (url.includes('/drafts')) return json({ items: [] });
    if (url.endsWith('/rooms/room_dm/status')) {
      server.statusCalls += 1;
      return json({ items: [], presence: { online: server.statusOnline } });
    }
    if (/\/rooms\/room_dm$/.test(url)) {
      return json({
        id: 'room_dm',
        orgId: 'org_1',
        name: '',
        kind: 'dm',
        archivedAt: null,
        settings: { description: '' },
      });
    }
    if (url.includes('/capabilities')) return json(CAPS);
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  }) as typeof fetch;
}

/** Mount the shell with the DM room active (leftnav + chat header on screen). */
export function renderShellWithDm(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/org/org_1/rooms/dm']}>
      <AuthProvider>
        <CapabilitiesProvider initial={CAPS}>
          <OrgProvider orgId="org_1">
            <WorkspaceProvider activeRoomId="room_dm">
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
