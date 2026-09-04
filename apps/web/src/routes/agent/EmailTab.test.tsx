import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { restoreFetch, json, errorJson } from '../../test/apiStub.js';
import {
  agentParty,
  contact,
  email,
  party,
  preview,
  thread,
  threadRef,
  AGENT_ID,
  ORG_ID,
  THREAD_ID,
} from '../../test/fixtures.js';
import { renderAgentPage, AGENT_ADDRESS } from './testHarness.js';

const EMAIL_URL = '/org/1/agents/1?tab=email';
const THREAD_URL = `/org/1/agents/1?tab=email&thread=${THREAD_ID}`;

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

/**
 * The email routes: the newest-first thread LIST (full threads, `nextBefore`),
 * plus one full thread per id for the thread VIEW. `pages` answers successive
 * list reads in order — the last one repeats, which is what a live refetch gets.
 */
function emailRoutes(opts: {
  threads?: unknown[];
  nextBefore?: string | null;
  pages?: { items: unknown[]; nextBefore: string | null }[];
  full?: Record<string, unknown>;
  contacts?: unknown[];
}) {
  let n = 0;
  return (url: string): Response | null => {
    const m = /\/email\/threads\/([^?]+)/.exec(url);
    if (m) {
      const found = opts.full?.[decodeURIComponent(m[1]!)];
      return found ? json(found) : errorJson('not_found', 404);
    }
    if (url.includes('/email/threads')) {
      if (opts.pages) {
        const page = opts.pages[Math.min(n, opts.pages.length - 1)]!;
        n += 1;
        return json(page);
      }
      return json({ items: opts.threads ?? [], nextBefore: opts.nextBefore ?? null });
    }
    if (url.includes('/email/contacts')) {
      return json({ items: opts.contacts ?? [], nextCursor: null });
    }
    return null;
  };
}

