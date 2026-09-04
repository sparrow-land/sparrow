/**
 * The CLI's heartbeat bridge must record WHICH listener is alive: the Stop hook
 * allows a turn ending under `await` (a wake path — it exits when work arrives)
 * and blocks under `watch`/`loop` (they only hold you online). Passing no kind
 * stays supported and writes an empty file, which the hook reads as
 * "cannot judge".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHeartbeatKind, __resetHeartbeatThrottle } from '@sparrow/skill';
import { touchHeartbeat } from './loop-state.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-hb-'));
  __resetHeartbeatThrottle();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const env = () => ({ SPARROW_STATE_DIR: stateDir });

describe('touchHeartbeat (CLI bridge)', () => {
  it.each(['await', 'watch', 'loop'] as const)('records the %s listener kind', (kind) => {
    touchHeartbeat(env(), kind);
    expect(readHeartbeatKind(stateDir)).toBe(kind);
    expect(fs.existsSync(path.join(stateDir, 'heartbeat'))).toBe(true);
  });

  it('still works with no kind (empty content = unknown listener)', () => {
    touchHeartbeat(env());
    expect(fs.readFileSync(path.join(stateDir, 'heartbeat'), 'utf8')).toBe('');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });
});
