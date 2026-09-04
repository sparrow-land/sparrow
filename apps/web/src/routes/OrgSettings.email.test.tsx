import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { CapabilitiesResponse, ExternalContact, OrgRole } from '@sparrow/common-types';
import { AuthProvider } from '../lib/auth.js';
import { OrgProvider } from '../lib/org.js';
import { CapabilitiesProvider } from '../lib/capabilities.js';
import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { ORG_ID, approvalItem, contact, preview, threadRef } from '../test/fixtures.js';
import { OrgSettings } from './OrgSettings.js';

/**
 * Org admin's EMAIL surfaces (SPEC v4 → *Web UI → Org admin* + *Capabilities
 * gating*): the Policies → Email subsection, the org-wide email approvals, the
 * Contacts list, and the governance address column. Everything here is gated on
 * `capabilities.email` — with the medium off NOTHING email-related renders and
 * no email route is even probed (the client gates render, never discovery).
 */

const CAPS_ON: CapabilitiesResponse = {
  email: true,
  emailReviewer: false,
  voice: { stt: false, tts: false, sttStreaming: false },
  orgHostSuffix: null,
  workspaceSwitcher: null,
};
const CAPS_OFF: CapabilitiesResponse = { ...CAPS_ON, email: false };

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
  email: {
    inboundUnrecognized: 'reject',
    outboundUnrecognized: 'reject',
    trustedPatterns: [],
    judgePrompt: null,
  },
};

/** An SSE response whose frames the test pushes explicitly (no races). */
function sse() {
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(enc.encode(': open\n\n'));
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  return {
    response,
    push(event: string, data: unknown) {
      ctrl?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
  };
}

interface MockOpts {
  role?: OrgRole;
  settings?: Record<string, unknown>;
  agents?: unknown[];
  approvals?: unknown[];
  contacts?: ExternalContact[];
  /** Force the settings PATCH to fail with this error envelope. */
  patchError?: { status: number; code: string; message: string };
}

function mockFetch(opts: MockOpts = {}) {
  const role = opts.role ?? 'owner';
  const settings = opts.settings ?? defaultSettings;
  const streams: { push(event: string, data: unknown): void }[] = [];
  const contactState = new Map((opts.contacts ?? []).map((c) => [c.id, c] as const));

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/auth/config')) return json({ providers: [], allowSignup: true });
    if (url.includes('/auth/me')) return json({ user: jake });
    if (url.includes('/me/orgs')) {
      return json({ items: [{ org: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role }] });
    }
    if (url.includes('/me/events')) {
      const s = sse();
      streams.push(s);
      return s.response;
    }

    if (url.includes(`/orgs/${ORG_ID}/email/approvals`)) {
      return json({ items: opts.approvals ?? [], nextCursor: null });
    }
    if (url.includes(`/orgs/${ORG_ID}/email/emails/`)) {
      return json({ email: preview() });
    }
    if (url.includes(`/orgs/${ORG_ID}/email/contacts`)) {
      if (method === 'PATCH') {
        const id = url.split('/contacts/')[1]!.split('?')[0]!;
        const body = JSON.parse(String(init?.body ?? '{}')) as { trust: string | null };
        const next = { ...contactState.get(id)!, trust: body.trust } as ExternalContact;
        contactState.set(id, next);
        return json({ contact: next });
      }
      const q = new URL(url, 'http://x').searchParams;
      let items = [...contactState.values()];
      const trust = q.get('trust');
      if (trust) items = items.filter((c) => (trust === 'unknown' ? c.trust === null : c.trust === trust));
      const needle = q.get('q');
      if (needle) items = items.filter((c) => c.email.startsWith(needle));
      return json({ items, nextCursor: null });
    }

    if (url.includes(`/orgs/${ORG_ID}/humans`)) return json({ items: [], nextCursor: null });
    if (url.includes(`/orgs/${ORG_ID}/agents`)) return json({ items: opts.agents ?? [] });
    if (url.includes(`/orgs/${ORG_ID}/enrollments`)) return json({ items: [] });
    if (url.includes(`/orgs/${ORG_ID}/invites`)) return json({ items: [] });

    if (url.includes(`/orgs/${ORG_ID}`)) {
      if (method === 'PATCH') {
        if (opts.patchError) {
          return errorJson(opts.patchError.code, opts.patchError.status, opts.patchError.message);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return json({
          org: {
            id: ORG_ID,
            name: 'Acme',
            slug: 'acme',
            settings,
            createdAt: '2026-01-01T00:00:00Z',
            ...body,
          },
        });
      }
      return json({
        org: {
          id: ORG_ID,
          name: 'Acme',
          slug: 'acme',
          settings,
          createdAt: '2026-01-01T00:00:00Z',
        },
      });
    }

    return json({ error: { code: 'not_found', message: `unmocked ${method} ${url}` } }, 404);
  });

  return Object.assign(fn, {
    push(event: string, data: unknown) {
      for (const s of streams) s.push(event, data);
    },
  });
}

