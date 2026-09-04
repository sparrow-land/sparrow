import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkill } from './install.js';
import {
  readLoopState,
  writeLoopState,
  touchHeartbeat,
  heartbeatAgeSeconds,
  readHeartbeatKind,
  __resetHeartbeatThrottle,
  HEARTBEAT_THROTTLE_MS,
} from './state.js';

let cwd: string;
let home: string;
let stateDir: string;
let logs: string[];

function env(): Record<string, string | undefined> {
  return { HOME: home, SPARROW_STATE_DIR: stateDir };
}

function run(argv: string[], overrides: Partial<{ env: Record<string, string | undefined>; cwd: string }> = {}): Promise<number> {
  return runSkill(argv, {
    cwd: overrides.cwd ?? cwd,
    home,
    env: overrides.env ?? env(),
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-cwd-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-home-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-state-'));
  fs.rmSync(stateDir, { recursive: true, force: true }); // start absent
  logs = [];
  __resetHeartbeatThrottle();
});

afterEach(() => {
  for (const d of [cwd, home, stateDir]) fs.rmSync(d, { recursive: true, force: true });
});

const skillFile = (p: string) => path.join(p, '.claude', 'skills', 'sparrow', 'SKILL.md');
const stopHook = (p: string) =>
  path.join(p, '.claude', 'skills', 'sparrow', 'hooks', 'sparrow-stop-check.sh');

/** A project install writes `.claude/settings.local.json` unless `--shared`. */
const settingsFile = (p: string, file = 'settings.local.json') => path.join(p, '.claude', file);
const readSettings = (p: string, file = 'settings.local.json') =>
  JSON.parse(fs.readFileSync(settingsFile(p, file), 'utf8'));
const seedSettings = (p: string, settings: unknown, file = 'settings.json'): void => {
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  fs.writeFileSync(settingsFile(p, file), JSON.stringify(settings));
};

interface Group {
  matcher?: string;
  hooks: { command: string }[];
}
const commandsFor = (s: { hooks?: Record<string, Group[]> }, event: string): string[] =>
  (s.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

describe('install (project scope)', () => {
  it('copies assets, merges both hooks, and seeds loop-state=engaged', async () => {
    expect(await run(['install'])).toBe(0);

    expect(fs.existsSync(skillFile(cwd))).toBe(true);
    expect(fs.existsSync(stopHook(cwd))).toBe(true);
    // hook scripts are executable
    expect(fs.statSync(stopHook(cwd)).mode & 0o111).toBeTruthy();
    // SKILL.md carries the frontmatter name
    expect(fs.readFileSync(skillFile(cwd), 'utf8')).toContain('name: sparrow');

    const s = readSettings(cwd);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('sparrow-stop-check.sh');
    expect(s.hooks.Stop[0].hooks[0].command).toContain('$CLAUDE_PROJECT_DIR');
    // UserPromptSubmit now runs auto-status in `prompt` mode (presence folded in).
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/sparrow-auto-status\.sh prompt$/);
    // PostToolUse: throttled presence refresh, matcher '*'.
    expect(s.hooks.PostToolUse[0].matcher).toBe('*');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toMatch(/sparrow-auto-status\.sh post-tool$/);
    // Notification: blocked-input status, scoped by matcher to the notification
    // types that actually mean "a human is being asked something" plus the idle
    // prompt (which sets idle). A matcher of '' would fire for every type.
    expect(s.hooks.Notification[0].hooks[0].command).toMatch(/sparrow-auto-status\.sh notification$/);
    expect(s.hooks.Notification[0].matcher).toBe(
      'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|idle_prompt',
    );
    // Stop stays a SINGLE stop-check entry (it invokes auto-status idle itself).
    expect(commandsFor(s, 'Stop').some((c) => c.includes('sparrow-auto-status.sh'))).toBe(false);

    expect(readLoopState(stateDir)).toBe('engaged');
  });

  it('is idempotent — re-running does not duplicate hook entries', async () => {
    await run(['install']);
    await run(['install']);
    const s = readSettings(cwd);
    expect(commandsFor(s, 'Stop').filter((c) => c.includes('sparrow-stop-check.sh'))).toHaveLength(1);
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Notification']) {
      expect(commandsFor(s, event).filter((c) => c.includes('sparrow-auto-status.sh'))).toHaveLength(1);
    }
  });

  it('preserves unrelated settings and unrelated hooks on install', async () => {
    seedSettings(
      cwd,
      {
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other-stop' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        },
      },
      'settings.local.json',
    );

    await run(['install']);
    const s = readSettings(cwd);

    // Unrelated top-level keys untouched.
    expect(s.model).toBe('opus');
    expect(s.permissions.allow).toEqual(['Bash(ls:*)']);
    // Unrelated PreToolUse hook untouched.
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('echo pre');
    // Pre-existing unrelated Stop hook preserved alongside ours.
    expect(commandsFor(s, 'Stop')).toContain('echo other-stop');
    expect(commandsFor(s, 'Stop').some((c) => c.includes('sparrow-stop-check.sh'))).toBe(true);
  });

  it('does not clobber an existing loop-state on re-install', async () => {
    writeLoopState(stateDir, 'paused');
    await run(['install']);
    expect(readLoopState(stateDir)).toBe('paused');
  });
});

