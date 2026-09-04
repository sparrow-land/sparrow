/**
 * TEST-ONLY harness for the agent page and its tabs. Nothing in `src/` imports
 * this outside `*.test.tsx`, so it never reaches the bundle; it lives beside the
 * tabs (rather than in `src/test/`) because it knows this one page's shape.
 *
 * It mounts the REAL page inside the real providers — Capabilities + Auth + Org
 * + Workspace + a router — over a stubbed `fetch`, so a tab test exercises the
 * same wiring the browser does (`?tab=` resolution, capability gating, the
 * owner/admin read rule) instead of a component in isolation.
 */
import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';
import type { CapabilitiesResponse, HumanRef, OrgRole } from '@sparrow/common-types';
import { AuthProvider } from '../../lib/auth.js';
import { OrgProvider } from '../../lib/org.js';
import { WorkspaceProvider } from '../../lib/workspace.js';
import { CapabilitiesProvider } from '../../lib/capabilities.js';
import { useFetch, json } from '../../test/apiStub.js';
import { AGENT_ID, ORG_ID } from '../../test/fixtures.js';
import { AgentProfile } from '../AgentProfile.js';

/** Capabilities with every optional medium off (the keyless default). */
export const CAPS_OFF: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};
/** …and with the email medium configured. */
export const CAPS_EMAIL: CapabilitiesResponse = { ...CAPS_OFF, email: true };

export const ME = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };
export const AGENT_ADDRESS = 'fable@acme.example.com';

/** Every request the page made, so a test can assert the query it sent. */
export interface Recorder {
  requests: { method: string; url: string; body: unknown }[];
  /** The `?…` of the last request whose path contains `needle`. */
  lastQuery(needle: string): URLSearchParams | null;
  /** How many requests hit a path containing `needle` (paging / refetch counts). */
  count(needle: string): number;
  /**
   * Push one raw SSE frame down EVERY open `/me/events` stream — the workspace
   * provider holds one and the live tab holds another, exactly as the browser
   * would. Wrapped in `act` so React has flushed by the time it resolves.
   */
  push(type: string, data: unknown): Promise<void>;
}

export interface AgentPageOptions {
  /** Where to start (default: the agent page, Overview). */
  url?: string;
  caps?: CapabilitiesResponse;
  /** The caller's role in the org — `useOrg().isAdmin` comes from this. */
  role?: OrgRole;
  /** The agent's derived address, or null for "the medium wrote none". */
  address?: string | null;
  /** Non-null makes the caller a GRANTEE rather than the owner. */
  sharedBy?: HumanRef | null;
  owner?: HumanRef;
  /** The visibility entry's owner-only mail count (`null` = not countable here). */
  emailUnreadCount?: number | null;
  /** Surface-specific routes; return null to fall through to the defaults. */
  handle?: (url: string, init: RequestInit | undefined) => Response | null;
}

/**
 * Render the agent page over a stubbed API. Returns the recorder plus
 * testing-library's own result, so a test can `unmount()` between cases.
 */
export function renderAgentPage(
  opts: AgentPageOptions = {},
): RenderResult & { rec: Recorder } {
  /** Every open `/me/events` stream (the workspace's, plus a live tab's). */
  const streams: ((frame: string) => void)[] = [];

  const rec: Recorder = {
    requests: [],
    lastQuery(needle) {
      const hit = [...this.requests].reverse().find((r) => r.url.includes(needle));
      if (!hit) return null;
      const q = hit.url.indexOf('?');
      return new URLSearchParams(q === -1 ? '' : hit.url.slice(q + 1));
    },
    count(needle) {
      return this.requests.filter((r) => r.url.includes(needle)).length;
    },
    async push(type, data) {
      const frame = `id: 1\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      await act(async () => {
        for (const send of streams) send(frame);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };

  const entry = {
    agent: {
      id: AGENT_ID,
      name: 'fable',
      orgId: ORG_ID,
      emailAddress: 'address' in opts ? opts.address : AGENT_ADDRESS,
      online: true,
      lastSeenAt: '2026-08-31T11:00:00Z',
      sharing: 'selected',
      createdAt: '2026-08-01T00:00:00Z',
    },
    owner: opts.owner ?? { id: 'usr_1', displayName: 'Jake' },
    sharedBy: opts.sharedBy ?? null,
    rooms: [],
    sharedWith: [],
    emailUnreadCount: opts.emailUnreadCount ?? null,
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    rec.requests.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    const custom = opts.handle?.(url, init);
    if (custom) return custom;

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: ME });
    if (url.includes('/me/orgs')) {
      return json({
        items: [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: opts.role ?? 'owner' }],
      });
    }
    if (url.includes('/me/events')) {
      // A REAL SSE body, held open, so `rec.push` can deliver live frames to
      // every subscriber the page opened.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(': open\n\n'));
          streams.push((s) => c.enqueue(new TextEncoder().encode(s)));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes(`/orgs/${ORG_ID}/me/humans`)) return json({ items: [] });
    if (url.includes(`/orgs/${ORG_ID}/me/agents`)) return json({ items: [entry] });
    if (url.includes(`/orgs/${ORG_ID}/enrollments`)) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    // Empty defaults for every v4 surface a tab may reach for. The two
    // TRANSCRIPT lists answer `{ items, nextBefore }`; contacts is a plain list.
    if (url.includes('/activity')) return json({ items: [], nextBefore: null });
    if (url.includes('/email/threads')) return json({ items: [], nextBefore: null });
    if (url.includes('/email/contacts')) return json({ items: [], nextCursor: null });
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
  useFetch(fetchMock as unknown as typeof fetch);

  const view = render(
    <MemoryRouter initialEntries={[opts.url ?? '/org/1/agents/1']}>
      <CapabilitiesProvider initial={opts.caps ?? CAPS_EMAIL}>
        <AuthProvider>
          <OrgProvider orgId={ORG_ID}>
            <WorkspaceProvider activeRoomId={null}>
              <Routes>
                <Route path="/org/:orgId" element={<div>ORG HOME</div>} />
                <Route path="/org/:orgId/agents/:agentId" element={<AgentProfile />} />
                <Route path="/org/:orgId/rooms/:roomId" element={<RoomStub />} />
              </Routes>
            </WorkspaceProvider>
          </OrgProvider>
        </AuthProvider>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );

  return { rec, ...view };
}

function RoomStub() {
  const { roomId } = useParams<{ roomId: string }>();
  return <div>ROOM {roomId}</div>;
}
