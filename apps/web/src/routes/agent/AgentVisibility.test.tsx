/**
 * The agent-visibility surfaces of the agent page (SPEC.md, *Agent visibility*): tag chips and the
 * one-line analytics card on Overview, the Access tab (tags, messaging with a
 * reachability preview, who can change this, grants), and the Analytics tab.
 * The real page over a stubbed API, via the shared agent-page harness.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentAnalyticsResponse, AgentAnalyticsWindow, Grant } from '@sparrow-land/sdk/types';
import { json, restoreFetch } from '../../test/apiStub.js';
import { renderAgentPage, type AgentPageOptions } from './testHarness.js';

afterEach(() => restoreFetch());

function grant(principalId: string, scope: string, id = `grt_${principalId}`): Grant {
  return {
    id,
    orgId: 'org_1',
    principalId,
    principalKind: principalId.startsWith('agt_') ? 'agent' : 'human',
    scope,
    grantedBy: 'usr_1',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function other(id: string, name: string, tags: string[], messaging = 'any') {
  return {
    agent: {
      id,
      name,
      orgId: 'org_1',
      online: false,
      lastSeenAt: null,
      tags,
      messaging,
      createdAt: '2026-08-01T00:00:00Z',
    },
    owner: { id: 'usr_9', displayName: 'Otto' },
    sharedBy: { id: 'usr_9', displayName: 'Otto' },
  };
}

const OTHERS = [
  other('agt_2', 'vm7-cubes-reviewer', ['cubes']),
  other('agt_3', 'cubes-tester', ['cubes'], 'tags'),
  other('agt_4', 'docs-writer', ['docs']),
  other('agt_5', 'vm9-chief', []),
];

const ROSTER = [
  { human: { id: 'usr_1', displayName: 'Jake', email: 'jake@acme.com', avatarUrl: null }, role: 'owner', joinedAt: '2026-08-01T00:00:00Z' },
  { human: { id: 'usr_3', displayName: 'Priya Nair', email: 'p@acme.com', avatarUrl: null }, role: 'admin', joinedAt: '2026-08-01T00:00:00Z' },
  { human: { id: 'usr_4', displayName: 'Dana Okafor', email: 'd@acme.com', avatarUrl: null }, role: 'member', joinedAt: '2026-08-01T00:00:00Z' },
  { human: { id: 'usr_9', displayName: 'Otto', email: 'o@acme.com', avatarUrl: null }, role: 'member', joinedAt: '2026-08-01T00:00:00Z' },
];

function analytics(window: AgentAnalyticsWindow): AgentAnalyticsResponse {
  const scale = window === '24h' ? 1 : window === '7d' ? 10 : window === '30d' ? 40 : 100;
  return {
    window,
    from: '2026-09-22T00:00:00Z',
    to: '2026-09-29T00:00:00Z',
    totals: { sent: 23 * scale, received: 18 * scale, tokensSent: 5000 * scale, tokensReceived: 4600 * scale },
    withAgents: { messages: 30 * scale, tokens: 7000 * scale },
    withHumans: { messages: 11 * scale, tokens: 2600 * scale },
    inDms: { messages: 26 * scale, tokens: 6000 * scale },
    inRooms: { messages: 15 * scale, tokens: 3600 * scale },
    counterparts: [
      { kind: 'agent', id: 'agt_3', name: 'cubes-tester', messages: 4 * scale, tokens: 800 * scale },
      { kind: 'agent', id: 'agt_2', name: 'vm7-cubes-reviewer', messages: 18 * scale, tokens: 4100 * scale },
      { kind: 'human', id: 'usr_1', name: 'Jake', messages: 7 * scale, tokens: 1900 * scale },
    ],
    rooms: [{ roomId: 'room_1', name: 'cubes-build', messages: 9 * scale, tokens: 2100 * scale }],
    series: [
      { start: '2026-09-27T00:00:00Z', messages: 12 * scale, tokens: 100 },
      { start: '2026-09-28T00:00:00Z', messages: 29 * scale, tokens: 100 },
    ],
  };
}

interface Stub {
  grants?: Grant[];
  analyticsStatus?: number;
  /** The agent's current tags, echoed on the messaging PUT's agent resource. */
  tags?: string[];
  /** `GET /orgs/:orgId/agents/agt_1` (any member): the agent's current tags/messaging. */
  orgAgent?: { tags: string[]; messaging?: string };
  /** Refuse PUTs / POSTs with this 403 reason. */
  refuse?: string;
  /** `GET /grants` answers 500 from this (1-based) call on. */
  grantsFailFrom?: number;
}

