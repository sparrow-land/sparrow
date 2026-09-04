/**
 * Served-CLI bundle execution smoke — the FIELD BLOCKER guard.
 *
 * The API serves a single-file `sparrow.js` (bundled from `apps/cli/src/bin.ts`).
 * That bundle imports `@sparrow/skill`; when the skill package's `install.ts` held
 * a module-level main-guard, the guard fired for the WHOLE bundle and `runSkill()`
 * hijacked EVERY `sparrow` invocation — `sparrow whoami` died with "Unknown
 * command 'whoami'. Use: install | uninstall | …" and `--version` printed spurious
 * errors. The earlier "smoke" never executed the bundle, so it missed this.
 *
 * This test BUILDS the real bundle (via the same `bundle-clients` path prod uses)
 * and RUNS it in a child `node` process (like the chaos crash-guard test), pinning
 * the exact field failure:
 *   • `sparrow.js --version` exits 0 and prints a version.
 *   • `sparrow.js whoami` never prints "Unknown command" (the skill-hijack tell).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
const bundlePath = path.join(apiRoot, 'install-assets', 'sparrow.js');

/** Run the bundle in a child node; capture stdout+stderr and the exit status. */
function runBundle(
  args: string[],
  env: Record<string, string | undefined>,
): { output: string; status: number } {
  try {
    const output = execFileSync('node', [bundlePath, ...args], {
      env: { ...process.env, ...env },
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return { output, status: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    const output = `${(err.stdout ?? Buffer.from('')).toString()}${(err.stderr ?? Buffer.from('')).toString()}`;
    return { output, status: typeof err.status === 'number' ? err.status : 1 };
  }
}

describe('served sparrow.js bundle executes the CLI (not the skill bin)', () => {
  beforeAll(() => {
    // Build the workspace packages the CLI bundle resolves (their `exports` point
    // at dist/), then bundle exactly as prod does. If the skill main-guard ever
    // returns, the freshly rebuilt bundle reproduces the hijack and this fails.
    for (const pkg of ['packages/common-types', 'packages/client', 'packages/skill']) {
      execFileSync('npm', ['run', 'build'], {
        cwd: path.join(repoRoot, pkg),
        timeout: 120_000,
        stdio: 'ignore',
      });
    }
    execFileSync('node', ['scripts/bundle-clients.mjs'], {
      cwd: apiRoot,
      timeout: 120_000,
      stdio: 'ignore',
    });
    expect(fs.existsSync(bundlePath)).toBe(true);
  }, 240_000);

  it('`sparrow.js --version` exits 0 and prints a version', () => {
    const { output, status } = runBundle(['--version'], {});
    expect(status).toBe(0);
    expect(output).toMatch(/\d+\.\d+\.\d+/);
    expect(output).not.toContain('Unknown command');
  });

  it('`sparrow.js whoami` runs the CLI — never "Unknown command" (the skill-hijack tell)', () => {
    // Isolate config so no developer credentials resolve: `whoami` then fails on
    // missing credentials (exit 1) — a CLI error, decidedly NOT the skill bin's
    // "Unknown command 'whoami'". The tell we guard against is the string itself.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-bundle-cfg-'));
    try {
      const { output } = runBundle(['whoami'], {
        XDG_CONFIG_HOME: configDir,
        SPARROW_SERVER: undefined,
        SPARROW_TOKEN: undefined,
        HOME: configDir,
      });
      expect(output).not.toContain('Unknown command');
      expect(output).not.toContain('install | uninstall');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('`sparrow.js --help` prints CLI usage, not a skill error', () => {
    const { output, status } = runBundle(['--help'], {});
    expect(status).toBe(0);
    expect(output).toContain('sparrow');
    expect(output).not.toContain('Unknown command');
  });
});
