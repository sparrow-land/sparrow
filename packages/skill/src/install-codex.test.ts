/**
 * The Codex installer — `sparrow skill install --codex`.
 *
 * Three things are load-bearing and each has bitten somebody live:
 *
 *  1. **The hooks.json schema is NOT Claude Code's.** Codex nests events under a
 *     top-level `hooks` key; a Claude-shaped file is accepted as JSON, fails to
 *     deserialize, prints one warning to stderr, and then runs NO hooks at all.
 *     Nothing else reports it.
 *  2. **Foreign content must survive.** `hooks.json`, `config.toml` and
 *     `AGENTS.md` are all files the user very likely already owns.
 *  3. **A file on disk proves nothing.** Two silent trust gates stand between a
 *     registration and a hook that runs, so `status`/`verify` must report firing,
 *     not existence, and must never show a tick for something unproven.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkill } from './install.js';
import { managedToml, validateCodexHooks, type CodexHooksFile } from './provider-codex.js';
import { readLoopState } from './state.js';

let cwd: string;
let home: string;
let stateDir: string;
let logs: string[];

function env(): Record<string, string | undefined> {
  return { HOME: home, SPARROW_STATE_DIR: stateDir };
}

function run(
  argv: string[],
  overrides: Partial<{ env: Record<string, string | undefined>; cwd: string }> = {},
): Promise<number> {
  return runSkill(argv, {
    cwd: overrides.cwd ?? cwd,
    home,
    env: overrides.env ?? env(),
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-codex-cwd-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-codex-home-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-codex-state-'));
  fs.rmSync(stateDir, { recursive: true, force: true }); // start absent
  logs = [];
});

afterEach(() => {
  for (const d of [cwd, home, stateDir]) fs.rmSync(d, { recursive: true, force: true });
});

const skillMd = (p: string) => path.join(p, '.agents', 'skills', 'sparrow', 'SKILL.md');
const hookScript = (p: string, f: string) =>
  path.join(p, '.agents', 'skills', 'sparrow', 'hooks', f);
const hooksJson = (p: string) => path.join(p, '.codex', 'hooks.json');
const configToml = (p: string) => path.join(p, '.codex', 'config.toml');
const agentsMd = (p: string) => path.join(p, 'AGENTS.md');

const readHooks = (p: string): CodexHooksFile =>
  JSON.parse(fs.readFileSync(hooksJson(p), 'utf8')) as CodexHooksFile;
const commandsFor = (f: CodexHooksFile, event: string): string[] =>
  (f.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];

/* ------------------------------- the playbook ------------------------------- */

