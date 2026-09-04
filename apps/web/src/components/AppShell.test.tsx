import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { api } from '../lib/client.js';
import { approvalItem, preview } from '../test/fixtures.js';
import { AppShell } from './AppShell.js';

/** Point the shared client's `_fetch` at the mock (see AgentProfile.test). */
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

interface Opts {
  invitesWho?: 'members' | 'admins';
  /** `settings.rooms.create` — gates the ROOMS "+" exactly like `invites.who`. */
  roomsCreate?: 'members' | 'admins';
  role?: 'owner' | 'admin' | 'member';
  /** When true, `/me/rooms` also carries a PROJECT room (`room_p`, "deploys"). */
  projectRoom?: boolean;
  /** Overrides that project room's name — for the narrow-header overflow test. */
  roomName?: string;
  /** When true, /me/events pushes a wrapped member.joined for a NEW DM room and
   * the HUMANS source starts empty then gains the counterpart on reload. */
  liveJoin?: boolean;
  /** When true, the AGENTS source returns one agent OWNED by the caller. */
  ownedAgent?: boolean;
  /**
   * That agent's `emailUnreadCount` — the visibility list's owner-only mail
   * count, and the only producer of the AGENTS badge's email half. `null` is
   * what a shared-to-me agent (or an instance with the medium off) carries.
   */
  agentEmailUnread?: number | null;
  /** When true, the HUMANS source returns one offline, never-seen member
   * (no shared room: `online: false`, `lastSeenAt: null`). */
  neverSeenHuman?: boolean;
  /** When true, `GET /config` returns 200 (the instance exposes a config surface). */
  exposeConfig?: boolean;
  /** Pending enrollments returned by `GET /orgs/org_1/enrollments`. */
  enrollments?: unknown[];
  /** Rows returned by `GET /orgs/org_1/email/approvals`. */
  emailApprovals?: unknown[];
  /**
   * When set, the caller has a DM room with `agt_1` holding this many unread
   * chat messages (hydrated through the room stream's inbox resync).
   */
  dmUnread?: number;
}
interface Recorder {
  calls: { method: string; url: string; body: unknown }[];
  /** Every request URL, GET included (the capability gate is a NON-fetch). */
  urls: string[];
}

