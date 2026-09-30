/**
 * Agent visibility AUTHORITY (SPEC "Agent visibility → Authority"): who may
 * change an agent's tags and messaging policy, who may create and delete
 * delegated grants, and who may read an agent's analytics.
 *
 * Pure decisions over plain facts, so the whole rule set is one truth table
 * (`visibility-authority.test.ts`); the routes load the facts from the database
 * (`visibility.ts`) and turn a refusal into a `403` with its `reason`.
 *
 * The rules:
 *  - IMPLICIT authority: the agent's owner and the org's owners/admins may change
 *    any tag and the messaging policy of the agent. They are exempt from the
 *    `outranked` guard (humans with full authority over it).
 *  - DELEGATED grants: `tag:<slug>` (that tag, and the policy of agents carrying
 *    it) and `tags:*` (every tag on every agent, plus granting `tag:<slug>` to
 *    others). A `tag:<slug>` holder has standing only over agents that ALREADY
 *    carry a tag it holds: it manages them, it never recruits new agents into
 *    its tag.
 *  - Guard rails: nobody acts on themselves (`self`) — except to give up a grant
 *    they hold; a grant holder never acts on
 *    a principal holding a grant it does not also hold (`outranked`; `tags:*`
 *    counts as holding every `tag:<slug>`); nobody grants a scope they do not hold,
 *    and only org owners/admins grant `tags:*` (`grant_required`); an agent whose
 *    own messaging policy is not `any` never adds a tag it carries to another
 *    agent, since that would widen its own DM reach (`self`). Reads of an
 *    agent's analytics pass the same `outranked` guard as writes.
 */
import type { AgentMessagingPolicy, ForbiddenReason, PrincipalKind } from '@sparrow-land/sdk/types';

/** Everything the rules need to know about the caller. */
export interface ActorFacts {
  kind: PrincipalKind;
  id: string;
  /** An org owner/admin (always a human). */
  orgAdmin: boolean;
  /** The grant scopes the actor holds in the org. */
  scopes: readonly string[];
  /** For an agent actor: its own current tags (humans carry none). */
  tags?: readonly string[];
  /** For an agent actor: its own messaging policy (default `any`). */
  messaging?: AgentMessagingPolicy;
}

/** Everything the rules need to know about the principal being acted on. */
export interface TargetFacts {
  kind: PrincipalKind;
  id: string;
  /** For an agent: its owning human. */
  ownerHumanId?: string;
  /** For an agent: its current tags. */
  tags: readonly string[];
  /** The grant scopes the target holds in the org. */
  scopes: readonly string[];
}

export type AuthorityReason = Exclude<ForbiddenReason, 'messaging_policy'>;

export type Verdict = { ok: true } | { ok: false; reason: AuthorityReason; message: string };

const OK: Verdict = { ok: true };
const refuse = (reason: AuthorityReason, message: string): Verdict => ({ ok: false, reason, message });

export const ALL_TAGS_SCOPE = 'tags:*';
export const tagScope = (tag: string): string => `tag:${tag}`;

/** Whether `held` covers `scope`: exactly, or `tags:*` covering a `tag:<slug>`. */
export function covers(held: readonly string[], scope: string): boolean {
  return held.includes(scope) || (scope.startsWith('tag:') && held.includes(ALL_TAGS_SCOPE));
}

/** Whether the actor may edit tag `tag` on some agent. */
function coversTag(held: readonly string[], tag: string): boolean {
  return covers(held, tagScope(tag));
}

/** Implicit authority over an agent: an org owner/admin, or the agent's owner. */
function implicitOver(actor: ActorFacts, target: TargetFacts): boolean {
  return (
    actor.kind === 'human' &&
    (actor.orgAdmin || (target.kind === 'agent' && target.ownerHumanId === actor.id))
  );
}

const SELF_MESSAGE = 'You cannot change your own tags, messaging policy or grants';

/**
 * The shared prefix of every delegated decision: `self`, then "holds no grant at
 * all", then `outranked`. Returns a refusal, or null to continue.
 */
