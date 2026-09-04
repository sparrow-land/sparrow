import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../lib/client.js';
import { App } from '../App.js';

/**
 * The personal `/me/*` pages (approvals, settings) must wear the SAME chrome as the
 * rest of the signed-in app: the AppShell left-nav sidebar, NOT the marketing
 * SiteHeader/SiteFooter. These tests drive the real App routing (MeLayout →
 * AppShell → the page in the Outlet) and assert the shell is present and the
 * marketing chrome is gone.
 */

// Point the shared client's `_fetch` at the mock (same shim AppShell.test uses).
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

/** Fetch stub: a signed-in human (Jake) who owns Acme, plus every endpoint the
 * shell + these pages touch on boot. */
function appFetchMock(opts: { orgs?: { org: { id: string; name: string; slug: string }; role: string }[] } = {}) {
  const orgs = opts.orgs ?? [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) return json({ items: orgs });
    if (url.includes('/me/events')) return json('');

    if (/\/orgs\/org_1$/.test(url.split('?')[0]!)) {
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
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) return json({ items: [] });
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/orgs/org_1/invites')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    if (url.includes('/api/v1/config')) return json({ error: { code: 'not_found', message: 'x' } }, 404);

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (api as unknown as WithFetch)._fetch = REAL_FETCH;
  localStorage.clear();
});

describe('MeLayout — /me/* wears the app shell', () => {
  it('/me/settings renders inside the AppShell (sidebar), not the marketing chrome', async () => {
    useFetch(appFetchMock());
    render(
      <MemoryRouter initialEntries={['/me/settings']}>
        <App />
      </MemoryRouter>,
    );

    // The page itself renders.
    expect(await screen.findByRole('heading', { name: /your settings/i })).toBeInTheDocument();
    // The app shell is present: its Sign out control + the Rooms nav.
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /rooms/i })).toBeInTheDocument();
    // The marketing chrome is gone.
    expect(screen.queryByText(/self-hostable message rooms/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /getting started/i })).not.toBeInTheDocument();
  });

  it('/me/approvals renders inside the AppShell (sidebar), not the marketing chrome', async () => {
    useFetch(appFetchMock());
    render(
      <MemoryRouter initialEntries={['/me/approvals']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /^approvals$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText(/self-hostable message rooms/i)).not.toBeInTheDocument();
  });

  it('/me/invites redirects to /me/approvals (the v3 URL keeps working)', async () => {
    useFetch(appFetchMock());
    render(
      <MemoryRouter initialEntries={['/me/invites']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /^approvals$/i })).toBeInTheDocument();
  });

  it('a signed-in human with NO org sees /me/settings in the BareShell frame', async () => {
    useFetch(appFetchMock({ orgs: [] }));
    render(
      <MemoryRouter initialEntries={['/me/settings']}>
        <App />
      </MemoryRouter>,
    );

    // Page renders and does not crash without an org context...
    expect(await screen.findByRole('heading', { name: /your settings/i })).toBeInTheDocument();
    expect(screen.getByText(/not in any organizations yet/i)).toBeInTheDocument();
    // ...and the signed-in BareShell frame wraps it (identity + Sign out), so it
    // reads as logged-in — but there is no full AppShell (no org), so no Rooms nav.
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /rooms/i })).not.toBeInTheDocument();
  });
});
