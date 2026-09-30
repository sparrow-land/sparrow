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

/** Singular/plural count wording: `1 message`, `2 messages`, `12,345 messages`. */
export function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : many}`;
}

/** The grant scopes `principalId` holds. */
export function scopesOf(principalId: string | undefined, grants: readonly Grant[]): string[] {
  if (!principalId) return [];
  return grants.filter((g) => g.principalId === principalId).map((g) => g.scope);
}

/** Whether `held` covers `scope`: exactly, or `tags:*` covering any `tag:<slug>`. */
export function coversScope(held: readonly string[], scope: string): boolean {
  return held.includes(scope) || (scope.startsWith('tag:') && held.includes('tags:*'));
}

/** `target` holds a grant `actor` does not also hold (the `outranked` guard rail). */
function outranks(targetScopes: readonly string[], actorScopes: readonly string[]): boolean {
  return targetScopes.some((s) => !coversScope(actorScopes, s));
}

export interface AuthorityInput {
  isOwner: boolean;
  isAdmin: boolean;
  meId: string | undefined;
  agentId: string;
  agentTags: readonly string[];
  grants: readonly Grant[];
}

/** What the viewer may do to one agent — mirrors the server's rules (render gating only). */
export interface Authority {
  /** Owner or org owner/admin: every tag, exempt from `outranked`. */
  implicit: boolean;
  /** The agent holds a grant the viewer does not (irrelevant when `implicit`). */
  outranked: boolean;
  /** May change messaging and tags, and see Access + Analytics. */
  manage: boolean;
  /** May add/remove any tag. */
  anyTag: boolean;
  /** When `!anyTag`: the only tags the viewer may add or remove. */
  tags: string[];
  canEditTag(tag: string): boolean;
}

/**
 * The viewer's authority over an agent (SPEC.md, *Agent visibility → Authority*):
 * the owner and org owners/admins over everything; otherwise a `tags:*` holder,
 * or a `tag:y` holder where the agent CURRENTLY carries `y` — never over
 * yourself, and never over an agent holding a grant the viewer does not
 * ("outranked"). Adding or removing a tag also needs authority over THAT tag.
 */
export function authorityOver(input: AuthorityInput): Authority {
  const none: Authority = {
    implicit: false,
    outranked: false,
    manage: false,
    anyTag: false,
    tags: [],
    canEditTag: () => false,
  };
  if (input.meId && input.meId === input.agentId) return none;
  if (input.isOwner || input.isAdmin) {
    return { implicit: true, outranked: false, manage: true, anyTag: true, tags: [], canEditTag: () => true };
  }
  const mine = scopesOf(input.meId, input.grants);
  const outranked = outranks(scopesOf(input.agentId, input.grants), mine);
  const anyTag = mine.includes('tags:*');
  const tags = mine.filter((s) => s.startsWith('tag:')).map((s) => s.slice(4));
  const covering = anyTag || input.agentTags.some((t) => tags.includes(t));
  if (!covering || outranked) return { ...none, outranked };
  return {
    implicit: false,
    outranked: false,
    manage: true,
    anyTag,
    tags: anyTag ? [] : [...tags].sort(),
    canEditTag: (t) => anyTag || tags.includes(t),
  };
}

/** The viewer may manage this agent's tags and messaging, and read its analytics. */
export function hasAuthority(input: AuthorityInput): boolean {
  return authorityOver(input).manage;
}

/** Which scopes the viewer may grant: admins any, `tags:*` holders only `tag:<slug>`. */
export function grantableScopes(input: {
  isAdmin: boolean;
  meId: string | undefined;
  grants: readonly Grant[];
}): 'any' | 'tag' | 'none' {
  if (input.isAdmin) return 'any';
  return scopesOf(input.meId, input.grants).includes('tags:*') ? 'tag' : 'none';
}

/**
 * Whether the viewer may grant to `principalId`: never themselves; a non-admin
 * never to a principal that outranks them.
 */
export function canGrantTo(input: {
  isAdmin: boolean;
  meId: string | undefined;
  grants: readonly Grant[];
  principalId: string;
}): boolean {
  if (!input.meId || input.principalId === input.meId) return false;
  const can = grantableScopes(input);
  if (can === 'none') return false;
  if (can === 'any') return true;
  return !outranks(scopesOf(input.principalId, input.grants), scopesOf(input.meId, input.grants));
}

/**
 * Whether the viewer may revoke `grant`: org owners/admins; its holder (giving
 * it up); or its creator, unless the holder now outranks them.
 */
export function canRevokeGrant(input: {
  grant: Grant;
  isAdmin: boolean;
  meId: string | undefined;
  grants: readonly Grant[];
}): boolean {
  const { grant, meId } = input;
  if (input.isAdmin) return true;
  if (!meId) return false;
  if (grant.principalId === meId) return true;
  if (grant.grantedBy !== meId) return false;
  return !outranks(scopesOf(grant.principalId, input.grants), scopesOf(meId, input.grants));
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
