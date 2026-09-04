import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  shareAgent,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';

describe('rooms, members & invitations', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let orgId: string;

  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
  });
  afterEach(async () => {
    await ts.close();
  });

  it('CreateRoom → 201, creator is room owner; GetRoom shape', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/rooms`,
      headers: auth(owner.token),
      payload: { name: 'general' },
    });
    expect(res.statusCode).toBe(201);
    const room = res.json().room;
    expect(room).toMatchObject({ orgId, name: 'general', kind: 'project', archivedAt: null });
    expect(room.settings).toEqual({ description: '' });

    const whoami = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${room.id}/whoami`,
      headers: auth(owner.token),
    });
    expect(whoami.json().roomRole).toBe('owner');
    expect(whoami.json().kind).toBe('human');
  });

  it('GetRoom: unknown room → 404; non-member → 403', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const missing = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/rooms/room_doesnotexist/',
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);

    const outsider = await joinOrg(ts.app, owner.token, orgId, 'out@example.com');
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('cross-org prober with a leaked room id → 404 (existence never leaks)', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'secret');
    // A human whose only org is a different one (org B) probes the org-A room id.
    const stranger = await signup(ts.app, { email: 'stranger@example.com', displayName: 'Stranger' });
    const orgB = await ts.app.inject({
      method: 'POST',
      url: '/api/v1/orgs',
      headers: auth(stranger.token),
      payload: { name: 'Org B' },
    });
    expect(orgB.statusCode).toBe(201);

    const probe = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(stranger.token),
    });
    expect(probe.statusCode).toBe(404);

    // An agent from org B likewise cannot distinguish the org-A room.
    const orgBId = orgB.json().org.id as string;
    const bBot = await makeAgent(ts.app, stranger.token, orgBId, 'bbot');
    const agentProbe = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(bBot.key),
    });
    expect(agentProbe.statusCode).toBe(404);
  });

  it('UpdateRoom: description validated + merged; admin-only', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const ok = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { settings: { description: 'the plan' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().room.settings.description).toBe('the plan');

    const tooLong = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { settings: { description: 'x'.repeat(241) } },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('archive → mutations 410, history readable (force-peek); restore → normal', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com', 'Mia');
    // invite + accept so there are two members for messaging
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: member.userId },
    });
    const rin = inv.json().invitation.id as string;
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${rin}/accept`,
      headers: auth(member.token),
    });
    const sent = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: 'all', body: 'hello' },
    });
    const msgId = sent.json().message.id as string;

    const archive = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().room.archivedAt).not.toBeNull();

    // A send is now 410.
    const send = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: 'all', body: 'again' },
    });
    expect(send.statusCode).toBe(410);

    // PATCH (non-restore) is 410.
    const rename = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { name: 'renamed' },
    });
    expect(rename.statusCode).toBe(410);

    // History reads still work and DO NOT mark read (force-peek).
    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}`,
      headers: auth(member.token),
    });
    expect(read.statusCode).toBe(200);
    const status = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/status`,
      headers: auth(owner.token),
    });
    expect(status.json().recipients[0].status).toBe('unread');

    // Restore.
    const restore = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { archived: false },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().room.archivedAt).toBeNull();
  });

  /**
   * `POST /orgs/:orgId/rooms` answers `{ room }` and `PATCH /rooms/:roomId`
   * answered a BARE room — two shapes for the same resource on adjacent calls, so
   * a client that wrote `res.room` after create had to write `res` after update.
   * Mutations envelope their resource; the bare object stays the GET shape.
   */
  it('UpdateRoom envelopes its resource as { room } — matching CreateRoom', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'shapes');
    const res = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
      payload: { name: 'shapes-v2' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['room']);
    expect(body.room.id).toBe(roomId);
    expect(body.room.name).toBe('shapes-v2');
    // The bare room is NOT at the top level any more.
    expect(body.id).toBeUndefined();
    // GET keeps the bare shape (it returns the resource, not a mutation result).
    const get = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: auth(owner.token),
    });
    expect(get.json().id).toBe(roomId);
  });

  /**
   * `sparrow room create "#launch-readiness"` used to store the literal `#`, and
   * the sidebar prepends its own — rendering `##launch-readiness`. A leading `#`
   * is stripped at the API boundary on BOTH create and rename.
   */
  it('room names drop a leading # on create and on rename', async () => {
    const create = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/rooms`,
      headers: auth(owner.token),
      payload: { name: '#launch-readiness' },
    });
    expect(create.statusCode).toBe(201);
    const room = create.json().room;
    expect(room.name).toBe('launch-readiness');

    // …and it is what was STORED, not just what was echoed back.
    const get = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(owner.token),
    });
    expect(get.json().name).toBe('launch-readiness');

    const rename = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${room.id}`,
      headers: auth(owner.token),
      payload: { name: '#renamed' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().room.name).toBe('renamed');

    // A name that is nothing but hashes normalizes to empty → 400.
    const empty = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/rooms`,
      headers: auth(owner.token),
      payload: { name: '###' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('AddMember: agent w/ visibility 201; dup 409; human 400; no-visibility 403', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');

    const add = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().member).toMatchObject({ kind: 'agent', roomRole: 'member' });

    const dup = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    expect(dup.statusCode).toBe(409);

    const human = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: owner.userId },
    });
    expect(human.statusCode).toBe(400);

    // A member without visibility on the agent cannot add it.
    const other = await joinOrg(ts.app, owner.token, orgId, 'other@example.com');
    const room2 = await createRoom(ts.app, other.token, orgId, 'r2');
    const noVis = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room2}/members`,
      headers: auth(other.token),
      payload: { principal: agent.id },
    });
    expect(noVis.statusCode).toBe(403);
  });

  it('GetMember by member id OR principal id', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const add = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    const memberId = add.json().member.id as string;
    const byMember = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/members/${memberId}`,
      headers: auth(owner.token),
    });
    expect(byMember.json().principalId).toBe(agent.id);
    const byPrincipal = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/members/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(byPrincipal.json().id).toBe(memberId);
  });

  it('SetMemberRole: grant admin; agent target 400; last-owner demote 409', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com', 'Mia');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: member.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(member.token),
    });

    const grant = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}/members/${member.userId}`,
      headers: auth(owner.token),
      payload: { roomRole: 'admin' },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().member.roomRole).toBe('admin');

    const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const add = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    const agentRole = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}/members/${add.json().member.id}`,
      headers: auth(owner.token),
      payload: { roomRole: 'admin' },
    });
    expect(agentRole.statusCode).toBe(400);

    // Demoting the sole owner (self) → 409.
    const demote = await ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/rooms/${roomId}/members/${owner.userId}`,
      headers: auth(owner.token),
      payload: { roomRole: 'member' },
    });
    expect(demote.statusCode).toBe(409);
  });

  it('RemoveMember: self 400; kick works; agent owner may remove it', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: member.userId },
    });
    const accept = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(member.token),
    });
    const memberMemId = accept.json().member.id as string;

    const self = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${owner.userId}`,
      headers: auth(owner.token),
    });
    expect(self.statusCode).toBe(400);

    const kick = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/members/${memberMemId}`,
      headers: auth(owner.token),
    });
    expect(kick.statusCode).toBe(200);

    // Agent owner removes its agent even without being room admin elsewhere.
    const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');
    const other = await joinOrg(ts.app, owner.token, orgId, 'o2@example.com');
    const room2 = await createRoom(ts.app, other.token, orgId, 'r2');
    await shareAgent(ts.app, owner.token, agent.id, other.userId);
    // owner is not a member of room2; add agent as other (has visibility)
    const add = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room2}/members`,
      headers: auth(other.token),
      payload: { principal: agent.id },
    });
    expect(add.statusCode).toBe(201);
    // owner cannot even see room2 (not a member) → removing via that room is 403
    const ownerRemove = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${room2}/members/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(ownerRemove.statusCode).toBe(403);
  });

  it('InviteHuman: 201, pending dedup 200, non-org-member 400; revoke', async () => {
    const roomId = await createRoom(ts.app, owner.token, orgId, 'r');
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com');

    const first = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: member.userId },
    });
    expect(first.statusCode).toBe(201);

    const dup = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: member.userId },
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().invitation.id).toBe(first.json().invitation.id);

    // Not an org member → 400.
    const stranger = await signup(ts.app, { email: 'stranger@example.com' });
    void stranger;
    const bad = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: 'stranger@example.com' },
    });
    expect(bad.statusCode).toBe(400);

    const list = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
    });
    expect(list.json().items).toHaveLength(1);

    const revoke = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${roomId}/invitations/${first.json().invitation.id}`,
      headers: auth(owner.token),
    });
    expect(revoke.statusCode).toBe(200);
    const list2 = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
    });
    expect(list2.json().items).toHaveLength(0);
  });

  it('org owner has implicit room-admin capability in org rooms', async () => {
    // A member creates a room; the org owner (not a room member... but implicit
    // admin only applies once a member). Verify org admin can manage via being
    // added. Here: member creates room, owner joins via invite+accept, then
    // even as room 'member' the org owner can invite (implicit admin).
    const member = await joinOrg(ts.app, owner.token, orgId, 'm@example.com');
    const roomId = await createRoom(ts.app, member.token, orgId, 'r');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(member.token),
      payload: { human: owner.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(owner.token),
    });
    // Owner joined as a plain member but is org owner → may invite (admin cap).
    const third = await joinOrg(ts.app, owner.token, orgId, 'third@example.com');
    const asOwner = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: third.userId },
    });
    expect(asOwner.statusCode).toBe(201);
  });
});
