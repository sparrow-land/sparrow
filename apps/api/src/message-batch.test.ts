import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  recordStatements,
  type StatementLog,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

/** Add an org member to a room (invite + accept). */
async function addToRoom(
  ts: TestServer,
  ownerToken: string,
  roomId: string,
  invitee: SignedUpHuman,
): Promise<void> {
  const inv = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/invitations`,
    headers: auth(ownerToken),
    payload: { human: invitee.userId },
  });
  await ts.app.inject({
    method: 'POST',
    url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
    headers: auth(invitee.token),
  });
}

/** `n` distinct attachment inputs (`a0.txt`, `a1.txt`, …). */
function files(n: number): { filename: string; contentType: string; dataBase64: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    filename: `a${i}.txt`,
    contentType: 'text/plain',
    dataBase64: Buffer.from(`file ${i}`).toString('base64'),
  }));
}

/**
 * Serializing a PAGE of messages must not cost one attachments query per message
 * (SPEC "Messages"). The batched serializer has to be indistinguishable from the
 * per-row one — same bytes, attachments included, in the same order — while
 * asking the database once for the whole page.
 */
describe('batched message serialization', () => {
  let ts: TestServer;
  let log: StatementLog;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let bob: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  const sent: string[] = [];

  beforeEach(async () => {
    log = recordStatements();
    ts = await makeTestServer();
    sent.length = 0;
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    // A page with 0-, 1- and several-attachment messages in it.
    for (const count of [0, 1, 3, 0, 2]) {
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${roomId}/messages`,
        headers: auth(owner.token),
        payload: { body: `msg with ${count}`, attachments: files(count) },
      });
      expect(res.statusCode).toBe(201);
      sent.push(res.json().message.id as string);
    }
  });

  afterEach(async () => {
    log.restore();
    await ts.close();
  });

  it('a batched history page equals the per-message serialization, element for element', async () => {
    const page = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(alice.token),
    });
    expect(page.statusCode).toBe(200);
    const items = page.json().items as { id: string }[];
    expect(items.map((i) => i.id)).toEqual([...sent].reverse());

    // The single-message route still serializes one row at a time — it is the
    // reference the batched page must reproduce exactly, attachments and all.
    for (const item of items) {
      const single = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${item.id}?peek=true`,
        headers: auth(alice.token),
      });
      expect(single.statusCode).toBe(200);
      expect(item).toEqual(single.json().message);
    }
    expect(items.map((i) => (i as unknown as { attachments: unknown[] }).attachments.length))
      .toEqual([2, 0, 3, 1, 0]);
  });

  it('the outbox and the room inbox agree with the per-message shape too', async () => {
    const outbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/outbox`,
      headers: auth(owner.token),
    });
    expect(outbox.statusCode).toBe(200);
    for (const item of outbox.json().items as { id: string }[]) {
      const single = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${item.id}?peek=true`,
        headers: auth(owner.token),
      });
      expect(item).toEqual(single.json().message);
    }

    const inbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/inbox`,
      headers: auth(alice.token),
    });
    expect(inbox.statusCode).toBe(200);
    expect((inbox.json().items as { attachmentCount: number }[]).map((i) => i.attachmentCount))
      .toEqual([0, 1, 3, 0, 2]);
  });

  it('recipient refs survive batching — 0, 1 and several recipients, and a member who left', async () => {
    // Bob joins, receives a broadcast (3 recipients incl. him), then leaves: his
    // ref must keep resolving off the FROZEN snapshot, batched or not.
    await addToRoom(ts, owner.token, roomId, bob);
    const three = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { body: 'to all three' },
    });
    expect(three.statusCode).toBe(201);
    expect((three.json().message.to as unknown[]).length).toBe(2);
    const leave = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/rooms/${roomId}`,
      headers: auth(bob.token),
    });
    expect(leave.statusCode).toBeLessThan(300);

    const page = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(alice.token),
    });
    expect(page.statusCode).toBe(200);
    const items = page.json().items as { id: string; to: { id: string; kind: string }[] }[];
    // The page holds messages with 0 recipients (alice's own, below), 1 and 2.
    for (const item of items) {
      const single = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${item.id}?peek=true`,
        headers: auth(alice.token),
      });
      expect(single.statusCode).toBe(200);
      expect(item).toEqual(single.json().message);
    }
    // The departed member is still named, and still as himself.
    const broadcast = items.find((i) => i.id === three.json().message.id)!;
    expect(broadcast.to.map((r) => r.kind).sort()).toEqual(['human', 'human']);
  });

  it('a message with no recipients at all serializes the same either way', async () => {
    // A room where the sender is the ONLY member: zero recipient rows.
    const solo = await createRoom(ts.app, owner.token, orgId, 'solo');
    const sentSolo = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${solo}/messages`,
      headers: auth(owner.token),
      payload: { body: 'talking to myself' },
    });
    expect(sentSolo.statusCode).toBe(201);
    const page = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${solo}/messages`,
      headers: auth(owner.token),
    });
    const item = (page.json().items as { id: string; to: unknown[] }[])[0]!;
    expect(item.to).toEqual([]);
    const single = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${solo}/messages/${item.id}?peek=true`,
      headers: auth(owner.token),
    });
    expect(item).toEqual(single.json().message);
  });

  it('serializing a page asks for attachments ONCE, not once per message', async () => {
    const attachmentQueries = () => log.count('from "attachments"');

    for (const url of [
      `/api/v1/rooms/${roomId}/messages`,
      `/api/v1/rooms/${roomId}/outbox`,
    ]) {
      log.reset();
      const res = await ts.app.inject({ method: 'GET', url, headers: auth(owner.token) });
      expect(res.statusCode).toBe(200);
      expect((res.json().items as unknown[]).length).toBe(sent.length);
      expect(attachmentQueries()).toBe(1);
    }

    // The inbox surfaces (room-scoped and principal-wide) count attachments per
    // preview — one query for the page there too.
    for (const url of [`/api/v1/rooms/${roomId}/inbox`, '/api/v1/me/inbox']) {
      log.reset();
      const res = await ts.app.inject({ method: 'GET', url, headers: auth(alice.token) });
      expect(res.statusCode).toBe(200);
      expect(attachmentQueries()).toBe(1);
    }
  });

  it('a page resolves recipients and members in bulk, not per message', async () => {
    // History: the route reads `members` once to authorize the caller, and the
    // serializer once for every ref on the page; recipient rows are one query.
    log.reset();
    const history = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(alice.token),
    });
    expect(history.statusCode).toBe(200);
    expect(log.count('from "message_recipients"')).toBe(1);
    expect(log.count('from "members"')).toBe(2);

    // Outbox: same, one authorization read plus one refs read.
    log.reset();
    const outbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/outbox`,
      headers: auth(owner.token),
    });
    expect(outbox.statusCode).toBe(200);
    expect(log.count('from "message_recipients"')).toBe(1);
    expect(log.count('from "members"')).toBe(2);

    // The inbox previews render only the SENDER, so their single
    // `message_recipients` read is the inbox query itself — no second one.
    //
    // Their `members` count is measured on the SECOND listing. The first one
    // observes delivery and emits a `message.received` per newly-seen row, and
    // routing each of those events reads the room's roster — event fan-out, not
    // serialization, and set-once: the second listing emits nothing and shows
    // what rendering a page actually costs.
    for (const [url, token] of [
      [`/api/v1/rooms/${roomId}/inbox`, alice.token],
      ['/api/v1/me/inbox', alice.token],
    ] as const) {
      await ts.app.inject({ method: 'GET', url, headers: auth(token) });
      log.reset();
      const res = await ts.app.inject({ method: 'GET', url, headers: auth(token) });
      expect(res.statusCode).toBe(200);
      expect(log.count('from "message_recipients"')).toBe(1);
      // One read to authorize the caller, one to resolve the page's refs.
      expect(log.count('from "members"')).toBe(2);
    }
  });

  it('the cost of a page does not grow with the page: 5 messages and 25 cost the same', async () => {
    // The guarantee behind all of the above, stated once: serialization is flat
    // in page size. Twenty more messages between the SAME people must not add a
    // single statement.
    const measure = async (): Promise<number> => {
      log.reset();
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages?limit=200`,
        headers: auth(alice.token),
      });
      expect(res.statusCode).toBe(200);
      return log.statements.length;
    };
    const small = await measure();
    for (let i = 0; i < 20; i += 1) {
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${roomId}/messages`,
        headers: auth(owner.token),
        payload: { body: `filler ${i}`, attachments: files(i % 2) },
      });
    }
    expect(await measure()).toBe(small);
  });
});
