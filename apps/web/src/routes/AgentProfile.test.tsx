import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';
import type { CapabilitiesResponse, OrgRole } from '@sparrow/common-types';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { api } from '../lib/client.js';
import { AgentProfile } from './AgentProfile.js';

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

interface AgentOpts {
  /** The single visibility entry the caller can see, or null for "none". */
  entry?: unknown;
  /** The caller's role in org_1 (drives `useOrg().isAdmin`). Default: owner. */
  role?: OrgRole;
}

/** Capabilities with every optional medium off — the keyless default. */
const CAPS_OFF: CapabilitiesResponse = {
  email: false,
  emailReviewer: false,
  voice: { stt: false, tts: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};
const CAPS_EMAIL: CapabilitiesResponse = { ...CAPS_OFF, email: true };

/** The visibility entry for an owned agent that HAS a derived address. */
const ADDRESSED_ENTRY = {
  agent: {
    id: 'agt_1',
    name: 'deploy-bot',
    orgId: 'org_1',
    emailAddress: 'deploy-bot@acme.example.com',
    online: true,
    lastSeenAt: '2026-08-20T17:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
  },
  owner: { id: 'usr_1', displayName: 'Jake' },
  sharedBy: null,
  rooms: [],
  sharedWith: [],
};

/** An owned agent that HAS a role (title org-visible; instructions owner-only). */
const OWNED_ROLE_ENTRY = {
  agent: {
    id: 'agt_1',
    name: 'deploy-bot',
    orgId: 'org_1',
    online: true,
    lastSeenAt: '2026-08-20T17:00:00Z',
    sharing: 'room-members',
    roleTitle: 'Support triage',
    createdAt: '2026-08-01T00:00:00Z',
  },
  owner: { id: 'usr_1', displayName: 'Jake' },
  sharedBy: null,
  rooms: [],
  sharedWith: [],
  roleInstructions: 'Answer support DMs first; escalate billing.',
};

/** Records every non-boot mutation so tests can assert what the page called. */
interface Recorder {
  calls: { method: string; url: string; body: unknown }[];
}

function agentFetchMock(opts: AgentOpts, rec: Recorder) {
  const ownEntry =
    'entry' in opts
      ? opts.entry
      : {
          agent: {
            id: 'agt_1',
            name: 'deploy-bot',
            orgId: 'org_1',
            online: true,
            lastSeenAt: '2026-08-20T17:00:00Z',
            createdAt: '2026-08-01T00:00:00Z',
          },
          owner: { id: 'usr_1', displayName: 'Jake' },
          sharedBy: null,
          rooms: [{ id: 'room_9', name: 'General', memberId: 'mem_r9' }],
          sharedWith: [{ id: 'usr_2', displayName: 'Mira', createdAt: '2026-08-05T00:00:00Z' }],
        };
  const agents = ownEntry ? [ownEntry] : [];

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') rec.calls.push({ method, url, body });

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({
        items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: opts.role ?? 'owner' }],
      });
    }
    if (url.includes('/orgs/org_1/agents/agt_1/activity')) return json({ items: [], nextCursor: null });
    if (url.includes('/orgs/org_1/agents/agt_1/email/threads')) {
      return json({ items: [], nextCursor: null });
    }
    if (url.includes('/orgs/org_1/email/contacts')) return json({ items: [], nextCursor: null });
    if (url.includes('/me/events')) return json('');
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) return json({ items: agents });
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    if (url.includes('/orgs/org_1/directory')) {
      return json({ items: [{ id: 'usr_2', displayName: 'Mira', email: 'mira@acme.com', avatarUrl: null }] });
    }
    if (url.includes('/me/agents/agt_1/rotate')) {
      return json({
        agent: {
          id: 'agt_1',
          name: 'deploy-bot',
          orgId: 'org_1',
          online: true,
          lastSeenAt: '2026-08-20T17:00:00Z',
          createdAt: '2026-08-01T00:00:00Z',
        },
        key: 'agk_rotated_secret_key',
      });
    }
    if (url.includes('/me/agents/agt_1/share')) return json({ ok: true }, 201);
    if (url.includes('/me/agents/agt_1') && method === 'PATCH') {
      return json({
        agent: {
          id: 'agt_1',
          name: body?.name ?? 'deploy-bot',
          orgId: 'org_1',
          online: true,
          lastSeenAt: '2026-08-20T17:00:00Z',
          sharing: body?.sharing ?? 'selected',
          roleTitle: 'roleTitle' in (body ?? {}) ? body.roleTitle : null,
          createdAt: '2026-08-01T00:00:00Z',
        },
      });
    }
    // Detach an agent from a room (RemoveMember on the agent's member id).
    if (url.includes('/rooms/room_9/members/') && method === 'DELETE') return json({ ok: true });
    if (url.includes('/me/agents/agt_1') && method === 'DELETE') return json({ ok: true });
    if (url.includes('/me/dms')) {
      return json(
        {
          room: { id: 'room_dm', kind: 'dm', orgId: 'org_1' },
          counterpart: { type: 'agent', id: 'agt_1', displayName: 'deploy-bot', avatarUrl: null },
          memberId: 'mem_1',
        },
        201,
      );
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function RoomStub() {
  const { roomId } = useParams<{ roomId: string }>();
  return <div>ROOM {roomId}</div>;
}

function renderProfile(
  entry: string = '/org/org_1/agents/agt_1',
  caps: CapabilitiesResponse = CAPS_OFF,
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CapabilitiesProvider initial={caps}>
        <AuthProvider>
          <OrgProvider orgId="org_1">
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
}

describe('AgentProfile', () => {
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

  it('renders the header + owner affordance for an owned agent', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    expect(await screen.findByRole('heading', { name: 'deploy-bot' })).toBeInTheDocument();
    expect(screen.getByText('yours')).toBeInTheDocument();
    expect(screen.getByText(/owned by you/i)).toBeInTheDocument();
    // Owner controls present.
    expect(screen.getByRole('heading', { name: /^share$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rotate key/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete agent/i })).toBeInTheDocument();
    // Room memberships listed, and the shared-with grantee.
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Mira')).toBeInTheDocument();
  });

  // v4 capabilities gating: the visibility entry carries the agent's derived
  // `emailAddress`, but the page renders NO email surface while
  // `capabilities.email` is false (the default here — no provider is mounted, so
  // the medium reads off, exactly as on a keyless instance). Render is gated;
  // discovery never is. The email wave turns the row on behind the flag.
  it('renders no email address on the agent page while the email medium is off', async () => {
    useFetch(agentFetchMock({ entry: ADDRESSED_ENTRY }, rec));
    renderProfile();
    await screen.findByRole('heading', { name: 'deploy-bot' });
    expect(screen.queryByText(/deploy-bot@acme\.example\.com/)).toBeNull();
    // No email SURFACE at all: no address row, no Email tab, no filter chip. The
    // tab chrome that does render (Overview / Activity) names no medium, so the
    // original blanket assertion still holds verbatim.
    expect(screen.queryByText(/email/i)).toBeNull();
    expect(screen.queryByRole('tab', { name: /email/i })).toBeNull();
  });

  it('renders the address as a copyable row when the email medium is on', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useFetch(agentFetchMock({ entry: ADDRESSED_ENTRY }, rec));
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    expect(await screen.findByText('deploy-bot@acme.example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /copy email address/i }));
    expect(writeText).toHaveBeenCalledWith('deploy-bot@acme.example.com');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows the address to a non-owner too — it is public routing information', async () => {
    useFetch(
      agentFetchMock(
        {
          role: 'member',
          entry: {
            ...ADDRESSED_ENTRY,
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
          },
        },
        rec,
      ),
    );
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    expect(await screen.findByText('deploy-bot@acme.example.com')).toBeInTheDocument();
  });

  it('renders no address row when the agent has none (never rendered empty)', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    await screen.findByRole('heading', { name: 'deploy-bot' });
    expect(screen.queryByRole('button', { name: /copy email address/i })).toBeNull();
  });

  it('owner gets all three tabs with the medium on; Overview is the default', async () => {
    useFetch(agentFetchMock({ entry: ADDRESSED_ENTRY }, rec));
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Email' })).toBeInTheDocument();
    // Overview holds v3's agent-profile contents.
    expect(screen.getByRole('heading', { name: /^share$/i })).toBeInTheDocument();
  });

  it('owner gets Overview + Activity but no Email tab with the medium off', async () => {
    useFetch(agentFetchMock({ entry: ADDRESSED_ENTRY }, rec));
    renderProfile();
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Email' })).toBeNull();
  });

  it('a non-owner grantee (plain member) gets no tabs at all', async () => {
    useFetch(
      agentFetchMock(
        {
          role: 'member',
          entry: {
            ...ADDRESSED_ENTRY,
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
          },
        },
        rec,
      ),
    );
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    await screen.findByRole('heading', { name: 'deploy-bot' });
    expect(screen.queryByRole('tab')).toBeNull();
    // The overview content is still what they see.
    expect(screen.getByRole('button', { name: /message/i })).toBeInTheDocument();
  });

  it('an org admin who is not the owner still gets Activity and Email', async () => {
    useFetch(
      agentFetchMock(
        {
          role: 'admin',
          entry: {
            ...ADDRESSED_ENTRY,
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
          },
        },
        rec,
      ),
    );
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    expect(await screen.findByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Email' })).toBeInTheDocument();
  });

  it('a ?tab= the caller may not read falls back to Overview', async () => {
    useFetch(
      agentFetchMock(
        {
          role: 'member',
          entry: {
            ...ADDRESSED_ENTRY,
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
          },
        },
        rec,
      ),
    );
    renderProfile('/org/org_1/agents/agt_1?tab=activity', CAPS_EMAIL);
    await screen.findByRole('heading', { name: 'deploy-bot' });
    expect(screen.getByRole('button', { name: /message/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^all$/i })).toBeNull();
  });

  it('revokes a share via the unshare endpoint', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await screen.findByText('Mira');
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) => c.method === 'DELETE' && c.url.includes('/me/agents/agt_1/share/usr_2'),
        ),
      ).toBe(true),
    );
  });

  it('detaches the agent from a room via RemoveMember', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await screen.findByText('General');
    await userEvent.click(screen.getByRole('button', { name: /^detach$/i }));
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) => c.method === 'DELETE' && c.url.includes('/rooms/room_9/members/mem_r9'),
        ),
      ).toBe(true),
    );
  });

  it('shows a not-found panel when the agent is not visible', async () => {
    useFetch(agentFetchMock({ entry: null }, rec));
    renderProfile();
    expect(await screen.findByText(/can’t see this agent/i)).toBeInTheDocument();
  });

  it('grantee view: names the owner + sharer, hides owner controls', async () => {
    useFetch(
      agentFetchMock(
        {
          entry: {
            agent: {
              id: 'agt_1',
              name: 'deploy-bot',
              orgId: 'org_1',
              online: false,
              lastSeenAt: null,
              createdAt: '2026-08-01T00:00:00Z',
            },
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
          },
        },
        rec,
      ),
    );
    renderProfile();
    expect(await screen.findByRole('heading', { name: 'deploy-bot' })).toBeInTheDocument();
    expect(screen.getByText(/owned by otto · shared by sam/i)).toBeInTheDocument();
    expect(screen.queryByText('yours')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /share/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rotate key/i })).not.toBeInTheDocument();
    // Message is still offered.
    expect(screen.getByRole('button', { name: /message/i })).toBeInTheDocument();
  });

  it('Message ensures a DM and navigates into the room', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: /message/i }));
    expect(await screen.findByText(/ROOM dm/)).toBeInTheDocument();
    expect(rec.calls.some((c) => c.url.includes('/me/dms'))).toBe(true);
  });

  it('rotate shows the new key exactly once with a warning', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: /rotate key/i }));
    expect(await screen.findByText('agk_rotated_secret_key')).toBeInTheDocument();
    expect(screen.getByText(/won’t see it again/i)).toBeInTheDocument();
  });

  it('share by email posts to the share endpoint', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await screen.findByRole('heading', { name: 'deploy-bot' });
    await userEvent.type(
      screen.getByLabelText(/share with/i),
      'mira@acme.com',
    );
    await userEvent.click(screen.getByRole('button', { name: /^share$/i }));
    await waitFor(() =>
      expect(rec.calls.some((c) => c.url.includes('/me/agents/agt_1/share'))).toBe(true),
    );
    const call = rec.calls.find((c) => c.url.includes('/me/agents/agt_1/share'));
    expect(call?.body).toEqual({ human: 'mira@acme.com' });
    expect(await screen.findByText(/shared with mira/i)).toBeInTheDocument();
  });

  it('renders the sharing radio group and defaults to the agent’s mode', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    expect(await screen.findByRole('heading', { name: /sharing/i })).toBeInTheDocument();
    // Three options, one-line explanations.
    const roomMembers = screen.getByRole('radio', { name: /anyone in a room with this agent/i });
    expect(screen.getByRole('radio', { name: /only people you choose/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /everyone in the organization/i })).toBeInTheDocument();
    // Default (absent on the wire) resolves to `room-members`.
    expect(roomMembers).toBeChecked();
  });

  it('changing the sharing mode PATCHes the agent', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await screen.findByRole('heading', { name: /sharing/i });
    await userEvent.click(screen.getByRole('radio', { name: /everyone in the organization/i }));
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) => c.method === 'PATCH' && c.url.includes('/me/agents/agt_1') && (c.body as { sharing?: string })?.sharing === 'org',
        ),
      ).toBe(true),
    );
  });

  it('reflects a non-default sharing mode from the wire', async () => {
    useFetch(
      agentFetchMock(
        {
          entry: {
            agent: {
              id: 'agt_1',
              name: 'deploy-bot',
              orgId: 'org_1',
              online: true,
              lastSeenAt: '2026-08-20T17:00:00Z',
              sharing: 'room-members',
              createdAt: '2026-08-01T00:00:00Z',
            },
            owner: { id: 'usr_1', displayName: 'Jake' },
            sharedBy: null,
            rooms: [],
            sharedWith: [],
          },
        },
        rec,
      ),
    );
    renderProfile();
    expect(await screen.findByRole('radio', { name: /anyone in a room with this agent/i })).toBeChecked();
  });

  it('owner rename: editing the name and saving PATCHes { name }', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    // The owner-only Name control is present, seeded with the current name.
    const input = (await screen.findByLabelText(/agent name/i)) as HTMLInputElement;
    expect(input.value).toBe('deploy-bot');
    // Save is disabled until the name actually changes.
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'helper');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.includes('/me/agents/agt_1') &&
            (c.body as { name?: string })?.name === 'helper',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(/renamed to helper/i)).toBeInTheDocument();
  });

  it('owner rename: a 409 collision surfaces the server message inline', async () => {
    const mock = agentFetchMock({}, rec);
    // Override PATCH to 409 for this test.
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(input).includes('/me/agents/agt_1') && method === 'PATCH') {
        return json(
          { error: { code: 'conflict', message: 'An agent named “taken” already exists in this org; choose another name' } },
          409,
        );
      }
      return mock(input, init);
    });
    useFetch(wrapped as unknown as typeof fetch);
    renderProfile();
    const input = (await screen.findByLabelText(/agent name/i)) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'taken');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/already exists in this org/i)).toBeInTheDocument();
  });

  it('delete asks to confirm, then deletes and leaves', async () => {
    useFetch(agentFetchMock({}, rec));
    renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: /delete agent/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(await screen.findByText('ORG HOME')).toBeInTheDocument();
    expect(
      rec.calls.some((c) => c.method === 'DELETE' && c.url.includes('/me/agents/agt_1')),
    ).toBe(true);
  });

  it('shows the role title as a header badge, visible to a non-owner too', async () => {
    useFetch(
      agentFetchMock(
        {
          role: 'member',
          entry: {
            ...OWNED_ROLE_ENTRY,
            owner: { id: 'usr_9', displayName: 'Otto' },
            sharedBy: { id: 'usr_5', displayName: 'Sam' },
            // The server never sends a non-owner the private instructions.
            roleInstructions: null,
          },
        },
        rec,
      ),
    );
    renderProfile('/org/org_1/agents/agt_1', CAPS_EMAIL);
    await screen.findByRole('heading', { name: 'deploy-bot' });
    // The org-visible title renders for everyone…
    expect(screen.getByText('Support triage')).toBeInTheDocument();
    // …but a non-owner gets NO role editor and never the private body.
    expect(screen.queryByLabelText(/role title/i)).toBeNull();
    expect(screen.queryByLabelText(/role instructions/i)).toBeNull();
  });

  it('owner role editor: seeds current values and saves PATCHes the role halves', async () => {
    useFetch(agentFetchMock({ entry: OWNED_ROLE_ENTRY }, rec));
    renderProfile();
    const title = (await screen.findByLabelText(/role title/i)) as HTMLInputElement;
    const instructions = screen.getByLabelText(/role instructions/i) as HTMLTextAreaElement;
    // Seeded from the current role.
    expect(title.value).toBe('Support triage');
    expect(instructions.value).toBe('Answer support DMs first; escalate billing.');

    await userEvent.clear(title);
    await userEvent.type(title, 'Ops lead');
    await userEvent.click(screen.getByRole('button', { name: /save role/i }));

    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.includes('/me/agents/agt_1') &&
            (c.body as { roleTitle?: string })?.roleTitle === 'Ops lead',
        ),
      ).toBe(true),
    );
  });

  it('owner role editor: clearing both halves sends null (clears the role)', async () => {
    useFetch(agentFetchMock({ entry: OWNED_ROLE_ENTRY }, rec));
    renderProfile();
    const title = (await screen.findByLabelText(/role title/i)) as HTMLInputElement;
    const instructions = screen.getByLabelText(/role instructions/i) as HTMLTextAreaElement;
    await userEvent.clear(title);
    await userEvent.clear(instructions);
    await userEvent.click(screen.getByRole('button', { name: /save role/i }));
    await waitFor(() =>
      expect(
        rec.calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.includes('/me/agents/agt_1') &&
            (c.body as { roleTitle?: string | null }).roleTitle === null &&
            (c.body as { roleInstructions?: string | null }).roleInstructions === null,
        ),
      ).toBe(true),
    );
  });
});
