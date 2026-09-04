import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { WorkspaceProvider } from '../lib/workspace.js';
import { api } from '../lib/client.js';
import { buildInviteBlob } from '../lib/inviteBlob.js';
import { InviteDialog } from './InviteDialog.js';

/** Point the shared client's `_fetch` at the mock (see AppShell.test). */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

const ORG_ID = 'org_1';
const INVITE_URL = 'https://sparrow.example.com/invite/ivk_secrettoken';
const jake = { id: 'usr_1', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };

const agentEnrollment = {
  id: 'enr_1',
  kind: 'agent',
  proposedName: 'acme-buildbox',
  note: 'sparrow harness',
  inviter: { id: 'usr_1', displayName: 'Jake' },
  createdAt: new Date().toISOString(),
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorder {
  calls: { method: string; url: string; body: unknown }[];
}

interface MockOpts {
  /** Force the by-email `POST /members` to an error status. */
  addMemberError?: number;
  /** `emailSent` value the stub `POST /members` reports (default false). */
  emailSent?: boolean;
  /** Enrollments already pending when the dialog opens. */
  initialEnrollments?: unknown[];
  /** Fail the invite mint. */
  inviteError?: boolean;
  /** Status the failed mint answers with (default 500 — a plain server failure). */
  inviteErrorStatus?: number;
}

function mockFetch(opts: MockOpts = {}, rec: Recorder = { calls: [] }) {
  let resolved = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') rec.calls.push({ method, url, body });

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: 'owner' }] });
    }
    if (url.includes('/me/events')) return json('');
    if (url.includes(`/orgs/${ORG_ID}/me/humans`)) return json({ items: [] });
    if (url.includes(`/orgs/${ORG_ID}/me/agents`)) return json({ items: [] });
    if (url.includes('/me/room-invitations')) return json({ items: [] });
    if (url.includes('/me/rooms')) return json({ items: [] });

    if (url.includes(`/orgs/${ORG_ID}/enrollments/enr_1/approve`) && method === 'POST') {
      resolved = true;
      return json({ ok: true });
    }
    if (url.includes(`/orgs/${ORG_ID}/enrollments/enr_1/deny`) && method === 'POST') {
      resolved = true;
      return json({ ok: true });
    }
    if (url.includes(`/orgs/${ORG_ID}/enrollments`)) {
      return json({ items: resolved ? [] : (opts.initialEnrollments ?? []) });
    }

    if (url.includes(`/orgs/${ORG_ID}/members`) && method === 'POST') {
      if (opts.addMemberError) {
        const code = opts.addMemberError === 409 ? 'conflict' : 'bad_request';
        return json({ error: { code, message: `err ${opts.addMemberError}` } }, opts.addMemberError);
      }
      const b = body as { email: string; role?: string };
      return json(
        {
          member: {
            human: { id: 'usr_added', displayName: b.email, email: b.email, avatarUrl: null },
            role: b.role ?? 'member',
          },
          inviteUrl: 'https://example.test/invite/ivk_member_secret',
          emailSent: opts.emailSent ?? false,
        },
        201,
      );
    }

    if (url.includes(`/orgs/${ORG_ID}/invites`) && method === 'POST') {
      if (opts.inviteError) {
        const status = opts.inviteErrorStatus ?? 500;
        return json(
          status === 403
            ? { error: { code: 'forbidden', message: 'Only admins may create invites in this org' } }
            : { error: { code: 'internal', message: 'boom' } },
          status,
        );
      }
      return json(
        {
          invite: {
            id: 'inv_1',
            inviter: { id: 'usr_1', displayName: 'Jake' },
            note: null,
            expiresAt: '2026-09-01T00:00:00Z',
            revokedAt: null,
            createdAt: '2026-08-20T00:00:00Z',
          },
          url: INVITE_URL,
        },
        201,
      );
    }

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

function renderDialog(props: Partial<React.ComponentProps<typeof InviteDialog>> = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={[`/org/${ORG_ID}`]}>
      <AuthProvider>
        <OrgProvider orgId={ORG_ID}>
          <WorkspaceProvider activeRoomId={null}>
            <InviteDialog
              orgId={ORG_ID}
              orgName="Acme"
              inviterName="Jake"
              canByEmail
              hasAgents
              onClose={onClose}
              {...props}
            />
          </WorkspaceProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { onClose };
}

/** Text of every terminal block currently on screen. */
function terminalText(): string {
  return Array.from(document.querySelectorAll('pre.terminal-body'))
    .map((el) => el.textContent ?? '')
    .join('\n');
}

