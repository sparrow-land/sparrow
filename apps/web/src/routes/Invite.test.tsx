import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';

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

import { AuthProvider, useAuth } from '../lib/auth.js';
import { wire } from '../lib/ids.js';
import { Home } from './Home.js';
import { Invite } from './Invite.js';

const jake = {
  id: 'usr_1',
  email: 'jake@acme.com',
  displayName: 'Jake',
  provider: 'password',
};

const DOC = '# Acme Robotics\n\nYou were invited by Dana to join Acme Robotics on sparrow.\n';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface StubOptions {
  signedIn?: boolean;
  /** HTTP status for the info endpoint (non-2xx → a dead-invite state). */
  infoStatus?: number;
  /** Error envelope body the info endpoint returns alongside a non-200 status. */
  infoError?: { code: string; message: string };
  /** Make the info fetch reject outright (transport failure / server unreachable). */
  infoThrows?: boolean;
  /** HTTP status for the root markdown doc fetch (Agent tab; best-effort). */
  docStatus?: number;
  /** Enroll outcome: pending (202, default) or member (200). */
  enroll?: 'pending' | 'member';
  /** Override the `/auth/config` provider list (default: password only). */
  providers?: unknown[];
  /** Override the invite inviter (pass `{displayName:'',email:''}` for none). */
  inviter?: { displayName: string; email: string };
  /** The org's agent enrollment policy (default: approval). */
  agentPolicy?: 'approval' | 'open';
}

