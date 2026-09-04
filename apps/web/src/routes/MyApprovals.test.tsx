import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CapabilitiesResponse } from '@sparrow/common-types';
import { AuthProvider } from '../lib/auth.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { useFetch, restoreFetch, json } from '../test/apiStub.js';
import { approvalItem, preview, threadRef, party, ORG_ID, AGENT_ID } from '../test/fixtures.js';
import { MyApprovals } from './MyApprovals.js';

/**
 * `/me/approvals` — the PERSONAL approval surface, unified across enrollments
 * and email (SPEC v4 → *Web UI → Approvals*). The enrollment half is v3's
 * `/me/invites` under its new name, so its coverage is ported here verbatim.
 */

const jake = { id: 'usr_jake', email: 'jake@acme.com', displayName: 'Jake', provider: 'password' };
const OTHER_ORG = 'org_2';

const EMAIL_ON: CapabilitiesResponse = {
  email: true,
  emailReviewer: false,
  voice: { stt: false, tts: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};
const EMAIL_OFF: CapabilitiesResponse = { ...EMAIL_ON, email: false };

interface MockOpts {
  signedOut?: boolean;
  orgs?: { id: string; name: string; slug: string }[];
  enrollments?: unknown[];
  invites?: unknown[];
  /** `GET /orgs/:id/email/approvals` rows, per org id. */
  approvals?: Record<string, unknown[]>;
  /** `GET /orgs/:id/me/agents` rows, per org id (defaults to one OWNED agent). */
  agents?: Record<string, unknown[]>;
  /** SSE frames pushed on `/me/events` (as one `text/event-stream` body). */
  frames?: string;
}

/** One `GET /orgs/:id/me/agents` row (the visibility list). */
function visibilityAgent(id: string, name: string, ownerId = jake.id, sharedBy: string | null = null) {
  return {
    agent: {
      id,
      name,
      orgId: ORG_ID,
      emailAddress: `${name}@acme.example.com`,
      online: true,
      lastSeenAt: null,
      sharing: 'selected',
      createdAt: '2026-08-01T00:00:00Z',
    },
    owner: { id: ownerId, displayName: ownerId === jake.id ? 'Jake' : 'Pat' },
    sharedBy: sharedBy ? { id: sharedBy, displayName: 'Pat' } : null,
  };
}

function mockFetch(opts: MockOpts = {}) {
  const orgs = opts.orgs ?? [{ id: ORG_ID, name: 'Acme', slug: 'acme' }];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) {
      if (opts.signedOut) return json({ error: { code: 'unauthorized', message: 'x' } }, 401);
      return json({ user: jake });
    }
    if (url.includes('/me/orgs')) {
      return json({ items: orgs.map((org) => ({ org, role: 'owner' })) });
    }
    if (url.includes('/me/events')) {
      if (!opts.frames) return json('');
      return new Response(`: open\n\n${opts.frames}`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    for (const org of orgs) {
      if (url.includes(`/orgs/${org.id}/email/approvals`)) {
        return json({ items: opts.approvals?.[org.id] ?? [], nextCursor: null });
      }
      if (url.includes(`/orgs/${org.id}/me/agents`)) {
        return json({ items: opts.agents?.[org.id] ?? [visibilityAgent(AGENT_ID, 'fable')] });
      }
      if (url.includes(`/orgs/${org.id}/enrollments`)) {
        if (method === 'POST') return json({ ok: true });
        return json({ items: org.id === ORG_ID ? (opts.enrollments ?? []) : [] });
      }
      if (url.includes(`/orgs/${org.id}/invites`)) {
        if (method === 'DELETE') return json({ ok: true });
        return json({ items: org.id === ORG_ID ? (opts.invites ?? []) : [] });
      }
    }
    if (url.includes('/approve') || url.includes('/deny')) {
      return json({
        email: {
          id: 'eml_1',
          threadId: 'eth_1',
          direction: 'in',
          from: party(),
          to: [],
          cc: [],
          bcc: [],
          subject: 'Re: Q3 rollout',
          text: 'x',
          html: null,
          attachments: [],
          rfcMessageId: '<a@b>',
          inReplyTo: null,
          verification: null,
          disposition: 'delivered',
          reason: null,
          judge: null,
          status: 'unread',
          createdAt: '2026-08-31T12:04:00Z',
          resolvedAt: '2026-08-31T13:00:00Z',
        },
      });
    }

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  }) as unknown as typeof fetch;
}

