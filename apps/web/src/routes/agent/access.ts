import { ApiError } from '@sparrow-land/sdk';
import type { AgentMessagingPolicy, Grant } from '@sparrow-land/sdk/types';

/**
 * Pure helpers for the agent page's Access and Analytics tabs: who has
 * authority over an agent (render gating only — the server is the authority),
 * the messaging reachability preview, tag input, and plain wording for the
 * `403` refusal reasons of the agent-visibility contract.
 */

/** `412` → `412`, `8200` → `8.2k`, `96400` → `96k`, `2.3e6` → `2.3M`. */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  // Round first, so 999,500+ rolls over to `1M` instead of reading `1000k`.
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Does a grant `scope` cover an agent carrying `tags`? */
export function grantCoversAgent(scope: string, tags: readonly string[]): boolean {
  if (scope === 'tags:*') return true;
  if (scope.startsWith('tag:')) return tags.includes(scope.slice(4));
  return false;
}

/**
 * The viewer may manage this agent's tags and messaging, and read its analytics:
 * its owner, an org owner/admin, or a holder of a grant covering one of its tags.
 */
export function hasAuthority(input: {
  isOwner: boolean;
  isAdmin: boolean;
  meId: string | undefined;
  agentTags: readonly string[];
  grants: readonly Grant[];
}): boolean {
  if (input.isOwner || input.isAdmin) return true;
  if (!input.meId) return false;
  return input.grants.some(
    (g) => g.principalId === input.meId && grantCoversAgent(g.scope, input.agentTags),
  );
}

export interface PolicyAgent {
  id: string;
  name: string;
  tags: readonly string[];
  messaging: AgentMessagingPolicy;
}

function allows(from: PolicyAgent, to: PolicyAgent): boolean {
  if (from.messaging === 'none') return false;
  if (from.messaging === 'tags') return from.tags.some((t) => to.tags.includes(t));
  return true;
}

/**
 * Which of `others` the agent could DM under its policy, and which it could not.
 * A DM needs BOTH agents' policies to allow it, so a peer's own setting counts.
 * `any` means "any agent it has met" — the preview cannot know who it has met,
 * so it reports everyone the policies alone allow. Names, sorted; never itself.
 */
export function reachability(
  self: PolicyAgent,
  others: readonly PolicyAgent[],
): { reachable: string[]; blocked: string[] } {
  const reachable: string[] = [];
  const blocked: string[] = [];
  for (const o of others) {
    if (o.id === self.id) continue;
    (allows(self, o) && allows(o, self) ? reachable : blocked).push(o.name);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return { reachable: reachable.sort(byName), blocked: blocked.sort(byName) };
}

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Typed text → a tag slug (`#Cubes` → `cubes`, spaces → `-`), or null if invalid. */
export function normalizeTag(input: string): string | null {
  const s = input.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
  return TAG_RE.test(s) ? s : null;
}

/**
 * Tags already used in the org (`orgTagSets`: one array per agent), minus the
 * ones this agent carries, filtered by `query`: prefix matches first, then
 * substring matches, each alphabetical.
 */
export function tagSuggestions(
  orgTagSets: readonly (readonly string[])[],
  current: readonly string[],
  query: string,
): string[] {
  const q = query.trim().replace(/^#+/, '').toLowerCase();
  const all = [...new Set(orgTagSets.flat())].filter((t) => !current.includes(t)).sort();
  if (!q) return all;
  const prefix = all.filter((t) => t.startsWith(q));
  const inner = all.filter((t) => !t.startsWith(q) && t.includes(q));
  return [...prefix, ...inner];
}

/** `a, b, c` — or `a, b and 2 more` past `cap`. */
export function namesList(names: readonly string[], cap = 8): string {
  if (names.length <= cap) return names.join(', ');
  return `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`;
}

/**
 * Plain wording for a refusal. The agent-visibility `403`s carry a `reason`;
 * `messaging_policy` keeps the server's message, which names whose setting
 * blocks the DM. Anything else falls back to the server's message, then to
 * `fallback`.
 */
export function forbiddenMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.reason) {
    case 'self':
      return 'Nobody can change their own tags, messaging or grants.';
    case 'outranked':
      return 'This agent holds access you don’t have, so you can’t change it.';
    case 'grant_required':
      return 'You don’t have access to change this. Ask an org admin for a grant.';
    case 'messaging_policy':
      return err.message || 'A messaging setting blocks this conversation.';
    default:
      return err.message || fallback;
  }
}
