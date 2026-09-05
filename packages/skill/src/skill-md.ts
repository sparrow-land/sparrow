/**
 * The playbook renderer — ONE document, per-provider fragments.
 *
 * `SKILL.md` is ~80% provider-neutral: the credential ladder, the typed work
 * queue, the no-pipes rhythm, the await→drain→handle→re-arm wake pattern, the
 * email and voice register lessons, status discipline, presence, the pause
 * switch. Only a handful of passages are specific to the harness the agent runs
 * in (which files the installer wired, what the Stop hook can promise, what an
 * interrupt does). Forking the whole document per provider would guarantee the
 * two copies drift apart on exactly the 80% that matters most, so instead
 * `assets/skill/base.md` carries `{{sparrow:<key>}}` placeholders and each
 * provider supplies its own fragment for every key under
 * `assets/skill/<provider>/<key>.md`.
 *
 * Rendering is a pure string substitution over {@link EMBEDDED_ASSETS} — no
 * filesystem, so it works identically from the npx package and from the
 * single-file API-served CLI bundle.
 */
import { EMBEDDED_ASSETS } from './assets-gen.js';

/** The agent harnesses this skill knows how to install into. */
export type Provider = 'claude' | 'codex';

export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];

/** Human name for a provider, used in every message the installer prints. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * The Codex CLI release this adapter was built and live-verified against
 * (hook schema, event names, payload keys, `decision:block` re-arm and
 * `additionalContext` injection all confirmed on it). Codex's hook surface grew
 * 6 → 12 events in ~25 releases, so the tested version is recorded rather than
 * assumed.
 */
export const CODEX_MIN_VERSION = '0.153.3';

/** Every placeholder `base.md` uses. A provider must supply all of them. */
export const FRAGMENT_KEYS: readonly string[] = [
  'intro',
  'turn-based-examples',
  'interrupt-note',
  'reaper-note',
  'session-start-turn-based',
  'auto-status-bullets',
  'several-agents-files',
  'hooks-enforce',
];

const PLACEHOLDER = /\{\{sparrow:([a-z-]+)\}\}/g;

/** The raw template, as shipped. */
export function skillTemplate(): string {
  const base = EMBEDDED_ASSETS['skill/base.md'];
  if (base === undefined) throw new Error('skill/base.md missing from EMBEDDED_ASSETS');
  return base;
}

/**
 * One provider's fragment for `key`. A fragment file always ends in a newline
 * (every text file here does); the trailing newline is the file's, not the
 * document's, so it is stripped — the placeholder already sits on the line the
 * fragment is replacing.
 */
export function fragment(provider: Provider, key: string): string {
  const raw = EMBEDDED_ASSETS[`skill/${provider}/${key}.md`];
  if (raw === undefined) throw new Error(`missing ${provider} fragment: ${key}`);
  return raw.replace(/\n$/, '');
}

/**
 * The playbook for `provider`, ready to write.
 *
 * An unknown placeholder throws rather than rendering `{{sparrow:…}}` into a
 * file an agent will read as instructions — a silently half-rendered playbook is
 * worse than a failed install.
 */
export function renderSkillMd(provider: Provider): string {
  return skillTemplate().replace(PLACEHOLDER, (_m, key: string) => fragment(provider, key));
}
