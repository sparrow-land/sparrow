import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { App } from '../App.js';
import { AuthProvider } from '../lib/auth.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { api } from '../lib/client.js';
import { peekOnboarding, resetOnboardingCache } from '../lib/onboarding.js';
import { Onboarding } from './Onboarding.js';

/** Point the shared client's `_fetch` at the mock (see InviteDialog.test). */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

const ORG_ID = 'org_1';
const INVITE_URL = 'https://sparrow.example.com/invite/ivk_secrettoken';
const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface MockOpts {
  /** What `GET /api/v1/onboarding` answers. */
  active?: boolean;
  reason?: string;
  /** Boot signed-in (a reload mid-wizard). */
  signedIn?: boolean;
  /** Captures the parsed `POST /auth/signup` body. */
  onSignup?: (body: Record<string, unknown>) => void;
}

interface Recorder {
  calls: { method: string; url: string }[];
}

function mockFetch(opts: MockOpts = {}, rec: Recorder = { calls: [] }) {
  // Before the founding signup the instance has no org; after it, one.
  let founded = opts.signedIn ?? false;
  let signedIn = opts.signedIn ?? false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    rec.calls.push({ method, url });

    if (url.includes('/api/v1/onboarding/dismiss')) return new Response(null, { status: 204 });
    if (url.includes('/api/v1/onboarding')) {
      const active = opts.active ?? true;
      return json({ active, reason: opts.reason ?? (active ? 'empty' : 'populated') });
    }

    if (url.includes('/auth/config')) {
      return json({
        providers: [{ id: 'password', label: 'Password', kind: 'credentials' }],
        allowSignup: true,
        bootstrapOrg: !founded,
      });
    }
    if (url.includes('/auth/me')) return json({ user: signedIn ? jake : null });
    if (url.includes('/auth/signup')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      opts.onSignup?.(body);
      founded = true;
      signedIn = true;
      return json({ user: jake, token: 'ses_tok' }, 201);
    }
    if (url.includes('/me/orgs')) {
      return json({
        items: founded ? [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: 'owner' }] : [],
      });
    }

    // Workspace sources the reused invite panels hang off.
    if (url.includes('/me/events')) return json('');
    if (url.includes(`/orgs/${ORG_ID}/me/humans`)) return json({ items: [] });
    if (url.includes(`/orgs/${ORG_ID}/me/agents`)) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });
    if (url.includes(`/orgs/${ORG_ID}/enrollments`)) return json({ items: [] });

    if (url.includes(`/orgs/${ORG_ID}/invites`) && method === 'POST') {
      return json(
        {
          invite: {
            id: 'inv_1',
            inviter: { id: 'usr_1', displayName: 'Jake' },
            note: null,
            expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            revokedAt: null,
            createdAt: new Date().toISOString(),
            useCount: 0,
          },
          url: INVITE_URL,
        },
        201,
      );
    }
    if (url.includes(`/orgs/${ORG_ID}/invites`)) return json({ items: [] });
    if (url.includes('/capabilities')) {
      return json({
        email: false,
        emailReviewer: false,
        voice: { stt: false, tts: false },
        orgHostSuffix: null,
        workspaceSwitcher: null,
      });
    }

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function loc(): string {
  return screen.getByTestId('loc').textContent ?? '';
}

/** The wizard with sentinel destinations, so navigation is observable. */
function renderWizard(entry = '/onboarding') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <CapabilitiesProvider>
          <LocationProbe />
          <Routes>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/login" element={<div>login page</div>} />
            <Route path="/" element={<div>workspace home</div>} />
          </Routes>
        </CapabilitiesProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Everything on screen, whitespace collapsed. */
function bodyText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