function shellFetchMock(opts: Opts, rec: Recorder) {
  const invitesWho = opts.invitesWho ?? 'members';
  const roomsCreate = opts.roomsCreate ?? 'members';
  const role = opts.role ?? 'member';
  let humansCalls = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    rec.urls.push(url);
    if (method !== 'GET') rec.calls.push({ method, url, body });

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role }] });
    }
    if (url.includes('/me/events')) {
      if (!opts.liveJoin) return json('');
      // A wrapped member.joined for a room we don't know yet → the gaining
      // principal must refetch its sidebar sources (no manual reload).
      const evt =
        `: open\n\n` +
        `event: member.joined\n` +
        `data: ${JSON.stringify({
          room: { id: 'room_dm', name: '', orgId: 'org_1', kind: 'dm' },
          member: {
            id: 'mem_9',
            kind: 'human', avatarUrl: null,
            principalId: 'usr_9',
            displayName: 'Mira',
            roomRole: 'member',
            lastSeenAt: null,
            createdAt: '2026-08-01T00:00:00Z',
          },
        })}\n\n`;
      return new Response(evt, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    // getOrg (settings.invites.who) — must precede the generic /orgs branch.
    if (/\/orgs\/org_1$/.test(url.split('?')[0]!)) {
      return json({
        org: {
          id: 'org_1',
          name: 'Acme',
          slug: 'acme',
          settings: {
            invites: { who: invitesWho },
            enroll: { agents: 'approval' },
            rooms: { create: roomsCreate },
          },
          createdAt: '2026-08-01T00:00:00Z',
        },
      });
    }
    if (url.includes('/orgs/org_1/me/humans')) {
      humansCalls += 1;
      // liveJoin: empty on the initial load, then gains Mira once the
      // member.joined event triggers a reload.
      const items =
        opts.liveJoin && humansCalls > 1
          ? [{ human: { id: 'usr_9', displayName: 'Mira', avatarUrl: null }, online: true, lastSeenAt: null }]
          : opts.neverSeenHuman
            ? [{ human: { id: 'usr_2', displayName: 'Mira', avatarUrl: null }, online: false, lastSeenAt: null }]
            : [];
      return json({ items });
    }
    if (url.includes('/orgs/org_1/me/agents')) {
      const items = opts.ownedAgent
        ? [
            {
              agent: {
                id: 'agt_1',
                name: 'Botty',
                orgId: 'org_1',
                online: true,
                lastSeenAt: null,
                createdAt: '2026-08-01T00:00:00Z',
              },
              owner: { id: 'usr_1', displayName: 'Jake' },
              sharedBy: null,
              rooms: [],
              sharedWith: [],
              emailUnreadCount: opts.agentEmailUnread ?? null,
            },
          ]
        : [];
      return json({ items });
    }
    if (url.includes('/orgs/org_1/email/approvals')) {
      return json({ items: opts.emailApprovals ?? [], nextCursor: null });
    }
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: opts.enrollments ?? [] });
    // The project room's live badge sources (only present with `projectRoom`).
    if (url.includes('/rooms/room_p/events')) return json('');
    if (url.includes('/rooms/room_p/inbox')) return json({ items: [], nextCursor: null });
    if (url.includes('/rooms/room_p/status')) return json({ items: [], presence: { online: [] } });
    // The DM room's live badge sources (stream + unread inbox + status).
    if (url.includes('/rooms/room_dm/events')) return json('');
    if (url.includes('/rooms/room_dm/inbox')) {
      const items = Array.from({ length: opts.dmUnread ?? 0 }, (_, i) => ({
        id: `msg_${i}`,
        from: { id: 'mem_bot', kind: 'agent', principalId: 'agt_1', displayName: 'Botty', avatarUrl: null },
        kind: 'dm',
        subject: null,
        preview: 'ping',
        truncated: false,
        attachmentCount: 0,
        status: 'unread',
        createdAt: '2026-08-31T00:00:00Z',
      }));
      return json({ items, nextCursor: null });
    }
    if (url.includes('/rooms/room_dm/status')) return json({ items: [], presence: { online: [] } });
    if (url.includes('/orgs/org_1/directory')) {
      return json({ items: [{ id: 'usr_2', displayName: 'Mira', email: 'mira@acme.com', avatarUrl: null }] });
    }
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) {
      const items: unknown[] = [];
      if (opts.dmUnread !== undefined) {
        items.push({
          room: {
            id: 'room_dm',
            name: '',
            orgId: 'org_1',
            kind: 'dm',
            archivedAt: null,
            counterpart: { type: 'agent', id: 'agt_1', displayName: 'Botty', avatarUrl: null },
          },
          memberId: 'mem_me',
          roomRole: 'member',
        });
      }
      if (opts.projectRoom) {
        items.push({
          room: {
            id: 'room_p',
            name: opts.roomName ?? 'deploys',
            orgId: 'org_1',
            kind: 'project',
            archivedAt: null,
          },
          memberId: 'mem_me2',
          roomRole: 'member',
        });
      }
      return json({ items });
    }
    if (url.includes('/orgs/org_1/invites') && method === 'POST') {
      return json(
        {
          invite: {
            id: 'inv_1',
            inviter: { id: 'usr_1', displayName: 'Jake' },
            note: null,
            expiresAt: '2026-09-01T00:00:00Z',
            revokedAt: null,
            createdAt: '2026-08-20T00:00:00Z',
          },
          url: 'https://sparrow.example.com/invite/ivk_secrettoken',
        },
        201,
      );
    }
    if (url.includes('/me/dms') && method === 'POST') {
      return json(
        {
          room: { id: 'room_dm', kind: 'dm', orgId: 'org_1' },
          counterpart: { type: 'human', id: 'usr_2', displayName: 'Mira', avatarUrl: null },
          memberId: 'mem_1',
        },
        201,
      );
    }
    if (url.includes('/api/v1/config')) {
      return opts.exposeConfig
        ? json({ values: {} })
        : json({ error: { code: 'not_found', message: 'x' } }, 404);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function renderShell(caps?: CapabilitiesResponse, activeRoomId: string | null = null) {
  return render(
    <MemoryRouter
      initialEntries={[activeRoomId ? `/org/org_1/rooms/${activeRoomId}` : '/org/org_1']}
    >
      <AuthProvider>
        <CapabilitiesProvider initial={caps}>
          <OrgProvider orgId="org_1">
            <WorkspaceProvider activeRoomId={activeRoomId}>
              <Routes>
                <Route path="/org/:orgId" element={<AppShell />}>
                  <Route index element={<div>ORG HOME</div>} />
                  <Route path="rooms/:roomId" element={<div>ROOM</div>} />
                </Route>
              </Routes>
            </WorkspaceProvider>
          </OrgProvider>
        </CapabilitiesProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppShell — unified invite UX', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [], urls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  it('shows the topnav Invite button when invites.who = members (any role)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    expect(await screen.findByRole('button', { name: /^invite$/i })).toBeInTheDocument();
  });

  it('hides the topnav Invite button when invites.who = admins and the caller is a member', async () => {
    useFetch(shellFetchMock({ invitesWho: 'admins', role: 'member' }, rec));
    renderShell();
    // Wait for the org list to load (Sign out appears once booted).
    await screen.findByRole('button', { name: /sign out/i });
    await waitFor(() => expect(rec.calls).toBeDefined());
    expect(screen.queryByRole('button', { name: /^invite$/i })).not.toBeInTheDocument();
  });

  it('the topnav Invite button asks who is being invited (org already has agents)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', ownedAgent: true }, rec));
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: /^invite$/i }));
    const dialog = await screen.findByRole('dialog', { name: /^invite$/i });
    expect(within(dialog).getByText('Who are you inviting to Acme?')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /a person/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /an agent/i })).toBeInTheDocument();
  });

  it('the topnav Invite button STILL asks who for an org with no agents yet', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members' }, rec));
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: /^invite$/i }));
    const dialog = await screen.findByRole('dialog', { name: /^invite$/i });
    // One door: a brand-new owner inviting a teammate must not land on the
    // agent step. The zero-agent short-cut is the AGENTS + entry point's.
    expect(within(dialog).getByText('Who are you inviting to Acme?')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /a person/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /an agent/i })).toBeInTheDocument();
    expect(within(dialog).queryByText('Your first agent.')).not.toBeInTheDocument();
    // WHO needs no URL, so nothing is minted until a step actually asks for one.
    expect(rec.calls.some((c) => c.method === 'POST' && c.url.includes('/orgs/org_1/invites'))).toBe(
      false,
    );
  });

  it('topnav Invite → an agent, in an org with no agents, keeps the lead-in and a way back', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members' }, rec));
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: /^invite$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /an agent/i }));
    expect(await within(dialog).findByText('Your first agent.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /back/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByText(/--url https:\/\/sparrow\.example\.com\/invite\/ivk_secrettoken/),
      ).toBeInTheDocument(),
    );
    expect(rec.calls.some((c) => c.method === 'POST' && c.url.includes('/orgs/org_1/invites'))).toBe(true);
  });

  it('HUMANS + opens the dialog on the person step: by-email form + a shareable link', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'owner' }, rec));
    renderShell();
    // The HUMANS section header "+" (aria-label "Invite a person").
    await userEvent.click(await screen.findByRole('button', { name: /invite a person/i }));
    const dialog = await screen.findByRole('dialog', { name: /invite a person/i });
    expect(within(dialog).getByLabelText(/invite by email/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByText('https://sparrow.example.com/invite/ivk_secrettoken'),
      ).toBeInTheDocument(),
    );
  });

  it('hides the HUMANS + for a member when only admins may invite', async () => {
    useFetch(shellFetchMock({ invitesWho: 'admins', role: 'member' }, rec));
    renderShell();
    await screen.findByRole('button', { name: /sign out/i });
    await waitFor(() => expect(rec.calls).toBeDefined());
    expect(screen.queryByRole('button', { name: /invite a person/i })).not.toBeInTheDocument();
  });

  it('AGENTS + opens the dialog on the agent step (no chooser, no create-agent flow)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members' }, rec));
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: /invite an agent/i }));
    const dialog = await screen.findByRole('dialog', { name: /invite an agent/i });
    expect(within(dialog).getByText('How should the agent connect?')).toBeInTheDocument();
    // This org has no agents yet: the lead-in shows, and there is no WHO behind
    // this entry point, so no back chip either.
    expect(within(dialog).getByText('Your first agent.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    // Harness is the default: the install + harness command, against this invite.
    // The installer is the canonical one (SPEC: *Canonical public homes*) — the
    // instance's own origin only carries the invite URL.
    await waitFor(() =>
      expect(
        within(dialog).getByText(/curl -fsSL https:\/\/sparrow\.land\/install\.sh \| sh/),
      ).toBeInTheDocument(),
    );
    // Inline shows the invitation blob instead — the same invite, no second mint.
    await userEvent.click(within(dialog).getByRole('radio', { name: /inline/i }));
    await waitFor(() =>
      expect(
        within(dialog).getByText(/sparrow enroll https:\/\/sparrow\.example\.com\/invite\/ivk_/),
      ).toBeInTheDocument(),
    );
    expect(within(dialog).getByText(/Jake is inviting you to join Acme/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/agent name/i)).not.toBeInTheDocument();
    expect(
      rec.calls.filter((c) => c.method === 'POST' && c.url.includes('/orgs/org_1/invites')),
    ).toHaveLength(1);
  });

  it('does NOT render a "yours" pill next to an owned agent in the sidebar list', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', ownedAgent: true }, rec));
    renderShell();
    // The owned agent is present in the AGENTS list...
    expect(await screen.findByText('Botty')).toBeInTheDocument();
    // ...but the leftnav no longer decorates it with a "yours" pill.
    expect(screen.queryByText('yours')).not.toBeInTheDocument();
  });

  it('renders a never-seen member dimmed, and DM-start opens/creates the DM', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', neverSeenHuman: true }, rec));
    renderShell();
    // The member (no shared room, never active) still appears in the HUMANS list.
    const row = await screen.findByRole('button', { name: /mira/i });
    // Dimmed: the "exists but never here" style (subtle reduced opacity).
    expect(row.className).toContain('opacity-60');
    // DM-start does not assume a shared room: clicking POSTs /me/dms and routes in.
    await userEvent.click(row);
    await waitFor(() =>
      expect(rec.calls.some((c) => c.method === 'POST' && c.url.includes('/me/dms'))).toBe(true),
    );
    expect(await screen.findByText('ROOM')).toBeInTheDocument();
  });

  it('never renders an "Instance" nav link, even when the instance exposes /config', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'owner', exposeConfig: true }, rec));
    renderShell();
    // Wait for the shell to boot (Sign out + the Org admin link, since owner).
    await screen.findByRole('button', { name: /sign out/i });
    expect(await screen.findByRole('link', { name: /org admin/i })).toBeInTheDocument();
    // Even with /config exposed, the instance-settings UI is gone for good — no nav link.
    await waitFor(() => expect(rec.calls).toBeDefined());
    expect(screen.queryByRole('link', { name: /^instance$/i })).not.toBeInTheDocument();
  });

  // --- Mobile header: the account nav must not widen the page on phones ------
  // Regression for "the whole mobile screen looks weird": the top-bar account
  // actions used to be a fixed-width (shrink-0), never-collapsing row wider than
  // a phone viewport, forcing page-level horizontal overflow. The nav is now
  // shrinkable and the secondary actions collapse below the `sm` breakpoint.
  // jsdom applies no stylesheet, so we assert the responsive classes are present
  // on the right nodes (box-model behaviour is reasoned about, not laid out).
  it('the account nav is shrinkable, not a fixed shrink-0 row', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    const signOut = await screen.findByRole('button', { name: /sign out/i });
    const nav = signOut.closest('nav')!;
    expect(nav.className).toContain('min-w-0');
    expect(nav.className).not.toContain('shrink-0');
  });

  // --- Mobile viewport height: the iOS Safari 100vh trap ---------------------
  // Regression for "the header is pushed off the top of the screen on iPhone":
  // a `h-screen` (100vh) shell is TALLER than Safari's visual viewport (vh
  // counts the collapsing toolbar region), so the whole app overflows and the
  // top bar scrolls out of view. The shell must size to the *dynamic* viewport
  // (100dvh, vh fallback) and pad the header past the status bar via
  // `env(safe-area-inset-top)`. jsdom lays nothing out, so we assert the sizing
  // classes are present on the right nodes.
  it('sizes the app shell to the dynamic viewport, not 100vh', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    const shell = (await screen.findByRole('banner')).parentElement!;
    expect(shell.className).toContain('app-height');
    expect(shell.className).not.toContain('h-screen');
  });

  it('pads the top bar past the iOS status bar (safe-area-inset-top)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    const header = await screen.findByRole('banner');
    expect(header.className).toContain('app-header');
    // The old fixed 3rem bar (h-12) tucked under the status bar — gone.
    expect(header.className).not.toContain('h-12');
  });

  it('offsets the mobile drawer + backdrop below the safe-area header', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    await screen.findByRole('button', { name: /sign out/i });
    const sidebar = document.getElementById('app-sidebar')!;
    expect(sidebar.className).toContain('top-app-header');
    expect(sidebar.className).not.toContain('top-12');
  });

  it('collapses the Invite button below the sm breakpoint (hidden sm:inline-flex)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    const invite = await screen.findByRole('button', { name: /^invite$/i });
    expect(invite.className).toContain('hidden');
    expect(invite.className).toContain('sm:inline-flex');
  });

  it('collapses the Org admin link below the sm breakpoint (hidden sm:inline-block)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'owner' }, rec));
    renderShell();
    const admin = await screen.findByRole('link', { name: /org admin/i });
    expect(admin.className).toContain('hidden');
    expect(admin.className).toContain('sm:inline-block');
  });

  it('keeps Sign out visible on mobile (never collapsed)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    const signOut = await screen.findByRole('button', { name: /sign out/i });
    expect(signOut.className).not.toContain('hidden');
  });

  it('live-refreshes the sidebar when /me/events delivers a member.joined for a new DM room', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', liveJoin: true }, rec));
    renderShell();
    // The HUMANS source returns [] on the initial load; it only yields the
    // counterpart on a SECOND call — which happens solely because the wrapped
    // member.joined for an unknown DM room triggers a sidebar refetch. So the
    // counterpart appearing proves the live refresh fired (no manual reload).
    expect(await screen.findByText('Mira')).toBeInTheDocument();
  });

  // --- Org identity moved into the leftnav header (change #2 / #3) -----------
  const noSwitcher: CapabilitiesResponse = {
    email: false,
    emailReviewer: false,
    voice: { stt: false, tts: false, sttStreaming: false },
    orgHostSuffix: null,
    workspaceSwitcher: null,
  };

  it('renders the org name in the leftnav header, not the top bar (plain label default)', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell(noSwitcher);
    await screen.findByRole('button', { name: /sign out/i });

    // The org name lives in the sidebar…
    const sidebar = document.getElementById('app-sidebar')!;
    expect(within(sidebar).getByText('Acme')).toBeInTheDocument();
    // …and NOT in the top bar (banner).
    expect(within(screen.getByRole('banner')).queryByText('Acme')).not.toBeInTheDocument();
    // Default = plain, non-interactive label: no switcher button in the header.
    expect(within(sidebar).queryByRole('button', { name: /acme/i })).not.toBeInTheDocument();
  });

  it('renders a workspace switcher button in the leftnav when capabilities advertise one', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell({
      ...noSwitcher,
      workspaceSwitcher: { directoryUrl: 'https://dir.example.com/api/v1/me/workspaces', createUrl: null },
    });
    await screen.findByRole('button', { name: /sign out/i });

    const sidebar = document.getElementById('app-sidebar')!;
    const header = within(sidebar).getByRole('button', { name: /acme/i });
    expect(header).toHaveAttribute('aria-haspopup', 'menu');
  });

  /* ------------------------------------------------------------------ */
  /* v4: the top-nav pending pill and the AGENTS badge fold             */
  /* ------------------------------------------------------------------ */

  const emailCaps: CapabilitiesResponse = { ...noSwitcher, email: true };

  /** A pending enrollment arriving through MY invite. */
  const myEnrollment = {
    id: 'enr_1',
    kind: 'agent',
    proposedName: 'Scout',
    note: null,
    inviter: { id: 'usr_1', displayName: 'Jake' },
    createdAt: '2026-08-30T00:00:00Z',
  };

  it('the pending pill is ONE number to ONE destination, split in the tooltip', async () => {
    useFetch(
      shellFetchMock(
        { ownedAgent: true, enrollments: [myEnrollment], emailApprovals: [approvalItem()] },
        rec,
      ),
    );
    renderShell(emailCaps);

    const pill = await screen.findByRole('link', { name: /2 pending/i });
    expect(pill).toHaveAttribute('href', '/me/approvals');
    expect(pill).toHaveAttribute('title', '2 waiting — 1 enrollment, 1 email');
  });

  it('counts only email approvals for agents the caller OWNS', async () => {
    // The route returns EVERY agent's approvals to an org owner/admin; the
    // PERSONAL pill is about the caller's own agents (org-wide is org admin).
    useFetch(
      shellFetchMock(
        {
          role: 'owner',
          ownedAgent: true,
          enrollments: [],
          emailApprovals: [
            approvalItem(),
            approvalItem({
              email: preview({ id: 'eml_other', disposition: 'quarantined', status: 'unread' }),
              agent: { id: 'agt_coworker', name: 'pat-bot' },
            }),
          ],
        },
        rec,
      ),
    );
    renderShell(emailCaps);

    const pill = await screen.findByRole('link', { name: /1 pending/i });
    expect(pill).toHaveAttribute('title', '1 waiting — 1 email');
  });

  it('with the email medium off the pill counts enrollments only, in v3 wording', async () => {
    useFetch(shellFetchMock({ enrollments: [myEnrollment], emailApprovals: [approvalItem()] }, rec));
    renderShell(noSwitcher);

    const pill = await screen.findByRole('link', { name: /1 pending/i });
    expect(pill).toHaveAttribute('href', '/me/approvals');
    expect(pill).toHaveAttribute('title', '1 pending request from your invites');
    // Render is gated AND so is discovery of the queue: nothing asks for it.
    expect(rec.urls.some((u) => u.includes('/email/approvals'))).toBe(false);
  });

  it('folds unread into ONE agent badge whose tooltip breaks it down in text', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 2, agentEmailUnread: 3 }, rec));
    renderShell(emailCaps);

    // ONE number per agent = unread chat + unread email, and the split lives in
    // the tooltip text (the v3 rule: a tooltip always carries its state in text).
    expect(await screen.findByText('Botty')).toBeInTheDocument();
    const badge = await screen.findByTitle('5 unread — 2 messages, 3 emails');
    expect(badge).toHaveTextContent('5');
  });

  it('an agent whose emailUnreadCount is null badges exactly v3’s chat count', async () => {
    // `null` is what a shared-to-me agent carries, and what EVERY agent carries
    // when the email medium is off — never folded in as a zero, never guessed.
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 2, agentEmailUnread: null }, rec));
    renderShell(emailCaps);

    expect(await screen.findByText('Botty')).toBeInTheDocument();
    const badge = await screen.findByTitle('2 unread — 2 messages');
    expect(badge).toHaveTextContent('2');
  });

  it('email unread alone badges an agent with no unread chat at all', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, agentEmailUnread: 4 }, rec));
    renderShell(emailCaps);

    expect(await screen.findByText('Botty')).toBeInTheDocument();
    const badge = await screen.findByTitle('4 unread — 4 emails');
    expect(badge).toHaveTextContent('4');
  });
});

