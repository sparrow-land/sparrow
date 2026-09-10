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

/**
 * What the install home serves as `/install/agent-notes.json` for the current
 * test — `undefined` means the file is not published at all (a 404, which is
 * the normal state of an install home that has not shipped a digest yet).
 * Deliberately a raw string so a test can serve malformed JSON.
 */
let agentNotesBody: string | undefined;
/** Every request the digest endpoint saw this test (cache-busting query included). */
let agentNotesHits: string[] = [];
/**
 * Sentinel for `agentNotesBody`: the server ACCEPTS the request and then never
 * answers — the stalled-install-home case the digest fetch must not inherit as
 * an indefinite hang. Held responses are destroyed in afterEach so a hung
 * socket never outlives its test.
 */
const HANG = '@@HANG@@';
const hungResponses: http.ServerResponse[] = [];

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/install/agent-notes.json')) {
      agentNotesHits.push(url);
      if (agentNotesBody === HANG) {
        hungResponses.push(res); // accept, say nothing, hold the socket open
        return;
      }
      if (agentNotesBody === undefined) {
        res.writeHead(404);
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(agentNotesBody);
      return;
    }
    if (url.startsWith('/install/')) {
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
afterAll(() => {
  for (const res of hungResponses.splice(0)) res.destroy();
  stub.close();
});

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
    agentNotesBody = undefined;
    agentNotesHits = [];
    for (const res of hungResponses.splice(0)) res.destroy();
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

  /**
   * An uninstall only forgets the install it actually removed.
   *
   * `--shared` and personal installs share a skill dir but not a settings file,
   * so a plain `sparrow skill uninstall` leaves a `--shared` registration (and
   * its assets) standing — and the record of it must stand too. Dropping the
   * marker anyway would quietly stop `sparrow upgrade` refreshing a skill that
   * is still installed and still firing.
   */
  it('a plain uninstall keeps the record of a --shared install, which upgrade still refreshes', async () => {
    expect(await runCli(['skill', 'install', '--claude', '--shared'], env(), capture().io)).toBe(0);
    expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.shared).toBe(true);

    expect(await runCli(['skill', 'uninstall', '--claude'], env(), capture().io)).toBe(0);

    expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.shared).toBe(true);
    fs.rmSync(refreshLog, { force: true });
    expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
    expect(refreshes()[0]!.argv).toEqual(['skill', 'install', '--claude', '--shared']);
  });

  it('the MATCHING uninstall does forget it', async () => {
    expect(await runCli(['skill', 'install', '--claude', '--shared'], env(), capture().io)).toBe(0);
    expect(await runCli(['skill', 'uninstall', '--claude', '--shared'], env(), capture().io)).toBe(0);

    expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))).toBeUndefined();
    fs.rmSync(refreshLog, { force: true });
    expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
    expect(refreshes()).toHaveLength(0);
  });

  it('a --shared uninstall keeps the record of a PERSONAL install', async () => {
    expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
    expect(await runCli(['skill', 'uninstall', '--claude', '--shared'], env(), capture().io)).toBe(0);
    expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.provider).toBe('claude');
  });

  it('an uninstall for the OTHER harness never forgets this one', async () => {
    expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
    expect(await runCli(['skill', 'uninstall', '--codex'], env(), capture().io)).toBe(0);
    expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.provider).toBe('claude');
  });

  /**
   * DETECTION MUST HAPPEN WHILE THE EVIDENCE IS STILL THERE.
   *
   * In a repo carrying BOTH harness fingerprints (a `CLAUDE.md` and an
   * `AGENTS.md` — plenty of repos do) the tie is broken by the installed skill
   * dir. An uninstall deletes that dir, so re-detecting the provider afterwards
   * gets "ambiguous, refusing to guess", the marker survives its install, and
   * the next `sparrow upgrade` cheerfully resurrects what was just removed.
   */
  describe('a project that looks like BOTH harnesses', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# claude\n');
      fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# agents\n');
    });

    it('an unflagged uninstall still forgets the install it removed', async () => {
      expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
      expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.provider).toBe('claude');

      // No provider flag: the uninstall resolves it from the installed skill
      // dir, and so must the bookkeeping that follows.
      expect(await runCli(['skill', 'uninstall'], env(), capture().io)).toBe(0);

      expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))).toBeUndefined();
      fs.rmSync(refreshLog, { force: true });
      expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
      expect(refreshes()).toHaveLength(0);
    });

    it('the same holds for a Codex install', async () => {
      expect(await runCli(['skill', 'install', '--codex'], env(), capture().io)).toBe(0);
      expect(await runCli(['skill', 'uninstall'], env(), capture().io)).toBe(0);
      expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))).toBeUndefined();
    });

    it('an uninstall for the OTHER harness still keeps this install\'s marker', async () => {
      expect(await runCli(['skill', 'install', '--claude'], env(), capture().io)).toBe(0);
      expect(await runCli(['skill', 'uninstall', '--codex'], env(), capture().io)).toBe(0);

      expect(readSkillInstallMarker(path.join(projectDir, '.sparrow'))?.provider).toBe('claude');
      fs.rmSync(refreshLog, { force: true });
      expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
      expect(refreshes()[0]!.argv).toEqual(['skill', 'install', '--claude']);
    });
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

  /* --------------------------- the agent digest --------------------------- */

  /**
   * The agent that RUNS the upgrade is the one whose behaviour has to change,
   * and it only gets one turn's attention on the subject. So `upgrade` fetches
   * the install home's release digest and prints, in that same turn, the short
   * "do this differently now" line for every release it just crossed.
   *
   * The stub bundle answers `--version` with `9.9.9+new`; the pre-existing
   * bundle the harness writes reports `0.0.1+old`. So the crossed window is
   * (0.0.1, 9.9.9].
   */
  describe('what changed for agents', () => {
    /** The whole published file, as the install home would serve it. */
    const publish = (notes: Record<string, unknown>): void => {
      agentNotesBody = JSON.stringify({ notes });
    };

    it('prints only the releases this upgrade crossed, ascending', async () => {
      publish({
        '9.9.9': 'the newest thing',
        '0.0.1': 'already had this one',
        '1.2.3': 'the middle thing',
        '0.0.2': 'the first new thing',
        '10.0.0': 'not shipped to you yet',
      });

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);

      const out = cap.out();
      expect(out).toContain('What changed for agents:');
      expect(out).toContain('  0.0.2 — the first new thing');
      expect(out).toContain('  1.2.3 — the middle thing');
      expect(out).toContain('  9.9.9 — the newest thing');
      // The boundary: the version you were ALREADY on is not news…
      expect(out).not.toContain('already had this one');
      // …and neither is one the install home has not shipped you.
      expect(out).not.toContain('not shipped to you yet');
      // Ascending, and below the upgrade line the user actually asked for.
      const lines = out.split('\n');
      expect(lines.indexOf('  0.0.2 — the first new thing')).toBeLessThan(
        lines.indexOf('  1.2.3 — the middle thing'),
      );
      expect(lines.indexOf('  1.2.3 — the middle thing')).toBeLessThan(
        lines.indexOf('  9.9.9 — the newest thing'),
      );
      expect(lines.findIndex((l) => l.startsWith('Upgraded sparrow'))).toBeLessThan(
        lines.indexOf('What changed for agents:'),
      );
    });

    /** Build metadata is invisible to the window: `0.0.1+old` IS `0.0.1`. */
    it('compares on the semver core, so a build-stamped old version still excludes its own entry', async () => {
      publish({ '0.0.1': 'you are on this already', '9.9.9': 'you are moving to this' });

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).toContain('  9.9.9 — you are moving to this');
      expect(cap.out()).not.toContain('you are on this already');
    });

    /**
     * An install home that has not published the file yet is the COMMON case,
     * not an error: the upgrade the user asked for succeeded either way.
     */
    it('a missing digest file leaves the upgrade output untouched', async () => {
      agentNotesBody = undefined; // 404

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).toContain('Upgraded sparrow: 0.0.1+old → 9.9.9+new');
      expect(cap.out()).not.toContain('What changed for agents');
      expect(cap.err()).toBe('');
    });

    /**
     * The nastier unavailability: the install home ACCEPTS the request and then
     * says nothing (a wedged edge, a half-dead origin). "Best-effort" must mean
     * bounded — the digest fetch carries its own timeout, so the upgrade the
     * user asked for still completes promptly instead of hanging on a nicety.
     */
    it(
      'a digest endpoint that never answers cannot hang the upgrade',
      { timeout: 15_000 },
      async () => {
        agentNotesBody = HANG;

        const started = Date.now();
        const cap = capture();
        expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
        // Well past the digest's own 3s bound would mean we waited on the
        // socket, not the abort. (Generous ceiling: CI boxes are slow.)
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(cap.out()).toContain('Upgraded sparrow: 0.0.1+old → 9.9.9+new');
        expect(cap.out()).not.toContain('What changed for agents');
        expect(cap.err()).toBe('');
      },
    );

    it('malformed JSON is skipped silently', async () => {
      agentNotesBody = '{"notes": {';

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).toContain('Upgraded sparrow');
      expect(cap.out()).not.toContain('What changed for agents');
      expect(cap.err()).toBe('');
    });

    /**
     * One bad entry must not cost the agent the rest of the digest: a
     * non-string value is dropped, its siblings still print.
     */
    it('a wrong-shaped entry is dropped without poisoning its siblings', async () => {
      publish({ '1.2.3': 42, '9.9.9': 'still worth saying' });

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).toContain('  9.9.9 — still worth saying');
      expect(cap.out()).not.toContain('1.2.3');
    });

    it('a wrong-shaped file (notes is not an object) is skipped entirely', async () => {
      agentNotesBody = JSON.stringify({ notes: ['0.0.2', 'nope'] });

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).not.toContain('What changed for agents');
      expect(cap.err()).toBe('');
    });

    /**
     * When the old bundle cannot report its own version there is no window to
     * bound, so the only honest digest is the release being installed.
     */
    it('an unreadable old version narrows the digest to the new release alone', async () => {
      fs.writeFileSync(path.join(home, '.local', 'bin', 'sparrow.mjs'), 'process.exit(3);\n');
      publish({ '0.0.2': 'not provably news', '9.9.9': 'this is where you are' });

      const cap = capture();
      expect(await runCli(['upgrade'], env(), cap.io)).toBe(0);
      expect(cap.out()).toContain('  9.9.9 — this is where you are');
      expect(cap.out()).not.toContain('not provably news');
    });

    it('-j carries the matched entries as agentNotes', async () => {
      publish({ '9.9.9': 'the newest thing', '0.0.1': 'old news', '1.2.3': 'the middle thing' });

      const cap = capture();
      expect(await runCli(['upgrade', '-j'], env(), cap.io)).toBe(0);
      const payload = JSON.parse(cap.out());
      expect(payload.agentNotes).toEqual([
        { version: '1.2.3', note: 'the middle thing' },
        { version: '9.9.9', note: 'the newest thing' },
      ]);
    });

    it('-j carries an empty agentNotes when there is no digest to report', async () => {
      agentNotesBody = undefined; // 404

      const cap = capture();
      expect(await runCli(['upgrade', '-j'], env(), cap.io)).toBe(0);
      expect(JSON.parse(cap.out()).agentNotes).toEqual([]);
    });

    /**
     * The digest is cache-busted for the same reason the bundles are: an edge
     * cache holding yesterday's file would tell the agent nothing changed.
     */
    it('the digest URL is cache-busted like the bundles', async () => {
      publish({ '9.9.9': 'fresh' });

      expect(await runCli(['upgrade'], env(), capture().io)).toBe(0);
      expect(agentNotesHits).toHaveLength(1);
      expect(agentNotesHits[0]).toMatch(/^\/install\/agent-notes\.json\?v=\d+$/);
    });
  });
});
