import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_STATUS_IDS_MAX } from '@sparrow/common-types';
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
 * Bulk read receipts (SPEC "Messages"): `GET /rooms/:roomId/messages/status?ids=`.
 * The single-message route is the contract — this one returns exactly its payload
 * per id, for a whole screen of messages in ONE request instead of one per bubble.
 * Ids the caller may not see are omitted, never refused.
 */
describe('bulk message receipts', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let outsider: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  let otherRoomId: string;
  const sent: string[] = [];

  /** Send `body` into `roomId` as the owner; returns the message id. */
  async function send(room: string, body: string, token = owner.token): Promise<string> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/messages`,
      headers: auth(token),
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().message.id as string;
  }

  beforeEach(async () => {
    ts = await makeTestServer();
    sent.length = 0;
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    outsider = await joinOrg(ts.app, owner.token, orgId, 'zed@example.com', 'Zed');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    otherRoomId = await createRoom(ts.app, owner.token, orgId, 'private');
    for (let i = 0; i < 3; i += 1) sent.push(await send(roomId, `hello ${i}`));
  });

  afterEach(async () => {
    await ts.close();
  });

  /** The bulk route for a set of ids. */
  function bulk(ids: string[], token = owner.token) {
    return ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/status?ids=${ids.join(',')}`,
      headers: auth(token),
    });
  }

  it('returns one entry per id, in the order asked, each the single-route payload', async () => {
    // Alice reads the middle message, so at least one entry is non-trivial.
    await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${sent[1]}`,
      headers: auth(alice.token),
    });

    const asked = [sent[2]!, sent[0]!, sent[1]!];
    const res = await bulk(asked);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { messageId: string; status: unknown }[];
    expect(items.map((i) => i.messageId)).toEqual(asked);

    // …and each `status` equals what the single route serves for that id.
    for (const id of asked) {
      const single = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${id}/status`,
        headers: auth(owner.token),
      });
      expect(single.statusCode).toBe(200);
      expect(items.find((i) => i.messageId === id)!.status).toEqual(single.json());
    }
    expect(items.find((i) => i.messageId === sent[1])!.status).toMatchObject({
      recipients: [expect.objectContaining({ status: 'read' })],
    });
  });

  it('omits unknown, other-room and clawed-back ids instead of failing the request', async () => {
    const elsewhere = await send(otherRoomId, 'not yours');
    const clawed = await send(roomId, 'oops');
    const claw = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages/${clawed}/clawback`,
      headers: auth(owner.token),
    });
    expect(claw.statusCode).toBe(200);

    const res = await bulk([sent[0]!, 'msg_nope', elsewhere, clawed, sent[2]!]);
    expect(res.statusCode).toBe(200);
    expect((res.json().items as { messageId: string }[]).map((i) => i.messageId)).toEqual([
      sent[0],
      sent[2],
    ]);
    // Each omitted id 404s on the single route too — same rules, no leak.
    for (const id of ['msg_nope', elsewhere, clawed]) {
      const single = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/messages/${id}/status`,
        headers: auth(owner.token),
      });
      expect(single.statusCode).toBe(404);
    }
  });

  it('is member-gated: a non-member gets the room 403/404, never a partial page', async () => {
    const res = await bulk(sent, outsider.token);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('rejects an empty or missing `ids`, and more than the cap', async () => {
    const empty = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/status?ids=`,
      headers: auth(owner.token),
    });
    expect(empty.statusCode).toBe(400);
    const missing = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/status`,
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(400);

    const atCap = Array.from({ length: MESSAGE_STATUS_IDS_MAX }, (_, i) => `msg_pad_${i}`);
    // At the cap the request is fine (the padding ids are simply unknown)…
    const ok = await bulk([...atCap.slice(0, MESSAGE_STATUS_IDS_MAX - 1), sent[0]!]);
    expect(ok.statusCode).toBe(200);
    expect((ok.json().items as { messageId: string }[]).map((i) => i.messageId)).toEqual([sent[0]]);
    // …one over it is a client error.
    const over = await bulk([...atCap, sent[0]!]);
    expect(over.statusCode).toBe(400);
  });
});
