/**
 * Avatars: the resolution chain (uploaded → provider photo → gravatar → null),
 * upload/serve/delete roundtrip + validation, provider-photo intake at sign-in,
 * and the effective `avatarUrl` projected into every human-carrying payload.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256Hex } from '@sparrow/common-types/identity';
import { AVATAR_MAX_BYTES } from '@sparrow/common-types';
import {
  makeTestServer,
  signup,
  joinOrg,
  firstOrgId,
  createRoom,
  makeAgent,
  auth,
  TEST_ADMIN_TOKEN,
  type TestServer,
} from './test-helpers.js';
import type { AuthProvider } from './server.js';

/* A tiny PNG-ish payload; only the bytes matter for the roundtrip. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

/**
 * Test-only auth provider: logs in through the real `loginOrCreateUser` seam,
 * forwarding an optional provider `avatarUrl` so the provider-photo intake path
 * is exercised end-to-end.
 */
const testLoginProvider: AuthProvider = {
  id: 'test-login',
  label: 'Test Login',
  kind: 'credentials',
  register(app, ctx) {
    app.post('/api/v1/auth/test-login', (request, reply) => {
      const body = request.body as { email: string; displayName?: string; avatarUrl?: string };
      const result = ctx.auth.loginOrCreateUser(
        {
          email: body.email,
          displayName: body.displayName,
          provider: 'test-login',
          avatarUrl: body.avatarUrl,
        },
        reply,
      );
      return reply.send(result);
    });
  },
};

function makeServer(): Promise<TestServer> {
  return makeTestServer({ providers: [testLoginProvider] });
}

async function testLogin(
  app: FastifyInstance,
  input: { email: string; displayName?: string; avatarUrl?: string },
): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/test-login', payload: input });
  if (res.statusCode !== 200) throw new Error(`test-login failed (${res.statusCode}): ${res.body}`);
  const body = res.json();
  return { token: body.token as string, userId: body.user.id as string };
}

async function setGravatar(app: FastifyInstance, on: boolean): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/config',
    headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    payload: { values: { 'avatars.gravatar': on } },
  });
  if (res.statusCode !== 200) throw new Error(`set gravatar failed (${res.statusCode}): ${res.body}`);
}

/** The caller's own roster row's resolved avatarUrl. */
async function rosterAvatar(
  app: FastifyInstance,
  token: string,
  orgId: string,
  humanId: string,
): Promise<string | null> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${orgId}/humans`,
    headers: auth(token),
  });
  const items = res.json().items as { human: { id: string; avatarUrl: string | null } }[];
  const row = items.find((i) => i.human.id === humanId);
  if (!row) throw new Error('human not in roster');
  return row.human.avatarUrl;
}

async function uploadAvatar(
  app: FastifyInstance,
  token: string,
  bytes: Buffer,
  contentType = 'image/png',
) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/me/avatar',
    headers: { ...auth(token), 'content-type': contentType },
    payload: bytes,
  });
}

describe('avatar resolution chain', () => {
  it('is null with no upload, no provider photo, gravatar off', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      const orgId = await firstOrgId(ts.app, owner.token);
      expect(await rosterAvatar(ts.app, owner.token, orgId, owner.userId)).toBeNull();
    } finally {
      await ts.close();
    }
  });

  it('gravatar wins over null only when the instance opts in (sha256, d=404)', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'Owner@Example.com' });
      const orgId = await firstOrgId(ts.app, owner.token);
      expect(await rosterAvatar(ts.app, owner.token, orgId, owner.userId)).toBeNull();

      await setGravatar(ts.app, true);
      const expected = `https://www.gravatar.com/avatar/${sha256Hex('owner@example.com')}?d=404`;
      expect(await rosterAvatar(ts.app, owner.token, orgId, owner.userId)).toBe(expected);
    } finally {
      await ts.close();
    }
  });

  it('provider photo beats gravatar; uploaded beats provider photo', async () => {
    const ts = await makeServer();
    try {
      await setGravatar(ts.app, true);
      // First human (founds an org) with a provider photo.
      const person = await testLogin(ts.app, {
        email: 'p@example.com',
        avatarUrl: 'https://cdn.example.com/p.png',
      });
      const orgId = await firstOrgId(ts.app, person.token);
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        'https://cdn.example.com/p.png',
      );

      // Upload wins over the provider photo.
      const up = await uploadAvatar(ts.app, person.token, PNG_BYTES);
      expect(up.statusCode).toBe(200);
      expect(up.json().avatarUrl).toBe(`/api/v1/avatars/${person.userId}`);
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        `/api/v1/avatars/${person.userId}`,
      );
    } finally {
      await ts.close();
    }
  });
});