/**
 * WHERE a project install registers, and WHAT it stamps.
 *
 * Three agents can share a machine, a unix user and even a checkout. The
 * registration therefore goes to the PERSONAL `.claude/settings.local.json` by
 * default (never the committed file), and every command it writes carries this
 * project's state dir and this agent's profile — so a hook can neither read
 * another checkout's loop switch nor speak as another agent.
 */
describe('install (project scope) — settings.local.json + stamped commands', () => {
  it('writes .claude/settings.local.json by default and says so', async () => {
    await run(['install']);
    expect(fs.existsSync(settingsFile(cwd, 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(settingsFile(cwd, 'settings.json'))).toBe(false);
    expect(logs.join('\n')).toContain(settingsFile(cwd, 'settings.local.json'));
  });

  it('--shared writes the committed .claude/settings.json instead', async () => {
    await run(['install', '--shared']);
    expect(fs.existsSync(settingsFile(cwd, 'settings.json'))).toBe(true);
    expect(fs.existsSync(settingsFile(cwd, 'settings.local.json'))).toBe(false);
    const s = readSettings(cwd, 'settings.json');
    expect(commandsFor(s, 'Stop')[0]).toContain('sparrow-stop-check.sh');
    expect(logs.join('\n')).toContain(settingsFile(cwd, 'settings.json'));
  });

  it('stamps SPARROW_STATE_DIR and the install profile into every hook command', async () => {
    await run(['install', '--profile', 'acme-workspace']);
    const s = readSettings(cwd);
    const all = [
      ...commandsFor(s, 'Stop'),
      ...commandsFor(s, 'UserPromptSubmit'),
      ...commandsFor(s, 'PostToolUse'),
      ...commandsFor(s, 'Notification'),
    ];
    expect(all).toHaveLength(4);
    for (const c of all) {
      expect(c).toMatch(
        /^SPARROW_STATE_DIR="\$CLAUDE_PROJECT_DIR\/\.sparrow" SPARROW_PROFILE="acme-workspace" \$CLAUDE_PROJECT_DIR\/\.claude\/skills\/sparrow\/hooks\/sparrow-[a-z-]+\.sh/,
      );
    }
    expect(commandsFor(s, 'UserPromptSubmit')[0]).toMatch(/sparrow-auto-status\.sh prompt$/);
  });

  it('falls back to $SPARROW_PROFILE, then to the store default, for the stamp', async () => {
    await run(['install'], { env: { ...env(), SPARROW_PROFILE: 'from-env' } });
    expect(readSettings(cwd).hooks.Stop[0].hooks[0].command).toContain('SPARROW_PROFILE="from-env"');

    // …and with nothing in the env, credentials.json's defaultProfile.
    const xdg = path.join(home, 'cfg');
    fs.mkdirSync(path.join(xdg, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { fallback: {} }, defaultProfile: 'fallback' }),
    );
    await run(['install'], { env: { ...env(), XDG_CONFIG_HOME: xdg } });
    expect(readSettings(cwd).hooks.Stop[0].hooks[0].command).toContain('SPARROW_PROFILE="fallback"');
  });

  // Issue #52: the installer reads the credential store to learn `defaultProfile`,
  // so it must resolve the store's directory the same way the CLI and MCP server
  // do — SPARROW_CONFIG_DIR > $XDG_CONFIG_HOME/sparrow > ~/.config/sparrow —
  // or a sandboxed install stamps the OPERATOR's default profile into its hooks.
  it('honors SPARROW_CONFIG_DIR over XDG_CONFIG_HOME when reading defaultProfile', async () => {
    const xdg = path.join(home, 'xdg-cfg');
    fs.mkdirSync(path.join(xdg, 'sparrow'), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, 'sparrow', 'credentials.json'),
      JSON.stringify({ profiles: { operator: {} }, defaultProfile: 'operator' }),
    );
    const scoped = path.join(home, 'sandbox-cfg');
    fs.mkdirSync(scoped, { recursive: true });
    fs.writeFileSync(
      path.join(scoped, 'credentials.json'),
      JSON.stringify({ profiles: { sandbox: {} }, defaultProfile: 'sandbox' }),
    );
    await run(['install'], {
      env: { ...env(), XDG_CONFIG_HOME: xdg, SPARROW_CONFIG_DIR: scoped },
    });
    const cmd = readSettings(cwd).hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('SPARROW_PROFILE="sandbox"');
    expect(cmd).not.toContain('operator');
  });

  it('omits the SPARROW_PROFILE prefix entirely when no profile can be determined', async () => {
    await run(['install']);
    const cmd = readSettings(cwd).hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain('SPARROW_PROFILE');
    expect(cmd).toContain('SPARROW_STATE_DIR="$CLAUDE_PROJECT_DIR/.sparrow"');
  });

  it('creates <project>/.sparrow with loop-state=engaged (no SPARROW_STATE_DIR set)', async () => {
    expect(await run(['install'], { env: { HOME: home } })).toBe(0);
    const projectState = path.join(cwd, '.sparrow');
    expect(fs.existsSync(projectState)).toBe(true);
    expect(readLoopState(projectState)).toBe('engaged');
    // The user-scope switch is left alone entirely.
    expect(fs.existsSync(path.join(home, '.sparrow'))).toBe(false);
  });

  it('pause/resume/status find the project state dir from a nested cwd', async () => {
    await run(['install'], { env: { HOME: home } });
    const nested = path.join(cwd, 'packages', 'thing');
    fs.mkdirSync(nested, { recursive: true });
    await run(['pause'], { env: { HOME: home }, cwd: nested });
    expect(readLoopState(path.join(cwd, '.sparrow'))).toBe('paused');
    logs.length = 0;
    await run(['status'], { env: { HOME: home }, cwd: nested });
    expect(logs.join('\n')).toContain(path.join(cwd, '.sparrow'));
  });
});

