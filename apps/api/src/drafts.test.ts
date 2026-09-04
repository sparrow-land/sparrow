import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAFTS_PER_ROOM_MAX, MAX_BODY_BYTES } from '@sparrow/common-types';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  sleep,
  type TestServer,
  type SignedUpHuman,
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

describe('drafts', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let bob: SignedUpHuman;
  let outsider: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    bob = await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    // An org member who is NOT in the room.
    outsider = await joinOrg(ts.app, owner.token, orgId, 'out@example.com', 'Outsider');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
    await addToRoom(ts, owner.token, roomId, bob);
  });
  afterEach(async () => {
    await ts.close();
  });

  const create = (token: string, payload: Record<string, unknown>) =>
    ts.app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/drafts`, headers: auth(token), payload });
  const list = (token: string) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/drafts`, headers: auth(token) });
  const del = (token: string, id: string) =>
    ts.app.inject({ method: 'DELETE', url: `/api/v1/rooms/${roomId}/drafts/${id}`, headers: auth(token) });

  it('create → list → delete happy path', async () => {
    const c = await create(alice.token, { text: '  hello world  ' });
    expect(c.statusCode).toBe(201);
    const draft = c.json().draft;
    expect(draft).toMatchObject({ id: expect.stringMatching(/^drf_/), text: 'hello world' });
    expect(typeof draft.createdAt).toBe('string');

    const l = await list(alice.token);
    expect(l.statusCode).toBe(200);
    expect(l.json().items).toHaveLength(1);
    expect(l.json().items[0]).toMatchObject({ id: draft.id, text: 'hello world' });

    const d = await del(alice.token, draft.id);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ ok: true });

    const after = await list(alice.token);
    expect(after.json().items).toEqual([]);
  });

  it('lists oldest-first', async () => {
    await create(alice.token, { text: 'first' });
    await sleep(3);
    await create(alice.token, { text: 'second' });
    await sleep(3);
    await create(alice.token, { text: 'third' });
    const l = await list(alice.token);
    expect(l.json().items.map((d: { text: string }) => d.text)).toEqual(['first', 'second', 'third']);
  });

  it('drafts are personal: A cannot see or delete B’s drafts', async () => {
    const a = await create(alice.token, { text: 'alice draft' });
    const b = await create(bob.token, { text: 'bob draft' });
    const aliceId = a.json().draft.id as string;
    const bobId = b.json().draft.id as string;

    // Each sees only their own.
    expect((await list(alice.token)).json().items.map((d: { id: string }) => d.id)).toEqual([aliceId]);
    expect((await list(bob.token)).json().items.map((d: { id: string }) => d.id)).toEqual([bobId]);

    // Bob deleting Alice's draft → 404 (existence hidden), and Alice's draft survives.
    const forbiddenDel = await del(bob.token, aliceId);
    expect(forbiddenDel.statusCode).toBe(404);
    expect((await list(alice.token)).json().items).toHaveLength(1);
  });

  it('deleting an unknown id → 404', async () => {
    const d = await del(alice.token, 'drf_unknown00000');
    expect(d.statusCode).toBe(404);
  });

  it('non-member of the room → 403; outsider to the org → 404', async () => {
    // outsider is in the org but not the room → 403.
    expect((await list(outsider.token)).statusCode).toBe(403);
    expect((await create(outsider.token, { text: 'x' })).statusCode).toBe(403);

    // A human with no org membership cannot distinguish the room from nonexistent → 404.
    const stranger = await signup(ts.app, { email: 'stranger@example.com', displayName: 'Stranger' });
    expect((await list(stranger.token)).statusCode).toBe(404);
    expect((await create(stranger.token, { text: 'x' })).statusCode).toBe(404);
  });

  it('rejects empty / whitespace-only text with 400', async () => {
    expect((await create(alice.token, { text: '' })).statusCode).toBe(400);
    expect((await create(alice.token, { text: '   ' })).statusCode).toBe(400);
    expect((await create(alice.token, {})).statusCode).toBe(400);
  });

  it('rejects oversize text (same cap as message bodies) with 413', async () => {
    const tooBig = 'a'.repeat(MAX_BODY_BYTES + 1);
    const res = await create(alice.token, { text: tooBig });
    expect(res.statusCode).toBe(413);
  });

  it('caps at DRAFTS_PER_ROOM_MAX per (room, member)', async () => {
    for (let i = 0; i < DRAFTS_PER_ROOM_MAX; i++) {
      const r = await create(alice.token, { text: `draft ${i}` });
      expect(r.statusCode).toBe(201);
    }
    const over = await create(alice.token, { text: 'one too many' });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('bad_request');
    // Cap is per (room, member): bob is unaffected.
    expect((await create(bob.token, { text: 'bob ok' })).statusCode).toBe(201);
  });
});