function renderAdmin(caps: CapabilitiesResponse = CAPS_ON) {
  return render(
    <MemoryRouter initialEntries={[`/org/${ORG_ID}/admin`]}>
      <CapabilitiesProvider initial={caps}>
        <AuthProvider>
          <OrgProvider orgId={ORG_ID}>
            <OrgSettings />
          </OrgProvider>
        </AuthProvider>
      </CapabilitiesProvider>
    </MemoryRouter>,
  );
}

/** The last `PATCH /orgs/:orgId` body, parsed. */
function lastPatch(fetchMock: ReturnType<typeof mockFetch>): Record<string, any> | null {
  const calls = fetchMock.mock.calls.filter(
    ([u, i]) =>
      String(u).includes(`/orgs/${ORG_ID}`) &&
      !String(u).includes('/email/') &&
      (i?.method ?? 'GET').toUpperCase() === 'PATCH',
  );
  const last = calls.at(-1);
  return last ? JSON.parse(String(last[1]?.body ?? '{}')) : null;
}

async function policiesLoaded() {
  await screen.findByRole('radio', { name: /anyone can invite/i });
}

describe('OrgSettings — email surfaces', () => {
  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------------ *
   * Capabilities gating
   * ------------------------------------------------------------------ */

  it('renders NO email surface — and probes no email route — with the medium off', async () => {
    const fetchMock = mockFetch({
      approvals: [approvalItem()],
      contacts: [contact()],
      agents: [
        {
          agent: {
            id: 'agt_1',
            name: 'fable',
            emailAddress: 'fable@acme.example.com',
            createdAt: '2026-01-01T00:00:00Z',
          },
          owner: { id: 'usr_pat', displayName: 'Pat' },
        },
      ],
    });
    useFetch(fetchMock);
    renderAdmin(CAPS_OFF);
    await policiesLoaded();
    await screen.findByText('fable');

    // No Email policy subsection, no trusted-address editor, no reviewer box.
    expect(screen.queryByText(/email from people we don.t recognize/i)).toBeNull();
    expect(screen.queryByText(/always-trusted addresses/i)).toBeNull();
    expect(screen.queryByText(/what the automatic reviewer looks for/i)).toBeNull();
    // No Contacts list.
    expect(screen.queryByRole('heading', { name: /^contacts$/i })).toBeNull();
    // No email approvals in the org-wide Approvals block.
    expect(screen.queryByText(/Re: Q3 rollout/i)).toBeNull();
    // No address column on the governance list.
    expect(screen.queryByText('fable@acme.example.com')).toBeNull();
    // And nothing was discovered by taking a 404.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/email/'))).toBe(false);
  });

  /* ------------------------------------------------------------------ *
   * Policies → Email
   * ------------------------------------------------------------------ */

  it('renders the three-choice policies with the spec copy and the reject defaults', async () => {
    useFetch(mockFetch());
    renderAdmin();
    await policiesLoaded();

    expect(await screen.findByText(/email from people we don.t recognize/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /We recognize people in this workspace, addresses you.ve approved before, and the always-trusted addresses below\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/email your agents send to people we don.t recognize/i),
    ).toBeInTheDocument();

    const inbound = screen.getByRole('radiogroup', { name: /email from people we don.t recognize/i });
    expect(within(inbound).getByRole('radio', { name: /^reject it$/i })).toBeChecked();
    expect(within(inbound).getByRole('radio', { name: /ask me to approve it/i })).not.toBeChecked();
    within(inbound).getByRole('radio', { name: /let an automatic reviewer decide/i });

    const outbound = screen.getByRole('radiogroup', {
      name: /email your agents send to people we don.t recognize/i,
    });
    expect(within(outbound).getByRole('radio', { name: /don.t send it/i })).toBeChecked();
    within(outbound).getByRole('radio', { name: /ask me to approve it/i });
    within(outbound).getByRole('radio', { name: /let an automatic reviewer decide/i });
  });

  it('saves the wire values for the three-choice policies', async () => {
    const fetchMock = mockFetch();
    useFetch(fetchMock);
    renderAdmin();
    await policiesLoaded();

    const inbound = screen.getByRole('radiogroup', { name: /email from people we don.t recognize/i });
    await userEvent.click(within(inbound).getByRole('radio', { name: /ask me to approve it/i }));
    const outbound = screen.getByRole('radiogroup', {
      name: /email your agents send to people we don.t recognize/i,
    });
    await userEvent.click(
      within(outbound).getByRole('radio', { name: /let an automatic reviewer decide/i }),
    );
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]!);

    await waitFor(() => {
      const body = lastPatch(fetchMock);
      expect(body?.settings?.email).toMatchObject({
        inboundUnrecognized: 'approve',
        outboundUnrecognized: 'judge',
      });
      // The WHOLE settings object goes up, as the existing Policies save does.
      expect(body?.settings?.invites).toBeTruthy();
    });
  });

  it('states the degrade-to-approve rule, in the spec’s words, when no reviewer is registered', async () => {
    useFetch(mockFetch());
    // CAPS_ON carries `emailReviewer: false` — the medium is on, the judge is not.
    renderAdmin();
    await policiesLoaded();

    expect(screen.queryByText(/wait for your approval instead/i)).toBeNull();

    const inbound = screen.getByRole('radiogroup', { name: /email from people we don.t recognize/i });
    await userEvent.click(
      within(inbound).getByRole('radio', { name: /let an automatic reviewer decide/i }),
    );
    const notice = await screen.findByRole('note');
    // Asserted verbatim: this sentence is the SPEC's, and it is a promise about
    // what the server will actually do.
    expect(notice).toHaveTextContent(
      'No automatic reviewer is set up here, so these messages will wait for your approval instead.',
    );

    await userEvent.click(within(inbound).getByRole('radio', { name: /^reject it$/i }));
    await waitFor(() => expect(screen.queryByText(/wait for your approval instead/i)).toBeNull());
  });

  it('renders NO notice when a reviewer IS registered — it would be a lie', async () => {
    useFetch(mockFetch());
    renderAdmin({ ...CAPS_ON, emailReviewer: true });
    await policiesLoaded();

    for (const group of [
      /email from people we don.t recognize/i,
      /email your agents send to people we don.t recognize/i,
    ]) {
      await userEvent.click(
        within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', {
          name: /let an automatic reviewer decide/i,
        }),
      );
    }
    expect(screen.queryByText(/wait for your approval instead/i)).toBeNull();
  });

  it('the OUTBOUND policy raises the notice too', async () => {
    useFetch(mockFetch());
    renderAdmin();
    await policiesLoaded();

    const outbound = screen.getByRole('radiogroup', {
      name: /email your agents send to people we don.t recognize/i,
    });
    await userEvent.click(
      within(outbound).getByRole('radio', { name: /let an automatic reviewer decide/i }),
    );
    expect(await screen.findByText(/wait for your approval instead/i)).toBeInTheDocument();
  });

  /* ---- Always-trusted addresses ---- */

  it('adds and removes always-trusted addresses and saves them', async () => {
    const fetchMock = mockFetch();
    useFetch(fetchMock);
    renderAdmin();
    await policiesLoaded();

    expect(
      screen.getByText(
        /Mail from these addresses reaches your agents without approval\./i,
      ),
    ).toBeInTheDocument();

    const input = screen.getByLabelText(/add a trusted address/i);
    await userEvent.type(input, '*@partner.example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    // The chip is identified by its own remove control (the help copy quotes the
    // same example, so the bare text is deliberately not unique).
    expect(
      await screen.findByRole('button', { name: /remove \*@partner\.example\.com/i }),
    ).toBeInTheDocument();

    await userEvent.type(input, 'dana@other.example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await screen.findByText('dana@other.example.com');

    // Remove the second one again.
    await userEvent.click(
      screen.getByRole('button', { name: /remove dana@other\.example\.com/i }),
    );
    await waitFor(() => expect(screen.queryByText('dana@other.example.com')).toBeNull());

    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]!);
    await waitFor(() =>
      expect(lastPatch(fetchMock)?.settings?.email?.trustedPatterns).toEqual([
        '*@partner.example.com',
      ]),
    );
  });

  it('rejects an invalid trusted address inline, in plain words, without saving', async () => {
    const fetchMock = mockFetch();
    useFetch(fetchMock);
    renderAdmin();
    await policiesLoaded();

    const input = screen.getByLabelText(/add a trusted address/i);
    await userEvent.type(input, '*@*.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(/that address can.t be trusted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove \*@\*\.com/i })).toBeNull();
    expect(lastPatch(fetchMock)).toBeNull();
  });

  it('surfaces the server’s rejection of a trusted address inline', async () => {
    const fetchMock = mockFetch({
      patchError: {
        status: 400,
        code: 'bad_request',
        message: 'pattern must not be a catch-all: every part of the domain needs a real name',
      },
    });
    useFetch(fetchMock);
    renderAdmin();
    await policiesLoaded();

    const input = screen.getByLabelText(/add a trusted address/i);
    await userEvent.type(input, 'dana@partner.example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]!);

    expect(await screen.findByText(/must not be a catch-all/i)).toBeInTheDocument();
  });

  /* ---- Reviewer instructions ---- */

  it('saves the reviewer instructions, and null once cleared', async () => {
    const fetchMock = mockFetch({
      settings: { ...defaultSettings, email: { ...defaultSettings.email, judgePrompt: null } },
    });
    useFetch(fetchMock);
    renderAdmin();
    await policiesLoaded();

    expect(screen.getByText(/what the automatic reviewer looks for/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Describe in your own words what should be allowed and what shouldn.t\. Only used when you choose .Let an automatic reviewer decide.\./i,
      ),
    ).toBeInTheDocument();

    const box = screen.getByLabelText(/what the automatic reviewer looks for/i);
    await userEvent.type(box, 'no invoices from strangers');
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]!);
    await waitFor(() =>
      expect(lastPatch(fetchMock)?.settings?.email?.judgePrompt).toBe('no invoices from strangers'),
    );

    await userEvent.clear(box);
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[1]!);
    await waitFor(() => expect(lastPatch(fetchMock)?.settings?.email?.judgePrompt).toBeNull());
  });

  it('reflects the org’s stored email policy', async () => {
    useFetch(
      mockFetch({
        settings: {
          ...defaultSettings,
          email: {
            inboundUnrecognized: 'judge',
            outboundUnrecognized: 'approve',
            trustedPatterns: ['*@partner.example.com'],
            judgePrompt: 'only invoices',
          },
        },
      }),
    );
    renderAdmin();
    await policiesLoaded();

    const inbound = screen.getByRole('radiogroup', { name: /email from people we don.t recognize/i });
    expect(
      within(inbound).getByRole('radio', { name: /let an automatic reviewer decide/i }),
    ).toBeChecked();
    const outbound = screen.getByRole('radiogroup', {
      name: /email your agents send to people we don.t recognize/i,
    });
    expect(within(outbound).getByRole('radio', { name: /ask me to approve it/i })).toBeChecked();
    expect(
      screen.getByRole('button', { name: /remove \*@partner\.example\.com/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/what the automatic reviewer looks for/i)).toHaveValue(
      'only invoices',
    );
    // A stored `judge` policy shows the honest notice on load.
    expect(screen.getByText(/wait for your approval instead/i)).toBeInTheDocument();
  });

  /* ------------------------------------------------------------------ *
   * Org-wide approvals
   * ------------------------------------------------------------------ */

  it('lists pending email for ANOTHER member’s agent in the org-wide approvals', async () => {
    useFetch(
      mockFetch({
        approvals: [
          approvalItem({ agent: { id: 'agt_pat', name: 'scout' } }),
        ],
      }),
    );
    renderAdmin();

    const approvals = (await screen.findByRole('heading', { name: /^approvals$/i })).closest(
      'section',
    )!;
    expect(await within(approvals).findByText('Re: Q3 rollout')).toBeInTheDocument();
    expect(within(approvals).getByText('scout')).toBeInTheDocument();
    expect(within(approvals).getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });

  it('inserts a live email.quarantined row and resolves it in place on email.resolved', async () => {
    const fetchMock = mockFetch({ approvals: [] });
    useFetch(fetchMock);
    renderAdmin();

    const approvals = (await screen.findByRole('heading', { name: /^approvals$/i })).closest(
      'section',
    )!;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/me/events'))).toBe(true),
    );

    const incoming = preview({
      id: 'eml_live',
      subject: 'Urgent invoice',
      disposition: 'quarantined',
      reason: 'unrecognized-sender',
      status: 'unread',
    });
    await act(async () => {
      fetchMock.push('email.quarantined', {
        email: incoming,
        thread: threadRef({ id: 'eth_live', trusted: false }),
        agent: { id: 'agt_pat', name: 'scout' },
        reason: 'unrecognized-sender',
      });
      await Promise.resolve();
    });
    expect(await within(approvals).findByText('Urgent invoice')).toBeInTheDocument();

    await act(async () => {
      fetchMock.push('email.resolved', {
        email: { ...incoming, disposition: 'delivered', reason: null },
        thread: threadRef({ id: 'eth_live' }),
        resolution: 'approved',
        by: { id: 'usr_pat', displayName: 'Pat' },
      });
      await Promise.resolve();
    });
    expect(await within(approvals).findByText(/resolved by Pat/i)).toBeInTheDocument();
    expect(within(approvals).queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  /* ------------------------------------------------------------------ *
   * Contacts
   * ------------------------------------------------------------------ */

  it('lists contacts with trust and who resolved them, and says trust is forward-looking', async () => {
    useFetch(
      mockFetch({
        contacts: [
          contact(),
          contact({
            id: 'ext_sam',
            email: 'sam@spam.example.com',
            displayName: null,
            trust: 'blocked',
            resolvedBy: { id: 'usr_pat', displayName: 'Pat' },
          }),
          contact({
            id: 'ext_new',
            email: 'new@unknown.example.com',
            displayName: null,
            trust: null,
            resolvedAt: null,
            resolvedBy: null,
          }),
        ],
      }),
    );
    renderAdmin();

    const contacts = (await screen.findByRole('heading', { name: /^contacts$/i })).closest(
      'section',
    )!;
    expect(await within(contacts).findByText('dana@partner.example.com')).toBeInTheDocument();
    // The quiet trust pills (lowercase; the capitalized words are filter chips).
    expect(within(contacts).getByText('trusted')).toBeInTheDocument();
    expect(within(contacts).getByText('blocked')).toBeInTheDocument();
    expect(within(contacts).getByText(/by Jake/i)).toBeInTheDocument();
    expect(
      within(contacts).getByText(/only affects future email/i),
    ).toBeInTheDocument();
  });

  it('approves, blocks and resets a contact', async () => {
    const fetchMock = mockFetch({
      contacts: [
        contact({ id: 'ext_new', email: 'new@unknown.example.com', trust: null, resolvedBy: null }),
      ],
    });
    useFetch(fetchMock);
    renderAdmin();

    const contacts = (await screen.findByRole('heading', { name: /^contacts$/i })).closest(
      'section',
    )!;
    await within(contacts).findByText('new@unknown.example.com');

    await userEvent.click(
      within(contacts).getByRole('button', { name: /approve new@unknown\.example\.com/i }),
    );
    await waitFor(() => expect(lastContactPatch(fetchMock)).toEqual({ trust: 'approved' }));

    await userEvent.click(
      await within(contacts).findByRole('button', { name: /block new@unknown\.example\.com/i }),
    );
    await waitFor(() => expect(lastContactPatch(fetchMock)).toEqual({ trust: 'blocked' }));

    await userEvent.click(
      await within(contacts).findByRole('button', { name: /reset new@unknown\.example\.com/i }),
    );
    await waitFor(() => expect(lastContactPatch(fetchMock)).toEqual({ trust: null }));
  });

  it('filters contacts by trust and searches by address', async () => {
    const fetchMock = mockFetch({
      contacts: [
        contact(),
        contact({
          id: 'ext_sam',
          email: 'sam@spam.example.com',
          trust: 'blocked',
        }),
      ],
    });
    useFetch(fetchMock);
    renderAdmin();

    const contacts = (await screen.findByRole('heading', { name: /^contacts$/i })).closest(
      'section',
    )!;
    await within(contacts).findByText('dana@partner.example.com');

    await userEvent.click(within(contacts).getByRole('button', { name: /^blocked$/i }));
    await waitFor(() =>
      expect(within(contacts).queryByText('dana@partner.example.com')).toBeNull(),
    );
    expect(within(contacts).getByText('sam@spam.example.com')).toBeInTheDocument();

    await userEvent.click(within(contacts).getByRole('button', { name: /^all$/i }));
    await within(contacts).findByText('dana@partner.example.com');

    await userEvent.type(within(contacts).getByLabelText(/search addresses/i), 'dana');
    await waitFor(
      () => expect(within(contacts).queryByText('sam@spam.example.com')).toBeNull(),
      { timeout: 2000 },
    );
  });

  /* ------------------------------------------------------------------ *
   * Governance address column
   * ------------------------------------------------------------------ */

  it('shows each agent’s email address in the governance list', async () => {
    useFetch(
      mockFetch({
        agents: [
          {
            agent: {
              id: 'agt_1',
              name: 'fable',
              emailAddress: 'fable@acme.example.com',
              createdAt: '2026-01-01T00:00:00Z',
            },
            owner: { id: 'usr_pat', displayName: 'Pat' },
          },
          {
            agent: {
              id: 'agt_2',
              name: 'scout',
              emailAddress: null,
              createdAt: '2026-01-02T00:00:00Z',
            },
            owner: { id: 'usr_jake', displayName: 'Jake' },
          },
        ],
      }),
    );
    renderAdmin();

    const agents = (await screen.findByRole('heading', { name: /^agents$/i })).closest('section')!;
    expect(await within(agents).findByText('fable@acme.example.com')).toBeInTheDocument();
    // An agent with no address renders no placeholder at all.
    expect(within(agents).getByText('scout')).toBeInTheDocument();
  });
});

/** The last `PATCH …/email/contacts/:id` body, parsed. */
function lastContactPatch(fetchMock: ReturnType<typeof mockFetch>): unknown {
  const calls = fetchMock.mock.calls.filter(
    ([u, i]) =>
      String(u).includes('/email/contacts/') && (i?.method ?? 'GET').toUpperCase() === 'PATCH',
  );
  const last = calls.at(-1);
  return last ? JSON.parse(String(last[1]?.body ?? '{}')) : null;
}