const invitesMinted = (f: ReturnType<typeof mockFetch>) =>
  f.mock.calls.filter(
    ([u, i]) =>
      String(u).includes(`/orgs/${ORG_ID}/invites`) &&
      (i?.method ?? 'GET').toUpperCase() === 'POST',
  ).length;

describe('InviteDialog', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = { calls: [] };
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  describe('entry points', () => {
    it('the header Invite button opens the WHO step', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'who' });
      expect(await screen.findByRole('heading', { name: /^invite$/i })).toBeInTheDocument();
      expect(screen.getByText('Who are you inviting to Acme?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /a person/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /an agent/i })).toBeInTheDocument();
    });

    it('the Humans + button opens the PERSON step', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'person' });
      expect(await screen.findByRole('heading', { name: /invite a person/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/invite by email/i)).toBeInTheDocument();
    });

    it('the Agents + button opens the AGENT step', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      expect(await screen.findByRole('heading', { name: /invite an agent/i })).toBeInTheDocument();
      expect(screen.getByText('How should the agent connect?')).toBeInTheDocument();
    });

    it('the header Invite button opens WHO even in an org with zero agents', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'who', hasAgents: false });
      expect(await screen.findByRole('heading', { name: /^invite$/i })).toBeInTheDocument();
      expect(screen.getByText('Who are you inviting to Acme?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /a person/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /an agent/i })).toBeInTheDocument();
      // The first-agent short-cut belongs to the AGENTS +, never to the one door:
      // a brand-new owner clicking Invite is usually inviting a teammate.
      expect(screen.queryByText('Your first agent.')).not.toBeInTheDocument();
    });

    it('the Agents + button in an org with zero agents opens AGENT with a first-agent lead-in and no back chip', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent', hasAgents: false });
      expect(await screen.findByRole('heading', { name: /invite an agent/i })).toBeInTheDocument();
      expect(screen.getByText('Your first agent.')).toBeInTheDocument();
      expect(
        screen.getByText(/two ways to bring one in\. pick one; you can always add the other later\./i),
      ).toBeInTheDocument();
      // Nothing to go back to — the WHO step was never shown.
      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('an org WITH agents gets no first-agent lead-in', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      await screen.findByText('How should the agent connect?');
      expect(screen.queryByText('Your first agent.')).not.toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('WHO → a person → back returns to WHO', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'who' });
      await userEvent.click(await screen.findByRole('button', { name: /a person/i }));
      expect(await screen.findByRole('heading', { name: /invite a person/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByText('Who are you inviting to Acme?')).toBeInTheDocument();
    });

    it('WHO → an agent in a zero-agent org shows the lead-in AND a back chip', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'who', hasAgents: false });
      await userEvent.click(await screen.findByRole('button', { name: /an agent/i }));
      expect(await screen.findByRole('heading', { name: /invite an agent/i })).toBeInTheDocument();
      // A lead-in and a back chip coexist: the org has no agents, but the caller
      // came through WHO, so the person step is one click away.
      expect(screen.getByText('Your first agent.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByText('Who are you inviting to Acme?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /a person/i })).toBeInTheDocument();
    });

    it('WHO → an agent → back returns to WHO', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'who' });
      await userEvent.click(await screen.findByRole('button', { name: /an agent/i }));
      expect(await screen.findByRole('heading', { name: /invite an agent/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByText('Who are you inviting to Acme?')).toBeInTheDocument();
    });
  });

  describe('PERSON step', () => {
    it('offers the by-email form and a shareable link', async () => {
      const f = mockFetch({}, rec);
      useFetch(f);
      renderDialog({ initialStep: 'person' });

      expect(await screen.findByLabelText(/invite by email/i)).toBeInTheDocument();
      expect(await screen.findByText(INVITE_URL)).toBeInTheDocument();
      expect(
        screen.getByText(/use email when you want to know who’s coming\./i),
      ).toBeInTheDocument();
    });

    it('posts {email, role} and confirms the outcome', async () => {
      const f = mockFetch({ emailSent: true }, rec);
      useFetch(f);
      renderDialog({ initialStep: 'person' });

      await userEvent.type(await screen.findByLabelText(/invite by email/i), 'newbie@acme.com');
      await userEvent.selectOptions(screen.getByLabelText(/role for the new person/i), 'admin');
      await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

      await waitFor(() =>
        expect(
          rec.calls.some(
            (c) =>
              c.method === 'POST' &&
              c.url.includes(`/orgs/${ORG_ID}/members`) &&
              (c.body as { email: string }).email === 'newbie@acme.com' &&
              (c.body as { role: string }).role === 'admin',
          ),
        ).toBe(true),
      );
      expect(await screen.findByText(/invitation emailed to newbie@acme.com/i)).toBeInTheDocument();
    });

    it('shows only the link path when the caller cannot invite by email', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'person', canByEmail: false });
      expect(await screen.findByText(INVITE_URL)).toBeInTheDocument();
      expect(screen.queryByLabelText(/invite by email/i)).not.toBeInTheDocument();
    });
  });

  describe('AGENT step', () => {
    it('selects harness by default and shows the install + harness command', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });

      expect(await screen.findByRole('radio', { name: /harness/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('radio', { name: /inline/i })).toHaveAttribute('aria-checked', 'false');

      await waitFor(() => expect(terminalText()).toContain('sparrow harness'));
      const text = terminalText();
      expect(text).toContain('# on a machine that stays up');
      // The installer has ONE home (SPEC: *Canonical public homes*) — this
      // instance does not serve `install.sh`, it redirects to sparrow.land, and
      // printing its own origin would teach every reader a different command.
      expect(text).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
      expect(text).not.toContain('https://sparrow.example.com/install.sh');
      // The invite, by contrast, IS this instance's — it keeps its origin.
      expect(text).toContain(`--url ${INVITE_URL}`);
    });

    /**
     * Issue #63: the harness command carries the whole invite URL, and an
     * unwrapped block hid its tail behind a horizontal scrollbar — so a reader
     * copying by SELECTION got a truncated URL. Every block here that carries
     * an invite URL soft-wraps; the copy button remains the exact route.
     */
    it('soft-wraps the command blocks, so a long invite URL is never clipped', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      await waitFor(() => expect(terminalText()).toContain(INVITE_URL));
      const blocks = Array.from(document.querySelectorAll('pre.terminal-body'));
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b.className).toMatch(/terminal-wrap/);
    });

    it('never calls either mode "recommended"', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      await screen.findByRole('radio', { name: /harness/i });
      expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument();
    });

    it('labels the trade-off of each mode with a neutral pill', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      const harness = await screen.findByRole('radio', { name: /harness/i });
      expect(within(harness).getByText(/needs the cli/i)).toBeInTheDocument();
      const inline = screen.getByRole('radio', { name: /inline/i });
      expect(within(inline).getByText(/no install/i)).toBeInTheDocument();
    });

    it('draws the loop art on each mode card, ring on the mode’s loop holder', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      const harness = await screen.findByRole('radio', { name: /harness/i });
      expect(harness.querySelector('[data-part="ring"]')).toHaveAttribute('data-holder', 'sparrow');
      const inline = screen.getByRole('radio', { name: /inline/i });
      expect(inline.querySelector('[data-part="ring"]')).toHaveAttribute('data-holder', 'agent');
    });

    it('switching to inline swaps the harness command for the invitation blob', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      await waitFor(() => expect(terminalText()).toContain('sparrow harness'));

      await userEvent.click(screen.getByRole('radio', { name: /inline/i }));

      const blob = buildInviteBlob({ inviterName: 'Jake', orgName: 'Acme', url: INVITE_URL });
      await waitFor(() => expect(terminalText()).toContain(blob));
      expect(terminalText()).not.toContain('curl -fsSL');
      expect(screen.getByText(/paste this into your agent/i)).toBeInTheDocument();
    });

    it('the runtime picker changes the harness command', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      await waitFor(() => expect(terminalText()).toContain('sparrow harness'));
      // Claude Code is the default: no runner flag.
      expect(terminalText()).not.toContain('--codex');

      await userEvent.click(screen.getByRole('tab', { name: /codex/i }));
      await waitFor(() => expect(terminalText()).toContain('sparrow harness --codex'));

      await userEvent.click(screen.getByRole('tab', { name: /gemini/i }));
      await waitFor(() => expect(terminalText()).toContain('sparrow harness --gemini'));

      await userEvent.click(screen.getByRole('tab', { name: /other/i }));
      await waitFor(() =>
        expect(terminalText()).toContain("sparrow harness --exec '<your command>'"),
      );
    });

    it('mints the invite once and shares it across both modes', async () => {
      const f = mockFetch({}, rec);
      useFetch(f);
      renderDialog({ initialStep: 'agent' });
      await waitFor(() => expect(terminalText()).toContain(INVITE_URL));
      await userEvent.click(screen.getByRole('radio', { name: /inline/i }));
      await waitFor(() => expect(terminalText()).toContain(INVITE_URL));
      await userEvent.click(screen.getByRole('radio', { name: /harness/i }));
      await waitFor(() => expect(terminalText()).toContain(INVITE_URL));
      expect(invitesMinted(f)).toBe(1);
    });

    it('reports a failed mint instead of showing half a command', async () => {
      useFetch(mockFetch({ inviteError: true }, rec));
      renderDialog({ initialStep: 'agent' });
      expect(await screen.findByText(/could not create the invite/i)).toBeInTheDocument();
    });

    /* ---- policy (issue #37) ------------------------------------------- */
    // `invites.who: 'admins'` makes the server 403 a member's mint. That is a
    // RULE, not a glitch: say the rule, and never leave the step's captions and
    // approvals list narrating an invite that does not exist.
    it('a 403 mint names the policy instead of a transient failure', async () => {
      useFetch(mockFetch({ inviteError: true, inviteErrorStatus: 403 }, rec));
      renderDialog({ initialStep: 'agent' });

      expect(
        await screen.findByText('Only admins can invite agents in this organization.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/could not create the invite/i)).not.toBeInTheDocument();
    });

    it('a 403 mint shows no orphaned caption and no false "waiting to enroll" line', async () => {
      useFetch(mockFetch({ inviteError: true, inviteErrorStatus: 403 }, rec));
      renderDialog({ initialStep: 'agent' });
      await screen.findByText('Only admins can invite agents in this organization.');

      // Nothing was created, so nothing can enroll — the approvals block and the
      // "then approve it below" captions must be gone, not merely empty.
      expect(screen.queryByText(/waiting for an agent to enroll/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/then approve it below/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/installs the cli/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/paste this into your agent/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: /harness/i })).not.toBeInTheDocument();
    });

    it('a 403 mint on the PERSON step names the same policy in person words', async () => {
      useFetch(mockFetch({ inviteError: true, inviteErrorStatus: 403 }, rec));
      renderDialog({ initialStep: 'person', canByEmail: false });
      expect(
        await screen.findByText('Only admins can invite people in this organization.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/could not create the invite/i)).not.toBeInTheDocument();
    });
  });

  describe('approvals', () => {
    it('shows an empty state while nothing has enrolled', async () => {
      useFetch(mockFetch({}, rec));
      renderDialog({ initialStep: 'agent' });
      expect(await screen.findByText(/approvals/i)).toBeInTheDocument();
      expect(
        await screen.findByText(/waiting for an agent to enroll with this invite/i),
      ).toBeInTheDocument();
    });

    it('hydrates a pending enrollment with its name, kind and provenance', async () => {
      useFetch(mockFetch({ initialEnrollments: [agentEnrollment] }, rec));
      renderDialog({ initialStep: 'agent' });
      const dialog = await screen.findByRole('dialog');
      const row = (await within(dialog).findByText('acme-buildbox')).closest('li')!;
      expect(within(row).getByText('agent')).toBeInTheDocument();
      expect(within(row).getByText(/via sparrow harness · just now/i)).toBeInTheDocument();
    });

    it('approves a pending request and flips the row to an approved state', async () => {
      useFetch(mockFetch({ initialEnrollments: [agentEnrollment] }, rec));
      renderDialog({ initialStep: 'agent' });
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('acme-buildbox');
      await userEvent.click(within(dialog).getByRole('button', { name: /approve/i }));

      await waitFor(() =>
        expect(
          rec.calls.some(
            (c) =>
              c.method === 'POST' &&
              c.url.includes(`/orgs/${ORG_ID}/enrollments/enr_1/approve`),
          ),
        ).toBe(true),
      );
      expect(await within(dialog).findByText(/approved/i)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    });

    it('denies a pending request and flips the row to a denied state', async () => {
      useFetch(mockFetch({ initialEnrollments: [agentEnrollment] }, rec));
      renderDialog({ initialStep: 'agent' });
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('acme-buildbox');
      await userEvent.click(within(dialog).getByRole('button', { name: /deny/i }));
      await waitFor(() =>
        expect(
          rec.calls.some(
            (c) => c.method === 'POST' && c.url.includes(`/orgs/${ORG_ID}/enrollments/enr_1/deny`),
          ),
        ).toBe(true),
      );
      expect(await within(dialog).findByText(/denied/i)).toBeInTheDocument();
    });

    it('is not shown on the person step', async () => {
      useFetch(mockFetch({ initialEnrollments: [agentEnrollment] }, rec));
      renderDialog({ initialStep: 'person' });
      await screen.findByText(INVITE_URL);
      expect(screen.queryByText('acme-buildbox')).not.toBeInTheDocument();
    });
  });

  it('closes on Escape, backdrop click, and the X button', async () => {
    useFetch(mockFetch({}, rec));
    const { onClose } = renderDialog({ initialStep: 'who' });
    await screen.findByText('Who are you inviting to Acme?');

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await userEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
