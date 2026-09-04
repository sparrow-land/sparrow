/**
 * Node-only utilities (subpath export `@sparrow/common-types/identity`).
 *
 * Kept out of the main entry so browsers can import the schemas without pulling
 * in `node:os` / `node:crypto`.
 */
import os from 'node:os';
import { createHash } from 'node:crypto';
import { AGENT_NAME_MAX } from './constants.js';

/** Short hostname: everything before the first dot, lowercased. */
export function shortHostname(hostname: string): string {
  return (hostname.split('.')[0] ?? hostname).toLowerCase();
}

/**
 * Format the folder portion of a default agent name from an absolute `cwd`:
 * - `cwd === home` -> `~`
 * - `cwd` under `home` -> the `home/`-stripped relative path
 * - otherwise -> the absolute path unchanged
 */
export function formatFolder(cwd: string, home: string): string {
  if (cwd === home) return '~';
  const prefix = home.endsWith('/') ? home : `${home}/`;
  if (cwd.startsWith(prefix)) return cwd.slice(prefix.length);
  return cwd;
}

/**
 * Slugify an arbitrary string into something valid against the v4 agent-name
 * rule (SPEC "Default agent name"): lowercased, every character outside
 * `[a-z0-9._-]` replaced with `-`, runs of `-` collapsed, and leading/trailing
 * `.`/`-` trimmed.
 *
 * Two closures the spec's prose leaves implicit but its "valid by construction"
 * claim requires: runs of `.` collapse to one (the name rule forbids `..`), and
 * the result is truncated to {@link AGENT_NAME_MAX} (then re-trimmed) so a deep
 * cwd cannot propose an over-long name. An input that slugifies to nothing
 * yields `agent`.
 */
export function slugifyAgentName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, AGENT_NAME_MAX)
    .replace(/[.-]+$/, '');
  return slug === '' ? 'agent' : slug;
}

/**
 * Derive the default agent name the CLI/MCP propose when enrolling without
 * `--name` (SPEC "Default agent name"): a slugified `{host}-{folder}`, where
 * `folder` is the cwd with the `$HOME/` prefix stripped (and `home` for `$HOME`
 * itself). `demo1` in `~/projects/foo` proposes `demo1-projects-foo`.
 *
 * v3's `{host}:{folder}` form is gone — colons and slashes are not email-safe,
 * and in v4 the name IS the local part of the agent's address. `cwd` / `home`
 * default to the current process values; pass them (or use the pure
 * `shortHostname` / `formatFolder` / `slugifyAgentName` helpers) for
 * deterministic tests.
 */
export function deriveDefaultAgentName(
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string {
  const folder = formatFolder(cwd, home);
  return slugifyAgentName(`${shortHostname(os.hostname())}-${folder === '~' ? 'home' : folder}`);
}

/** SHA-256 of `s` as a lowercase hex string. Used to hash secrets server-side. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
