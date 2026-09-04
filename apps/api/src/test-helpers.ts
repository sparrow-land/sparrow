import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import type { ServerConfig } from './context.js';

export interface TestServer {
  app: FastifyInstance;
  dataDir: string;
  baseUrl: string;
  close(): Promise<void>;
}

/** Default admin token for test servers (the operator escape hatch). */
export const TEST_ADMIN_TOKEN = 'test-admin-token';

/** Spin up a server backed by a fresh temp-dir SQLite database. */
export async function makeTestServer(
  overrides: Partial<ServerConfig> = {},
): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-api-'));
  const config: ServerConfig = {
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: TEST_ADMIN_TOKEN,
    ...overrides,
  };
  const app = buildServer(config);
  await app.ready();
  return {
    app,
    dataDir,
    baseUrl: config.baseUrl,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The inbound bearer every email test server accepts. */
export const TEST_INBOUND_TOKEN = 'test-inbound-token';

/**
 * A server with the EMAIL MEDIUM ON: `EMAIL_ORG_SUFFIX=.example.com` plus the
 * in-process `fake` provider (outbound captured, inbound injectable) and the
 * inbound seam's bearer. `judge` is left unregistered unless a test asks.
 */
export async function makeEmailServer(
  overrides: Partial<ServerConfig> = {},
): Promise<TestServer> {
  return makeTestServer({
    emailOrgSuffix: '.example.com',
    emailProvider: 'fake',
    emailInboundToken: TEST_INBOUND_TOKEN,
    ...overrides,
  });
}

/** A normalized inbound payload with sane defaults (the edge's verdicts included). */
export function inboundPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rfcMessageId: `<${Math.random().toString(36).slice(2)}@mail.example.net>`,
    from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
    to: [{ email: 'fable@acme.example.com', name: 'fable' }],
    subject: 'Q3 rollout',
    text: 'the body',
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
    ...overrides,
  };
}

/** POST one payload at the inbound seam; returns the parsed `202` body. */
export async function deliverEmail(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/email/inbound',
    headers: auth(TEST_INBOUND_TOKEN),
    payload,
  });
  return { statusCode: res.statusCode, body: res.statusCode === 202 ? res.json() : res.json() };
}

/** Bearer auth header helper (session token or agent key). */
export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface SignedUpHuman {
  token: string;
  userId: string;
  email: string;
}

/**
 * Sign up a human via the password provider and return its session token + id.
 * The FIRST human on a fresh server auto-gets an org (bootstrap).
 */
export async function signup(
  app: FastifyInstance,
  input: { email: string; password?: string; displayName?: string },
): Promise<SignedUpHuman> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      email: input.email,
      password: input.password ?? 'password123',
      displayName: input.displayName,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`signup failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json();
  return { token: body.token as string, userId: body.user.id as string, email: input.email };
}

/** The caller's first org id (from GET /me/orgs). */
export async function firstOrgId(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/me/orgs', headers: auth(token) });
  const items = res.json().items as { org: { id: string } }[];
  if (items.length === 0) throw new Error('no orgs');
  return items[0]!.org.id;
}

/** Enroll+approve `email` into `orgId` as a plain member; returns their creds. */
export async function joinOrg(
  app: FastifyInstance,
  ownerToken: string,
  orgId: string,
  email: string,
  displayName?: string,
): Promise<SignedUpHuman> {
  const inv = await createInvite(app, ownerToken, orgId);
  const member = await signup(app, { email, displayName });
  // Redeeming a valid invite grants membership immediately (a valid invite IS
  // the approval) — no separate approval step.
  const enroll = await app.inject({
    method: 'POST',
    url: `/api/v1/invite/${inv.token}/enroll`,
    headers: auth(member.token),
    payload: {},
  });
  if (enroll.statusCode !== 201) {
    throw new Error(`joinOrg failed (${enroll.statusCode}): ${enroll.body}`);
  }
  return member;
}

/** Create a project room in an org; returns its id. */
export async function createRoom(
  app: FastifyInstance,
  token: string,
  orgId: string,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/rooms`,
    headers: auth(token),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`createRoom failed (${res.statusCode}): ${res.body}`);
  return res.json().room.id as string;
}

/** Create an agent owned by `token`; returns its id + one-time `agk_` key. */
export async function makeAgent(
  app: FastifyInstance,
  token: string,
  orgId: string,
  name: string,
): Promise<{ id: string; key: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/agents',
    headers: auth(token),
    payload: { orgId, name },
  });
  if (res.statusCode !== 201) throw new Error(`makeAgent failed (${res.statusCode}): ${res.body}`);
  return { id: res.json().agent.id as string, key: res.json().key as string };
}

/** Grant `granteeId` visibility on an agent (owner action). */
export async function shareAgent(
  app: FastifyInstance,
  ownerToken: string,
  agentId: string,
  target: string,
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/me/agents/${agentId}/share`,
    headers: auth(ownerToken),
    payload: { human: target },
  });
  if (res.statusCode >= 300) throw new Error(`shareAgent failed (${res.statusCode}): ${res.body}`);
}

/** A parsed SSE event. */
export interface SseEvent {
  event: string;
  data: unknown;
  /** The `id:` field (journal cursor), when the frame carried one. */
  id?: string;
  /** The raw frame block (all lines), for byte-shape assertions. */
  raw?: string;
}

/** A live SSE connection opened against a listening server for tests. */
export interface SseClient {
  events: SseEvent[];
  waitFor(predicate: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves when the stream ends — server-closed or locally aborted. */
  closed: Promise<void>;
  close(): void;
}

/** Start listening (port 0) and return the base origin (`http://127.0.0.1:PORT`). */
export async function listen(ts: TestServer): Promise<string> {
  await ts.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = ts.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

/** Open an SSE stream (auth via `?token=`) and collect its events. */
export async function openSse(
  base: string,
  path: string,
  token?: string,
  headers?: Record<string, string>,
): Promise<SseClient> {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}${token ? `token=${token}` : ''}`;
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers });
  if (!res.ok || !res.body) throw new Error(`SSE open failed (${res.status})`);
  const events: SseEvent[] = [];
  const waiters: { predicate: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let name: string | undefined;
          let data: string | undefined;
          let id: string | undefined;
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
          }
          if (name) {
            const evt: SseEvent = {
              event: name,
              data: data ? JSON.parse(data) : undefined,
              id,
              raw: block,
            };
            events.push(evt);
            for (const w of [...waiters]) {
              if (w.predicate(evt)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(evt);
              }
            }
          }
        }
      }
    } catch {
      /* aborted */
    } finally {
      resolveClosed();
    }
  })();
  return {
    events,
    closed,
    waitFor(predicate, timeoutMs = 1500) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<SseEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timeout')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** Sleep for `ms` milliseconds (presence grace / TTL tests). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create an invite in an org (as `token`); returns the invite id + `ivk_` token. */
export async function createInvite(
  app: FastifyInstance,
  token: string,
  orgId: string,
  note?: string,
): Promise<{ id: string; token: string; url: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/orgs/${orgId}/invites`,
    headers: auth(token),
    payload: note ? { note } : {},
  });
  if (res.statusCode !== 201) {
    throw new Error(`createInvite failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json();
  const url = body.url as string;
  const ivk = url.split('/invite/')[1]!;
  return { id: body.invite.id as string, token: ivk, url };
}
