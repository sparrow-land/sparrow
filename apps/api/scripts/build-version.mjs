/**
 * Build-version stamping for the client bundles (see bundle-clients.mjs) AND
 * for the server's own `GET /healthz` / `GET /api/v1/meta` report (the bundler
 * writes `install-assets/build-info.json`, which `src/version.ts` reads).
 *
 * `<pkg-version>+<yyyymmdd>.<sha>` where `<sha>` is resolved in order:
 *   1. `BUILD_SHA` env (trimmed) — how docker builds inject the real commit,
 *      since `.git` is never part of the image build context.
 *   2. `git rev-parse --short HEAD` at `repoRoot`.
 *   3. `"dev"` — tarball/no-git builds still succeed, visibly unversioned.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve the commit sha to stamp: `BUILD_SHA` → git → `"dev"`.
 *
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {string}
 */
export function resolveBuildSha({ repoRoot, env = process.env }) {
  const fromEnv = (env.BUILD_SHA ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    return 'dev'; // not a git checkout (e.g. a tarball build) and no BUILD_SHA
  }
}

/**
 * The full stamp, split into the parts the server reports separately: the
 * product `version` (root package.json), the `build` suffix `<date>.<sha>`, and
 * the joined `buildVersion` the client bundles carry.
 *
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv, now?: Date }} opts
 * @returns {Promise<{ version: string, sha: string, build: string, buildVersion: string }>}
 */
export async function computeBuildInfo({ repoRoot, env = process.env, now = new Date() }) {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const sha = resolveBuildSha({ repoRoot, env });
  const build = `${yyyymmdd}.${sha}`;
  return { version: pkg.version, sha, build, buildVersion: `${pkg.version}+${build}` };
}

/**
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv, now?: Date }} opts
 * @returns {Promise<string>}
 */
export async function computeBuildVersion(opts) {
  return (await computeBuildInfo(opts)).buildVersion;
}