describe('Agent page — Email tab (threads list)', () => {
  it('renders in the wire’s own newest-first order (no client sort)', async () => {
    renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        threads: [
          thread({ id: 'eth_new', subject: 'Newer thread', lastEmailAt: '2026-08-31T12:04:00Z' }),
          thread({ id: 'eth_old', subject: 'Older thread', lastEmailAt: '2026-08-29T09:00:00Z' }),
        ],
      }),
    });
    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Newer thread');
    expect(rows[1]).toHaveTextContent('Older thread');
  });

  it('a row carries subject, ≤3 participant chips + “+N”, unread dot, trusted pill and the newest disposition badge — from the ROW, with no second request', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        threads: [
          thread({
            trusted: true,
            unreadCount: 2,
            lastDisposition: 'quarantined',
            participants: [
              party({ email: 'dana@partner.example.com', name: 'Dana Lee' }),
              party({ email: 'raj@partner.example.com', name: 'Raj P' }),
              party({ email: 'sam@partner.example.com', name: 'Sam Q' }),
              agentParty(),
            ],
          }),
        ],
      }),
    });

    const row = (await screen.findAllByRole('listitem'))[0]!;
    expect(within(row).getByText('Q3 rollout')).toBeInTheDocument();
    expect(within(row).getByText('Dana Lee')).toBeInTheDocument();
    expect(within(row).getByText('Raj P')).toBeInTheDocument();
    expect(within(row).getByText('Sam Q')).toBeInTheDocument();
    expect(within(row).getByText('+1')).toBeInTheDocument();
    expect(within(row).getByText('trusted')).toBeInTheDocument();
    expect(within(row).getByText(/2 unread/i)).toBeInTheDocument();
    expect(within(row).getByText('Quarantined')).toBeInTheDocument();

    // The whole point of the wire change: triage costs ONE request, not one per
    // row. Nothing reached `…/email/threads/<id>`.
    expect(rec.requests.some((r) => /\/email\/threads\/eth_/.test(r.url))).toBe(false);
  });

  it('a happy-path thread badges nothing', async () => {
    renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({ threads: [thread({ lastDisposition: 'delivered' })] }),
    });
    const row = (await screen.findAllByRole('listitem'))[0]!;
    expect(within(row).queryByText('Quarantined')).toBeNull();
    expect(within(row).queryByText('Held')).toBeNull();
  });

  it('pages BACKWARD with ?before=, appending older threads to the end', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        pages: [
          { items: [thread({ id: 'eth_new', subject: 'Newer thread' })], nextBefore: 'eth_new' },
          { items: [thread({ id: 'eth_old', subject: 'Older thread' })], nextBefore: null },
        ],
      }),
    });

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /show more threads/i }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Newer thread');
    expect(rows[1]).toHaveTextContent('Older thread');
    expect(rec.lastQuery('/email/threads')?.get('before')).toBe('eth_new');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /show more threads/i })).toBeNull(),
    );
  });

  it('the empty state names the agent’s address', async () => {
    renderAgentPage({ url: EMAIL_URL });
    // Wait for the empty state itself: the header also carries the address, so
    // finding the address alone would pass before the list even loaded.
    const empty = await screen.findByText(/will appear here/i);
    expect(empty).toHaveTextContent(`Mail sent to ${AGENT_ADDRESS} will appear here.`);
    expect(screen.getByText('No email yet.')).toBeInTheDocument();
  });

  it('opening a row deep-links into the thread', async () => {
    renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        threads: [thread()],
        full: {
          [THREAD_ID]: { thread: thread(), items: [email()], nextCursor: null },
        },
      }),
    });
    await userEvent.click(await screen.findByRole('link', { name: /q3 rollout/i }));
    expect(await screen.findByRole('heading', { name: 'Q3 rollout' })).toBeInTheDocument();
  });

  /* ---- live: rows are AGGREGATES, so the honest update is a refetch ------- */

  it('email.received for this agent re-reads the head, and the row restates its unread count', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        pages: [
          { items: [thread({ unreadCount: 0 })], nextBefore: null },
          { items: [thread({ unreadCount: 1 })], nextBefore: null },
        ],
      }),
    });
    await screen.findAllByRole('listitem');
    expect(screen.queryByText(/1 unread/i)).toBeNull();
    const before = rec.count('/agents/agt_1/email/threads');

    await rec.push('email.received', {
      email: preview({ id: 'eml_9', status: 'unread' }),
      thread: threadRef(),
    });

    await waitFor(() => expect(rec.count('/agents/agt_1/email/threads')).toBe(before + 1));
    expect(await screen.findByText(/1 unread/i)).toBeInTheDocument();
  });

  it('email.resolved for this agent re-reads the head, and the badge follows', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        pages: [
          { items: [thread({ lastDisposition: 'held' })], nextBefore: null },
          { items: [thread({ lastDisposition: 'sent' })], nextBefore: null },
        ],
      }),
    });
    expect(await screen.findByText('Held')).toBeInTheDocument();

    await rec.push('email.resolved', {
      email: preview({ id: 'eml_1', direction: 'out', disposition: 'sent' }),
      thread: threadRef(),
      resolution: 'approved',
      by: { id: 'usr_1', displayName: 'Jake' },
    });

    await waitFor(() => expect(screen.queryByText('Held')).toBeNull());
  });

  it('ignores an email.* frame for a DIFFERENT agent’s thread', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({ threads: [thread()] }),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/email/threads');

    await rec.push('email.received', {
      email: preview({ id: 'eml_9' }),
      thread: threadRef({ id: 'eth_other', agentId: 'agt_other' }),
    });

    expect(rec.count('/agents/agt_1/email/threads')).toBe(before);
  });

  it('a replay.gap re-reads the head without duplicating rows', async () => {
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      handle: emailRoutes({
        pages: [
          { items: [thread({ id: 'eth_1', subject: 'Q3 rollout' })], nextBefore: null },
          {
            items: [
              thread({ id: 'eth_2', subject: 'Missed thread' }),
              thread({ id: 'eth_1', subject: 'Q3 rollout' }),
            ],
            nextBefore: null,
          },
        ],
      }),
    });
    await screen.findAllByRole('listitem');

    await rec.push('replay.gap', { reason: 'trimmed' });

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Missed thread');
  });

  it('a viewer who does NOT own the agent polls the head', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rec } = renderAgentPage({
      url: EMAIL_URL,
      role: 'admin',
      owner: { id: 'usr_2', displayName: 'Mira' },
      handle: emailRoutes({ threads: [thread()] }),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/email/threads');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(rec.count('/agents/agt_1/email/threads')).toBeGreaterThan(before);
    vi.useRealTimers();
  });
});