describe('AppShell — leftnav affordances (Jake, 2026-09-02)', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [], urls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  it('the ACTIVE agent row is highlighted with a filled background, like the human rows', async () => {
    // dmUnread: 0 → the DM room exists (so Botty CAN be active) with no unread.
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 0 }, rec));
    renderShell(undefined, 'room_dm'); // viewing Botty's DM

    const btn = await screen.findByRole('button', { name: /Botty/ });
    expect(btn).toHaveAttribute('aria-current', 'page');
    // The highlight lives on the row wrapper (button + gear share it).
    expect(btn.closest('div')!.className).toContain('bg-[var(--sparrow-panel-2)]');
  });

  it('an agent with unread renders its NAME bold — the badge alone was missed', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 2 }, rec));
    renderShell();

    const name = await screen.findByText('Botty');
    await waitFor(() => expect(name.className).toContain('font-semibold'));
    // …and reads as text, not muted, so the bolding is visible.
    expect(name.className).toContain('text-[var(--sparrow-text)]');
  });

  it('no unread → the name stays regular weight', async () => {
    useFetch(shellFetchMock({ ownedAgent: true }, rec));
    renderShell();

    const name = await screen.findByText('Botty');
    expect(name.className).not.toContain('font-semibold');
  });

  it('"New room" is a + on the Rooms section header (like Agents/Humans), not a footer link', async () => {
    useFetch(shellFetchMock({}, rec));
    renderShell();
    await screen.findByText('Rooms');

    // The old bottom-of-sidebar button is gone…
    expect(screen.queryByRole('button', { name: /^New room$/i })).toBeNull();
    // …replaced by the header +, which opens the create modal.
    const plus = screen.getByRole('button', { name: 'Create a room' });
    await userEvent.click(plus);
    expect(await screen.findByRole('heading', { name: /new room/i })).toBeInTheDocument();
  });

  // --- Sidebar gears are always visible (issue #49) --------------------------
  // The row gears used to be `md:opacity-0` — invisible until hover, so on a
  // desktop pointer they were undiscoverable and on a touch screen they were a
  // coin flip. They stay muted, but they never hide.
  it('the AGENTS row gear is always visible (no hover-only opacity trick)', async () => {
    useFetch(shellFetchMock({ ownedAgent: true }, rec));
    renderShell();
    const gear = await screen.findByRole('link', { name: /profile for botty/i });
    expect(gear.className).not.toContain('md:opacity-0');
    expect(gear.className).not.toContain('group-hover:opacity-100');
  });

  it('the ROOMS row gear is always visible (no hover-only opacity trick)', async () => {
    useFetch(shellFetchMock({ projectRoom: true }, rec));
    renderShell();
    const gear = await screen.findByRole('link', { name: /settings for deploys/i });
    expect(gear.className).not.toContain('md:opacity-0');
    expect(gear.className).not.toContain('group-hover:opacity-100');
  });
});

