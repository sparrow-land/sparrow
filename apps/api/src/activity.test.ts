/**
 * Unified attention (layer 3) — the activity timeline (SPEC v4 "Unified
 * attention → The activity timeline / Entry types registry / Activity routes").
 *
 * The timeline is an append-only record, never a mailbox: entries are typed refs
 * with a frozen `actor_label`, read per agent or per principal, and reading one
 * writes nothing. v4 wave 2 ships the chat writer (`chat.message`) and both read
 * routes; the email writers land with the email medium.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  TEST_ADMIN_TOKEN,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

interface WireEntry {
  id: string;
  orgId: string;
  medium: string;
  type: string;
  agent: { id: string; name: string } | null;
  actor: { kind: string; id: string | null; displayName: string };
  summary: string | null;
  refs: { roomId?: string; messageId?: string; emailThreadId?: string; emailId?: string };
  createdAt: string;
}

describe('activity timeline (layer 3)', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  let bot: { id: string; key: string };
  const open: SseClient[] = [];

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  /** Attach an agent to a room (owner acts). */
  async function attachAgent(room: string, agentId: string): Promise<void> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/members`,
      headers: auth(owner.token),
      payload: { principal: agentId },
    });
    if (res.statusCode !== 201) throw new Error(`attach failed (${res.statusCode}): ${res.body}`);
  }

  /** Invite + accept a human into a room. */
  async function addHuman(room: string, human: SignedUpHuman): Promise<void> {
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/invitations`,
      headers: auth(owner.token),
      payload: { human: human.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(human.token),
    });
  }

  async function send(room: string, token: string, body: string, subject?: string): Promise<string> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/messages`,
      // Belt-and-braces: sends no longer carry hints at all (teaching happens at
      // the PAUSE — an empty `me/inbox/pop`), but a fired hint would journal its
      // own `hint.delivered` entry and this suite pins the CHAT medium's writes
      // in isolation.
      headers: { ...auth(token), 'x-sparrow-no-hints': '1' },
      payload: subject ? { body, subject } : { body },
    });
    if (res.statusCode !== 201) throw new Error(`send failed (${res.statusCode}): ${res.body}`);
    return res.json().message.id as string;
  }

  async function activity(token: string, qs = ''): Promise<{ items: WireEntry[]; nextBefore: string | null }> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/activity${qs}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  beforeEach(async () => {
    ts = await makeTestServer({ presenceGraceSeconds: 30 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await attachAgent(roomId, bot.id);
    await addHuman(roomId, alice);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  it('a chat message in a room with an agent appends one chat.message entry per involved agent', async () => {
    const messageId = await send(roomId, owner.token, 'ship it', 'Deploy');

    const mine = await activity(owner.token);
    expect(mine.items).toHaveLength(1);
    const entry = mine.items[0]!;
    expect(entry.id.startsWith('act_')).toBe(true);
    expect(entry.orgId).toBe(orgId);
    expect(entry.medium).toBe('chat');
    expect(entry.type).toBe('chat.message');
    expect(entry.agent).toEqual({ id: bot.id, name: 'bot' });
    expect(entry.actor).toEqual({ kind: 'human', id: owner.userId, displayName: 'Owner' });
    // summary is the subject when present (else the first line) — a list renders
    // without a medium fetch.
    expect(entry.summary).toBe('Deploy');
    expect(entry.refs).toEqual({ roomId, messageId });
    // Refs only, never a payload.
    expect(JSON.stringify(entry)).not.toContain('ship it');
  });

  it('fans out one entry per involved agent, and writes nothing for a human↔human room', async () => {
    const second = await makeAgent(ts.app, owner.token, orgId, 'bot2');
    await attachAgent(roomId, second.id);
    await send(roomId, owner.token, 'broadcast');

    const mine = await activity(owner.token);
    expect(mine.items.map((i) => i.agent?.id).sort()).toEqual([bot.id, second.id].sort());

    // A room with no agent member journals nothing — the timeline is not a message log.
    const humansOnly = await createRoom(ts.app, owner.token, orgId, 'humans-only');
    await addHuman(humansOnly, alice);
    await send(humansOnly, owner.token, 'no agents here');
    const after = await activity(owner.token);
    expect(after.items).toHaveLength(2);
  });

  it('an agent sending is its own involved agent (actor = the agent)', async () => {
    await send(roomId, bot.key, 'reporting in');
    const asAgent = await activity(bot.key);
    expect(asAgent.items).toHaveLength(1);
    expect(asAgent.items[0]!.agent).toEqual({ id: bot.id, name: 'bot' });
    expect(asAgent.items[0]!.actor).toEqual({ kind: 'agent', id: bot.id, displayName: 'bot' });
  });

  it('GET /me/activity: agent sees its own; owner sees agents they own; actor sees their own acts', async () => {
    await send(roomId, alice.token, 'from alice');

    // The agent: its own entries.
    const agentView = await activity(bot.key);
    expect(agentView.items).toHaveLength(1);
    expect(agentView.items[0]!.agent!.id).toBe(bot.id);

    // The owner: entries on agents they own (they were not the actor here).
    const ownerView = await activity(owner.token);
    expect(ownerView.items).toHaveLength(1);

    // Alice: not the owner, but she IS the actor.
    const aliceView = await activity(alice.token);
    expect(aliceView.items).toHaveLength(1);
    expect(aliceView.items[0]!.actor.id).toBe(alice.userId);
  });

  it('a human who neither owns the agent nor acted sees nothing', async () => {
    await send(roomId, owner.token, 'owner speaking');
    const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    // Bob can even ACCESS the agent — access is not correspondence.
    await shareAgent(ts.app, owner.token, bot.id, bob.userId);
    const bobView = await activity(bob.token);
    expect(bobView.items).toEqual([]);
  });

  it('actor_label is frozen at append time — a later rename does not rewrite history', async () => {
    await send(roomId, alice.token, 'before the rename');
    const rename = await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(alice.token),
      payload: { displayName: 'Alice Renamed' },
    });
    expect(rename.statusCode).toBe(200);
    const view = await activity(owner.token);
    expect(view.items[0]!.actor.displayName).toBe('Alice');
  });

  it('?medium= filters; an unknown medium is bad_request; ?org= scopes', async () => {
    await send(roomId, owner.token, 'one');

    expect((await activity(owner.token, '?medium=chat')).items).toHaveLength(1);
    // The email medium is off, so there are no email entries — but the filter is valid.
    expect((await activity(owner.token, '?medium=email')).items).toEqual([]);
    const bad = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=carrier-pigeon',
      headers: auth(owner.token),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');

    expect((await activity(owner.token, `?org=${orgId}`)).items).toHaveLength(1);
    expect((await activity(owner.token, '?org=org_nope')).items).toEqual([]);
  });

  it('reads backward from now: newest-first, walked with `before`', async () => {
    for (let i = 0; i < 3; i++) await send(roomId, owner.token, `msg ${i}`);
    const first = await activity(owner.token, '?limit=2');
    expect(first.items.map((i) => i.summary)).toEqual(['msg 2', 'msg 1']);
    // `nextBefore` is the OLDEST id returned, fed back as the next `before`.
    expect(first.nextBefore).toBe(first.items[1]!.id);
    const second = await activity(owner.token, `?limit=2&before=${first.nextBefore!}`);
    expect(second.items.map((i) => i.summary)).toEqual(['msg 0']);
    expect(second.nextBefore).toBeNull();
    // The whole window in one page reports no more.
    expect((await activity(owner.token)).nextBefore).toBeNull();
  });

  it('an unknown or foreign `before` is a bad_request — never a silent first page', async () => {
    await send(roomId, owner.token, 'anchor');
    for (const before of ['act_nope', 'not-an-id']) {
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/me/activity?before=${before}`,
        headers: auth(owner.token),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    // An entry id that exists but lies OUTSIDE the caller's scope is invalid too:
    // the anchor is resolved inside the same WHERE the page uses.
    const mine = (await activity(owner.token)).items[0]!;
    const other = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/activity?org=org_nope&before=${mine.id}`,
      headers: auth(owner.token),
    });
    expect(other.statusCode).toBe(400);
  });

  it('reading a timeline writes nothing — the same read repeats verbatim', async () => {
    await send(roomId, owner.token, 'idempotent');
    const a = await activity(owner.token);
    const b = await activity(owner.token);
    expect(b).toEqual(a);
  });

  describe('GET /orgs/:orgId/agents/:agentId/activity', () => {
    async function agentTimeline(token: string | null, agentId = bot.id, org = orgId, admin = false) {
      return ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${org}/agents/${agentId}/activity`,
        headers: admin ? { 'x-admin-token': TEST_ADMIN_TOKEN } : auth(token!),
      });
    }

    beforeEach(async () => {
      await send(roomId, owner.token, 'for the org route');
    });

    it('admits the owner, org owners/admins and the admin token', async () => {
      const asOwner = await agentTimeline(owner.token);
      expect(asOwner.statusCode).toBe(200);
      expect((asOwner.json().items as WireEntry[])).toHaveLength(1);

      // Promote alice to org admin.
      await ts.app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${orgId}/humans/${alice.userId}`,
        headers: auth(owner.token),
        payload: { role: 'admin' },
      });
      expect((await agentTimeline(alice.token)).statusCode).toBe(200);
      expect((await agentTimeline(null, bot.id, orgId, true)).statusCode).toBe(200);
    });

    it('404s (never 403) for a plain org member, even one who can access the agent', async () => {
      const bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
      await shareAgent(ts.app, owner.token, bot.id, bob.userId);
      const res = await agentTimeline(bob.token);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404s for a non-member of the org and for an unknown agent', async () => {
      const outsider = await signup(ts.app, { email: 'out@example.com', displayName: 'Out' });
      expect((await agentTimeline(outsider.token)).statusCode).toBe(404);
      expect((await agentTimeline(owner.token, 'agt_nope')).statusCode).toBe(404);
    });

    it('filters by ?medium= and rejects an unknown one', async () => {
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/agents/${bot.id}/activity?medium=email`,
        headers: auth(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
      const bad = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/agents/${bot.id}/activity?medium=nope`,
        headers: auth(owner.token),
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  it('emits activity.appended to the owning human’s /me/events', async () => {
    const stream = track(await openSse(base, '/api/v1/me/events', owner.token));
    await send(roomId, alice.token, 'wake the owner');
    const frame = await stream.waitFor((e) => e.event === 'activity.appended');
    const entry = (frame.data as { entry: WireEntry }).entry;
    expect(entry.type).toBe('chat.message');
    expect(entry.agent!.id).toBe(bot.id);
    // Journaled like every other /me/events frame (it carries a cursor).
    expect(frame.id).toBeDefined();
  });

  it('deleting an agent takes its timeline with it', async () => {
    await send(roomId, owner.token, 'doomed');
    expect((await activity(owner.token)).items).toHaveLength(1);
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${bot.id}`,
      headers: auth(owner.token),
    });
    expect(del.statusCode).toBe(200);
    expect((await activity(owner.token)).items).toEqual([]);
  });
});