/**
 * The pruner looks in BOTH settings files on every install. Otherwise an upgrade
 * that switches the default target leaves the old registration in place and the
 * hooks fire twice — once with the old (unstamped) command.
 */
describe('install — migration between settings.json and settings.local.json', () => {
  it('removes an older settings.json registration when installing to settings.local.json', async () => {
    seedSettings(cwd, {
      model: 'opus',
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/sparrow-stop-check.sh' },
              { type: 'command', command: 'echo someone-elses-stop' },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: '$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/sparrow-auto-status.sh prompt',
              },
            ],
          },
        ],
      },
    });

    await run(['install']);

    const shared = readSettings(cwd, 'settings.json');
    expect(JSON.stringify(shared)).not.toContain('sparrow-stop-check.sh');
    expect(JSON.stringify(shared)).not.toContain('sparrow-auto-status.sh');
    // Only OUR entries go; everything else survives.
    expect(shared.model).toBe('opus');
    expect(commandsFor(shared, 'Stop')).toEqual(['echo someone-elses-stop']);
    expect(shared.hooks.UserPromptSubmit).toBeUndefined();

    // Exactly one registration, in the file this install targeted.
    const local = readSettings(cwd, 'settings.local.json');
    expect(commandsFor(local, 'Stop').filter((c) => c.includes('sparrow-stop-check.sh'))).toHaveLength(1);
  });

  it('removes a settings.local.json registration when installing --shared', async () => {
    await run(['install']);
    await run(['install', '--shared']);
    const local = readSettings(cwd, 'settings.local.json');
    expect(JSON.stringify(local)).not.toContain('sparrow-');
    const shared = readSettings(cwd, 'settings.json');
    expect(commandsFor(shared, 'Stop').filter((c) => c.includes('sparrow-stop-check.sh'))).toHaveLength(1);
  });

  it('does not create the other settings file when there is nothing to prune', async () => {
    await run(['install']);
    expect(fs.existsSync(settingsFile(cwd, 'settings.json'))).toBe(false);
  });
});