describe('Agent page — Email tab (thread view)', () => {
  const full = {
    [THREAD_ID]: {
      thread: thread({ subject: 'Q3 rollout', trusted: true }),
      items: [
        email({ id: 'eml_1', subject: 'Q3 rollout', text: 'first message', createdAt: '2026-08-30T09:00:00Z' }),
        email({ id: 'eml_2', subject: 'Re: Q3 rollout', text: 'second message', createdAt: '2026-08-31T12:04:00Z' }),
      ],
      nextCursor: null,
    },
  };

  it('a ?thread= deep link opens the thread directly, ascending and expanded', async () => {
    renderAgentPage({ url: THREAD_URL, handle: emailRoutes({ threads: [thread()], full }) });
    expect(await screen.findByRole('heading', { name: 'Q3 rollout' })).toBeInTheDocument();
    const bodies = await screen.findAllByTestId('email-body');
    expect(bodies).toHaveLength(2);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('first message');
    expect(rows[1]).toHaveTextContent('second message');
  });

  it('names the thread’s ORIGINAL subject and its trusted state', async () => {
    renderAgentPage({ url: THREAD_URL, handle: emailRoutes({ threads: [thread()], full }) });
    const heading = await screen.findByRole('heading', { name: 'Q3 rollout' });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByText('trusted').length).toBeGreaterThan(0);
  });

  it('lists the full participant set with trust pills', async () => {
    renderAgentPage({
      url: THREAD_URL,
      handle: emailRoutes({
        threads: [thread()],
        full,
        contacts: [contact({ id: 'ext_dana', trust: 'blocked' })],
      }),
    });
    const participants = await screen.findByRole('group', { name: /participants/i });
    expect(within(participants).getByText('Dana Lee')).toBeInTheDocument();
    expect(within(participants).getByText('fable')).toBeInTheDocument();
    expect(within(participants).getByText('blocked')).toBeInTheDocument();
  });

  it('a quarantined email in the thread offers its Review affordance', async () => {
    renderAgentPage({
      url: THREAD_URL,
      handle: emailRoutes({
        threads: [thread()],
        full: {
          [THREAD_ID]: {
            thread: thread(),
            items: [email({ disposition: 'quarantined', reason: 'unrecognized-sender' })],
            nextCursor: null,
          },
        },
      }),
    });
    const review = await screen.findByRole('link', { name: /review/i });
    expect(review).toHaveAttribute('href', '/me/approvals');
  });

  it('a thread that is gone renders a plain note, not a crash', async () => {
    renderAgentPage({ url: THREAD_URL, handle: emailRoutes({ threads: [], full: {} }) });
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it('reads the thread on the org-scoped agent route', async () => {
    const { rec } = renderAgentPage({
      url: THREAD_URL,
      handle: emailRoutes({ threads: [thread()], full }),
    });
    await waitFor(() =>
      expect(
        rec.requests.some((r) =>
          r.url.includes(`/orgs/${ORG_ID}/agents/${AGENT_ID}/email/threads/${THREAD_ID}`),
        ),
      ).toBe(true),
    );
  });

  it('going back returns to the threads list', async () => {
    renderAgentPage({ url: THREAD_URL, handle: emailRoutes({ threads: [thread()], full }) });
    await userEvent.click(await screen.findByRole('link', { name: /all threads/i }));
    expect(await screen.findByRole('link', { name: /q3 rollout/i })).toBeInTheDocument();
  });
});
