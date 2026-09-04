import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from '@sparrow/common-types';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  makeAgent,
  TEST_ADMIN_TOKEN,
  type TestServer,
  type SignedUpHuman,
} from './test-helpers.js';
import { FAKE_MP3, FAKE_TRANSCRIPT } from './voice/fake.js';

/** Invite an org member into a room and accept; returns their member id. */
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

const b64 = (s: string) => Buffer.from(s).toString('base64');

/* ------------------------------- Capabilities ---------------------- */
describe('GET /capabilities', () => {
  it('reports false/false when no voice provider is registered', async () => {
    const ts = await makeTestServer();
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      voice: { stt: false, tts: false },
      // v4: the email medium's on/off rides here too, and whether an automatic
      // reviewer (an LlmJudge) is registered — neither is on this bare server.
      email: false,
      emailReviewer: false,
      orgHostSuffix: null,
      workspaceSwitcher: null,
    });
    await ts.close();
  });

  it('reports true/true with VOICE_PROVIDER=fake (no auth required)', async () => {
    const ts = await makeTestServer({ voiceProvider: 'fake' });
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json()).toEqual({
      voice: { stt: true, tts: true },
      email: false,
      emailReviewer: false,
      orgHostSuffix: null,
      workspaceSwitcher: null,
    });
    await ts.close();
  });

  it('workspaceSwitcher is null until a directory URL is configured', async () => {
    const ts = await makeTestServer();
    const before = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(before.json().workspaceSwitcher).toBeNull();

    // Configuring only the directory URL exposes the switcher with no create link.
    await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
      payload: { values: { 'workspace.directoryUrl': 'https://dir.example.com/api/v1/me/workspaces' } },
    });
    const dirOnly = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(dirOnly.json().workspaceSwitcher).toEqual({
      directoryUrl: 'https://dir.example.com/api/v1/me/workspaces',
      createUrl: null,
    });

    // Adding the create URL surfaces it too.
    await ts.app.inject({
      method: 'PUT',
      url: '/api/v1/config',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
      payload: { values: { 'workspace.createUrl': 'https://dir.example.com/new' } },
    });
    const both = await ts.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(both.json().workspaceSwitcher).toEqual({
      directoryUrl: 'https://dir.example.com/api/v1/me/workspaces',
      createUrl: 'https://dir.example.com/new',
    });
    await ts.close();
  });
});

