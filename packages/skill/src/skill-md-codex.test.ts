/**
 * The CODEX playbook.
 *
 * Two obligations, and they pull in opposite directions:
 *
 *  1. The provider-neutral core must arrive INTACT. Everything a Sparrow citizen
 *     has to know — the typed work queue, the clawback rule, the no-pipes
 *     rhythm, the empty-pop hint, the email and voice register lessons, the
 *     credential ladder, the wake pattern, the pause switch — is the same
 *     document for both harnesses, so this file re-asserts the load-bearing
 *     parts against the Codex render. Anything that passes here and in
 *     `skill-md.test.ts` is, by construction, shared.
 *  2. Everything Claude-specific must be GONE, and replaced with what is
 *     actually true on Codex. A playbook that told a Codex agent about
 *     `.claude/settings.local.json` or the background-shell reaper would be
 *     teaching it to look for files that do not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSkillMd } from './skill-md.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codex = renderSkillMd('codex');
const claude = renderSkillMd('claude');

function constantFromCommonTypes(name: string): string {
  const src = fs.readFileSync(
    path.join(here, '..', '..', 'common-types', 'src', 'constants.ts'),
    'utf8',
  );
  const m = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${name} not found in @sparrow/common-types`);
  return m[1]!;
}

describe('Codex SKILL.md — the shipped shape', () => {
  it('carries the YAML frontmatter Codex\'s skills system reads', () => {
    expect(codex.startsWith('---\n')).toBe(true);
    const front = codex.slice(4, codex.indexOf('\n---\n'));
    expect(front).toMatch(/^name: sparrow$/m);
    expect(front).toMatch(/^description: .+/m);
  });

  it('renders fully — no placeholder survives into a file an agent reads', () => {
    expect(codex).not.toMatch(/\{\{sparrow:/);
  });

  it('names its own home and invocation', () => {
    expect(codex).toContain('.agents/skills/sparrow/SKILL.md');
    expect(codex).toContain('$sparrow');
    expect(codex).toContain('AGENTS.md');
  });
});

/**
 * The neutral core. Each of these is also asserted for Claude Code in
 * `skill-md.test.ts`; duplicating them here is the point — it is what stops the
 * Codex variant quietly becoming a lesser document.
 */
