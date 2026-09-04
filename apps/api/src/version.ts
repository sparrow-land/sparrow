import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the server reports about itself (`GET /healthz`, `GET /api/v1/meta`).
 *
 * `version` is the PRODUCT version — the root `package.json` (the same one the
 * client bundler stamps into `sparrow --version`), NOT `@sparrow/api`'s own
 * package version, which never moved off `0.1.0` and used to be what we
 * reported. `build` is the bundle stamp `<yyyymmdd>.<sha>` when the image was
 * built with a real `BUILD_SHA`, else `null` — never a fabricated value.
 */
export interface BuildInfo {
  version: string;
  build: string | null;
}

/** Reported when no product `package.json` can be found (an unpacked partial tree). */
const UNKNOWN_VERSION = '0.0.0';

/** The npm `name` of the workspace root package — the product itself. */
const PRODUCT_PACKAGE = 'sparrow';

/** How far up the tree to look for the product package.json. */
const MAX_WALK = 8;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `startDir` looking for the workspace root `package.json` (the one
 * named `sparrow`). Works from `src/` in dev, from `dist/` in the built image
 * (the Dockerfile copies the root package.json into `/app`), and from the
 * install-assets sibling in either.
 */
function productVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK; i += 1) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && pkg.name === PRODUCT_PACKAGE && typeof pkg.version === 'string') {
      return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the version + build stamp this server reports.
 *
 * The build stamp comes from `install-assets/build-info.json`, written by
 * `scripts/bundle-clients.mjs` at bundle time from the SAME source the client
 * bundles are stamped from (`BUILD_SHA` env → git → none). That directory is
 * already copied into the runtime image, so the stamp survives to runtime with
 * no extra Dockerfile plumbing. A `BUILD_SHA` in the runtime environment wins,
 * so an operator can label a hand-rolled build.
 */
export function resolveBuildInfo(
  opts: { moduleDir?: string; env?: NodeJS.ProcessEnv } = {},
): BuildInfo {
  const moduleDir = opts.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const env = opts.env ?? process.env;
  const stamp = readJson(path.join(moduleDir, '..', 'install-assets', 'build-info.json'));

  const version =
    productVersion(moduleDir) ??
    (typeof stamp?.version === 'string' ? stamp.version : undefined) ??
    UNKNOWN_VERSION;

  const envSha = (env.BUILD_SHA ?? '').trim();
  const build = envSha || (typeof stamp?.build === 'string' && stamp.build ? stamp.build : null);

  return { version, build };
}

const info = resolveBuildInfo();

/** Product version reported by `GET /healthz` and `GET /api/v1/meta`. */
export const API_VERSION = info.version;

/** Build stamp (`<yyyymmdd>.<sha>`) of this image, or `null` for an unstamped build. */
export const BUILD_STAMP = info.build;
