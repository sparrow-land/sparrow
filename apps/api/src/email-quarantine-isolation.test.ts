/**
 * Quarantine isolation — the structural guarantee behind Jake's rule: an AGENT
 * credential must never observe a quarantined or inbound-rejected email's
 * content (body OR subject) or existence, on ANY surface — transcript, by-id,
 * thread list, pop, unread counts, attachments, events journal, activity
 * timeline — until a human approves it. The oversight surfaces (owner/admin)
 * must keep seeing everything: the approval queue is the point.
 *
 * These tests are adversarial pins. Some passed on day one (regression armor);
 * the ones that first ran red (attachment fetch, deny's `email.resolved` fan-out
 * to the agent, thread-list metadata, reply derivation, activity summaries)
 * were real leaks, sealed in the route layer and then made structural by the
 * `email_quarantine` table split.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeEmailServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  deliverEmail,
  inboundPayload,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';

/** Marker strings that must NEVER show up on an agent surface. */
const SECRET_SUBJECT = 'ZZQ-SUBJECT-7f3a';
const SECRET_BODY = 'ZZQ-BODY-7f3a';

describe('quarantine isolation: the agent-credential surfaces', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let slug: string;
  let fable: { id: string; key: string };

  const at = (name: string): string => `${name}@${slug}.example.com`;

  /** A sender the trust set already recognizes: the org's own owner, verified. */
  const fromOwner = {
    from: { email: 'owner@example.com', name: 'Owner' },
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
  };

  /** The stranger's payload: unrecognized sender, authenticated, secret content. */
  const fromStranger = {
    from: { email: 'mallory@stranger.example.net', name: 'Mallory' },
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'stranger.example.net' },
    subject: SECRET_SUBJECT,
    text: SECRET_BODY,
  };

  async function send(overrides: Record<string, unknown> = {}) {
    return deliverEmail(ts.app, inboundPayload({ to: [{ email: at('fable') }], ...overrides }));
  }

  async function setPolicy(policy: Record<string, unknown>): Promise<void> {
    const res = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
      payload: { settings: { email: policy } },
    });
    if (res.statusCode !== 200) throw new Error(`policy failed: ${res.body}`);
  }

  /** The agent's thread list items. */
  async function agentThreads(): Promise<any[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/threads',
      headers: auth(fable.key),
    });
    expect(res.statusCode).toBe(200);
    return res.json().items as any[];
  }

  /** The agent's transcript of one thread. */
  async function agentTranscript(threadId: string) {
    return ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/threads/${threadId}`,
      headers: auth(fable.key),
    });
  }

  /** Every journaled `/me/events` frame for one principal token. */
  async function journal(token: string): Promise<{ event: string; data: any }[]> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/events/log?since=0',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().events as { event: string; data: any }[];
  }

  async function pop(): Promise<any> {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(fable.key),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function unreadCount(): Promise<number | null> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/agents`,
      headers: auth(owner.token),
    });
    return (res.json().items as any[]).find((e) => e.agent.id === fable.id).emailUnreadCount;
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

  it('1. the thread transcript never contains quarantined OR rejected rows — even threaded replies', async () => {
    // A real conversation exists…
    const seeded = await send({ ...fromOwner, rfcMessageId: '<seed@mail.example.net>' });
    expect(seeded.body.status).toBe('delivered');
    const threadId = seeded.body.email.threadId as string;

    // …a stranger replies under the default policy → rejected, same thread…
    const rejected = await send({
      ...fromStranger,
      rfcMessageId: '<rej@mail.example.net>',
      inReplyTo: '<seed@mail.example.net>',
    });
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.email.threadId).toBe(threadId);

    // …and again under `approve` → quarantined, same thread.
    await setPolicy({ inboundUnrecognized: 'approve' });
    const quarantined = await send({
      ...fromStranger,
      rfcMessageId: '<quar@mail.example.net>',
      inReplyTo: '<seed@mail.example.net>',
    });
    expect(quarantined.body.status).toBe('quarantined');
    expect(quarantined.body.email.threadId).toBe(threadId);

    const transcript = await agentTranscript(threadId);
    const items = transcript.json().items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].disposition).toBe('delivered');
    expect(JSON.stringify(transcript.json())).not.toContain(SECRET_SUBJECT);
    expect(JSON.stringify(transcript.json())).not.toContain(SECRET_BODY);
  });

  it('2. the by-id read is 404 for quarantined AND inbound-rejected ids, peek or not', async () => {
    const rejected = await send({ ...fromStranger, rfcMessageId: '<r@x.test>' });
    expect(rejected.body.status).toBe('rejected');
    await setPolicy({ inboundUnrecognized: 'approve' });
    const quarantined = await send({ ...fromStranger, rfcMessageId: '<q@x.test>' });
    expect(quarantined.body.status).toBe('quarantined');

    for (const id of [rejected.body.email.id, quarantined.body.email.id]) {
      for (const qs of ['', '?peek=true']) {
        const res = await ts.app.inject({
          method: 'GET',
          url: `/api/v1/me/email/emails/${id}${qs}`,
          headers: auth(fable.key),
        });
        expect(res.statusCode).toBe(404);
      }
    }
  });

  it('3. pop never returns a quarantined email, and it never counts as unread', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send(fromStranger);
    expect(q.body.status).toBe('quarantined');

    const popped = await pop();
    expect(popped.item).toBeNull();
    expect(JSON.stringify(popped)).not.toContain(SECRET_SUBJECT);
    expect(await unreadCount()).toBe(0);
  });

  it('4. a quarantined email’s attachment is NOT downloadable with the agent key (the owner keeps access)', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({
      ...fromStranger,
      attachments: [
        {
          filename: 'payload.pdf',
          contentType: 'application/pdf',
          dataBase64: Buffer.from('QUARANTINED-BYTES').toString('base64'),
        },
      ],
    });
    expect(q.body.status).toBe('quarantined');

    // The OWNER's oversight read exposes the attachment id and can download it.
    const oversight = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}`,
      headers: auth(owner.token),
    });
    expect(oversight.statusCode).toBe(200);
    const attachmentId = oversight.json().email.attachments[0].id as string;
    const byOwner = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/attachments/${attachmentId}`,
      headers: auth(owner.token),
    });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.rawPayload.toString()).toBe('QUARANTINED-BYTES');

    // The AGENT must not: attachment access is only via delivered inbound or
    // the agent's own outbound email. 404, indistinguishable from no-such-id.
    const byAgent = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/attachments/${attachmentId}`,
      headers: auth(fable.key),
    });
    expect(byAgent.statusCode).toBe(404);

    // Approval flips it: the attachment is now the agent's to read.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    const afterApprove = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/attachments/${attachmentId}`,
      headers: auth(fable.key),
    });
    expect(afterApprove.statusCode).toBe(200);
    expect(afterApprove.rawPayload.toString()).toBe('QUARANTINED-BYTES');
  });

  it('5. the thread LIST hides quarantine-only threads, and a mixed thread reflects only delivered mail', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    // A thread whose ONLY mail is quarantined must be absent entirely.
    const only = await send({ ...fromStranger, rfcMessageId: '<lone@x.test>' });
    expect(only.body.status).toBe('quarantined');
    expect(await agentThreads()).toHaveLength(0);

    // A mixed thread: delivered seed, then a NEWER quarantined stranger reply.
    const seeded = await send({ ...fromOwner, rfcMessageId: '<seed2@mail.example.net>' });
    const threadId = seeded.body.email.threadId as string;
    await send({
      ...fromStranger,
      rfcMessageId: '<quar2@mail.example.net>',
      inReplyTo: '<seed2@mail.example.net>',
    });

    const list = await agentThreads();
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row.id).toBe(threadId);
    // The triage badges reflect DELIVERED mail only: the stranger's pending
    // message must not surface as the "last" outcome, the cast must not carry
    // their address, and the count must not betray a hidden row.
    expect(row.lastDisposition).toBe('delivered');
    expect(row.emailCount).toBe(1);
    expect(row.participants.map((p: any) => p.email)).not.toContain(
      'mallory@stranger.example.net',
    );
    expect(JSON.stringify(list)).not.toContain(SECRET_SUBJECT);
  });

  it('6a. lifecycle APPROVE: the message then appears on every agent surface', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send(fromStranger);
    const threadId = q.body.email.threadId as string;
    expect(await unreadCount()).toBe(0);

    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });

    expect(await unreadCount()).toBe(1);
    const list = await agentThreads();
    expect(list).toHaveLength(1);
    expect(list[0].lastEmailAt).not.toBeNull();
    const transcript = await agentTranscript(threadId);
    expect((transcript.json().items as any[]).map((e: any) => e.disposition)).toEqual([
      'delivered',
    ]);
    const byId = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${q.body.email.id}`,
      headers: auth(fable.key),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().email.text).toBe(SECRET_BODY);
    // A fresh read state: approval delivered it UNREAD; the read just now
    // consumed it.
    expect(await unreadCount()).toBe(0);
  });

  it('6b. lifecycle DENY: the message never appears, and its body is gone everywhere', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send(fromStranger);
    const threadId = q.body.email.threadId as string;

    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}/deny`,
      headers: auth(owner.token),
      payload: {},
    });

    // Agent surfaces: nothing, before and after.
    expect(await agentThreads()).toHaveLength(0);
    expect((await pop()).item).toBeNull();
    const byId = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${q.body.email.id}`,
      headers: auth(fable.key),
    });
    expect(byId.statusCode).toBe(404);
    const transcript = await agentTranscript(threadId);
    expect(transcript.statusCode).toBe(404); // thread never became visible

    // The overseer read still resolves — but BODYLESS, per the deny contract.
    const oversight = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}`,
      headers: auth(owner.token),
    });
    expect(oversight.statusCode).toBe(200);
    expect(oversight.json().email.disposition).toBe('rejected');
    expect(oversight.json().email.reason).toBe('denied');
    expect(oversight.json().email.text).toBe('');
    expect(oversight.json().email.html).toBeNull();
    expect(oversight.json().email.subject).toBe(SECRET_SUBJECT); // metadata stays

    // And the AGENT's events journal took nothing from the whole episode.
    const frames = await journal(fable.key);
    expect(JSON.stringify(frames)).not.toContain(SECRET_SUBJECT);
    expect(JSON.stringify(frames)).not.toContain(SECRET_BODY);
  });

  it('7. the agent’s /me/events journal never carries a quarantined email’s subject or body', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    await send(fromStranger);

    const agentFrames = await journal(fable.key);
    expect(agentFrames.some((e) => e.event === 'email.quarantined')).toBe(false);
    expect(JSON.stringify(agentFrames)).not.toContain(SECRET_SUBJECT);
    expect(JSON.stringify(agentFrames)).not.toContain(SECRET_BODY);

    // The OWNER's journal is the approval surface — it must keep the event.
    const ownerFrames = await journal(owner.token);
    expect(ownerFrames.some((e) => e.event === 'email.quarantined')).toBe(true);
  });

  it('8. the agent’s activity timeline carries no quarantined/rejected subject; the owner’s does', async () => {
    const rejected = await send({ ...fromStranger, rfcMessageId: '<ra@x.test>' });
    expect(rejected.body.status).toBe('rejected');
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({ ...fromStranger, rfcMessageId: '<qa@x.test>' });
    expect(q.body.status).toBe('quarantined');

    const timeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(fable.key),
    });
    const entries = timeline.json().items as any[];
    // The entries themselves are legitimate refs (pinned elsewhere) — but their
    // SUMMARY is the stranger's subject line, which is quarantined content.
    expect(entries.map((e) => e.type).sort()).toEqual(['email.quarantined', 'email.rejected']);
    for (const entry of entries) expect(entry.summary).toBeNull();
    expect(JSON.stringify(entries)).not.toContain(SECRET_SUBJECT);

    // The owner's timeline keeps the summary — it is their triage line.
    const ownerTimeline = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?medium=email',
      headers: auth(owner.token),
    });
    const ownerEntries = ownerTimeline.json().items as any[];
    expect(ownerEntries.some((e) => e.summary === SECRET_SUBJECT)).toBe(true);
  });

  it('9. a reply never derives recipients or headers from a quarantined message', async () => {
    const seeded = await send({ ...fromOwner, rfcMessageId: '<seed3@mail.example.net>' });
    const threadId = seeded.body.email.threadId as string;
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({
      ...fromStranger,
      rfcMessageId: '<quar3@mail.example.net>',
      inReplyTo: '<seed3@mail.example.net>',
    });
    expect(q.body.status).toBe('quarantined');

    const reply = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/email/threads/${threadId}/reply`,
      headers: auth(fable.key),
      payload: { text: 'replying to what I can see' },
    });
    expect(reply.statusCode).toBe(201); // owner is recognized → sent outright
    const sent = reply.json().email;
    // The reply answers the DELIVERED mail: the stranger must not be addressed,
    // and the threading headers must not reference the quarantined message.
    expect(sent.to.map((p: any) => p.email)).toEqual(['owner@example.com']);
    expect(sent.inReplyTo).toBe('<seed3@mail.example.net>');
  });

  it('10. the oversight surfaces DO see quarantined mail — queue, transcript, by-id', async () => {
    const seeded = await send({ ...fromOwner, rfcMessageId: '<seed4@mail.example.net>' });
    const threadId = seeded.body.email.threadId as string;
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({
      ...fromStranger,
      rfcMessageId: '<quar4@mail.example.net>',
      inReplyTo: '<seed4@mail.example.net>',
    });

    // The approvals queue lists it, preview intact.
    const approvals = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/approvals`,
      headers: auth(owner.token),
    });
    const items = approvals.json().items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].email.id).toBe(q.body.email.id);
    expect(items[0].email.preview).toBe(SECRET_BODY);
    expect(items[0].thread.id).toBe(threadId);

    // The oversight transcript interleaves the quarantined row by createdAt.
    const oversight = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/agents/${fable.id}/email/threads/${threadId}`,
      headers: auth(owner.token),
    });
    const dispositions = (oversight.json().items as any[]).map((e) => e.disposition);
    expect(dispositions).toEqual(['delivered', 'quarantined']); // createdAt order
    expect((oversight.json().items as any[])[1].text).toBe(SECRET_BODY);

    // And the org by-id read resolves it whole.
    const byId = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/email/emails/${q.body.email.id}`,
      headers: auth(owner.token),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().email.text).toBe(SECRET_BODY);
  });

  /* ================================================================== *
   * The table split — Jake's structural guarantee: "put all those messages
   * in their own table … even an out-of-band sql query won't confuse
   * quarantined emails with legit messages."
   * ================================================================== */

  /** Raw table contents, read out-of-band like an operator's sql would. */
  function rawRows(table: string): any[] {
    const handle = openDb(ts.dataDir);
    try {
      return handle.sqlite.prepare(`SELECT * FROM ${table}`).all() as any[];
    } finally {
      handle.close();
    }
  }

  it('11. quarantined/rejected inbound rows live ONLY in email_quarantine — never in emails', async () => {
    // One of everything: delivered inbound, rejected inbound, quarantined
    // inbound, and the agent's own outbound (sent + a denied composition).
    await send({ ...fromOwner, rfcMessageId: '<d@x.test>' });
    const rejected = await send({ ...fromStranger, rfcMessageId: '<r2@x.test>' });
    expect(rejected.body.status).toBe('rejected');
    await setPolicy({ inboundUnrecognized: 'approve', outboundUnrecognized: 'approve' });
    const quarantined = await send({ ...fromStranger, rfcMessageId: '<q2@x.test>' });
    expect(quarantined.body.status).toBe('quarantined');
    const sent = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['owner@example.com'], subject: 'mine', text: 'my words' },
    });
    expect(sent.statusCode).toBe(201);
    const held = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/email/send',
      headers: auth(fable.key),
      payload: { to: ['newpartner@elsewhere.example.net'], subject: 'held', text: 'hold me' },
    });
    expect(held.json().email.disposition).toBe('held');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${held.json().email.id}/deny`,
      headers: auth(owner.token),
      payload: {},
    });

    // `emails` = delivered inbound + the agent's own outbound, whatever their
    // fate. NO quarantined row, NO inbound-rejected row — a bare
    // `SELECT * FROM emails` can never surface a stranger's message.
    const emailRows = rawRows('emails');
    expect(emailRows.some((r) => r.disposition === 'quarantined')).toBe(false);
    expect(
      emailRows.some((r) => r.direction === 'in' && r.disposition !== 'delivered'),
    ).toBe(false);
    expect(JSON.stringify(emailRows)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(emailRows)).not.toContain(SECRET_SUBJECT);
    // The denied OUTBOUND composition stays in `emails` — it is the agent's own.
    expect(
      emailRows.some((r) => r.direction === 'out' && r.disposition === 'rejected'),
    ).toBe(true);

    // `email_quarantine` = exactly the stranger's two messages, reasons intact.
    const qRows = rawRows('email_quarantine');
    expect(qRows).toHaveLength(2);
    expect(qRows.every((r) => r.direction === 'in')).toBe(true);
    expect(qRows.map((r) => r.disposition).sort()).toEqual(['quarantined', 'rejected']);
    // The rejected row is metadata-only; the quarantined one keeps its body
    // (the human must be able to read it to rule on it).
    const qRow = qRows.find((r) => r.disposition === 'quarantined')!;
    expect(qRow.text_body).toBe(SECRET_BODY);
    expect(qRows.find((r) => r.disposition === 'rejected')!.text_body).toBeNull();
  });

  it('12. approve MOVES the row quarantine → emails; deny leaves it in quarantine, body wiped', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const approved = await send({ ...fromStranger, rfcMessageId: '<mv1@x.test>' });
    const denied = await send({ ...fromStranger, rfcMessageId: '<mv2@x.test>' });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${approved.body.email.id}/approve`,
      headers: auth(owner.token),
      payload: {},
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/email/emails/${denied.body.email.id}/deny`,
      headers: auth(owner.token),
      payload: {},
    });

    const emailRows = rawRows('emails');
    const qRows = rawRows('email_quarantine');
    // The approved message crossed over — same id, now a delivered legit row.
    const moved = emailRows.find((r) => r.id === approved.body.email.id);
    expect(moved).toBeDefined();
    expect(moved!.disposition).toBe('delivered');
    expect(moved!.reason).toBeNull();
    expect(moved!.read_at).toBeNull(); // fresh read state: delivered UNREAD
    expect(moved!.resolved_at).not.toBeNull();
    expect(qRows.some((r) => r.id === approved.body.email.id)).toBe(false);
    // The denied one never crossed: it stays quarantine-side, rejected, bodyless.
    expect(emailRows.some((r) => r.id === denied.body.email.id)).toBe(false);
    const stayed = qRows.find((r) => r.id === denied.body.email.id)!;
    expect(stayed.disposition).toBe('rejected');
    expect(stayed.reason).toBe('denied');
    expect(stayed.text_body).toBeNull();
    expect(stayed.html_body).toBeNull();
  });

  it('13. idempotency spans the split: a retried quarantined message is `duplicate`, not a second row', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const first = await send({ ...fromStranger, rfcMessageId: '<dup-q@x.test>' });
    expect(first.body.status).toBe('quarantined');
    const retry = await send({ ...fromStranger, rfcMessageId: '<dup-q@x.test>' });
    expect(retry.body.status).toBe('duplicate');
    expect(retry.body.email.id).toBe(first.body.email.id);
    expect(rawRows('email_quarantine')).toHaveLength(1);

    // …and threading still joins a reply onto the quarantined ancestor's thread.
    const reply = await send({
      ...fromStranger,
      rfcMessageId: '<dup-q-child@x.test>',
      inReplyTo: '<dup-q@x.test>',
    });
    expect(reply.body.email.threadId).toBe(first.body.email.threadId);
  });

  it('14. deleting the agent takes its quarantine rows (and their attachment blobs) with it', async () => {
    await setPolicy({ inboundUnrecognized: 'approve' });
    const q = await send({
      ...fromStranger,
      attachments: [
        {
          filename: 'x.bin',
          contentType: 'application/octet-stream',
          dataBase64: Buffer.from('GONE-WITH-AGENT').toString('base64'),
        },
      ],
    });
    expect(q.body.status).toBe('quarantined');
    const del = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${fable.id}`,
      headers: auth(owner.token),
    });
    expect(del.statusCode).toBe(200);
    expect(rawRows('email_quarantine')).toHaveLength(0);
    expect(rawRows('email_attachments')).toHaveLength(0);
  });
});
