/**
 * The SKILL.md contract (SPEC v4 → "Unified attention → The medium-spanning work
 * queue" and "MCP server"). An agent that follows this file must:
 *
 * - drain ONE queue whose items are typed, switching on `item.type` and LEAVING
 *   an unrecognized type for a newer client (never erroring);
 * - know the email verbs, gated on `GET /capabilities` reporting `email: true`
 *   (on an instance without the medium the file must not pretend it exists);
 * - carry the register lesson — an email is a document, not a turn.
 *
 * These assertions run against the RENDERED Claude Code playbook — the exact
 * bytes an install writes — which is `assets/skill/base.md` with the
 * `assets/skill/claude/*` fragments substituted in. The Codex playbook renders
 * from the same base and is pinned by `skill-md-codex.test.ts`; everything
 * asserted in both files is, by construction, the provider-neutral core.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_ASSETS } from './assets-gen.js';
import { renderSkillMd } from './skill-md.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillMd = renderSkillMd('claude');

/**
 * The canonical register paragraph lives in `packages/common-types`
 * (`EMAIL_REGISTER_NOTE`) and is reused by the MCP tool descriptions, the
 * onboarding doc, and the `email-is-a-different-register` hint. The skill is a
 * zero-dependency package that ships as a flat asset, so it carries the
 * paragraph VERBATIM rather than importing it — and this test reads the constant
 * straight out of the sibling package's source, so the copy cannot drift.
 */
