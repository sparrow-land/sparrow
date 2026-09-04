/**
 * The email medium's ON/OFF contract and its address derivation (SPEC v4 "The
 * email medium → Concepts / Providers" + "Server configuration (env)").
 *
 * The medium is ON iff `EMAIL_ORG_SUFFIX` is set AND an email provider registers
 * (`EMAIL_PROVIDER=fake`, or `webhook` WITH `email.webhookUrl` resolved).
 * Otherwise every route `404`s — including for org owners — no address derives,
 * and `GET /capabilities` reports `email: false`. `POST /email/inbound`
 * additionally requires `EMAIL_INBOUND_TOKEN`: without it that ONE route 404s
 * even while the medium is on (a send-only deployment is legitimate).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  makeAgent,
  TEST_ADMIN_TOKEN,
  makeEmailServer,
  deliverEmail,
  inboundPayload,
  type TestServer,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { emailAttachments, emails, emailThreads, externalContacts } from './db/schema.js';

describe('email medium on/off', () => {
  let ts: TestServer | undefined;
  afterEach(async () => {
    if (ts) await ts.close();
    ts = undefined;
  });

  async function boot(overrides: Record<string, unknown>) {
    ts = await makeTestServer(overrides);
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    return { owner, orgId };
  }

  it('a suffix with NO provider leaves the medium off', async () => {
    const { owner, orgId } = await boot({ emailOrgSuffix: '.example.com' });
    const caps = await ts!.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(caps.json().email).toBe(false);
    const agent = await makeAgent(ts!.app, owner.token, orgId, 'fable');
    const addr = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/address',
      headers: auth(agent.key),
    });
    expect(addr.statusCode).toBe(404);
  });

  it('`webhook` with no resolved webhook URL registers nothing (medium stays off)', async () => {
    await boot({ emailOrgSuffix: '.example.com', emailProvider: 'webhook' });
    const caps = await ts!.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(caps.json().email).toBe(false);
  });

  it('`webhook` WITH a webhook URL turns the medium on', async () => {
    await boot({
      emailOrgSuffix: '.example.com',
      emailProvider: 'webhook',
      emailWebhookUrl: 'https://relay.example.com/hook',
    });
    const caps = await ts!.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(caps.json().email).toBe(true);
  });

  it('a provider with NO suffix leaves the medium off', async () => {
    await boot({ emailProvider: 'fake' });
    const caps = await ts!.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(caps.json().email).toBe(false);
  });

  it('suffix + fake provider: capabilities, the derived address, and /me/email/address', async () => {
    const { owner, orgId } = await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const caps = await ts!.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(caps.json().email).toBe(true);

    const org = await ts!.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    const slug = org.json().org.slug as string;

    const agent = await makeAgent(ts!.app, owner.token, orgId, 'fable');
    // The address rides on the agent resource everywhere it renders.
    const me = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: auth(agent.key),
    });
    expect(me.json().principal.emailAddress).toBe(`fable@${slug}.example.com`);

    const addr = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/address',
      headers: auth(agent.key),
    });
    expect(addr.statusCode).toBe(200);
    expect(addr.json()).toEqual({
      address: `fable@${slug}.example.com`,
      domain: `${slug}.example.com`,
      orgId,
      agentId: agent.id,
    });
  });

  it('a rename MOVES the mailbox — the derived address follows the name', async () => {
    const { owner, orgId } = await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const agent = await makeAgent(ts!.app, owner.token, orgId, 'fable');
    const renamed = await ts!.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { name: 'scribe' },
    });
    expect(renamed.statusCode).toBe(200);
    const addr = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/address',
      headers: auth(agent.key),
    });
    expect((addr.json().address as string).startsWith('scribe@')).toBe(true);
  });

  it('a HUMAN session on /me/email/* is 403 — addresses belong to agents', async () => {
    const { owner } = await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const res = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/me/email/address',
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('POST /email/inbound 404s without EMAIL_INBOUND_TOKEN, 401s on a bad bearer', async () => {
    await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const noToken = await ts!.app.inject({ method: 'POST', url: '/api/v1/email/inbound', payload: {} });
    expect(noToken.statusCode).toBe(404);
    await ts!.close();

    ts = await makeTestServer({
      emailOrgSuffix: '.example.com',
      emailProvider: 'fake',
      emailInboundToken: 'inbound-secret',
    });
    const bad = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/email/inbound',
      headers: auth('wrong'),
      payload: {},
    });
    expect(bad.statusCode).toBe(401);
    const missing = await ts.app.inject({ method: 'POST', url: '/api/v1/email/inbound', payload: {} });
    expect(missing.statusCode).toBe(401);
  });

  it('the fake admin outbox exists ONLY under EMAIL_PROVIDER=fake', async () => {
    await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    const ok = await ts!.app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/outbox',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toEqual([]);
    await ts!.close();

    ts = await makeTestServer({
      emailOrgSuffix: '.example.com',
      emailProvider: 'webhook',
      emailWebhookUrl: 'https://relay.example.com/hook',
    });
    const gone = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/outbox',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('exposes the in-process fake handle on the built server', async () => {
    await boot({ emailOrgSuffix: '.example.com', emailProvider: 'fake' });
    expect(ts!.app.emailFake).toBeDefined();
    expect(ts!.app.emailFake!.sent).toEqual([]);
    expect(typeof ts!.app.emailFake!.deliver).toBe('function');
  });
});

/**
 * Cascades (SPEC "Data model (SQLite)"): deleting an agent takes its threads,
 * emails, and attachment blobs with it; deleting an org additionally takes its
 * external contacts.
 */