describe('install --codex — the playbook', () => {
  it('writes the Codex-flavored SKILL.md to Codex\'s own skills dir', async () => {
    expect(await run(['install', '--codex'])).toBe(0);
    expect(fs.existsSync(skillMd(cwd))).toBe(true);
    const body = fs.readFileSync(skillMd(cwd), 'utf8');
    expect(body).toContain('name: sparrow');
    expect(body).toContain('.codex/hooks.json');
    // …and none of Claude Code's furniture.
    expect(body).not.toContain('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP');
    // The Claude playbook is NOT what landed here.
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  it('installs every hook script it registers, executable', async () => {
    await run(['install', '--codex']);
    for (const f of [
      'sparrow-stop-check.sh',
      'sparrow-auto-status.sh',
      'sparrow-session-start.sh',
      'sparrow-codex-hook.sh',
    ]) {
      expect(fs.existsSync(hookScript(cwd, f))).toBe(true);
      expect(fs.statSync(hookScript(cwd, f)).mode & 0o111).toBeTruthy();
    }
  });

  it('seeds the loop switch exactly as the Claude path does', async () => {
    await run(['install', '--codex']);
    expect(readLoopState(stateDir)).toBe('engaged');
  });
});

/* -------------------------------- hooks.json -------------------------------- */

describe('install --codex — hooks.json', () => {
  it('writes the REAL Codex schema: events nested under a top-level `hooks`', async () => {
    await run(['install', '--codex']);
    const raw = JSON.parse(fs.readFileSync(hooksJson(cwd), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).toContain('hooks');
    // The Claude Code shape (events at the top level) would be a silent no-op.
    for (const event of EVENTS) expect(raw[event]).toBeUndefined();
    expect(validateCodexHooks(raw)).toEqual([]);
    const file = raw as CodexHooksFile;
    for (const event of EVENTS) {
      expect(commandsFor(file, event)).toHaveLength(1);
      expect(file.hooks![event]![0]!.hooks[0]!.type).toBe('command');
      expect(file.hooks![event]![0]!.hooks[0]!.timeout).toBeTypeOf('number');
    }
  });

  it('wires each event to the script that handles it, through the firing wrapper', async () => {
    await run(['install', '--codex']);
    const f = readHooks(cwd);
    expect(commandsFor(f, 'Stop')[0]).toMatch(/sparrow-codex-hook\.sh" Stop ".*sparrow-stop-check\.sh"$/);
    expect(commandsFor(f, 'SessionStart')[0]).toMatch(/ SessionStart ".*sparrow-session-start\.sh"$/);
    expect(commandsFor(f, 'UserPromptSubmit')[0]).toMatch(/ UserPromptSubmit ".*sparrow-auto-status\.sh" prompt$/);
    expect(commandsFor(f, 'PostToolUse')[0]).toMatch(/ PostToolUse ".*sparrow-auto-status\.sh" post-tool$/);
  });

  /**
   * A Codex hook payload has no `$CLAUDE_PROJECT_DIR` equivalent and no
   * guaranteed cwd, so anything relative would resolve somewhere else on some
   * machine. Every path is therefore pinned at install time.
   */
  it('bakes ABSOLUTE paths and the state dir into every command', async () => {
    await run(['install', '--codex', '--profile', 'acme']);
    const f = readHooks(cwd);
    const all = EVENTS.flatMap((e) => commandsFor(f, e));
    expect(all).toHaveLength(4);
    for (const c of all) {
      expect(c).not.toContain('$CLAUDE_PROJECT_DIR');
      expect(c).toContain(`SPARROW_STATE_DIR="${stateDir}"`);
      expect(c).toContain('SPARROW_PROFILE="acme"');
      expect(c).toContain(path.join(cwd, '.agents', 'skills', 'sparrow', 'hooks'));
    }
    // The SessionStart injector needs to be able to NAME the playbook.
    expect(commandsFor(f, 'SessionStart')[0]).toContain(`SPARROW_SKILL_PATH="${skillMd(cwd)}"`);
  });

  it('is idempotent — a re-install never duplicates an entry', async () => {
    await run(['install', '--codex']);
    await run(['install', '--codex']);
    const f = readHooks(cwd);
    for (const event of EVENTS) expect(commandsFor(f, event)).toHaveLength(1);
  });

  /** Their hooks.json is very likely to exist, with their own hooks in it. */
  it('MERGES into an existing hooks.json, preserving foreign hooks and keys', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(
      hooksJson(cwd),
      JSON.stringify({
        description: 'my own hooks',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo their-stop' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo their-pre' }] }],
        },
      }),
    );
    await run(['install', '--codex']);
    const f = readHooks(cwd);
    expect(f.description).toBe('my own hooks'); // never clobbered
    expect(commandsFor(f, 'PreToolUse')).toEqual(['echo their-pre']);
    expect(commandsFor(f, 'Stop')).toContain('echo their-stop');
    expect(commandsFor(f, 'Stop').some((c) => c.includes('sparrow-stop-check.sh'))).toBe(true);
  });

  it('claims the description only when the file had none', async () => {
    await run(['install', '--codex']);
    expect(readHooks(cwd).description).toMatch(/sparrow/);
  });

  /** An old registration under a different event must not keep firing forever. */
  it('sweeps our entries out of EVERY event, not just the ones we write', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(
      hooksJson(cwd),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                { type: 'command', command: '/old/hooks/sparrow-auto-status.sh stop' },
                { type: 'command', command: 'echo theirs' },
              ],
            },
          ],
        },
      }),
    );
    await run(['install', '--codex']);
    const f = readHooks(cwd);
    expect(commandsFor(f, 'SessionEnd')).toEqual(['echo theirs']);
  });
});

