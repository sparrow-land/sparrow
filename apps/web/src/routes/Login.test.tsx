import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// SHIM: the shared `api` client (packages/client) binds `globalThis.fetch`
// eagerly at construction, so a later `vi.stubGlobal('fetch', …)` never reaches
// it (relative `/api/v1/...` URLs then throw). Until the client reads fetch
// lazily, install a mutable indirection BEFORE the client module is imported so
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

import { AuthProvider } from '../lib/auth.js';
import { Login, humanizeAuthError } from './Login.js';

const jake = {
  id: 'usr_1',
  email: 'jake@acme.com',
  displayName: 'Jake',
  provider: 'password',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface StubOptions {
  providers?: unknown[];
  allowSignup?: boolean;
  /** `GET /auth/config` → `bootstrapOrg: true` (the next signup founds the workspace). */
  bootstrapOrg?: boolean;
  /** Captures the parsed `POST /auth/signup` body for assertions. */
  onSignup?: (body: Record<string, unknown>) => void;
  loginStatus?: number;
  signupStatus?: number;
  signupError?: { code: string; message: string };
  /** When true, boot resolves signed-in (GET /auth/me → user). */
  signedIn?: boolean;
}

// A managed tenant advertises password (for automation) + a PRIMARY
// oauth-redirect provider; an unauthenticated visitor should bounce silently
// through that provider rather than being asked to click "sign in".
const PLATFORM_PROVIDERS = [
  { id: 'password', label: 'Password', kind: 'credentials' },
  {
    id: 'platform',
    label: 'Company SSO',
    kind: 'oauth-redirect',
    loginUrl: 'https://acme.example/api/v1/auth/platform',
    primary: true,
  },
];

/** Fetch stub for a v3 instance (accounts always on; login/signup → { user, token }). */
function authFetchMock(opts: StubOptions = {}) {
  const providers = opts.providers ?? [{ id: 'password', label: 'Password', kind: 'credentials' }];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth/config')) {
      return json({
        providers,
        allowSignup: opts.allowSignup ?? true,
        ...(opts.bootstrapOrg ? { bootstrapOrg: true } : {}),
      });
    }
    if (url.includes('/auth/me')) {
      // Boot is signed-out unless the test opts in; sign-in otherwise via the form.
      if (opts.signedIn) return json({ user: jake });
      return json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, 401);
    }
    if (url.includes('/me/orgs')) return json({ items: [] });
    if (url.includes('/auth/login')) {
      if ((opts.loginStatus ?? 200) !== 200) {
        return json(
          { error: { code: 'unauthorized', message: 'Invalid email or password' } },
          opts.loginStatus!,
        );
      }
      return json({ user: jake, token: 'ses_tok' });
    }
    if (url.includes('/auth/signup')) {
      if (opts.signupStatus && opts.signupStatus !== 201) {
        return json({ error: opts.signupError! }, opts.signupStatus);
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      opts.onSignup?.(body);
      return json(
        { user: { ...jake, email: (body.email as string) ?? jake.email }, token: 'ses_tok' },
        201,
      );
    }
    if (url.includes('/api/v1/config')) {
      return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

/** Renders the live URL so tests can assert the view is deep-linkable. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

/** Render the Login route with sentinel targets so navigation is observable
 * without depending on sibling routes written by other agents. */
function renderLogin(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <LocationProbe />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>workspace home</div>} />
          <Route path="/invite/:token" element={<div>invite landing</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The current URL as the router sees it. */
function loc(): string {
  return screen.getByTestId('loc').textContent ?? '';
}

describe('Login page (/login)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  // #48: /login carried index.html's marketing title, identical to every other
  // route — a tab, a history entry and a page announcement all said the same thing.
  it('titles the document per view', async () => {
    renderLogin('/login');
    await waitFor(() => expect(document.title).toBe('Sign in — sparrow'));
    cleanup();
    renderLogin('/login?view=signup');
    await waitFor(() => expect(document.title).toBe('Create your account — sparrow'));
  });

  it('renders the login form at /login', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login');
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('logs in with credentials and redirects to next (default /)', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login');
    await userEvent.type(await screen.findByLabelText(/email/i), 'jake@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(screen.getByText('workspace home')).toBeInTheDocument());
  });

  it('shows the server message for bad credentials', async () => {
    fetchCtl.set(authFetchMock({ loginStatus: 401 }));
    renderLogin('/login');
    await userEvent.type(await screen.findByLabelText(/email/i), 'jake@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });

  it('offers sign-up when the instance allows it, and creates the account', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login');
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }));
    expect(screen.getByRole('heading', { name: /create your account/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/display name/i), 'Jake');
    await userEvent.type(screen.getByLabelText(/email/i), 'jake@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(screen.getByText('workspace home')).toBeInTheDocument());
  });

  it('hides sign-up when the instance disallows it', async () => {
    fetchCtl.set(authFetchMock({ allowSignup: false }));
    renderLogin('/login');
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.queryByRole('button', { name: /create an account/i })).not.toBeInTheDocument();
  });

  it('surfaces a 403 when signup is disabled server-side mid-flight', async () => {
    fetchCtl.set(
      authFetchMock({
        signupStatus: 403,
        signupError: { code: 'forbidden', message: 'Signup is disabled on this instance' },
      }),
    );
    renderLogin('/login');
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }));
    await userEvent.type(screen.getByLabelText(/email/i), 'eve@evil.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/signup is disabled/i)).toBeInTheDocument();
  });

  it('renders a Continue button per oauth-redirect provider with ?next= preserved', async () => {
    fetchCtl.set(
      authFetchMock({
        providers: [
          { id: 'google', label: 'Google', kind: 'oauth-redirect', loginUrl: '/api/v1/auth/google' },
        ],
      }),
    );
    renderLogin(`/login?next=${encodeURIComponent('/invite/ivk_1')}`);
    const button = await screen.findByRole('link', { name: /continue with google/i });
    expect(button).toHaveAttribute(
      'href',
      `/api/v1/auth/google?next=${encodeURIComponent('/invite/ivk_1')}`,
    );
    // Invitees get the invite hint.
    expect(screen.getByText(/you were invited — sign in to continue/i)).toBeInTheDocument();
  });
});

/* ---- #40: the subtitle must follow the view, not just `invited` ---- */

describe('Login page subtitle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  it('reads as sign-in copy on the sign-in view and account copy on the signup view', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login');
    expect(
      await screen.findByText(/sign in to sync your rooms across browsers/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /create an account/i }));
    expect(
      screen.queryByText(/sign in to sync your rooms across browsers/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/create an account to sync your rooms across browsers/i),
    ).toBeInTheDocument();
  });

  it('keeps an invite-aware subtitle in both views', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin(`/login?next=${encodeURIComponent('/invite/ivk_1')}`);
    expect(
      await screen.findByText(/you were invited — sign in to continue/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /create an account/i }));
    expect(
      screen.getByText(/you were invited — create your account to continue/i),
    ).toBeInTheDocument();
  });
});

