/**
 * Clawback (SPEC "Clawback"): a sender retracts their own message while it is
 * still unread by EVERY recipient. `POST /rooms/:roomId/messages/:messageId/clawback`
 * → `200 { message }` (full body — the client restores it into the composer);
 * the row is then dead on every read surface, `message.clawback` fans out to
 * ALL room members (journaled for replay), and the message's `chat.message`
 * activity entries are deleted. 409s: `already_clawed_back`, `message_read`
 * (ANY recipient read it — `received` is fine), `outside_window` (not among the
 * sender's last CLAWBACK_WINDOW non-clawed messages in the room). 404 when the
 * message is not the caller's own in that room.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAWBACK_WINDOW } from '@sparrow/common-types';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  listen,
  openSse,
  sleep,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

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

describe('message clawback', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  const open: SseClient[] = [];
  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  const send = async (body: string, token = owner.token) => {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().message.id as string;
  };

  const clawback = (messageId: string, token = owner.token) =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages/${messageId}/clawback`,
      headers: auth(token),
    });

  const get = (url: string, token: string) =>
    ts.app.inject({ method: 'GET', url, headers: auth(token) });

  it('happy path: clawed message vanishes from every surface; the event reaches everyone', async () => {
    const msgId = await send('super secret — wrong room');

    const res = await clawback(msgId);
    expect(res.statusCode).toBe(200);
    // The FULL message comes back — the client restores it into the composer.
    expect(res.json().message.id).toBe(msgId);
    expect(res.json().message.body).toBe('super secret — wrong room');

    // Room history: empty.
    const hist = await get(`/api/v1/rooms/${roomId}/messages`, alice.token);
    expect(hist.json().items).toEqual([]);

    // Room inbox previews (unread and ?all): empty.
    expect((await get(`/api/v1/rooms/${roomId}/inbox`, alice.token)).json().items).toEqual([]);
    expect((await get(`/api/v1/rooms/${roomId}/inbox?all=true`, alice.token)).json().items).toEqual([]);

    // Principal inbox previews: empty.
    expect((await get('/api/v1/me/inbox', alice.token)).json().items).toEqual([]);

    // A clawed message never pops — room pop and principal pop are both empty.
    const roomPop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
      payload: {},
    });
    expect(roomPop.json().message).toBeNull();
    const mePop = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(alice.token),
      payload: {},
    });
    expect(mePop.json().item).toBeNull();

    // Unread count (the room badge on send responses): 0 for alice.
    const aliceSend = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(alice.token),
      payload: { body: 'hi' },
    });
    expect(aliceSend.json().unreadCount).toBe(0);

    // By-id reads: 404 everywhere.
    expect((await get(`/api/v1/rooms/${roomId}/messages/${msgId}`, alice.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/me/messages/${msgId}`, alice.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/rooms/${roomId}/messages/${msgId}/status`, owner.token)).statusCode).toBe(404);

    // Read/ack by id: 404.
    const ack = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/messages/${msgId}/read`,
      headers: auth(alice.token),
    });
    expect(ack.statusCode).toBe(404);

    // The event is journaled to ALL members — the sender included.
    for (const who of [owner, alice]) {
      const log = await get('/api/v1/me/events/log?since=0', who.token);
      const events = log.json().events as { event: string; data: any }[];
      const claw = events.filter((e) => e.event === 'message.clawback');
      expect(claw).toHaveLength(1);
      expect(claw[0]!.data.messageId).toBe(msgId);
      expect(claw[0]!.data.by.displayName).toBe('Owner');
      expect(claw[0]!.data.clawedBackAt).toBeTruthy();
    }
  });

  it('any recipient read → 409 message_read', async () => {
    const msgId = await send('too late');
    // Alice READS it (room-scoped GET without ?peek marks read).
    const read = await get(`/api/v1/rooms/${roomId}/messages/${msgId}`, alice.token);
    expect(read.statusCode).toBe(200);

    const res = await clawback(msgId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('message_read');
  });

  it('received-but-unread still claws — delivery is not reading', async () => {
    const msgId = await send('delivered only');
    // Listing the inbox marks `received` (server-observed delivery), not read.
    const inbox = await get(`/api/v1/rooms/${roomId}/inbox`, alice.token);
    expect(inbox.json().items[0]!.status).toBe('received');

    const res = await clawback(msgId);
    expect(res.statusCode).toBe(200);
  });

  it(`only the sender's last ${CLAWBACK_WINDOW} messages are eligible → 409 outside_window`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < CLAWBACK_WINDOW + 1; i++) ids.push(await send(`m${i}`));

    // The 1st of 6 is outside the window …
    const outside = await clawback(ids[0]!);
    expect(outside.statusCode).toBe(409);
    expect(outside.json().error.message).toBe('outside_window');

    // … the 2nd is within it.
    expect((await clawback(ids[1]!)).statusCode).toBe(200);
  });

  it('a READ message is a hard stop: an older unread message behind it → 409 behind_read', async () => {
    // Jake (2026-09-02): "clawback should only work on the last N-unread
    // messages, and stop once it hits a read message" — eligibility is the
    // TRAILING UNREAD RUN, not any-unread-in-window. [unread, read] ⇒ the
    // older unread is locked in: the conversation moved past it.
    const older = await send('first thought');
    const newer = await send('second thought');
    // Alice reads only the NEWER one.
    expect((await get(`/api/v1/rooms/${roomId}/messages/${newer}`, alice.token)).statusCode).toBe(200);

    const res = await clawback(older);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('behind_read');

    // A newer UNREAD message does not lock anything: [unread, unread] — the
    // older of the two still claws (the run is unbroken).
    const a = await send('third');
    const b = await send('fourth');
    expect(typeof b).toBe('string');
    expect((await clawback(a)).statusCode).toBe(200);
  });

  it('clawing back twice → 409 already_clawed_back', async () => {
    const msgId = await send('once only');
    expect((await clawback(msgId)).statusCode).toBe(200);
    const again = await clawback(msgId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('already_clawed_back');
  });

  it("another member's message → 404 (not yours, not clawable)", async () => {
    const msgId = await send('owner speaking');
    const res = await clawback(msgId, alice.token);
    expect(res.statusCode).toBe(404);
  });

  it('a non-member of the org → 404 (existence never leaks)', async () => {
    const msgId = await send('internal');
    const mallory = await signup(ts.app, { email: 'mallory@example.com', displayName: 'Mallory' });
    const res = await clawback(msgId, mallory.token);
    expect(res.statusCode).toBe(404);
  });

  it('an agent can clawback its own message', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'fable');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    const msgId = await send('agent misfire', agent.key);
    const res = await clawback(msgId, agent.key);
    expect(res.statusCode).toBe(200);
    expect(res.json().message.body).toBe('agent misfire');
  });

  it('deletes the chat.message activity entries — no phantom timeline line', async () => {
    const agent = await makeAgent(ts.app, owner.token, orgId, 'fable');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    const msgId = await send('to be unsaid');

    const before = await get('/api/v1/me/activity', owner.token);
    expect(
      (before.json().items as { refs?: { messageId?: string } }[]).some(
        (e) => e.refs?.messageId === msgId,
      ),
    ).toBe(true);

    expect((await clawback(msgId)).statusCode).toBe(200);

    const after = await get('/api/v1/me/activity', owner.token);
    expect(
      (after.json().items as { refs?: { messageId?: string } }[]).some(
        (e) => e.refs?.messageId === msgId,
      ),
    ).toBe(false);
  });

  it('a live watcher sees message.clawback; a reconnecting one replays it from the journal', async () => {
    const base = await listen(ts);
    const aliceStream = track(await openSse(base, '/api/v1/me/events', alice.token));
    await sleep(50);

    const msgId = await send('now you see me');
    await aliceStream.waitFor((e) => e.event === 'message.new');
    expect((await clawback(msgId)).statusCode).toBe(200);

    const live = await aliceStream.waitFor((e) => e.event === 'message.clawback');
    const data = live.data as { messageId: string; by: { displayName: string }; clawedBackAt: string };
    expect(data.messageId).toBe(msgId);
    expect(data.by.displayName).toBe('Owner');
    expect(data.clawedBackAt).toBeTruthy();
    // The frame carries a journal cursor — replayable after a disconnect.
    expect(live.id).toBeTruthy();
    aliceStream.close();

    // Reconnect-and-replay: the journal read returns the same event.
    const log = await get('/api/v1/me/events/log?since=0', alice.token);
    const replayed = (log.json().events as { event: string; data: any }[]).find(
      (e) => e.event === 'message.clawback',
    );
    expect(replayed).toBeDefined();
    expect(replayed!.data.messageId).toBe(msgId);
  });

  it('excludes clawed messages from outbox and agent-dm oversight transcripts', async () => {
    // Outbox (the sender's own listing) drops the clawed row too.
    const msgId = await send('gone from outbox');
    await clawback(msgId);
    const outbox = await get(`/api/v1/rooms/${roomId}/outbox`, owner.token);
    expect((outbox.json().items as { id: string }[]).some((m) => m.id === msgId)).toBe(false);

    // Agent↔agent DM oversight: a clawed message leaves the transcript, and a
    // box whose ONLY message was clawed disappears from the listing.
    const a = await makeAgent(ts.app, owner.token, orgId, 'aa');
    const b = await makeAgent(ts.app, owner.token, orgId, 'bb');
    // Agents may only open a DM with a peer they have MET (a shared room).
    for (const agent of [a, b]) {
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${roomId}/members`,
        headers: auth(owner.token),
        payload: { principal: agent.id },
      });
    }
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(a.key),
      payload: { principal: b.id },
    });
    const dmRoomId = dm.json().room.id as string;
    const sent = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoomId}/messages`,
      headers: auth(a.key),
      payload: { body: 'psst' },
    });
    const dmMsgId = sent.json().message.id as string;

    const listedBefore = await get(`/api/v1/orgs/${orgId}/agent-dms`, owner.token);
    expect((listedBefore.json().items as { roomId: string }[]).some((x) => x.roomId === dmRoomId)).toBe(true);

    const claw = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoomId}/messages/${dmMsgId}/clawback`,
      headers: auth(a.key),
    });
    expect(claw.statusCode).toBe(200);

    const transcript = await get(`/api/v1/orgs/${orgId}/agent-dms/${dmRoomId}/messages`, owner.token);
    expect(transcript.json().items).toEqual([]);
    const listedAfter = await get(`/api/v1/orgs/${orgId}/agent-dms`, owner.token);
    expect((listedAfter.json().items as { roomId: string }[]).some((x) => x.roomId === dmRoomId)).toBe(false);
  });
});
