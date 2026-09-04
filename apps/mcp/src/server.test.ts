import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '@sparrow/api';
import { SparrowClient } from '@sparrow/client';
import { deriveDefaultAgentName } from '@sparrow/common-types/identity';
import { clientBuildVersion } from '@sparrow/client';
import { VOICE_REGISTER_NOTE } from '@sparrow/common-types';
import { createMcpServer, TOOL_NAMES, type McpServerDeps } from './server.js';
import { credentialsPath } from './credentials.js';
import type { Env } from './config.js';

/* ---------------------------- test harness -------------------------------- */

interface Closer {
  close: () => Promise<void>;
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const ADMIN_TOKEN = 'test-admin-token';
let emailSeq = 0;
const email = (name = 'user') => `${name}-${Date.now()}-${emailSeq++}@example.com`;

interface Api {
  url: string;
}

/** Start a real in-process API on an ephemeral port, backed by a temp SQLite db. */
async function startApi(): Promise<Api> {
  const dataDir = tmpDir('sparrow-mcp-data-');
  const app = buildServer({ dataDir, baseUrl: 'http://localhost:8722', adminToken: ADMIN_TOKEN });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const addr = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}` };
}

interface Owner {
  client: SparrowClient;
  orgId: string;
  userId: string;
}

/** Sign up the FIRST human (bootstraps an org) and return the owner context. */
async function bootstrapOwner(api: Api): Promise<Owner> {
  const client = new SparrowClient({ server: api.url });
  const res = await client.signup({ email: email('owner'), password: 'password123', displayName: 'Owner' });
  const orgId = (await client.meOrgs())[0]!.org.id;
  return { client, orgId, userId: res.user.id };
}

/** A room with two owned agents attached; returns the room id + agent keys/ids. */
interface Scene {
  api: Api;
  owner: Owner;
  roomId: string;
  alice: { id: string; key: string };
  bob: { id: string; key: string };
}

async function scene(): Promise<Scene> {
  const api = await startApi();
  const owner = await bootstrapOwner(api);
  const room = await owner.client.createRoom(owner.orgId, { name: 'proj' });
  const a = await owner.client.createAgent({ orgId: owner.orgId, name: 'alice' });
  const b = await owner.client.createAgent({ orgId: owner.orgId, name: 'bob' });
  await owner.client.addMember(room.id, a.agent.id);
  await owner.client.addMember(room.id, b.agent.id);
  return {
    api,
    owner,
    roomId: room.id,
    alice: { id: a.agent.id, key: a.key },
    bob: { id: b.agent.id, key: b.key },
  };
}

/** Build an invite URL rooted at the real (ephemeral) server origin. */
async function inviteUrl(owner: Owner, api: Api): Promise<string> {
  const inv = await owner.client.createInvite(owner.orgId);
  const token = inv.url.split('/invite/')[1]!;
  return `${api.url}/invite/${token}`;
}

async function connectMcp(deps: McpServerDeps): Promise<Client & Closer> {
  const server = createMcpServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const closer = client as Client & Closer;
  const origClose = closer.close.bind(closer);
  closer.close = async () => {
    await origClose();
    await server.close();
  };
  cleanups.push(() => closer.close());
  return closer;
}

interface ParsedResult {
  isError: boolean;
  data: any;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ParsedResult> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = res.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(res.isError), data };
}

/* ---------------------------- tests --------------------------------------- */

describe('serverInfo', () => {
  it('reports the shared client build version (not a hard-coded 0.1.0)', async () => {
    const api = await startApi();
    const client = await connectMcp({ server: api.url });
    const info = client.getServerVersion();
    expect(info?.name).toBe('sparrow');
    expect(info?.version).toBe(clientBuildVersion());
    // Non-bundled test runs report `<pkg>+dev`.
    expect(info?.version).toContain('+dev');
  });
});

describe('tools/list', () => {
  it('exposes all tools with input schemas and no purged vocabulary', async () => {
    const api = await startApi();
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(TOOL_NAMES.length);
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.inputSchema, `${t.name} schema`).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
      // v3 vocabulary: "room"/"member", never "channel" or "identity"/"request_join".
      expect(JSON.stringify(t), `${t.name} must not mention "channel"`).not.toMatch(/channel/i);
      expect(JSON.stringify(t), `${t.name} must not mention "request_join"`).not.toMatch(/request_join/);
    }
  });

  /**
   * EVERY tool that can hand back a message must teach the voice register — the
   * unified `pop_next_work_item` is the one an agent runtime actually drains, so
   * leaving it out was the gap. All three carry `VOICE_REGISTER_NOTE` VERBATIM
   * (the same sentence the CLI prints, the docs serve, SKILL.md states and the
   * `voice-is-a-different-register` hint delivers), so the surfaces cannot drift.
   */
  it('every message-returning tool coaches a speakable reply for voice origin', async () => {
    const api = await startApi();
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    for (const name of ['pop_next_work_item', 'pop_next_message', 'read_message']) {
      const desc = tools.find((t) => t.name === name)?.description ?? '';
      expect(desc, `${name} voice guidance`).toMatch(/origin 'voice'/);
      expect(desc, `${name} speakable guidance`).toMatch(/speakable/);
      expect(desc, `${name} carries the canonical note`).toContain(VOICE_REGISTER_NOTE);
    }
  });

  it('tools that never hand back a message do NOT carry the voice note', async () => {
    // The note is guidance for answering a spoken sender; on a listing or a
    // read-receipt tool it would be noise in a description an agent must parse.
    const api = await startApi();
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    for (const name of ['list_members', 'get_message_status', 'set_status']) {
      const desc = tools.find((t) => t.name === name)?.description ?? '';
      expect(desc, `${name}`).not.toContain(VOICE_REGISTER_NOTE);
    }
  });
});

describe('enroll', () => {
  it('open policy: mints instantly, saves an agent profile, and adopts the owner DM room', async () => {
    const api = await startApi();
    const owner = await bootstrapOwner(api);
    // Flip the org to admit agents instantly.
    const org = await owner.client.getOrg(owner.orgId);
    await owner.client.updateOrg(owner.orgId, {
      settings: { ...org.settings, enroll: { ...org.settings.enroll, agents: 'open' } },
    });
    const url = await inviteUrl(owner, api);

    const xdg = tmpDir('sparrow-mcp-xdg-');
    const env: Env = { XDG_CONFIG_HOME: xdg };
    const agent = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });

    const res = await call(agent, 'enroll', { url, name: 'deploybot' });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('approved');
    expect(res.data.agent.name).toBe('deploybot');
    expect(res.data.dmRoomId).toMatch(/^room_/);
    expect(res.data.profile).toBeTruthy();

    // FIRST profile on a fresh machine: nothing to protect, so it takes the default.
    expect(res.data.defaultProfile).toBe(res.data.profile);
    expect(res.data.defaultProfileChanged).toBe(true);
    expect(res.data.note).toBe(`defaultProfile: "${res.data.profile}"`);

    // Profile persisted in v3 shape ({ server, token: agk_, kind: 'agent' }).
    const creds = JSON.parse(fs.readFileSync(credentialsPath(env), 'utf8'));
    expect(creds.defaultProfile).toBe(res.data.profile);
    const prof = creds.profiles[res.data.profile];
    expect(prof.server).toBe(api.url);
    expect(prof.token).toMatch(/^agk_/);
    expect(prof.kind).toBe('agent');

    // The live client now acts as the agent in the adopted owner DM room.
    const members = await call(agent, 'list_members');
    expect(members.isError).toBe(false);
    expect(members.data).toHaveLength(2);
    expect(members.data.some((m: any) => m.principalId === res.data.agent.id)).toBe(true);
  });

  it('default name derives the slugified {host}-{folder} when omitted (v4: email-safe)', async () => {
    const api = await startApi();
    const owner = await bootstrapOwner(api);
    const org = await owner.client.getOrg(owner.orgId);
    await owner.client.updateOrg(owner.orgId, {
      settings: { ...org.settings, enroll: { ...org.settings.enroll, agents: 'open' } },
    });
    const url = await inviteUrl(owner, api);
    const env: Env = { XDG_CONFIG_HOME: tmpDir('sparrow-mcp-xdg-') };
    const cwd = tmpDir('sparrow-mcp-cwd-');
    const agent = await connectMcp({ server: api.url, env, cwd });

    const res = await call(agent, 'enroll', { url });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('approved');
    // v4 names are email-safe by construction: lowercase `[a-z0-9._-]`, no colons
    // or slashes, and they are exactly what the shared `deriveDefaultAgentName`
    // helper proposes for this cwd.
    expect(res.data.agent.name).toBe(deriveDefaultAgentName(cwd));
    expect(res.data.agent.name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(res.data.agent.name).not.toContain(':');
    expect(res.data.agent.name).toContain('-');
  });

  /**
   * One machine, several agents, ONE credentials.json. A second enrollment must
   * NOT silently re-point the other agents' bare commands at this workspace, so
   * `defaultProfile` moves only when it is unambiguously right.
   */
  describe('defaultProfile is not stolen by a second enrollment', () => {
    /** An org admitting agents instantly, plus a reusable invite URL factory. */
    async function openOrg(): Promise<{ api: Api; owner: Owner; invite: () => Promise<string> }> {
      const api = await startApi();
      const owner = await bootstrapOwner(api);
      const org = await owner.client.getOrg(owner.orgId);
      await owner.client.updateOrg(owner.orgId, {
        settings: { ...org.settings, enroll: { ...org.settings.enroll, agents: 'open' } },
      });
      return { api, owner, invite: () => inviteUrl(owner, api) };
    }

    it('a second enroll KEEPS the existing default and says how to address itself', async () => {
      const { api, invite } = await openOrg();
      const xdg = tmpDir('sparrow-mcp-xdg-');
      const env: Env = { XDG_CONFIG_HOME: xdg };

      const first = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });
      const one = await call(first, 'enroll', { url: await invite(), name: 'firstbot' });
      expect(one.isError).toBe(false);
      expect(one.data.profile).toBe('firstbot');

      const second = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });
      const two = await call(second, 'enroll', { url: await invite(), name: 'secondbot' });
      expect(two.isError).toBe(false);
      expect(two.data.profile).toBe('secondbot');
      expect(two.data.defaultProfile).toBe('firstbot');
      expect(two.data.defaultProfileChanged).toBe(false);
      expect(two.data.note).toBe(
        'defaultProfile stays "firstbot" \u2014 pass --profile secondbot ' +
          '(or SPARROW_PROFILE=secondbot) on commands for this workspace, or re-run with set_default.',
      );

      const creds = JSON.parse(fs.readFileSync(credentialsPath(env), 'utf8'));
      expect(creds.defaultProfile).toBe('firstbot');
      expect(Object.keys(creds.profiles).sort()).toEqual(['firstbot', 'secondbot']);
    });

    it('set_default: true moves the default, and reports old \u2192 new', async () => {
      const { api, invite } = await openOrg();
      const xdg = tmpDir('sparrow-mcp-xdg-');
      const env: Env = { XDG_CONFIG_HOME: xdg };

      const first = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });
      await call(first, 'enroll', { url: await invite(), name: 'firstbot' });

      const second = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });
      const two = await call(second, 'enroll', {
        url: await invite(),
        name: 'secondbot',
        set_default: true,
      });
      expect(two.isError).toBe(false);
      expect(two.data.defaultProfile).toBe('secondbot');
      expect(two.data.defaultProfileChanged).toBe(true);
      expect(two.data.note).toBe('defaultProfile: "firstbot" \u2192 "secondbot"');
      expect(JSON.parse(fs.readFileSync(credentialsPath(env), 'utf8')).defaultProfile).toBe(
        'secondbot',
      );
    });

    it('a DANGLING default (its profile is gone) is replaced by the new profile', async () => {
      const { api, invite } = await openOrg();
      const xdg = tmpDir('sparrow-mcp-xdg-');
      const env: Env = { XDG_CONFIG_HOME: xdg };
      fs.mkdirSync(path.dirname(credentialsPath(env)), { recursive: true });
      fs.writeFileSync(
        credentialsPath(env),
        JSON.stringify({ profiles: {}, defaultProfile: 'ghost' }, null, 2),
      );

      const agent = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });
      const res = await call(agent, 'enroll', { url: await invite(), name: 'realbot' });
      expect(res.isError).toBe(false);
      expect(res.data.defaultProfile).toBe('realbot');
      expect(res.data.defaultProfileChanged).toBe(true);
      expect(res.data.note).toBe('defaultProfile: "ghost" \u2192 "realbot"');
    });
  });

  it('approval policy: waitSeconds=0 returns pending immediately', async () => {
    const api = await startApi();
    const owner = await bootstrapOwner(api);
    const url = await inviteUrl(owner, api);
    const env: Env = { XDG_CONFIG_HOME: tmpDir('sparrow-mcp-xdg-') };
    const agent = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });

    const pending = await call(agent, 'enroll', { url, name: 'gatebot', waitSeconds: 0 });
    expect(pending.isError).toBe(false);
    expect(pending.data.status).toBe('pending');
    expect(pending.data.enrollment.id).toMatch(/^enl_/);
  });

  it('approval policy: a request approved mid-wait resolves and saves the profile', async () => {
    const api = await startApi();
    const owner = await bootstrapOwner(api);
    const url = await inviteUrl(owner, api);
    const env: Env = { XDG_CONFIG_HOME: tmpDir('sparrow-mcp-xdg-'), SPARROW_POLL_INTERVAL_MS: '15' };
    const agent = await connectMcp({ server: api.url, env, cwd: tmpDir('sparrow-mcp-cwd-') });

    const callP = call(agent, 'enroll', { url, name: 'gatebot', waitSeconds: 5 });
    const deadline = Date.now() + 3000;
    for (;;) {
      const items = await owner.client.listEnrollments(owner.orgId);
      const mine = items.find((e) => e.proposedName === 'gatebot');
      if (mine) {
        await owner.client.approveEnrollment(owner.orgId, mine.id);
        break;
      }
      if (Date.now() >= deadline) throw new Error('enrollment never appeared');
      await new Promise((r) => setTimeout(r, 10));
    }

    const done = await callP;
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('approved');
    expect(done.data.agent.name).toBe('gatebot');

    const who = await call(agent, 'list_members');
    expect(who.isError).toBe(false);
    expect(who.data.some((m: any) => m.principalId === done.data.agent.id)).toBe(true);
  });
});

describe('send / pop roundtrip', () => {
  it('delivers a room message the recipient can pop; sender sees it read', async () => {
    const s = await scene();
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    // `to` is accepted-and-ignored; a project-room message is a broadcast to the
    // whole room (here just Bob), which he can pop.
    const sent = await call(alice, 'send_message', { to: s.bob.id, body: 'roundtrip', subject: 'hi' });
    expect(sent.isError).toBe(false);
    expect(sent.data.message.kind).toBe('broadcast');

    const popped = await call(bob, 'pop_next_message');
    expect(popped.isError).toBe(false);
    expect(popped.data.message.body).toBe('roundtrip');
    expect(popped.data.message.subject).toBe('hi');

    // Empty inbox pops to null.
    const empty = await call(bob, 'pop_next_message');
    expect(empty.data.message).toBeNull();

    // Sender sees Bob's copy as read. The broadcast fans out to every member but
    // the sender (here the owner too), so pick Bob's recipient row explicitly.
    const status = await call(alice, 'get_message_status', { messageId: sent.data.message.id });
    expect(status.isError).toBe(false);
    const bobRecipient = status.data.recipients.find(
      (r: { displayName: string }) => r.displayName === 'bob',
    );
    expect(bobRecipient?.status).toBe('read');

    // list_outbox shows the sent message.
    const outbox = await call(alice, 'list_outbox');
    expect(outbox.data).toHaveLength(1);
    expect(outbox.data[0].id).toBe(sent.data.message.id);
  });

  it('surfaces origin on pop_next_message and read_message (voice vs typed)', async () => {
    const s = await scene();
    // send_message (MCP) does not thread origin; simulate an inbound voice
    // message with a raw client (its param type does not yet list origin).
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    const voice = await aliceRaw.sendMessage(s.roomId, {
      to: s.bob.id,
      body: 'spoken',
      origin: 'voice',
    } as unknown as Parameters<typeof aliceRaw.sendMessage>[1]);

    const popped = await call(bob, 'pop_next_message');
    expect(popped.data.message.origin).toBe('voice');

    const read = await call(bob, 'read_message', { messageId: voice.message.id, peek: true });
    expect(read.data.origin).toBe('voice');

    // A typed message projects origin: null.
    await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body: 'typed' });
    const typed = await call(bob, 'pop_next_message');
    expect(typed.data.message.origin).toBeNull();
  });

  it('carries suggestedReplies + structured reply echo; validation errors surface', async () => {
    const s = await scene();
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    const ask = await call(alice, 'send_message', {
      to: s.bob.id,
      body: 'ship?',
      suggestedReplies: [{ label: 'Ship it', value: 'ship' }, { label: 'Wait' }],
    });
    expect(ask.isError).toBe(false);
    expect(ask.data.message.suggestedReplies).toEqual([
      { label: 'Ship it', value: 'ship' },
      { label: 'Wait', value: 'Wait' },
    ]);

    const popped = await call(bob, 'pop_next_message');
    expect(popped.data.message.suggestedReplies).toHaveLength(2);
    const reply = await call(bob, 'send_message', {
      to: s.alice.id,
      body: 'Ship it',
      inReplyTo: ask.data.message.id,
      replyValue: 'ship',
    });
    expect(reply.isError).toBe(false);
    expect(reply.data.message.inReplyTo).toBe(ask.data.message.id);
    expect(reply.data.message.replyValue).toBe('ship');

    // replyValue without inReplyTo → bad_request tool error.
    const bad = await call(alice, 'send_message', { to: s.bob.id, body: 'x', replyValue: 'ship' });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe('bad_request');
  });

  it('pop_next_message with ack advertises a working status to the sender', async () => {
    const s = await scene();
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body: 'reply please' });
    const popped = await call(bob, 'pop_next_message', { ack: true });
    expect(popped.data.message.body).toBe('reply please');

    const seen = await aliceRaw.listStatuses(s.roomId);
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]!.state).toBe('working');
    expect(seen.items[0]!.note).toBe('reading your message');
  });
});

describe('set_status', () => {
  it('sets and clears a working status visible to the recipient', async () => {
    const s = await scene();
    const bobRaw = new SparrowClient({ server: s.api.url, token: s.bob.key });
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId });

    const set = await call(alice, 'set_status', { state: 'working', note: 'thinking', to: s.bob.id });
    expect(set.isError).toBe(false);
    expect(set.data.status.state).toBe('working');
    expect(set.data.status.to.displayName).toBe('bob');

    expect((await bobRaw.listStatuses(s.roomId)).items).toHaveLength(1);

    const idle = await call(alice, 'set_status', { state: 'idle' });
    expect(idle.data.status).toBeNull();
    expect((await bobRaw.listStatuses(s.roomId)).items).toHaveLength(0);
  });
});

describe('get_member', () => {
  it('resolves a member by principal id', async () => {
    const s = await scene();
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId });
    const res = await call(alice, 'get_member', { id: s.bob.id });
    expect(res.isError).toBe(false);
    expect(res.data.principalId).toBe(s.bob.id);
    expect(res.data.displayName).toBe('bob');
  });
});

describe('ensure_dm', () => {
  it('an agent DMs its owner, then messages the returned DM room', async () => {
    const s = await scene();
    const alice = await connectMcp({
      server: s.api.url,
      token: s.alice.key,
      roomId: s.roomId,
      orgId: s.owner.orgId,
    });

    const dm = await call(alice, 'ensure_dm', { principal: s.owner.userId });
    expect(dm.isError).toBe(false);
    expect(dm.data.room.kind).toBe('dm');
    expect(dm.data.counterpart.id).toBe(s.owner.userId);

    // Message the owner in the just-ensured DM room (roomId override).
    const sent = await call(alice, 'send_message', {
      roomId: dm.data.room.id,
      to: s.owner.userId,
      body: 'hello owner',
    });
    expect(sent.isError).toBe(false);
    const ownerPop = await s.owner.client.popNextMessage(dm.data.room.id);
    expect(ownerPop?.body).toBe('hello owner');
  });
});

describe('room resolution', () => {
  it('errors when no room is configured and none is passed', async () => {
    const s = await scene();
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key });
    const res = await call(alice, 'list_members');
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('bad_request');
    expect(res.data.error.message).toMatch(/SPARROW_ROOM|roomId/);
  });
});

describe('error mapping', () => {
  it('maps an invalid token to an isError result with the unauthorized code', async () => {
    const s = await scene();
    const client = await connectMcp({ server: s.api.url, token: 'agk_bogus', roomId: s.roomId });
    const res = await call(client, 'list_members');
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('unauthorized');
    expect(res.data.error.message).toBeTruthy();
  });
});

describe('get_attachment', () => {
  it('returns text inline and writes binary to disk', async () => {
    const s = await scene();
    const aliceCwd = tmpDir('sparrow-mcp-alice-');
    const bobCwd = tmpDir('sparrow-mcp-bob-');
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId, cwd: aliceCwd });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId, cwd: bobCwd });

    fs.writeFileSync(path.join(aliceCwd, 'note.txt'), 'hello from a text file');
    const binPath = path.join(aliceCwd, 'blob.bin');
    const binBytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    fs.writeFileSync(binPath, binBytes);

    const sent = await call(alice, 'send_message', {
      to: s.bob.id,
      body: 'files attached',
      attachments: [{ path: 'note.txt' }, { path: binPath }],
    });
    expect(sent.isError).toBe(false);
    expect(sent.data.message.attachments).toHaveLength(2);

    const msg = await call(bob, 'pop_next_message');
    const atts: any[] = msg.data.message.attachments;
    const textAtt = atts.find((a) => a.filename === 'note.txt');
    const binAtt = atts.find((a) => a.filename === 'blob.bin');
    expect(textAtt).toBeDefined();
    expect(binAtt).toBeDefined();

    // Text inline.
    const textRes = await call(bob, 'get_attachment', { attachmentId: textAtt.id });
    expect(textRes.isError).toBe(false);
    expect(textRes.data.content).toBe('hello from a text file');
    expect(textRes.data.savedTo).toBeUndefined();

    // Binary saved to cwd by default.
    const binRes = await call(bob, 'get_attachment', { attachmentId: binAtt.id });
    expect(binRes.isError).toBe(false);
    expect(binRes.data.content).toBeUndefined();
    expect(binRes.data.savedTo).toBe(path.join(bobCwd, 'blob.bin'));
    expect(fs.readFileSync(binRes.data.savedTo)).toEqual(binBytes);

    // savePath forces saving even for text.
    const forced = await call(bob, 'get_attachment', { attachmentId: textAtt.id, savePath: 'saved-note.txt' });
    expect(forced.data.savedTo).toBe(path.join(bobCwd, 'saved-note.txt'));
    expect(fs.readFileSync(forced.data.savedTo, 'utf8')).toBe('hello from a text file');
  });
});

describe('list_inbox', () => {
  it('shows unread previews and marks nothing read', async () => {
    const s = await scene();
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body: 'a preview of the message' });
    const inbox = await call(bob, 'list_inbox');
    expect(inbox.isError).toBe(false);
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0].from.displayName).toBe('alice');
    // Still poppable (not marked read by listing).
    const popped = await call(bob, 'pop_next_message');
    expect(popped.data.message.body).toBe('a preview of the message');
  });
});

/* ================================================================== *
 * Unified attention (layer 3): the medium-spanning loop + the timeline
 * ================================================================== */

describe('pop_next_work_item / list_activity', () => {
  it('pop_next_work_item drains the ONE queue and returns a typed item', async () => {
    const s = await scene();
    const alice = await connectMcp({ server: s.api.url, token: s.alice.key, roomId: s.roomId });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    await call(alice, 'send_message', { to: s.bob.id, body: 'unified work', subject: 'hi' });

    const popped = await call(bob, 'pop_next_work_item');
    expect(popped.isError).toBe(false);
    expect(popped.data.item.type).toBe('chat.message');
    expect(popped.data.item.message.body).toBe('unified work');
    expect(popped.data.item.room.id).toBe(s.roomId);

    // Empty queue → item null (never an error).
    const empty = await call(bob, 'pop_next_work_item');
    expect(empty.isError).toBe(false);
    expect(empty.data.item).toBeNull();
  });

  it('pop_next_work_item is NOT room-scoped: it drains a DM the agent was never configured for', async () => {
    const s = await scene();
    // The DM room is not the server's configured room, yet the item still comes
    // back — an agent key spans memberships and the work queue follows it.
    const dm = await s.owner.client.ensureDm({ principal: s.bob.id });
    const ownerMember = await s.owner.client.whoami(dm.room.id);
    void ownerMember;
    await s.owner.client.sendMessage(dm.room.id, { body: 'from your owner' });

    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });
    const popped = await call(bob, 'pop_next_work_item');
    expect(popped.data.item.type).toBe('chat.message');
    expect(popped.data.item.room.id).toBe(dm.room.id);
    expect(popped.data.item.room.kind).toBe('dm');
  });

  it('its description tells agents to switch on type and ignore unknown ones', async () => {
    const api = await startApi();
    const client = await connectMcp({ server: api.url });
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === 'pop_next_work_item')?.description ?? '';
    expect(desc).toMatch(/type/);
    expect(desc).toMatch(/unknown/i);
    // The room-scoped pop survives for agents that work exactly one room.
    expect(tools.find((t) => t.name === 'pop_next_message')).toBeDefined();
  });

  it('list_inbox spans mediums (the /me/inbox union), not one room', async () => {
    const s = await scene();
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });

    await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body: 'union preview' });
    const inbox = await call(bob, 'list_inbox');
    expect(inbox.isError).toBe(false);
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0].type).toBe('chat.message');
    expect(inbox.data[0].room.id).toBe(s.roomId);
    // The email half is empty in v4 — and asking for it is not an error.
    const emailOnly = await call(bob, 'list_inbox', { medium: 'email' });
    expect(emailOnly.isError).toBe(false);
    expect(emailOnly.data).toHaveLength(0);
  });

  it('list_activity returns the agent’s own timeline; an owner may watch one agent', async () => {
    const s = await scene();
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });
    const sent = await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body: 'journaled' });

    const mine = await call(bob, 'list_activity');
    expect(mine.isError).toBe(false);
    expect('nextBefore' in mine.data).toBe(true);
    const entry = mine.data.items.find((e: any) => e.refs.messageId === sent.message.id);
    expect(entry).toBeDefined();
    expect(entry.medium).toBe('chat');
    expect(entry.type).toBe('chat.message');

    // The owning human watches ONE agent through the org route.
    const ownerSession = await connectMcp({
      server: s.api.url,
      token: s.owner.client.token,
      orgId: s.owner.orgId,
    });
    const watched = await call(ownerSession, 'list_activity', { agentId: s.bob.id });
    expect(watched.isError).toBe(false);
    expect(watched.data.items.every((e: any) => e.agent.id === s.bob.id)).toBe(true);
  });

  it('list_activity is NEWEST-first and walks older with `before`', async () => {
    const s = await scene();
    const aliceRaw = new SparrowClient({ server: s.api.url, token: s.alice.key });
    const bob = await connectMcp({ server: s.api.url, token: s.bob.key, roomId: s.roomId });
    for (const body of ['one', 'two', 'three']) {
      await aliceRaw.sendMessage(s.roomId, { to: s.bob.id, body });
    }

    // A timeline is a transcript: it reads backward from now.
    const all = await call(bob, 'list_activity', { medium: 'chat' });
    expect(all.isError).toBe(false);
    const summaries = all.data.items.map((e: any) => e.summary);
    expect(summaries.indexOf('three')).toBeLessThan(summaries.indexOf('two'));
    expect(summaries.indexOf('two')).toBeLessThan(summaries.indexOf('one'));

    // `before` is an entry-id cursor: only entries strictly older come back.
    const older = await call(bob, 'list_activity', { medium: 'chat', before: all.data.items[0].id });
    expect(older.isError).toBe(false);
    expect(older.data.items.map((e: any) => e.id)).not.toContain(all.data.items[0].id);
    expect(older.data.items[0].id).toBe(all.data.items[1].id);
  });
});