/** Walk the wizard from the welcome step to the "Invite an agent" step. */
async function walkToAgents() {
  await userEvent.click(await screen.findByRole('button', { name: /get started/i }));
  await userEvent.type(await screen.findByLabelText(/workspace name/i), 'Acme Robotics');
  await userEvent.type(screen.getByLabelText(/display name/i), 'Jake');
  await userEvent.type(screen.getByLabelText(/email/i), 'jake@acme.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
  await userEvent.click(screen.getByRole('button', { name: /create workspace/i }));
  return screen.findByRole('heading', { name: /invite an agent/i });
}

describe('Onboarding wizard (/onboarding)', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [] };
    localStorage.clear();
    resetOnboardingCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  describe('route gating', () => {
    it('sends /login to /onboarding while onboarding is active', async () => {
      useFetch(mockFetch({ active: true }, rec));
      render(
        <MemoryRouter initialEntries={['/login']}>
          <App />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { name: /welcome to sparrow/i })).toBeInTheDocument();
    });

    it('sends /onboarding to /login when onboarding is not active', async () => {
      useFetch(mockFetch({ active: false, reason: 'populated' }, rec));
      render(
        <MemoryRouter initialEntries={['/onboarding']}>
          <App />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
    });

    it('asks the server exactly once per page load', async () => {
      useFetch(mockFetch({ active: true }, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      await userEvent.click(screen.getByRole('button', { name: /get started/i }));
      await screen.findByRole('heading', { name: /set up your org and account/i });
      const asks = rec.calls.filter(
        (c) => c.url.includes('/api/v1/onboarding') && !c.url.includes('dismiss'),
      );
      expect(asks).toHaveLength(1);
    });
  });

  describe('step 1 — welcome', () => {
    it('shows the headline, the visual and the docs link', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      expect(await screen.findByRole('heading', { name: /welcome to sparrow/i })).toBeInTheDocument();
      expect(bodyText()).toContain('messaging built for your agents');
      expect(bodyText()).toContain('your hardware');
      expect(screen.getByRole('img').getAttribute('src')).toBe('/onboarding/welcome.png');
      const link = screen.getByRole('link', { name: 'What is Sparrow?' });
      expect(link).toHaveAttribute('href', 'https://sparrow.land/docs/what-is-sparrow/');
    });

    it('counts the steps, marking the current one', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      expect(screen.getByText('1 of 4')).toBeInTheDocument();
      const current = document.querySelector('[aria-current="step"]');
      expect(current?.textContent).toMatch(/welcome/i);
    });
  });

  describe('step 2 — org and account', () => {
    it('renders the founding form with the instance-local reassurance', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await userEvent.click(await screen.findByRole('button', { name: /get started/i }));
      expect(
        await screen.findByRole('heading', { name: /set up your org and account/i }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      expect(
        screen.getByText('Everything lives on this instance. Nothing is sent to sparrow.land.'),
      ).toBeInTheDocument();
      expect(screen.getByText('2 of 4')).toBeInTheDocument();
      expect(screen.getByRole('img').getAttribute('src')).toBe('/onboarding/org.png');
    });

    it('creates the workspace through the signup route and advances', async () => {
      const bodies: Record<string, unknown>[] = [];
      useFetch(mockFetch({ onSignup: (b) => bodies.push(b) }, rec));
      renderWizard();
      await walkToAgents();
      expect(bodies[0]).toMatchObject({
        email: 'jake@acme.com',
        displayName: 'Jake',
        orgName: 'Acme Robotics',
      });
    });
  });

  describe('step 3 — invite an agent', () => {
    it('says what an agent needs, links the docs, and reuses the connect panel', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await walkToAgents();
      expect(bodyText()).toContain(
        'If your agent can use MCP or invoke tools, it can participate in your Sparrow instance.',
      );
      expect(screen.getByRole('link', { name: 'What does my agent see?' })).toHaveAttribute(
        'href',
        'https://sparrow.land/docs/what-my-agent-sees/',
      );
      expect(screen.getByText('How should the agent connect?')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /harness/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /inline/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Claude Code' })).toBeInTheDocument();
      // The live invite really is minted and shown in the command.
      await waitFor(() =>
        expect(document.querySelector('pre.terminal-body')?.textContent ?? '').toContain(
          INVITE_URL,
        ),
      );
      // And the live approvals block is there, waiting.
      expect(screen.getByText('Approvals')).toBeInTheDocument();
      expect(screen.getByAltText(/three sparrows carrying letters/i).getAttribute('src')).toBe(
        '/onboarding/agents.png',
      );
    });

    it('Next and Skip both go to the humans step', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await walkToAgents();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      expect(
        await screen.findByRole('heading', { name: /humans are welcome too/i }),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /^back$/i }));
      await screen.findByRole('heading', { name: /invite an agent/i });
      await userEvent.click(screen.getByRole('button', { name: /^skip$/i }));
      expect(
        await screen.findByRole('heading', { name: /humans are welcome too/i }),
      ).toBeInTheDocument();
    });
  });

  describe('step 4 — invite humans', () => {
    it('reuses the person invite link and links the who-can-message docs', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await walkToAgents();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByRole('heading', { name: /humans are welcome too/i });
      expect(
        screen.getByRole('link', { name: 'Who is allowed to message my agents?' }),
      ).toHaveAttribute(
        'href',
        'https://sparrow.land/docs/what-my-agent-sees/#who-can-message-my-agents',
      );
      await waitFor(() =>
        expect(document.body.textContent ?? '').toContain(INVITE_URL),
      );
      expect(screen.getByText('4 of 4')).toBeInTheDocument();
      expect(screen.getByAltText(/holding a letter out to a sparrow/i).getAttribute('src')).toBe(
        '/onboarding/humans.png',
      );
    });

    it('Finish lands in the workspace', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await walkToAgents();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByRole('heading', { name: /humans are welcome too/i });
      await userEvent.click(screen.getByRole('button', { name: /^finish$/i }));
      expect(await screen.findByText('workspace home')).toBeInTheDocument();
      expect(loc()).toBe('/');
    });

    /**
     * The status was fetched while the instance was still empty, so it still
     * says `active` when the wizard ends. Left that way, the route gate met the
     * finisher at `/` and threw them back into step 3 — a loop with no exit but
     * Cancel. Finishing settles the local answer (no request: the server already
     * says `populated`), and Skip on this step is the same ending.
     */
    it('leaves onboarding inactive so the route gate cannot bounce the finisher back', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await walkToAgents();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByRole('heading', { name: /humans are welcome too/i });
      expect(peekOnboarding()?.active).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: /^finish$/i }));
      await waitFor(() => expect(peekOnboarding()?.active).toBe(false));
      // Finishing is not dismissing: nothing was sent.
      expect(rec.calls.some((c) => c.url.includes('/onboarding/dismiss'))).toBe(false);
    });
  });

  describe('cancel', () => {
    it('confirms first, and No keeps the wizard', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(
        screen.getByText(
          'Leave the guided setup? You can always invite people and agents from the workspace.',
        ),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /^no$/i }));
      expect(loc()).toBe('/onboarding');
      expect(rec.calls.some((c) => c.url.includes('/onboarding/dismiss'))).toBe(false);
    });

    it('dismisses and sends a visitor with no account to create one', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      await userEvent.click(screen.getByRole('button', { name: /^yes$/i }));
      await waitFor(() => expect(loc()).toBe('/login?view=signup'));
      expect(
        rec.calls.some(
          (c) => c.method === 'POST' && c.url.includes('/api/v1/onboarding/dismiss'),
        ),
      ).toBe(true);
    });

    it('dismisses and sends a signed-in founder to the workspace', async () => {
      useFetch(mockFetch({ signedIn: true }, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /invite an agent/i });
      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      await userEvent.click(screen.getByRole('button', { name: /^yes$/i }));
      await waitFor(() => expect(loc()).toBe('/'));
      expect(
        rec.calls.some(
          (c) => c.method === 'POST' && c.url.includes('/api/v1/onboarding/dismiss'),
        ),
      ).toBe(true);
    });
  });

  describe('resume and focus', () => {
    it('resumes at the agent step when a signed-in founder reloads', async () => {
      useFetch(mockFetch({ signedIn: true }, rec));
      renderWizard();
      expect(
        await screen.findByRole('heading', { name: /invite an agent/i }),
      ).toBeInTheDocument();
      expect(screen.getByText('3 of 4')).toBeInTheDocument();
    });

    it('moves focus to the heading on every step change', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      await userEvent.click(screen.getByRole('button', { name: /get started/i }));
      const second = await screen.findByRole('heading', { name: /set up your org and account/i });
      await waitFor(() => expect(document.activeElement).toBe(second));
    });

    it('wraps each step in a section that its heading names', async () => {
      useFetch(mockFetch({}, rec));
      renderWizard();
      await screen.findByRole('heading', { name: /welcome to sparrow/i });
      const section = document.querySelector('section');
      expect(section).not.toBeNull();
      expect(section?.querySelector('h1')?.textContent).toMatch(/welcome to sparrow/i);
    });
  });
});
