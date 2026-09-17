import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { OrgRole } from '@sparrow/common-types';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { api } from '../lib/client.js';
import { OrgSettings } from './OrgSettings.js';

const ORG_ID = 'org_1';

/**
 * The `api` singleton binds `globalThis.fetch` at import time, so stubbing the
 * global alone never reaches it. Point the client's fetch at the mock (and stub
 * the global for the bare-`fetch` probe), then restore afterwards.
 */
type WithFetch = { _fetch: typeof fetch };
const REAL_FETCH = (api as unknown as WithFetch)._fetch;
function useFetch(f: typeof fetch) {
  vi.stubGlobal('fetch', f);
  (api as unknown as WithFetch)._fetch = f;
}

const jake = {
  id: 'usr_jake',
  email: 'jake@acme.com',
  displayName: 'Jake',
  provider: 'password',
};

const defaultSettings = {
  invites: { who: 'members' },
  enroll: { agents: 'approval' },
  rooms: { create: 'members' },
};

function org(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    settings: defaultSettings,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface MockOpts {
  role?: OrgRole;
  members?: unknown[];
  agents?: unknown[];
  enrollments?: unknown[];
  invites?: unknown[];
  /**
   * Agents the governance list gains once an enrollment is resolved — the shape
   * the server really has: an approved agent EXISTS, so the next read sees it.
   */
  agentsAfterResolve?: unknown[];
  /** Force the `POST /members` (add-by-email) response to an error status. */
  addMemberError?: number;
  /** `emailSent` value the stub `POST /members` reports (default false). */
  emailSent?: boolean;
}

function mockFetch(opts: MockOpts = {}) {
  const role = opts.role ?? 'owner';
  /** Flipped by an approve/deny, exactly as the server's own state would be. */
  let resolved = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role }] });
    }

    if (url.includes(`/orgs/${ORG_ID}/members`) && method === 'POST') {
      if (opts.addMemberError) {
        const code = opts.addMemberError === 409 ? 'conflict' : 'bad_request';
        return json({ error: { code, message: `err ${opts.addMemberError}` } }, opts.addMemberError);
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; role?: string };
      return json(
        {
          member: {
            human: { id: 'usr_added', displayName: body.email, email: body.email, avatarUrl: null },
            role: body.role ?? 'member',
          },
          inviteUrl: 'https://example.test/invite/ivk_member_secret',
          emailSent: opts.emailSent ?? false,
        },
        201,
      );
    }

    if (url.includes(`/orgs/${ORG_ID}/humans`)) {
      if (method === 'GET') return json({ items: opts.members ?? [], nextCursor: null });
      return json({ ok: true }); // PATCH / DELETE role change / remove
    }
    if (url.includes(`/orgs/${ORG_ID}/agents`)) {
      const items = resolved ? (opts.agentsAfterResolve ?? opts.agents ?? []) : (opts.agents ?? []);
      return json({ items });
    }
    if (url.includes(`/orgs/${ORG_ID}/enrollments`)) {
      if (method === 'POST') {
        resolved = true;
        return json({ ok: true });
      }
      return json({ items: resolved ? [] : (opts.enrollments ?? []) });
    }
    if (url.includes(`/orgs/${ORG_ID}/invites`)) {
      if (method === 'POST') {
        return json(
          {
            invite: {
              id: 'ivk_new',
              inviter: { id: jake.id, displayName: 'Jake' },
              note: null,
              expiresAt: '2026-02-01T00:00:00Z',
              revokedAt: null,
              createdAt: '2026-01-10T00:00:00Z',
            },
            url: 'https://example.test/invite/ivk_secret',
          },
          201,
        );
      }
      if (method === 'DELETE') return json({ ok: true });
      return json({ items: opts.invites ?? [] });
    }
    if (url.includes(`/orgs/${ORG_ID}`)) {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return json({ org: org(body) });
      }
      return json({ org: org() });
    }

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });
}

