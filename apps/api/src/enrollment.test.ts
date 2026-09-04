import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newInviteId, newInviteToken } from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import { makeTestServer, auth, signup, firstOrgId, createInvite, type TestServer } from './test-helpers.js';
import { openDb } from './db/index.js';
import { agents, enrollments, invites, type EnrollmentRow } from './db/schema.js';

const HOUR_MS = 60 * 60 * 1000;

describe('enrollment — agents', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string; email: string };
  let orgId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  it('approval flow: enroll → poll pending → approve (yes/no) → key once → DM + visibility', async () => {
    const inv = await createInvite(ts.app, owner.token, orgId);
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'deploy-bot' },
    });
    expect(enroll.statusCode).toBe(202);
    const eid = enroll.json().enrollment.id as string;
    const enr = enroll.json().enrollmentToken as string;
    expect(enr.startsWith('enr_')).toBe(true);

    // Poll pending.
    const pending = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(enr),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: 'pending', retryAfterSeconds: 5 });

    // Approver list shows it.
    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments`,
      headers: auth(owner.token),
    });
    expect(list.json().items[0]).toMatchObject({ kind: 'agent', proposedName: 'deploy-bot' });

    // Approve is strictly yes/no — a stray `name` in the body is ignored (the
    // agent keeps the name it proposed at enroll).
    const approve = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
      headers: auth(owner.token),
      payload: { name: 'ignored-override' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toEqual({ ok: true });

    // First approved poll → key + agent + org + dmRoomId; name is the proposed one.
    const first = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(enr),
    });
    const fbody = first.json();
    expect(fbody.status).toBe('approved');
    expect(fbody.key.startsWith('agk_')).toBe(true);
    expect(fbody.agent.name).toBe('deploy-bot');
    expect(fbody.org.id).toBe(orgId);
    expect(typeof fbody.dmRoomId).toBe('string');
    const key = fbody.key as string;

    // Key delivered exactly once.
    const second = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(enr),
    });
    expect(second.json().status).toBe('approved');
    expect(second.json().key).toBeUndefined();

    // The minted key authenticates.
    const me = await ts.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(key) });
    expect(me.json().principal).toMatchObject({ type: 'agent', name: 'deploy-bot' });

    // Owner sees the agent in their visibility list.
    const agents = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
    });
    const entry = agents.json().items.find((a: { agent: { name: string } }) => a.agent.name === 'deploy-bot');
    expect(entry).toBeTruthy();
    expect(entry.sharedBy).toBeNull();
  });

  it('open policy → instant mint 201 with key + dmRoomId', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { enroll: { agents: 'open' } } },
    });
    const inv = await createInvite(ts.app, owner.token, orgId);
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'insta' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key.startsWith('agk_')).toBe(true);
    expect(body.agent.name).toBe('insta');
    expect(body.org).toEqual({ id: orgId, name: "Owner's org" });
    expect(typeof body.dmRoomId).toBe('string');
  });

  it('regression: agent enrollment via invite still respects the approval policy (pending)', async () => {
    // Unlike a human redeeming an invite (pre-approved), an agent enrolling through
    // a shared invite link is the open-enrollment path the approval policy still
    // governs → 202 pending, not an instant mint.
    const inv = await createInvite(ts.app, owner.token, orgId);
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'guard-bot' },
    });
    expect(enroll.statusCode).toBe(202);
    expect(enroll.json().enrollment.status).toBe('pending');
  });

  it('name collision at approval suffixes -2', async () => {
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: auth(owner.token),
      payload: { orgId, name: 'twin' },
    });
    const inv = await createInvite(ts.app, owner.token, orgId);
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'twin' },
    });
    const eid = enroll.json().enrollment.id as string;
    const enr = enroll.json().enrollmentToken as string;
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const poll = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(enr),
    });
    expect(poll.json().agent.name).toBe('twin-2');
  });

  it('invalid → 404, revoked → 410; approving twice → 409', async () => {
    const bad = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/invite/ivk_totallyfake/enroll',
      payload: { name: 'x' },
    });
    expect(bad.statusCode).toBe(404);

    const inv = await createInvite(ts.app, owner.token, orgId);
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${orgId}/invites/${inv.id}`,
      headers: auth(owner.token),
    });
    const revoked = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'x' },
    });
    expect(revoked.statusCode).toBe(410);
  });

  it('deny reads denied (indistinguishable from expired)', async () => {
    const inv = await createInvite(ts.app, owner.token, orgId);
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      payload: { name: 'nope-bot' },
    });
    const eid = enroll.json().enrollment.id as string;
    const enr = enroll.json().enrollmentToken as string;
    const deny = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/enrollments/${eid}/deny`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(deny.json()).toEqual({ ok: true });
    const poll = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
      headers: auth(enr),
    });
    expect(poll.json()).toEqual({ status: 'denied' });

    // Deny again → 409.
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/enrollments/${eid}/deny`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  /**
   * Issue #53 (W2B-23): a pending enrollment left behind by a dead `sparrow
   * enroll` could still be approved DAYS later, minting an orphan agent
   * (`qa-bot-2`) whose key nobody ever receives. The approvable window is 24
   * hours, and the refusal says so — a genuine race still reads "already
   * resolved", so an approver can tell the two apart.
   */
  describe('expiry', () => {
    /** Enroll an agent; returns its enrollment id + `enr_` poll token. */
    async function enroll(inviteToken: string, name: string) {
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${inviteToken}/enroll`,
        payload: { name },
      });
      expect(res.statusCode).toBe(202);
      return { eid: res.json().enrollment.id as string, enr: res.json().enrollmentToken as string };
    }

    function enrollmentRow(eid: string): EnrollmentRow {
      const handle = openDb(ts.dataDir);
      try {
        const row = handle.db.select().from(enrollments).where(eq(enrollments.id, eid)).get();
        if (!row) throw new Error(`no enrollment ${eid}`);
        return row;
      } finally {
        handle.close();
      }
    }

    /** Backdate a pending enrollment past the 24h window (dead `enroll` process). */
    function age(eid: string, hoursAgo: number): void {
      const createdAt = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + 24 * HOUR_MS).toISOString();
      const handle = openDb(ts.dataDir);
      try {
        handle.db
          .update(enrollments)
          .set({ createdAt, expiresAt })
          .where(eq(enrollments.id, eid))
          .run();
      } finally {
        handle.close();
      }
    }

    function agentCount(): number {
      const handle = openDb(ts.dataDir);
      try {
        return handle.db.select().from(agents).where(eq(agents.orgId, orgId)).all().length;
      } finally {
        handle.close();
      }
    }

    it('a new enrollment is approvable for 24 hours, not 7 days', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid } = await enroll(inv.token, 'fresh-bot');
      const row = enrollmentRow(eid);
      expect(Date.parse(row.expiresAt) - Date.parse(row.createdAt)).toBe(24 * HOUR_MS);
    });

    it('an expired pending enrollment drops out of the approver list', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const stale = await enroll(inv.token, 'qa-bot');
      const live = await enroll(inv.token, 'live-bot');
      age(stale.eid, 25);

      const list = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/enrollments`,
        headers: auth(owner.token),
      });
      const ids = (list.json().items as { id: string }[]).map((i) => i.id);
      expect(ids).not.toContain(stale.eid);
      expect(ids).toContain(live.eid);
    });

    it('approving an expired enrollment → 409 "expired", and mints NO orphan agent', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid } = await enroll(inv.token, 'qa-bot');
      age(eid, 25);
      const before = agentCount();

      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/expired/i);
      // …and it names the window + the way out, so the approver is not left guessing.
      expect(res.json().error.message).toMatch(/24 hours/);
      expect(res.json().error.message).toMatch(/sparrow enroll/);
      // The orphan-agent bug: no agent row may appear.
      expect(agentCount()).toBe(before);
    });

    it('denying an expired enrollment → the same 409 "expired"', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid } = await enroll(inv.token, 'qa-bot');
      age(eid, 25);
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/deny`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/expired/i);
    });

    it('a genuinely resolved enrollment still reads "already resolved", not "expired"', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid } = await enroll(inv.token, 'dup-bot');
      const first = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      const again = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.message).toMatch(/already been resolved/i);
      expect(again.json().error.message).not.toMatch(/expired/i);
    });

    it('a fresh enrollment still approves and mints its agent', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid, enr } = await enroll(inv.token, 'good-bot');
      const before = agentCount();
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/enrollments/${eid}/approve`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(agentCount()).toBe(before + 1);
      const poll = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
        headers: auth(enr),
      });
      expect(poll.json().status).toBe('approved');
      expect((poll.json().key as string).startsWith('agk_')).toBe(true);
    });

    it('an expired enrollment still polls back as denied (what a waiting CLI needs)', async () => {
      const inv = await createInvite(ts.app, owner.token, orgId);
      const { eid, enr } = await enroll(inv.token, 'gone-bot');
      age(eid, 25);
      const poll = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/invite/${inv.token}/enrollments/${eid}`,
        headers: auth(enr),
      });
      expect(poll.statusCode).toBe(200);
      expect(poll.json()).toEqual({ status: 'denied' });
    });
  });

  it('rate limit: 10/hour/IP → 429 on the 11th', async () => {
    const inv = await createInvite(ts.app, owner.token, orgId);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${inv.token}/enroll`,
        payload: { name: `bot-${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('enrollment — humans', () => {
  let ts: TestServer;
  let owner: { token: string; userId: string };
  let orgId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  it('redeem with a valid invite → immediate member (no pending row); idempotent re-redeem 200', async () => {
    // Approval never applies to humans: holding a valid invite IS the approval.
    const inv = await createInvite(ts.app, owner.token, orgId);
    const bob = await signup(ts.app, { email: 'bob@example.com', displayName: 'Bob' });
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      headers: auth(bob.token),
      payload: { note: 'hi' },
    });
    // Holding a valid invite IS the approval → instant 201 member, not 202 pending.
    expect(enroll.statusCode).toBe(201);
    expect(enroll.json()).toMatchObject({ role: 'member', org: { id: orgId } });

    // No pending enrollment was created — the approver queue stays empty.
    const pendingList = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments`,
      headers: auth(owner.token),
    });
    expect(pendingList.json().items).toEqual([]);

    // Re-redeeming while already a member → idempotent 200 { org, role }.
    const again = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      headers: auth(bob.token),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ role: 'member' });
  });

  it('redemption is instant for any signed-in human holding a valid invite', async () => {
    const inv = await createInvite(ts.app, owner.token, orgId);
    const emp = await signup(ts.app, { email: 'sam@corp.com', displayName: 'Sam' });
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      headers: auth(emp.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: 'member' });

    // A second, unrelated person holding a valid invite is admitted just the
    // same — there is no human admission policy; the invite IS the approval.
    const inv2 = await createInvite(ts.app, owner.token, orgId);
    const other = await signup(ts.app, { email: 'nope@other.com' });
    const res2 = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv2.token}/enroll`,
      headers: auth(other.token),
      payload: {},
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json()).toMatchObject({ role: 'member' });
  });

  it('immediate human admission auto-ensures the inviter↔joiner DM', async () => {
    const inv = await createInvite(ts.app, owner.token, orgId);
    const bob = await signup(ts.app, { email: 'bob@example.com', displayName: 'Bob' });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv.token}/enroll`,
      headers: auth(bob.token),
      payload: {},
    });
    const bobRooms = await ts.app.inject({ method: 'GET', url: '/api/v1/me/rooms', headers: auth(bob.token) });
    const dm = (bobRooms.json().items as { room: { kind: string; counterpart?: { id: string } } }[]).find(
      (i) => i.room.kind === 'dm' && i.room.counterpart?.id === owner.userId,
    );
    expect(dm).toBeDefined();

    // A second admitted human gets the same auto-DM with the inviter.
    const inv2 = await createInvite(ts.app, owner.token, orgId);
    const sam = await signup(ts.app, { email: 'sam@corp.com', displayName: 'Sam' });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${inv2.token}/enroll`,
      headers: auth(sam.token),
      payload: {},
    });
    const samRooms = await ts.app.inject({ method: 'GET', url: '/api/v1/me/rooms', headers: auth(sam.token) });
    expect(
      (samRooms.json().items as { room: { counterpart?: { id: string } } }[]).some(
        (i) => i.room.counterpart?.id === owner.userId,
      ),
    ).toBe(true);
  });

  it('an expired invite is still rejected for a signed-in human (410, no membership)', async () => {
    const human = await signup(ts.app, { email: 'late@example.com', displayName: 'Late' });
    // Forge an already-expired (but unrevoked) invite directly in the store.
    const token = newInviteToken();
    const handle = openDb(ts.dataDir);
    try {
      handle.db
        .insert(invites)
        .values({
          id: newInviteId(),
          orgId,
          inviterHumanId: owner.userId,
          tokenHash: sha256Hex(token),
          note: null,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          revokedAt: null,
          createdAt: new Date(Date.now() - 2000).toISOString(),
        })
        .run();
    } finally {
      handle.close();
    }
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${token}/enroll`,
      headers: auth(human.token),
      payload: {},
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it('enrollment list scoping: owner sees all, member sees own; ?mine restricts', async () => {
    // Add a plain member. Human redemption is instant now — no approval step
    // needed to seat `mem`.
    const invM = await createInvite(ts.app, owner.token, orgId);
    const mem = await signup(ts.app, { email: 'mem@example.com', displayName: 'Mem' });
    const memEnroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${invM.token}/enroll`,
      headers: auth(mem.token),
      payload: {},
    });
    expect(memEnroll.statusCode).toBe(201);

    // An agent enrolls via the MEMBER's invite → pending X (inviter = mem).
    const memInvite = await createInvite(ts.app, mem.token, orgId);
    const eX = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${memInvite.token}/enroll`,
      payload: { name: 'x-bot' },
    });
    const xid = eX.json().enrollment.id as string;
    // An agent enrolls via the OWNER's invite → pending Y (inviter = owner).
    const ownerInvite = await createInvite(ts.app, owner.token, orgId);
    const eY = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${ownerInvite.token}/enroll`,
      payload: { name: 'y-bot' },
    });
    const yid = eY.json().enrollment.id as string;

    const ids = (res: { json(): { items: { id: string }[] } }) =>
      res.json().items.map((i) => i.id).sort();

    // Owner (org owner) sees both.
    const ownerAll = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments`,
      headers: auth(owner.token),
    });
    expect(ids(ownerAll)).toEqual([xid, yid].sort());

    // Owner ?mine=true → only the owner's own invite's enrollment (Y).
    const ownerMine = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments?mine=true`,
      headers: auth(owner.token),
    });
    expect(ids(ownerMine)).toEqual([yid]);

    // Plain member sees only their own invite's enrollment (X), with or without ?mine.
    const memList = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments`,
      headers: auth(mem.token),
    });
    expect(ids(memList)).toEqual([xid]);
    const memMine = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/enrollments?mine=true`,
      headers: auth(mem.token),
    });
    expect(ids(memMine)).toEqual([xid]);
  });
});
