import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { useFetch, restoreFetch } from '../test/apiStub.js';
import {
  makeServer,
  presenceFetch,
  closeStreams,
  renderShellWithDm,
  type PresenceServer,
} from '../test/presenceHarness.js';
import { roomStreams } from '../lib/roomStreams.js';
import { presenceStore } from '../lib/presenceStore.js';

/**
 * Dot-geometry normalization: the leftnav rows and the DM chat header must
 * render the SAME avatar+status-dot component (PresenceAvatar), not per-surface
 * copies of the cluster — the copies drifted (ring/whitespace mismatch). The
 * component module is mocked with a probe, so finding the probe on a surface
 * proves that surface renders the shared component (not lookalike pixels).
 */
vi.mock('./PresenceAvatar.js', async () => {
  const { createElement } = await import('react');
  return {
    PresenceAvatar: (props: { displayName: string }) =>
      createElement('span', { 'data-testid': 'presence-avatar-probe', 'data-name': props.displayName }),
  };
});

describe('PresenceAvatar is the one avatar+dot cluster on every presence surface', () => {
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

  it('both the leftnav agent row and the DM chat header render PresenceAvatar', async () => {
    renderShellWithDm();

    const sidebar = document.getElementById('app-sidebar')!;
    await waitFor(() => {
      const probes = within(sidebar).getAllByTestId('presence-avatar-probe');
      expect(probes.some((p) => p.getAttribute('data-name') === 'Botty')).toBe(true);
    });

    const main = screen.getByRole('main');
    await waitFor(() => {
      const probes = within(main).getAllByTestId('presence-avatar-probe');
      expect(probes.some((p) => p.getAttribute('data-name') === 'Botty')).toBe(true);
    });
  });
});
