import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../lib/client.js';
import { AuthProvider, useAuth } from '../lib/auth.js';
import { Home } from './Home.js';

/** Mirror AppRoutes' boot gate: routes only mount once auth has resolved. */
function BootGate({ children }: { children: React.ReactNode }) {
  return useAuth().booting ? null : <>{children}</>;
}

/**
 * `/` routes by auth state. A signed-in human with NO org must be sent to
 * `/welcome` (a real client-side navigation, which also clears the stray `#`
 * fragment Google leaves on the OAuth redirect) — the create-org panel no
 * longer renders inline here.
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
}

function homeFetchMock(opts: Opts = {}) {
  const signedIn = opts.signedIn ?? true;
  const orgs = opts.orgs ?? [];
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) {
      return signedIn
        ? json({ user: jake })
        : json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, 401);
    }
    if (url.includes('/me/orgs')) return json({ items: orgs });
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function renderHome(opts: Opts = {}) {
  useFetch(homeFetchMock(opts));
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <BootGate>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/welcome" element={<div>welcome page</div>} />
          <Route path="/login" element={<div>login page</div>} />
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

describe('Home (/)', () => {
  it('redirects a signed-in human with NO org to /welcome', async () => {
    renderHome({ signedIn: true, orgs: [] });
    expect(await screen.findByText('welcome page')).toBeInTheDocument();
  });

  it('redirects a signed-out visitor to /login', async () => {
    renderHome({ signedIn: false });
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  it('redirects a signed-in human with an org into it', async () => {
    renderHome({
      signedIn: true,
      orgs: [{ org: { id: 'org_1', name: 'Acme', slug: 'acme' }, role: 'owner' }],
    });
    expect(await screen.findByText('org workspace')).toBeInTheDocument();
  });
});
