import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  listen,
  openSse,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

/**
 * Org room governance (SPEC "Rooms & members → Org room governance"): an org
 * owner/admin can SEE every room in their org and ARCHIVE/RESTORE any of them
 * without being a member — and gains no read access to a single message by
 * doing so. Enumeration is a summary (id, name, kind, member count, archived,
 * created); DM rooms are never enumerated.
 */
describe('org room governance', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@ex.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  const listRooms = (token: string, org = orgId) =>
    ts.app.inject({ method: 'GET', url: `/api/v1/orgs/${org}/rooms`, headers: auth(token) });

  const setArchived = (token: string, roomId: string, archived: boolean, org = orgId) =>
    ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${org}/rooms/${roomId}`,
      headers: auth(token),
      payload: { archived },
    });

  const send = (token: string, roomId: string, body = 'hi') =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(token),
      payload: { body },
    });

  /* ------------------------------ enumerate ------------------------- */

  it('lists every project room in the org — including ones the admin never joined', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    const mine = await createRoom(ts.app, owner.token, orgId, 'Ops');
    const theirs = await createRoom(ts.app, member.token, orgId, 'Secret Project');
    // A DM between the two humans: a room, but never an enumerated one.
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: member.userId },
    });
    expect(dm.statusCode).toBeLessThan(300);

    const res = await listRooms(owner.token);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as any[];
    expect(items.map((r) => r.id).sort()).toEqual([mine, theirs].sort());
    const secret = items.find((r) => r.id === theirs)!;
    expect(secret).toMatchObject({ name: 'Secret Project', kind: 'project', archivedAt: null });
    expect(secret.memberCount).toBe(1);
    expect(typeof secret.createdAt).toBe('string');
    // Governance is not a reading surface: no message ever rides the summary.
    expect('messages' in secret).toBe(false);
    expect('settings' in secret).toBe(false);
  });

  it('is owner/admin only: a plain member is refused, a non-member gets 404', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    await createRoom(ts.app, owner.token, orgId, 'Ops');
    expect((await listRooms(member.token)).statusCode).toBe(403);

    // An admin (promoted) may.
    await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/humans/${member.userId}`,
      headers: auth(owner.token),
      payload: { role: 'admin' },
    });
    expect((await listRooms(member.token)).statusCode).toBe(200);

    // Someone with no membership at all cannot even tell the org exists.
    const stranger = await signup(ts.app, { email: 'x@ex.com', displayName: 'Ex' });
    expect((await listRooms(stranger.token)).statusCode).toBe(404);
  });

  /* --------------------------- archive/restore ---------------------- */

  it('archives and restores a room the admin is not a member of', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    const roomId = await createRoom(ts.app, member.token, orgId, 'Noise');
    expect((await send(member.token, roomId)).statusCode).toBe(201);

    const archived = await setArchived(owner.token, roomId, true);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().room.archivedAt).not.toBeNull();

    // Ordinary archived-room semantics apply, unchanged: mutation 410, history readable.
    expect((await send(member.token, roomId)).statusCode).toBe(410);
    const hist = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(member.token),
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().items).toHaveLength(1);
    expect((await listRooms(owner.token)).json().items[0].archivedAt).not.toBeNull();

    const restored = await setArchived(owner.token, roomId, false);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().room.archivedAt).toBeNull();
    expect((await send(member.token, roomId)).statusCode).toBe(201);
  });

  it('grants no read access and no membership — governance is not a way in', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    const roomId = await createRoom(ts.app, member.token, orgId, 'Private');
    await send(member.token, roomId, 'a secret');
    await setArchived(owner.token, roomId, true);

    for (const url of [
      `/api/v1/rooms/${roomId}/messages`,
      `/api/v1/rooms/${roomId}/members`,
      `/api/v1/rooms/${roomId}`,
    ]) {
      const res = await ts.app.inject({ method: 'GET', url, headers: auth(owner.token) });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    // Nor did archiving quietly add the admin to the room.
    const rooms = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/rooms',
      headers: auth(owner.token),
    });
    expect((rooms.json().items as any[]).some((r) => r.room.id === roomId)).toBe(false);
  });

  it('refuses a DM room and any body that is not exactly {archived}', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    const roomId = await createRoom(ts.app, member.token, orgId, 'Noise');
    const dm = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/dms',
      headers: auth(owner.token),
      payload: { principal: member.userId },
    });
    const dmRoomId = dm.json().room.id as string;

    expect((await setArchived(owner.token, dmRoomId, true)).statusCode).toBe(404);
    const rename = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${orgId}/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { name: 'Renamed' },
    });
    expect(rename.statusCode).toBe(400);
    // A room in another org is invisible here, even to this org's owner.
    const other = await signup(ts.app, { email: 'o2@ex.com', displayName: 'Other' });
    const otherOrg = (
      await ts.app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: auth(other.token),
        payload: { name: 'Elsewhere Inc' },
      })
    ).json().org.id as string;
    const otherRoom = await createRoom(ts.app, other.token, otherOrg, 'Elsewhere');
    expect((await setArchived(owner.token, otherRoom, true)).statusCode).toBe(404);
  });

  it('live: members of the archived room see room.updated', async () => {
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@ex.com', 'Mia');
    const roomId = await createRoom(ts.app, member.token, orgId, 'Noise');
    const base = await listen(ts);
    const sse = await openSse(base, `/api/v1/rooms/${roomId}/events`, member.token);
    await setArchived(owner.token, roomId, true);
    const ev = await sse.waitFor((e) => e.event === 'room.updated');
    expect((ev.data as any).room.archivedAt).not.toBeNull();
    sse.close();
  });
});
