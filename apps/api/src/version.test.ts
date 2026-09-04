import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_VERSION, BUILD_STAMP, resolveBuildInfo } from './version.js';

/**
 * The server used to report `@sparrow/api`'s own package version (0.1.0, frozen
 * since the first commit) while the product shipped as the ROOT package version.
 * `resolveBuildInfo` resolves the root version plus the bundler's build stamp.
 */
describe('resolveBuildInfo', () => {
  let root: string;
  let moduleDir: string;

  beforeEach(() => {
    // A miniature workspace shaped like the real one: <root>/package.json is the
    // product ("sparrow"), <root>/apps/api/package.json is the api package, and
    // the module lives at <root>/apps/api/src.
    root = mkdtempSync(path.join(tmpdir(), 'sparrow-version-'));
    moduleDir = path.join(root, 'apps', 'api', 'src');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'sparrow', version: '9.9.9' }),
    );
    writeFileSync(
      path.join(root, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: '@sparrow/api', version: '0.1.0' }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the ROOT product version, not the api package version', () => {
    expect(resolveBuildInfo({ moduleDir, env: {} }).version).toBe('9.9.9');
  });

  it('reads the build stamp the bundler writes next to the install assets', () => {
    const assets = path.join(root, 'apps', 'api', 'install-assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      path.join(assets, 'build-info.json'),
      JSON.stringify({ version: '9.9.9', build: '20260904.abc1234' }),
    );
    expect(resolveBuildInfo({ moduleDir, env: {} })).toEqual({
      version: '9.9.9',
      build: '20260904.abc1234',
    });
  });

  it('falls back to a BUILD_SHA in the environment when no stamp file was written', () => {
    expect(resolveBuildInfo({ moduleDir, env: { BUILD_SHA: 'deadbee' } }).build).toBe('deadbee');
  });

  it('reports a null build (never a fake one) when nothing stamped the tree', () => {
    expect(resolveBuildInfo({ moduleDir, env: {} }).build).toBeNull();
  });

  it('survives an unreadable/absent package tree instead of throwing', () => {
    const orphan = path.join(root, 'nowhere', 'deep');
    mkdirSync(orphan, { recursive: true });
    // `orphan` is still under `root`, so the walk-up finds the product package.
    expect(resolveBuildInfo({ moduleDir: orphan, env: {} }).version).toBe('9.9.9');
    expect(resolveBuildInfo({ moduleDir: '/definitely/not/here', env: {} }).version).toBe('0.0.0');
  });
});

describe('the module-level version constants', () => {
  it('API_VERSION is the workspace ROOT package version', () => {
    const rootPkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string };
    expect(rootPkg.name).toBe('sparrow');
    expect(API_VERSION).toBe(rootPkg.version);
  });

  it('BUILD_STAMP is a string or null — never undefined', () => {
    expect(BUILD_STAMP === null || typeof BUILD_STAMP === 'string').toBe(true);
  });
});