describe('validateCodexHooks — the schema that fails silently', () => {
  it('accepts what we write', async () => {
    await run(['install', '--codex']);
    expect(validateCodexHooks(readHooks(cwd))).toEqual([]);
  });

  it('rejects a Claude-shaped file, naming the exact failure', () => {
    const claudeShaped = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x' }] }],
    };
    const problems = validateCodexHooks(claudeShaped);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no top-level `hooks` key/);
    expect(problems[0]).toMatch(/Claude Code shape/);
  });

  it('rejects malformed groups and entries', () => {
    expect(validateCodexHooks({ hooks: { Stop: 'nope' } })[0]).toMatch(/not an array of groups/);
    expect(validateCodexHooks({ hooks: { Stop: [{}] } })[0]).toMatch(/without a `hooks` array/);
    expect(
      validateCodexHooks({ hooks: { Stop: [{ hooks: [{ type: 'mcp', command: 'x' }] }] } })[0],
    ).toMatch(/type is not "command"/);
    expect(validateCodexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } })[0]).toMatch(
      /no command/,
    );
  });
});

/* -------------------------------- config.toml ------------------------------- */

describe('install --codex — config.toml', () => {
  it('writes the documented inline prerequisite', async () => {
    await run(['install', '--codex']);
    const toml = fs.readFileSync(configToml(cwd), 'utf8');
    expect(toml).toContain('[sandbox_workspace_write]');
    expect(toml).toContain('network_access = true');
  });

  /**
   * The TOML footgun: a bare key written after a `[table]` header lands inside
   * that table. Our block is appended to somebody else's file, so the invariant
   * has to hold by construction, not by review.
   */
  it('managedToml puts every top-level key BEFORE the first table header', () => {
    const text = managedToml(
      [
        ['notify', '["sh", "-c", "x"]'],
        ['approval_policy', '"never"'],
      ],
      [{ name: 'sandbox_workspace_write', keys: [['network_access', 'true']] }],
    );
    const firstTable = text.indexOf('[sandbox_workspace_write]');
    expect(firstTable).toBeGreaterThan(-1);
    expect(text.indexOf('notify =')).toBeLessThan(firstTable);
    expect(text.indexOf('approval_policy =')).toBeLessThan(firstTable);
  });

  it('appends only a TABLE, so nothing of ours can land in a foreign table', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(configToml(cwd), '[features]\nhooks = true\n');
    await run(['install', '--codex']);
    const toml = fs.readFileSync(configToml(cwd), 'utf8');
    const ours = toml.slice(toml.indexOf('# >>> sparrow'));
    // First non-comment, non-blank line of our block must be a table header.
    const first = ours.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(first).toBe('[sandbox_workspace_write]');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
  });

  it('adds writable_roots only when the state dir is OUTSIDE the workspace', async () => {
    // The test rig points SPARROW_STATE_DIR at a tmpdir outside `cwd`.
    await run(['install', '--codex']);
    expect(fs.readFileSync(configToml(cwd), 'utf8')).toContain(`writable_roots = ["${stateDir}"]`);

    // …and a plain project install, whose `.sparrow` is inside the project,
    // needs no writable root at all.
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-codex-in-'));
    try {
      await run(['install', '--codex'], { cwd: clean, env: { HOME: home } });
      expect(fs.readFileSync(configToml(clean), 'utf8')).not.toContain('writable_roots');
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });

  it('is idempotent and preserves foreign config', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(configToml(cwd), 'model = "gpt-6"\n\n[features]\nhooks = true\n');
    await run(['install', '--codex']);
    await run(['install', '--codex']);
    const toml = fs.readFileSync(configToml(cwd), 'utf8');
    expect(toml.match(/\[sandbox_workspace_write\]/g)).toHaveLength(1);
    expect(toml).toContain('model = "gpt-6"');
    expect(toml).toContain('[features]');
  });

  /**
   * Two `[sandbox_workspace_write]` tables is invalid TOML — Codex would fail to
   * load the whole config. Refusing to write, loudly, beats breaking their setup.
   */
  it('refuses to write a second [sandbox_workspace_write] and says what to do', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(configToml(cwd), '[sandbox_workspace_write]\nnetwork_access = false\n');
    await run(['install', '--codex']);
    const toml = fs.readFileSync(configToml(cwd), 'utf8');
    expect(toml.match(/\[sandbox_workspace_write\]/g)).toHaveLength(1);
    expect(toml).toContain('network_access = false'); // theirs, untouched
    expect(logs.join('\n')).toMatch(/already declares \[sandbox_workspace_write\]/);
    expect(logs.join('\n')).toContain('network_access = true');
  });
});

