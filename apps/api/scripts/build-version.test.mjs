import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildInfo, computeBuildVersion } from './build-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/scripts → repo root (sparrow-core) is three levels up.
const repoRoot = path.resolve(here, '..', '..', '..');

/** A fake repo root outside any git work tree, with a known package version. */
async function nonGitRoot(version = '9.9.9') {
  const dir = await mkdtemp(path.join(tmpdir(), 'sparrow-buildver-'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}

describe('computeBuildVersion', () => {
  it('uses BUILD_SHA from the environment verbatim, before any git fallback', async () => {
    const root = await nonGitRoot();
    const v = await computeBuildVersion({ repoRoot: root, env: { BUILD_SHA: 'abc1234' } });
    expect(v).toMatch(/^9\.9\.9\+\d{8}\.abc1234$/);
  });

  it('trims BUILD_SHA and ignores it when blank', async () => {
    const root = await nonGitRoot();
    const padded = await computeBuildVersion({ repoRoot: root, env: { BUILD_SHA: '  abc1234\n' } });
    expect(padded).toMatch(/\.abc1234$/);
    const blank = await computeBuildVersion({ repoRoot: root, env: { BUILD_SHA: '   ' } });
    expect(blank).toMatch(/\.dev$/); // blank → same as unset → git (absent here) → dev
  });

  it('falls back to the git short sha when BUILD_SHA is unset', async () => {
    const v = await computeBuildVersion({ repoRoot, env: {} });
    // Inside this git checkout the sha resolves; it must be hex, not "dev".
    expect(v).toMatch(/^\d+\.\d+\.\d+\+\d{8}\.[0-9a-f]{7,}$/);
  });

  it('falls back to "dev" outside a git checkout with no BUILD_SHA', async () => {
    const root = await nonGitRoot('1.2.3');
    const v = await computeBuildVersion({ repoRoot: root, env: {} });
    expect(v).toMatch(/^1\.2\.3\+\d{8}\.dev$/);
  });

  it('stamps the current UTC date', async () => {
    const root = await nonGitRoot();
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const v = await computeBuildVersion({ repoRoot: root, env: { BUILD_SHA: 'f00' } });
    expect(v).toBe(`9.9.9+${yyyymmdd}.f00`);
  });
});

/**
 * The SERVER reports the same version + build the client bundles are stamped
 * with (`GET /healthz`, `GET /api/v1/meta`), so both come out of one place.
 */
describe('computeBuildInfo', () => {
  it('splits the stamp into the product version and the build part', async () => {
    const root = await nonGitRoot('1.2.3');
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const info = await computeBuildInfo({ repoRoot: root, env: { BUILD_SHA: 'abc1234' } });
    expect(info).toEqual({
      version: '1.2.3',
      sha: 'abc1234',
      build: `${yyyymmdd}.abc1234`,
      buildVersion: `1.2.3+${yyyymmdd}.abc1234`,
    });
  });

  it('agrees exactly with computeBuildVersion', async () => {
    const root = await nonGitRoot('4.5.6');
    const env = { BUILD_SHA: 'cafe123' };
    const now = new Date('2026-09-04T00:00:00Z');
    const info = await computeBuildInfo({ repoRoot: root, env, now });
    expect(info.buildVersion).toBe(await computeBuildVersion({ repoRoot: root, env, now }));
  });

  it('marks an unstamped non-git build "dev" (never ship one)', async () => {
    const root = await nonGitRoot('1.2.3');
    const info = await computeBuildInfo({ repoRoot: root, env: {} });
    expect(info.sha).toBe('dev');
    expect(info.build).toMatch(/^\d{8}\.dev$/);
  });
});
