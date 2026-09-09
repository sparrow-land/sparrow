/**
 * `sparrow upgrade` — the SKILL REFRESH half.
 *
 * Upgrading the CLI used to leave the installed skill assets (SKILL.md, the
 * hook scripts, the settings registrations) exactly as the previous release
 * wrote them: a Codex agent went 0.1.17 → 0.1.18 and kept running the 0.1.17
 * playbook until they thought to re-run `sparrow skill install --codex` by
 * hand. So `upgrade` now re-runs the install for every skill installation it
 * can find on this machine — and it does so by EXECUTING THE FRESHLY
 * DOWNLOADED BUNDLE, because the running process still carries the old
 * assets; refreshing in-process would only rewrite the stale files.
 *
 * These tests drive the real `runCli` against a stub install home whose
 * "bundle" is a tiny script that records the argv/cwd/state dir it was invoked
 * with — which is precisely the contract `upgrade` owes the new binary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from './index.js';
import { readSkillInstallMarker, skillInstallMarkerPath } from './skill-refresh.js';

/* ------------------------------ the stub bundle ------------------------------ */

/**
 * What the install home serves as `sparrow.js`. It answers `--version` (the
 * upgrade reports old → new by running the bundle) and otherwise appends one
 * JSON line per invocation to `$SPARROW_TEST_REFRESH_LOG` — how a test sees
 * that the refresh ran THE NEW BINARY, with which flags, in which project, on
 * which state dir. `$SPARROW_TEST_REFRESH_FAIL` makes it fail like a broken
 * install would.
 */
const BUNDLE = [
  "import fs from 'node:fs';",
  'const argv = process.argv.slice(2);',
  "if (argv[0] === '--version') { console.log('9.9.9+new'); process.exit(0); }",
  'const log = process.env.SPARROW_TEST_REFRESH_LOG;',
  'if (log) fs.appendFileSync(log, JSON.stringify({',
  '  argv, cwd: fs.realpathSync(process.cwd()), stateDir: process.env.SPARROW_STATE_DIR ?? null,',
  "}) + '\\n');",
  'if (process.env.SPARROW_TEST_REFRESH_FAIL) {',
  "  process.stderr.write('skill install exploded\\n');",
  '  process.exit(3);',
  '}',
  // A REFUSED install: the reason is printed on stdout (that is where the
  // installer's own log goes) and the exit code is non-zero.
  'if (process.env.SPARROW_TEST_REFRESH_REFUSE) {',
  "  process.stdout.write('Refusing to install: hooks are already registered in .claude/settings.json\\n');",
  '  process.exit(1);',
  '}',
  '',
].join('\n');

let installUrl: string;
let stub: http.Server;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/install/')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(BUNDLE);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  installUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(() => stub.close());

/* --------------------------------- harness ---------------------------------- */

interface Capture {
  io: CliIO;
  out(): string;
  err(): string;
}
function capture(): Capture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

const tempDir = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