/* --------------------------------- AGENTS.md -------------------------------- */

describe('install --codex — the AGENTS.md fragment', () => {
  it('appends a SHORT delimited section pointing at the skill', async () => {
    await run(['install', '--codex']);
    const body = fs.readFileSync(agentsMd(cwd), 'utf8');
    expect(body).toContain('<!-- BEGIN SPARROW SKILL -->');
    expect(body).toContain('<!-- END SPARROW SKILL -->');
    expect(body).toContain('$sparrow');
    expect(body).toContain('.agents/skills/sparrow/SKILL.md');
    expect(body).toContain('sparrow await --timeout 900');
    // Codex's AGENTS.md budget is 32KiB and truncation is SILENT, so our
    // fragment stays a pointer. A kilobyte is already generous.
    const block = body.slice(body.indexOf('<!-- BEGIN'), body.indexOf('<!-- END'));
    expect(block.length).toBeLessThan(1024);
  });

  it('preserves an existing AGENTS.md and re-applies idempotently', async () => {
    fs.writeFileSync(agentsMd(cwd), '# House rules\n\nAlways run the tests.\n');
    await run(['install', '--codex']);
    await run(['install', '--codex']);
    const body = fs.readFileSync(agentsMd(cwd), 'utf8');
    expect(body).toContain('# House rules');
    expect(body).toContain('Always run the tests.');
    expect(body.match(/<!-- BEGIN SPARROW SKILL -->/g)).toHaveLength(1);
  });
});

/* ------------------------------ git excludes -------------------------------- */

describe('install --codex — .git/info/exclude', () => {
  it('excludes the state dir, the skill dir and .codex — but not AGENTS.md', async () => {
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await run(['install', '--codex']);
    const lines = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(lines).toContain('.sparrow/');
    expect(lines).toContain('.agents/skills/sparrow/');
    expect(lines).toContain('.codex/');
    // AGENTS.md is small, shared and marker-delimited — it is meant to be committed.
    expect(lines).not.toContain('AGENTS.md');
  });
});

/* -------------------------------- uninstall --------------------------------- */

describe('uninstall --codex', () => {
  it('removes the skill dir and every managed block, leaving nothing behind', async () => {
    await run(['install', '--codex']);
    expect(await run(['uninstall', '--codex'])).toBe(0);
    expect(fs.existsSync(path.join(cwd, '.agents', 'skills', 'sparrow'))).toBe(false);
    // Files that held ONLY our block were ours to create, so they go too.
    expect(fs.existsSync(hooksJson(cwd))).toBe(false);
    expect(fs.existsSync(configToml(cwd))).toBe(false);
    expect(fs.existsSync(agentsMd(cwd))).toBe(false);
  });

  it('PRESERVES foreign hooks, foreign config and a foreign AGENTS.md', async () => {
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.writeFileSync(
      hooksJson(cwd),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] },
      }),
    );
    fs.writeFileSync(configToml(cwd), 'model = "gpt-6"\n');
    fs.writeFileSync(agentsMd(cwd), '# House rules\n');

    await run(['install', '--codex']);
    await run(['uninstall', '--codex']);

    const f = readHooks(cwd);
    expect(commandsFor(f, 'Stop')).toEqual(['echo theirs']);
    expect(JSON.stringify(f)).not.toContain('sparrow-');
    expect(fs.readFileSync(configToml(cwd), 'utf8')).toContain('model = "gpt-6"');
    expect(fs.readFileSync(configToml(cwd), 'utf8')).not.toContain('sandbox_workspace_write');
    const agents = fs.readFileSync(agentsMd(cwd), 'utf8');
    expect(agents).toContain('# House rules');
    expect(agents).not.toContain('SPARROW SKILL');
  });

  it('round-trips: install → uninstall leaves a foreign AGENTS.md byte-identical', async () => {
    const original = '# House rules\n\nAlways run the tests.\n';
    fs.writeFileSync(agentsMd(cwd), original);
    await run(['install', '--codex']);
    await run(['uninstall', '--codex']);
    expect(fs.readFileSync(agentsMd(cwd), 'utf8')).toBe(original);
  });

  it('leaves the loop state alone', async () => {
    await run(['install', '--codex']);
    await run(['uninstall', '--codex']);
    expect(readLoopState(stateDir)).toBe('engaged');
  });
});