function inviteFetchMock(opts: StubOptions = {}) {
  const signedIn = opts.signedIn ?? false;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/config')) {
      return json({
        providers: opts.providers ?? [{ id: 'password', label: 'Password', kind: 'credentials' }],
        allowSignup: true,
      });
    }
    if (url.includes('/auth/me')) {
      return signedIn
        ? json({ user: jake })
        : json({ error: { code: 'unauthorized', message: 'Sign-in required' } }, 401);
    }
    if (url.includes('/me/orgs')) return json({ items: [] });
    // Info (GET /api/v1/invite/:token/info) — the browser-facing hero metadata.
    if (url.includes('/invite/') && url.includes('/info')) {
      if (opts.infoThrows) throw new TypeError('Failed to fetch');
      return (opts.infoStatus ?? 200) !== 200
        ? json(
            {
              error: opts.infoError ?? { code: 'not_found', message: 'no' },
            },
            opts.infoStatus!,
          )
        : json({
            org: { name: 'Acme Robotics' },
            inviter: opts.inviter ?? { displayName: 'Dana', email: 'dana@acme.com' },
            agentPolicy: opts.agentPolicy ?? 'approval',
          });
    }
    // Poll (GET /api/v1/invite/:token/enrollments/:eid) — checked before enroll.
    if (url.includes('/invite/') && url.includes('/enrollments/')) {
      return json({ status: 'pending', retryAfterSeconds: 5 });
    }
    // Enroll (POST /api/v1/invite/:token/enroll).
    if (url.includes('/invite/') && url.includes('/enroll')) {
      return opts.enroll === 'member'
        ? json({ org: { id: 'org_1', name: 'Acme Robotics', slug: 'acme' }, role: 'member' }, 200)
        : json({ enrollment: { id: 'enl_1', status: 'pending' } }, 202);
    }
    // Root markdown onboarding doc (GET /invite/:token, Accept: text/markdown).
    if (url.includes('/invite/')) {
      return new Response(DOC, {
        status: opts.docStatus ?? 200,
        headers: { 'Content-Type': 'text/markdown' },
      });
    }
    if (url.includes('/api/v1/config')) {
      return json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

function renderInvite(token = 'ivk_1') {
  return render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/org/:orgId" element={<div>org workspace</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/**
 * The membership guard `App.tsx`'s `OrgLayout` applies to every `/org/:orgId`
 * route, reproduced here (App.tsx is not under test): a signed-in NON-member is
 * bounced to `/`, which is where a stale `auth.orgs` sends a fresh joiner.
 */
function OrgGuard() {
  const auth = useAuth();
  const { orgId = '' } = useParams<{ orgId: string }>();
  if (!auth.orgs.some((o) => o.org.id === wire('org', orgId))) return <Navigate to="/" replace />;
  return <div>org workspace</div>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

/**
 * The invite page mounted inside the REAL post-join route graph — org routes
 * behind the membership guard, `/` behind {@link Home}, `/welcome` as the
 * create-an-org dead end. This is what turns a stale org list into the visible
 * "Create your organization" bug rather than a silent no-op.
 */
function renderInviteInApp(token = 'ivk_1') {
  return render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <AuthProvider>
        <LocationProbe />
        <Routes>
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<Home />} />
          <Route path="/welcome" element={<div>Create your organization</div>} />
          <Route path="/org/:orgId" element={<OrgGuard />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The raw text inside the Terminal block carrying `label`. */
function terminalCode(label: string): string {
  const term = screen.getByText(label).closest('.terminal');
  if (!term) throw new Error(`no terminal labelled "${label}"`);
  return term.querySelector('code')?.textContent ?? '';
}

describe('Invite landing page (/invite/:token)', () => {
  // jsdom's `window.location.assign` is a non-configurable throwing no-op, so we
  // can't spy on it directly. Swap the whole `location` for a plain stand-in that
  // reads through to the real one for URL parts but uses our mock for `assign`.
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
    assignMock.mockClear();
  });

  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  // A managed tenant advertises password (for automation) + a PRIMARY
  // oauth-redirect provider; an unauthenticated invitee should bounce silently
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

  // #42: a link holder is far more often a NEWCOMER than a returning user, so
  // the primary CTA opens the create-account view; the sign-in door stays a
  // click away underneath.
  it('points a signed-out visitor at the create-account view, next preserved', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    const cta = await screen.findByRole('link', { name: /create an account to join/i });
    expect(cta).toHaveAttribute(
      'href',
      `/login?view=signup&next=${encodeURIComponent('/invite/ivk_1')}`,
    );
    expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent('/invite/ivk_1')}`,
    );
  });

  // #53: the invite URL is a bearer token — anyone holding it sees this page, so
  // it may name the inviter but must not leak their email address.
  it('surfaces the org name + inviter NAME, never the inviter email', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    expect(await screen.findByRole('heading', { name: /acme robotics/i })).toBeInTheDocument();
    expect(screen.getByText(/invited by dana/i)).toBeInTheDocument();
    expect(screen.queryByText(/dana@acme\.com/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('dana@acme.com');
  });

  it('the person tab is the default and points agent-wranglers at the other tab', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: true }));
    renderInvite();
    expect(await screen.findByRole('button', { name: /join workspace/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /join as a person/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText(/here to connect an ai agent instead\?/i)).toBeInTheDocument();
  });

  it('the agent tab offers both loop modes, harness first, with their pills', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));

    expect(screen.getByText(/two ways to connect an agent to acme robotics/i)).toBeInTheDocument();

    const harness = screen.getByRole('heading', { name: /harness mode/i });
    const inline = screen.getByRole('heading', { name: /inline mode/i });
    expect(harness).toBeInTheDocument();
    expect(inline).toBeInTheDocument();
    // Harness is presented first.
    expect(harness.compareDocumentPosition(inline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByText(/needs the cli/i)).toBeInTheDocument();
    expect(screen.getByText(/no install/i)).toBeInTheDocument();
    expect(screen.getByText(/most reliable/i)).toBeInTheDocument();
    expect(screen.getByText(/quickest/i)).toBeInTheDocument();

    // Harness: the two-command block, embedding this invite URL.
    const cmd = terminalCode('sparrow harness');
    expect(cmd).toContain('# on a machine that stays up');
    // One installer home (SPEC: *Canonical public homes*): the canonical URL,
    // never this instance's origin — while the invite URL stays the instance's.
    expect(cmd).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(cmd).not.toMatch(/localhost.*install\.sh|http:\/\/[^\s]*\/install\.sh/);
    expect(cmd).toMatch(/sparrow harness \\\n {2}--url http.*\/invite\/ivk_1/);

    // Inline: the bare invite URL to paste into an open agent.
    expect(terminalCode('invite link')).toMatch(/^http.*\/invite\/ivk_1$/);
  });

  it('says a member approves the agent under an approval policy', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false, agentPolicy: 'approval' }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));
    expect(
      screen.getByText(
        /Both use this same invite URL; a member approves the agent once it enrolls\./i,
      ),
    ).toBeInTheDocument();
  });

  it('says the agent is admitted straight away under an open policy', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false, agentPolicy: 'open' }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));
    expect(
      screen.getByText(
        /Both use this same invite URL; the agent is admitted as soon as it enrolls\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/a member approves the agent/i)).not.toBeInTheDocument();
  });

  it('the runtime picker rewrites the harness command', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));

    // Claude Code is the default runner — no runner flag at all.
    expect(terminalCode('sparrow harness')).not.toMatch(/--codex|--gemini|--exec/);

    await userEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(terminalCode('sparrow harness')).toContain('--codex');

    await userEvent.click(screen.getByRole('radio', { name: /gemini/i }));
    expect(terminalCode('sparrow harness')).toContain('--gemini');

    await userEvent.click(screen.getByRole('radio', { name: /other/i }));
    expect(terminalCode('sparrow harness')).toContain("--exec '<your command>'");
  });

  it('the option hint under the harness command follows the runtime', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));
    const hint = (): string => screen.getByText(/sets the working folder/i).textContent ?? '';

    expect(hint()).toContain('--model sonnet');
    await userEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(hint()).toContain('--sandbox read-only');
    expect(hint()).not.toContain('sonnet');
  });

  it('tucks the onboarding doc behind a closed disclosure', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false }));
    renderInvite();
    await userEvent.click(await screen.findByRole('tab', { name: /connect an agent/i }));

    const summary = await screen.findByText(/what the agent reads/i);
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    await userEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(await screen.findByText(/You were invited by Dana/)).toBeInTheDocument();
  });

  it('a pending human enrollment shows the calm waiting state', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: true, enroll: 'pending' }));
    renderInvite();
    await userEvent.click(await screen.findByRole('button', { name: /join workspace/i }));
    expect(await screen.findByText(/waiting for approval/i)).toBeInTheDocument();
  });

  it('an instant admission lands on the "you\'re in" state', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: true, enroll: 'member' }));
    renderInvite();
    await userEvent.click(await screen.findByRole('button', { name: /join workspace/i }));
    expect(await screen.findByText(/you're in/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to acme robotics/i })).toHaveAttribute(
      'href',
      '/org/1',
    );
  });

  it('a 404 from the info endpoint renders the not-valid state with the server copy', async () => {
    fetchCtl.set(
      inviteFetchMock({
        infoStatus: 404,
        infoError: {
          code: 'not_found',
          message:
            'This invite link is not valid. Check the link you were given, or ask whoever invited you for a new one.',
        },
      }),
    );
    renderInvite();
    expect(await screen.findByRole('heading', { name: /isn't valid/i })).toBeInTheDocument();
    expect(screen.getByText(/check the link you were given/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /agent/i })).not.toBeInTheDocument();
  });

  // 410 vs 404: a revoked invite says so, in the server's own words — the SPA
  // must not re-author (or flatten) the reason.
  it('a revoked invite (410) says it was revoked', async () => {
    fetchCtl.set(
      inviteFetchMock({
        infoStatus: 410,
        infoError: {
          code: 'gone',
          message: 'This invite has been revoked. Ask whoever invited you for a new link.',
        },
      }),
    );
    renderInvite();
    expect(
      await screen.findByRole('heading', { name: /this invite is no longer valid/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/has been revoked/i)).toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('an expired invite (410) says it expired, not that it was revoked', async () => {
    fetchCtl.set(
      inviteFetchMock({
        infoStatus: 410,
        infoError: {
          code: 'gone',
          message: 'This invite has expired. Ask whoever invited you for a new link.',
        },
      }),
    );
    renderInvite();
    expect(
      await screen.findByRole('heading', { name: /this invite is no longer valid/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/revoked/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('a transport failure shows a neutral load error, not "invalid invite"', async () => {
    fetchCtl.set(inviteFetchMock({ infoThrows: true }));
    renderInvite();
    expect(
      await screen.findByRole('heading', { name: /couldn't load this invite/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/revoked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't valid|is not valid|invalid/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('hides the "Invited by" line when the invite has no inviter', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false, inviter: { displayName: '', email: '' } }));
    renderInvite();
    // Wait for the hero to render, then assert the inviter line is absent.
    expect(await screen.findByRole('heading', { name: /acme robotics/i })).toBeInTheDocument();
    expect(screen.queryByText(/invited by/i)).not.toBeInTheDocument();
    // And no stray empty parens from a null email.
    expect(screen.queryByText('()')).not.toBeInTheDocument();
  });

  it('auto-initiates SSO for an unauthenticated visitor when a primary oauth provider exists', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: false, providers: PLATFORM_PROVIDERS }));
    renderInvite();
    await vi.waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    expect(assignMock).toHaveBeenCalledWith(
      `https://acme.example/api/v1/auth/platform?next=${encodeURIComponent('/invite/ivk_1')}`,
    );
    // Loop guard marker set so a return-unauthenticated does not redirect again.
    expect(sessionStorage.getItem('sparrow.invite.sso.ivk_1')).toBeTruthy();
  });

  it('does not auto-redirect when already authenticated', async () => {
    fetchCtl.set(inviteFetchMock({ signedIn: true, providers: PLATFORM_PROVIDERS }));
    renderInvite();
    expect(await screen.findByRole('button', { name: /join workspace/i })).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not auto-redirect when no provider is marked primary (shows the CTA)', async () => {
    fetchCtl.set(
      inviteFetchMock({
        signedIn: false,
        providers: [
          { id: 'password', label: 'Password', kind: 'credentials' },
          {
            id: 'google',
            label: 'Google',
            kind: 'oauth-redirect',
            loginUrl: 'https://acme.example/api/v1/auth/google',
          },
        ],
      }),
    );
    renderInvite();
    const cta = await screen.findByRole('link', { name: /create an account to join/i });
    expect(cta).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not auto-redirect when the loop-guard marker is already set', async () => {
    sessionStorage.setItem('sparrow.invite.sso.ivk_1', '1');
    fetchCtl.set(inviteFetchMock({ signedIn: false, providers: PLATFORM_PROVIDERS }));
    renderInvite();
    const cta = await screen.findByRole('link', { name: /create an account to join/i });
    expect(cta).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });
});