describe('sparrow upgrade — skill refresh', () => {
  let projectDir: string;
  let home: string;
  let configDir: string;
  let refreshLog: string;
  let previousCwd: string;

  beforeEach(() => {
    projectDir = tempDir('sparrow-upgrade-project-');
    home = tempDir('sparrow-upgrade-home-');
    configDir = tempDir('sparrow-upgrade-cfg-');
    refreshLog = path.join(home, 'refresh.log');
    // An install.sh layout: `upgrade` refuses to run without one.
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'sparrow.mjs'), 'console.log("0.0.1+old");\n');
    previousCwd = process.cwd();
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const d of [projectDir, home, configDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  /** No SPARROW_STATE_DIR: discovery must find the project (and HOME) on its own. */
  const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    HOME: home,
    XDG_CONFIG_HOME: configDir,
    PATH: process.env.PATH,
    SPARROW_INSTALL_URL: installUrl,
    SPARROW_TEST_REFRESH_LOG: refreshLog,
    ...extra,
  });

  /** Every invocation the freshly downloaded bundle recorded. */
  const refreshes = (): Array<{ argv: string[]; cwd: string; stateDir: string | null }> => {
    let raw = '';
    try {
      raw = fs.readFileSync(refreshLog, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  };

  /* ------------------------------ the marker ------------------------------ */

  it('skill install records provider, scope and version next to the loop-state', async () => {
    expect(await runCli(['skill', 'install', '--codex', '--profile', 'ws-b'], env(), capture().io)).toBe(0);

    const marker = readSkillInstallMarker(path.join(projectDir, '.sparrow'));
    expect(marker).toBeDefined();
    expect(marker!.provider).toBe('codex');
    expect(marker!.scope).toBe('project');
    expect(marker!.dir).toBe(projectDir);
    expect(marker!.profile).toBe('ws-b');
    expect(marker!.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(marker!.installedAt))).toBe(false);
    // It lives with the loop switch, not in the harness's own config.
    expect(skillInstallMarkerPath(path.join(projectDir, '.sparrow'))).toBe(
      path.join(projectDir, '.sparrow', 'skill-install.json'),
    );
  });

  it('a user-scope install records itself in ~/.sparrow, not in the project', async () => {
    expect(await runCli(['skill', 'install', '--user', '--claude'], env(), capture().io)).toBe(0);
    const marker = readSkillInstallMarker(path.join(home, '.sparrow'));
    expect(marker?.scope).toBe('user');
    expect(marker?.provider).toBe('claude');
    expect(marker?.dir).toBe(home);
    expect(fs.existsSync(path.join(projectDir, '.sparrow', 'skill-install.json'))).toBe(false);
  });

  /**
   * A removed skill must STAY removed: if `uninstall` left the marker behind,
   * the next `upgrade` would cheerfully re-install what the user just deleted.
   */
  it('skill uninstall forgets the marker, so a later upgrade resurrects nothing', async () => {
    expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
    expect(fs.existsSync(path.join(projectDir, '.sparrow', 'skill-install.json'))).toBe(true);

    expect(await runCli(['skill', 'uninstall', '--codex'], env(), capture().io)).toBe(0);
    expect(fs.existsSync(path.join(projectDir, '.sparrow', 'skill-install.json'))).toBe(false);

    fs.rmSync(refreshLog, { force: true });
    const cap = capture();
    expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
    expect(refreshes()).toHaveLength(0);
    expect(cap.out()).toContain('sparrow skill install');
  });

  /* ------------------------------ the refresh ------------------------------ */

  it('upgrade re-runs the recorded install with the NEW bundle, same provider and scope', async () => {
    expect(await runCli(['skill', 'install', '--codex', '--profile', 'ws-b'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);

    const runs = refreshes();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv).toEqual(['skill', 'install', '--codex', '--profile', 'ws-b']);
    expect(runs[0]!.cwd).toBe(projectDir);
    expect(runs[0]!.stateDir).toBe(path.join(projectDir, '.sparrow'));
    // One line per refreshed install, naming provider, scope and where.
    expect(cap.out()).toContain(`skill: refreshed codex install (project scope, ${projectDir})`);
    expect(cap.out()).toContain('Upgraded sparrow');
  });

  it('upgrade refreshes BOTH a project install and a user install, one line each', async () => {
    expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
    expect(await runCli(['skill', 'install', '--user', '--claude'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);

    const runs = refreshes();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.argv.includes('--user'))).toEqual([false, true]);
    expect(runs[0]!.stateDir).toBe(path.join(projectDir, '.sparrow'));
    expect(runs[1]!.stateDir).toBe(path.join(home, '.sparrow'));
    expect(cap.out()).toContain(`skill: refreshed claude install (project scope, ${projectDir})`);
    expect(cap.out()).toContain(`skill: refreshed claude install (user scope, ${home})`);
  });

  it('--shared is replayed, so a refresh never moves hooks to the personal settings file', async () => {
    expect(await runCli(['skill', 'install', '--claude', '--shared'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });
    expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
    expect(refreshes()[0]!.argv).toEqual(['skill', 'install', '--claude', '--shared']);
  });

  it('upgrade with no recorded install refreshes nothing and says how to fix that', async () => {
    const cap = capture();
    expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
    expect(refreshes()).toHaveLength(0);
    expect(cap.out()).toContain('Upgraded sparrow');
    expect(cap.out()).toContain('sparrow skill install');
    expect(cap.out()).not.toContain('refreshed');
  });

  it('--no-skill-refresh opts out entirely', async () => {
    expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade', '--no-skill-refresh'], env(), cap.io)).toBe(0);
    expect(refreshes()).toHaveLength(0);
    expect(cap.out()).toContain('Upgraded sparrow');
    expect(cap.out()).not.toContain('skill:');
  });

  /**
   * The upgrade is the thing the user asked for; the refresh is a courtesy. A
   * broken skill install must be LOUD and must not turn a good upgrade into a
   * failed command.
   */
  /**
   * A refused install says WHY on stdout and exits non-zero. If the refresh
   * reported only "Command failed", the operator would be told their skill did
   * not refresh without being told the one thing that fixes it.
   */
  it('surfaces a refusal message the child printed on stdout', async () => {
    expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade'], env({ SPARROW_TEST_REFRESH_REFUSE: '1' }), cap.io)).toBe(0);
    expect(cap.err()).toContain('skill: refresh failed');
    expect(cap.err()).toContain('hooks are already registered in .claude/settings.json');
  });

  it('a skill refresh failure prints the error but leaves the upgrade exit code at 0', async () => {
    expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade'], env({ SPARROW_TEST_REFRESH_FAIL: '1' }), cap.io)).toBe(0);
    expect(cap.out()).toContain('Upgraded sparrow');
    expect(cap.err()).toContain('skill: refresh failed');
    expect(cap.err()).toContain('codex');
    expect(cap.err()).toContain('exploded');
  });

  it('-j reports the refresh in the JSON payload instead of prose', async () => {
    expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
    fs.rmSync(refreshLog, { force: true });

    const cap = capture();
    expect(await runCli(['upgrade', '-j'], env(), cap.io)).toBe(0);
    const payload = JSON.parse(cap.out());
    expect(payload.new).toBe('9.9.9+new');
    expect(payload.skillRefresh).toEqual([
      { provider: 'codex', scope: 'project', dir: projectDir, ok: true },
    ]);
  });

  /**
   * The refresh only helps if re-installing is safe. The installer merges into
   * the harness's settings file, and a user's own keys there must survive every
   * repeat install — otherwise `upgrade` would quietly eat them.
   */
  it('a repeat skill install preserves unrelated settings keys the user added', async () => {
    expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
    const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
    const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    before.env = { ...(before.env ?? {}), MY_OWN_KEY: 'keep me' };
    before.permissions = { allow: ['Bash(ls:*)'] };
    fs.writeFileSync(settingsFile, JSON.stringify(before, null, 2));

    expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);

    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(after.env.MY_OWN_KEY).toBe('keep me');
    expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    // …and the hooks are still registered exactly once.
    expect(JSON.stringify(after.hooks)).toContain('sparrow-stop-check.sh');
    expect(after.hooks.Stop).toHaveLength(1);
  });
});