/* ---- #41: raw Zod/server validation text never reaches a human ---- */

describe('humanizeAuthError', () => {
  it('maps the password-length message the API emits verbatim from Zod', () => {
    expect(humanizeAuthError('password: String must contain at least 8 character(s)')).toBe(
      'Password must be at least 8 characters.',
    );
  });

  it('maps other min-length fields, with a known label and correct plurality', () => {
    expect(humanizeAuthError('displayName: String must contain at least 1 character(s)')).toBe(
      'Display name must be at least 1 character.',
    );
    expect(humanizeAuthError('email: String must contain at least 3 character(s)')).toBe(
      'Email must be at least 3 characters.',
    );
  });

  it('maps max-length messages too, falling back to the raw field name', () => {
    expect(humanizeAuthError('nickname: String must contain at most 80 character(s)')).toBe(
      'Nickname must be at most 80 characters.',
    );
  });

  it('maps the email-format message', () => {
    expect(humanizeAuthError('email: Invalid email')).toBe(
      'Enter a valid email address.',
    );
  });

  it('never swallows an unrecognised message', () => {
    expect(humanizeAuthError('Signup is disabled on this instance')).toBe(
      'Signup is disabled on this instance',
    );
    expect(humanizeAuthError('Invalid email or password')).toBe('Invalid email or password');
  });
});

describe('Login page validation copy', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  it('shows human copy (not the Zod string) for a too-short password', async () => {
    fetchCtl.set(
      authFetchMock({
        signupStatus: 400,
        signupError: {
          code: 'bad_request',
          message: 'password: String must contain at least 8 character(s)',
        },
      }),
    );
    renderLogin('/login?view=signup');
    await userEvent.type(await screen.findByLabelText(/email/i), 'jake@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(
      await screen.findByText('Password must be at least 8 characters.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/String must contain/i)).not.toBeInTheDocument();
  });
});

/* ---- #42: the signup view is a real, linkable URL ---- */

describe('Login page view routing (?view=)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  it('deep-links straight to the create-account view', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login?view=signup');
    expect(
      await screen.findByRole('heading', { name: /create your account/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it('puts the view in the URL when the toggle flips, preserving next', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin(`/login?next=${encodeURIComponent('/invite/ivk_1')}`);
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }));
    await waitFor(() => expect(loc()).toContain('view=signup'));
    expect(loc()).toContain(`next=${encodeURIComponent('/invite/ivk_1')}`);

    // …and back again, still carrying next.
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^sign in$/i })).toBeInTheDocument(),
    );
    expect(loc()).not.toContain('view=signup');
    expect(loc()).toContain(`next=${encodeURIComponent('/invite/ivk_1')}`);
  });
});

/* ---- #47: the view flip must be announced ---- */

describe('Login page toggle focus', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  it('moves focus to the heading on toggle, but never steals it on mount', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login');
    const signInHeading = await screen.findByRole('heading', { name: /^sign in$/i });
    expect(signInHeading).toHaveAttribute('tabindex', '-1');
    // Mount focuses the email field (autoFocus), not the heading.
    expect(document.activeElement).not.toBe(signInHeading);

    await userEvent.click(screen.getByRole('button', { name: /create an account/i }));
    const signUpHeading = await screen.findByRole('heading', { name: /create your account/i });
    await waitFor(() => expect(document.activeElement).toBe(signUpHeading));
  });
});

