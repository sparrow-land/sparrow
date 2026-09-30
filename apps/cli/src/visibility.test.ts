import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from './index.js';
import { compact } from './visibility.js';

/* ------------------------------------------------------------------ *
 * Agent visibility commands (tags, messaging, grants, stats) driven
 * in-process against a FAKE /api/v1 server: a small in-memory model of the
 * wire contract (SPEC.md, *Agent visibility*) that records every request,
 * so each test can assert both the output and exactly what went over the wire.
 * ------------------------------------------------------------------ */

const NOW = '2026-09-29T12:00:00.000Z';
const HUMAN_TOKEN = 'ses_human';
const AGENT_TOKEN = 'agk_cubey';

interface FakeAgent {
  id: string;
  name: string;
  tags: string[];
  messaging: 'any' | 'tags' | 'none';
}
interface FakeGrant {
  id: string;
  orgId: string;
  principalId: string;
  principalKind: 'human' | 'agent';
  scope: string;
  grantedBy: string;
  createdAt: string;
}
interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: any;
}
interface Refusal {
  method: string;
  path: string;
  status: number;
  code: string;
  message: string;
  reason?: string;
}

interface Fake {
  url: string;
  agents: FakeAgent[];
  grants: FakeGrant[];
  seen: Seen[];
  refusals: Refusal[];
  /** Whether the governance list (`GET /orgs/:id/agents`) answers the HUMAN caller. */
  humanGovernance: boolean;
  analytics: any;
  close(): Promise<void>;
}

function agentResource(a: FakeAgent) {
  return {
    id: a.id,
    name: a.name,
    orgId: 'org_a',
    emailAddress: null,
    online: false,
    lastSeenAt: null,
    sharing: 'room-members',
    roleTitle: null,
    tags: [...a.tags].sort(),
    messaging: a.messaging,
    createdAt: NOW,
  };
}

const JAKE = { id: 'usr_jake', displayName: 'Jake', email: 'jake@example.com' };
const PAT = { id: 'usr_pat', displayName: 'Pat', email: 'pat@example.com' };

