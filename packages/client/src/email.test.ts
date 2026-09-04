/**
 * The email medium through `@sparrow/client` (SPEC v4 "The email medium →
 * Routes"). Every test drives a REAL in-process server with the medium ON
 * (`EMAIL_PROVIDER=fake` + `EMAIL_ORG_SUFFIX`), so these double as a contract
 * check against the live routes and the `common-types` wire shapes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SparrowClient, ApiError, type PrincipalEvent } from './index.js';
import type { EmailReceivedEvent, EmailQuarantinedEvent } from '@sparrow/common-types';
import {
  startServer,
  startEmailServer,
  deliverEmail,
  sleep,
  TEST_EMAIL_SUFFIX,
  type Harness,
} from './harness.js';

let seq = 0;
const addr = (name = 'user') => `${name}-${Date.now()}-${seq++}@example.com`;

interface Acme {
  h: Harness;
  owner: SparrowClient;
  /** The owner's account email — a rung-1 trusted sender in their org. */
  ownerEmail: string;
  org: { id: string; slug: string };
  fable: SparrowClient;
  agent: { id: string; name: string };
  /** `fable@<org-slug>.example.com`, the derived address. */
  address: string;
}

/**
 * A fresh org with one agent named `fable`, plus its derived address. Each call
 * makes its OWN org so trust state never leaks between tests.
 */
async function acmeOn(h: Harness, opts: { email?: boolean } = {}): Promise<Acme> {
  const ownerEmail = addr('owner');
  // Deliberately NO admin token: these tests exercise the OWNER's authority
  // (an `X-Admin-Token` would ride on every request and stand in for the human,
  // hiding `resolvedBy` and widening the approvals scope).
  const owner = new SparrowClient({ server: h.url });
  await owner.signup({ email: ownerEmail, password: 'password123', displayName: 'Owner' });
  const org = await owner.createOrg({ name: `Acme ${Date.now()}-${seq++}` });
  const minted = await owner.createAgent({ orgId: org.id, name: 'fable' });
  const fable = new SparrowClient({ server: h.url, token: minted.key });
  const address = opts.email === false ? '' : (await fable.meEmailAddress()).address;
  return { h, owner, ownerEmail, org, fable, agent: minted.agent, address };
}

/** Set this org's email trust policy (both directions at once). */
async function setPolicy(
  ctx: Acme,
  policy: { inboundUnrecognized?: string; outboundUnrecognized?: string },
): Promise<void> {
  await ctx.owner.updateOrg(ctx.org.id, {
    settings: { email: policy } as never,
  });
}

/** Deliver one inbound email to `ctx.address` from a TRUSTED sender (the owner). */
function inboundFromOwner(ctx: Acme, overrides: Record<string, unknown> = {}) {
  return deliverEmail(ctx.h, {
    to: [{ email: ctx.address }],
    from: { email: ctx.ownerEmail, name: 'Owner' },
    ...overrides,
  });
}

/** Deliver one inbound email to `ctx.address` from an UNRECOGNIZED sender. */
function inboundFromStranger(ctx: Acme, from: string, overrides: Record<string, unknown> = {}) {
  return deliverEmail(ctx.h, {
    to: [{ email: ctx.address }],
    from: { email: from, name: 'Stranger' },
    ...overrides,
  });
}

