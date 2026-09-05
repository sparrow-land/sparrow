/**
 * The provider seam.
 *
 * Everything a Sparrow inline install needs to answer is provider-neutral —
 * which credentials, which state dir, which loop switch, which playbook, which
 * rhythm. Only FOUR questions have per-harness answers:
 *
 *   1. where does the playbook go, and how is it invoked?
 *   2. where do hook registrations live, and in what shape?
 *   3. what do those hooks receive, and what may they print back?
 *   4. what else has to be true before any of it runs?
 *
 * A {@link ProviderAdapter} answers exactly those four and nothing else; the
 * neutral core in `install.ts` owns the rest (argv, scope, profile stamping,
 * state seeding, git excludes, the shared shell scripts, the rendered playbook).
 * Adding a third harness means adding one adapter, not another switch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_LABEL, type Provider } from './skill-md.js';

export type { Provider };
export { PROVIDER_LABEL };

/** Where the skill installs — the project, or the user's home. */
export type Scope = 'project' | 'user';

export type Env = Record<string, string | undefined>;

/** Everything a resolved `sparrow skill …` invocation acts on. */
export interface Resolved {
  provider: Provider;
  scope: Scope;
  cwd: string;
  home: string;
  env: Env;
  log: (msg: string) => void;
  stateDir: string;
  /** Project scope, Claude only: write the COMMITTED `.claude/settings.json`. */
  shared?: boolean;
  /** Profile stamped into project-scope hook commands (`undefined` = none known). */
  profile?: string;
}

/** One line of a `status` / `verify` report, with a verdict we can total up. */
export interface CheckLine {
  /** `ok` = observed true. `warn` = true-as-far-as-we-can-see. `fail` = not true. */
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface ProviderAdapter {
  readonly id: Provider;
  readonly label: string;
  /** The directory holding `SKILL.md` and `hooks/` for this scope. */
  skillDir(r: Resolved): string;
  /** Shell scripts this provider installs into `<skillDir>/hooks`. */
  readonly scripts: readonly string[];
  /**
   * Register the hooks / settings / instructions files. Called AFTER the
   * playbook and scripts are on disk, so it may reference their absolute paths.
   */
  wire(r: Resolved): void;
  /** Undo {@link wire} — preserving every foreign hook and setting. */
  unwire(r: Resolved): void;
  /** Extra `.git/info/exclude` entries for a project-scope install. */
  gitExcludes(r: Resolved): string[];
  /** Provider-specific lines for `sparrow skill status`. */
  statusLines(r: Resolved): CheckLine[];
  /** Provider-specific checks for `sparrow skill verify`. */
  verifyLines(r: Resolved): CheckLine[];
  /** Printed after a successful install (manual steps the installer cannot do). */
  postInstallNotes(r: Resolved): string[];
  /** Filesystem markers that mean "this provider's skill is installed here". */
  installMarkers(dir: string): string[];
}

/* ------------------------------- detection -------------------------------- */

export interface Detection {
  provider?: Provider;
  /** Why — printed when we had to guess, and when we refuse to. */
  reason: string;
}

const exists = (p: string): boolean => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Which harness this directory belongs to, when the human did not say.
 *
 * An EXISTING sparrow install wins outright: a re-install is an upgrade, and
 * silently switching a working project to the other harness because it happens
 * to carry both a `CLAUDE.md` and an `AGENTS.md` would be the worst possible
 * guess. Failing that, exactly one harness's fingerprint decides. Two
 * fingerprints and no install is genuinely ambiguous — plenty of repos carry
 * both files — so we refuse and ask for the flag rather than pick. Nothing at
 * all falls back to Claude Code, which is what every `sparrow skill install`
 * before this change did.
 */
export function detectProvider(cwd: string): Detection {
  const installed = (Object.keys(ADAPTERS) as Provider[]).filter((p) =>
    ADAPTERS[p].installMarkers(cwd).some(exists),
  );
  if (installed.length === 1) {
    return { provider: installed[0], reason: `existing ${PROVIDER_LABEL[installed[0]!]} install` };
  }

  const claude = exists(path.join(cwd, '.claude')) || exists(path.join(cwd, 'CLAUDE.md'));
  const codex = exists(path.join(cwd, '.codex')) || exists(path.join(cwd, 'AGENTS.md'));
  if (claude && !codex) return { provider: 'claude', reason: 'found .claude/ or CLAUDE.md' };
  if (codex && !claude) return { provider: 'codex', reason: 'found .codex/ or AGENTS.md' };
  if (claude && codex) {
    return {
      reason:
        'this project looks like BOTH (.claude/ or CLAUDE.md and .codex/ or AGENTS.md are present) — ' +
        're-run with --claude or --codex to say which harness to install for',
    };
  }
  return { provider: 'claude', reason: 'no harness fingerprint here — defaulting to Claude Code' };
}

/* -------------------------------- registry -------------------------------- */

import { CLAUDE_ADAPTER } from './provider-claude.js';
import { CODEX_ADAPTER } from './provider-codex.js';

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  claude: CLAUDE_ADAPTER,
  codex: CODEX_ADAPTER,
};

export function adapterFor(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
