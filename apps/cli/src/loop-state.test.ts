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
import { markHeartbeatBlocked, markHeartbeatOrphaned, touchHeartbeat } from './loop-state.js';

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
  it.each(['await', 'await:codex', 'watch', 'loop'] as const)('records the %s listener kind', (kind) => {
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

/* The CLI's adapters: env → state dir, then `@sparrow/skill`'s one writer
 * (whose own tests pin the shape, mtime and failure behaviour). */
describe('markHeartbeatBlocked / markHeartbeatOrphaned (CLI bridge)', () => {
  const read = (): string => fs.readFileSync(path.join(stateDir, 'heartbeat'), 'utf8');

  it('write into the state dir the env resolves', () => {
    markHeartbeatBlocked(env(), 'usage-limit', 'n1');
    expect(read()).toBe('blocked:usage-limit n1\n');
    markHeartbeatOrphaned(env(), 'n2');
    expect(read()).toBe('orphaned n2\n');
    markHeartbeatOrphaned(env());
    expect(read()).toBe('orphaned\n');
  });
});