/* -------------------------------------------------------------------------- */
/* Policy gating of the sidebar "add" affordances (issues #37, #43)            */
/* -------------------------------------------------------------------------- */

describe('AppShell — org policy gates the sidebar add affordances', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [], urls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  it('hides the AGENTS + for a member when only admins may invite', async () => {
    useFetch(shellFetchMock({ invitesWho: 'admins', role: 'member' }, rec));
    renderShell();
    // The section itself is still there; only its "+" is gone — the member never
    // opens a modal that can only end in a 403.
    expect(await screen.findByText('Agents')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /invite an agent/i })).not.toBeInTheDocument(),
    );
  });

  it('keeps the AGENTS + for an admin when only admins may invite', async () => {
    useFetch(shellFetchMock({ invitesWho: 'admins', role: 'admin' }, rec));
    renderShell();
    expect(await screen.findByRole('button', { name: /invite an agent/i })).toBeInTheDocument();
  });

  it('keeps the AGENTS + for a member when anyone may invite', async () => {
    useFetch(shellFetchMock({ invitesWho: 'members', role: 'member' }, rec));
    renderShell();
    expect(await screen.findByRole('button', { name: /invite an agent/i })).toBeInTheDocument();
  });

  it('hides Create a room for a member when rooms.create = admins', async () => {
    useFetch(shellFetchMock({ roomsCreate: 'admins', role: 'member' }, rec));
    renderShell();
    expect(await screen.findByText('Rooms')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create a room' })).not.toBeInTheDocument(),
    );
  });

  it('keeps Create a room for an admin when rooms.create = admins', async () => {
    useFetch(shellFetchMock({ roomsCreate: 'admins', role: 'admin' }, rec));
    renderShell();
    expect(await screen.findByRole('button', { name: 'Create a room' })).toBeInTheDocument();
  });

  it('keeps Create a room for a member when rooms.create = members', async () => {
    useFetch(shellFetchMock({ roomsCreate: 'members', role: 'member' }, rec));
    renderShell();
    expect(await screen.findByRole('button', { name: 'Create a room' })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Mobile top bar: the room title must have room to read (issue #45)           */
/* -------------------------------------------------------------------------- */

describe('AppShell — mobile top-bar title', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [], urls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  // jsdom lays nothing out, so this asserts the flex sizing contract: the title
  // takes the remaining space and reserves a floor, instead of being a zero-basis
  // `min-w-0 flex-1` that a wide account nav squeezed down to a ~5px sliver.
  //
  // That floor is now `sm`-and-up only. At phone widths it was itself part of
  // the overflow (Jake's iPhone session: 413px of content in a 390px viewport),
  // and the room title is no longer the thing that has to give — the nav drops
  // the "Sign out" label to an icon instead, which buys back more than the
  // floor ever protected.
  it('reserves a readable minimum width for the active room title from sm up', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 0 }, rec));
    renderShell(undefined, 'room_dm');
    const title = await screen.findByText('@Botty');
    const holder = title.parentElement!;
    expect(holder.className).toContain('flex-1');
    expect(holder.className).toMatch(/sm:min-w-\[\d/);
    // Below `sm` it must be free to shrink — nothing may outrank the viewport.
    expect(holder.className).toContain('min-w-0');
  });

  // The nav is still the shrinkable side, but its two always-present items now
  // shrink DELIBERATELY (issue #58): under 430px the caller name collapsed to a
  // single glyph and "Sign out" wrapped onto two lines.
  it('truncates the caller name to a readable floor, never to one glyph', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 0 }, rec));
    renderShell(undefined, 'room_dm');
    const name = await screen.findByTitle('Your settings');
    expect(name.className).toContain('truncate');
    // A floor to truncate DOWN TO — `min-w-0` let it shrink to nothing.
    expect(name.className).toMatch(/min-w-\[\d/);
    expect(name.className).not.toContain('min-w-0');
    expect(name.className).toMatch(/max-w-\[\d/);
  });

  // Issue #53: without a skip link, reaching the conversation from the keyboard
  // meant re-tabbing every human, agent and room — on every navigation.
  it('leads with a skip link into the shared main-content landmark', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 0 }, rec));
    const { container } = renderShell(undefined, 'room_dm');
    const link = await screen.findByRole('link', { name: /skip to content/i });
    expect(link).toHaveAttribute('href', '#main-content');
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea'),
    ].filter((el) => el.getAttribute('tabindex') !== '-1' && !el.hasAttribute('disabled'));
    expect(tabbable[0]).toBe(link);
    const main = container.querySelector('#main-content');
    expect(main?.tagName).toBe('MAIN');
  });

  it('never wraps or shrinks the Sign out control', async () => {
    useFetch(shellFetchMock({ ownedAgent: true, dmUnread: 0 }, rec));
    renderShell(undefined, 'room_dm');
    const signOut = await screen.findByRole('button', { name: 'Sign out' });
    expect(signOut.className).toContain('whitespace-nowrap');
    expect(signOut.className).toContain('shrink-0');
  });
});