describe('avatar upload / serve / delete', () => {
  it('roundtrips the exact bytes with content type + cache headers', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      const up = await uploadAvatar(ts.app, owner.token, PNG_BYTES);
      expect(up.statusCode).toBe(200);

      const got = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/avatars/${owner.userId}`,
        headers: auth(owner.token),
      });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.headers['cache-control']).toContain('private');
      expect(Buffer.compare(got.rawPayload, PNG_BYTES)).toBe(0);
    } finally {
      await ts.close();
    }
  });

  it('rejects a non-accepted image type with 400', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      const res = await uploadAvatar(ts.app, owner.token, PNG_BYTES, 'image/gif');
      expect(res.statusCode).toBe(400);
    } finally {
      await ts.close();
    }
  });

  it('rejects an oversized image with 413', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      const big = Buffer.alloc(AVATAR_MAX_BYTES + 1, 7);
      const res = await uploadAvatar(ts.app, owner.token, big, 'image/png');
      expect(res.statusCode).toBe(413);
    } finally {
      await ts.close();
    }
  });

  it('delete clears the avatar; serve then 404s and it falls back down the chain', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      const orgId = await firstOrgId(ts.app, owner.token);
      await uploadAvatar(ts.app, owner.token, PNG_BYTES);

      const del = await ts.app.inject({
        method: 'DELETE',
        url: '/api/v1/me/avatar',
        headers: auth(owner.token),
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().avatarUrl).toBeNull();

      const got = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/avatars/${owner.userId}`,
        headers: auth(owner.token),
      });
      expect(got.statusCode).toBe(404);
      expect(await rosterAvatar(ts.app, owner.token, orgId, owner.userId)).toBeNull();
    } finally {
      await ts.close();
    }
  });

  it('serve is 404 for a principal who shares no org with the target', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com' });
      await uploadAvatar(ts.app, owner.token, PNG_BYTES);
      // A stranger in their own separate org.
      const stranger = await signup(ts.app, { email: 'stranger@example.com' });
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/avatars/${owner.userId}`,
        headers: auth(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await ts.close();
    }
  });
});

describe('provider photo intake at sign-in', () => {
  it('stores the provider photo for a new human and refreshes on later login', async () => {
    const ts = await makeServer();
    try {
      const person = await testLogin(ts.app, {
        email: 'p@example.com',
        avatarUrl: 'https://cdn.example.com/one.png',
      });
      const orgId = await firstOrgId(ts.app, person.token);
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        'https://cdn.example.com/one.png',
      );

      await testLogin(ts.app, { email: 'p@example.com', avatarUrl: 'https://cdn.example.com/two.png' });
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        'https://cdn.example.com/two.png',
      );
    } finally {
      await ts.close();
    }
  });

  it('does not clobber an uploaded avatar; the provider photo survives underneath', async () => {
    const ts = await makeServer();
    try {
      const person = await testLogin(ts.app, {
        email: 'p@example.com',
        avatarUrl: 'https://cdn.example.com/original.png',
      });
      const orgId = await firstOrgId(ts.app, person.token);
      await uploadAvatar(ts.app, person.token, PNG_BYTES);

      // A later login with a NEW provider photo must be ignored while an upload exists.
      await testLogin(ts.app, { email: 'p@example.com', avatarUrl: 'https://cdn.example.com/new.png' });
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        `/api/v1/avatars/${person.userId}`,
      );

      // After deleting the upload, the ORIGINAL provider photo (frozen while the
      // upload existed) resurfaces — not the ignored later one.
      await ts.app.inject({ method: 'DELETE', url: '/api/v1/me/avatar', headers: auth(person.token) });
      expect(await rosterAvatar(ts.app, person.token, orgId, person.userId)).toBe(
        'https://cdn.example.com/original.png',
      );
    } finally {
      await ts.close();
    }
  });
});

describe('avatarUrl in human-carrying payloads', () => {
  it('appears in roster, directory, sidebar, room members, messages, and DM counterpart', async () => {
    const ts = await makeServer();
    try {
      const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
      const orgId = await firstOrgId(ts.app, owner.token);
      const member = await joinOrg(ts.app, owner.token, orgId, 'member@example.com', 'Member');
      // Give the member an uploaded avatar so a concrete URL flows everywhere.
      await uploadAvatar(ts.app, member.token, PNG_BYTES);
      const memberAvatar = `/api/v1/avatars/${member.userId}`;

      // Roster.
      expect(await rosterAvatar(ts.app, owner.token, orgId, member.userId)).toBe(memberAvatar);

      // Directory.
      const dir = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/directory?q=member`,
        headers: auth(owner.token),
      });
      expect(dir.json().items[0].avatarUrl).toBe(memberAvatar);

      // Sidebar humans source (lists the OTHER org human for the caller).
      const side = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${orgId}/me/humans`,
        headers: auth(owner.token),
      });
      const sideItem = (side.json().items as { human: { id: string; avatarUrl: string | null } }[]).find(
        (i) => i.human.id === member.userId,
      );
      expect(sideItem?.human.avatarUrl).toBe(memberAvatar);

      // DM between owner and member: makes both room members without an
      // invitation dance — the counterpart, the room member list, and a message
      // sender ref should all carry the member's avatar.
      const dm = await ts.app.inject({
        method: 'POST',
        url: '/api/v1/me/dms',
        headers: auth(owner.token),
        payload: { principal: member.userId },
      });
      expect(dm.json().counterpart.avatarUrl).toBe(memberAvatar);
      const dmRoomId = dm.json().room.id as string;

      const dmMembersRes = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${dmRoomId}/members`,
        headers: auth(owner.token),
      });
      const dmMemberRows = dmMembersRes.json().items as {
        principalId: string;
        avatarUrl: string | null;
      }[];
      expect(dmMemberRows.find((m) => m.principalId === member.userId)?.avatarUrl).toBe(memberAvatar);

      // Message sender ref (member DMs the owner).
      const send = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${dmRoomId}/messages`,
        headers: auth(member.token),
        payload: { to: owner.userId, body: 'hi' },
      });
      expect(send.statusCode).toBe(201);
      expect(send.json().message.from.avatarUrl).toBe(memberAvatar);

      // Agent member refs are always null (generated client-side). Add an agent
      // to a project room and confirm its member row carries a null avatar.
      const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
      const agent = await makeAgent(ts.app, owner.token, orgId, 'bot');
      await ts.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${roomId}/members`,
        headers: auth(owner.token),
        payload: { principal: agent.id },
      });
      const membersRes = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/members`,
        headers: auth(owner.token),
      });
      const memberRows = membersRes.json().items as { kind: string; avatarUrl: string | null }[];
      expect(memberRows.find((m) => m.kind === 'agent')?.avatarUrl).toBeNull();
    } finally {
      await ts.close();
    }
  });
});