function renderOrgSettings() {
  return render(
    <MemoryRouter initialEntries={[`/o/${ORG_ID}/settings`]}>
      <AuthProvider>
        <OrgProvider orgId={ORG_ID}>
          <OrgSettings />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('OrgSettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (api as unknown as WithFetch)._fetch = REAL_FETCH;
  });

  it('shows a friendly message when the caller is not an admin', async () => {
    useFetch(mockFetch({ role: 'member' }));
    renderOrgSettings();
    expect(
      await screen.findByText(/don’t have access to org admin/i),
    ).toBeInTheDocument();
    // No admin-only section headings.
    expect(screen.queryByRole('heading', { name: /^people$/i })).not.toBeInTheDocument();
  });

  it('renders sections and reflects current policies for an owner', async () => {
    useFetch(
      mockFetch({
        members: [
          {
            human: { id: 'usr_pat', displayName: 'Pat', email: 'pat@acme.com', avatarUrl: null },
            role: 'member',
            joinedAt: '2026-01-02T00:00:00Z',
          },
        ],
      }),
    );
    renderOrgSettings();

    // The page identifies as Org admin.
    expect(await screen.findByRole('heading', { name: /^org admin$/i })).toBeInTheDocument();

    // Roster loads.
    expect(await screen.findByText('Pat')).toBeInTheDocument();
    expect(screen.getByText('pat@acme.com')).toBeInTheDocument();

    // Policy defaults reflected in the radios.
    const anyoneInvite = await screen.findByRole('radio', { name: /anyone can invite/i });
    expect(anyoneInvite).toBeChecked();
    // Agent-admission policy defaults to "Review each agent" (there is no human
    // admission policy — a valid invite admits a person immediately).
    expect(screen.getByRole('radio', { name: /review each agent/i })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /review each person who wants to join/i })).toBeNull();
  });

  // Issue #27(b): renaming an org now REGENERATES a slug the server derived, so
  // the address field has to say that up front — an address that moves itself is
  // only acceptable if the person was told it could.
  it('says a derived web address follows the name until it is set by hand', async () => {
    useFetch(mockFetch({}));
    renderOrgSettings();
    const hint = await screen.findByText(/follows the name/i);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toMatch(/set it yourself|type|choose/i);
  });

  it('invites a person by email: posts the payload and refreshes the roster', async () => {
    const fetchMock = mockFetch();
    useFetch(fetchMock);
    renderOrgSettings();

    const emailInput = await screen.findByLabelText(/invite by email/i);
    await userEvent.type(emailInput, 'newbie@acme.com');
    await userEvent.selectOptions(screen.getByLabelText(/role for the new person/i), 'admin');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    // The right POST went out with the typed email + selected role.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) => {
          if (!String(u).includes(`/orgs/${ORG_ID}/members`)) return false;
          if ((i?.method ?? 'GET').toUpperCase() !== 'POST') return false;
          const body = JSON.parse(String(i?.body ?? '{}'));
          return body.email === 'newbie@acme.com' && body.role === 'admin';
        }),
      ).toBe(true),
    );

    // Roster reloaded after inviting (a second GET /humans).
    await waitFor(() => {
      const rosterGets = fetchMock.mock.calls.filter(
        ([u, i]) =>
          String(u).includes(`/orgs/${ORG_ID}/humans`) &&
          (i?.method ?? 'GET').toUpperCase() === 'GET',
      );
      expect(rosterGets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('confirms "Invitation emailed" + share link when the email was sent', async () => {
    useFetch(mockFetch({ emailSent: true }));
    renderOrgSettings();
    const emailInput = await screen.findByLabelText(/invite by email/i);
    await userEvent.type(emailInput, 'mailed@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    expect(await screen.findByText(/invitation emailed to mailed@acme.com/i)).toBeInTheDocument();
    expect(screen.getByText(/or share this link/i)).toBeInTheDocument();
    // The invite link is present for sharing.
    expect(screen.getByText('https://example.test/invite/ivk_member_secret')).toBeInTheDocument();
  });

  it('confirms "they’re in — send them this link" when no email was sent', async () => {
    useFetch(mockFetch({ emailSent: false }));
    renderOrgSettings();
    const emailInput = await screen.findByLabelText(/invite by email/i);
    await userEvent.type(emailInput, 'noemail@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    expect(await screen.findByText(/send them this link/i)).toBeInTheDocument();
    expect(screen.getByText('https://example.test/invite/ivk_member_secret')).toBeInTheDocument();
  });

  it('the invite link copy button copies the link to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useFetch(mockFetch({ emailSent: false }));
    renderOrgSettings();
    const emailInput = await screen.findByLabelText(/invite by email/i);
    await userEvent.type(emailInput, 'copy@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    await screen.findByText(/send them this link/i);
    // The success confirmation's copy control.
    const copyBtn = screen.getByRole('button', { name: /^copy$/i });
    await userEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith('https://example.test/invite/ivk_member_secret');
  });

  it('shows an inline error when the person is already a member (409)', async () => {
    useFetch(mockFetch({ addMemberError: 409 }));
    renderOrgSettings();
    const emailInput = await screen.findByLabelText(/invite by email/i);
    await userEvent.type(emailInput, 'dupe@acme.com');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));
    expect(await screen.findByText(/already in this organization/i)).toBeInTheDocument();
  });

  it('shows an inline error for an invalid email (400)', async () => {
    useFetch(mockFetch({ addMemberError: 400 }));
    renderOrgSettings();
    const emailInput = await screen.findByLabelText(/invite by email/i);
    // Passes the browser's loose email check but the server rejects it (400).
    await userEvent.type(emailInput, 'a@b');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));
    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
  });

  it('the invite-by-email affordance is not shown to a plain member', async () => {
    useFetch(mockFetch({ role: 'member' }));
    renderOrgSettings();
    await screen.findByText(/don’t have access to org admin/i);
    expect(screen.queryByLabelText(/invite by email/i)).not.toBeInTheDocument();
  });

  it('creates an invite and shows the link once', async () => {
    useFetch(mockFetch());
    renderOrgSettings();

    const createBtn = await screen.findByRole('button', { name: /create invite/i });
    await userEvent.click(createBtn);

    expect(await screen.findByText('https://example.test/invite/ivk_secret')).toBeInTheDocument();
  });

  it('approves a pending enrollment', async () => {
    const fetchMock = mockFetch({
      enrollments: [
        {
          id: 'enr_1',
          kind: 'human',
          proposedName: null,
          note: 'let me in',
          email: 'newbie@acme.com',
          displayName: 'Newbie',
          inviter: { id: jake.id, displayName: 'Jake' },
          createdAt: '2026-01-05T00:00:00Z',
        },
      ],
    });
    useFetch(fetchMock);
    renderOrgSettings();

    const approvals = (await screen.findByRole('heading', { name: /approvals/i })).closest('section')!;
    const approveBtn = await within(approvals).findByRole('button', { name: /approve/i });
    await userEvent.click(approveBtn);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/orgs/${ORG_ID}/enrollments/enr_1/approve`) &&
            (i?.method ?? 'GET').toUpperCase() === 'POST',
        ),
      ).toBe(true),
    );
  });

  /* ---- the AGENTS list follows an approval (issue #44) ------------------ */
  // Approving an agent CREATES it, so the governance list right above the
  // approvals block is stale the moment the decision lands. It used to need a
  // manual page reload; it now refetches itself.

  const agentEnrollment = {
    id: 'enr_1',
    kind: 'agent',
    proposedName: 'scout',
    note: null,
    inviter: { id: jake.id, displayName: 'Jake' },
    createdAt: '2026-01-05T00:00:00Z',
  };
  const newAgent = {
    agent: {
      id: 'agt_scout',
      name: 'scout',
      orgId: ORG_ID,
      emailAddress: null,
      online: false,
      lastSeenAt: null,
      sharing: 'room-members',
      roleTitle: null,
      createdAt: '2026-01-05T00:00:00Z',
    },
    owner: { id: jake.id, displayName: 'Jake' },
  };

  it('refetches the AGENTS list after approving an enrollment', async () => {
    useFetch(mockFetch({ enrollments: [agentEnrollment], agentsAfterResolve: [newAgent] }));
    renderOrgSettings();

    const agentsSection = (await screen.findByRole('heading', { name: /^agents$/i })).closest(
      'section',
    )!;
    expect(await within(agentsSection).findByText('No agents yet.')).toBeInTheDocument();

    const approvals = (await screen.findByRole('heading', { name: /approvals/i })).closest('section')!;
    await userEvent.click(await within(approvals).findByRole('button', { name: /approve/i }));

    // No remount, no manual reload — the just-approved agent shows up.
    expect(await within(agentsSection).findByText('scout')).toBeInTheDocument();
  });

  it('refetches the AGENTS list after denying an enrollment too', async () => {
    // Symmetric on purpose: a denial resolves the same queue, and the list must
    // never be left showing a state the decision has already moved past.
    useFetch(mockFetch({ enrollments: [agentEnrollment], agentsAfterResolve: [newAgent] }));
    renderOrgSettings();

    const agentsSection = (await screen.findByRole('heading', { name: /^agents$/i })).closest(
      'section',
    )!;
    await within(agentsSection).findByText('No agents yet.');

    const approvals = (await screen.findByRole('heading', { name: /approvals/i })).closest('section')!;
    await userEvent.click(await within(approvals).findByRole('button', { name: /deny/i }));

    expect(await within(agentsSection).findByText('scout')).toBeInTheDocument();
  });
});