/* ================================================================== *
 * The top bar at 390px (Jake's iPhone session, 2026-09-04)
 * ================================================================== */

const LONG_TITLE =
  'quarterly deployment coordination and incident review — europe west';

describe('AppShell — the top bar cannot widen the page', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [], urls: [] };
    localStorage.clear();
    useFetch(shellFetchMock({ projectRoom: true, roomName: LONG_TITLE }, rec));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  it('caps the shell so no child can push the document wider than the viewport', async () => {
    // The measured symptom was scrollWidth 413 against clientWidth 390: one
    // over-wide row is enough to make the WHOLE page scroll sideways, which on
    // a phone reads as "the app is broken", not "this row is long".
    const { container } = renderShell(undefined, 'room_p');
    await screen.findByText('ROOM');
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain('overflow-x-hidden');
    expect(shell.className).toContain('max-w-full');
  });

  it('truncates a long room title instead of shouldering the account nav off-screen', async () => {
    const { container } = renderShell(undefined, 'room_p');
    // The sidebar lists the room too; this is about the TOP BAR.
    const header = container.querySelector('header') as HTMLElement;
    const title = await within(header).findByText(`#${LONG_TITLE}`);
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
    // Its container must be free to shrink too — a min-width floor on the title
    // is exactly what pushed the nav past the right edge.
    const holder = title.parentElement as HTMLElement;
    expect(holder.className).toContain('min-w-0');
  });

  it('keeps Sign out reachable — icon-only on a phone, still named', async () => {
    renderShell(undefined, 'room_p');
    const signOut = await screen.findByRole('button', { name: /sign out/i });
    // Below `md` the label is an icon; the accessible name never goes away.
    expect(signOut.className).toContain('shrink-0');
    const label = within(signOut).getByText('Sign out');
    expect(label.className).toContain('md:inline');
    expect(label.className).toContain('hidden');
  });

  it('still signs out when the icon-only control is tapped', async () => {
    renderShell(undefined, 'room_p');
    const signOut = await screen.findByRole('button', { name: /sign out/i });
    await userEvent.click(signOut);
    await waitFor(() => expect(rec.urls.some((u) => u.includes('/logout'))).toBe(true));
  });
});
