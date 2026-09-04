import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../lib/client.js';
import { AuthProvider, useAuth } from '../lib/auth.js';
import { Welcome } from './Welcome.js';

/** Mirror AppRoutes' boot gate: routes only mount once auth has resolved. */
function BootGate({ children }: { children: React.ReactNode }) {
  return useAuth().booting ? null : <>{children}</>;
}

/**
 * `/welcome` is the org-less create-an-org experience. It must wear the signed-in
 * BareShell (identity + Sign out, NO marketing Docs/GitHub nav), guard both auth
 * states (signed-out → /login, has-orgs → /), and drive org creation.
 *
 * Drives the real AuthProvider boot via the shared client's `_fetch` (same shim
 * MeLayout.test / AppShell.test use), with sentinel routes so navigation is
 * observable without depending on sibling routes.
 */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'google' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Opts {
  signedIn?: boolean;
  orgs?: { org: { id: string; name: string; slug: string }; role: string }[];
  createStatus?: number;
  createError?: { code: string; message: string };
}

function welcomeFetchMock(opts: Opts = {}) {
  const signedIn = opts.signedIn ?? true;
  let orgs = opts.orgs ?? [];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) {
      return signedIn
        ? json({ user: jake })
        : json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, 401);
    }
    if (url.includes('/me/orgs')) return json({ items: orgs });
    if (url.endsWith('/orgs') && method === 'POST') {
      if ((opts.createStatus ?? 201) !== 201) {
        return json({ error: opts.createError! }, opts.createStatus!);
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
      const org = {
        id: 'org_new',
        name: body.name,
        slug: 'new',
        settings: {
          invites: { who: 'members' },
          enroll: { agents: 'approval' },
          rooms: { create: 'members' },
        },
        createdAt: '2026-08-20T00:00:00Z',
      };
      // After creation the caller belongs to the new org.
      orgs = [{ org: { id: 'org_new', name: body.name, slug: 'new' }, role: 'owner' }];
      return json({ org }, 201);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

function renderWelcome(opts: Opts = {}) {
  useFetch(welcomeFetchMock(opts));
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <AuthProvider>
        <BootGate>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<div>home page</div>} />
          <Route path="/org/:orgId" element={<div>org workspace</div>} />
        </Routes>
        </BootGate>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (api as unknown as WithFetch)._fetch = REAL_FETCH;
  localStorage.clear();
});

describe('Welcome page (/welcome)', () => {
  it('renders the app-style bar with the signed-in identity and NO marketing nav', async () => {
    renderWelcome({ signedIn: true, orgs: [] });
    expect(await screen.findByRole('heading', { name: /create your organization/i })).toBeInTheDocument();
    // The signed-in identity + Sign out prove you ARE logged in.
    expect(screen.getByText('Jake')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    // The marketing chrome is gone.
    expect(screen.queryByRole('link', { name: /docs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /github/i })).not.toBeInTheDocument();
  });

  it('names both first moves once the org exists — invite people, connect an agent', async () => {
    renderWelcome({ signedIn: true, orgs: [] });
    await screen.findByRole('heading', { name: /create your organization/i });
    expect(screen.getByText(/connect your first agent/i)).toBeInTheDocument();
  });

  it('redirects a signed-out visitor to /login', async () => {
    renderWelcome({ signedIn: false });
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  it('redirects a signed-in human who already has an org to /', async () => {
    renderWelcome({
      signedIn: true,
      orgs: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }],
    });
    expect(await screen.findByText('home page')).toBeInTheDocument();
  });

  it('creates an org and navigates into it', async () => {
    renderWelcome({ signedIn: true, orgs: [] });
    await screen.findByRole('heading', { name: /create your organization/i });
    await userEvent.type(screen.getByLabelText(/organization name/i), 'Acme Robotics');
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));
    await waitFor(() => expect(screen.getByText('org workspace')).toBeInTheDocument());
  });

  it('shows the ask-for-invite copy when creation is forbidden', async () => {
    renderWelcome({
      signedIn: true,
      orgs: [],
      createStatus: 403,
      createError: { code: 'forbidden', message: 'nope' },
    });
    await screen.findByRole('heading', { name: /create your organization/i });
    await userEvent.type(screen.getByLabelText(/organization name/i), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: /create organization/i }));
    expect(await screen.findByText(/creating organizations is disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/ask for an invite/i)).toBeInTheDocument();
  });
});
