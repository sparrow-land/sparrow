import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { restoreFetch, json } from '../../test/apiStub.js';
import {
  activityEntry,
  chatEntry,
  contact,
  email,
  preview,
  threadRef,
  AGENT_ID,
  ORG_ID,
} from '../../test/fixtures.js';
import { renderAgentPage, CAPS_OFF } from './testHarness.js';

const ACTIVITY_URL = '/org/1/agents/1?tab=activity';

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

/**
 * A handler for the activity route in the wire's own order: NEWEST FIRST, paged
 * backward with `before` / `nextBefore`. Pages are answered in sequence, so the
 * n-th read gets the n-th page (the last one repeats for refetches).
 */
function activityRoutes(
  pages: { items: unknown[]; nextBefore: string | null }[],
  extra?: (url: string) => Response | null,
) {
  let n = 0;
  return (url: string): Response | null => {
    if (url.includes('/agents/agt_1/activity')) {
      const page = pages[Math.min(n, pages.length - 1)]!;
      n += 1;
      return json(page);
    }
    return extra?.(url) ?? null;
  };
}

describe('Agent page — Activity tab', () => {
  it('renders the timeline in the wire’s own newest-first order (no client reverse)', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        {
          items: [
            activityEntry({ id: 'act_b', summary: 'Re: Q3 rollout', createdAt: '2026-08-31T12:04:00Z' }),
            chatEntry({ id: 'act_a', summary: 'ship it', createdAt: '2026-08-31T09:00:00Z' }),
          ],
          nextBefore: null,
        },
      ]),
    });

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Re: Q3 rollout');
    expect(rows[1]).toHaveTextContent('ship it');
  });

  it('renders a chat entry as a one-line message card (no bubbles here)', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [chatEntry()], nextBefore: null }]),
    });
    const row = (await screen.findAllByRole('listitem'))[0]!;
    expect(within(row).getByText('Jake')).toBeInTheDocument();
    expect(within(row).getByText('ship it')).toBeInTheDocument();
  });

  it('filter chips are All / Chat / Email, and send ?medium=', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [activityEntry()], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');
    expect(rec.lastQuery('/activity')?.get('medium')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(rec.lastQuery('/activity')?.get('medium')).toBe('email'));

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(rec.lastQuery('/activity')?.get('medium')).toBe('chat'));

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(rec.lastQuery('/activity')?.get('medium')).toBeNull());
  });

  it('has no Email chip (and no Voice chip, ever) with the medium off', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      caps: CAPS_OFF,
      handle: activityRoutes([{ items: [chatEntry()], nextBefore: null }]),
    });
    expect(await screen.findByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email' })).toBeNull();
    expect(screen.queryByRole('button', { name: /voice/i })).toBeNull();
  });

  it('expands an email card in place, fetching the body once', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [activityEntry()], nextBefore: null }], (url) =>
        url.includes('/email/emails/eml_1') ? json({ email: email() }) : null,
      ),
    });
    const row = await screen.findByRole('button', { name: /received email from dana lee/i });
    await userEvent.click(row);
    expect(await screen.findByTestId('email-body')).toBeInTheDocument();
    expect(screen.getByText(/the plan is attached/)).toBeInTheDocument();
  });

  it('shows an external contact’s trust pill when the caller may read contacts', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      role: 'owner',
      handle: activityRoutes([{ items: [activityEntry()], nextBefore: null }], (url) =>
        url.includes('/email/contacts')
          ? json({ items: [contact({ id: 'ext_dana', trust: 'approved' })], nextCursor: null })
          : null,
      ),
    });
    expect(await screen.findByText('trusted')).toBeInTheDocument();
  });

  it('renders no trust pill (and never calls the admin-only contacts route) for a plain owner', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      role: 'member',
      handle: activityRoutes([{ items: [activityEntry()], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');
    expect(screen.queryByText('trusted')).toBeNull();
    expect(rec.requests.some((r) => r.url.includes('/email/contacts'))).toBe(false);
  });

  it('pages BACKWARD with ?before=, appending older entries to the end', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        {
          items: [activityEntry({ id: 'act_new', summary: 'newer', createdAt: '2026-08-31T09:00:00Z' })],
          nextBefore: 'act_new',
        },
        {
          items: [activityEntry({ id: 'act_old', summary: 'older', createdAt: '2026-08-30T09:00:00Z' })],
          nextBefore: null,
        },
      ]),
    });

    // The first page is already the top of the list — nothing is fetched for it.
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(rec.count('/agents/agt_1/activity')).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: /load older activity/i }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('newer');
    expect(rows[1]).toHaveTextContent('older');
    expect(rec.lastQuery('/activity')?.get('before')).toBe('act_new');

    // Cursor exhausted: the affordance goes away rather than paging forever.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load older activity/i })).toBeNull(),
    );
  });

  it('has no pager at all when the first page is the whole timeline', async () => {
    renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [activityEntry()], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: /load older activity/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /load newer activity/i })).toBeNull();
  });

  /**
   * Issue #28: an empty timeline must EXPLAIN itself. The surface is
   * agent-anchored by design, so a workspace whose agents have not started
   * working yet sees nothing here — and read a blank panel as broken. The empty
   * state now says what the timeline follows and what would fill it.
   */
  it('explains the empty timeline instead of showing a bare panel', async () => {
    renderAgentPage({ url: ACTIVITY_URL });
    // It names what the timeline FOLLOWS…
    const explanation = await screen.findByText(/this timeline follows/i);
    expect(explanation).toBeInTheDocument();
    expect(explanation.textContent).toContain('fable');
    // …and what would fill it.
    expect(explanation.textContent).toMatch(/conversation/i);
  });

  it('asks for this agent’s timeline on the org-scoped route', async () => {
    const { rec } = renderAgentPage({ url: ACTIVITY_URL });
    await waitFor(() =>
      expect(
        rec.requests.some((r) =>
          r.url.includes(`/orgs/${ORG_ID}/agents/${AGENT_ID}/activity`),
        ),
      ).toBe(true),
    );
  });

  /* ---- live: the same /me/events fan-in the conversation pane uses -------- */

  it('inserts a live activity.appended entry at the TOP, without refetching', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        {
          items: [activityEntry({ id: 'act_old', summary: 'older', createdAt: '2026-08-30T09:00:00Z' })],
          nextBefore: null,
        },
      ]),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/activity');

    await rec.push('activity.appended', {
      entry: activityEntry({ id: 'act_live', summary: 'just now', createdAt: '2026-08-31T14:00:00Z' }),
    });

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('just now');
    expect(rows[1]).toHaveTextContent('older');
    // Live-inserted in place: the timeline was not re-read.
    expect(rec.count('/agents/agt_1/activity')).toBe(before);
  });

  it('ignores activity.appended for a DIFFERENT agent, and de-dupes by entry id', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [activityEntry({ id: 'act_1' })], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');

    await rec.push('activity.appended', {
      entry: activityEntry({ id: 'act_other', agent: { id: 'agt_other', name: 'other' } }),
    });
    await rec.push('activity.appended', { entry: activityEntry({ id: 'act_1' }) });

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('respects the active medium filter when a live entry arrives', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([{ items: [activityEntry({ id: 'act_1' })], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');
    await userEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(rec.lastQuery('/activity')?.get('medium')).toBe('email'));

    await rec.push('activity.appended', {
      entry: chatEntry({ id: 'act_chat_live', summary: 'not this tab' }),
    });

    expect(screen.queryByText('not this tab')).toBeNull();
  });

  it('email.resolved flips a Held badge to none, in place, with no refetch', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        { items: [activityEntry({ id: 'act_h', type: 'email.held' })], nextBefore: null },
      ]),
    });
    expect(await screen.findByText('Held')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toBeTruthy();
    const before = rec.count('/agents/agt_1/activity');

    await rec.push('email.resolved', {
      email: preview({ id: 'eml_1', direction: 'out', disposition: 'sent' }),
      thread: threadRef(),
      resolution: 'approved',
      by: { id: 'usr_1', displayName: 'Jake' },
    });

    await waitFor(() => expect(screen.queryByText('Held')).toBeNull());
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
    expect(rec.count('/agents/agt_1/activity')).toBe(before);
  });

  it('a denial grays the card in place to “Denied”', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        { items: [activityEntry({ id: 'act_q', type: 'email.quarantined' })], nextBefore: null },
      ]),
    });
    expect(await screen.findByText('Quarantined')).toBeInTheDocument();

    await rec.push('email.resolved', {
      email: preview({ id: 'eml_1', disposition: 'rejected', reason: 'denied' }),
      thread: threadRef(),
      resolution: 'denied',
      by: { id: 'usr_1', displayName: 'Jake' },
    });

    expect(await screen.findByText('Denied')).toBeInTheDocument();
    expect(screen.queryByText('Quarantined')).toBeNull();
  });

  it('a replay.gap refetches the head and folds it in without duplicating rows', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        { items: [activityEntry({ id: 'act_1', summary: 'first' })], nextBefore: null },
        {
          items: [
            activityEntry({ id: 'act_2', summary: 'missed', createdAt: '2026-08-31T13:00:00Z' }),
            activityEntry({ id: 'act_1', summary: 'first' }),
          ],
          nextBefore: null,
        },
      ]),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/activity');

    await rec.push('replay.gap', { reason: 'trimmed' });

    await waitFor(() => expect(rec.count('/agents/agt_1/activity')).toBe(before + 1));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('missed');
  });

  it('email.rejected (which carries no email id) reconciles instead of guessing', async () => {
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      handle: activityRoutes([
        { items: [activityEntry({ id: 'act_1' })], nextBefore: null },
        {
          items: [
            activityEntry({ id: 'act_r', type: 'email.rejected', createdAt: '2026-08-31T13:00:00Z' }),
            activityEntry({ id: 'act_1' }),
          ],
          nextBefore: null,
        },
      ]),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/activity');

    await rec.push('email.rejected', { agentId: AGENT_ID, orgId: ORG_ID, reason: 'unrecognized-sender' });

    await waitFor(() => expect(rec.count('/agents/agt_1/activity')).toBe(before + 1));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  });

  it('a viewer who does NOT own the agent polls the head (no activity.appended reaches them)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rec } = renderAgentPage({
      url: ACTIVITY_URL,
      // An org admin reading someone ELSE's agent.
      role: 'admin',
      owner: { id: 'usr_2', displayName: 'Mira' },
      handle: activityRoutes([{ items: [activityEntry({ id: 'act_1' })], nextBefore: null }]),
    });
    await screen.findAllByRole('listitem');
    const before = rec.count('/agents/agt_1/activity');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(rec.count('/agents/agt_1/activity')).toBeGreaterThan(before);
    vi.useRealTimers();
  });
});