describe('Codex SKILL.md — the provider-neutral core survives', () => {
  it('teaches the typed work queue and the forward-compat rule', () => {
    expect(codex).toContain('item.type');
    expect(codex).toContain('"type": "chat.message"');
    expect(codex).toContain('"type": "email"');
    expect(codex).toContain('"item": null');
    expect(codex.toLowerCase()).toMatch(/unknown|unrecognized/);
  });

  it('teaches the clawback no-op rule', () => {
    expect(codex).toContain('message.clawback');
    expect(codex).toMatch(/never sent/i);
    expect(codex).toMatch(/no-op/i);
  });

  it('teaches plain commands, draining to empty, and the one hint', () => {
    expect(codex).toMatch(/do \*\*not\*\* pipe|never pipe|don't pipe/i);
    expect(codex).toContain('Inbox empty.');
    expect(codex).toContain('[hint]');
    expect(codex).toContain('sparrow tips');
  });

  it('keeps the email medium, gated on capabilities, with the register note', () => {
    expect(codex).toContain('/api/v1/capabilities');
    expect(codex).toContain('/api/v1/me/email/send');
    expect(codex).toContain(constantFromCommonTypes('EMAIL_REGISTER_NOTE'));
  });

  /**
   * The voice section is the one the coordinator called out by name: it is
   * shared, it pins a constant from `@sparrow/common-types`, and it must keep
   * passing for BOTH rendered playbooks.
   */
  it('keeps the whole voice / hands-free section, with VOICE_REGISTER_NOTE verbatim', () => {
    const idx = codex.indexOf('## Voice / hands-free');
    expect(idx).toBeGreaterThan(0);
    const section = codex.slice(idx, codex.indexOf('\n## ', idx + 5));
    expect(section).toContain('/api/v1/capabilities');
    expect(section).toMatch(/hands-free/i);
    expect(section).toContain(constantFromCommonTypes('VOICE_REGISTER_NOTE'));
    expect(section).toContain('inReplyTo');
    expect(section).toContain('sparrow send --origin voice');
    // …and it still sits after email — both are register lessons, email first.
    expect(idx).toBeGreaterThan(codex.indexOf('## Email (only when the instance has it)'));
  });

  it('keeps the credential ladder, the canonical installer and docs home', () => {
    expect(codex).toContain('SPARROW_PROFILE');
    expect(codex).toContain('defaultProfile');
    expect(codex).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
    expect(codex).toContain('https://sparrow.land/docs/');
  });

  it('keeps the come-online fork and the await → drain → handle → re-arm pattern', () => {
    expect(codex).toMatch(/always-running/i);
    expect(codex).toMatch(/turn-based/i);
    expect(codex).toContain('sparrow await');
    expect(codex).toMatch(/re-arm/i);
    expect(codex).toMatch(/exits? \*\*0\*\*/);
    expect(codex).toContain(
      '`sparrow watch` alone will NOT cause you to act on messages — you need a wake mechanism',
    );
  });

  it('keeps the pause switch and the per-project state dir', () => {
    expect(codex).toContain('sparrow skill pause');
    expect(codex).toContain('<project>/.sparrow');
    expect(codex).toContain('SPARROW_STATE_DIR');
  });

  it('is the same document: only the provider-specific passages differ', () => {
    // A crude but effective drift alarm — if someone forks the base, this dives.
    const shared = codex.split('\n').filter((l) => claude.includes(l)).length;
    expect(shared / codex.split('\n').length).toBeGreaterThan(0.9);
  });
});

describe('Codex SKILL.md — nothing Claude-specific leaks', () => {
  it('never mentions the background-shell reaper or its opt-out', () => {
    expect(codex).not.toContain('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP');
    expect(codex).not.toMatch(/memory[- ]pressure/i);
  });

  it('never points at Claude Code settings files or the .claude skill dir', () => {
    expect(codex).not.toContain('.claude/settings.local.json');
    expect(codex).not.toContain('.claude/settings.json');
    expect(codex).not.toContain('.claude/skills/sparrow/');
  });

  it("never names Claude Code as this agent's own harness", () => {
    // Two mentions are legitimate and both are about somebody else: the
    // harness-mode aside (which lists the runners `sparrow harness` can spawn
    // for OTHER agents), and a comparison that reassures the reader a mechanism
    // they may have read about elsewhere behaves the same here. Anything else
    // would be instructing a Codex agent about a harness it is not running in.
    for (const line of codex.split('\n')) {
      if (!line.includes('Claude Code')) continue;
      expect(line).toMatch(/sparrow harness|as Claude Code does/);
    }
  });

  it('does not promise a blocked status Codex cannot produce', () => {
    const idx = codex.indexOf('### Auto-status');
    const section = codex.slice(idx, codex.indexOf('## Presence for turn-based agents'));
    expect(section).toMatch(/no `Notification` event|nothing automatic on Codex/i);
    expect(section).toContain('sparrow status working --note "blocked — needs your input" --sticky');
    expect(section).not.toContain('idle_prompt');
    expect(section).not.toContain('permission_prompt');
  });
});

describe('Codex SKILL.md — what the hooks enforce', () => {
  const section = () => {
    const idx = codex.indexOf('## What the hooks enforce');
    expect(idx).toBeGreaterThan(0);
    return codex.slice(idx);
  };

  it('names the real Codex file and the four events it wires', () => {
    const s = section();
    expect(s).toContain('.codex/hooks.json');
    for (const event of ['Stop', 'SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      expect(s).toContain(`- **${event}**`);
    }
    expect(s).not.toContain('- **Notification**');
  });

  it('keeps the Stop hook honest about what it can and cannot judge', () => {
    const s = section();
    expect(s).toMatch(/wake[- ]capable/);
    expect(s).toContain('sparrow await');
    expect(s).toMatch(/cannot judge/i);
    expect(s).toMatch(/killed:SIGTERM|`killed`/);
    expect(s).toContain('stop_hook_active');
  });

  it('says the block-the-stop re-arm guarantee survives on Codex', () => {
    expect(section()).toContain('{"decision":"block"}');
  });

  it('documents both silent trust gates and the verify flow that beats them', () => {
    const s = section();
    expect(s).toMatch(/trust_level = "trusted"/);
    expect(s).toContain('/hooks');
    expect(s).toContain('--dangerously-bypass-hook-trust');
    expect(s).toMatch(/never fire|silently never run|simply never fire/i);
    expect(s).toContain('sparrow skill verify');
    expect(s).toMatch(/UNVERIFIED/);
    expect(s).toMatch(/never green|never green,|reported \*\*UNVERIFIED\*\*/i);
  });

  it('still honors the loop switch', () => {
    expect(section()).toMatch(/while `loop-state` is `paused`, none of them write anything/);
  });
});

/**
 * The one thing that is STRUCTURALLY different on Codex and cannot be worked
 * around: the per-command sandbox is a PID namespace, so a detached child of a
 * model-run shell command dies the instant that command exits. A playbook that
 * did not say so would have Codex agents arming listeners that are already dead.
 */
describe('Codex SKILL.md — the sandbox truth about the wake listener', () => {
  const section = () => {
    const idx = codex.indexOf('### The wake pattern');
    expect(idx).toBeGreaterThan(0);
    return codex.slice(idx, codex.indexOf('## Session-start protocol'));
  };

  it('warns that a listener started from a tool call is killed with the command', () => {
    const s = section();
    expect(s).toMatch(/PID namespace/i);
    expect(s).toMatch(/setsid/);
    expect(s).toMatch(/dead before your turn is over|SIGKILL/i);
  });

  it('names the place a listener DOES survive: hooks run outside the sandbox', () => {
    expect(section()).toMatch(/hooks[^.]*outside/i);
  });

  it('names the two config prerequisites the installer writes', () => {
    const s = section();
    expect(s).toContain('network_access');
    expect(s).toContain('writable_roots');
    expect(s).toContain('.codex/config.toml');
  });

  it('is honest that Codex interrupt behavior is unverified', () => {
    expect(section()).toMatch(/not verified|unverified/i);
  });
});
