/**
 * The agent-visibility surfaces of the agent page (SPEC.md, *Agent visibility*): tag chips and the
 * one-line analytics card on Overview, the Access tab (tags, messaging with a
 * reachability preview, who can change this, grants), and the Analytics tab.
 * The real page over a stubbed API, via the shared agent-page harness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
}

/** Routes for the agent-visibility wire surface (SPEC.md, *Agent visibility*), layered on the harness. */
function visibilityRoutes(stub: Stub = {}): AgentPageOptions['handle'] {
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
    if (path.endsWith('/orgs/org_1/grants') && method === 'GET') return json({ items: stub.grants ?? [] });
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
        grants: [grant('usr_1', 'tag:cubes')],
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
