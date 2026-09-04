import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('/me rooms, invitations, inbox & sidebar', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  const open: SseClient[] = [];

  beforeEach(async () => {
    ts = await makeTestServer();
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  it('GET /me/rooms lists memberships incl. DM counterpart', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    void roomId;
    const bot = await makeAgent(ts.app, owner.token, orgId, 'bot');
    await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: bot.id },
    });
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/rooms?org=${orgId}`,
      headers: auth(owner.token),
    });
    const items = res.json().items as { room: { kind: string; counterpart?: { id: string } } }[];
    // general project room + DM-with-bot + auto owner↔alice DM (alice was invited).
    expect(items).toHaveLength(3);
    const dm = items.find((i) => i.room.counterpart?.id === bot.id)!;
    expect(dm.room.kind).toBe('dm');
    const project = items.find((i) => i.room.kind === 'project')!;
    expect(project.room.counterpart).toBeUndefined();
  });

  it('room-invitations: list, accept (joins), decline', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/room-invitations',
      headers: auth(alice.token),
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].room.id).toBe(roomId);

    const rin = list.json().items[0].id as string;
    const accept = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${rin}/accept`,
      headers: auth(alice.token),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().member.kind).toBe('human');
    // Now a member.
    const whoami = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/whoami`,
      headers: auth(alice.token),
    });
    expect(whoami.statusCode).toBe(200);
    // Invitation list is now empty; decline of a resolved one → 404.
    const decline = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${rin}/decline`,
      headers: auth(alice.token),
    });
    expect(decline.statusCode).toBe(404);
  });

  it('leave: sole owner → 409', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const res = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/rooms/${roomId}`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('/me/inbox + /me/inbox/pop drain across memberships in order', async () => {
    // DM owner↔alice, plus a shared project room.
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: alice.userId },
    });
    const dmRoom = dm.json().room.id as string;
    const project = await createRoom(ts.app, owner.token, orgId, 'general');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${project}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(alice.token),
    });

    // owner sends in DM first, then broadcast in the project room.
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoom}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'dm-first' },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${project}/messages`,
      headers: auth(owner.token),
      payload: { to: 'all', body: 'project-second' },
    });

    const inbox = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      headers: auth(alice.token),
    });
    const items = inbox.json().items as {
      type: string;
      preview: string;
      room: { id: string; kind: string; counterpart?: unknown };
    }[];
    expect(items.map((i) => i.preview)).toEqual(['dm-first', 'project-second']);
    // v4: every principal-inbox item is discriminated on `type` (chat today).
    expect(items.map((i) => i.type)).toEqual(['chat.message', 'chat.message']);
    // DM item carries counterpart; project item does not.
    expect(items[0]!.room.counterpart).toBeDefined();
    expect(items[1]!.room.counterpart).toBeUndefined();

    const pop = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(alice.token),
    });
    // v4: the pop response is a typed WorkItem — `{ message, room }` is gone.
    expect(pop.json().item.type).toBe('chat.message');
    expect(pop.json().item.message.body).toBe('dm-first');
    expect(pop.json().item.room.id).toBe(dmRoom);
  });

  it('/me/inbox/pop with note/ttlSeconds but no ack → 400 with a docs link (not a silent no-op)', async () => {
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: alice.userId },
    });
    const dmRoom = dm.json().room.id as string;
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${dmRoom}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'hello' },
    });

    const bad = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(alice.token),
      payload: { note: 'on it' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('note/ttlSeconds require ack: true');
    expect(bad.json().error.docs).toBe('http://localhost:8722/docs/api/me/inbox');

    // The rejected call did not consume the message.
    const ok = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(alice.token),
      payload: { ack: true, note: 'on it' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().item.message.body).toBe('hello');
  });

  it('sidebar /orgs/:orgId/me/humans lists every org member; shared-room lastSeen else null', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    const list = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/room-invitations',
      headers: auth(alice.token),
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${list.json().items[0].id}/accept`,
      headers: auth(alice.token),
    });
    // A third human shares no room with alice — but is still an org member.
    await joinOrg(ts.app, owner.token, orgId, 'carol@example.com', 'Carol');

    const humans = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/humans`,
      headers: auth(alice.token),
    });
    const items = humans.json().items as {
      human: { id: string; displayName: string };
      online: boolean;
      lastSeenAt: string | null;
    }[];
    const names = items.map((i) => i.human.displayName);
    // Every org member EXCEPT the caller (Alice) — Carol appears despite no shared room.
    expect(new Set(names)).toEqual(new Set(['Owner', 'Carol']));
    expect(names).not.toContain('Alice');

    const ownerItem = items.find((i) => i.human.displayName === 'Owner')!;
    const carolItem = items.find((i) => i.human.displayName === 'Carol')!;
    // Owner shares rooms with alice → a real last-seen; Carol shares none → null.
    expect(typeof ownerItem.lastSeenAt).toBe('string');
    expect(carolItem.lastSeenAt).toBeNull();
    expect(ownerItem.online).toBe(false);
  });

  it('sidebar /orgs/:orgId/me/humans sorts online > recent > never, ties by name', async () => {
    // Owner shares the general room + auto-DM with alice → a real (recent) last-seen.
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    const inv = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/room-invitations',
      headers: auth(alice.token),
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().items[0].id}/accept`,
      headers: auth(alice.token),
    });
    // Two never-seen members (no shared room with alice), plus one who is online.
    await joinOrg(ts.app, owner.token, orgId, 'carol@example.com', 'Carol');
    await joinOrg(ts.app, owner.token, orgId, 'bob@example.com', 'Bob');
    const zoe = await joinOrg(ts.app, owner.token, orgId, 'zoe@example.com', 'Zoe');

    // Zoe holds a live stream → online, even with a null last-seen (shares no room).
    open.push(await openSse(base, '/api/v1/me/events', zoe.token));
    await sleep(50);

    const humans = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/humans`,
      headers: auth(alice.token),
    });
    const names = (
      humans.json().items as { human: { displayName: string }; online: boolean }[]
    ).map((i) => i.human.displayName);
    // Zoe (online) first; Owner (recent last-seen) next; then the never-seen pair by name.
    expect(names).toEqual(['Zoe', 'Owner', 'Bob', 'Carol']);
  });

  it('sidebar /orgs/:orgId/me/humans rejects a non-member with 404', async () => {
    const outsider = await signup(ts.app, {
      email: 'outsider@example.com',
      displayName: 'Outsider',
    });
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${orgId}/me/humans`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