/* ---- #36: joining must refresh the org list BEFORE the org route mounts ---- */

const JOINED_ORG = { id: 'org_1', name: 'Acme Robotics', slug: 'acme' };

/**
 * A server where the join really lands: `GET /me/orgs` returns nothing on the
 * boot call and the membership on every call after it. The client only sees the
 * membership if it re-asks — exactly the condition that made "Go to Acme
 * Robotics" dump invitees on "Create your organization".
 */
function joinFetchMock() {
  let orgsCalls = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/config')) {
      return json({
        providers: [{ id: 'password', label: 'Password', kind: 'credentials' }],
        allowSignup: true,
      });
    }
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      orgsCalls += 1;
      return json({ items: orgsCalls > 1 ? [{ org: JOINED_ORG, role: 'member' }] : [] });
    }
    if (url.includes('/invite/') && url.includes('/info')) {
      return json({
        org: { name: 'Acme Robotics' },
        inviter: { displayName: 'Dana', email: 'dana@acme.com' },
        agentPolicy: 'approval',
      });
    }
    if (url.includes('/invite/') && url.includes('/enroll')) {
      return json({ org: JOINED_ORG, role: 'member' }, 200);
    }
    if (url.includes('/invite/')) {
      return new Response(DOC, { status: 200, headers: { 'Content-Type': 'text/markdown' } });
    }
    return json({ error: { code: 'not_found', message: `unmocked ${url}` } }, 404);
  });
}

describe('Invite join → org handoff', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    fetchCtl.reset();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('"Go to <org>" lands in the org, not on "Create your organization"', async () => {
    fetchCtl.set(joinFetchMock());
    renderInviteInApp();

    await userEvent.click(await screen.findByRole('button', { name: /join workspace/i }));
    expect(await screen.findByText(/you're in/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /go to acme robotics/i }));

    expect(await screen.findByText('org workspace')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('/org/1');
    expect(screen.queryByText(/create your organization/i)).not.toBeInTheDocument();
  });
});