describe('Login page auto-SSO (primary oauth provider)', () => {
  // jsdom's `window.location.assign` is a non-configurable throwing no-op, so we
  // swap the whole `location` for a stand-in that reads through for URL parts but
  // routes `assign` to our mock (same approach as the invite page tests).
  const assignMock = vi.fn();
  beforeAll(() => {
    const real = window.location;
    const fake: Record<string, unknown> = { assign: assignMock, replace: vi.fn(), reload: vi.fn() };
    for (const k of ['origin', 'href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
      Object.defineProperty(fake, k, { get: () => (real as unknown as Record<string, unknown>)[k], enumerable: true });
    }
    Object.defineProperty(window, 'location', { configurable: true, value: fake });
  });
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    assignMock.mockClear();
  });
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('auto-redirects an unauthenticated visitor through the primary provider with next preserved', async () => {
    fetchCtl.set(authFetchMock({ providers: PLATFORM_PROVIDERS }));
    renderLogin(`/login?next=${encodeURIComponent('/org/acme')}`);
    await vi.waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    expect(assignMock).toHaveBeenCalledWith(
      `https://acme.example/api/v1/auth/platform?next=${encodeURIComponent('/org/acme')}`,
    );
    // Loop guard set so a return-unauthenticated does not bounce again.
    expect(sessionStorage.getItem('sparrow.login.sso')).toBeTruthy();
    // The interstitial shows, not the provider buttons.
    expect(screen.queryByRole('link', { name: /continue with company sso/i })).not.toBeInTheDocument();
  });

  it('defaults next to / when none is supplied', async () => {
    fetchCtl.set(authFetchMock({ providers: PLATFORM_PROVIDERS }));
    renderLogin('/login');
    await vi.waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    expect(assignMock).toHaveBeenCalledWith(
      `https://acme.example/api/v1/auth/platform?next=${encodeURIComponent('/')}`,
    );
  });

  it('does not auto-redirect when already authenticated', async () => {
    fetchCtl.set(authFetchMock({ providers: PLATFORM_PROVIDERS, signedIn: true }));
    renderLogin('/login');
    await waitFor(() => expect(screen.getByText('workspace home')).toBeInTheDocument());
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not auto-redirect when no provider is marked primary (buttons render)', async () => {
    fetchCtl.set(
      authFetchMock({
        providers: [
          { id: 'password', label: 'Password', kind: 'credentials' },
          { id: 'google', label: 'Google', kind: 'oauth-redirect', loginUrl: '/api/v1/auth/google' },
        ],
      }),
    );
    renderLogin('/login');
    expect(await screen.findByRole('link', { name: /continue with google/i })).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not auto-redirect when the loop-guard marker is already set (fallback buttons render)', async () => {
    sessionStorage.setItem('sparrow.login.sso', '1');
    fetchCtl.set(authFetchMock({ providers: PLATFORM_PROVIDERS }));
    renderLogin('/login');
    expect(await screen.findByRole('link', { name: /continue with company sso/i })).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });
});

/**
 * Issue #27(a) — the founding signup gets to NAME the workspace.
 *
 * The first account on an instance silently created `alice@example.com's org`,
 * slug and all, and nothing ever asked. `GET /auth/config` now says
 * `bootstrapOrg: true` while the next signup would be the founding one, and the
 * sign-up form grows one optional field on exactly those instances.
 */
describe('Login page — bootstrap workspace name', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
  });

  it('shows the Workspace name field on the sign-up view of a fresh instance', async () => {
    fetchCtl.set(authFetchMock({ bootstrapOrg: true }));
    renderLogin('/login?view=signup');
    expect(await screen.findByLabelText(/workspace name/i)).toBeInTheDocument();
  });

  it('never shows it on the SIGN-IN view, even on a fresh instance', async () => {
    fetchCtl.set(authFetchMock({ bootstrapOrg: true }));
    renderLogin('/login');
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.queryByLabelText(/workspace name/i)).not.toBeInTheDocument();
  });

  it('never shows it once the instance already has an org (no bootstrapOrg signal)', async () => {
    fetchCtl.set(authFetchMock());
    renderLogin('/login?view=signup');
    await screen.findByRole('heading', { name: /create your account/i });
    expect(screen.queryByLabelText(/workspace name/i)).not.toBeInTheDocument();
  });

  it('sends what was typed as `orgName`', async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchCtl.set(authFetchMock({ bootstrapOrg: true, onSignup: (b) => bodies.push(b) }));
    renderLogin('/login?view=signup');
    await userEvent.type(await screen.findByLabelText(/workspace name/i), 'Acme Robotics');
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.orgName).toBe('Acme Robotics');
  });

  it('omits `orgName` entirely when the field is left blank (server default stands)', async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchCtl.set(authFetchMock({ bootstrapOrg: true, onSignup: (b) => bodies.push(b) }));
    renderLogin('/login?view=signup');
    await userEvent.type(await screen.findByLabelText(/email/i), 'alice@acme.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty('orgName');
  });
});