function constantFromCommonTypes(name: string): string {
  const src = fs.readFileSync(
    path.join(here, '..', '..', 'common-types', 'src', 'constants.ts'),
    'utf8',
  );
  const m = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${name} not found in @sparrow/common-types`);
  return m[1]!;
}

const REGISTER_NOTE = constantFromCommonTypes('EMAIL_REGISTER_NOTE');
/** The voice half of the same rule — one sentence, reused by five surfaces. */
const VOICE_REGISTER_NOTE = constantFromCommonTypes('VOICE_REGISTER_NOTE');

describe('SKILL.md — typed work items', () => {
  it('tells the agent to switch on item.type and leave unknown types alone', () => {
    expect(skillMd).toContain('item.type');
    expect(skillMd).toMatch(/chat\.message/);
    // The forward-compat rule, stated as a rule.
    expect(skillMd.toLowerCase()).toMatch(/unknown|unrecognized/);
    expect(skillMd).toMatch(/leave it|leave them|never an error|not an error/i);
  });

  it('teaches the clawback rule: a clawed-back message was never sent — a no-op', () => {
    expect(skillMd).toContain('message.clawback');
    expect(skillMd).toMatch(/never sent/i);
    expect(skillMd).toMatch(/no-op/i);
    expect(skillMd).toMatch(/do not reply/i);
  });

  it('shows the work-item envelope, not a bare message', () => {
    expect(skillMd).toContain('"item"');
    expect(skillMd).toContain('"type": "chat.message"');
    expect(skillMd).toContain('"type": "email"');
    expect(skillMd).toContain('"item": null');
  });

  /**
   * The field failure (2026-09, Jake): agents drained with
   * `sparrow pop --json | jq -r '.item.message.body'`, which discards the
   * envelope — the ids they need next and anything sparrow was trying to say.
   * The fix is a rhythm, not a pipeline: run plain commands, drain to empty,
   * and read the ONE hint sparrow attaches to the empty pop — the single moment
   * you are between tasks. Hints are pause-only: a pop that hands back WORK
   * never carries one, so you are never interrupted mid-task. The stderr
   * channel that briefly existed is gone; hints are ordinary stdout there.
   */
  it('teaches plain commands: never pipe sparrow output through jq/grep', () => {
    expect(skillMd).toMatch(/`jq`/);
    expect(skillMd).toMatch(/do \*\*not\*\* pipe|never pipe|don't pipe/i);
    // The reason, not just the rule: a filter throws away the ids you need next.
    expect(skillMd).toMatch(/ids/i);
    // `-j` is for programs that consume the envelope whole.
    expect(skillMd).toMatch(/-j\b|--json/);
  });

  it('teaches draining to empty as the end of the drain, not a failure', () => {
    expect(skillMd).toContain('Inbox empty.');
    expect(skillMd).toMatch(/not a failure|is the end of the drain/i);
  });

  it('says the ONE hint arrives at the EMPTY pop, and nowhere else', () => {
    expect(skillMd).toMatch(/\bhints?\b/i);
    expect(skillMd).toContain('[hint]');
    // Anchored to the empty pop — the moment between tasks.
    expect(skillMd).toMatch(/empty pop|`\{ "item": null \}` response|the empty `pop`/i);
    expect(skillMd).toMatch(/nowhere else|only there|exactly there/i);
    // And explicitly NOT on a pop that returns work.
    expect(skillMd).toMatch(/never (carries|carry) a hint|hands back work[^.]*never/i);
    expect(skillMd).toMatch(/between tasks/i);
  });

  it('names `sparrow tips` as the on-demand, cost-free way to see them all', () => {
    expect(skillMd).toContain('sparrow tips');
    expect(skillMd).toMatch(/idle|on demand|right now/i);
  });

  it('no longer claims hints arrive on stderr (that channel was redirected)', () => {
    expect(skillMd).not.toMatch(/stderr/i);
  });
});

describe('SKILL.md — the email medium', () => {
  it('gates every email instruction on GET /capabilities reporting email: true', () => {
    expect(skillMd).toContain('/api/v1/capabilities');
    expect(skillMd).toMatch(/"?email"?:\s*true/);
  });

  it('names the email verbs an agent actually uses', () => {
    for (const route of [
      '/api/v1/me/email/address',
      '/api/v1/me/email/threads',
      '/api/v1/me/email/send',
    ]) {
      expect(skillMd).toContain(route);
    }
    expect(skillMd).toContain('/reply');
    // …and their CLI shortcuts.
    for (const cmd of ['sparrow email threads', 'sparrow email read', 'sparrow email reply']) {
      expect(skillMd).toContain(cmd);
    }
  });

  it('carries the canonical EMAIL_REGISTER_NOTE verbatim (no drift)', () => {
    expect(skillMd).toContain(REGISTER_NOTE);
  });

  it('says a held email is not a failure and must not be retried', () => {
    expect(skillMd).toMatch(/held/);
    expect(skillMd).toMatch(/not a failure/i);
    expect(skillMd).toContain('email.resolved');
  });
});

/**
 * Voice / hands-free. A message carrying `origin: 'voice'` came out of the web
 * client's hands-free mode: the human DICTATED it and is sitting there
 * listening, so whatever the agent writes back is read aloud by a speech voice.
 * The skill must gate the section on `capabilities.voice` (like email), say what
 * the marker MEANS, carry the canonical sentence verbatim, and still insist the
 * reply goes in-room with `inReplyTo` — voice owns no separate reply verb.
 */
describe('SKILL.md — voice / hands-free', () => {
  const section = (() => {
    const idx = skillMd.indexOf('## Voice / hands-free');
    expect(idx).toBeGreaterThan(0);
    return skillMd.slice(idx, skillMd.indexOf('\n## ', idx + 5));
  })();

  it('sits after the email section — both are register lessons, email first', () => {
    expect(skillMd.indexOf('## Voice / hands-free')).toBeGreaterThan(
      skillMd.indexOf('## Email (only when the instance has it)'),
    );
  });

  it('gates the section on capabilities.voice, checked once per session', () => {
    expect(section).toContain('/api/v1/capabilities');
    expect(section).toMatch(/"?voice"?:/);
    expect(section).toMatch(/once per session/i);
  });

  it("says an origin 'voice' item means the human is in hands-free mode and will HEAR you", () => {
    expect(section).toContain("origin");
    expect(section).toContain("'voice'");
    expect(section).toMatch(/hands-free/i);
    expect(section).toMatch(/hear|read (back )?aloud/i);
  });

  it('carries the canonical VOICE_REGISTER_NOTE verbatim (no drift)', () => {
    expect(section).toContain(VOICE_REGISTER_NOTE);
  });

  it('asks for a few sentences, and still an in-room reply with inReplyTo', () => {
    expect(section).toMatch(/few sentences/i);
    expect(section).toContain('inReplyTo');
    expect(section).toMatch(/in-room|in the room/i);
  });

  it('names the dictation flag for an agent that speaks instead of typing', () => {
    expect(section).toContain('sparrow send --origin voice');
  });
});

/**
 * The field failure this section exists to prevent (2026-09): a TURN-BASED agent
 * followed the session-start protocol exactly — `sparrow watch` running, presence
 * green — and sat through seven consecutive DMs. A background listener makes you
 * ONLINE, not ATTENTIVE. The skill must therefore fork by runtime type BEFORE it
 * prescribes a listener, name the trap, and prescribe the portable wake signal
 * (PROCESS EXIT — `sparrow await`, re-armed every turn).
 */
describe('SKILL.md — the come-online fork (online is not attentive)', () => {
  it('forks the session-start protocol by runtime type before prescribing a listener', () => {
    expect(skillMd).toMatch(/always-running/i);
    expect(skillMd).toMatch(/turn-based/i);
    expect(skillMd).toMatch(/you think only when (your harness invokes you|you are invoked)/i);
    // The fork comes before the raw-HTTP listener loop it qualifies.
    const fork = skillMd.search(/always-running/i);
    expect(fork).toBeGreaterThan(0);
    expect(fork).toBeLessThan(skillMd.indexOf('## Inbox etiquette'));
  });

  it('names the trap in the report\'s own words', () => {
    expect(skillMd).toMatch(/a background listener makes you \*\*online\*\*, not \*\*attentive\*\*/i);
    expect(skillMd).toContain(
      '`sparrow watch` alone will NOT cause you to act on messages — you need a wake mechanism',
    );
  });

  it('prescribes await → drain → handle → re-arm, with the exit-code contract', () => {
    expect(skillMd).toMatch(/process exit/i);
    expect(skillMd).toContain('sparrow await');
    expect(skillMd).toMatch(/without consuming it|does not consume/i);
    expect(skillMd).toMatch(/still unread/i);
    expect(skillMd).toMatch(/re-arm/i);
    // Exit 0 = work waiting; exit 2 = timed out, re-arm.
    expect(skillMd).toMatch(/exits? \*\*0\*\*/);
    expect(skillMd).toMatch(/\*\*2\*\*/);
    // The anti-pattern is named, not left to be discovered.
    expect(skillMd).toContain('loop --exec');
    expect(skillMd).toMatch(/cannot re-enter/i);
  });

  it('is honest about the Stop hook: what it now checks, and what it still cannot see', () => {
    const idx = skillMd.indexOf('## What the hooks enforce');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx);
    expect(section).toMatch(/listener (process|is alive|kind)/i);
    // It DOES distinguish a wake-capable listener from a hold-only one now.
    expect(section).toMatch(/wake[- ]capable|can wake you|wake path/i);
    expect(section).toContain('sparrow await');
    expect(section).toMatch(/sparrow watch/);
    expect(section).toMatch(/holds? you online/i);
    // And it is still honest about the limit: a wake path outside the CLI is
    // invisible to it (an empty heartbeat reads as "cannot judge").
    expect(section).toMatch(/cannot (detect|tell|see|judge)/i);
    expect(section).toMatch(/outside the CLI|hand-rolled|third-party/i);
    expect(section).toMatch(/harness/i);
  });

  /**
   * An interrupted Claude Code session kills the process tree, taking the
   * tracked background `sparrow await` with it — the agent's only wake path —
   * while the heartbeat it left behind still reads FRESH. The file has to say
   * that this happens, that the listener now stamps the heartbeat on its way
   * out, and that the two hooks catch it: the Stop hook at the end of a turn,
   * the prompt nudge at the start of the next one.
   */
  it('says an interrupted session kills the background await, and that the hooks catch it', () => {
    const idx = skillMd.indexOf('### The wake pattern');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx, skillMd.indexOf('## Session-start protocol'));
    expect(section).toMatch(/interrupt/i);
    expect(section).toMatch(/kills? your whole process tree|kills the process tree/i);
    expect(section).toMatch(/killed/);
    expect(section).toMatch(/re-arm/i);
  });

  /**
   * Claude Code >= 2.1.193 reaps tracked background shells under OS memory
   * pressure once a session has been idle 30+ minutes with nothing running —
   * which is precisely when a turn-based agent's `sparrow await` is the only
   * thing keeping it reachable. The file must name the reaper, say the
   * installer writes the documented opt-out, say the opt-out only bites on the
   * NEXT Claude Code start, and point at the killed-stamp + prompt-nudge
   * recovery path for the sessions in between.
   */
  it('documents the background-shell reaper and the env opt-out the installer writes', () => {
    const idx = skillMd.indexOf('### The wake pattern');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx, skillMd.indexOf('## Session-start protocol'));
    expect(section).toContain('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP');
    expect(section).toMatch(/memory pressure/i);
    expect(section).toMatch(/idle for at least 30 minutes|30\+? ?minutes|30 minutes/i);
    expect(section).toMatch(/install(er|s)? (sets|writes)/i);
    expect(section).toMatch(/next (Claude Code )?start|next start/i);
    // Until the opt-out is live, the existing recovery path is what saves you.
    expect(section).toMatch(/killed/);
    expect(section).toMatch(/re-arm/i);
  });

  it('the hooks section says the installer also writes the reaper opt-out', () => {
    const idx = skillMd.indexOf('## What the hooks enforce');
    expect(idx).toBeGreaterThan(0);
    const intro = skillMd.slice(idx, skillMd.indexOf('- **Stop**', idx));
    expect(intro).toContain('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP');
  });

  it('the Stop-hook bullet names the killed/stopped stamps and that they beat freshness', () => {
    const idx = skillMd.indexOf('## What the hooks enforce');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx);
    expect(section).toMatch(/killed:SIGTERM|`killed`/);
    expect(section).toMatch(/stopped/);
    expect(section).toMatch(/whatever its age|beats the freshness|regardless of (its )?age/i);
  });

  it('the UserPromptSubmit bullet documents the re-arm nudge it prints', () => {
    const idx = skillMd.indexOf('## What the hooks enforce');
    const section = skillMd.slice(idx);
    const bullet = section.slice(section.indexOf('- **UserPromptSubmit**'));
    const line = bullet.slice(0, bullet.indexOf('\n-'));
    expect(line).toMatch(/stdout is injected|injected into your context/i);
    expect(line).toContain('sparrow await --timeout 900');
    expect(line).toMatch(/absent, stale|stale/i);
    expect(line).toMatch(/killed/);
    // And that a healthy listener means silence.
    expect(line).toMatch(/nothing is printed|prints nothing/i);
  });

  it('warns that a presence heartbeat without a wake path is the WORST state', () => {
    const idx = skillMd.indexOf('## Presence for turn-based agents');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx, idx + 2000);
    expect(section).toMatch(/worst/i);
    expect(section).toContain('sparrow await');
  });
});

/**
 * The auto-status docs must be precise about WHEN `blocked — needs your input`
 * is set: registering our Notification hook for every notification type made
 * `idle_prompt` (fired ~60s after a turn ends) latch a sticky "blocked" onto
 * agents doing nothing at all. The file has to say which prompts mean blocked,
 * and that an idle prompt means idle.
 */
describe('SKILL.md — auto-status notification semantics', () => {
  const hooksSection = () => {
    const idx = skillMd.indexOf('## What the hooks enforce');
    expect(idx).toBeGreaterThan(0);
    return skillMd.slice(idx);
  };

  it('names the notification types that mean blocked', () => {
    const section = hooksSection();
    for (const type of [
      'permission_prompt',
      'elicitation_dialog',
      'elicitation_url_dialog',
      'agent_needs_input',
    ]) {
      expect(section).toContain(type);
    }
    expect(section).toContain('blocked — needs your input');
  });

  it('says an idle prompt sets idle, not blocked, and that other types are ignored', () => {
    const section = hooksSection();
    expect(section).toContain('idle_prompt');
    expect(section).toMatch(/idle_prompt[^\n]*idle/);
    expect(section).toMatch(/any other type is ignored/i);
  });

  it('the Auto-status bullets distinguish a blocking prompt from an idle prompt', () => {
    const idx = skillMd.indexOf('### Auto-status');
    expect(idx).toBeGreaterThan(0);
    const section = skillMd.slice(idx, skillMd.indexOf('## Presence for turn-based agents'));
    expect(section).toMatch(/permission prompt/i);
    expect(section).toMatch(/elicitation/i);
    expect(section).toMatch(/idle prompt/i);
    // The idle prompt must not be described as blocking.
    expect(section).toMatch(/idle prompt[^.]*\*\*idle\*\*/);
  });
});

/**
 * The embedded map is what a single-file bundle (the API-served `sparrow.js`
 * CLI) installs from, and it is now also what {@link renderSkillMd} reads — so a
 * fragment edited on disk without `pnpm gen-assets` would ship the OLD playbook
 * while every assertion above still read the new one. This sweep is the guard.
 */
describe('SKILL.md — the embedded copy', () => {
  const assetsRoot = path.join(here, '..', 'assets');
  const walk = (dir: string, prefix = ''): string[] =>
    fs.readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      return fs.statSync(full).isDirectory() ? walk(full, rel) : [rel];
    });

  it('matches every shipped asset byte for byte (run `pnpm gen-assets`)', () => {
    const shipped = walk(assetsRoot).sort();
    expect(Object.keys(EMBEDDED_ASSETS).sort()).toEqual(shipped);
    for (const rel of shipped) {
      expect(EMBEDDED_ASSETS[rel]).toBe(
        fs.readFileSync(path.join(assetsRoot, ...rel.split('/')), 'utf8'),
      );
    }
  });

  it('ships exactly the hook scripts the two adapters install', () => {
    const shipped = fs
      .readdirSync(path.join(assetsRoot, 'hooks'))
      .filter((f) => f.endsWith('.sh'))
      .sort();
    // The two shared hooks (the loop-check and the auto-status hook that
    // absorbed the standalone presence heartbeat), plus Codex's two: the
    // SessionStart injector and the wrapper that stamps "this hook really fired".
    expect(shipped).toEqual([
      'sparrow-auto-status.sh',
      'sparrow-codex-hook.sh',
      'sparrow-session-start.sh',
      'sparrow-stop-check.sh',
    ]);
  });

  it('gives both providers a fragment for every placeholder in the base', () => {
    const base = EMBEDDED_ASSETS['skill/base.md']!;
    const used = [...base.matchAll(/\{\{sparrow:([a-z-]+)\}\}/g)].map((m) => m[1]!);
    expect(new Set(used).size).toBe(used.length); // no placeholder used twice
    for (const provider of ['claude', 'codex']) {
      for (const key of used) {
        expect(EMBEDDED_ASSETS[`skill/${provider}/${key}.md`]).toBeTypeOf('string');
      }
      // …and no orphan fragments left behind by a removed placeholder.
      const owned = Object.keys(EMBEDDED_ASSETS)
        .filter((k) => k.startsWith(`skill/${provider}/`))
        .map((k) => k.slice(`skill/${provider}/`.length, -'.md'.length));
      expect(owned.sort()).toEqual([...used].sort());
    }
  });

  it('does not embed a retired hook (installs prune what the bundle no longer ships)', () => {
    expect(EMBEDDED_ASSETS['hooks/sparrow-presence.sh']).toBeUndefined();
  });
});

/**
 * One machine, one unix user, several agents. The invite doc (apps/api's
 * MULTI_AGENT_SECTION) makes the same five promises to a freshly-enrolled
 * agent; the skill an agent actually reads every session must not be the place
 * those promises go missing.
 */
describe('SKILL.md — several agents on one machine', () => {
  const section = (() => {
    const idx = skillMd.indexOf('## Several agents on one machine');
    expect(idx).toBeGreaterThan(0);
    return skillMd.slice(idx, skillMd.indexOf('## What the hooks enforce'));
  })();

  it('teaches per-workspace profiles and that --profile never steals the default', () => {
    expect(section).toContain('--profile');
    expect(section).toContain('SPARROW_PROFILE');
    expect(section).toContain('--set-default');
    expect(section).toMatch(/never\*{0,2}\s*move[s]? `?defaultProfile/i);
  });

  it('teaches the per-project state dir and the stamped SPARROW_STATE_DIR', () => {
    expect(section).toContain('<project>/.sparrow/');
    expect(section).toContain('SPARROW_STATE_DIR');
  });

  it('teaches settings.local.json by default, --shared for the committed file', () => {
    expect(section).toContain('.claude/settings.local.json');
    expect(section).toContain('--shared');
    expect(section).toContain('.claude/settings.json');
  });

  it('names the git exclude the installer writes', () => {
    expect(section).toContain('.git/info/exclude');
    expect(section).toContain('.claude/skills/sparrow/');
  });

  it('forbids `pkill -f sparrow` (it kills the neighbours, same unix user)', () => {
    expect(section).toMatch(/pkill -f sparrow/);
    expect(section).toMatch(/same unix user/i);
  });
});

