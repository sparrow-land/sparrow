import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropSession, readSession, sessionsPath, writeSession } from './sessions.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-sessions-'));
  env = { SPARROW_STATE_DIR: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('harness session store', () => {
  it('lives under <state>/harness/sessions.json', () => {
    expect(sessionsPath(env)).toBe(path.join(dir, 'harness', 'sessions.json'));
  });

  it('round-trips a session id per (profile, conversation)', () => {
    writeSession(env, 'work', 'room:room_a', 'uuid-1');
    writeSession(env, 'work', 'room:room_b', 'uuid-2');
    writeSession(env, 'other', 'room:room_a', 'uuid-3');
    expect(readSession(env, 'work', 'room:room_a')).toBe('uuid-1');
    expect(readSession(env, 'work', 'room:room_b')).toBe('uuid-2');
    expect(readSession(env, 'other', 'room:room_a')).toBe('uuid-3');
    expect(readSession(env, 'work', 'room:nope')).toBeUndefined();
  });

  it('drops a session id (a failed --resume) without touching its neighbours', () => {
    writeSession(env, 'work', 'room:room_a', 'uuid-1');
    writeSession(env, 'work', 'room:room_b', 'uuid-2');
    dropSession(env, 'work', 'room:room_a');
    expect(readSession(env, 'work', 'room:room_a')).toBeUndefined();
    expect(readSession(env, 'work', 'room:room_b')).toBe('uuid-2');
  });

  it('reads a missing or corrupt store as empty and never throws', () => {
    expect(readSession(env, 'work', 'room:room_a')).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'harness'), { recursive: true });
    fs.writeFileSync(sessionsPath(env), 'not json at all');
    expect(readSession(env, 'work', 'room:room_a')).toBeUndefined();
    expect(() => writeSession(env, 'work', 'room:room_a', 'uuid-1')).not.toThrow();
    expect(readSession(env, 'work', 'room:room_a')).toBe('uuid-1');
  });

  it('writes the store 0600 (it names conversations, if not secrets)', () => {
    writeSession(env, 'work', 'room:room_a', 'uuid-1');
    expect(fs.statSync(sessionsPath(env)).mode & 0o777).toBe(0o600);
  });
});