/* ------------------------------- Transcriptions -------------------- */
describe('POST /voice/transcriptions', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  beforeEach(async () => {
    ts = await makeTestServer({ voiceProvider: 'fake' });
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
  });
  afterEach(async () => {
    await ts.close();
  });

  const transcribe = (token: string | null, payload: unknown) =>
    ts.app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcriptions',
      headers: token ? auth(token) : {},
      payload: payload as Record<string, unknown>,
    });

  it('happy path (fake) → 200 with the deterministic transcript', async () => {
    const res = await transcribe(owner.token, { audioBase64: b64('audio'), contentType: 'audio/webm' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: FAKE_TRANSCRIPT });
  });

  it('accepts an agent key (principal-scoped)', async () => {
    const orgId = await firstOrgId(ts.app, owner.token);
    const agent = await makeAgent(ts.app, owner.token, orgId, 'scribe-bot');
    const res = await transcribe(agent.key, { audioBase64: b64('a'), contentType: 'audio/webm' });
    expect(res.statusCode).toBe(200);
  });

  it('413 when decoded audio exceeds the cap', async () => {
    const oversize = Buffer.alloc(MAX_TRANSCRIPTION_AUDIO_BYTES + 1).toString('base64');
    const res = await transcribe(owner.token, { audioBase64: oversize, contentType: 'audio/webm' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it('401 when unauthenticated', async () => {
    const res = await transcribe(null, { audioBase64: b64('a'), contentType: 'audio/webm' });
    expect(res.statusCode).toBe(401);
  });

  it('404 when no STT provider is registered', async () => {
    const keyless = await makeTestServer();
    const human = await signup(keyless.app, { email: 'k@example.com' });
    const res = await keyless.app.inject({
      method: 'POST',
      url: '/api/v1/voice/transcriptions',
      headers: auth(human.token),
      payload: { audioBase64: b64('a'), contentType: 'audio/webm' },
    });
    expect(res.statusCode).toBe(404);
    await keyless.close();
  });
});

/* ------------------------------- Origin round-trip ----------------- */
describe('message origin', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let roomId: string;
  beforeEach(async () => {
    ts = await makeTestServer();
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  });
  afterEach(async () => {
    await ts.close();
  });

  const send = (payload: Record<string, unknown>) =>
    ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload,
    });

  it("origin 'voice' round-trips through send, read, pop, and outbox", async () => {
    const res = await send({ to: alice.userId, body: 'dictated', origin: 'voice' });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.origin).toBe('voice');
    const msgId = res.json().message.id as string;

    const read = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}?peek=true`,
      headers: auth(alice.token),
    });
    expect(read.json().message.origin).toBe('voice');

    const pop = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/inbox/pop`,
      headers: auth(alice.token),
    });
    expect(pop.json().message.origin).toBe('voice');

    const outbox = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/outbox`,
      headers: auth(owner.token),
    });
    expect(outbox.json().items[0].origin).toBe('voice');
  });

  it('absent origin projects as null', async () => {
    const res = await send({ to: alice.userId, body: 'typed' });
    expect(res.json().message.origin).toBeNull();
  });

  it("rejects an unknown origin (e.g. 'email') → 400", async () => {
    const res = await send({ to: alice.userId, body: 'x', origin: 'email' });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------- Speech ---------------------------- */
describe('GET /rooms/:roomId/messages/:id/speech', () => {
  let ts: TestServer;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;

  async function setup(overrides = {}) {
    ts = await makeTestServer(overrides);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await addToRoom(ts, owner.token, roomId, alice);
  }

  async function sendDm(to: string, payload: Record<string, unknown> = {}): Promise<string> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to, body: 'hello **world**', subject: 'Greeting', ...payload },
    });
    return res.json().message.id as string;
  }

  afterEach(async () => {
    await ts.close();
  });

  it('200 with inline audio/mpeg via the fake provider', async () => {
    await setup({ voiceProvider: 'fake' });
    const msgId = await sendDm(alice.userId);
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/speech`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(Buffer.from(res.rawPayload).equals(FAKE_MP3)).toBe(true);
  });

  it('caches: a second fetch serves identical bytes without re-calling the provider', async () => {
    const synthesize = vi.fn(async () => ({ audio: FAKE_MP3, contentType: 'audio/mpeg' }));
    await setup({ voice: { tts: { id: 'spy', synthesize } } });
    const msgId = await sendDm(alice.userId);
    const url = `/api/v1/rooms/${roomId}/messages/${msgId}/speech`;
    const first = await ts.app.inject({ method: 'GET', url, headers: auth(alice.token) });
    const second = await ts.app.inject({ method: 'GET', url, headers: auth(alice.token) });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(Buffer.from(second.rawPayload).equals(Buffer.from(first.rawPayload))).toBe(true);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('any room member can fetch speech (flat visibility), even with no recipient row', async () => {
    await setup({ voiceProvider: 'fake' });
    // Carol joins AFTER the message, so she never gets a recipient row for it —
    // yet as a room member she reads the whole room, speech included.
    const msgId = await sendDm(alice.userId);
    const carol = await joinOrg(ts.app, owner.token, orgId, 'carol@example.com', 'Carol');
    await addToRoom(ts, owner.token, roomId, carol);
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/speech`,
      headers: auth(carol.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  });

  it('404 when no TTS provider is registered', async () => {
    await setup();
    const msgId = await sendDm(alice.userId);
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/speech`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