/**
 * `.sparrow/` is per-agent runtime state and a project-scope skill install is
 * personal, so both are excluded from THIS clone (`.git/info/exclude` — local,
 * untracked, invisible to everyone else). `--shared` means the skill dir is
 * deliberately committed, so only the state dir is excluded.
 */
describe('install — .git/info/exclude', () => {
  const excludeFile = (p: string) => path.join(p, '.git', 'info', 'exclude');
  const gitInit = (p: string) => {
    // A minimal REAL .git: the walk requires HEAD (a bare dir named .git is
    // debris, not a repo — see the phantom regression test below).
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    fs.writeFileSync(path.join(p, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  };

  it('adds both entries inside a git repo and says so', async () => {
    gitInit(cwd);
    await run(['install']);
    const lines = fs.readFileSync(excludeFile(cwd), 'utf8').split('\n');
    expect(lines).toContain('.sparrow/');
    expect(lines).toContain('.claude/skills/sparrow/');
    expect(logs).toContain('added .sparrow/ and .claude/skills/sparrow/ to .git/info/exclude');
  });

  it('--shared excludes only .sparrow/ (the skill dir is meant to be committed)', async () => {
    gitInit(cwd);
    await run(['install', '--shared']);
    const body = fs.readFileSync(excludeFile(cwd), 'utf8');
    expect(body).toContain('.sparrow/');
    expect(body).not.toContain('.claude/skills/sparrow/');
    expect(logs).toContain('added .sparrow/ to .git/info/exclude');
  });

  it('dedupes: a re-install never repeats an entry, and existing content survives', async () => {
    gitInit(cwd);
    fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    fs.writeFileSync(excludeFile(cwd), '# my own excludes\nnotes.txt\n.sparrow/\n');
    await run(['install']);
    await run(['install']);
    const lines = fs.readFileSync(excludeFile(cwd), 'utf8').split('\n').filter(Boolean);
    expect(lines.filter((l) => l === '.sparrow/')).toHaveLength(1);
    expect(lines.filter((l) => l === '.claude/skills/sparrow/')).toHaveLength(1);
    expect(lines).toContain('notes.txt');
  });

  it('appends a newline first when the exclude file does not end with one', async () => {
    gitInit(cwd);
    fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    fs.writeFileSync(excludeFile(cwd), 'no-trailing-newline');
    await run(['install']);
    const lines = fs.readFileSync(excludeFile(cwd), 'utf8').split('\n');
    expect(lines).toContain('no-trailing-newline');
    expect(lines).toContain('.sparrow/');
  });

  it('finds the repo from a nested project dir', async () => {
    gitInit(cwd);
    const nested = path.join(cwd, 'apps', 'thing');
    fs.mkdirSync(nested, { recursive: true });
    await run(['install'], { cwd: nested });
    expect(fs.readFileSync(excludeFile(cwd), 'utf8')).toContain('.sparrow/');
  });

  it('skips it (silently) outside a git repo', async () => {
    await run(['install']);
    expect(logs.join('\n')).not.toContain('.git/info/exclude');
  });

  it('a bare directory NAMED .git above cwd is not a repo — nothing written into it', async () => {
    // Regression: a phantom `.git/` (no HEAD — e.g. debris in /tmp) used to be
    // accepted by the upward walk, and the exclude writer then fabricated
    // `info/exclude` inside it, making the phantom look ever more real. The
    // phantom lives in a test-owned tree — never in the shared tmpdir itself.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-skill-phantom-'));
    fs.mkdirSync(path.join(parent, '.git'));
    const nested = path.join(parent, 'project');
    fs.mkdirSync(nested);
    const prev = cwd;
    cwd = nested;
    try {
      await run(['install']);
      expect(logs.join('\n')).not.toContain('.git/info/exclude');
      expect(fs.existsSync(path.join(parent, '.git', 'info'))).toBe(false);
    } finally {
      cwd = prev;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('install (--user scope)', () => {
  it('installs into ~/.claude with absolute, UNSTAMPED hook paths', async () => {
    expect(await run(['install', '--user'])).toBe(0);
    expect(fs.existsSync(skillFile(home))).toBe(true);
    const s = readSettings(home, 'settings.json');
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain('$CLAUDE_PROJECT_DIR');
    expect(cmd).not.toContain('SPARROW_STATE_DIR');
    expect(path.isAbsolute(cmd)).toBe(true);
    expect(cmd).toContain(path.join(home, '.claude'));
  });

  it('keeps ~/.sparrow as the state dir and adds no git exclude', async () => {
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    expect(await run(['install', '--user'], { env: { HOME: home } })).toBe(0);
    expect(readLoopState(path.join(home, '.sparrow'))).toBe('engaged');
    expect(fs.existsSync(path.join(cwd, '.sparrow'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.git', 'info', 'exclude'))).toBe(false);
  });
});

describe('uninstall', () => {
  it('removes the skill dir and strips only our hook entries', async () => {
    seedSettings(
      cwd,
      {
        model: 'opus',
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }] },
      },
      'settings.local.json',
    );
    await run(['install']);
    expect(await run(['uninstall'])).toBe(0);

    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'sparrow'))).toBe(false);
    const s = readSettings(cwd);
    expect(s.model).toBe('opus');
    expect(commandsFor(s, 'Stop')).toEqual(['echo other']);
    // Our event keys were the only entries there → each pruned on uninstall.
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    expect(s.hooks.PostToolUse).toBeUndefined();
    expect(s.hooks.Notification).toBeUndefined();
  });

  it('round-trips the settings file back to empty hooks when we were the only hooks', async () => {
    await run(['install']);
    await run(['uninstall']);
    expect(readSettings(cwd).hooks).toBeUndefined();
  });

  it('cleans BOTH settings files, whichever one the install used', async () => {
    await run(['install', '--shared']); // registers in settings.json
    await run(['install']); // …then migrates to settings.local.json
    expect(await run(['uninstall'])).toBe(0);
    expect(JSON.stringify(readSettings(cwd, 'settings.json'))).not.toContain('sparrow-');
    expect(JSON.stringify(readSettings(cwd, 'settings.local.json'))).not.toContain('sparrow-');
  });
});

describe('pause / resume / status', () => {
  it('pause and resume flip the loop switch', async () => {
    await run(['install']);
    expect(readLoopState(stateDir)).toBe('engaged');
    expect(await run(['pause'])).toBe(0);
    expect(readLoopState(stateDir)).toBe('paused');
    expect(await run(['resume'])).toBe(0);
    expect(readLoopState(stateDir)).toBe('engaged');
  });

  it('status reports the loop switch and install state', async () => {
    await run(['install']);
    logs.length = 0;
    await run(['status']);
    const out = logs.join('\n');
    expect(out).toMatch(/loop-state: engaged/);
    expect(out).toMatch(/skill: +installed/);
  });

  it('rejects an unknown subcommand with a nonzero code', async () => {
    expect(await run(['frobnicate'])).toBe(1);
  });
});

describe('loop-state + heartbeat primitives', () => {
  it('read returns undefined when absent, then the written value', () => {
    expect(readLoopState(stateDir)).toBeUndefined();
    writeLoopState(stateDir, 'engaged');
    expect(readLoopState(stateDir)).toBe('engaged');
  });

  it('touchHeartbeat creates the file and reports a fresh age', () => {
    touchHeartbeat(stateDir, { force: true });
    const age = heartbeatAgeSeconds(stateDir);
    expect(age).not.toBeUndefined();
    expect(age! < 5).toBe(true);
  });

  it('touchHeartbeat is throttled but advances the mtime past the window', () => {
    const base = 1_000_000_000_000;
    touchHeartbeat(stateDir, { now: base, force: true });
    const first = fs.statSync(path.join(stateDir, 'heartbeat')).mtimeMs;
    // within the throttle window → no write
    touchHeartbeat(stateDir, { now: base + 1000 });
    expect(fs.statSync(path.join(stateDir, 'heartbeat')).mtimeMs).toBe(first);
    // past the window → writes a newer mtime
    touchHeartbeat(stateDir, { now: base + HEARTBEAT_THROTTLE_MS + 1 });
    expect(fs.statSync(path.join(stateDir, 'heartbeat')).mtimeMs).toBeGreaterThan(first);
  });
});

/**
 * The heartbeat records WHICH listener wrote it, so the Stop hook can tell a
 * wake-capable listener (`await`, which EXITS when work arrives and re-invokes a
 * turn-based agent) from a hold-only one (`watch`/`loop`, which keep a
 * turn-based agent online-but-deaf). The no-kind form stays supported: an older
 * CLI or a third-party heartbeat script writes an empty file, which reads back
 * as `undefined` = "cannot judge".
 */
describe('heartbeat listener kind', () => {
  it('writes the listener kind as the file content and still refreshes the mtime', () => {
    const base = 1_000_000_000_000;
    touchHeartbeat(stateDir, { kind: 'await', now: base, force: true });
    const file = path.join(stateDir, 'heartbeat');
    expect(fs.readFileSync(file, 'utf8')).toBe('await\n');
    expect(fs.statSync(file).mtimeMs).toBe(base);
    expect(heartbeatAgeSeconds(stateDir, base)).toBe(0);
  });

  it('readHeartbeatKind round-trips each listener kind', () => {
    for (const kind of ['await', 'watch', 'loop'] as const) {
      touchHeartbeat(stateDir, { kind, force: true });
      expect(readHeartbeatKind(stateDir)).toBe(kind);
    }
  });

  it('the no-kind form writes empty content and reads back as undefined', () => {
    touchHeartbeat(stateDir, { kind: 'watch', force: true });
    expect(readHeartbeatKind(stateDir)).toBe('watch');
    // A legacy toucher (older CLI, third-party script) must not leave a stale
    // claim behind — no kind means no kind.
    touchHeartbeat(stateDir, { force: true });
    expect(fs.readFileSync(path.join(stateDir, 'heartbeat'), 'utf8')).toBe('');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });

  it('reads undefined for an absent file or unrecognized content', () => {
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'heartbeat'), 'curl-loop-of-my-own\n');
    expect(readHeartbeatKind(stateDir)).toBeUndefined();
  });

  it('tolerates surrounding whitespace in the file', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'heartbeat'), '  loop \n');
    expect(readHeartbeatKind(stateDir)).toBe('loop');
  });

  it('is still throttled when a kind is given', () => {
    const base = 1_000_000_000_000;
    touchHeartbeat(stateDir, { kind: 'watch', now: base, force: true });
    touchHeartbeat(stateDir, { kind: 'await', now: base + 1000 });
    expect(readHeartbeatKind(stateDir)).toBe('watch'); // throttled → no rewrite
    touchHeartbeat(stateDir, { kind: 'await', now: base + HEARTBEAT_THROTTLE_MS + 1 });
    expect(readHeartbeatKind(stateDir)).toBe('await');
  });
});

