import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { messageRecipients, messages } from './db/schema.js';

/**
 * Transcript integrity (QA I-4). A message's `from` is the identity that WROTE
 * it. Membership is mutable — a member can be removed, leave, or (for an agent)
 * be destroyed outright — but history must not be rewritten by any of that.
 *
 * The regression: `from`/`to` were resolved by joining the LIVE `members` row,
 * so deleting that row made every historical ref collapse to a blank anonymous
 * `{ kind: 'human', displayName: '', principalId: undefined }` — an agent's
 * transcript silently became a human's, which also misroutes on `kind`.
 *
 * The contract these tests pin:
 *  - a live member still renders LIVE (renames show on old messages);
 *  - a departed member keeps kind + principalId + a stable display name;
 *  - a genuinely unresolvable ref is `kind: 'unknown'`, NEVER `'human'`.
 */

async function addAgentToRoom(
  ts: TestServer,
  ownerToken: string,
  roomId: string,
  agentId: string,
): Promise<void> {
  const res = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/members`,
    headers: auth(ownerToken),
    payload: { principal: agentId },
  });
  if (res.statusCode !== 201) throw new Error(`addAgentToRoom failed (${res.statusCode}): ${res.body}`);
}

async function addHumanToRoom(
  ts: TestServer,
  ownerToken: string,
  roomId: string,
  invitee: SignedUpHuman,
): Promise<string> {
  const inv = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/invitations`,
    headers: auth(ownerToken),
    payload: { human: invitee.userId },
  });
  const accept = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
    headers: auth(invitee.token),
  });
  if (accept.statusCode >= 300) throw new Error(`addHumanToRoom failed: ${accept.body}`);
  return accept.json().member.id as string;
}

