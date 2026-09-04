import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { App } from '../App.js';
import { setScopedMode } from '../lib/ids.js';

/**
 * The personal `/me/*` surfaces must exist inside the org-scoped route tree
 * too: on a scoped host, in-app links like the pending pill point at
 * `/me/approvals`, which must not fall into the scoped 404. The v3 URL
 * (`/me/invites`) still resolves — it redirects.
 */

const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

function bootMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/capabilities'))
      return json({ voice: { stt: false, tts: false, sttStreaming: false }, orgHostSuffix: '.sparrow.test' });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs'))
      return json({ items: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }] });
    if (url.includes('/orgs/resolve/acme'))
      return json({ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' });
    if (url.includes('/me/events')) return json('');
    if (url.includes('/me/invitations')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/enrollments')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    if (url.includes('/orgs/org_1')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

afterEach(() => {
  restoreFetch();
  setScopedMode(false);
  vi.restoreAllMocks();
});

describe('scoped host /me routes', () => {
  it('/me/approvals renders MyApprovals inside a scoped tree (not the 404 page)', async () => {
    useFetch(bootMock());
    render(
      <MemoryRouter initialEntries={['/me/approvals']}>
        <App scope={{ slug: 'acme', mode: 'host', basename: '/' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /^approvals$/i })).toBeInTheDocument();
  });

  it('/me/invites redirects to /me/approvals inside a scoped tree too', async () => {
    useFetch(bootMock());
    render(
      <MemoryRouter initialEntries={['/me/invites']}>
        <App scope={{ slug: 'acme', mode: 'host', basename: '/' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /^approvals$/i })).toBeInTheDocument();
  });

  it('/me/settings renders inside a scoped tree', async () => {
    useFetch(bootMock());
    render(
      <MemoryRouter initialEntries={['/me/settings']}>
        <App scope={{ slug: 'acme', mode: 'host', basename: '/' }} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /settings/i })).toBeInTheDocument();
  });

  /**
   * Bug regression: on an org-scoped host the `/me/*` shell must hang on the org
   * named by the host, not the caller's first membership. A user in [Meteor,
   * Sightsinging] on `sightsinging.<suffix>` must see the SIGHTSINGING header —
   * previously the shell defaulted to the first membership (Meteor).
   */
  it('picks the host org (not the first membership) for the /me shell header', async () => {
    const multiOrgMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
      if (url.includes('/capabilities'))
        return json({ voice: { stt: false, tts: false, sttStreaming: false }, orgHostSuffix: '.sparrow.test' });
      if (url.includes('/auth/me')) return json({ user: jake });
      if (url.includes('/me/orgs'))
        return json({
          items: [
            { org: { id: 'org_meteor', name: 'Meteor', slug: 'meteor' }, role: 'owner' },
            { org: { id: 'org_sing', name: 'Sightsinging', slug: 'sightsinging' }, role: 'member' },
          ],
        });
      if (url.includes('/me/events')) return json('');
      if (url.includes('/me/room-invitations')) return json({ items: [] });
      if (url.includes('/me/rooms')) return json({ items: [] });
      // The shell hangs on the host org (org_sing); it must fetch ITS resources.
      if (/\/orgs\/org_sing$/.test(url.split('?')[0]!))
        return json({
          org: {
            id: 'org_sing',
            name: 'Sightsinging',
            slug: 'sightsinging',
            settings: {
              invites: { who: 'members' },
              enroll: { agents: 'approval' },
              rooms: { create: 'members' },
            },
            createdAt: '2026-08-01T00:00:00Z',
          },
        });
      if (url.includes('/orgs/org_sing/me/humans')) return json({ items: [] });
      if (url.includes('/orgs/org_sing/me/agents')) return json({ items: [] });
      if (url.includes('/orgs/org_sing/enrollments')) return json({ items: [] });
      return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
    });
    useFetch(multiOrgMock);
    render(
      <MemoryRouter initialEntries={['/me/settings']}>
        <App scope={{ slug: 'sightsinging', mode: 'host', basename: '/' }} />
      </MemoryRouter>,
    );

    // The leftnav header reflects the HOST org, not the first membership.
    const sidebar = await waitFor(() => {
      const el = document.getElementById('app-sidebar');
      if (!el) throw new Error('sidebar not mounted yet');
      return el;
    });
    expect(within(sidebar).getByText('Sightsinging')).toBeInTheDocument();
    expect(within(sidebar).queryByText('Meteor')).not.toBeInTheDocument();
  });
});
