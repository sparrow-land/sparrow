import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useFetch, restoreFetch } from '../test/apiStub.js';
import {
  makeServer,
  presenceFetch,
  pushBotPresence,
  closeStreams,
  renderShellWithDm,
  type PresenceServer,
} from '../test/presenceHarness.js';
import { roomStreams } from '../lib/roomStreams.js';
import { presenceStore } from '../lib/presenceStore.js';

/**
 * ONE presence truth per principal (the gray-vs-green split bug): the same
 * agent must never show a gray dot in the leftnav AGENTS list while the DM
 * chat header shows green. Both surfaces render from the shared PresenceStore,
 * fed by every subscribed room stream and by the sidebar's own wake reconcile.
 */

const sidebar = () => document.getElementById('app-sidebar')!;
const chatMain = () => screen.getByRole('main');

/** The presence dots visible in `root` (PresenceGlyph carries the label). */
const dots = (root: HTMLElement, label: 'online' | 'offline') =>
  within(root).queryAllByRole('img', { name: new RegExp(`^${label}( \\+ working)?$`) });

describe('presence — one truth for leftnav and chat header', () => {
  let server: PresenceServer;

  beforeEach(() => {
    localStorage.clear();
    presenceStore.reset();
    server = makeServer();
    useFetch(presenceFetch(server));
  });

  afterEach(() => {
    roomStreams.dispose();
    closeStreams(server);
    restoreFetch();
  });

  it('a single presence.changed frame flips BOTH the leftnav row and the DM header', async () => {
    renderShellWithDm();

    // Boot: snapshot says offline everywhere — one gray dot per surface.
    await waitFor(() => expect(dots(sidebar(), 'offline')).toHaveLength(1));
    await waitFor(() => expect(dots(chatMain(), 'offline')).toHaveLength(1));
    expect(dots(sidebar(), 'online')).toHaveLength(0);
    expect(dots(chatMain(), 'online')).toHaveLength(0);

    // The one multiplexed stream must be live before we can push the frame —
    // and the per-room stream that used to carry this must NOT exist (#54).
    await waitFor(() => expect(server.meEvents.length).toBeGreaterThan(0));
    expect(server.roomEvents).toHaveLength(0);
    act(() => pushBotPresence(server, 'online'));

    // The SAME event lights both surfaces — no surface may lag the other.
    await waitFor(() => expect(dots(sidebar(), 'online')).toHaveLength(1));
    await waitFor(() => expect(dots(chatMain(), 'online')).toHaveLength(1));
    expect(dots(sidebar(), 'offline')).toHaveLength(0);
    expect(dots(chatMain(), 'offline')).toHaveLength(0);

    // And back down again, from one offline frame.
    act(() => pushBotPresence(server, 'offline'));
    await waitFor(() => expect(dots(sidebar(), 'offline')).toHaveLength(1));
    await waitFor(() => expect(dots(chatMain(), 'offline')).toHaveLength(1));
  });

  it('visibility regain refetches sidebar presence (stale gray heals to green)', async () => {
    renderShellWithDm();
    await waitFor(() => expect(dots(sidebar(), 'offline')).toHaveLength(1));

    // The agent came online while the tab slept: every live event was missed,
    // only the server knows. Fresh server state, then the tab wakes up.
    server.agentOnline = true;
    server.statusOnline = ['mem_bot'];
    const agentsCallsBefore = server.agentsCalls;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The sidebar refetched its presence source (not just the room view)...
    await waitFor(() => expect(server.agentsCalls).toBeGreaterThan(agentsCallsBefore));
    // ...and both surfaces healed to green.
    await waitFor(() => expect(dots(sidebar(), 'online')).toHaveLength(1));
    await waitFor(() => expect(dots(chatMain(), 'online')).toHaveLength(1));
    expect(dots(sidebar(), 'offline')).toHaveLength(0);
  });
});
