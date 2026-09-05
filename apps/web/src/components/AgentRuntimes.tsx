import type { ReactNode } from 'react';

/**
 * The runtimes an agent can be, said ONCE for every invite surface.
 *
 * Two surfaces offer the same choice — the {@link InviteDialog} inside the app
 * and the `/invite/:token` landing page — and they had already drifted (two
 * copies of the harness list, one of them shaped differently) while sharing only
 * `RUNTIME_HINT`. Everything either surface needs to say about a runtime lives
 * here now, so a fact added on one is a fact on both.
 *
 * There are two lists because the two loop modes really do differ:
 *  - HARNESS: sparrow's CLI spawns the runner, so anything it can exec belongs
 *    (Claude Code, Codex, Gemini, or your own command).
 *  - INLINE: the agent holds its own loop and the sparrow SKILL is what keeps it
 *    honest — so the list is exactly the providers the skill installs for.
 */

/** Which runner the harness spawns; only changes one flag on the command. */
export type Runtime = 'claude' | 'codex' | 'gemini' | 'other';

/** `claude -p` is the harness default, so Claude Code carries no flag at all. */
export const RUNTIMES: { id: Runtime; label: string; flag: string }[] = [
  { id: 'claude', label: 'Claude Code', flag: '' },
  { id: 'codex', label: 'Codex', flag: '--codex' },
  { id: 'gemini', label: 'Gemini', flag: '--gemini' },
  { id: 'other', label: 'Other', flag: "--exec '<your command>'" },
];

/**
 * The ONE option worth naming under each runtime's harness command, before the
 * shared `--cwd`. Per-runtime because the flags are: `--model sonnet` is a
 * Claude alias and means nothing to Codex, whose own decision at this point is
 * how much of the working tree its runs may write.
 */
export const RUNTIME_HINT: Record<Runtime, { flag: string; what: string } | null> = {
  claude: { flag: '--model sonnet', what: 'picks a model' },
  // The harness pins codex to workspace-write; this narrows it.
  codex: { flag: '--sandbox read-only', what: 'narrows what it may write' },
  gemini: { flag: '--model <name>', what: 'picks a model' },
  other: null,
};

/**
 * The providers the sparrow SKILL installs for — the inline list. Gemini and a
 * bare `--exec` command are absent on purpose: there is no skill adapter for
 * them, and offering one here would promise hooks that do not exist.
 */
export type InlineRuntime = 'claude' | 'codex';

export const INLINE_RUNTIMES: { id: InlineRuntime; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

/** A path or flag rendered inline in prose, in the terminal's own voice. */
function C({ children }: { children: ReactNode }) {
  return <code className="mono text-[var(--sparrow-text)]">{children}</code>;
}

/**
 * What an inline agent on CODEX has to do after it enrols — the same four steps
 * on every surface that offers the Codex inline path.
 *
 * Steps 2 and 3 are the whole reason this component exists. Live-verified
 * against codex-cli 0.153.3: a project's `.codex/` files are SILENTLY ignored
 * until the project is trusted, and hooks need per-hook trust on top of that.
 * The installer can do neither, and neither failure prints anything — so a
 * green "installed" would be a lie. `sparrow skill verify --codex` is the only
 * honest proof, because it takes one real Codex turn and watches a hook fire.
 */
export function CodexInlineSteps({ className = '' }: { className?: string }) {
  return (
    <div className={className}>
      <ol className="ml-4 list-decimal space-y-1.5">
        <li>
          Once it has enrolled, run <C>sparrow skill install --codex</C> in the project. That writes{' '}
          <C>.agents/skills/sparrow/SKILL.md</C> (invoke it in a session with <C>$sparrow</C>), a
          short sparrow section appended to the project&rsquo;s <C>AGENTS.md</C>,{' '}
          <C>.codex/hooks.json</C> (Stop, SessionStart, UserPromptSubmit, PostToolUse) and{' '}
          <C>.codex/config.toml</C>.
        </li>
        <li>
          <strong className="font-semibold text-[var(--sparrow-text)]">Trust the project.</strong>{' '}
          Answer &ldquo;trust this folder&rdquo; the first time you open <C>codex</C> there, or add{' '}
          <C>{'[projects."<absolute project path>"]'}</C> with <C>{'trust_level = "trusted"'}</C> to{' '}
          <C>~/.codex/config.toml</C>.
        </li>
        <li>
          <strong className="font-semibold text-[var(--sparrow-text)]">Trust the hooks.</strong> Run{' '}
          <C>/hooks</C> in the Codex TUI and enable the sparrow hooks; headless <C>codex exec</C>{' '}
          takes <C>--dangerously-bypass-hook-trust</C>.
        </li>
        <li>
          Run <C>sparrow skill verify --codex</C>. Until both of those are done Codex silently
          ignores the project&rsquo;s <C>.codex/</C> files: the hooks never fire, with no error
          message. Verify takes one real Codex turn and proves they fire, instead of checking that
          the files exist.
        </li>
      </ol>
      <p className="mt-2">
        Tested against codex-cli 0.153.3. Codex has no Notification event, so it never reports
        &ldquo;blocked — needs your input&rdquo;; working/idle status and the presence heartbeat
        both work.
      </p>
    </div>
  );
}