/* ------------------------- trust: the honest reporting ---------------------- */

describe('install --codex — the trust steps the installer cannot take', () => {
  it('prints both gates, exactly, with the config a human can paste', async () => {
    await run(['install', '--codex']);
    const out = logs.join('\n');
    expect(out).toMatch(/TWO MANUAL TRUST STEPS/);
    expect(out).toContain(`[projects.${JSON.stringify(cwd)}]`);
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain('/hooks');
    expect(out).toContain('--dangerously-bypass-hook-trust');
    // And the honest consequence of skipping them.
    expect(out).toMatch(/silently never run|no warning, no error/i);
    expect(out).toContain('sparrow skill verify --codex');
    expect(out).toContain('0.153.3');
  });
});

describe('status --codex', () => {
  it('validates the hooks file but reports trust as UNVERIFIED — never a tick', async () => {
    await run(['install', '--codex']);
    logs.length = 0;
    await run(['status', '--codex']);
    const out = logs.join('\n');
    expect(out).toContain('provider:   Codex');
    expect(out).toMatch(/skill: +installed/);
    expect(out).toMatch(/hooks\.json: valid/);
    expect(out).toMatch(/trust: +UNVERIFIED/);
    expect(out).toMatch(/0\/4 hooks observed firing/);
  });

  it('reports an INVALID (Claude-shaped) hooks.json rather than a happy tick', async () => {
    await run(['install', '--codex']);
    fs.writeFileSync(hooksJson(cwd), JSON.stringify({ Stop: [] }));
    logs.length = 0;
    await run(['status', '--codex']);
    expect(logs.join('\n')).toMatch(/hooks\.json: INVALID/);
  });
});

/**
 * `verify` is the whole answer to "the files exist, so it works, right?".
 * Every hook we install runs through a wrapper that stamps
 * `<state dir>/hooks-fired/<Event>`; verify reads those stamps and nothing else
 * can make it green.
 */
describe('verify --codex', () => {
  const markFired = (event: string): void => {
    fs.mkdirSync(path.join(stateDir, 'hooks-fired'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'hooks-fired', event), '');
  };

  it('exits NON-ZERO while any hook has never been observed firing', async () => {
    await run(['install', '--codex']);
    logs.length = 0;
    expect(await run(['verify', '--codex'])).toBe(1);
    const out = logs.join('\n');
    for (const event of EVENTS) expect(out).toContain(`fired ${event}: NEVER — UNVERIFIED`);
    expect(out).toMatch(/UNVERIFIED/);
    expect(out).toMatch(/never fired is not proof/i);
  });

  it('reports registration and the playbook separately from firing', async () => {
    await run(['install', '--codex']);
    logs.length = 0;
    await run(['verify', '--codex']);
    const out = logs.join('\n');
    for (const event of EVENTS) expect(out).toContain(`hook ${event}: registered`);
    expect(out).toMatch(/playbook: .*SKILL\.md/);
    expect(out).toMatch(/AGENTS\.md: +sparrow section present/);
  });

  it('goes green — and exit 0 — only once EVERY wired hook has fired', async () => {
    await run(['install', '--codex']);
    for (const event of EVENTS.slice(0, 3)) markFired(event);
    expect(await run(['verify', '--codex'])).toBe(1);
    markFired('Stop');
    logs.length = 0;
    expect(await run(['verify', '--codex'])).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('All checks passed.');
    for (const event of EVENTS) expect(out).toMatch(new RegExp(`fired ${event}: yes,`));
  });

  it('fails loudly when the hooks file was replaced with a Claude-shaped one', async () => {
    await run(['install', '--codex']);
    for (const event of EVENTS) markFired(event);
    fs.writeFileSync(hooksJson(cwd), JSON.stringify({ Stop: [] }));
    logs.length = 0;
    expect(await run(['verify', '--codex'])).toBe(1);
    expect(logs.join('\n')).toMatch(/Claude Code shape/);
  });
});

