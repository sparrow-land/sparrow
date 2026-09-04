import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { invites, orgMemberships } from './db/schema.js';

const adminHeader = { 'x-admin-token': TEST_ADMIN_TOKEN };

/** A stub outbound-email webhook that records what it received. */
interface Hook {
  url: string;
  close(): Promise<void>;
  calls: Array<{ authorization?: string; body: any }>;
}

async function startHook(status = 200): Promise<Hook> {
  const calls: Hook['calls'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ authorization: req.headers['authorization'], body: raw ? JSON.parse(raw) : undefined });
      res.statusCode = status;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function configureHook(ts: TestServer, url: string, token = 'hook-token') {
  const res = await ts.app.inject({
    method: 'PUT',
    url: '/api/v1/config',
    headers: adminHeader,
    payload: { values: { 'email.webhookUrl': url, 'email.webhookToken': token } },
  });
  expect(res.statusCode).toBe(200);
}

async function addMember(ts: TestServer, token: string, orgId: string, email: string, role?: string) {
  return ts.app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/members`,
    headers: auth(token),
    payload: { email, ...(role ? { role } : {}) },
  });
}

/** Pull the `ivk_...` token out of an `/invite/<token>` URL. */
function tokenOf(inviteUrl: string): string {
  return inviteUrl.split('/invite/')[1]!;
}

describe('POST /orgs/:orgId/members — fused low-friction invite', () => {
  let ts: TestServer;
  let hook: Hook | undefined;

  beforeEach(async () => {
    ts = await makeTestServer();
    hook = undefined;
  });
  afterEach(async () => {
    if (hook) await hook.close();
    await ts.close();
  });

  it('mints an invite whose URL the invite-info endpoint accepts; membership + invite both exist', async () => {
    const owner = await signup(ts.app, { email: 'owner@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);

    const res = await addMember(ts, owner.token, orgId, 'new@acme.com');
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Response carries the invite URL + emailSent flag.
    expect(typeof body.inviteUrl).toBe('string');
    expect(body.inviteUrl).toContain('/invite/');
    expect(body.emailSent).toBe(false); // no hook configured

    // The token is a real, redeemable invite: the public info endpoint accepts it.
    const token = tokenOf(body.inviteUrl);
    const info = await ts.app.inject({ method: 'GET', url: `/api/v1/invite/${token}/info` });
    expect(info.statusCode).toBe(200);
    expect(info.json().org.name).toBe("Owner's org"); // bootstrap org name = "<displayName>'s org"
    expect(info.json().inviter.displayName).toBe('Owner');

    // Both the membership and the invite row are persisted.
    const handle = openDb(ts.dataDir);
    try {
      const membership = handle.db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.humanId, body.member.human.id))
        .get();
      expect(membership).toBeDefined();
      const inviteRow = handle.db.select().from(invites).where(eq(invites.orgId, orgId)).all();
      expect(inviteRow.length).toBeGreaterThanOrEqual(1);
    } finally {
      handle.close();
    }
  });

  it('emailSent true + email content (org, inviter, link) on the v4 envelope when the hook is configured', async () => {
    hook = await startHook(200);
    const owner = await signup(ts.app, { email: 'boss@acme.com', displayName: 'Boss Person' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await configureHook(ts, hook.url, 'hook-token');

    const res = await addMember(ts, owner.token, orgId, 'invitee@acme.com');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.emailSent).toBe(true);

    expect(hook.calls).toHaveLength(1);
    const call = hook.calls[0]!;
    expect(call.authorization).toBe('Bearer hook-token');
    // The v4 outbound envelope: `to` is ALWAYS an array, the sender rides on
    // `from`, and a `headers` object carries the message identity (SPEC "The
    // email medium → Providers → EMAIL_PROVIDER=webhook").
    expect(call.body.to).toEqual(['invitee@acme.com']);
    expect(call.body.from).toBe('boss@acme.com'); // inviter's email
    expect(call.body.headers.messageId).toMatch(/^<inv_[^@]+@[^>]+>$/);
    expect(call.body.replyTo).toBeUndefined();
    expect(call.body.subject).toContain('Boss Person');
    // subject: "<inviter> invited you to <org>"
    expect(call.body.subject).toContain('invited you to');

    // Both text and html carry the org name, the inviter, and the invite link.
    for (const part of [call.body.text as string, call.body.html as string]) {
      expect(part).toContain('Boss Person');
      expect(part).toContain(body.inviteUrl);
    }
    // The org name appears in the subject and in the body text.
    const subjectOrg = (call.body.subject as string).split('invited you to ')[1];
    expect(call.body.text).toContain(subjectOrg);
  });

  it('a failing email hook does not fail the request (still 201, emailSent false)', async () => {
    hook = await startHook(500);
    const owner = await signup(ts.app, { email: 'o2@acme.com', displayName: 'Owner Two' });
    const orgId = await firstOrgId(ts.app, owner.token);
    await configureHook(ts, hook.url, 'hook-token');

    const res = await addMember(ts, owner.token, orgId, 'p2@acme.com');
    expect(res.statusCode).toBe(201);
    expect(res.json().emailSent).toBe(false);
    // The person is still a member despite the email failure.
    const roster = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/humans`,
      headers: auth(owner.token),
    });
    const emails = (roster.json().items as { human: { email: string } }[]).map((m) => m.human.email);
    expect(emails).toContain('p2@acme.com');
  });

  it('the invite URL is built the effective-origin way (org host) when host-scoped', async () => {
    ts = await makeTestServer({ orgHostSuffix: '.example.com' });
    const owner = await signup(ts.app, { email: 'owner3@acme.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    // Fetch the org slug to build the scoped host.
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    const slug = org.json().org.slug as string;

    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members`,
      headers: { ...auth(owner.token), host: `${slug}.example.com` },
      payload: { email: 'scoped@acme.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteUrl).toContain(`${slug}.example.com/invite/`);
  });
});
