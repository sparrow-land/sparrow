import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awaitCandidatePath,
  awaitOwnerPath,
  prepareAwaitGeneration,
  readAwaitOwner,
} from './await-owner.js';

/* ==================================================================
 * THE CANDIDATE MARKER — `<state dir>/await-candidate.json`.
 *
 * The generation record is published LATE (credentials + a round trip), which
 * leaves a window where a listener is genuinely starting and nothing on disk
 * says so: the Stop hook, checking the published owner's pid, would see a dead
 * pid and block a turn whose re-arm is in flight. The marker closes that window
 * WITHOUT touching the publish-late guarantee — it is never read for eviction.
 * ================================================================== */

let stateDir: string;
const env = (): Record<string, string | undefined> => ({ SPARROW_STATE_DIR: stateDir });

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-await-owner-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const candidate = (): any => JSON.parse(fs.readFileSync(awaitCandidatePath(env()), 'utf8'));

describe('prepareAwaitGeneration — the candidate marker', () => {
  it('is written the moment a generation is CONSTRUCTED, before any publish', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await:codex' });

    const c = candidate();
    expect(c.version).toBe(1);
    expect(c.pid).toBe(process.pid);
    expect(typeof c.nonce).toBe('string');
    expect(c.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.now() - Date.parse(c.startedAt)).toBeLessThan(5000);

    // …and this really is BEFORE the publish: nothing owns the state dir yet.
    expect(fs.existsSync(awaitOwnerPath(env()))).toBe(false);
    expect(gen.published()).toBe(false);
    expect(gen.nonce()).toBeUndefined();
  });

  it('carries the same nonce the generation goes on to publish', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    const armed = candidate().nonce;
    expect(gen.publish()).toBe('published');
    expect(readAwaitOwner(env())!.nonce).toBe(armed);
  });

  it('is retired by its own publish — the published record now says the same thing', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(true);
    gen.publish();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  /* A marker is removed ONLY when it is this generation's own — the same
   * never-unlink-blindly rule the owner record follows. Otherwise a slow
   * candidate's cleanup would delete the marker of the listener that overtook
   * it, re-opening the very window the marker exists to close. */
  it('never removes a NEWER candidate\u2019s marker on publish', () => {
    const slow = prepareAwaitGeneration({ env: env(), kind: 'await' });
    prepareAwaitGeneration({ env: env(), kind: 'await' }); // overtakes it
    const newer = candidate().nonce;

    slow.publish();
    expect(candidate().nonce).toBe(newer);
  });

  it('a superseded listener\u2019s exit leaves the successor\u2019s marker alone', () => {
    const first = prepareAwaitGeneration({ env: env(), kind: 'await' });
    first.publish(); // its own marker is retired here
    const second = prepareAwaitGeneration({ env: env(), kind: 'await' });
    const successor = candidate().nonce;

    first.clearCandidate(); // the loser's exit path
    expect(candidate().nonce).toBe(successor);

    // And the successor still retires its own when it gets there.
    second.publish();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  it('clearing is idempotent and safe with no marker on disk at all', () => {
    const gen = prepareAwaitGeneration({ env: env(), kind: 'await' });
    gen.clearCandidate();
    expect(() => gen.clearCandidate()).not.toThrow();
    expect(fs.existsSync(awaitCandidatePath(env()))).toBe(false);
  });

  it('a newer candidate simply overwrites the older one (no unlink, ever)', () => {
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    const first = candidate().nonce;
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(candidate().nonce).not.toBe(first);
  });

  it('is atomic: no temp file is left behind', () => {
    prepareAwaitGeneration({ env: env(), kind: 'await' });
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('an unwritable state dir is skipped silently — arming is never blocked by it', () => {
    const blocker = path.join(stateDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const broken = { SPARROW_STATE_DIR: path.join(blocker, 'nested') };

    const gen = prepareAwaitGeneration({ env: broken, kind: 'await' });
    expect(fs.existsSync(path.join(blocker, 'nested'))).toBe(false);
    // The listener still runs — unfenced, exactly as a failed publish leaves it.
    expect(gen.publish()).toBe('unfenced');
    expect(gen.supersededBy()).toBeUndefined();
    expect(() => gen.clearCandidate()).not.toThrow();
  });
});
