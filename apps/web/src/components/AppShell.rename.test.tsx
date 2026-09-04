import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useFetch, restoreFetch } from '../test/apiStub.js';
import {
  makeServer,
  presenceFetch,
  pushMeEvent,
  closeStreams,
  renderShellWithDm,
  DM_ROOM_REF,
  type PresenceServer,
} from '../test/presenceHarness.js';
import { roomStreams } from '../lib/roomStreams.js';
import { presenceStore } from '../lib/presenceStore.js';
import { meEvents } from '../lib/meEvents.js';

/**
 * The reported dogfood bug: an agent renamed ITSELF (`PATCH /me` with an agent
 * key). The message pane updated live, but the leftnav AGENTS entry, the
 * top-nav breadcrumb, and the DM header all stayed on the old name until a hard
 * refresh.
 *
 * SPEC (`PATCH /me`): a rename "propagates live (members render names live) and
 * emits `member.updated` in every room the principal inhabits". Every one of
 * those three surfaces reads a workspace source (`GET /orgs/:orgId/me/agents`
 * for the row, `GET /me/rooms` for the crumb AND the DM header's counterpart),
 * so honoring the event means the WORKSPACE has to apply it — the room stream's
 * member roster never touched any of them.
 *
 * The payload carries `principalId` + the new `displayName`, so this is an
 * IN-PLACE patch: no source is refetched (asserted below), which is what makes
 * the rename land on all three surfaces in the same frame.
 */

const sidebar = () => document.getElementById('app-sidebar')!;
const topNav = () => document.querySelector('header') as HTMLElement;
const chatMain = () => screen.getByRole('main');

/** The `member.updated` frame the API emits into the DM room on a rename. */
const renamed = (displayName: string) => ({
  member: {
    id: 'mem_bot',
    kind: 'agent' as const,
    principalId: 'agt_1',
    displayName,
    avatarUrl: null,
    roomRole: 'member' as const,
    lastSeenAt: null,
    createdAt: '2026-08-20T10:00:00Z',
  },
});

describe('agent rename propagates to every name surface (no hard refresh)', () => {
  let server: PresenceServer;

  beforeEach(() => {
    localStorage.clear();
    presenceStore.reset();
    server = makeServer();
    useFetch(presenceFetch(server));
  });

  afterEach(() => {
    roomStreams.dispose();
    meEvents.dispose();
    closeStreams(server);
    restoreFetch();
  });

  it('one member.updated frame renames the sidebar row, the crumb AND the DM header', async () => {
    renderShellWithDm();

    // Boot: the old name on all three surfaces.
    await waitFor(() => expect(within(sidebar()).getByText('Botty')).toBeTruthy());
    await waitFor(() => expect(within(topNav()).getByText('@Botty')).toBeTruthy());
    await waitFor(() => expect(within(chatMain()).getByText('Botty')).toBeTruthy());

    // The workspace's `/me/events` stream must be live before we push.
    await waitFor(() => expect(server.meEvents.length).toBeGreaterThan(0));
    const agentsBefore = server.agentsCalls;
    const roomsBefore = server.roomsCalls;

    // `fable` → `vm9-sparrow`: the agent renamed itself.
    act(() => pushMeEvent(server, 'member.updated', renamed('vm9-sparrow'), DM_ROOM_REF));

    await waitFor(() => expect(within(sidebar()).getByText('vm9-sparrow')).toBeTruthy());
    await waitFor(() => expect(within(topNav()).getByText('@vm9-sparrow')).toBeTruthy());
    await waitFor(() => expect(within(chatMain()).getByText('vm9-sparrow')).toBeTruthy());

    // The OLD name is gone from every surface — not merely joined by the new one.
    expect(within(sidebar()).queryByText('Botty')).toBeNull();
    expect(within(topNav()).queryByText('@Botty')).toBeNull();
    expect(within(chatMain()).queryByText('Botty')).toBeNull();

    // In place: the event carries the name, so nothing was refetched to get it.
    expect(server.agentsCalls).toBe(agentsBefore);
    expect(server.roomsCalls).toBe(roomsBefore);
  });

  it('a room rename by anyone lands on the ROOMS row, live', async () => {
    server.projectRoom = { id: 'room_p', name: 'deploys', archivedAt: null };
    renderShellWithDm();
    await waitFor(() => expect(within(sidebar()).getByText('#deploys')).toBeTruthy());
    await waitFor(() => expect(server.meEvents.length).toBeGreaterThan(0));

    act(() =>
      pushMeEvent(
        server,
        'room.updated',
        {
          room: { id: 'room_p', name: 'deploys-v2', archivedAt: null },
          settings: { description: '' },
        },
        { id: 'room_p', name: 'deploys', kind: 'project' },
      ),
    );

    await waitFor(() => expect(within(sidebar()).getByText('#deploys-v2')).toBeTruthy());
    expect(within(sidebar()).queryByText('#deploys')).toBeNull();
  });

  it('a room archived by a coworker moves into the Archived fold, live', async () => {
    server.projectRoom = { id: 'room_p', name: 'deploys', archivedAt: null };
    renderShellWithDm();
    await waitFor(() => expect(within(sidebar()).getByText('#deploys')).toBeTruthy());
    // Nothing is archived yet, so the fold is absent entirely.
    expect(within(sidebar()).queryByText('Archived')).toBeNull();
    await waitFor(() => expect(server.meEvents.length).toBeGreaterThan(0));

    act(() =>
      pushMeEvent(
        server,
        'room.updated',
        {
          room: { id: 'room_p', name: 'deploys', archivedAt: '2026-08-31T12:00:00Z' },
          settings: { description: '' },
        },
        { id: 'room_p', name: 'deploys', kind: 'project' },
      ),
    );

    // The row leaves the active list for the collapsed "Archived" group.
    await waitFor(() => expect(within(sidebar()).getByText('Archived')).toBeTruthy());
    expect(within(sidebar()).queryByText('#deploys')).toBeNull();
  });

  it('the agent-profile link and its tooltip follow the new name too', async () => {
    renderShellWithDm();
    await waitFor(() => expect(within(sidebar()).getByText('Botty')).toBeTruthy());
    await waitFor(() => expect(server.meEvents.length).toBeGreaterThan(0));

    act(() => pushMeEvent(server, 'member.updated', renamed('vm9-sparrow'), DM_ROOM_REF));

    await waitFor(() =>
      expect(within(sidebar()).getByLabelText('Profile for vm9-sparrow')).toBeTruthy(),
    );
  });
});