describe('upgrade pruning', () => {
  it('re-install over a v1 layout removes the retired presence hook entry and file', async () => {
    // Simulate the v1 layout: orphan script + a settings entry referencing it.
    const hooksDir = path.join(cwd, '.claude', 'skills', 'sparrow', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'sparrow-presence.sh'), '#!/bin/sh\nexit 0\n');
    seedSettings(cwd, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/sparrow-presence.sh' },
            ],
          },
        ],
      },
    });

    expect(await run(['install'])).toBe(0);
    // The retired entry is gone from the old file…
    expect(JSON.stringify(readSettings(cwd, 'settings.json'))).not.toContain('sparrow-presence.sh');
    expect(fs.existsSync(path.join(hooksDir, 'sparrow-presence.sh'))).toBe(false);
    // …and the v2 entries live in the file this install targeted.
    expect(JSON.stringify(readSettings(cwd, 'settings.local.json'))).toContain(
      'sparrow-auto-status.sh prompt',
    );
  });

  /**
   * The Notification hook used to be registered with matcher '' (= every
   * notification type, including `idle_prompt`). Re-installing must MIGRATE
   * that entry to the new matcher rather than leaving it behind: two groups
   * both pointing at our script would fire it twice, and the old one would
   * still fire on the types the new matcher exists to exclude.
   */
  it("migrates an old matcher-'' Notification entry to the new matcher", async () => {
    seedSettings(
      cwd,
      {
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    '$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/sparrow-auto-status.sh notification',
                },
                { type: 'command', command: 'echo someone-elses-notification-hook' },
              ],
            },
          ],
        },
      },
      'settings.local.json',
    );

    await run(['install']);
    const s = readSettings(cwd);

    const groups: Group[] = s.hooks.Notification;
    const ours = groups.flatMap((g) =>
      g.hooks.filter((h) => h.command.includes('sparrow-auto-status.sh')).map(() => g.matcher ?? ''),
    );
    // Exactly one registration, under the new matcher only.
    expect(ours).toEqual([
      'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|idle_prompt',
    ]);
    // Someone else's hook in the old group is untouched.
    const others = groups.flatMap((g) =>
      g.hooks.map((h) => h.command).filter((c) => !c.includes('sparrow-auto-status.sh')),
    );
    expect(others).toEqual(['echo someone-elses-notification-hook']);
  });

  it("migrates an old matcher-'' PostToolUse entry and drops the emptied group", async () => {
    seedSettings(
      cwd,
      {
        hooks: {
          PostToolUse: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    '$CLAUDE_PROJECT_DIR/.claude/skills/sparrow/hooks/sparrow-auto-status.sh post-tool',
                },
              ],
            },
          ],
        },
      },
      'settings.local.json',
    );

    await run(['install']);
    const groups: Group[] = readSettings(cwd).hooks.PostToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe('*');
    expect(groups[0]!.hooks).toHaveLength(1);
  });
});