async function post(ts: TestServer, roomId: string, token: string, body: string): Promise<string> {
  const res = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/messages`,
    headers: auth(token),
    payload: { body },
  });
  if (res.statusCode !== 201) throw new Error(`post failed (${res.statusCode}): ${res.body}`);
  return res.json().message.id as string;
}

interface WireRef {
  id: string;
  kind: string;
  displayName: string;
  principalId?: string;
}

async function listMessages(ts: TestServer, roomId: string, token: string) {
  const res = await ts.app.inject({
    method: 'GET',
    url: `/api/v1/rooms/${roomId}/messages`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as { id: string; body: string; from: WireRef; to: WireRef[] }[];
}

describe('message sender identity survives membership changes', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
  });
  afterEach(async () => {
    await ts.close();
  });

  it('an agent removed from the room keeps agent identity on its past messages', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'atlas');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    await post(ts, roomId, bot.key, 'hello from the agent');

    const removed = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${bot.id}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(200);

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'hello from the agent')!;
    expect(msg.from.kind).toBe('agent');
    expect(msg.from.displayName).toBe('atlas');
    expect(msg.from.principalId).toBe(bot.id);
  });

  it('a human removed from the room keeps human identity + name on their past messages', async () => {
    const alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    const aliceMemberId = await addHumanToRoom(ts, owner.token, roomId, alice);
    await post(ts, roomId, alice.token, 'hello from alice');

    const removed = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${aliceMemberId}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(200);

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'hello from alice')!;
    expect(msg.from.kind).toBe('human');
    expect(msg.from.displayName).toBe('Alice');
    expect(msg.from.principalId).toBe(alice.userId);
  });

  it('a destroyed agent keeps agent kind and its last known name on past messages', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'scout');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    await post(ts, roomId, bot.key, 'before the destroy');

    const destroyed = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${bot.id}`,
      headers: auth(owner.token),
    });
    expect(destroyed.statusCode).toBe(200);

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'before the destroy')!;
    expect(msg.from.kind).toBe('agent');
    // The agents row is gone, so the snapshot taken at send time is the only
    // surviving name — it must still be there, never ''.
    expect(msg.from.displayName).toBe('scout');
    expect(msg.from.principalId).toBe(bot.id);
  });

  it('display names stay LIVE while the principal exists (rename shows on old messages)', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    await post(ts, roomId, bot.key, 'posted under the old name');

    await ts.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(bot.key),
      payload: { name: 'renamed-bot' },
    });
    // Removing it from the room must not freeze the name back to the snapshot:
    // the agent principal still exists, so its live name wins.
    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${bot.id}`,
      headers: auth(owner.token),
    });

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'posted under the old name')!;
    expect(msg.from.displayName).toBe('renamed-bot');
    expect(msg.from.kind).toBe('agent');
  });

  it('a removed recipient keeps their identity in the `to` delivery refs', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'listener');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    await post(ts, roomId, owner.token, 'addressed to the room');

    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${bot.id}`,
      headers: auth(owner.token),
    });

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'addressed to the room')!;
    const ref = msg.to.find((r) => r.principalId === bot.id);
    expect(ref).toBeDefined();
    expect(ref!.kind).toBe('agent');
    expect(ref!.displayName).toBe('listener');
  });

  it('the inbox preview of a removed sender keeps their identity', async () => {
    const alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    const bot = await makeAgent(ts.app, owner.token, orgId, 'poster');
    await addHumanToRoom(ts, owner.token, roomId, alice);
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    await post(ts, roomId, bot.key, 'unread for alice');

    await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${bot.id}`,
      headers: auth(owner.token),
    });

    const inbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox`,
      headers: auth(alice.token),
    });
    expect(inbox.statusCode).toBe(200);
    const item = (inbox.json().items as { from: WireRef; preview: string }[]).find(
      (i) => i.preview === 'unread for alice',
    )!;
    expect(item.from.kind).toBe('agent');
    expect(item.from.displayName).toBe('poster');
    expect(item.from.principalId).toBe(bot.id);
  });

  it('an unresolvable sender is kind "unknown", never a blank human', async () => {
    // Simulates a row written before the identity snapshot existed (nullable
    // columns on an upgraded database) whose member row is also gone.
    await post(ts, roomId, owner.token, 'orphaned row');
    const handle = openDb(ts.dataDir);
    try {
      handle.db
        .update(messages)
        .set({
          senderId: 'mem_gone',
          senderPrincipalType: null,
          senderPrincipalId: null,
          senderDisplayName: null,
        })
        .where(eq(messages.body, 'orphaned row'))
        .run();
    } finally {
      handle.sqlite.close();
    }

    const items = await listMessages(ts, roomId, owner.token);
    const msg = items.find((m) => m.body === 'orphaned row')!;
    expect(msg.from.kind).toBe('unknown');
    expect(msg.from.kind).not.toBe('human');
    expect(msg.from.principalId).toBeUndefined();
  });

  it('persists the sender identity snapshot on the message row at send time', async () => {
    const bot = await makeAgent(ts.app, owner.token, orgId, 'snapshotter');
    await addAgentToRoom(ts, owner.token, roomId, bot.id);
    const msgId = await post(ts, roomId, bot.key, 'snapshot me');

    const handle = openDb(ts.dataDir);
    try {
      const row = handle.db.select().from(messages).where(eq(messages.id, msgId)).get()!;
      expect(row.senderPrincipalType).toBe('agent');
      expect(row.senderPrincipalId).toBe(bot.id);
      expect(row.senderDisplayName).toBe('snapshotter');
      // Recipient delivery rows carry the same snapshot for the `to` refs.
      const rec = handle.db
        .select()
        .from(messageRecipients)
        .where(eq(messageRecipients.messageId, msgId))
        .all();
      expect(rec.length).toBeGreaterThan(0);
      expect(rec[0]!.recipientPrincipalType).toBe('human');
      expect(rec[0]!.recipientPrincipalId).toBe(owner.userId);
      expect(rec[0]!.recipientDisplayName).toBe('Owner');
    } finally {
      handle.sqlite.close();
    }
  });
});