describe('email cascade on delete', () => {
  let ts: TestServer;
  afterEach(async () => {
    await ts.close();
  });

  it('deleting an agent deletes its threads, emails and attachment blobs', async () => {
    ts = await makeEmailServer();
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    const slug = org.json().org.slug as string;
    const agent = await makeAgent(ts.app, owner.token, orgId, 'fable');
    const res = await deliverEmail(
      ts.app,
      inboundPayload({
        to: [{ email: `fable@${slug}.example.com` }],
        from: { email: 'owner@example.com' },
        verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'example.com' },
        attachments: [
          {
            filename: 'plan.pdf',
            contentType: 'application/pdf',
            dataBase64: Buffer.from('PDF').toString('base64'),
          },
        ],
      }),
    );
    expect(res.body.status).toBe('delivered');
    const email = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/email/emails/${res.body.email.id}?peek=true`,
      headers: auth(agent.key),
    });
    const attachmentId = email.json().email.attachments[0].id as string;
    expect(existsSync(path.join(ts.dataDir, 'attachments', attachmentId))).toBe(true);

    const deleted = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(200);

    const handle = openDb(ts.dataDir);
    try {
      expect(handle.db.select().from(emails).all()).toHaveLength(0);
      expect(handle.db.select().from(emailThreads).all()).toHaveLength(0);
      expect(handle.db.select().from(emailAttachments).all()).toHaveLength(0);
    } finally {
      handle.close();
    }
    expect(existsSync(path.join(ts.dataDir, 'attachments', attachmentId))).toBe(false);
  });

  it('deleting an org additionally deletes its external contacts', async () => {
    ts = await makeEmailServer();
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const org = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}`,
      headers: auth(owner.token),
    });
    const slug = org.json().org.slug as string;
    await makeAgent(ts.app, owner.token, orgId, 'fable');
    await deliverEmail(
      ts.app,
      inboundPayload({ to: [{ email: `fable@${slug}.example.com` }] }),
    );
    const handle = openDb(ts.dataDir);
    try {
      expect(handle.db.select().from(externalContacts).all()).toHaveLength(1);
    } finally {
      handle.close();
    }
    const deleted = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/orgs/${orgId}`,
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    expect(deleted.statusCode).toBe(200);
    const after = openDb(ts.dataDir);
    try {
      expect(after.db.select().from(externalContacts).all()).toHaveLength(0);
      expect(after.db.select().from(emails).all()).toHaveLength(0);
      expect(after.db.select().from(emailThreads).all()).toHaveLength(0);
    } finally {
      after.close();
    }
  });
});
