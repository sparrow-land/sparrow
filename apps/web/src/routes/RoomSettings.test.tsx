import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Member, Room as RoomResource, VisibilityAgent } from '@sparrow/common-types';

// RoomSettings leans on the org/workspace contexts and the per-room SSE manager;
// stub them so the test can focus on the Members add affordances. The `api`
// client's fetch is routed via the shared apiStub.
const orgState: { isAdmin: boolean } = { isAdmin: false };
vi.mock('../lib/org.js', () => ({ useOrg: () => ({ orgId: 'org_1', isAdmin: orgState.isAdmin }) }));

// The add-people picker excludes the signed-in user, so it needs an identity.
vi.mock('../lib/auth.js', () => ({
  useAuth: () => ({
    user: { id: 'usr_self', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' },
  }),
}));

const wsState: { agents: VisibilityAgent[] } = { agents: [] };
vi.mock('../lib/workspace.js', () => ({
  useWorkspace: () => ({ agents: wsState.agents, reloadRooms: vi.fn() }),
}));

vi.mock('../lib/roomStreams.js', () => ({
  roomStreams: { subscribe: () => () => {} },
}));

import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { RoomSettings } from './RoomSettings.js';

const OWNER: Member = {
  id: 'mem_self',
  kind: 'human',
  avatarUrl: null,
  principalId: 'usr_self',
  displayName: 'Jake',
  roomRole: 'owner',
  lastSeenAt: null,
  createdAt: '2026-08-20T10:00:00Z',
};
const PLAIN: Member = { ...OWNER, roomRole: 'member' };
const ROOM: RoomResource = {
  id: 'room_abc',
  orgId: 'org_1',
  name: 'general',
  kind: 'project',
  archivedAt: null,
  settings: { description: '' },
};

const AGENT: VisibilityAgent = {
  agent: {
    id: 'agt_bot',
    name: 'deploy-bot',
    orgId: 'org_1',
    emailAddress: null,
    online: false,
    lastSeenAt: null,
    sharing: 'room-members',
    roleTitle: null,
    createdAt: '2026-08-20T10:00:00Z',
  },
  owner: { id: 'usr_self', displayName: 'Jake' },
  sharedBy: null,
  emailUnreadCount: null,
  roleInstructions: null,
};

interface Opts {
  self?: Member;
  onInvite?: (body: unknown) => void;
  onAddMember?: (body: unknown) => void;
  /** Fail the room PATCH (name/description save). */
  saveError?: boolean;
}

function stubSettings(opts: Opts = {}) {
  const self = opts.self ?? OWNER;
  useFetch(async (input, init) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (url.includes('/whoami')) return json(self);
    if (url.includes('/directory')) {
      // The org directory answers with EVERY member — the signed-in caller
      // included. Filtering self out is the client's job.
      return json({
        items: [
          { id: 'usr_amy', displayName: 'Amy', email: 'amy@example.com' },
          { id: 'usr_self', displayName: 'Jake', email: 'jake@acme.com' },
        ],
        nextCursor: null,
      });
    }
    if (url.endsWith('/invitations') && method === 'POST') {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      opts.onInvite?.(body);
      return json(
        { invitation: { id: 'rinv_1', human: { id: 'usr_amy', displayName: 'Amy' }, invitedBy: self } },
        201,
      );
    }
    if (url.endsWith('/invitations')) return json({ items: [], nextCursor: null });
    if (url.endsWith('/members') && method === 'POST') {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      opts.onAddMember?.(body);
      return json({ member: { ...OWNER, id: 'mem_bot', kind: 'agent', principalId: 'agt_bot', displayName: 'deploy-bot', roomRole: 'member' } }, 201);
    }
    if (url.endsWith('/members')) return json({ items: [self], nextCursor: null });
    if (/\/rooms\/room_abc$/.test(url)) {
      if (method === 'PATCH') {
        if (opts.saveError) return errorJson('bad_request', 400, 'nope');
        const body = init?.body ? (JSON.parse(String(init.body)) as { name?: string }) : {};
        return json({ room: { ...ROOM, name: body.name ?? ROOM.name } });
      }
      return json(ROOM);
    }
    return errorJson('not_found', 404);
  });
}

function renderSettings() {
  render(
    <MemoryRouter initialEntries={['/rooms/abc/settings']}>
      <Routes>
        <Route path="/rooms/:roomId/settings" element={<RoomSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  orgState.isAdmin = false;
  wsState.agents = [];
});
afterEach(() => {
  restoreFetch();
});

describe('RoomSettings member add affordances', () => {
  it('renders Add people + Add agent for a permitted (owner/admin) member', async () => {
    stubSettings({ self: OWNER });
    renderSettings();

    expect(await screen.findByRole('button', { name: /add people/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add agent/i })).toBeInTheDocument();
  });

  it('shows no add affordances to a non-permitted (plain member) viewer', async () => {
    stubSettings({ self: PLAIN });
    renderSettings();

    // Wait for the page to settle (the Members heading is present for all members).
    await screen.findByText('Members');
    expect(screen.queryByRole('button', { name: /add people/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add agent/i })).toBeNull();
  });

  it('adding a human fires the invitation POST', async () => {
    const invites: unknown[] = [];
    stubSettings({ self: OWNER, onInvite: (b) => invites.push(b) });
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: /add people/i }));
    // The directory picker resolves Amy; click her to invite.
    await userEvent.click(await screen.findByRole('button', { name: /amy/i }));

    await waitFor(() => expect(invites).toHaveLength(1));
    expect(invites[0]).toMatchObject({ human: 'usr_amy' });
  });

  it('never offers the signed-in user as someone to add (issue #53)', async () => {
    stubSettings({ self: OWNER });
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: /add people/i }));
    // The directory carries both, the picker offers only the other person.
    expect(await screen.findByRole('button', { name: /amy/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /jake/i })).toBeNull();
  });

  it('adding an agent fires the AddMember POST', async () => {
    const adds: unknown[] = [];
    wsState.agents = [AGENT];
    stubSettings({ self: OWNER, onAddMember: (b) => adds.push(b) });
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: /add agent/i }));
    await userEvent.click(await screen.findByRole('button', { name: /deploy-bot/i }));

    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]).toMatchObject({ principal: 'agt_bot' });
  });
});

/**
 * Saving the room used to be silent — the form just sat there, so you could not
 * tell a save from a no-op. Org admin already answers with a "Saved" tick
 * (`routes/org/ui.tsx`); the room form now uses the same one.
 */
describe('RoomSettings save confirmation', () => {
  it('confirms a successful save with the shared Saved tick', async () => {
    stubSettings({ self: OWNER });
    renderSettings();

    const name = await screen.findByLabelText(/^name$/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'renamed');
    expect(screen.queryByText('Saved')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const saved = await screen.findByText('Saved');
    expect(saved).toBeInTheDocument();
    expect(saved.closest('[role="status"]')).not.toBeNull();
  });

  it('drops the confirmation as soon as the form is edited again', async () => {
    stubSettings({ self: OWNER });
    renderSettings();

    const name = await screen.findByLabelText(/^name$/i);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText('Saved');

    await userEvent.type(name, '!');
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('shows the error, not a confirmation, when the save fails', async () => {
    stubSettings({ self: OWNER, saveError: true });
    renderSettings();

    await screen.findByLabelText(/^name$/i);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