function defaultAnalytics() {
  // Self-consistent, as the server computes it: inDms = withAgents + withHumans,
  // inDms + inRooms = sent + received (messages and tokens alike), and the DM
  // counterparts sum to inDms.
  return {
    window: '7d',
    from: '2026-09-22T12:00:00.000Z',
    to: NOW,
    totals: { sent: 120, received: 80, tokensSent: 30_160, tokensReceived: 12_000 },
    withAgents: { messages: 90, tokens: 22_000 },
    withHumans: { messages: 50, tokens: 8_010 },
    inDms: { messages: 140, tokens: 30_010 },
    inRooms: { messages: 60, tokens: 12_150 },
    counterparts: [
      { kind: 'agent', id: 'agt_rev', name: 'reviewer', messages: 90, tokens: 22_000 },
      { kind: 'human', id: 'usr_jake', name: 'Jake', messages: 50, tokens: 8_010 },
    ],
    rooms: [{ roomId: 'rom_build', name: 'build-crew', messages: 60, tokens: 12_150 }],
    series: [],
  };
}

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: '',
    agents: [
      { id: 'agt_cubey', name: 'cubey', tags: ['cubes'], messaging: 'any' },
      { id: 'agt_rev', name: 'reviewer', tags: ['reviewers'], messaging: 'any' },
      { id: 'agt_quiet', name: 'quiet', tags: [], messaging: 'none' },
    ],
    grants: [
      {
        id: 'grt_one',
        orgId: 'org_a',
        principalId: 'agt_cubey',
        principalKind: 'agent',
        scope: 'tags:*',
        grantedBy: 'usr_jake',
        createdAt: NOW,
      },
    ],
    seen: [],
    refusals: [],
    humanGovernance: true,
    analytics: defaultAnalytics(),
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const p = u.pathname.replace(/^\/api\/v1/, '');
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const auth = req.headers.authorization?.replace(/^Bearer /, '');
      fake.seen.push({ method: req.method!, path: p, query: u.searchParams, auth, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const fail = (status: number, code: string, message: string, reason?: string) =>
        send(status, { error: { code, message, ...(reason ? { reason } : {}) } });

      const refusal = fake.refusals.find((r) => r.method === req.method && r.path === p);
      if (refusal) return fail(refusal.status, refusal.code, refusal.message, refusal.reason);

      const isAgent = auth === AGENT_TOKEN;
      const isHuman = auth === HUMAN_TOKEN;
      if (!isAgent && !isHuman) return fail(401, 'unauthorized', 'Sign-in required');
      const byId = (id: string) => fake.agents.find((a) => a.id === id);

      if (req.method === 'GET' && p === '/me') {
        if (isHuman) return send(200, { principal: { type: 'human', ...JAKE } });
        const me = byId('agt_cubey')!;
        return send(200, {
          principal: {
            type: 'agent',
            id: me.id,
            name: me.name,
            orgId: 'org_a',
            owner: { id: JAKE.id, displayName: JAKE.displayName },
            tags: [...me.tags].sort(),
            messaging: me.messaging,
          },
        });
      }
      if (req.method === 'GET' && p === '/me/orgs') {
        if (isAgent) return fail(401, 'unauthorized', 'Sign-in required');
        return send(200, { items: [{ org: { id: 'org_a', name: 'Acme', slug: 'acme' }, role: 'owner' }] });
      }
      if (req.method === 'GET' && p === '/me/agents') {
        if (isAgent) return fail(401, 'unauthorized', 'Sign-in required');
        // Jake owns cubey and reviewer; quiet is NOT in his visibility list.
        return send(200, {
          items: fake.agents
            .filter((a) => a.id !== 'agt_quiet')
            .map((a) => ({ agent: agentResource(a), owner: { id: JAKE.id, displayName: 'Jake' }, sharedBy: null })),
        });
      }
      if (req.method === 'GET' && p === '/orgs/org_a/agents') {
        if (isAgent || !fake.humanGovernance) return fail(403, 'forbidden', 'Org owners/admins only');
        return send(200, {
          items: fake.agents.map((a) => ({
            agent: { id: a.id, name: a.name, emailAddress: null, tags: [...a.tags].sort(), messaging: a.messaging, createdAt: NOW },
            owner: { id: JAKE.id, displayName: 'Jake' },
          })),
        });
      }
      if (req.method === 'GET' && p === '/me/rooms') {
        return send(200, {
          items: [
            {
              room: { id: 'rom_build', name: 'build-crew', orgId: 'org_a', kind: 'project', archivedAt: null },
              memberId: 'mem_self',
              roomRole: 'member',
            },
          ],
        });
      }
      if (req.method === 'GET' && p === '/rooms/rom_build/members') {
        const m = (id: string, kind: string, principalId: string, displayName: string) => ({
          id,
          kind,
          principalId,
          displayName,
          roomRole: 'member',
          lastSeenAt: null,
          createdAt: NOW,
        });
        return send(200, {
          items: [
            m('mem_self', 'agent', 'agt_cubey', 'cubey'),
            m('mem_rev', 'agent', 'agt_rev', 'reviewer'),
            m('mem_quiet', 'agent', 'agt_quiet', 'quiet'),
            m('mem_pat', 'human', 'usr_pat', 'Pat'),
          ],
          nextCursor: null,
        });
      }
      if (req.method === 'GET' && p === '/orgs/org_a/directory') {
        const q = (u.searchParams.get('q') ?? '').toLowerCase();
        return send(200, {
          items: [JAKE, PAT].filter(
            (h) => !q || h.email.startsWith(q) || h.displayName.toLowerCase().startsWith(q),
          ),
        });
      }
      let m = p.match(/^\/orgs\/org_a\/agents\/(agt_[^/]+)$/);
      if (req.method === 'GET' && m) {
        const a = byId(m[1]!);
        if (!a) return fail(404, 'not_found', 'No such agent');
        return send(200, { agent: agentResource(a), owner: { id: JAKE.id, displayName: 'Jake' } });
      }
      m = p.match(/^\/orgs\/org_a\/agents\/([^/]+)\/tags$/);
      if (req.method === 'PUT' && m) {
        const a = byId(m[1]!);
        if (!a) return fail(404, 'not_found', 'No such agent');
        a.tags = [...body.tags];
        return send(200, { agent: agentResource(a) });
      }
      m = p.match(/^\/orgs\/org_a\/agents\/([^/]+)\/messaging$/);
      if (req.method === 'PUT' && m) {
        const a = byId(m[1]!);
        if (!a) return fail(404, 'not_found', 'No such agent');
        a.messaging = body.messaging;
        return send(200, { agent: agentResource(a) });
      }
      m = p.match(/^\/orgs\/org_a\/agents\/([^/]+)\/analytics$/);
      if (req.method === 'GET' && m) {
        return send(200, { ...fake.analytics, window: u.searchParams.get('window') });
      }
      if (req.method === 'GET' && p === '/orgs/org_a/grants') return send(200, { items: fake.grants });
      if (req.method === 'POST' && p === '/orgs/org_a/grants') {
        const existing = fake.grants.find((g) => g.principalId === body.principalId && g.scope === body.scope);
        if (existing) return send(200, { grant: existing });
        const grant: FakeGrant = {
          id: `grt_${fake.grants.length + 1}`,
          orgId: 'org_a',
          principalId: body.principalId,
          principalKind: body.principalId.startsWith('usr_') ? 'human' : 'agent',
          scope: body.scope,
          grantedBy: isAgent ? 'agt_cubey' : 'usr_jake',
          createdAt: NOW,
        };
        fake.grants.push(grant);
        return send(201, { grant });
      }
      m = p.match(/^\/orgs\/org_a\/grants\/([^/]+)$/);
      if (req.method === 'DELETE' && m) {
        fake.grants = fake.grants.filter((g) => g.id !== m![1]);
        return send(200, { ok: true });
      }
      return fail(404, 'not_found', `no route ${req.method} ${p}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

/* ------------------------------ harness ------------------------------ */

let fake: Fake;
let configDir: string;
let stateDir: string;

beforeEach(async () => {
  fake = await startFake();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-vis-cfg-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-vis-state-'));
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function envFor(token: string) {
  return {
    XDG_CONFIG_HOME: configDir,
    HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
    PATH: process.env.PATH,
    SPARROW_SERVER: fake.url,
    SPARROW_TOKEN: token,
  };
}

async function run(who: 'human' | 'agent', ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    prompt: async () => '',
  } as CliIO;
  const code = await runCli([...argv], envFor(who === 'human' ? HUMAN_TOKEN : AGENT_TOKEN), io);
  return { code, out: out.join(''), err: err.join('') };
}

const writes = () => fake.seen.filter((s) => s.method !== 'GET');
const refuse = (r: Omit<Refusal, 'code' | 'status'> & { status?: number; code?: string }) =>
  fake.refusals.push({ status: 403, code: 'forbidden', ...r });

/* ------------------------------- tags -------------------------------- */

describe('sparrow tags', () => {
  it('with no agent lists the calling agent’s own tags, with its id inline', async () => {
    const r = await run('agent', 'tags');
    expect(r.code).toBe(0);
    expect(r.out).toContain('cubey (agt_cubey)');
    expect(r.out).toContain('cubes');
    expect(r.out).toMatch(/messaging:\s+any/);
  });

  it('-j prints the agent id, name, tags and messaging', async () => {
    const r = await run('agent', 'tags', '-j');
    expect(JSON.parse(r.out)).toEqual({ agentId: 'agt_cubey', name: 'cubey', tags: ['cubes'], messaging: 'any' });
  });

  it('a human names the agent (by name, from the visibility list)', async () => {
    const r = await run('human', 'tags', 'reviewer');
    expect(r.code).toBe(0);
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toContain('reviewers');
  });

  it('a human falls back to the org governance list for an agent outside their visibility list', async () => {
    const r = await run('human', 'tags', 'quiet');
    expect(r.code).toBe(0);
    expect(r.out).toContain('quiet (agt_quiet)');
    expect(r.out).toContain('(none)');
    expect(r.out).toMatch(/messaging:\s+none/);
  });

  it('a human with no agent argument is told to name one', async () => {
    const r = await run('human', 'tags');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/name an agent/i);
  });

  it('tags add computes the new set client-side and PUTs it (sorted, deduped, lowercased)', async () => {
    const r = await run('human', 'tags', 'add', 'reviewer', 'Cubes', 'leads', 'reviewers');
    expect(r.code).toBe(0);
    const put = writes();
    expect(put).toHaveLength(1);
    expect(put[0]!.method).toBe('PUT');
    expect(put[0]!.path).toBe('/orgs/org_a/agents/agt_rev/tags');
    expect(put[0]!.body).toEqual({ tags: ['cubes', 'leads', 'reviewers'] });
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toContain('cubes, leads, reviewers');
    expect(r.out).toMatch(/added: cubes, leads/);
  });

  it('tags rm removes only the named tags', async () => {
    fake.agents[1]!.tags = ['cubes', 'reviewers'];
    const r = await run('human', 'tags', 'rm', 'agt_rev', 'cubes');
    expect(r.code).toBe(0);
    expect(writes()[0]!.body).toEqual({ tags: ['reviewers'] });
    expect(r.out).toMatch(/removed: cubes/);
  });

  it('tags set replaces the whole set without needing to read it first', async () => {
    const r = await run('agent', 'tags', 'set', 'agt_quiet', 'cubes', 'ops', '-j');
    expect(r.code).toBe(0);
    expect(writes()[0]!.body).toEqual({ tags: ['cubes', 'ops'] });
    expect(JSON.parse(r.out).agent.tags).toEqual(['cubes', 'ops']);
  });

  it('an agent resolves another agent by name through its rooms and edits its tags', async () => {
    const r = await run('agent', 'tags', 'add', 'reviewer', 'cubes');
    expect(r.code).toBe(0);
    expect(fake.seen.some((x) => x.method === 'GET' && x.path === '/orgs/org_a/agents/agt_rev')).toBe(true);
    expect(writes()[0]).toMatchObject({ path: '/orgs/org_a/agents/agt_rev/tags', body: { tags: ['cubes', 'reviewers'] } });
    expect(r.out).toMatch(/added: cubes/);
  });

  it('an agent lists another agent’s tags read from GET /orgs/:org/agents/:id', async () => {
    fake.agents[1]!.tags = ['ops', 'reviewers'];
    fake.agents[1]!.messaging = 'tags';
    const r = await run('agent', 'tags', 'reviewer');
    expect(r.code).toBe(0);
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toContain('ops, reviewers');
    expect(r.out).toMatch(/messaging:\s+tags/);
  });

  it('reads current tags fresh from the single-agent route, not a stale list', async () => {
    // A human's lists would say ['reviewers']; the single-agent route is the truth.
    const r0 = await run('human', 'tags', 'rm', 'reviewer', 'reviewers');
    expect(r0.code).toBe(0);
    expect(fake.seen.some((x) => x.method === 'GET' && x.path === '/orgs/org_a/agents/agt_rev')).toBe(true);
    expect(writes()[0]!.body).toEqual({ tags: [] });
  });

  it('an unknown agt_ id surfaces the 404', async () => {
    const r = await run('human', 'tags', 'agt_ghost');
    expect(r.code).toBe(1);
    expect(r.err).toContain('No such agent');
  });

  it('a no-op add PUTs nothing and says so', async () => {
    const r = await run('human', 'tags', 'add', 'reviewer', 'reviewers');
    expect(r.code).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(r.out).toMatch(/unchanged/i);
  });

  it('rejects an invalid tag slug before calling the server', async () => {
    const r = await run('human', 'tags', 'add', 'reviewer', 'no spaces!');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid tag/i);
    expect(writes()).toHaveLength(0);
  });

  it('rejects more than 10 tags before calling the server', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const r = await run('human', 'tags', 'set', 'reviewer', ...many);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/at most 10/);
    expect(writes()).toHaveLength(0);
  });

  it('-j prints the same { agent, changed } shape on a no-op and on a change', async () => {
    const noop = JSON.parse((await run('human', 'tags', 'add', 'reviewer', 'reviewers', '-j')).out);
    expect(Object.keys(noop).sort()).toEqual(['agent', 'changed']);
    expect(noop.changed).toBe(false);
    expect(noop.agent).toMatchObject({ id: 'agt_rev', name: 'reviewer', tags: ['reviewers'], messaging: 'any' });
    const changed = JSON.parse((await run('human', 'tags', 'add', 'reviewer', 'ops', '-j')).out);
    expect(Object.keys(changed).sort()).toEqual(['agent', 'changed']);
    expect(changed.changed).toBe(true);
    expect(changed.agent).toMatchObject({ id: 'agt_rev', name: 'reviewer', tags: ['ops', 'reviewers'], messaging: 'any' });
    const setNoop = JSON.parse((await run('human', 'tags', 'set', 'reviewer', 'ops', 'reviewers', '-j')).out);
    expect(Object.keys(setNoop).sort()).toEqual(['agent', 'changed']);
    expect(setNoop.changed).toBe(false);
  });

  it('tags set reads the current tags fresh, so a stale list never fakes a no-op', async () => {
    fake.agents[1]!.tags = ['ops', 'reviewers']; // the lists would agree; the point is the fresh read
    const r = await run('human', 'tags', 'set', 'reviewer', 'reviewers');
    expect(r.code).toBe(0);
    expect(fake.seen.some((x) => x.method === 'GET' && x.path === '/orgs/org_a/agents/agt_rev')).toBe(true);
    expect(writes()[0]!.body).toEqual({ tags: ['reviewers'] });
  });

  it('a human who cannot list the agent by name is told to pass its agt_ id', async () => {
    fake.humanGovernance = false; // a grant holder, not an admin: no governance list
    const r = await run('human', 'tags', 'quiet');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/agt_ id/);
    // …and the id works: the single-agent read is open to any org member.
    const byId = await run('human', 'tags', 'agt_quiet');
    expect(byId.code).toBe(0);
    expect(byId.out).toContain('quiet (agt_quiet)');
  });

  it('tags set with an empty set is refused (use rm to clear)', async () => {
    const r = await run('human', 'tags', 'set', 'reviewer');
    expect(r.code).toBe(1);
  });
});

/* ----------------------------- 403 hints ----------------------------- */

describe('403 refusals print the server message plus one plain hint', () => {
  it('self', async () => {
    refuse({ method: 'PUT', path: '/orgs/org_a/agents/agt_cubey/tags', message: 'You cannot change your own tags', reason: 'self' });
    const r = await run('agent', 'tags', 'add', 'cubey', 'ops');
    expect(r.code).toBe(1);
    expect(r.err).toContain('You cannot change your own tags');
    expect(r.err).toContain("you can't change your own settings");
  });

  it('outranked', async () => {
    refuse({ method: 'PUT', path: '/orgs/org_a/agents/agt_rev/messaging', message: 'reviewer holds tags:*', reason: 'outranked' });
    const r = await run('human', 'messaging', 'reviewer', 'none');
    expect(r.code).toBe(1);
    expect(r.err).toContain('reviewer holds tags:*');
    expect(r.err).toContain("that agent holds permissions you don't");
  });

  it('grant_required', async () => {
    refuse({ method: 'POST', path: '/orgs/org_a/grants', message: 'You do not hold tag:ops', reason: 'grant_required' });
    const r = await run('human', 'grants', 'add', 'reviewer', 'tag:ops');
    expect(r.code).toBe(1);
    expect(r.err).toContain('You do not hold tag:ops');
    expect(r.err).toContain('you need a grant for that tag — ask an org admin');
  });

  it('-j carries the reason and hint in the error envelope', async () => {
    refuse({ method: 'PUT', path: '/orgs/org_a/agents/agt_cubey/tags', message: 'no', reason: 'self' });
    const r = await run('agent', 'tags', 'set', 'cubey', 'ops', '-j');
    expect(JSON.parse(r.err)).toEqual({
      error: { code: 'forbidden', message: 'no', reason: 'self', hint: "you can't change your own settings" },
    });
  });

  it('messaging_policy on dm prints the server message, nothing more', async () => {
    refuse({ method: 'POST', path: '/me/dms', message: "reviewer's messaging is set to tags and you share no tag", reason: 'messaging_policy' });
    const r = await run('agent', 'dm', 'agt_rev', 'hello');
    expect(r.code).toBe(1);
    expect(r.err).toBe("Error: reviewer's messaging is set to tags and you share no tag\n");
  });

  it('messaging_policy on send prints the server message, nothing more', async () => {
    refuse({ method: 'POST', path: '/rooms/room_dm/messages', message: "cubey's messaging is set to none", reason: 'messaging_policy' });
    const r = await run('agent', 'send', '--room', 'room_dm', 'hi');
    expect(r.code).toBe(1);
    expect(r.err).toBe("Error: cubey's messaging is set to none\n");
  });
});

/* ----------------------------- messaging ----------------------------- */

describe('sparrow messaging', () => {
  it('an agent can read another agent’s policy', async () => {
    fake.agents[2]!.messaging = 'none';
    const r = await run('agent', 'messaging', 'quiet');
    expect(r.code).toBe(0);
    expect(r.out).toContain('quiet (agt_quiet) messaging: none');
  });

  it('shows the current policy with a plain explanation', async () => {
    const r = await run('human', 'messaging', 'reviewer');
    expect(r.code).toBe(0);
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toMatch(/messaging: any/);
    expect(writes()).toHaveLength(0);
  });

  it('sets the policy', async () => {
    const r = await run('human', 'messaging', 'reviewer', 'tags');
    expect(r.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'PUT', path: '/orgs/org_a/agents/agt_rev/messaging', body: { messaging: 'tags' } });
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toMatch(/messaging: tags/);
    expect(r.out).toContain('reviewers');
  });

  it('-j prints the updated agent', async () => {
    const r = await run('human', 'messaging', 'reviewer', 'none', '-j');
    expect(JSON.parse(r.out).agent).toMatchObject({ id: 'agt_rev', messaging: 'none' });
  });

  it('rejects a value other than any|tags|none', async () => {
    const r = await run('human', 'messaging', 'reviewer', 'some');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/any, tags or none/);
    expect(writes()).toHaveLength(0);
  });

  it('an agent can set another agent’s policy by name (resolved through its rooms)', async () => {
    const r = await run('agent', 'messaging', 'quiet', 'any');
    expect(r.code).toBe(0);
    expect(writes()[0]!.path).toBe('/orgs/org_a/agents/agt_quiet/messaging');
  });
});

/* ------------------------------- grants ------------------------------ */

describe('sparrow grants', () => {
  it('lists grants with ids inline and principal names where known', async () => {
    for (const argv of [['grants'], ['grants', 'ls']]) {
      const r = await run('human', ...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('grt_one');
      expect(r.out).toContain('cubey (agt_cubey)');
      expect(r.out).toContain('tags:*');
      expect(r.out).toContain('Jake (usr_jake)');
    }
  });

  it('-j prints { items }', async () => {
    const r = await run('agent', 'grants', '-j');
    expect(JSON.parse(r.out).items[0].id).toBe('grt_one');
  });

  it('says so when there are none', async () => {
    fake.grants = [];
    const r = await run('human', 'grants');
    expect(r.out).toMatch(/no grants/i);
  });

  it('add resolves an agent name and posts the scope', async () => {
    const r = await run('human', 'grants', 'add', 'reviewer', 'tag:cubes');
    expect(r.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/orgs/org_a/grants', body: { principalId: 'agt_rev', scope: 'tag:cubes' } });
    expect(r.out).toContain('grt_2');
    expect(r.out).toContain('reviewer (agt_rev)');
    expect(r.out).toContain('tag:cubes');
  });

  it('add resolves a human by email', async () => {
    const r = await run('human', 'grants', 'add', 'pat@example.com', 'tags:*');
    expect(r.code).toBe(0);
    expect(writes()[0]!.body).toEqual({ principalId: 'usr_pat', scope: 'tags:*' });
  });

  it('add resolves a human by name', async () => {
    const r = await run('human', 'grants', 'add', 'Pat', 'tag:ops');
    expect(r.code).toBe(0);
    expect(writes()[0]!.body).toEqual({ principalId: 'usr_pat', scope: 'tag:ops' });
  });

  it('add rejects a malformed scope before calling the server', async () => {
    const r = await run('human', 'grants', 'add', 'reviewer', 'cubes');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/tags:\*.*tag:<slug>/);
    expect(writes()).toHaveLength(0);
  });

  it('add of a grant that already exists says "Already granted"', async () => {
    const r = await run('human', 'grants', 'add', 'agt_cubey', 'tags:*');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Already granted tags:\* to agt_cubey — grt_one\./);
    expect(r.out).not.toMatch(/^Granted/m);
    const j = JSON.parse((await run('human', 'grants', 'add', 'agt_cubey', 'tags:*', '-j')).out);
    expect(j).toMatchObject({ grant: { id: 'grt_one' }, created: false });
    const fresh = JSON.parse((await run('human', 'grants', 'add', 'agt_rev', 'tag:ops', '-j')).out);
    expect(fresh).toMatchObject({ grant: { principalId: 'agt_rev', scope: 'tag:ops' }, created: true });
  });

  it('rm help names who may revoke: admins, the creator, or the holder giving it up', async () => {
    const r = await run('human', 'grants', 'rm', '--help');
    expect(r.out + r.err).toMatch(/holder/i);
    expect(r.out + r.err).toMatch(/creat/i);
  });

  it('rm deletes by grant id', async () => {
    const r = await run('human', 'grants', 'rm', 'grt_one');
    expect(r.code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: '/orgs/org_a/grants/grt_one' });
    expect(r.out).toContain('grt_one');
    expect(fake.grants).toHaveLength(0);
  });
});

/* -------------------------------- stats ------------------------------ */

describe('sparrow stats', () => {
  it('defaults to yourself and a 7d window', async () => {
    const r = await run('agent', 'stats');
    expect(r.code).toBe(0);
    const get = fake.seen.find((s) => s.path.endsWith('/analytics'))!;
    expect(get.path).toBe('/orgs/org_a/agents/agt_cubey/analytics');
    expect(get.query.get('window')).toBe('7d');
  });

  it('prints totals, splits, top counterparts and rooms, and the estimate note', async () => {
    const r = await run('human', 'stats', 'reviewer', '--window', '30d');
    expect(r.code).toBe(0);
    expect(fake.seen.find((s) => s.path.endsWith('/analytics'))!.query.get('window')).toBe('30d');
    const o = r.out;
    expect(o).toContain('reviewer (agt_rev)');
    expect(o).toMatch(/last 30 days/);
    expect(o).toMatch(/sent\s+120\s+~30\.2k/);
    expect(o).toMatch(/received\s+80\s+~12k/);
    expect(o).toMatch(/with agents\s+90\s+~22k/);
    expect(o).toMatch(/with humans\s+50/);
    expect(o).toMatch(/in DMs\s+140/);
    expect(o).toMatch(/in rooms\s+60/);
    expect(o).toContain('agt_rev');
    expect(o).toContain('usr_jake');
    expect(o).toContain('build-crew');
    expect(o).toContain('rom_build');
    expect(o).toMatch(/tokens are estimated from message text/i);
  });

  it('-j prints the raw report', async () => {
    const r = await run('agent', 'stats', '-j', '--window', 'all');
    const json = JSON.parse(r.out);
    expect(json.window).toBe('all');
    expect(json.totals.sent).toBe(120);
  });

  it('rejects an unknown window', async () => {
    const r = await run('agent', 'stats', '--window', '1y');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/24h, 7d, 30d or all/);
  });

  it('a human with no agent is told to name one', async () => {
    const r = await run('human', 'stats');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/name an agent/i);
  });

  it('an empty window says so instead of printing empty tables', async () => {
    fake.analytics = {
      ...defaultAnalytics(),
      totals: { sent: 0, received: 0, tokensSent: 0, tokensReceived: 0 },
      withAgents: { messages: 0, tokens: 0 },
      withHumans: { messages: 0, tokens: 0 },
      inDms: { messages: 0, tokens: 0 },
      inRooms: { messages: 0, tokens: 0 },
      counterparts: [],
      rooms: [],
    };
    const r = await run('agent', 'stats', '--window', '24h');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no messages/i);
  });
});

describe('compact', () => {
  it('abbreviates thousands and millions, rolling over at the rounding boundary', () => {
    expect(compact(999)).toBe('999');
    expect(compact(1000)).toBe('1k');
    expect(compact(30_160)).toBe('30.2k');
    expect(compact(999_949)).toBe('999.9k');
    expect(compact(999_950)).toBe('1M');
    expect(compact(999_999)).toBe('1M');
    expect(compact(1_000_000)).toBe('1M');
    expect(compact(1_250_000)).toBe('1.3M');
  });
});