/** Routes for the agent-visibility wire surface (SPEC.md, *Agent visibility*), layered on the harness. */
function visibilityRoutes(stub: Stub = {}): AgentPageOptions['handle'] {
  let grantReads = 0;
  return (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0]!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const refuse = () =>
      json({ error: { code: 'forbidden', message: 'server says no', reason: stub.refuse } }, 403);
    const agentResource = (patch: Record<string, unknown>) =>
      json({
        agent: {
          id: 'agt_1',
          name: 'fable',
          orgId: 'org_1',
          online: true,
          lastSeenAt: null,
          createdAt: '2026-08-01T00:00:00Z',
          ...patch,
        },
      });
    if (path.endsWith('/orgs/org_1/grants') && method === 'GET') {
      grantReads += 1;
      if (stub.grantsFailFrom && grantReads >= stub.grantsFailFrom) {
        return json({ error: { code: 'internal', message: 'boom' } }, 500);
      }
      return json({ items: stub.grants ?? [] });
    }
    if (path.endsWith('/orgs/org_1/grants') && method === 'POST') {
      if (stub.refuse) return refuse();
      return json({ grant: grant(body.principalId, body.scope, 'grt_new') }, 201);
    }
    if (/\/orgs\/org_1\/grants\/[^/]+$/.test(path) && method === 'DELETE') return json({ ok: true });
    if (path.endsWith('/agents/agt_1/tags') && method === 'PUT') {
      if (stub.refuse) return refuse();
      return agentResource({ tags: body.tags });
    }
    if (path.endsWith('/agents/agt_1/messaging') && method === 'PUT') {
      if (stub.refuse) return refuse();
      return agentResource({ tags: stub.tags ?? [], messaging: body.messaging });
    }
    if (path.endsWith('/agents/agt_1/analytics')) {
      if (stub.analyticsStatus) return json({ error: { code: 'not_found', message: 'no' } }, stub.analyticsStatus);
      const w = (new URL(url, 'http://x').searchParams.get('window') ?? '7d') as AgentAnalyticsWindow;
      return json(analytics(w));
    }
    if (path.endsWith('/orgs/org_1/agents/agt_1') && method === 'GET' && stub.orgAgent) {
      return json({
        agent: {
          id: 'agt_1',
          name: 'fable',
          orgId: 'org_1',
          online: true,
          lastSeenAt: null,
          createdAt: '2026-08-01T00:00:00Z',
          messaging: 'any',
          ...stub.orgAgent,
        },
        owner: { id: 'usr_9', displayName: 'Otto' },
      });
    }
    if (path.endsWith('/orgs/org_1/humans')) return json({ items: ROSTER, nextCursor: null });
    if (path.endsWith('/orgs/org_1/agents') && method === 'GET') return json({ items: [] });
    return null;
  };
}

const TEAMMATE = {
  role: 'member' as const,
  owner: { id: 'usr_9', displayName: 'Otto' },
  sharedBy: { id: 'usr_9', displayName: 'Otto' },
};

function puts(rec: { requests: { method: string; url: string; body: unknown }[] }, needle: string) {
  return rec.requests.filter((r) => r.method === 'PUT' && r.url.includes(needle));
}

