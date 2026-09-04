import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { AuthProvider } from '../lib/auth.js';
import { ScopedOrgLayout } from '../App.js';
import { setScopedMode } from '../lib/ids.js';

/**
 * The scoped workspace layout (host `<slug><suffix>` or `/orgs/<slug>` path):
 * org identity comes from `GET /orgs/resolve/:slug`, NOT the URL. A signed-out
 * visitor gets the login flow; a signed-in non-member sees a clear terminal
 * screen (no redirect loop); a member gets the full shell.
 */

const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

const acmeOrg = {
  id: 'org_1',
  name: 'Acme',
  slug: 'acme',
  settings: {
    invites: { who: 'members' },
    enroll: { agents: 'approval' },
    rooms: { create: 'members' },
  },
  createdAt: '2026-08-01T00:00:00Z',
};

/** Base boot fetch: signed-in Jake, member of Acme, plus the shell's boot calls. */
function bootMock(opts: { resolve?: 'ok' | '404'; signedIn?: boolean } = {}) {
  const signedIn = opts.signedIn ?? true;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/capabilities')) return json({ voice: { stt: false, tts: false, sttStreaming: false }, orgHostSuffix: '.sparrow.test' });
    if (url.includes('/auth/me')) {
      return signedIn ? json({ user: jake }) : errorJson('unauthorized', 401);
    }
    if (url.includes('/me/orgs')) {
      return json({ items: signedIn ? [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }] : [] });
    }
    if (url.includes('/orgs/resolve/acme')) {
      return opts.resolve === '404'
        ? errorJson('not_found', 404)
        : json({ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' });
    }
    if (url.includes('/orgs/resolve/')) return errorJson('not_found', 404);
    if (url.includes('/me/events')) return json('');
    if (/\/orgs\/org_1$/.test(url.split('?')[0]!)) return json({ org: acmeOrg });
    if (url.includes('/orgs/org_1/me/humans')) return json({ items: [] });
    if (url.includes('/orgs/org_1/me/agents')) return json({ items: [] });
    if (url.includes('/orgs/org_1/enrollments')) return json({ items: [] });
    if (url.includes('/orgs/org_1/invites')) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

function renderScoped(slug = 'acme') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route element={<ScopedOrgLayout slug={slug} />}>
            <Route index element={<div>org home page</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  restoreFetch();
  setScopedMode(false);
  localStorage.clear();
});

describe('ScopedOrgLayout', () => {
  it('mounts the workspace shell for a member (resolved by slug)', async () => {
    setScopedMode(true);
    useFetch(bootMock({ resolve: 'ok' }));
    renderScoped();
    // The AppShell sidebar (Rooms nav) proves the full workspace mounted.
    expect(await screen.findByRole('navigation', { name: /rooms/i })).toBeInTheDocument();
    // Scoped mode shows the org name statically, not a cross-org switcher.
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
  });

  it('shows a clear "not a member" screen when the slug resolves 404 (no redirect)', async () => {
    setScopedMode(true);
    useFetch(bootMock({ resolve: '404' }));
    renderScoped();
    expect(await screen.findByText(/not a member of this workspace/i)).toBeInTheDocument();
    // No redirect to login — the visitor is signed in.
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
    // A way out is offered (the BareShell frame's Sign out).
    expect(screen.getAllByRole('button', { name: /sign out/i }).length).toBeGreaterThan(0);
  });

  it('sends a signed-out visitor to the login flow', async () => {
    setScopedMode(true);
    useFetch(bootMock({ signedIn: false }));
    renderScoped();
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });
});