function delegatedGuard(actor: ActorFacts, target: TargetFacts, noGrantMessage: string): Verdict | null {
  if (actor.scopes.length === 0) return refuse('grant_required', noGrantMessage);
  const lacking = target.scopes.filter((s) => !covers(actor.scopes, s));
  if (lacking.length > 0) {
    return refuse(
      'outranked',
      `You cannot act on this ${target.kind}: it holds ${lacking.map((s) => `\`${s}\``).join(', ')}, which you do not`,
    );
  }
  return null;
}

/**
 * Standing over an agent for a delegated actor: `tags:*` (org-wide), or a
 * `tag:x` grant for some `x` the agent carries NOW.
 */
function standingOver(actor: ActorFacts, target: TargetFacts): boolean {
  return actor.scopes.includes(ALL_TAGS_SCOPE) || target.tags.some((t) => coversTag(actor.scopes, t));
}

/**
 * Replace an agent's tag set. The actor needs standing over the agent AS IT IS
 * before the change (so a `tag:x` holder cannot recruit an agent into `x` and
 * thereby gain authority over it), and every ADDED or REMOVED tag must be within
 * its authority; unchanged tags need none. An agent actor whose own policy is
 * not `any` may not add a tag it carries: that would widen its own DM reach.
 */
export function decideTags(
  actor: ActorFacts,
  target: TargetFacts,
  added: readonly string[],
  removed: readonly string[],
): Verdict {
  if (actor.id === target.id) return refuse('self', SELF_MESSAGE);
  if (implicitOver(actor, target)) return OK;
  const noGrant =
    'Changing this agent’s tags needs its owner, an org admin, `tags:*`, or a grant for one of the tags it already carries';
  const guard = delegatedGuard(actor, target, noGrant);
  if (guard) return guard;
  if (!standingOver(actor, target)) return refuse('grant_required', noGrant);
  const outside = [...added, ...removed].filter((t) => !coversTag(actor.scopes, t));
  if (outside.length > 0) {
    return refuse(
      'grant_required',
      `You hold no grant for ${outside.map((t) => `\`tag:${t}\``).join(', ')}`,
    );
  }
  if (actor.kind === 'agent' && (actor.messaging ?? 'any') !== 'any') {
    const own = added.filter((t) => (actor.tags ?? []).includes(t));
    if (own.length > 0) {
      return refuse(
        'self',
        `Your messaging setting is \`${actor.messaging}\`: adding a tag you carry (${own
          .map((t) => `\`${t}\``)
          .join(', ')}) to another agent would widen your own reach`,
      );
    }
  }
  return OK;
}

/** Change an agent's messaging policy: implicit authority, `tags:*`, or `tag:x` for a tag it carries. */
export function decideMessaging(actor: ActorFacts, target: TargetFacts): Verdict {
  if (actor.id === target.id) return refuse('self', SELF_MESSAGE);
  if (implicitOver(actor, target)) return OK;
  const noGrant = 'Changing this agent’s messaging needs its owner, an org admin, `tags:*`, or a grant for one of its tags';
  const guard = delegatedGuard(actor, target, noGrant);
  if (guard) return guard;
  if (standingOver(actor, target)) return OK;
  return refuse('grant_required', noGrant);
}

/**
 * Create a grant of `scope` for `target`. Org owners/admins grant anything (to
 * anyone but themselves); `tags:*` holders grant only `tag:<slug>`; nobody else
 * grants at all. The agent's owner has no grant authority by ownership alone.
 */
export function decideGrantCreate(actor: ActorFacts, target: TargetFacts, scope: string): Verdict {
  if (actor.id === target.id) return refuse('self', SELF_MESSAGE);
  if (actor.kind === 'human' && actor.orgAdmin) return OK;
  const noGrant = 'Only org owners/admins, or holders of `tags:*` (for `tag:<slug>`), can grant';
  if (!actor.scopes.includes(ALL_TAGS_SCOPE)) return refuse('grant_required', noGrant);
  if (scope === ALL_TAGS_SCOPE || !scope.startsWith('tag:')) {
    return refuse('grant_required', `Only org owners/admins can grant \`${scope}\``);
  }
  const guard = delegatedGuard(actor, target, noGrant);
  if (guard) return guard;
  return OK;
}

/**
 * Delete a grant held by `holder`: the holder itself (giving up your own
 * authority is always safe, so `self` does not apply), org owners/admins, or the
 * grant's creator.
 */
export function decideGrantDelete(actor: ActorFacts, holder: TargetFacts, grantedBy: string): Verdict {
  if (actor.id === holder.id) return OK;
  if (actor.kind === 'human' && actor.orgAdmin) return OK;
  if (grantedBy !== actor.id) {
    return refuse('grant_required', 'Only org owners/admins or the grant’s creator can revoke it');
  }
  const lacking = holder.scopes.filter((s) => !covers(actor.scopes, s));
  if (lacking.length > 0) {
    return refuse(
      'outranked',
      `You cannot act on this ${holder.kind}: it holds ${lacking.map((s) => `\`${s}\``).join(', ')}, which you do not`,
    );
  }
  return OK;
}

/**
 * Read an agent's analytics: the agent itself, its owner, org owners/admins, and
 * holders of a grant covering one of its tags (`tags:*` covers every agent,
 * tagged or not: the org-wide chief of staff). Delegated readers pass the same
 * `outranked` guard as writes: nobody reads a principal holding a grant they do
 * not also hold.
 */
export function decideAnalyticsRead(actor: ActorFacts, target: TargetFacts): Verdict {
  if (actor.id === target.id) return OK;
  if (implicitOver(actor, target)) return OK;
  const noGrant = 'Reading this agent’s analytics needs its owner, an org admin, or a grant covering one of its tags';
  const guard = delegatedGuard(actor, target, noGrant);
  if (guard) return guard;
  if (standingOver(actor, target)) return OK;
  return refuse('grant_required', noGrant);
}
