/**
 * Unit tests for the `install.sh` template itself (rendered text + real execution).
 *
 * The script installs into a directory the operator may not own, so the two
 * things under test here are (a) that the target is overridable and announced
 * before anything is written, and (b) that the legacy-bundle cleanup only ever
 * removes files that belong to a sparrow install.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderInstallScript } from './routes/onboarding.templates.js';

const script = renderInstallScript('http://localhost:8722');

describe('install.sh — install directory', () => {
  it('honors SPARROW_BIN_DIR and falls back to ~/.local/bin', () => {
    expect(script).toContain('BIN_DIR="${SPARROW_BIN_DIR:-${HOME}/.local/bin}"');
  });

  it('announces the resolved target before writing anything', () => {
    const announce = script.indexOf('sparrow: installing into ${BIN_DIR}');
    expect(announce).toBeGreaterThan(-1);
    // …before the first mkdir/download, not after.
    expect(announce).toBeLessThan(script.indexOf('mkdir -p "${BIN_DIR}"'));
    expect(announce).toBeLessThan(script.indexOf('download "${BASE_URL}/install/sparrow.js"'));
  });

  // #51: the hint hardcoded `$HOME/.local/bin`, so `SPARROW_BIN_DIR=/my/dir`
  // installed into /my/dir and then told the user to PATH-add a directory it
  // had never written to.
  it('points the PATH hint at the ACTUAL BIN_DIR, not a hardcoded ~/.local/bin', () => {
    const hint = script.slice(script.indexOf('# --- PATH hint'));
    expect(hint).toContain('export PATH=\\"${BIN_DIR}:\\$PATH\\"');
    // `$PATH` stays literal in the printed line; only BIN_DIR is expanded.
    expect(hint).not.toContain('$HOME/.local/bin');
  });

  it('documents the override in the header comment', () => {
    expect(script).toContain('SPARROW_BIN_DIR');
    expect(script.slice(0, script.indexOf('set -eu'))).toContain('SPARROW_BIN_DIR');
  });
});

describe('install.sh — stale bundle cleanup is guarded', () => {
  it('only removes sparrow.js/sparrow-mcp.js when a sparrow wrapper sits alongside', () => {
    // The guard: a `sparrow` wrapper in BIN_DIR proves this directory is a
    // sparrow install, so the two legacy filenames are ours to delete.
    expect(script).toContain('-f "${BIN_DIR}/sparrow"');
    const guard = script.indexOf('-f "${BIN_DIR}/sparrow"');
    const rm = script.indexOf('rm -f "${BIN_DIR}/${stale}"');
    expect(guard).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(guard);
  });
});

/**
 * Execute the real script against a local file server so the guards are proven
 * by behaviour, not just by grep. Node is the only hard dependency; the script
 * needs curl or wget, which every CI image and dev box has.
 */
describe('install.sh — execution', () => {
  const haveDownloader = (() => {
    try {
      execFileSync('sh', ['-c', 'command -v curl || command -v wget'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const run = async (
    binDir: string | undefined,
    seed: (dir: string) => void,
  ): Promise<{ out: string; home: string; binDir: string }> => {
    const home = mkdtempSync(path.join(tmpdir(), 'sparrow-install-'));
    const resolved = binDir ?? path.join(home, '.local', 'bin');
    mkdirSync(resolved, { recursive: true });
    seed(resolved);

    // Serve the two bundle paths from a throwaway http server.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/install/sparrow.js' || req.url === '/install/sparrow-mcp.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('#!/usr/bin/env node\nif(process.argv[2]==="--version")console.log("9.9.9");\n');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const body = renderInstallScript(`http://127.0.0.1:${port}`);
    const scriptPath = path.join(home, 'install.sh');
    writeFileSync(scriptPath, body, { mode: 0o755 });
    try {
      // MUST be async: the bundle server above runs on this very event loop, so
      // a blocking execFileSync would deadlock against the script's own curl.
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn('sh', [scriptPath], {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            ...(binDir ? { SPARROW_BIN_DIR: binDir } : {}),
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`install.sh exited ${code}\n${stderr}`)),
        );
      });
      return { out, home, binDir: resolved };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };

  it.skipIf(!haveDownloader)('installs into SPARROW_BIN_DIR and echoes the target', async () => {
    const custom = mkdtempSync(path.join(tmpdir(), 'sparrow-bin-'));
    try {
      const { out, home } = await run(custom, () => {});
      expect(out).toContain(`sparrow: installing into ${custom}`);
      // #51 — the PATH hint names the directory we actually installed into.
      // (`custom` is a temp dir, so it is never already on PATH.)
      expect(out).toContain(`export PATH="${custom}:$PATH"`);
      expect(out).not.toContain('$HOME/.local/bin');
      for (const f of ['sparrow.mjs', 'sparrow-mcp.mjs', 'sparrow', 'sparrow-mcp', 'sparrow-skill']) {
        expect(existsSync(path.join(custom, f))).toBe(true);
      }
      // Nothing written to the default location.
      expect(existsSync(path.join(home, '.local', 'bin', 'sparrow'))).toBe(false);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!haveDownloader)('removes legacy bundles it owns', async () => {
    const custom = mkdtempSync(path.join(tmpdir(), 'sparrow-bin-'));
    try {
      const { out } = await run(custom, (dir) => {
        // A pre-.mjs sparrow install: legacy bundles AND a sparrow wrapper.
        writeFileSync(path.join(dir, 'sparrow.js'), '// legacy bundle\n');
        writeFileSync(path.join(dir, 'sparrow-mcp.js'), '// legacy bundle\n');
        writeFileSync(path.join(dir, 'sparrow'), '#!/bin/sh\n');
      });
      expect(out).toContain('removed stale');
      expect(existsSync(path.join(custom, 'sparrow.js'))).toBe(false);
      expect(existsSync(path.join(custom, 'sparrow-mcp.js'))).toBe(false);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!haveDownloader)(
    'never deletes a same-named file in a directory that is not a sparrow install',
    async () => {
      // Someone else's `sparrow.js` in a shared bin dir, no sparrow wrapper next
      // to it: the installer writes its own files but must not delete theirs.
      const custom = mkdtempSync(path.join(tmpdir(), 'sparrow-bin-'));
      try {
        // No `sparrow`/`sparrow.mjs` alongside it, so this is NOT a sparrow
        // install directory and the cleanup must not fire — even though the
        // installer writes its own `sparrow` wrapper moments later.
        const { out } = await run(custom, (dir) => {
          writeFileSync(path.join(dir, 'sparrow.js'), '// SOMEONE ELSE\n');
        });
        expect(out).not.toContain('removed stale');
        expect(existsSync(path.join(custom, 'sparrow.js'))).toBe(true);
      } finally {
        rmSync(custom, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
