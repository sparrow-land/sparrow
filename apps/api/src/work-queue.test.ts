/**
 * Unified attention (layer 3) — the medium-spanning work queue (SPEC v4
 * "Unified attention → The medium-spanning work queue").
 *
 * `POST /me/inbox/pop` returns a typed `WorkItem` (`{ item: WorkItem | null }`);
 * `GET /me/inbox` returns the `type`-discriminated `InboxEntry` union. v3's
 * `{ message, room }` pop response is GONE. The room-scoped inbox/pop are the
 * chat medium's own surface and keep their v3 shapes verbatim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('typed principal inbox & pop', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let dmRoom: string;

  async function dm(body: string): Promise<void> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoom}/messages`,
      headers: auth(owner.token),
      payload: { body },
    });
    if (res.statusCode !== 201) throw new Error(`send failed: ${res.body}`);
  }

  async function pop(payload: Record<string, unknown> = {}) {
    return ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(alice.token),
      payload,
    });
  }

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: alice.userId },
    });
    dmRoom = res.json().room.id as string;
  });
  afterEach(async () => {
    await ts.close();
  });

  it('pop returns { item: { type: "chat.message", message, room } }', async () => {
    await dm('hello');
    const res = await pop();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The discriminated union IS the contract — v3's top-level message/room are gone.
    expect(body.message).toBeUndefined();
    expect(body.room).toBeUndefined();
    expect(body.item.type).toBe('chat.message');
    expect(body.item.message.body).toBe('hello');
    expect(body.item.room.id).toBe(dmRoom);
    expect(body.item.room.kind).toBe('dm');
    expect(body.item.room.counterpart.id).toBe(owner.userId);
  });

  it('an empty queue is { item: null } (never 404)', async () => {
    const res = await pop();
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toBeNull();
  });

  it('the { ack, note, ttlSeconds } body survives unchanged', async () => {
    await dm('question');
    // note without ack:true is still the 400 trap-guard.
    const bad = await pop({ note: 'on it' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('note/ttlSeconds require ack: true');

    const ok = await pop({ ack: true, note: 'reading now' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().item.message.body).toBe('question');
    const statuses = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${dmRoom}/status`,
      headers: auth(owner.token),
    });
    expect(statuses.json().items[0]).toMatchObject({ state: 'working', note: 'reading now' });
  });

  it('GET /me/inbox items are the typed union (all chat.message today)', async () => {
    await dm('preview me');
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { type: string; preview: string; room: { id: string } }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('chat.message');
    expect(items[0]!.preview).toBe('preview me');
    expect(items[0]!.room.id).toBe(dmRoom);
  });

  it('GET /me/inbox?medium= narrows: chat yields the chat items, email yields none', async () => {
    await dm('chat only');
    const chat = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox?medium=chat',
      headers: auth(alice.token),
    });
    expect(chat.json().items).toHaveLength(1);

    // The email medium is off — asking for it is valid and simply empty.
    const email = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox?medium=email',
      headers: auth(alice.token),
    });
    expect(email.statusCode).toBe(200);
    expect(email.json().items).toEqual([]);
    // A medium that owns no work items is a bad_request.
    const bad = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox?medium=voice',
      headers: auth(alice.token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('?medium=email does not consume the chat queue (listing marks nothing there)', async () => {
    await dm('still unread');
    await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox?medium=email',
      headers: auth(alice.token),
    });
    const res = await pop();
    expect(res.json().item.message.body).toBe('still unread');
  });

  it('the room-scoped inbox and pop keep their v3 chat-only shapes', async () => {
    const room = await createRoom(ts.app, owner.token, orgId, 'general');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(alice.token),
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/messages`,
      headers: auth(owner.token),
      payload: { body: 'room scoped' },
    });

    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${room}/inbox`,
      headers: auth(alice.token),
    });
    const items = list.json().items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    // No discriminator, no room context — a room has no email.
    expect(items[0]!.type).toBeUndefined();
    expect(items[0]!.room).toBeUndefined();

    const roomPop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room}/inbox/pop`,
      headers: auth(alice.token),
    });
    expect(roomPop.json().message.body).toBe('room scoped');
    expect(roomPop.json().item).toBeUndefined();
  });
});
