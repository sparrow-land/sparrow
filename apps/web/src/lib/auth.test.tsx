import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// SHIM: the shared `api` client (packages/client) binds `globalThis.fetch`
// eagerly at construction, so a later `vi.stubGlobal('fetch', …)` never reaches
// it. Install a mutable indirection BEFORE the client module is imported so
// per-test mocks route through. `vi.hoisted` runs above the imports below.
const fetchCtl = vi.hoisted(() => {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const original = g.fetch;
  let current: typeof fetch = original;
  g.fetch = ((...a: Parameters<typeof fetch>) => current(...a)) as typeof fetch;
  return {
    set: (f: typeof fetch) => {
      current = f;
    },
    reset: () => {
      current = original;
    },
  };
});

import { AuthProvider, useAuth } from './auth.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A server whose `/auth/me` answers with `meStatus`.
 *  - `200` → a signed-in user
 *  - `'anonymous'` → the current server's `200 { user: null }` (#53)
 *  - anything else → that status with an error envelope (401 = an OLD server's
 *    way of saying "signed out", which the client must still tolerate)
 */
function bootFetchMock(meStatus: number | 'anonymous') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/config')) {
      return json({ providers: [{ id: 'password', label: 'Password', kind: 'credentials' }], allowSignup: true });
    }
    if (url.includes('/auth/me')) {
      if (meStatus === 'anonymous') return json({ user: null });
      return meStatus === 200
        ? json({ user: { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' } })
        : json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, meStatus);
    }
    if (url.includes('/me/orgs')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function Probe() {
  const auth = useAuth();
  return <div data-testid="state">{auth.booting ? 'booting' : auth.signedIn ? 'in' : 'out'}</div>;
}

function renderBoot() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe('AuthProvider boot', () => {
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  // #53: "not signed in" is the expected state for a public page, not an
  // incident — logging it buries the failures that DO matter.
  it('resolves an anonymous visitor quietly (a 401 from /auth/me is not an error)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchCtl.set(bootFetchMock(401));
    renderBoot();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('out'));
    expect(spy).not.toHaveBeenCalled();
  });

  // #53 (server half): the fix moved server-side — `/auth/me` now answers an
  // anonymous caller `200 { user: null }`, so the browser's OWN network log stays
  // clean too (nothing JS can swallow a red 401 line there).
  it('boots signed-out from `200 { user: null }` without touching /me/orgs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = bootFetchMock('anonymous');
    fetchCtl.set(fetchMock);
    renderBoot();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('out'));
    expect(spy).not.toHaveBeenCalled();
    // No user → no org list to fetch; asking would be a second pointless 401.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((u) => u.includes('/me/orgs'))).toBe(false);
  });

  it('still reports a genuine server-side failure of the me-fetch', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchCtl.set(bootFetchMock(500));
    renderBoot();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('out'));
    expect(spy).toHaveBeenCalled();
  });
});
