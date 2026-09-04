/**
 * The medium's six `/me/events` frames and its two retention rules (SPEC v4
 * "Unified attention → `/me/events` in v4"; "The email medium → What a rejected
 * inbound email keeps"; "Hints & docs by convention").
 *
 * Audiences are the point: the two delivery events reach the AGENT, the approval
 * trio fans out to the anchor agent's owner AND the org's owners/admins (so the
 * org-wide approvals list is live for whoever can act on it), and
 * `email.resolved` reaches both plus the agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeEmailServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  makeAgent,
  deliverEmail,
  inboundPayload,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { emailQuarantine, emails } from './db/schema.js';
import { reapRejectedEmails } from './email/store.js';

describe('the email medium’s events and retention', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let admin: SignedUpHuman;
  let member: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };

  const at = (name: string): string => `${name}@${slug}.example.com`;

  /** Every journaled event name for one principal. */
  async function events(token: string): Promise<{ event: string; data: any }[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/events/log?since=0',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().events as { event: string; data: any }[];
  }

  async function setPolicy(policy: Record<string, unknown>): Promise<void> {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: policy } },
    });
  }

  beforeEach(async () => {
    ts = await makeEmailServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    slug = org.json().org.slug as string;
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
    admin = await joinOrg(ts.app, owner.token, orgId, 'admin@example.com', 'Admin');
    member = await joinOrg(ts.app, owner.token, orgId, 'member@example.com', 'Member');
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${admin.userId}`,
      headers: auth(owner.token),
      payload: { role: 'admin' },
    });
  });
  afterEach(async () => {
    await ts.close();
  });

  it('`email.received` reaches the anchor agent with a preview, never a body', async () => {
    const res = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
        subject: 'Q3 rollout',
        text: 'the body',
      }),
    );
    const agentEvents = await events(fable.key);
    const received = agentEvents.find((e) => e.event === 'email.received');
    expect(received).toBeDefined();
    expect(received!.data.email.id).toBe(res.body.email.id);
    expect(received!.data.email.preview).toBe('the body');
    expect(received!.data.email.text).toBeUndefined(); // a ref, not a body
    expect(received!.data.thread.id).toBe(res.body.email.threadId);
    // The owner gets the timeline's live half, not the delivery event.
    const ownerEvents = await events(owner.token);
    expect(ownerEvents.some((e) => e.event === 'email.received')).toBe(false);
    expect(ownerEvents.some((e) => e.event === 'activity.appended')).toBe(true);
  });

  it('`email.quarantined` fans out to the owner AND the org’s owners/admins, not members', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    const ownerQ = (await events(owner.token)).filter((e) => e.event === 'email.quarantined');
    expect(ownerQ).toHaveLength(1);
    expect(ownerQ[0]!.data.agent).toEqual({ id: fable.id, name: 'fable' });
    expect(ownerQ[0]!.data.reason).toBe('unrecognized-sender');
    expect((await events(admin.token)).some((e) => e.event === 'email.quarantined')).toBe(true);
    expect((await events(member.token)).some((e) => e.event === 'email.quarantined')).toBe(false);
  });

  it('`email.held` fires for an outbound hold; `email.resolved` reaches approvers AND the agent', async () => {
    await setPolicy({ outboundUnrecognized: 'approve' });
    const sent = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' },
    });
    expect(sent.statusCode).toBe(202);
    expect((await events(owner.token)).some((e) => e.event === 'email.held')).toBe(true);

    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${sent.json().email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const resolvedForOwner = (await events(owner.token)).filter((e) => e.event === 'email.resolved');
    expect(resolvedForOwner).toHaveLength(1);
    expect(resolvedForOwner[0]!.data.resolution).toBe('approved');
    expect(resolvedForOwner[0]!.data.by).toEqual({ id: owner.userId, displayName: 'Owner' });
    expect((await events(admin.token)).some((e) => e.event === 'email.resolved')).toBe(true);
    const agentEvents = await events(fable.key);
    expect(agentEvents.some((e) => e.event === 'email.resolved')).toBe(true);
    expect(agentEvents.some((e) => e.event === 'email.sent')).toBe(true);
  });

  it('`email.rejected` carries no preview — a refusal is a security record', async () => {
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    const rejected = (await events(owner.token)).filter((e) => e.event === 'email.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.data).toEqual({
      agentId: fable.id,
      from: expect.objectContaining({ email: 'dana@partner.example.com' }),
      direction: 'in',
      reason: 'unrecognized-sender',
    });
    expect(rejected[0]!.data.email).toBeUndefined();
  });

  it('reaps rejected inbound rows 30 days on, leaving their activity entries behind', async () => {
    const res = await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: at('fable') }], from: { email: 'dana@partner.example.com' } }),
    );
    const emailId = res.body.email.id as string;
    // Age the row past the retention horizon, then reap. Rejected INBOUND rows
    // live in `email_quarantine` (the table split) — the aging poke follows.
    const handle = openDb(ts.dataDir);
    try {
      handle.db
        .update(emailQuarantine)
        .set({ createdAt: '2020-01-01T00:00:00.000Z' })
        .where(eq(emailQuarantine.id, emailId))
        .run();
    } finally {
      handle.close();
    }
    const before = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${emailId}`,
      headers: auth(owner.token),
    });
    expect(before.statusCode).toBe(200);

    // The reap runs lazily on the inbound seam.
    await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'someone@partner.example.com' },
        rfcMessageId: '<next@mail.example.net>',
      }),
    );
    const after = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${emailId}`,
      headers: auth(owner.token),
    });
    expect(after.statusCode).toBe(404);
    // The `email.rejected` activity entry outlives the row it points at.
    const timeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(fable.key),
    });
    const entries = timeline.json().items as any[];
    expect(entries.filter((e) => e.type === 'email.rejected')).toHaveLength(2);
    // The timeline reads backward from now, so the reaped email's entry is LAST.
    expect(entries.at(-1).refs.emailId).toBe(emailId); // a dangling ref, by design
  });

  it('reapRejectedEmails leaves delivered and outbound rows alone', async () => {
    await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
      }),
    );
    const handle = openDb(ts.dataDir);
    try {
      handle.db.update(emails).set({ createdAt: '2020-01-01T00:00:00.000Z' }).run();
      const reaped = reapRejectedEmails(
        { db: handle.db } as never,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      expect(reaped).toBe(0);
      expect(handle.db.select().from(emails).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });
});

describe('the three email hint triggers', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };

  const at = (name: string): string => `${name}@${slug}.example.com`;

  async function pop(): Promise<any> {
    // Mark the agent online first: `start-listening` outranks the email triggers,
    // and an agent with no stream would take that hint instead (SPEC's priority
    // order — the email triggers sit just below it).
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/presence',
      headers: auth(fable.key),
      payload: { ttlSeconds: 60 },
    });
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(fable.key),
      payload: {},
    });
    return res.json();
  }

  beforeEach(async () => {
    ts = await makeEmailServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    slug = org.json().org.slug as string;
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
  });
  afterEach(async () => {
    await ts.close();
  });

  it('`you-have-email` fires for an agent that has never opened its mailbox', async () => {
    const first = await pop();
    expect(first.item).toBeNull();
    const hint = (first.hints as any[]).find((h) => h.id === 'you-have-email');
    expect(hint).toBeDefined();
    expect(hint.text).toContain(`fable@${slug}.example.com`);
    // The copy teaches the TRUST MODEL, not an open door (Jake, 2026-09-02):
    // only human-approved senders reach an agent; strangers wait on the human.
    // It must never suggest that anyone outside can write to the agent.
    expect(hint.text).toMatch(/approved|trusted/i);
    expect(hint.text).not.toMatch(/people outside/i);
    expect(hint.action).toEqual({ method: 'GET', path: '/api/v1/me/email/threads' });
    expect(hint.docs).toContain('/docs/api/me/email/threads');
  });

  it('`email-is-a-different-register` fires at the PAUSE after mail was popped, once ever', async () => {
    await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
      }),
    );
    await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: at('fable') }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
        rfcMessageId: '<second@mail.example.net>',
      }),
    );
    // The work itself is never hinted — a lecture stapled to the mail the agent
    // must now answer competes with the job.
    const first = await pop();
    expect(first.item.type).toBe('email');
    expect('hints' in first).toBe(false);
    const second = await pop();
    expect(second.item.type).toBe('email');
    expect('hints' in second).toBe(false);

    // The PAUSE right after the drain that included mail: the register lesson
    // lands there, still naming the thread of the mail just read.
    const paused = await pop();
    expect(paused.item).toBeNull();
    const hint = (paused.hints as any[])[0];
    expect(hint.id).toBe('email-is-a-different-register');
    expect(hint.text).toContain('That was email, not chat');
    expect(hint.action.path).toBe(`/api/v1/me/email/threads/${second.item.thread.id}/reply`);

    // Once ever — a later pause does not re-fire it.
    const again = await pop();
    expect(((again.hints as any[]) ?? []).some((h) => h.id === 'email-is-a-different-register')).toBe(
      false,
    );
  });

  it('`email-is-held` fires once an outbound email has waited ~10 minutes', async () => {
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: { outboundUnrecognized: 'approve' } } },
    });
    const sent = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['dana@partner.example.com'], subject: 'Hi', text: 'body' },
    });
    expect(sent.json().email.disposition).toBe('held');
    // Fresh: the trigger has not aged in yet (a just-sent hold is not news).
    const fresh = await pop();
    expect(((fresh.hints as any[]) ?? []).some((h) => h.id === 'email-is-held')).toBe(false);

    const handle = openDb(ts.dataDir);
    try {
      handle.db
        .update(emails)
        .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })
        .where(eq(emails.id, sent.json().email.id))
        .run();
    } finally {
      handle.close();
    }
    const aged = await pop();
    const hint = (aged.hints as any[]).find((h) => h.id === 'email-is-held');
    expect(hint).toBeDefined();
    expect(hint.text).toContain('Owner');
    expect(hint.action).toEqual({
      method: 'POST',
      path: '/api/v1/me/dms',
      exampleBody: { principal: owner.userId },
    });
    expect(hint.docs).toContain('/docs/api/orgs/email/approvals');
  });

  it('the email triggers are dormant when the medium is OFF', async () => {
    await ts.close();
    ts = await makeEmailServer({ emailProvider: undefined, emailOrgSuffix: undefined });
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    fable = await makeAgent(ts.app, owner.token, orgId, 'fable');
    const res = await pop();
    const ids = ((res.hints as any[]) ?? []).map((h) => h.id);
    expect(ids).not.toContain('you-have-email');
    expect(ids).not.toContain('email-is-a-different-register');
    expect(ids).not.toContain('email-is-held');
  });
});