describe('email — the medium off', () => {
  let h: Harness;
  beforeAll(async () => (h = await startServer()));
  afterAll(() => h.close());

  it('capabilities report email:false and every /me/email route 404s', async () => {
    const ctx = await acmeOn(h, { email: false });
    expect((await ctx.fable.getCapabilities()).email).toBe(false);
    await expect(ctx.fable.meEmailAddress()).rejects.toMatchObject({ status: 404 });
    await expect(ctx.fable.listEmailThreads()).rejects.toBeInstanceOf(ApiError);
    await expect(ctx.owner.listEmailApprovals(ctx.org.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('email — agent surfaces (/me/email/*)', () => {
  let h: Harness;
  beforeAll(async () => (h = await startEmailServer()));
  afterAll(() => h.close());

  it('capabilities report email:true and the address derives from name + org slug', async () => {
    const ctx = await acmeOn(h);
    expect((await ctx.fable.getCapabilities()).email).toBe(true);
    const res = await ctx.fable.meEmailAddress();
    expect(res.address).toBe(`fable@${ctx.org.slug}${TEST_EMAIL_SUFFIX}`);
    expect(res.domain).toBe(`${ctx.org.slug}${TEST_EMAIL_SUFFIX}`);
    expect(res.orgId).toBe(ctx.org.id);
    expect(res.agentId).toBe(ctx.agent.id);
  });

  it('a human session on /me/email/* is 403 — addresses belong to agents', async () => {
    const ctx = await acmeOn(h);
    await expect(ctx.owner.meEmailAddress()).rejects.toMatchObject({ status: 403 });
  });

  it('an inbound email lands as a thread, a readable email, and a typed work item', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'Q3 rollout', text: 'hello there' });

    const threads = await ctx.fable.listEmailThreads();
    expect(threads.items).toHaveLength(1);
    expect(threads.nextBefore).toBeNull();
    const thread = threads.items[0]!;
    expect(thread.subject).toBe('Q3 rollout');
    expect(thread.agentId).toBe(ctx.agent.id);
    expect(thread.orgId).toBe(ctx.org.id);
    expect(thread.lastEmailAt).not.toBeNull();
    // The LIST carries full threads, so a triage row needs no second request.
    expect(thread.emailCount).toBe(1);
    expect(thread.unreadCount).toBe(1);
    expect(thread.lastDisposition).toBe('delivered');
    expect(thread.participants.length).toBeGreaterThan(0);

    // The thread read is a PEEK: it writes no read state.
    const full = await ctx.fable.getEmailThread(thread.id);
    expect(full.thread.emailCount).toBe(1);
    expect(full.thread.unreadCount).toBe(1);
    expect(full.items[0]!.text).toBe('hello there');
    expect(full.items[0]!.direction).toBe('in');
    expect(full.items[0]!.verification?.spf).toBe('pass');
    expect((await ctx.fable.getEmailThread(thread.id)).thread.unreadCount).toBe(1);

    // The email work item parses through the medium-spanning pop.
    const popped = await ctx.fable.meInboxPop();
    expect(popped.item?.type).toBe('email');
    if (popped.item?.type !== 'email') throw new Error('expected an email work item');
    expect(popped.item.email.subject).toBe('Q3 rollout');
    expect(popped.item.email.text).toBe('hello there');
    expect(popped.item.thread.id).toBe(thread.id);
    // Popping is reading: the queue is now empty and the thread has no unread.
    expect((await ctx.fable.meInboxPop()).item).toBeNull();
    expect((await ctx.fable.getEmailThread(thread.id)).thread.unreadCount).toBe(0);
  });

  it('/me/inbox lists the email variant of the union (EmailPreview + thread)', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'inbox item', text: 'body text' });
    const res = await ctx.fable.meInbox({ medium: 'email' });
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.type).toBe('email');
    if (item.type !== 'email') throw new Error('expected an email inbox entry');
    expect(item.subject).toBe('inbox item');
    expect(item.disposition).toBe('delivered');
    expect(item.status).toBe('unread');
    expect(item.thread.subject).toBe('inbox item');
    // Listing marks nothing read on email.
    expect((await ctx.fable.meInbox({ medium: 'email' })).items).toHaveLength(1);
  });

  it('readEmail marks an inbound delivered email read; ?peek=true never does', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'read me', text: 'body' });
    const thread = (await ctx.fable.listEmailThreads()).items[0]!;
    const emailId = (await ctx.fable.getEmailThread(thread.id)).items[0]!.id;

    const peeked = await ctx.fable.readEmail(emailId, { peek: true });
    expect(peeked.status).toBe('unread');
    const read = await ctx.fable.readEmail(emailId);
    expect(read.status).toBe('read');
    expect(read.bcc).toEqual([]);
    await expect(ctx.fable.readEmail('eml_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('replyEmail answers inside the thread (subject and recipients come from it)', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'Q3 rollout', text: 'ping' });
    const thread = (await ctx.fable.listEmailThreads()).items[0]!;

    const sent = await ctx.fable.replyEmail(thread.id, {
      text: 'answering whole, as a document.',
    });
    expect(sent.direction).toBe('out');
    expect(sent.disposition).toBe('sent');
    expect(sent.threadId).toBe(thread.id);
    expect(sent.to.map((p) => p.email)).toContain(ctx.ownerEmail.toLowerCase());
    expect(sent.subject).toContain('Q3 rollout');
    // The thread keeps its FIRST subject.
    expect((await ctx.fable.listEmailThreads()).items[0]!.subject).toBe('Q3 rollout');
    // Outbound is never a work item: only the inbound one is in the inbox.
    const inbox = await ctx.fable.meInbox({ medium: 'email', all: true });
    expect(inbox.items.every((i) => i.type === 'email' && i.direction === 'in')).toBe(true);
  });

  it('the thread list is newest-first and pages backward with `before`', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'older thread', text: 'a' });
    await inboundFromOwner(ctx, { subject: 'newer thread', text: 'b' });

    const all = await ctx.fable.listEmailThreads();
    expect(all.items.map((t) => t.subject)).toEqual(['newer thread', 'older thread']);
    expect(all.nextBefore).toBeNull();

    const head = await ctx.fable.listEmailThreads({ limit: 1 });
    expect(head.items[0]!.subject).toBe('newer thread');
    expect(head.nextBefore).toBe(head.items[0]!.id);
    const older = await ctx.fable.listEmailThreads({ limit: 1, before: head.nextBefore! });
    expect(older.items[0]!.subject).toBe('older thread');
    expect(older.nextBefore).toBeNull();
    await expect(ctx.fable.listEmailThreads({ before: 'eth_nope' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('sendEmail to a trusted recipient goes out (201, disposition sent)', async () => {
    const ctx = await acmeOn(h);
    const res = await ctx.fable.sendEmail({
      to: [ctx.ownerEmail],
      subject: 'a note for my owner',
      text: 'Everything is fine.',
    });
    expect(res.email.disposition).toBe('sent');
    expect(res.email.direction).toBe('out');
    expect(res.thread.orgId).toBe(ctx.org.id);
    const threads = await ctx.fable.listEmailThreads();
    expect(threads.items.map((t) => t.subject)).toContain('a note for my owner');
  });

  it('sendEmail to an unknown recipient is HELD under an approve policy (202)', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { outboundUnrecognized: 'approve' });
    const res = await ctx.fable.sendEmail({
      to: ['stranger@nowhere.example.com'],
      subject: 'introducing myself',
      text: 'Hello — I am fable, an agent working for Owner at Acme.',
    });
    expect(res.email.disposition).toBe('held');
    expect(res.email.reason).toBe('unrecognized-recipient');
    expect(res.thread.subject).toBe('introducing myself');
    // A held thread has never carried a delivered/sent email, so it stays out of
    // the listing (`lastEmailAt` is null).
    expect((await ctx.fable.listEmailThreads()).items).toHaveLength(0);
  });

  it('sendEmail to an unknown recipient is 403 under the default reject policy', async () => {
    const ctx = await acmeOn(h);
    await expect(
      ctx.fable.sendEmail({ to: ['nope@nowhere.example.com'], subject: 'x', text: 'y' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('retryEmail refuses an email that is not send-failed (409)', async () => {
    const ctx = await acmeOn(h);
    const res = await ctx.fable.sendEmail({
      to: [ctx.ownerEmail],
      subject: 'ok',
      text: 'fine',
    });
    await expect(ctx.fable.retryEmail(res.email.id)).rejects.toMatchObject({ status: 409 });
  });

  it('getEmailAttachment downloads an inbound attachment with its filename', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, {
      subject: 'with a file',
      text: 'see attached',
      attachments: [
        {
          filename: 'plan.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('the plan').toString('base64'),
        },
      ],
    });
    const thread = (await ctx.fable.listEmailThreads()).items[0]!;
    const email = (await ctx.fable.getEmailThread(thread.id)).items[0]!;
    expect(email.attachments).toHaveLength(1);
    const dl = await ctx.fable.getEmailAttachment(email.attachments[0]!.id);
    expect(dl.filename).toBe('plan.txt');
    expect(Buffer.from(dl.bytes).toString('utf8')).toBe('the plan');
  });
});

describe('email — human/org surfaces', () => {
  let h: Harness;
  beforeAll(async () => (h = await startEmailServer()));
  afterAll(() => h.close());

  it("an owner reads an agent's address and threads (always a peek)", async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, { subject: 'owner peek', text: 'body' });

    expect((await ctx.owner.agentEmailAddress(ctx.org.id, ctx.agent.id)).address).toBe(ctx.address);
    const threads = await ctx.owner.agentEmailThreads(ctx.org.id, ctx.agent.id);
    expect(threads.items).toHaveLength(1);
    const thread = await ctx.owner.agentEmailThread(ctx.org.id, ctx.agent.id, threads.items[0]!.id);
    expect(thread.items[0]!.text).toBe('body');
    // A human reading never marks the agent's mail read.
    expect(thread.thread.unreadCount).toBe(1);
    const email = await ctx.owner.getOrgEmail(ctx.org.id, thread.items[0]!.id);
    expect(email.status).toBe('unread');
  });

  it('the approvals queue carries quarantined inbound and held outbound', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve', outboundUnrecognized: 'approve' });
    await inboundFromStranger(ctx, 'stranger@elsewhere.example.com', {
      subject: 'who am I',
      text: 'unknown sender',
    });
    await ctx.fable.sendEmail({
      to: ['nobody@nowhere.example.com'],
      subject: 'held one',
      text: 'hi',
    });

    const queue = await ctx.owner.listEmailApprovals(ctx.org.id);
    expect(queue.items).toHaveLength(2);
    expect(queue.items.map((i) => i.email.disposition).sort()).toEqual(['held', 'quarantined']);
    for (const item of queue.items) expect(item.agent.name).toBe('fable');

    const inbound = await ctx.owner.listEmailApprovals(ctx.org.id, { direction: 'in' });
    expect(inbound.items).toHaveLength(1);
    expect(inbound.items[0]!.email.reason).toBe('unrecognized-sender');
    expect(inbound.items[0]!.verification?.dmarc).toBe('pass');
    const forAgent = await ctx.owner.listEmailApprovals(ctx.org.id, { agent: ctx.agent.id });
    expect(forAgent.items).toHaveLength(2);
  });

  it('approve delivers a quarantined inbound email and trusts the sender durably', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve' });
    await inboundFromStranger(ctx, 'newbie@elsewhere.example.com', {
      subject: 'first contact',
      text: 'may I?',
    });
    const pending = (await ctx.owner.listEmailApprovals(ctx.org.id)).items[0]!;
    const approved = await ctx.owner.approveEmail(ctx.org.id, pending.email.id);
    expect(approved.disposition).toBe('delivered');
    expect((await ctx.owner.listEmailApprovals(ctx.org.id)).items).toHaveLength(0);
    // Now it is the agent's work.
    expect((await ctx.fable.meInboxPop()).item?.type).toBe('email');

    // Durable: the contact is approved, so a second email from them delivers.
    const contacts = await ctx.owner.listEmailContacts(ctx.org.id, { q: 'newbie' });
    expect(contacts.items[0]!.trust).toBe('approved');
    await inboundFromStranger(ctx, 'newbie@elsewhere.example.com', {
      subject: 'second contact',
      text: 'again',
    });
    expect((await ctx.owner.listEmailApprovals(ctx.org.id)).items).toHaveLength(0);
  });

  it('approve with trustSender:false approves just this one email', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve' });
    await inboundFromStranger(ctx, 'once@elsewhere.example.com', {
      subject: 'just once',
      text: 'hi',
    });
    const pending = (await ctx.owner.listEmailApprovals(ctx.org.id)).items[0]!;
    await ctx.owner.approveEmail(ctx.org.id, pending.email.id, { trustSender: false });
    const contacts = await ctx.owner.listEmailContacts(ctx.org.id, { q: 'once@' });
    expect(contacts.items[0]!.trust).toBeNull();
  });

  it('deny rejects the email; blockSender blocks the contact for the org', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve' });
    await inboundFromStranger(ctx, 'spammer@elsewhere.example.com', {
      subject: 'buy this',
      text: 'spam',
    });
    const pending = (await ctx.owner.listEmailApprovals(ctx.org.id)).items[0]!;
    const denied = await ctx.owner.denyEmail(ctx.org.id, pending.email.id, { blockSender: true });
    expect(denied.disposition).toBe('rejected');
    expect(denied.reason).toBe('denied');
    const contacts = await ctx.owner.listEmailContacts(ctx.org.id, { q: 'spammer' });
    expect(contacts.items[0]!.trust).toBe('blocked');
    // Re-deciding a resolved email is a 409.
    await expect(ctx.owner.approveEmail(ctx.org.id, pending.email.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('contacts list filters by trust and updateEmailContact sets/clears it', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve' });
    await inboundFromStranger(ctx, 'contact@elsewhere.example.com', {
      subject: 'hello',
      text: 'hi',
    });
    const unknown = await ctx.owner.listEmailContacts(ctx.org.id, { trust: 'unknown' });
    const contact = unknown.items.find((c) => c.email === 'contact@elsewhere.example.com')!;
    expect(contact.trust).toBeNull();

    const approved = await ctx.owner.updateEmailContact(ctx.org.id, contact.id, 'approved');
    expect(approved.trust).toBe('approved');
    expect(approved.resolvedBy?.displayName).toBe('Owner');
    expect(
      (await ctx.owner.listEmailContacts(ctx.org.id, { trust: 'approved' })).items.map(
        (c) => c.email,
      ),
    ).toContain('contact@elsewhere.example.com');
    const cleared = await ctx.owner.updateEmailContact(ctx.org.id, contact.id, null);
    expect(cleared.trust).toBeNull();
  });

  it('the email.* principal events decode typed on /me/events', async () => {
    const ctx = await acmeOn(h);
    await setPolicy(ctx, { inboundUnrecognized: 'approve' });

    const seen: PrincipalEvent[] = [];
    // The agent sees `email.received`; the owner sees `email.quarantined`.
    const agentStream = ctx.fable.meEvents((e) => seen.push(e));
    const ownerStream = ctx.owner.meEvents((e) => seen.push(e));
    await sleep(120);

    await inboundFromOwner(ctx, { subject: 'typed event', text: 'body' });
    await inboundFromStranger(ctx, 'unknown@elsewhere.example.com', {
      subject: 'held for review',
      text: 'hi',
    });
    await sleep(250);
    agentStream.close();
    ownerStream.close();

    const received = seen.find((e) => e.type === 'email.received');
    expect(received).toBeDefined();
    // The union carries an open catch-all arm, so the payload is cast the same
    // way the chat event tests cast theirs — the point is that the frame DECODED
    // (it went through the schema), not that TS narrowed it.
    const receivedData = received!.data as EmailReceivedEvent;
    expect(receivedData.email.subject).toBe('typed event');
    expect(receivedData.email.disposition).toBe('delivered');
    expect(receivedData.thread.id).toBeTruthy();
    // A preview, never a body — the medium routes are the store.
    expect('text' in receivedData.email).toBe(false);

    const quarantined = seen.find((e) => e.type === 'email.quarantined');
    expect(quarantined).toBeDefined();
    const quarantinedData = quarantined!.data as EmailQuarantinedEvent;
    expect(quarantinedData.email.reason).toBe('unrecognized-sender');
    expect(quarantinedData.agent.name).toBe('fable');
  });

  it('an org-level email attachment downloads for the owner', async () => {
    const ctx = await acmeOn(h);
    await inboundFromOwner(ctx, {
      subject: 'org attachment',
      text: 'see attached',
      attachments: [
        {
          filename: 'notes.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('org notes').toString('base64'),
        },
      ],
    });
    const thread = (await ctx.fable.listEmailThreads()).items[0]!;
    const email = (await ctx.fable.getEmailThread(thread.id)).items[0]!;
    const dl = await ctx.owner.getOrgEmailAttachment(ctx.org.id, email.attachments[0]!.id);
    expect(dl.filename).toBe('notes.txt');
    expect(Buffer.from(dl.bytes).toString('utf8')).toBe('org notes');
  });
});