describe('Overview: tags and the analytics card', () => {
  it('shows tag chips in the header to a teammate without authority, with no tabs and no card', async () => {
    renderAgentPage({
      ...TEAMMATE,
      caps: undefined,
      agent: { tags: ['builders', 'cubes'], roleTitle: 'Builder' },
      handle: visibilityRoutes(),
    });
    await screen.findByRole('heading', { name: 'fable' });
    const tags = await screen.findByRole('list', { name: 'Tags' });
    expect(within(tags).getByText('cubes')).toBeInTheDocument();
    expect(within(tags).getByText('builders')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/view analytics/i)).toBeNull();
  });

  it('owner sees the one-line analytics card that opens the Analytics tab', async () => {
    renderAgentPage({ agent: { tags: ['cubes'] }, handle: visibilityRoutes() });
    expect(await screen.findByText(/410 messages/)).toBeInTheDocument();
    expect(screen.getByText(/~96k tokens this week/)).toBeInTheDocument();
    // The top counterpart by messages, whatever order the wire sent.
    expect(screen.getByText('vm7-cubes-reviewer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /view analytics/i }));
    expect(await screen.findByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  });

  it('card: agent-to-agent is the share of DM traffic with agents, same as the tab', async () => {
    const data = {
      ...analytics('7d'),
      // 400 messages in all, but only 100 in DMs: 60 with agents, 40 with people.
      totals: { sent: 200, received: 200, tokensSent: 1000, tokensReceived: 1000 },
      withAgents: { messages: 60, tokens: 100 },
      withHumans: { messages: 40, tokens: 100 },
    };
    renderAgentPage({
      handle: (url, init) =>
        url.includes('/analytics') ? json(data) : visibilityRoutes()!(url, init),
    });
    expect(await screen.findByText(/60% agent-to-agent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /view analytics/i }));
    expect(await screen.findByText('60%')).toBeInTheDocument();
  });

  it('card: says "mostly in #room" when the top room outweighs the top DM counterpart', async () => {
    const data = {
      ...analytics('7d'),
      counterparts: [{ kind: 'agent' as const, id: 'agt_2', name: 'vm7-cubes-reviewer', messages: 20, tokens: 10 }],
      rooms: [{ roomId: 'room_1', name: 'cubes-build', messages: 90, tokens: 10 }],
    };
    renderAgentPage({
      handle: (url, init) =>
        url.includes('/analytics') ? json(data) : visibilityRoutes()!(url, init),
    });
    const where = await screen.findByText('# cubes-build');
    expect(where.parentElement).toHaveTextContent(/mostly in # cubes-build/);
    expect(screen.queryByText('vm7-cubes-reviewer')).toBeNull();
  });

  it('hides the card when analytics cannot be read', async () => {
    renderAgentPage({ handle: visibilityRoutes({ analyticsStatus: 404 }) });
    await screen.findByRole('tab', { name: 'Overview' });
    await waitFor(() => expect(screen.getByRole('button', { name: /rotate key/i })).toBeInTheDocument());
    expect(screen.queryByText(/view analytics/i)).toBeNull();
  });
});

describe('tab gating per viewer role', () => {
  it('owner: Overview, Access, Analytics, Activity, Email', async () => {
    renderAgentPage({ handle: visibilityRoutes() });
    await screen.findByRole('tab', { name: 'Access' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Access',
      'Analytics',
      'Activity',
      'Email',
    ]);
  });

  it('org admin (not owner) gets Access and Analytics too', async () => {
    renderAgentPage({ ...TEAMMATE, role: 'admin', handle: visibilityRoutes() });
    expect(await screen.findByRole('tab', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('a member holding a covering grant gets Access and Analytics but not Activity or Email', async () => {
    renderAgentPage({
      ...TEAMMATE,
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    await screen.findByRole('tab', { name: 'Access' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Access', 'Analytics']);
  });

  it('a grant for a tag the agent does not carry gives nothing; ?tab=access falls back to Overview', async () => {
    renderAgentPage({
      ...TEAMMATE,
      url: '/org/1/agents/1?tab=access',
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:docs')] }),
    });
    await screen.findByRole('heading', { name: 'fable' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument());
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Messaging' })).toBeNull();
  });
});

describe('Access tab', () => {
  const accessUrl = '/org/1/agents/1?tab=access';

  it('removing a tag PUTs the remaining set', async () => {
    const { rec } = renderAgentPage({
      url: accessUrl,
      agent: { tags: ['builders', 'cubes'] },
      handle: visibilityRoutes(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove tag builders' }));
    await waitFor(() => expect(puts(rec, '/tags')).toHaveLength(1));
    expect(puts(rec, '/tags')[0]!.body).toEqual({ tags: ['cubes'] });
  });

  it('adding a tag PUTs the new set; suggestions come from tags used in the org', async () => {
    const { rec } = renderAgentPage({
      url: accessUrl,
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes(),
    });
    const input = await screen.findByRole('combobox', { name: 'Add a tag' });
    await userEvent.type(input, 'do');
    const option = await screen.findByRole('option', { name: 'docs' });
    await userEvent.click(option);
    await waitFor(() => expect(puts(rec, '/tags')).toHaveLength(1));
    expect(puts(rec, '/tags')[0]!.body).toEqual({ tags: ['cubes', 'docs'] });
    // A typed new tag is normalized.
    await userEvent.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'New Team{Enter}');
    await waitFor(() => expect(puts(rec, '/tags')).toHaveLength(2));
    expect(puts(rec, '/tags')[1]!.body).toEqual({ tags: ['cubes', 'docs', 'new-team'] });
  });

  it('an invalid tag is refused inline without a request', async () => {
    const { rec } = renderAgentPage({ url: accessUrl, handle: visibilityRoutes() });
    await userEvent.type(await screen.findByRole('combobox', { name: 'Add a tag' }), '-nope{Enter}');
    expect(await screen.findByText(/lowercase letters, digits and hyphens/i)).toBeInTheDocument();
    expect(puts(rec, '/tags')).toHaveLength(0);
  });

  it('a 403 renders plain wording inline', async () => {
    renderAgentPage({
      url: accessUrl,
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ refuse: 'outranked' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove tag cubes' }));
    expect(await screen.findByText(/holds access you don.t have/i)).toBeInTheDocument();
  });

  it('messaging: default any; choosing tags PUTs it and the preview names who is reachable and blocked', async () => {
    const { rec } = renderAgentPage({
      url: accessUrl,
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes({ tags: ['cubes'] }),
    });
    const any = await screen.findByRole('radio', { name: /any agent it has met/i });
    expect(any).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /only agents that share a tag/i }));
    await waitFor(() => expect(puts(rec, '/messaging')).toHaveLength(1));
    expect(puts(rec, '/messaging')[0]!.body).toEqual({ messaging: 'tags' });
    const preview = await screen.findByText(/can dm 2 agents/i);
    expect(preview.parentElement).toHaveTextContent('cubes-tester, vm7-cubes-reviewer');
    expect(preview.parentElement).toHaveTextContent(/now blocked:\s*docs-writer, vm9-chief/i);
    expect(screen.getByRole('radio', { name: /only agents that share a tag/i })).toBeChecked();
  });

  it('messaging none previews nobody reachable', async () => {
    renderAgentPage({
      url: accessUrl,
      agent: { tags: ['cubes'], messaging: 'none' },
      others: OTHERS,
      handle: visibilityRoutes(),
    });
    expect(await screen.findByText(/can dm 0 agents/i)).toBeInTheDocument();
  });

  it('who can change this: owner, org admins, and covering grant holders', async () => {
    renderAgentPage({
      url: accessUrl,
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes({
        grants: [grant('agt_5', 'tags:*'), grant('usr_4', 'tag:cubes'), grant('usr_9', 'tag:docs')],
      }),
    });
    const list = await screen.findByRole('list', { name: 'Who can change this' });
    await waitFor(() => expect(within(list).getByText('vm9-chief')).toBeInTheDocument());
    expect(within(list).getByText('Owner')).toBeInTheDocument();
    expect(within(list).getByText('Jake, Priya Nair')).toBeInTheDocument();
    expect(within(list).getByText('Can manage every tag')).toBeInTheDocument();
    expect(within(list).getByText('Dana Okafor')).toBeInTheDocument();
    expect(within(list).getByText('Can manage agents tagged cubes')).toBeInTheDocument();
    // A grant for a tag this agent does not carry is not listed.
    expect(within(list).queryByText('Otto')).toBeNull();
  });

  it('grants this agent holds: none, and no grant form for a non-admin grant holder', async () => {
    renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    expect(await screen.findByRole('heading', { name: 'Grants this agent holds' })).toBeInTheDocument();
    expect(screen.getByText(/fable can.t change other agents/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /grant access/i })).toBeNull();
  });

  it('admin grant form: one tag grants tag:<slug>; every tag shows the warning and grants tags:*', async () => {
    const { rec } = renderAgentPage({
      url: accessUrl,
      role: 'admin',
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes(),
    });
    await userEvent.click(await screen.findByRole('button', { name: /grant access/i }));
    expect(screen.getByText('Grant fable access to…')).toBeInTheDocument();
    // One tag (default) → no warning.
    expect(screen.queryByText(/re-tag and silence any agent/i)).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tag to grant' }), 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Grant tag:docs' }));
    await waitFor(() => expect(rec.requests.filter((r) => r.method === 'POST' && r.url.includes('/grants'))).toHaveLength(1));
    expect(rec.requests.find((r) => r.method === 'POST')!.body).toEqual({ principalId: 'agt_1', scope: 'tag:docs' });

    await userEvent.click(await screen.findByRole('button', { name: /grant access/i }));
    await userEvent.click(screen.getByRole('radio', { name: /every tag/i }));
    expect(
      screen.getByText('fable will be able to re-tag and silence any agent in the org. It can never change itself.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Grant tags:*' }));
    await waitFor(() => expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(2));
    expect(rec.requests.filter((r) => r.method === 'POST')[1]!.body).toEqual({ principalId: 'agt_1', scope: 'tags:*' });
  });

  it('an admin can revoke a grant the agent holds', async () => {
    const { rec } = renderAgentPage({
      url: accessUrl,
      role: 'admin',
      handle: visibilityRoutes({ grants: [grant('agt_1', 'tags:*', 'grt_chief')] }),
    });
    const held = await screen.findByRole('list', { name: 'Grants this agent holds' });
    expect(within(held).getByText('tags:*')).toBeInTheDocument();
    await userEvent.click(within(held).getByRole('button', { name: /revoke/i }));
    await waitFor(() =>
      expect(rec.requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/grants/grt_chief'))).toBe(true),
    );
  });
});

describe('Analytics tab', () => {
  it('renders tiles, bars, ranked lists and the footnote; the window switch refetches', async () => {
    const { rec } = renderAgentPage({ url: '/org/1/agents/1?tab=analytics', handle: visibilityRoutes() });
    expect(await screen.findByRole('heading', { name: 'Last 7 days' })).toBeInTheDocument();
    expect(await screen.findByText('410')).toBeInTheDocument();
    expect(screen.getByText('230 sent · 180 received')).toBeInTheDocument();
    expect(screen.getByText('~96k')).toBeInTheDocument();
    expect(screen.getByText('73%')).toBeInTheDocument();
    expect(screen.getByText('300 agent · 110 human')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /messages per day/i })).toBeInTheDocument();
    const agents = screen.getByRole('list', { name: 'Agents it talks to' });
    const names = within(agents).getAllByRole('listitem').map((li) => li.querySelector('[data-name]')?.textContent);
    expect(names).toEqual(['vm7-cubes-reviewer', 'cubes-tester']);
    expect(within(screen.getByRole('list', { name: 'People' })).getByText('Jake')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Rooms' })).getByText('# cubes-build')).toBeInTheDocument();
    expect(screen.getByText(/150 messages in rooms, 260 in DMs/)).toBeInTheDocument();
    expect(screen.getByText(/tokens are estimated from message text/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '24h' }));
    expect(await screen.findByRole('heading', { name: 'Last 24 hours' })).toBeInTheDocument();
    expect(await screen.findByText('41')).toBeInTheDocument();
    expect(rec.lastQuery('/analytics')?.get('window')).toBe('24h');
    expect(screen.getByRole('img', { name: /messages per hour/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('heading', { name: 'All time' })).toBeInTheDocument();
    expect(await screen.findByText('4,100')).toBeInTheDocument();
  });

  it('a 403 renders the inline error', async () => {
    renderAgentPage({
      url: '/org/1/agents/1?tab=analytics',
      handle: (url, init) =>
        url.includes('/analytics')
          ? json({ error: { code: 'forbidden', message: 'no', reason: 'grant_required' } }, 403)
          : visibilityRoutes()!(url, init),
    });
    expect(await screen.findByText(/ask an org admin/i)).toBeInTheDocument();
  });
});

describe('non-admin viewers read the agent via GET /orgs/:orgId/agents/:agentId', () => {
  const adminListCalls = (rec: { requests: { url: string }[] }) =>
    rec.requests.filter((r) => /\/orgs\/org_1\/agents(\?|$)/.test(r.url));

  it('a plain member sees the current tags from the org agent read, not the admin list', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      agent: { tags: [] },
      handle: visibilityRoutes({ orgAgent: { tags: ['cubes'] } }),
    });
    const tags = await screen.findByRole('list', { name: 'Tags' });
    expect(within(tags).getByText('cubes')).toBeInTheDocument();
    expect(rec.count('/orgs/org_1/agents/agt_1')).toBeGreaterThan(0);
    expect(adminListCalls(rec)).toHaveLength(0);
  });

  it('a grant holder: authority from the fresh tags, preview among visible agents, no admin-list request', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: '/org/1/agents/1?tab=access',
      // The visibility entry is stale (no tags); the org agent read is current.
      agent: { tags: [] },
      others: OTHERS,
      handle: visibilityRoutes({
        // tag:docs too, so this delegate may ADD docs (a tag:x delegate adds only x).
        grants: [grant('usr_1', 'tag:cubes', 'g_cubes'), grant('usr_1', 'tag:docs', 'g_docs')],
        orgAgent: { tags: ['cubes'], messaging: 'tags' },
      }),
    });
    expect(await screen.findByRole('radio', { name: /only agents that share a tag/i })).toBeChecked();
    const preview = await screen.findByText(/can dm 2 agents among those you can see/i);
    expect(preview.parentElement).toHaveTextContent('cubes-tester, vm7-cubes-reviewer');
    // Suggestions come from the agents this viewer can see.
    await userEvent.type(screen.getByRole('combobox', { name: 'Add a tag' }), 'do');
    expect(await screen.findByRole('option', { name: 'docs' })).toBeInTheDocument();
    expect(adminListCalls(rec)).toHaveLength(0);
  });

  it('an admin keeps the full org list and the unqualified preview', async () => {
    const { rec } = renderAgentPage({
      url: '/org/1/agents/1?tab=access',
      role: 'admin',
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes(),
    });
    expect(await screen.findByText(/^can dm \d+ agents:$/i)).toBeInTheDocument();
    await waitFor(() => expect(adminListCalls(rec).length).toBeGreaterThan(0));
    expect(screen.queryByText(/among those you can see/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Reviewer findings (agent-visibility client half)
 * ------------------------------------------------------------------ */

function by(grantedBy: string, g: Grant): Grant {
  return { ...g, grantedBy };
}

describe('a grant holder over an agent not shared with them (finding 1)', () => {
  /** The visibility list lacks agt_1: only the others are shared with this viewer. */
  const hidden: AgentPageOptions['meAgents'] = () => Promise.resolve(json({ items: OTHERS }));

  it('falls back to GET /orgs/:orgId/agents/:agentId and renders the manageable surface', async () => {
    const { rec } = renderAgentPage({
      role: 'member',
      meAgents: hidden,
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tags:*')], orgAgent: { tags: ['cubes'] } }),
    });
    expect(await screen.findByRole('heading', { name: 'fable' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Access', 'Analytics']);
    expect(screen.getByText(/Owned by Otto/)).toBeInTheDocument();
    expect(screen.getByText(/isn.t shared with you/i)).toBeInTheDocument();
    // Not shared → no DM affordance.
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
    expect(screen.queryByText(/can.t see this agent/i)).toBeNull();
    expect(rec.count('/orgs/org_1/agents/agt_1')).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(await screen.findByRole('heading', { name: 'Messaging' })).toBeInTheDocument();
  });

  it('a member without a covering grant still gets the not-found panel', async () => {
    renderAgentPage({
      role: 'member',
      meAgents: hidden,
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:docs')], orgAgent: { tags: ['cubes'] } }),
    });
    expect(await screen.findByText(/can.t see this agent/i)).toBeInTheDocument();
  });
});

describe('per-tag authority on the Access tab (finding 4)', () => {
  const accessUrl = '/org/1/agents/1?tab=access';

  it('a tag:cubes delegate may remove cubes but not docs, and has no free-form add box', async () => {
    renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes', 'docs'] },
      others: OTHERS,
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    expect(await screen.findByRole('button', { name: 'Remove tag cubes' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Remove tag docs' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Add a tag' })).toBeNull();
    expect(screen.getByText(/you can change only the cubes tag/i)).toBeInTheDocument();
  });

  it('a delegate holding tag:cubes and tag:ops may add only ops; other tags are refused without a request', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes', 'g1'), grant('usr_1', 'tag:ops', 'g2')] }),
    });
    const input = await screen.findByRole('combobox', { name: 'Add a tag' });
    await userEvent.click(input);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['ops']);
    await userEvent.type(input, 'docs{Enter}');
    expect(await screen.findByText(/you can only add ops/i)).toBeInTheDocument();
    expect(puts(rec, '/tags')).toHaveLength(0);
  });

  it('outranked: the agent holds a grant the viewer lacks, so no tabs and ?tab=access falls back', async () => {
    renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes'), grant('agt_1', 'tag:ops')] }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument());
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Messaging' })).toBeNull();
  });

  it('removing the tag that is the delegate’s only authority asks first, then lands on Overview with a notice', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes', 'docs'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove tag cubes' }));
    expect(await screen.findByText(/you.ll lose access to this agent/i)).toBeInTheDocument();
    expect(puts(rec, '/tags')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Remove cubes and lose access' }));
    await waitFor(() => expect(puts(rec, '/tags')).toHaveLength(1));
    expect(puts(rec, '/tags')[0]!.body).toEqual({ tags: ['docs'] });
    expect(await screen.findByRole('status')).toHaveTextContent(/you no longer manage fable/i);
    expect(screen.queryByRole('tab', { name: 'Access' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Messaging' })).toBeNull();
  });

  it('cancelling the confirmation sends nothing', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: accessUrl,
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove tag cubes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/lose access to this agent/i)).toBeNull();
    expect(puts(rec, '/tags')).toHaveLength(0);
  });
});

describe('grants reload failure (finding 5)', () => {
  it('keeps the previous list and shows an inline error', async () => {
    renderAgentPage({
      url: '/org/1/agents/1?tab=access',
      role: 'admin',
      handle: visibilityRoutes({ grants: [grant('agt_1', 'tags:*', 'grt_chief')], grantsFailFrom: 2 }),
    });
    const held = await screen.findByRole('list', { name: 'Grants this agent holds' });
    await userEvent.click(within(held).getByRole('button', { name: /revoke/i }));
    expect(await screen.findByText(/couldn.t refresh the grants/i)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Grants this agent holds' })).getByText('tags:*')).toBeInTheDocument();
  });
});

describe('who may revoke (finding 6)', () => {
  it('the grant’s creator may revoke it and a holder may give up their own grant', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: '/org/1/agents/1?tab=access',
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({
        grants: [
          by('usr_3', grant('usr_1', 'tags:*', 'grt_mine')),
          by('usr_1', grant('usr_4', 'tag:cubes', 'grt_dana')),
          by('usr_3', grant('usr_9', 'tag:cubes', 'grt_otto')),
        ],
      }),
    });
    const list = await screen.findByRole('list', { name: 'Who can change this' });
    await waitFor(() => expect(within(list).getByText('Dana Okafor')).toBeInTheDocument());
    // Created by me → Revoke; someone else's creation → nothing.
    expect(within(list).getByRole('button', { name: 'Revoke tag:cubes from Dana Okafor' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /from Otto/ })).toBeNull();
    // My own grant → Give up (and it is my only authority here, so it asks first).
    await userEvent.click(within(list).getByRole('button', { name: 'Give up tags:*' }));
    expect(await screen.findByText(/you.ll lose access to this agent/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Give up and lose access' }));
    await waitFor(() =>
      expect(rec.requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/grants/grt_mine'))).toBe(true),
    );
  });
});

describe('a tags:* holder who is not an admin can grant tag:<slug> (follow-up)', () => {
  it('shows a grant form limited to one tag', async () => {
    const { rec } = renderAgentPage({
      ...TEAMMATE,
      url: '/org/1/agents/1?tab=access',
      agent: { tags: ['cubes'] },
      others: OTHERS,
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tags:*')] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: /grant access/i }));
    expect(screen.queryByRole('radio', { name: /every tag/i })).toBeNull();
    expect(screen.getByText(/only org owners and admins can grant tags:\*/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tag to grant' }), 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Grant tag:docs' }));
    await waitFor(() => expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(1));
    expect(rec.requests.find((r) => r.method === 'POST')!.body).toEqual({ principalId: 'agt_1', scope: 'tag:docs' });
  });

  it('a tag:x holder gets no grant form', async () => {
    renderAgentPage({
      ...TEAMMATE,
      url: '/org/1/agents/1?tab=access',
      agent: { tags: ['cubes'] },
      handle: visibilityRoutes({ grants: [grant('usr_1', 'tag:cubes')] }),
    });
    await screen.findByRole('heading', { name: 'Grants this agent holds' });
    expect(screen.queryByRole('button', { name: /grant access/i })).toBeNull();
  });
});

describe('two quick edits (finding 8)', () => {
  /** Once armed, hold every `/me/agents` reload until the test releases it. */
  function heldReloads() {
    const pending: { resolve: (r: Response) => void; entry: Record<string, unknown> }[] = [];
    const state = { armed: false };
    const meAgents: AgentPageOptions['meAgents'] = (_n, entry) => {
      if (!state.armed) return null;
      return new Promise<Response>((resolve) => pending.push({ resolve, entry }));
    };
    const release = async (i: number, messaging: string) => {
      const p = pending[i]!;
      await act(async () => {
        p.resolve(json({ items: [{ ...p.entry, agent: { ...(p.entry.agent as object), messaging } }] }));
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    return {
      meAgents,
      pending,
      release,
      arm: () => {
        state.armed = true;
      },
    };
  }
  const radio = (name: RegExp) => screen.getByRole('radio', { name });

  it('a first reload answering after a second edit does not show stale messaging', async () => {
    const h = heldReloads();
    const { rec } = renderAgentPage({ url: '/org/1/agents/1?tab=access', meAgents: h.meAgents, handle: visibilityRoutes() });
    const tagsRadio = await screen.findByRole('radio', { name: /only agents that share a tag/i });
    h.arm();
    await userEvent.click(tagsRadio);
    await waitFor(() => expect(puts(rec, '/messaging')).toHaveLength(1));
    await waitFor(() => expect(radio(/only agents that share a tag/i)).toBeChecked());
    await userEvent.click(radio(/no agent dms/i));
    await waitFor(() => expect(puts(rec, '/messaging')).toHaveLength(2));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    // Reload 1 lands (state after edit 1 only): edit 2 must still show.
    await h.release(0, 'tags');
    expect(radio(/no agent dms/i)).toBeChecked();
    await h.release(1, 'none');
    expect(radio(/no agent dms/i)).toBeChecked();
  });

  it('a stale reload answering LAST never overwrites the newer state', async () => {
    const h = heldReloads();
    const { rec } = renderAgentPage({ url: '/org/1/agents/1?tab=access', meAgents: h.meAgents, handle: visibilityRoutes() });
    const tagsRadio = await screen.findByRole('radio', { name: /only agents that share a tag/i });
    h.arm();
    await userEvent.click(tagsRadio);
    await waitFor(() => expect(puts(rec, '/messaging')).toHaveLength(1));
    await waitFor(() => expect(radio(/only agents that share a tag/i)).toBeChecked());
    await userEvent.click(radio(/no agent dms/i));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    await h.release(1, 'none');
    expect(radio(/no agent dms/i)).toBeChecked();
    await h.release(0, 'tags');
    expect(radio(/no agent dms/i)).toBeChecked();
  });
});

describe('tag combobox keyboard and ARIA (finding 9)', () => {
  const TAGGED = [
    other('agt_2', 'a', ['alpha']),
    other('agt_3', 'b', ['beta']),
    other('agt_4', 'c', ['gamma']),
  ];

  it('arrows move the active option, Enter selects it, Escape closes', async () => {
    const { rec } = renderAgentPage({
      url: '/org/1/agents/1?tab=access',
      agent: { tags: [] },
      others: TAGGED,
      handle: visibilityRoutes(),
    });
    const input = await screen.findByRole('combobox', { name: 'Add a tag' });
    await userEvent.click(input);
    await screen.findByRole('listbox');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{ArrowDown}');
    let opts = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', opts[0]!.id);
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(opts[1]).toHaveAttribute('aria-selected', 'false');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    opts = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', opts[2]!.id); // clamps at the end
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{ArrowDown}');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(puts(rec, '/tags')).toHaveLength(1));
    expect(puts(rec, '/tags')[0]!.body).toEqual({ tags: ['beta'] });
  });
});

describe('analytics chart and wording (findings 2, 3, follow-up)', () => {
  const url = '/org/1/agents/1?tab=analytics';
  function withSeries(series: { start: string; messages: number; tokens: number }[], extra: object = {}) {
    return (u: string, init: RequestInit | undefined) =>
      u.includes('/analytics') ? json({ ...analytics('7d'), ...extra, series }) : visibilityRoutes()!(u, init);
  }
  const day = (i: number, messages = 1) => ({
    start: new Date(Date.UTC(2026, 8, 29) - i * 86_400_000).toISOString(),
    messages,
    tokens: 1,
  });

  it('a year of days renders at most 31 bars (monthly), never one per day', async () => {
    const series = Array.from({ length: 366 }, (_, i) => day(365 - i));
    renderAgentPage({ url, handle: withSeries(series) });
    const chart = await screen.findByRole('img', { name: /messages per month/i });
    const bars = chart.querySelectorAll('[data-bar]');
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThanOrEqual(31);
  });

  it('per-bar counts are compact (12k, not 12,345)', async () => {
    const series = Array.from({ length: 7 }, (_, i) => day(6 - i, 12_345));
    renderAgentPage({ url, handle: withSeries(series) });
    const chart = await screen.findByRole('img', { name: /messages per day/i });
    expect(within(chart).getAllByText('12k')).toHaveLength(7);
    expect(within(chart).queryByText('12,345')).toBeNull();
  });

  describe('in Los Angeles', () => {
    const tz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'America/Los_Angeles';
    });
    afterEach(() => {
      process.env.TZ = tz;
    });
    it('daily labels are the UTC day of the bucket', async () => {
      // 2026-09-27 (UTC) is a Sunday; local LA time would call it Saturday.
      renderAgentPage({ url, handle: withSeries([day(2), day(1), day(0)]) });
      const chart = await screen.findByRole('img', { name: /messages per day/i });
      expect(within(chart).getByText('Sun')).toBeInTheDocument();
      expect(within(chart).queryByText('Sat')).toBeNull();
    });
  });

  it('counts are pluralized: 1 message', async () => {
    const one = { messages: 1, tokens: 4 };
    const extra = {
      totals: { sent: 1, received: 0, tokensSent: 4, tokensReceived: 0 },
      inRooms: one,
      inDms: { messages: 0, tokens: 0 },
    };
    renderAgentPage({ handle: withSeries([day(1), day(0)], extra) });
    expect(await screen.findByText(/^1 message · ~4 tokens this week$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /view analytics/i }));
    expect(await screen.findByText(/1 message in rooms, 0 in DMs/)).toBeInTheDocument();
  });
});