function renderApprovals(caps: CapabilitiesResponse = EMAIL_ON) {
  return render(
    <MemoryRouter initialEntries={['/me/approvals']}>
      <AuthProvider>
        <CapabilitiesProvider initial={caps}>
          <Routes>
            <Route path="/me/approvals" element={<MyApprovals />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </CapabilitiesProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function agentEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enr_agent',
    kind: 'agent',
    proposedName: 'Scout',
    note: 'helper bot',
    inviter: { id: jake.id, displayName: 'Jake' },
    createdAt: '2026-01-05T00:00:00Z',
    ...overrides,
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ivk_mine',
    inviter: { id: jake.id, displayName: 'Jake' },
    note: 'Design team',
    expiresAt: '2026-02-01T00:00:00Z',
    revokedAt: null,
    createdAt: '2026-01-10T00:00:00Z',
    ...overrides,
  };
}

/** An email approval row, with a distinct id/subject/time per call. */
function emailItem(opts: {
  id: string;
  subject: string;
  createdAt: string;
  agentId?: string;
  direction?: 'in' | 'out';
}) {
  const inbound = (opts.direction ?? 'in') === 'in';
  return approvalItem({
    email: preview({
      id: opts.id,
      direction: inbound ? 'in' : 'out',
      subject: opts.subject,
      disposition: inbound ? 'quarantined' : 'held',
      reason: inbound ? 'unrecognized-sender' : 'unrecognized-recipient',
      status: 'unread',
      createdAt: opts.createdAt,
    }),
    thread: threadRef({ id: `eth_${opts.id}`, trusted: false, lastEmailAt: null }),
    agent: { id: opts.agentId ?? AGENT_ID, name: opts.agentId === 'agt_pat' ? 'pat-bot' : 'fable' },
  });
}

/** The accessible names of the rendered email rows, in DOM order. */
function emailRowNames(): string[] {
  return screen
    .getAllByRole('button', { expanded: false })
    .map((el) => el.textContent ?? '')
    .filter((t) => /email (from|to)/i.test(t));
}

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('MyApprovals (/me/approvals) — enrollments (ported from /me/invites)', () => {
  it('renders an enrollment from my invite with Approve/Deny, and Approve calls the endpoint', async () => {
    const fetchMock = mockFetch({ enrollments: [agentEnrollment()] });
    useFetch(fetchMock);
    renderApprovals(EMAIL_OFF);

    const pending = (await screen.findByRole('heading', { name: /pending requests/i })).closest(
      'section',
    )!;
    expect(await within(pending).findByText('Scout')).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: /deny/i })).toBeInTheDocument();

    // Approval is strictly yes/no — the proposed name is shown but not editable:
    // there is NO name input anywhere in the pending-approvals section.
    expect(within(pending).queryByRole('textbox')).toBeNull();

    await userEvent.click(within(pending).getByRole('button', { name: /approve/i }));

    await waitFor(() =>
      expect(
        (fetchMock as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/orgs/${ORG_ID}/enrollments/enr_agent/approve`) &&
            (i?.method ?? 'GET').toUpperCase() === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('renders an invite I sent with a Revoke button that calls the endpoint', async () => {
    const fetchMock = mockFetch({ invites: [invite()] });
    useFetch(fetchMock);
    renderApprovals(EMAIL_OFF);

    expect(await screen.findByText('Design team')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

    await waitFor(() =>
      expect(
        (fetchMock as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/orgs/${ORG_ID}/invites/ivk_mine`) &&
            (i?.method ?? 'GET').toUpperCase() === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('filters out an enrollment whose inviter is a coworker', async () => {
    useFetch(
      mockFetch({
        enrollments: [
          agentEnrollment({
            id: 'enr_other',
            proposedName: 'CoworkerBot',
            inviter: { id: 'usr_pat', displayName: 'Pat' },
          }),
        ],
      }),
    );
    renderApprovals(EMAIL_OFF);

    expect(await screen.findByText(/no pending requests/i)).toBeInTheDocument();
    expect(screen.queryByText('CoworkerBot')).not.toBeInTheDocument();
  });

  it('shows a sign-in prompt when signed out', async () => {
    useFetch(mockFetch({ signedOut: true }));
    renderApprovals();

    const link = await screen.findByRole('link', { name: /sign in/i });
    expect(link).toHaveAttribute('href', '/login?next=/me/approvals');
  });
});

describe('MyApprovals (/me/approvals) — the two groups', () => {
  it('renders both groups, each with its own count', async () => {
    useFetch(
      mockFetch({
        enrollments: [agentEnrollment()],
        approvals: {
          [ORG_ID]: [
            emailItem({ id: 'eml_a', subject: 'Older', createdAt: '2026-08-30T09:00:00Z' }),
            emailItem({ id: 'eml_b', subject: 'Newer', createdAt: '2026-08-31T09:00:00Z' }),
          ],
        },
      }),
    );
    renderApprovals();

    expect(await screen.findByRole('heading', { name: /^approvals$/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /enrollments\s+1/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^email\s+2/i })).toBeInTheDocument();
  });

  it('lists email approvals OLDEST-FIRST, inbound and outbound in one list', async () => {
    useFetch(
      mockFetch({
        approvals: {
          [ORG_ID]: [
            // Served newest-first on purpose: the page owns the ordering.
            emailItem({ id: 'eml_new', subject: 'Newest', createdAt: '2026-08-31T09:00:00Z' }),
            emailItem({
              id: 'eml_mid',
              subject: 'Middle',
              createdAt: '2026-08-30T09:00:00Z',
              direction: 'out',
            }),
            emailItem({ id: 'eml_old', subject: 'Oldest', createdAt: '2026-08-29T09:00:00Z' }),
          ],
        },
      }),
    );
    renderApprovals();

    await screen.findByText('Oldest');
    const names = emailRowNames();
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/Oldest/);
    expect(names[1]).toMatch(/Middle/);
    expect(names[2]).toMatch(/Newest/);
    // Inbound and outbound share the list but are labelled apart.
    expect(screen.getByText('Outbound')).toBeInTheDocument();
    expect(screen.getAllByText('Inbound')).toHaveLength(2);
  });

  it('shows only approvals for agents the caller OWNS (the route returns every agent’s)', async () => {
    useFetch(
      mockFetch({
        agents: {
          [ORG_ID]: [
            visibilityAgent(AGENT_ID, 'fable'),
            // A coworker's agent, shared with me: visible, but NOT mine to approve.
            visibilityAgent('agt_pat', 'pat-bot', 'usr_pat', 'usr_pat'),
          ],
        },
        approvals: {
          [ORG_ID]: [
            emailItem({ id: 'eml_mine', subject: 'Mine', createdAt: '2026-08-29T09:00:00Z' }),
            emailItem({
              id: 'eml_theirs',
              subject: 'Theirs',
              createdAt: '2026-08-30T09:00:00Z',
              agentId: 'agt_pat',
            }),
          ],
        },
      }),
    );
    renderApprovals();

    expect(await screen.findByText('Mine')).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^email\s+1/i })).toBeInTheDocument();
  });

  it('renders NO Email group at all with capabilities.email false', async () => {
    const fetchMock = mockFetch({
      enrollments: [agentEnrollment()],
      approvals: { [ORG_ID]: [emailItem({ id: 'eml_a', subject: 'Hidden', createdAt: '2026-08-30T09:00:00Z' })] },
    });
    useFetch(fetchMock);
    renderApprovals(EMAIL_OFF);

    expect(await screen.findByText('Scout')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^email/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    // Render is gated, and so is the fetch — the queue is never asked for.
    const urls = (fetchMock as unknown as { mock: { calls: [unknown][] } }).mock.calls.map(([u]) =>
      String(u),
    );
    expect(urls.some((u) => u.includes('/email/approvals'))).toBe(false);
  });

  it('groups the email queue per org when the caller is in more than one', async () => {
    useFetch(
      mockFetch({
        orgs: [
          { id: ORG_ID, name: 'Acme', slug: 'acme' },
          { id: OTHER_ORG, name: 'Globex', slug: 'globex' },
        ],
        agents: {
          [ORG_ID]: [visibilityAgent(AGENT_ID, 'fable')],
          [OTHER_ORG]: [visibilityAgent('agt_g', 'gbot')],
        },
        approvals: {
          [ORG_ID]: [emailItem({ id: 'eml_a', subject: 'AcmeMail', createdAt: '2026-08-29T09:00:00Z' })],
          [OTHER_ORG]: [
            emailItem({
              id: 'eml_g',
              subject: 'GlobexMail',
              createdAt: '2026-08-30T09:00:00Z',
              agentId: 'agt_g',
            }),
          ],
        },
      }),
    );
    renderApprovals();

    expect(await screen.findByText('AcmeMail')).toBeInTheDocument();
    expect(await screen.findByText('GlobexMail')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^acme$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^globex$/i })).toBeInTheDocument();
  });

  it('approving an email row hits the approve endpoint for its org', async () => {
    const fetchMock = mockFetch({
      approvals: {
        [ORG_ID]: [emailItem({ id: 'eml_1', subject: 'Re: Q3 rollout', createdAt: '2026-08-29T09:00:00Z' })],
      },
    });
    useFetch(fetchMock);
    renderApprovals();

    await screen.findByText('Re: Q3 rollout');
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() =>
      expect(
        (fetchMock as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/orgs/${ORG_ID}/email/emails/eml_1/approve`) &&
            (i?.method ?? 'GET').toUpperCase() === 'POST',
        ),
      ).toBe(true),
    );
    // Resolution is final: the row collapses in place to its outcome.
    expect(await screen.findByText(/delivered — sender trusted/i)).toBeInTheDocument();
  });
});

describe('MyApprovals (/me/approvals) — live', () => {
  const quarantined = (id: string, subject: string, agentId = AGENT_ID) =>
    `event: email.quarantined\ndata: ${JSON.stringify({
      email: preview({
        id,
        subject,
        disposition: 'quarantined',
        reason: 'unrecognized-sender',
        status: 'unread',
        createdAt: '2026-08-31T15:00:00Z',
      }),
      thread: threadRef({ id: `eth_${id}`, trusted: false, lastEmailAt: null }),
      agent: { id: agentId, name: 'fable' },
      reason: 'unrecognized-sender',
    })}\n\n`;

  it('a live email.quarantined inserts a row (and only for an agent I own)', async () => {
    useFetch(
      mockFetch({
        frames: quarantined('eml_live', 'Fresh mail') + quarantined('eml_pat', 'Not mine', 'agt_pat'),
      }),
    );
    renderApprovals();

    expect(await screen.findByText('Fresh mail')).toBeInTheDocument();
    expect(screen.queryByText('Not mine')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^email\s+1/i })).toBeInTheDocument();
  });

  it('a live email.resolved resolves a row in place, naming who acted first', async () => {
    const resolved = `event: email.resolved\ndata: ${JSON.stringify({
      email: preview({ id: 'eml_a', disposition: 'delivered', status: 'unread' }),
      thread: threadRef({ trusted: true }),
      resolution: 'approved',
      by: { id: 'usr_pat', displayName: 'Pat' },
    })}\n\n`;
    useFetch(
      mockFetch({
        approvals: {
          [ORG_ID]: [emailItem({ id: 'eml_a', subject: 'Contested', createdAt: '2026-08-29T09:00:00Z' })],
        },
        frames: resolved,
      }),
    );
    renderApprovals();

    // The row stays put and collapses to its outcome — two approvers never fight.
    expect(await screen.findByText(/resolved by Pat/i)).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    // …and it no longer counts as waiting.
    expect(await screen.findByRole('heading', { name: /^email\s+0/i })).toBeInTheDocument();
  });
});