/* ------------------------- provider auto-detection --------------------------- */

describe('provider detection', () => {
  it('picks Codex from a .codex/ or AGENTS.md fingerprint', async () => {
    fs.writeFileSync(agentsMd(cwd), '# rules\n');
    expect(await run(['install'])).toBe(0);
    expect(fs.existsSync(skillMd(cwd))).toBe(true);
    expect(logs.join('\n')).toMatch(/Detected harness: Codex/);
  });

  it('picks Claude Code from a .claude/ or CLAUDE.md fingerprint', async () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# rules\n');
    await run(['install']);
    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'sparrow', 'SKILL.md'))).toBe(true);
  });

  it('defaults to Claude Code in a bare directory (the historical behavior)', async () => {
    await run(['install']);
    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'sparrow', 'SKILL.md'))).toBe(true);
  });

  it('REFUSES to guess when both fingerprints are present', async () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# a\n');
    fs.writeFileSync(agentsMd(cwd), '# b\n');
    expect(await run(['install'])).toBe(1);
    const out = logs.join('\n');
    expect(out).toMatch(/looks like BOTH/);
    expect(out).toContain('--claude');
    expect(out).toContain('--codex');
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.agents'))).toBe(false);
  });

  /**
   * The upgrade path, and the reason the ambiguity rule cannot come first:
   * plenty of repos carry both a CLAUDE.md and an AGENTS.md, and a project that
   * already has a working install must keep working without a new flag.
   */
  it('an EXISTING install wins over an ambiguous fingerprint', async () => {
    await run(['install', '--codex']);
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# a\n');
    logs.length = 0;
    expect(await run(['install'])).toBe(0);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
    expect(logs.join('\n')).toMatch(/existing Codex install/);
  });

  it('an explicit flag always wins over detection', async () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# a\n');
    fs.writeFileSync(agentsMd(cwd), '# b\n');
    expect(await run(['install', '--codex'])).toBe(0);
    expect(fs.existsSync(skillMd(cwd))).toBe(true);
  });
});

/* ---------------------------- the two providers coexist ---------------------- */

describe('both providers in one checkout', () => {
  it('installs side by side without either touching the other', async () => {
    await run(['install', '--claude']);
    await run(['install', '--codex']);
    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'sparrow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(skillMd(cwd))).toBe(true);
    // One state dir, one loop switch — that part is deliberately shared.
    expect(readLoopState(stateDir)).toBe('engaged');

    await run(['uninstall', '--codex']);
    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'sparrow', 'SKILL.md'))).toBe(true);
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'))),
    ).toContain('sparrow-stop-check.sh');
  });
});

/* -------------------------------- user scope -------------------------------- */

describe('install --codex --user', () => {
  it('installs into ~/.agents and ~/.codex, and honors $CODEX_HOME', async () => {
    await run(['install', '--codex', '--user'], { env: { HOME: home } });
    expect(fs.existsSync(skillMd(home))).toBe(true);
    expect(fs.existsSync(hooksJson(home))).toBe(true);
    // The global brief is `$CODEX_HOME/AGENTS.md`, not the project's.
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(agentsMd(cwd))).toBe(false);

    const codexHome = path.join(home, 'scoped-codex');
    await run(['install', '--codex', '--user'], { env: { HOME: home, CODEX_HOME: codexHome } });
    expect(fs.existsSync(path.join(codexHome, 'hooks.json'))).toBe(true);
  });
});
