import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Outlet, useParams } from 'react-router-dom';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { OrgHome } from './OrgHome.js';

/**
 * The `api` singleton binds `globalThis.fetch` at import time, so stubbing the
 * global alone never reaches it — point the client's `_fetch` at the mock too
 * (and stub the global for the bare-`fetch` config probe), restoring afterwards.
 */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorder {
  calls: { method: string; url: string }[];
}

function homeFetchMock(opts: { invitations?: unknown[] }, rec: Recorder) {
  const invitations = opts.invitations ?? [];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') rec.calls.push({ method, url });

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }] });
    }
    if (url.includes('/me/events')) return json('');
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) return json({ items: [] });
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/me/room-invitations/rin_1/accept')) {
      return json({
        room: {
          id: 'room_7',
          orgId: 'org_1',
          name: 'Launch',
          kind: 'project',
          archivedAt: null,
          settings: { description: '' },
        },
        member: {
          id: 'mem_1',
          kind: 'human', avatarUrl: null,
          principalId: 'usr_1',
          displayName: 'Jake',
          roomRole: 'member',
          lastSeenAt: null,
          createdAt: '2026-08-01T00:00:00Z',
        },
      });
    }
    if (url.includes('/me/room-invitations/rin_1/decline')) return json({ ok: true });
    if (url.includes('/me/room-invitations')) return json({ items: invitations });
    if (url.includes('/me/rooms')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function RoomStub() {
  const { roomId } = useParams<{ roomId: string }>();
  return <div>ROOM {roomId}</div>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/org/org_1']}>
      <AuthProvider>
        <OrgProvider orgId="org_1">
          <WorkspaceProvider activeRoomId={null}>
            <Routes>
              <Route path="/org/:orgId" element={<OrgHome />} />
              <Route path="/org/:orgId/rooms/:roomId" element={<RoomStub />} />
              <Route path="/org/:orgId/settings" element={<div>ORG SETTINGS</div>} />
            </Routes>
          </WorkspaceProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const invitation = {
  id: 'rin_1',
  room: { id: 'room_7', name: 'Launch', orgId: 'org_1' },
  invitedBy: { id: 'usr_9', displayName: 'Otto' },
  createdAt: '2026-08-19T00:00:00Z',
};

describe('OrgHome', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  // Before #48 every route left index.html's marketing title in the tab.
  it('titles the document with the org name', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHome();
    await screen.findByText(/welcome to acme/i);
    expect(document.title).toBe('Acme — sparrow');
  });

  it('greets by org name and links admins to settings', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHome();
    expect(await screen.findByText(/welcome to acme/i)).toBeInTheDocument();
    expect(screen.getByText(/pick a conversation from the sidebar/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open org settings/i })).toBeInTheDocument();
  });

  /* ---- first-run copy names REAL controls (issue #38) ------------------- */
  // Every control named here must exist in AppShell with exactly this label:
  // the HUMANS "+" is `Invite a person`, the AGENTS "+" is `Invite an agent`,
  // and the ROOMS "+" (at the TOP of the section) is `Create a room`.
  async function bullets(): Promise<string[]> {
    await screen.findByText(/welcome to acme/i);
    return screen
      .getAllByRole('listitem')
      .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
  }

  it('points at the real sidebar controls, by their real labels', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHome();
    const [message, agent, room] = await bullets();

    expect(message).toContain('click a name under HUMANS or AGENTS');
    expect(message).toContain('the + beside HUMANS');
    expect(message).toContain('Invite a person');

    expect(agent).toContain('the + beside AGENTS');
    expect(agent).toContain('Invite an agent');

    expect(room).toContain('the + at the top of the ROOMS section');
    expect(room).toContain('Create a room');
  });

  it('names no control the shell does not render', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHome();
    const text = (await bullets()).join(' ');
    // The old copy invented three: a "New DM" button, a "New room" control at
    // the foot of the sidebar, and an "Invite" in the top bar (which is not even
    // rendered at mobile widths).
    expect(text).not.toContain('New DM');
    expect(text).not.toContain('New room');
    expect(text).not.toMatch(/foot of the sidebar/i);
    expect(text).not.toMatch(/top bar/i);
  });

  /* ---- copy follows POLICY, not just the label list (issues #38 + #43) ---- */
  // Once `invites.who`/`rooms.create` are admins-only the shell hides those "+"
  // buttons — so for a member the copy naming them is the SAME bug #38 was.
  function renderHomeWithPolicy(policy: { canInvite: boolean; canCreateRoom: boolean }) {
    return render(
      <MemoryRouter initialEntries={['/org/org_1']}>
        <AuthProvider>
          <OrgProvider orgId="org_1">
            <WorkspaceProvider activeRoomId={null}>
              <Routes>
                <Route
                  path="/org/:orgId"
                  element={<Outlet context={{ reportBroadcastUnread: () => {}, policy }} />}
                >
                  <Route index element={<OrgHome />} />
                </Route>
              </Routes>
            </WorkspaceProvider>
          </OrgProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('drops the invite + create-room bullets when policy hides those controls', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHomeWithPolicy({ canInvite: false, canCreateRoom: false });
    const text = (await bullets()).join(' ');
    expect(text).not.toContain('Invite a person');
    expect(text).not.toContain('Invite an agent');
    expect(text).not.toContain('Create a room');
    // ...and says why, rather than leaving the reader with only "click a name".
    expect(text).toMatch(/keeps invites and new rooms with its admins/i);
  });

  it('keeps each bullet the policy does allow', async () => {
    useFetch(homeFetchMock({}, rec));
    renderHomeWithPolicy({ canInvite: true, canCreateRoom: false });
    const text = (await bullets()).join(' ');
    expect(text).toContain('Invite a person');
    expect(text).toContain('Invite an agent');
    expect(text).not.toContain('Create a room');
  });

  it('surfaces pending room invitations with Accept / Decline', async () => {
    useFetch(homeFetchMock({ invitations: [invitation] }, rec));
    renderHome();
    expect(await screen.findByRole('heading', { name: /room invitations/i })).toBeInTheDocument();
    expect(screen.getByText('Launch')).toBeInTheDocument();
    expect(screen.getByText(/invited by otto/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('Accept joins the room and navigates into it', async () => {
    useFetch(homeFetchMock({ invitations: [invitation] }, rec));
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: /accept/i }));
    expect(await screen.findByText(/ROOM 7/)).toBeInTheDocument();
    expect(rec.calls.some((c) => c.url.includes('/me/room-invitations/rin_1/accept'))).toBe(true);
  });

  it('Decline resolves the invitation', async () => {
    useFetch(homeFetchMock({ invitations: [invitation] }, rec));
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: /decline/i }));
    await waitFor(() =>
      expect(
        rec.calls.some((c) => c.url.includes('/me/room-invitations/rin_1/decline')),
      ).toBe(true),
    );
  });
});
