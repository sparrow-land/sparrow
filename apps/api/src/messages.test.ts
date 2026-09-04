import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { openDb } from './db/index.js';
import { members, messageRecipients, messages } from './db/schema.js';

/** Add an org member to a room (invite + accept); returns their member id. */
async function addToRoom(
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
  return accept.json().member.id as string;
}

/**
 * The delivery model (SPEC "Messages"): a room is a Slack-style channel. Every
 * message in a project room is a `broadcast` that reaches every current member
 * except the sender; the `to` field is accepted-and-ignored. A `dm` room reaches
 * its one counterpart and keeps kind `dm`. Recipient rows are delivery state
 * only — any current member can read the WHOLE room history regardless.
 */
describe('messages', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let bob: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    await addToRoom(ts, owner.token, roomId, bob);
  });
  afterEach(async () => {
    await ts.close();
  });

  const send = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/messages`, headers: auth(token), payload });

  const inboxOf = (who: SignedUpHuman, query = '') =>
    ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox${query}`,
      headers: auth(who.token),
    });

  it('a room message fans out to every other member; `to` is optional and ignored', async () => {
    // No `to` at all — every message reaches the whole room.
    const res = await send(owner.token, { body: 'hello everyone' });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.kind).toBe('broadcast');
    expect(res.json().message.to).toHaveLength(2); // alice + bob, never the sender
    expect(res.json().unreadCount).toBe(0);
    for (const who of [alice, bob]) {
      expect((await inboxOf(who)).json().items).toHaveLength(1);
    }
  });

  it('`to` is accepted-and-ignored: a member id, `all`, self, or a bogus id all fan out to everyone', async () => {
    for (const to of ['all', alice.userId, owner.userId, 'usr_nonexistent1']) {
      const res = await send(owner.token, { to, body: `to=${to}` });
      // Always the whole room minus the sender — never just the named target,
      // never a self-send rejection, never a 404 for an unknown target.
      expect(res.statusCode).toBe(201);
      expect(res.json().message.kind).toBe('broadcast');
      expect(res.json().message.to.map((t: { displayName: string }) => t.displayName).sort()).toEqual([
        'Alice',
        'Bob',
      ]);
    }
  });

  it('posting into an empty project room is allowed; a later joiner sees it via history', async () => {
    const solo = await createRoom(ts.app, owner.token, orgId, 'solo');
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${solo}/messages`,
      headers: auth(owner.token),
      payload: { body: 'anyone?' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.kind).toBe('broadcast');
    expect(res.json().message.to).toHaveLength(0); // zero recipient rows
    const msgId = res.json().message.id as string;

    // Alice joins later — she was not a recipient, but the room history shows it.
    await addToRoom(ts, owner.token, solo, alice);
    const history = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${solo}/messages`,
      headers: auth(alice.token),
    });
    expect(history.json().items.map((m: { id: string }) => m.id)).toContain(msgId);
    // No backfilled recipient row → nothing unread in her inbox.
    const inbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${solo}/inbox`,
      headers: auth(alice.token),
    });
    expect(inbox.json().items).toHaveLength(0);
  });

  it('any current member can read messages directed only at others (historical dm rows)', async () => {
    // Fabricate a legacy kind:'dm' message in this project room, delivered to
    // Alice only (Bob has no recipient row). Under the flat contract Bob — any
    // member — can still read it.
    const handle = openDb(ts.dataDir);
    const aliceMember = handle.db
      .select()
      .from(members)
      .where(eq(members.principalId, alice.userId))
      .all()
      .find((m) => m.roomId === roomId)!;
    const ownerMember = handle.db
      .select()
      .from(members)
      .where(eq(members.principalId, owner.userId))
      .all()
      .find((m) => m.roomId === roomId)!;
    const histId = 'msg_hist_dm_0001';
    handle.db
      .insert(messages)
      .values({
        id: histId,
        roomId,
        senderId: ownerMember.id,
        kind: 'dm',
        body: 'legacy directed message',
        createdAt: '2026-08-20T00:00:00.000Z',
      })
      .run();
    handle.db
      .insert(messageRecipients)
      .values({ messageId: histId, recipientId: aliceMember.id, readAt: null })
      .run();

    // Bob is NOT a recipient, yet the room history and the single-message read
    // both surface it.
    const history = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(bob.token),
    });
    expect(history.json().items.map((m: { id: string }) => m.id)).toContain(histId);
    const single = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${histId}?peek=true`,
      headers: auth(bob.token),
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().message.body).toBe('legacy directed message');
  });

  it('inbox: preview truncation + ?all includes read', async () => {
    const big = 'x'.repeat(500);
    await send(owner.token, { body: big });
    const item = (await inboxOf(alice)).json().items[0];
    expect(item.preview.length).toBe(200);
    expect(item.truncated).toBe(true);

    // read it, then default inbox is empty, ?all shows it.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
    });
    expect((await inboxOf(alice)).json().items).toHaveLength(0);
    expect((await inboxOf(alice, '?all=true')).json().items).toHaveLength(1);
  });

  it('read by id marks read; peek does not; receipts stay per-recipient', async () => {
    const res = await send(owner.token, { body: 'peekme' });
    const msgId = res.json().message.id as string;
    const statusOf = async () =>
      (
        await ts.app.inject({
          method: 'GET',
          url: `/api/v1/rooms/${roomId}/messages/${msgId}/status`,
          headers: auth(owner.token),
        })
      ).json();

    // Receipt has one row per recipient (alice + bob).
    const st0 = await statusOf();
    expect(st0.recipients).toHaveLength(2);

    const peek = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}?peek=true`,
      headers: auth(alice.token),
    });
    expect(peek.statusCode).toBe(200);
    const aliceStatus = (st: { recipients: { displayName: string; status: string }[] }) =>
      st.recipients.find((r) => r.displayName === 'Alice')!.status;
    expect(aliceStatus(await statusOf())).toBe('unread');

    await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}`,
      headers: auth(alice.token),
    });
    const st = await statusOf();
    expect(aliceStatus(st)).toBe('read');
    // Only Alice's receipt advanced — Bob's is independent.
    expect(st.recipients.find((r: { displayName: string }) => r.displayName === 'Bob')!.status).not.toBe(
      'read',
    );
  });

  it('attachments: any room member downloads identical bytes; a non-member 403', async () => {
    const data = Buffer.from('file-contents-here');
    const res = await send(owner.token, {
      body: 'see attached',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', dataBase64: data.toString('base64') },
      ],
    });
    expect(res.statusCode).toBe(201);
    const attId = res.json().message.attachments[0].id as string;
    expect(res.json().message.attachments[0].sizeBytes).toBe(data.length);

    // A member who joined AFTER the message (no recipient row for it) can still
    // download it — visibility is room membership, not delivery.
    const dave = await joinOrg(ts.app, owner.token, orgId, 'dave@example.com', 'Dave');
    await addToRoom(ts, owner.token, roomId, dave);
    for (const who of [alice, bob, dave]) {
      const dl = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/attachments/${attId}`,
        headers: auth(who.token),
      });
      expect(dl.statusCode).toBe(200);
      expect(Buffer.from(dl.rawPayload).equals(data)).toBe(true);
    }

    // A room-org member who is NOT in the room → 403 (never a member).
    const carol = await joinOrg(ts.app, owner.token, orgId, 'carol@example.com', 'Carol');
    const forbidden = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/attachments/${attId}`,
      headers: auth(carol.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('suggested replies + structured echo (any member may reply-to any message) + validation', async () => {
    const ok = await send(owner.token, {
      body: 'ship?',
      suggestedReplies: [{ label: 'Ship it', value: 'ship' }, { label: 'Wait' }],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().message.suggestedReplies).toEqual([
      { label: 'Ship it', value: 'ship' },
      { label: 'Wait', value: 'Wait' },
    ]);
    const askId = ok.json().message.id as string;

    expect(
      (
        await send(owner.token, {
          body: 'x',
          suggestedReplies: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })),
        })
      ).statusCode,
    ).toBe(400);
    expect((await send(owner.token, { body: 'x', suggestedReplies: [] })).statusCode).toBe(400);
    expect((await send(owner.token, { body: 'x', replyValue: 'ship' })).statusCode).toBe(400);

    // Bob — a member who is neither sender nor a special recipient — may reply-to
    // the ask: any member can read (hence thread) any message in the room.
    const echo = await send(bob.token, {
      body: 'Ship it',
      inReplyTo: askId,
      replyValue: 'ship',
    });
    expect(echo.statusCode).toBe(201);
    expect(echo.json().message.inReplyTo).toBe(askId);
    expect(echo.json().message.replyValue).toBe('ship');

    // A nonexistent inReplyTo → 404.
    expect((await send(owner.token, { body: 'x', inReplyTo: 'msg_nope' })).statusCode).toBe(404);
  });

  it('body over 64 KB → 413', async () => {
    const res = await send(owner.token, { body: 'x'.repeat(64 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
  });

  it('outbox lists the caller sent messages', async () => {
    await send(owner.token, { body: 'one' });
    await send(owner.token, { body: 'two' });
    const outbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/outbox`,
      headers: auth(owner.token),
    });
    expect(outbox.json().items).toHaveLength(2);
    expect(outbox.json().items.map((m: { body: string }) => m.body)).toEqual(['one', 'two']);
  });
});

describe('dm room delivery (unchanged)', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
  });
  afterEach(async () => {
    await ts.close();
  });

  it('a message in a dm room stays kind:dm and reaches the one counterpart', async () => {
    const ensure = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: alice.userId },
    });
    const dmRoomId = ensure.json().room.id as string;

    // `to` omitted — the counterpart is implied.
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoomId}/messages`,
      headers: auth(owner.token),
      payload: { body: 'hi alice' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.kind).toBe('dm');
    expect(res.json().message.to).toHaveLength(1);
    expect(res.json().message.to[0].displayName).toBe('Alice');

    const inbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${dmRoomId}/inbox`,
      headers: auth(alice.token),
    });
    expect(inbox.json().items).toHaveLength(1);
  });
});

describe('room message history list (GET /rooms/:roomId/messages)', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let bob: SignedUpHuman;
  let carol: SignedUpHuman; // org member, NOT in the room
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    carol = await joinOrg(ts.app, owner.token, orgId, 'carol@example.com', 'Carol');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    await addToRoom(ts, owner.token, roomId, bob);
  });
  afterEach(async () => {
    await ts.close();
  });

  const send = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/messages`, headers: auth(token), payload });

  const list = (token: string, query = '') =>
    ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages${query}`,
      headers: auth(token),
    });

  it('authz: a room member reads it; an org member not in the room → 403', async () => {
    await send(owner.token, { body: 'hello room' });
    expect((await list(owner.token)).statusCode).toBe(200);
    expect((await list(carol.token)).statusCode).toBe(403);
  });

  it('newest-first ordering; body reuses the full Message resource', async () => {
    await send(owner.token, { body: 'first' });
    await send(owner.token, { body: 'second' });
    await send(owner.token, { body: 'third' });
    const res = await list(alice.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((m: { body: string }) => m.body)).toEqual(['third', 'second', 'first']);
    const m = res.json().items[0];
    expect(m).toHaveProperty('from.displayName');
    // The MemberRef carries the stable PRINCIPAL id alongside the per-room member
    // id, so clients seed procedural avatars off identity (same bird everywhere).
    expect(m.from.principalId).toBe(owner.userId);
    expect(m.from.id).not.toBe(owner.userId); // the ref id is the mem_… id, not the principal
    expect(Array.isArray(m.to)).toBe(true);
    expect(m).toHaveProperty('createdAt');
  });

  it('pagination: limit caps the page and nextBefore walks older until null', async () => {
    for (let i = 0; i < 5; i++) await send(owner.token, { body: `m${i}` });
    const page1 = await list(alice.token, '?limit=2');
    expect(page1.json().items.map((m: { body: string }) => m.body)).toEqual(['m4', 'm3']);
    const cursor1 = page1.json().nextBefore;
    expect(cursor1).toBeTruthy();

    const page2 = await list(alice.token, `?limit=2&before=${cursor1}`);
    expect(page2.json().items.map((m: { body: string }) => m.body)).toEqual(['m2', 'm1']);
    const cursor2 = page2.json().nextBefore;
    expect(cursor2).toBeTruthy();

    const page3 = await list(alice.token, `?limit=2&before=${cursor2}`);
    expect(page3.json().items.map((m: { body: string }) => m.body)).toEqual(['m0']);
    expect(page3.json().nextBefore).toBeNull();
  });

  it('an unknown before cursor → 400', async () => {
    await send(owner.token, { body: 'x' });
    expect((await list(alice.token, '?before=msg_doesnotexist')).statusCode).toBe(400);
  });

  it('flat visibility: every current member sees every message in the room', async () => {
    const a = (await send(owner.token, { body: 'one' })).json().message.id as string;
    const b = (await send(alice.token, { body: 'two' })).json().message.id as string;
    for (const tok of [owner.token, alice.token, bob.token]) {
      const ids = (await list(tok)).json().items.map((m: { id: string }) => m.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    }
  });

  it('a newcomer sees the full pre-join history with zero unread', async () => {
    for (let i = 0; i < 3; i++) await send(owner.token, { body: `pre${i}` });
    // Carol joins after the fact.
    await addToRoom(ts, owner.token, roomId, carol);
    const history = await list(carol.token);
    expect(history.json().items.map((m: { body: string }) => m.body)).toEqual(['pre2', 'pre1', 'pre0']);
    // No backfilled recipient rows → her inbox is empty (no unread bomb).
    const unread = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox`,
      headers: auth(carol.token),
    });
    expect(unread.json().items).toHaveLength(0);
    const all = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox?all=true`,
      headers: auth(carol.token),
    });
    expect(all.json().items).toHaveLength(0);
  });

  it('listing is a peek: it never marks a message received or read', async () => {
    const msg = await send(owner.token, { body: 'ping' });
    const msgId = msg.json().message.id as string;

    const statusOf = async () => {
      const s = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${msgId}/status`,
        headers: auth(owner.token),
      });
      return s.json().recipients.find((r: { displayName: string }) => r.displayName === 'Alice');
    };
    expect((await statusOf()).status).toBe('unread');

    await list(alice.token);
    const after = await statusOf();
    expect(after.status).toBe('unread');
    expect(after.receivedAt).toBeNull();
    expect(after.readAt).toBeNull();
  });
});
