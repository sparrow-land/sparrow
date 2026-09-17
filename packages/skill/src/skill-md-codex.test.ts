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
    expect(codex).toContain('CODEX_THREAD_ID');
    expect(codex).toContain('automatically queues');
    expect(codex).toContain('Codex requires explicit turn delivery');
    expect(codex).toContain('unbounded `sparrow await`');
    expect(codex).toContain('terminal `426 client_upgrade_required`');
    expect(codex).not.toContain('sparrow await --timeout 900');
    expect(codex).not.toContain('every turn-based harness already understands');
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
/** The same refusal, restated where a session-start turn will read it. */
describe('Codex SKILL.md — the session-start bullet names the refusal', () => {
  const bullet = () => {
    const idx = codex.indexOf('## Session-start protocol');
    expect(idx).toBeGreaterThan(0);
    return codex.slice(idx, codex.indexOf('## Inbox etiquette'));
  };

  it('says await refuses to arm rather than arming something already dead', () => {
    const b = bullet();
    expect(b).toMatch(/refuses to arm/i);
    expect(b).toMatch(/prints the (one |exact )?command/i);
  });
});

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

  /**
   * The refusal has to be in the playbook, or an agent meets it as an
   * unexplained failure mid-turn and starts inventing flags to get past it.
   * Two facts, and no third: WHEN await refuses, and that it prints the next
   * command itself.
   */
  it('warns that await REFUSES to arm in the sandbox or without firing hooks', () => {
    const s = section();
    expect(s).toMatch(/refuses to arm/i);
    expect(s).toMatch(/sandbox/i);
    expect(s).toMatch(/hooks are not firing|hooks are not verified|hooks aren't firing/i);
    expect(s).toMatch(/prints the (one |exact )?command/i);
  });

  it('points at the fix (hook-armed or unsandboxed listener + hook trust), not at new flags', () => {
    const s = section();
    expect(s).toMatch(/hook-armed|from a hook|outside the sandbox|unsandboxed/i);
    expect(s).toMatch(/trust/i);
    expect(s).toMatch(/no new flags|nothing new to remember|no flag/i);
  });

  /**
   * The other refusal, same paragraph: arming is idempotent and supersedes the
   * previous listener, which is exactly right WITHIN one thread and exactly
   * wrong across two. A sub-agent that supersedes the root session's listener
   * takes the whole agent offline, so the CLI stops rather than replaces.
   */
  it('says await refuses to supersede a listener owned by another Codex thread', () => {
    const s = section();
    expect(s).toMatch(/another Codex thread|a different Codex thread/i);
    expect(s).toMatch(/refuse/i);
    expect(s).toMatch(/rather than taking it over|instead of taking it over/i);
  });
});

/**
 * SUB-AGENTS DO NOT OWN THE LISTENER (field incident, 2026-09-17). A spawned
 * Codex sub-agent ran `sparrow await` in the parent's directory with the
 * parent's profile. It superseded the root session's listener, and when work
 * arrived Codex would not queue a turn into a sub-agent that was no longer
 * loaded — so the whole agent went deaf while presence stayed green. The
 * playbook has to draw the line before an agent spawns helpers, not after.
 */
describe('Codex SKILL.md — spawned sub-agents and the parent profile', () => {
  const section = (() => {
    const idx = codex.indexOf('## Several agents on one machine');
    expect(idx).toBeGreaterThan(0);
    return codex.slice(idx, codex.indexOf('## What the hooks enforce'));
  })();

  it('says the ROOT thread alone owns this profile listener', () => {
    expect(section).toMatch(/root/i);
    expect(section).toMatch(/sub-?agent/i);
  });

  it('names the three commands a sub-agent must not run for the parent profile', () => {
    expect(section).toMatch(/never[^.]*`sparrow await`/i);
    expect(section).toContain('sparrow pop');
    expect(section).toMatch(/status/i);
  });

  it('leaves `sparrow send` open to a sub-agent', () => {
    expect(section).toMatch(/`sparrow send`/);
  });

  it('gives the reason: Codex cannot queue a turn into an unloaded sub-agent', () => {
    expect(section).toMatch(/queue a turn|queue turns/i);
    expect(section).toMatch(/no longer loaded|not loaded|unloaded/i);
  });

  it('says the CLI now refuses to arm there, rather than leaving it to discipline', () => {
    expect(section).toMatch(/refuses to arm/i);
  });

  it('points an independent agent at its OWN profile and state dir', () => {
    expect(section).toMatch(/own profile/i);
    expect(section).toMatch(/state dir/i);
  });

  it('is Codex-specific: the Claude playbook is untouched by it', () => {
    const claudeSection = claude.slice(
      claude.indexOf('## Several agents on one machine'),
      claude.indexOf('## What the hooks enforce'),
    );
    expect(claudeSection).not.toMatch(/sub-?agent/i);
  });
});
