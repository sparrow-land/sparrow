/**
 * `sparrow-skill` bin smoke — the split-out executable entry (`bin.ts`) still
 * drives `runSkill`, AND importing the library (`install.ts`) is inert.
 *
 * These are the two halves of the field blocker: the served single-file CLI
 * bundle imports this package, so `install.ts` must run NOTHING on import; and the
 * standalone `npx sparrow-skill` bin must still work. Both are checked against the
 * REAL built `dist/` in a child `node` process (`beforeAll` builds it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(pkgRoot, 'dist');

describe('sparrow-skill bin (built dist)', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, timeout: 120_000, stdio: 'ignore' });
  }, 120_000);

  function runBin(args: string[], env: Record<string, string | undefined>): { out: string; status: number } {
    try {
      const out = execFileSync('node', [path.join(distDir, 'bin.js'), ...args], {
        env: { ...process.env, ...env },
        timeout: 20_000,
      }).toString();
      return { out, status: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer };
      return { out: (err.stdout ?? Buffer.from('')).toString(), status: err.status ?? 1 };
    }
  }

  it('runs a subcommand: `status` prints the loop-state and exits 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-bin-home-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-bin-state-'));
    try {
      const { out, status } = runBin(['status'], { HOME: home, SPARROW_STATE_DIR: stateDir });
      expect(status).toBe(0);
      expect(out).toMatch(/loop-state:/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown subcommand with a nonzero exit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-bin-home-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-bin-state-'));
    try {
      const { status } = runBin(['frobnicate'], { HOME: home, SPARROW_STATE_DIR: stateDir });
      expect(status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('importing the library (install.js) runs NOTHING — no command executes on import', () => {
    // Regression for the field blocker: the CLI bundle imports this module, so a
    // bare import must not parse argv or run a skill command. A child that only
    // imports it and prints a sentinel must emit exactly that sentinel.
    const harness = `
import ${JSON.stringify(path.join(distDir, 'install.js'))};
process.stdout.write('IMPORT_OK\\n');
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-import-'));
    const harnessPath = path.join(dir, 'h.mjs');
    fs.writeFileSync(harnessPath, harness);
    try {
      // argv[2] would be a subcommand IF the module self-ran; it must be ignored.
      const out = execFileSync('node', [harnessPath, 'uninstall'], { timeout: 20_000 }).toString();
      expect(out.trim()).toBe('IMPORT_OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