/**
 * The background-shell reaper opt-out.
 *
 * Claude Code >= 2.1.193 kills tracked background tasks under OS memory
 * pressure once a session has been idle 30+ minutes with no turn or subagent
 * running (documented in the interactive-mode docs). For a turn-based Sparrow
 * agent the reaped task is EXACTLY its wake listener (`sparrow await`), and
 * "idle 30+ minutes with nothing running" is exactly when that listener is the
 * only thing keeping the agent reachable — so every install must write the
 * documented opt-out into the settings file it targets.
 */
const REAP_KEY = 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP';

describe('settings env — background-shell reaper opt-out', () => {
  it('project install merges the opt-out into settings.local.json', async () => {
    expect(await run(['install'])).toBe(0);
    expect(readSettings(cwd).env).toEqual({ [REAP_KEY]: '1' });
  });

  it('--shared writes it into the committed settings.json instead', async () => {
    await run(['install', '--shared']);
    expect(readSettings(cwd, 'settings.json').env[REAP_KEY]).toBe('1');
  });

  it('--user writes it into ~/.claude/settings.json', async () => {
    await run(['install', '--user']);
    expect(readSettings(home, 'settings.json').env[REAP_KEY]).toBe('1');
  });

  it('creates the env object without clobbering other env keys', async () => {
    seedSettings(cwd, { env: { FOO: 'bar', ANTHROPIC_MODEL: 'opus' } }, 'settings.local.json');
    await run(['install']);
    const s = readSettings(cwd);
    expect(s.env).toEqual({ FOO: 'bar', ANTHROPIC_MODEL: 'opus', [REAP_KEY]: '1' });
  });

  it('is idempotent across re-installs', async () => {
    await run(['install']);
    await run(['install']);
    expect(readSettings(cwd).env).toEqual({ [REAP_KEY]: '1' });
  });

  it('prints one line explaining the opt-out and when it takes effect', async () => {
    await run(['install']);
    expect(logs).toContain(
      `settings env: ${REAP_KEY}=1 (Claude Code's memory-pressure reaper would otherwise kill ` +
        `your await listener during long idle stretches; takes effect on the next Claude Code start)`,
    );
  });

  it('uninstall removes ONLY that key and leaves the other env entries', async () => {
    seedSettings(cwd, { env: { FOO: 'bar' } }, 'settings.local.json');
    await run(['install']);
    expect(await run(['uninstall'])).toBe(0);
    expect(readSettings(cwd).env).toEqual({ FOO: 'bar' });
  });

  it('uninstall drops the env object entirely when it becomes empty', async () => {
    await run(['install']);
    await run(['uninstall']);
    expect(readSettings(cwd).env).toBeUndefined();
  });

  it('uninstall sweeps BOTH settings files, whichever install wrote it', async () => {
    await run(['install', '--shared']);
    await run(['uninstall']);
    expect(readSettings(cwd, 'settings.json').env).toBeUndefined();
  });

  it('leaves an unrelated env var alone on uninstall when we never installed', async () => {
    seedSettings(cwd, { env: { FOO: 'bar' } }, 'settings.local.json');
    await run(['uninstall']);
    expect(readSettings(cwd).env).toEqual({ FOO: 'bar' });
  });

  it('status reports the opt-out as set after an install', async () => {
    await run(['install']);
    logs.length = 0;
    await run(['status']);
    const out = logs.join('\n');
    expect(out).toContain(REAP_KEY);
    expect(out).toMatch(/opt-out set/);
  });

  it('status reports the opt-out as missing when it is not in the settings', async () => {
    await run(['install']);
    await run(['uninstall']);
    logs.length = 0;
    await run(['status']);
    const out = logs.join('\n');
    expect(out).toContain(REAP_KEY);
    expect(out).toMatch(/MISSING/);
  });

  it('status finds it in the committed settings.json after a --shared install', async () => {
    await run(['install', '--shared']);
    logs.length = 0;
    await run(['status']);
    expect(logs.join('\n')).toMatch(/opt-out set/);
  });
});