/**
 * The loop switch is no longer unconditionally `~/.sparrow/loop-state`: a
 * project-scope install puts it in `<project>/.sparrow`. Any sentence still
 * claiming the single home path would send an agent to another agent's switch.
 */
describe('SKILL.md — where the loop switch lives', () => {
  it('never states `~/.sparrow/loop-state` as the only location', () => {
    for (const line of skillMd.split('\n')) {
      if (!line.includes('~/.sparrow/loop-state')) continue;
      expect(line).toMatch(/user-scope|project/i);
    }
  });

  it('names the project-scoped switch', () => {
    expect(skillMd).toMatch(/`\.sparrow\/loop-state`|<project>\/\.sparrow/);
  });
});

/** The credential ladder the hooks and CLI both implement. */
describe('SKILL.md — credential resolution', () => {
  it('documents SPARROW_PROFILE ahead of defaultProfile', () => {
    const idx = skillMd.indexOf('## Credentials');
    const section = skillMd.slice(idx, skillMd.indexOf('## First:'));
    expect(section).toContain('SPARROW_PROFILE');
    expect(section.indexOf('SPARROW_PROFILE')).toBeLessThan(section.indexOf('defaultProfile'));
  });
});

/**
 * Canonical public homes (SPEC → *Canonical public homes*): the installer and
 * the docs have ONE home each, independent of which instance the agent talks
 * to. An instance serves neither (it `302`s), so a `<your-server>/docs/...`
 * example in this file teaches every reader a URL that only redirects — and
 * `curl <your host>/install.sh` teaches every reader a different command.
 */
describe('SKILL.md — canonical install + docs homes', () => {
  it('gives the canonical one-line installer for the CLI', () => {
    expect(skillMd).toContain('curl -fsSL https://sparrow.land/install.sh | sh');
  });

  it('never points docs or the installer at the instance', () => {
    for (const line of skillMd.split('\n')) {
      expect(line).not.toMatch(/<your-server>\/docs/);
      expect(line).not.toMatch(/\$SPARROW_SERVER\/docs/);
      expect(line).not.toMatch(/(<your-server>|\$SPARROW_SERVER)\/install/);
    }
  });

  it('shows docs links under the canonical docs home', () => {
    expect(skillMd).toContain('https://sparrow.land/docs/');
  });

  /**
   * API paths stay RELATIVE — they are the instance's, and the agent already
   * has `$SPARROW_SERVER`.
   */
  it('keeps API examples server-relative', () => {
    expect(skillMd).toContain('/api/v1/');
    expect(skillMd).toContain('"$SPARROW_SERVER/api/v1/capabilities"');
  });
});
