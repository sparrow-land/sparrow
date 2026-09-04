import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The TTS cache must be PUBLISHED, not assembled in place. Both `/speech` paths
 * stage their bytes in a per-request `.part` file and `renameSync` it over the
 * cache path, so the cache entry either does not exist or is the whole clip —
 * never a truncated one. That matters more here than almost anywhere else:
 * message bodies are immutable, so the cache is never invalidated and a
 * half-written file would be heard by every later listener forever.
 *
 * This file mocks `node:fs` as a PASS-THROUGH spy (every function is the real
 * one; two are wrapped so the call order is inspectable), which is why it lives
 * apart from `voice.test.ts` — the mock is module-scoped.
 */
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const fs = await import('node:fs');
const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
const renameSyncSpy = vi.mocked(fs.renameSync);

const { makeTestServer, auth, signup, firstOrgId, joinOrg, createRoom } = await import(
  './test-helpers.js'
);
const { FAKE_MP3 } = await import('./voice/fake.js');

describe('the /speech cache is published atomically (buffered provider)', () => {
  it('writes a per-request .part file and renames it over the cache path', async () => {
    // A buffered-only provider: no `synthesizeStream`, so this exercises the
    // `synthesize` + `writeFileSync` path specifically.
    const clip = Buffer.concat([FAKE_MP3, FAKE_MP3]);
    const ts = await makeTestServer({
      voice: { tts: { id: 'buffered', synthesize: async () => ({ audio: clip, contentType: 'audio/mpeg' }) } },
    });
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: alice.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(alice.token),
    });
    const sent = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body: 'hello', subject: 'Greeting' },
    });
    const msgId = sent.json().message.id as string;
    const cachePath = path.join(ts.dataDir, 'tts', msgId);

    writeFileSyncSpy.mockClear();
    renameSyncSpy.mockClear();

    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/speech`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(clip)).toBe(true);

    // The audio was never written straight to the cache path: a crash or a
    // concurrent writer mid-`writeFileSync` would otherwise leave a truncated
    // file sitting exactly where the next listener looks.
    const audioWrites = writeFileSyncSpy.mock.calls.filter((c) => String(c[0]).includes(msgId));
    expect(audioWrites).toHaveLength(1);
    const staged = String(audioWrites[0]![0]);
    expect(staged).not.toBe(cachePath);
    expect(staged.startsWith(`${cachePath}.`)).toBe(true);
    expect(staged.endsWith('.part')).toBe(true);

    // ...and the cache entry appeared by rename — atomic, so a reader sees the
    // whole clip or no file at all.
    expect(renameSyncSpy).toHaveBeenCalledWith(staged, cachePath);

    // End state: the clip is cached, nothing is left staged.
    expect(readFileSync(cachePath).equals(clip)).toBe(true);
    expect(readdirSync(path.join(ts.dataDir, 'tts'))).toEqual([msgId]);
    await ts.close();
  });

  it('a failing synthesize leaves neither a cache entry nor a stray .part', async () => {
    const ts = await makeTestServer({
      voice: {
        tts: {
          id: 'broken',
          synthesize: async () => {
            throw new Error('vendor said no');
          },
        },
      },
    });
    const owner = await signup(ts.app, { email: 'owner2@example.com', displayName: 'Owner' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    const sent = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { body: 'hello' },
    });
    const msgId = sent.json().message.id as string;

    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/messages/${msgId}/speech`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(502);
    expect(existsSync(path.join(ts.dataDir, 'tts', msgId))).toBe(false);
    expect(readdirSync(path.join(ts.dataDir, 'tts'))).toEqual([]);
    await ts.close();
  });
});
