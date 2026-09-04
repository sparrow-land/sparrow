import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hint } from '@sparrow/common-types';
import type { FastifyInstance } from 'fastify';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  shareAgent,
  listen,
  openSse,
  sleep,
  type TestServer,
} from './test-helpers.js';

/**
 * Agent roles — a per-agent `roleTitle` (org-visible) + `roleInstructions`
 * (private to the owner and the agent itself) + `roleUpdatedAt`. This pins the
 * write paths (self via PATCH /me, owner via PATCH /me/agents/:id), the privacy
 * shapes (who may read the instructions), the `role.updated` nudge (journaled +
 * live + replayed), and the `refresh-your-role` hint's per-`roleUpdatedAt` re-arm.
 */
describe('agent roles', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string };
  let orgId: string;
  let agent: { id: string; key: string };

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Olive' });
    orgId = await firstOrgId(ts.app, owner.token);
    agent = await makeAgent(ts.app, owner.token, orgId, 'deploy-bot');
  });
  afterEach(async () => {
    await ts.close();
  });

  const inject = (method: string, url: string, key: string, payload?: unknown) =>
    ts.app.inject({ method: method as 'GET', url, headers: auth(key), payload: payload as object });

  const meOf = async (key: string) => (await inject('GET', '/api/v1/me', key)).json().principal;
  const listFor = async (token: string) => {
    const res = await inject('GET', `/api/v1/orgs/${orgId}/me/agents`, token);
    return (res.json().items as Array<Record<string, unknown>>).find(
      (a) => (a.agent as { id: string }).id === agent.id,
    )!;
  };

  /* ------------------------------- write paths ------------------------- */

  it('an agent self-sets its role via PATCH /me (200); GET /me carries both halves', async () => {
    const res = await inject('PATCH', '/api/v1/me', agent.key, {
      roleTitle: '  Support triage  ',
      roleInstructions: '# Job\n\nAnswer support DMs promptly.',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal.roleTitle).toBe('Support triage'); // trimmed
    const me = await meOf(agent.key);
    expect(me.roleTitle).toBe('Support triage');
    expect(me.roleInstructions).toBe('# Job\n\nAnswer support DMs promptly.');
    expect(typeof me.roleUpdatedAt).toBe('string');
  });

  it('the owner sets an agent role via PATCH /me/agents/:id (200)', async () => {
    const res = await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, {
      roleTitle: 'Ops lead',
      roleInstructions: 'own the deploy pipeline',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.roleTitle).toBe('Ops lead');
    // The agent sees the owner-set role on its own GET /me.
    const me = await meOf(agent.key);
    expect(me.roleTitle).toBe('Ops lead');
    expect(me.roleInstructions).toBe('own the deploy pipeline');
  });

  it('a non-owner human cannot set the role (403); another agent cannot (401)', async () => {
    const other = await joinOrg(ts.app, owner.token, orgId, 'other@ex.com', 'Otto');
    const sibling = await makeAgent(ts.app, owner.token, orgId, 'sibling');
    expect(
      (await inject('PATCH', `/api/v1/me/agents/${agent.id}`, other.token, { roleTitle: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await inject('PATCH', `/api/v1/me/agents/${agent.id}`, sibling.key, { roleTitle: 'x' })).statusCode,
    ).toBe(401);
    // Unchanged.
    expect((await meOf(agent.key)).roleTitle).toBeNull();
  });

  it('clears the role with null; a no-op change does not bump roleUpdatedAt', async () => {
    await inject('PATCH', '/api/v1/me', agent.key, { roleTitle: 'Ops', roleInstructions: 'do X' });
    const first = (await meOf(agent.key)).roleUpdatedAt as string;
    // Re-set to the SAME values → no change → timestamp unchanged.
    await sleep(2);
    await inject('PATCH', '/api/v1/me', agent.key, { roleTitle: 'Ops', roleInstructions: 'do X' });
    expect((await meOf(agent.key)).roleUpdatedAt).toBe(first);
    // Clear both halves with null.
    const cleared = await inject('PATCH', '/api/v1/me', agent.key, {
      roleTitle: null,
      roleInstructions: null,
    });
    expect(cleared.json().principal.roleTitle).toBeNull();
    const me = await meOf(agent.key);
    expect(me.roleTitle).toBeNull();
    expect(me.roleInstructions).toBeNull();
  });

  /* ------------------------------- validation -------------------------- */

  it('rejects an over-long title (400) and over-long instructions (400)', async () => {
    expect(
      (await inject('PATCH', '/api/v1/me', agent.key, { roleTitle: 'x'.repeat(61) })).statusCode,
    ).toBe(400);
    expect(
      (await inject('PATCH', '/api/v1/me', agent.key, { roleInstructions: 'x'.repeat(16 * 1024 + 1) }))
        .statusCode,
    ).toBe(400);
    // Empty body (no fields at all) → 400.
    expect((await inject('PATCH', '/api/v1/me', agent.key, {})).statusCode).toBe(400);
  });

  /* ------------------------------- privacy shapes ---------------------- */

  it('org agents list: non-owner sees the title, never the instructions', async () => {
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, {
      roleTitle: 'Ops lead',
      roleInstructions: 'SECRET playbook',
    });
    // Share so a peer can see the agent in their list at all, in `org` mode.
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { sharing: 'org' });
    const peer = await joinOrg(ts.app, owner.token, orgId, 'peer@ex.com', 'Pat');

    const ownerEntry = await listFor(owner.token);
    expect((ownerEntry.agent as { roleTitle: string }).roleTitle).toBe('Ops lead');
    expect(ownerEntry.roleInstructions).toBe('SECRET playbook'); // owner-only

    const peerEntry = await listFor(peer.token);
    expect((peerEntry.agent as { roleTitle: string }).roleTitle).toBe('Ops lead'); // title is org-visible
    expect(peerEntry.roleInstructions).toBeNull(); // instructions private
    expect(JSON.stringify(peerEntry)).not.toContain('SECRET');
  });

  it('agent.shared payload carries the title but never the instructions', async () => {
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, {
      roleTitle: 'Ops',
      roleInstructions: 'SECRET',
    });
    const grantee = await joinOrg(ts.app, owner.token, orgId, 'g@ex.com', 'Gray');
    const base = await listen(ts);
    const sse = await openSse(base, '/api/v1/me/events', grantee.token);
    try {
      await shareAgent(ts.app, owner.token, agent.id, grantee.userId);
      const ev = await sse.waitFor((e) => e.event === 'agent.shared');
      const data = ev.data as { agent: { roleTitle: string } };
      expect(data.agent.roleTitle).toBe('Ops');
      expect(ev.raw).not.toContain('SECRET');
    } finally {
      sse.close();
    }
  });

  /* ------------------------------- role.updated event ------------------ */

  it('role.updated is live on the agent stream + journaled for replay; never carries instructions', async () => {
    const base = await listen(ts);
    const sse = await openSse(base, '/api/v1/me/events', agent.key);
    try {
      await inject('PATCH', '/api/v1/me', agent.key, {
        roleTitle: 'Ops',
        roleInstructions: 'SECRET body',
      });
      const ev = await sse.waitFor((e) => e.event === 'role.updated');
      const data = ev.data as { roleTitle: string; roleUpdatedAt: string };
      expect(data.roleTitle).toBe('Ops');
      expect(typeof data.roleUpdatedAt).toBe('string');
      expect(ev.raw).not.toContain('SECRET'); // instructions never on the wire
    } finally {
      sse.close();
    }
    // Replay via the journal log (?since=0) reproduces the same event.
    const log = await inject('GET', '/api/v1/me/events/log?since=0', agent.key);
    const events = log.json().events as Array<{ event: string; data: { roleTitle: string } }>;
    const replayed = events.find((e) => e.event === 'role.updated');
    expect(replayed?.data.roleTitle).toBe('Ops');
    expect(JSON.stringify(events)).not.toContain('SECRET body');
  });

  it('role.updated fans out to every human who can SEE the agent (with agentId), and to no one else', async () => {
    const peer = await joinOrg(ts.app, owner.token, orgId, 'peer@ex.com', 'Pat');
    const roleEventsFor = async (token: string) => {
      const log = await inject('GET', '/api/v1/me/events/log?since=0', token);
      return (log.json().events as Array<{ event: string; data: Record<string, unknown> }>).filter(
        (e) => e.event === 'role.updated',
      );
    };

    // Default `selected` sharing: only the owner can see the agent.
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, {
      roleTitle: 'Ops',
      roleInstructions: 'SECRET body',
    });
    const ownerEvents = await roleEventsFor(owner.token);
    expect(ownerEvents).toHaveLength(1);
    expect(ownerEvents[0]!.data.agentId).toBe(agent.id);
    expect(ownerEvents[0]!.data.roleTitle).toBe('Ops');
    expect(JSON.stringify(ownerEvents)).not.toContain('SECRET'); // never the instructions
    expect(await roleEventsFor(peer.token)).toHaveLength(0); // peer cannot see the agent

    // Widen to `org`: the next change reaches the peer too.
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { sharing: 'org' });
    await sleep(2);
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { roleTitle: 'Ops v2' });
    const peerEvents = await roleEventsFor(peer.token);
    expect(peerEvents).toHaveLength(1);
    expect(peerEvents[0]!.data.agentId).toBe(agent.id);
    expect(peerEvents[0]!.data.roleTitle).toBe('Ops v2');

    // The agent's own copy carries the agentId too (one shape on the wire).
    const agentEvents = await roleEventsFor(agent.key);
    expect(agentEvents.map((e) => e.data.agentId)).toEqual([agent.id, agent.id]);
  });

  /* ------------------------------- hint re-arm ------------------------- */

  it('refresh-your-role fires once per roleUpdatedAt and re-arms when the role changes', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'ops');
    await inject('POST', `/api/v1/rooms/${roomId}/members`, owner.token, { principal: agent.id });
    // Suppress the higher-priority triggers (set-a-status, start-listening).
    await inject('POST', '/api/v1/me/presence', agent.key, { ttlSeconds: 120 });
    await inject('POST', `/api/v1/rooms/${roomId}/status`, agent.key, { state: 'working', note: 'busy' });

    // Hints land at the PAUSE — an empty `POST /me/inbox/pop`, never on a send
    // or on a pop that returns work. This agent's inbox is empty throughout, so
    // each pop below is that pause.
    const pause = async (): Promise<Hint[]> => {
      const res = await inject('POST', '/api/v1/me/inbox/pop', agent.key, {});
      if (res.statusCode !== 200) throw new Error(`pop failed: ${res.body}`);
      expect(res.json().item).toBeNull();
      return (res.json().hints ?? []) as Hint[];
    };
    const hasRefresh = (hints: Hint[]) => hints.some((h) => h.id === 'refresh-your-role');

    // No role yet → no refresh hint.
    expect(hasRefresh(await pause())).toBe(false);

    // Owner sets a role → the next pause nudges a re-read.
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { roleTitle: 'Ops' });
    expect(hasRefresh(await pause())).toBe(true);
    // Same roleUpdatedAt → cooldown holds, no repeat.
    expect(hasRefresh(await pause())).toBe(false);

    // Role changes again (distinct timestamp) → the hint re-arms and fires.
    await sleep(2);
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { roleTitle: 'Ops v2' });
    expect(hasRefresh(await pause())).toBe(true);
    expect(hasRefresh(await pause())).toBe(false);

    // Meta-hint sanity: role churn collapses to ONE delivered hint, so the
    // control-your-hints meta-hint (threshold 3) has not been tripped by it.
    await sleep(2);
    await inject('PATCH', `/api/v1/me/agents/${agent.id}`, owner.token, { roleTitle: 'Ops v3' });
    const hints = await pause();
    expect(hits(hints, 'control-your-hints')).toBe(false);
  });
});

function hits(hints: Hint[], id: string): boolean {
  return hints.some((h) => h.id === id);
}
