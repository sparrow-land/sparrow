/**
 * Agent, visibility, and DM-ensure primitives shared by the agents, enrollment,
 * and (Phase-3) DM routes.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  newAgentId,
  newMemberId,
  newRoomId,
  AGENT_NAME_MAX,
  isReservedAgentName,
  type Agent,
  type AgentSharingMode,
  type EnrollmentSummary,
  type EnrollmentRequestedEvent,
  type EnrollmentResolvedEvent,
  type PrincipalKind,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { conflict } from './errors.js';
import { emitPrincipalRenamed } from './room-events.js';
import {
  agents,
  agentVisibility,
  members,
  orgMemberships,
  rooms,
} from './db/schema.js';
import type { AgentRow, HumanRow } from './db/schema.js';
import { agentAddress } from './email/addresses.js';

/**
 * An agent's DERIVED email address (`<name>@<org-slug><EMAIL_ORG_SUFFIX>`), or
 * `null` when the email medium is off (SPEC "Identity & addressing →
 * Addresses"). The address is a VIEW, never state — a rename or an org-slug
 * change moves it immediately, with no alias and no grace window. The single
 * derivation lives in `email/addresses.ts`; every agent-bearing response gets it
 * from here because they all render through {@link toAgent}.
 */
export function agentEmailAddress(ctx: AppContext, row: AgentRow): string | null {
  return agentAddress(ctx, row);
}

/**
 * Wire shape for an agent principal. `online` is the OR across the agent's open
 * events streams (any room's `/events` or `/me/events`), grace-windowed.
 * `emailAddress` is the derived address or `null` (see {@link agentEmailAddress}).
 */
export function toAgent(ctx: AppContext, row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    orgId: row.orgId,
    emailAddress: agentEmailAddress(ctx, row),
    online: ctx.rooms.isPrincipalOnline('agent', row.id),
    lastSeenAt: row.lastSeenAt ?? null,
    sharing: (row.sharing as AgentSharingMode) ?? 'selected',
    // Org-visible label only; the private instructions never ride the wire Agent.
    roleTitle: row.roleTitle ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Set (or clear) an agent's ROLE. `roleTitle` and `roleInstructions` are each
 * optional on the patch: an absent field is left untouched, a string SETS it
 * (a title is trimmed; an empty/whitespace-only value CLEARS to null), and an
 * explicit `null` CLEARS it. On a REAL change (either half differs), the row's
 * columns are written, `roleUpdatedAt` is bumped, and a `role.updated` event is
 * published to the agent's own `/me` stream AND to every human who can currently
 * see the agent ({@link humansWhoCanSeeAgent}) — carrying only the agent id, the
 * org-visible title and the new timestamp, never the instructions. A no-op patch
 * (nothing actually
 * changed) short-circuits with no write and no event. Returns the updated row.
 */
export function setAgentRole(
  ctx: AppContext,
  agent: AgentRow,
  patch: { roleTitle?: string | null; roleInstructions?: string | null },
): AgentRow {
  // Resolve each half's next value: undefined → keep; else coerce to a clean
  // string or null (empty/whitespace clears).
  const clean = (v: string | null | undefined, current: string | null, trim: boolean): string | null => {
    if (v === undefined) return current;
    if (v === null) return null;
    const value = trim ? v.trim() : v;
    return value.length === 0 ? null : value;
  };
  const nextTitle = clean(patch.roleTitle, agent.roleTitle ?? null, true);
  const nextInstructions = clean(patch.roleInstructions, agent.roleInstructions ?? null, false);

  const titleChanged = nextTitle !== (agent.roleTitle ?? null);
  const instructionsChanged = nextInstructions !== (agent.roleInstructions ?? null);
  if (!titleChanged && !instructionsChanged) return agent;

  const roleUpdatedAt = nowIso();
  ctx.db
    .update(agents)
    .set({ roleTitle: nextTitle, roleInstructions: nextInstructions, roleUpdatedAt })
    .where(eq(agents.id, agent.id))
    .run();
  // One event, two audiences (same payload — never the private instructions):
  // the agent's own /me stream (the re-read nudge), and every human who can
  // currently SEE the agent, so their sidebar's org-visible title refreshes
  // live. Both journaled, so both replay on reconnect.
  const event = { agentId: agent.id, roleTitle: nextTitle, roleUpdatedAt };
  ctx.bus.publish('agent', agent.id, 'role.updated', event);
  for (const humanId of humansWhoCanSeeAgent(ctx, agent)) {
    ctx.bus.publish('human', humanId, 'role.updated', event);
  }
  return { ...agent, roleTitle: nextTitle, roleInstructions: nextInstructions, roleUpdatedAt };
}

/** Case-insensitive lookup of an agent by name within an org. */
export function agentByNameInOrg(
  ctx: AppContext,
  orgId: string,
  name: string,
): AgentRow | undefined {
  return ctx.db
    .select()
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .all()
    .find((a) => a.name.toLowerCase() === name.toLowerCase());
}

/**
 * A per-org-unique agent name derived from `base`: the base itself when free,
 * else `base-2`, `base-3`, … (case-insensitive collision), staying ≤ 60 chars.
 */
export function uniqueAgentName(ctx: AppContext, orgId: string, base: string): string {
  if (!agentByNameInOrg(ctx, orgId, base)) return base;
  for (let n = 2; n < 100_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, AGENT_NAME_MAX - suffix.length)}${suffix}`;
    if (!agentByNameInOrg(ctx, orgId, candidate)) return candidate;
  }
  return `${base}-${newAgentId().slice(4)}`;
}

/**
 * Reject a name the instance reserves as a mailbox local part (SPEC "Identity &
 * addressing → Reserved local parts"). Reserved is a `409`, not a `400`: the name
 * is well-formed, just unavailable — the SAME outcome as a taken name, so a
 * caller cannot probe the reserved list apart from the org's namespace. The shape
 * rule itself (`400`) is enforced by `AgentNameSchema` at the route boundary.
 */
export function assertNameAvailable(name: string): void {
  if (isReservedAgentName(name)) {
    throw conflict(`The name “${name.trim()}” is reserved; choose another name`);
  }
}

/**
 * Rename an agent (display-layer; the `agt_` id is unchanged). `name` is assumed
 * schema-validated for SHAPE (trimmed, lowercase, email-safe, 1..AGENT_NAME_MAX);
 * this enforces the two `409` outcomes: a RESERVED local part, and a
 * case-insensitive clash with a DIFFERENT agent in the org. An explicit rename is
 * NEVER auto-suffixed (unlike an enroll-time proposed name at approval). A no-op
 * rename (identical name) short-circuits without a write or a ripple. On a real
 * change, `member.updated` is emitted in every room the agent inhabits, and the
 * agent's email address moves with it (no alias). Returns the updated row.
 */
export function renameAgent(ctx: AppContext, agent: AgentRow, name: string): AgentRow {
  if (name === agent.name) return agent;
  assertNameAvailable(name);
  const clash = agentByNameInOrg(ctx, agent.orgId, name);
  if (clash && clash.id !== agent.id) {
    throw conflict(`An agent named “${name}” already exists in this org; choose another name`);
  }
  ctx.db.update(agents).set({ name }).where(eq(agents.id, agent.id)).run();
  emitPrincipalRenamed(ctx, 'agent', agent.id);
  return { ...agent, name };
}

/** Grant (idempotently) a visibility row; returns true when a NEW row was created. */
export function grantVisibility(
  ctx: AppContext,
  agentId: string,
  humanId: string,
  grantedByHumanId: string,
): boolean {
  const existing = ctx.db
    .select()
    .from(agentVisibility)
    .where(and(eq(agentVisibility.agentId, agentId), eq(agentVisibility.humanId, humanId)))
    .get();
  if (existing) return false;
  ctx.db
    .insert(agentVisibility)
    .values({ agentId, humanId, grantedByHumanId, createdAt: nowIso() })
    .run();
  return true;
}

/** Whether a human holds an EXPLICIT visibility grant on an agent (owner row counts). */
export function hasVisibility(ctx: AppContext, agentId: string, humanId: string): boolean {
  return (
    ctx.db
      .select({ agentId: agentVisibility.agentId })
      .from(agentVisibility)
      .where(and(eq(agentVisibility.agentId, agentId), eq(agentVisibility.humanId, humanId)))
      .get() !== undefined
  );
}

/**
 * Whether two principals currently co-inhabit ≥1 non-DM, non-archived room —
 * "have they MET?". The single answer to that question in the codebase; both
 * the human↔agent sharing mode (`room-members`, via {@link sharesActiveRoom})
 * and the agent↔agent DM gate (SPEC "Direct conversations") ask it here rather
 * than growing a second, subtly different membership join.
 *
 * DM rooms are excluded on purpose: a DM only exists because reach was granted
 * at ensure-time, so counting it would make reach self-perpetuating (you could
 * never lose it by leaving the project rooms). Archived rooms are excluded for
 * the same reason a dead room confers nothing else.
 */
export function principalsShareActiveRoom(
  ctx: AppContext,
  a: { type: PrincipalKind; id: string },
  b: { type: PrincipalKind; id: string },
): boolean {
  const first = alias(members, 'first_member');
  const second = alias(members, 'second_member');
  return (
    ctx.db
      .select({ roomId: first.roomId })
      .from(first)
      .innerJoin(second, eq(second.roomId, first.roomId))
      .innerJoin(rooms, eq(rooms.id, first.roomId))
      .where(
        and(
          eq(first.principalType, a.type),
          eq(first.principalId, a.id),
          eq(second.principalType, b.type),
          eq(second.principalId, b.id),
          ne(rooms.kind, 'dm'),
          isNull(rooms.archivedAt),
        ),
      )
      .get() !== undefined
  );
}

/** {@link principalsShareActiveRoom} for the human↔agent pair (sharing modes). */
function sharesActiveRoom(ctx: AppContext, agentId: string, humanId: string): boolean {
  return principalsShareActiveRoom(
    ctx,
    { type: 'human', id: humanId },
    { type: 'agent', id: agentId },
  );
}

/**
 * The single access predicate for "may this human see & reach this agent",
 * honoring the agent's sharing mode. Access is granted when ANY holds:
 *  - the human has an explicit `agent_visibility` grant (true in every mode —
 *    the owner's own row counts, and extra grants stay meaningful);
 *  - mode `room-members` and the pair co-inhabit ≥1 non-DM, non-archived room;
 *  - mode `org` and the human belongs to the agent's org.
 *
 * NOTE: dynamic modes (`room-members`, `org`) confer access WITHOUT minting a
 * per-human `agent_visibility` row, so they emit NO `agent.shared` /
 * `agent.unshared` events — those would fire on every room join/leave. Only the
 * explicit share/unshare routes emit those. Callers that need explicit-grant
 * membership (share management) must use {@link hasVisibility}, not this.
 */
export function canAccessAgent(ctx: AppContext, agent: AgentRow, humanId: string): boolean {
  if (hasVisibility(ctx, agent.id, humanId)) return true;
  const mode = (agent.sharing as AgentSharingMode) ?? 'selected';
  if (mode === 'org') {
    return (
      ctx.db
        .select({ orgId: orgMemberships.orgId })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, agent.orgId), eq(orgMemberships.humanId, humanId)))
        .get() !== undefined
    );
  }
  if (mode === 'room-members') return sharesActiveRoom(ctx, agent.id, humanId);
  return false;
}

/**
 * The EXACT, bounded set of human ids that {@link canAccessAgent} returns true
 * for — the agent's viewers right now. It is the union of:
 *  - every explicit `agent_visibility` grantee (the owner's own row included);
 *  - under `org`, every human in the agent's org;
 *  - under `room-members`, every human co-inhabiting a non-DM, non-archived room
 *    with the agent.
 *
 * Bounded by (grants + org members | co-room humans) — never a per-human walk.
 * Used both to reason about "who can see this agent" and as the building block
 * for the agent↔agent DM predicate below.
 */
export function humansWhoCanSeeAgent(ctx: AppContext, agent: AgentRow): Set<string> {
  const ids = new Set<string>(
    ctx.db
      .select({ humanId: agentVisibility.humanId })
      .from(agentVisibility)
      .where(eq(agentVisibility.agentId, agent.id))
      .all()
      .map((r) => r.humanId),
  );
  const mode = (agent.sharing as AgentSharingMode) ?? 'selected';
  if (mode === 'org') {
    for (const r of ctx.db
      .select({ humanId: orgMemberships.humanId })
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, agent.orgId))
      .all())
      ids.add(r.humanId);
  } else if (mode === 'room-members') {
    const humanMember = alias(members, 'human_member');
    const agentMember = alias(members, 'agent_member');
    for (const r of ctx.db
      .select({ humanId: humanMember.principalId })
      .from(humanMember)
      .innerJoin(agentMember, eq(agentMember.roomId, humanMember.roomId))
      .innerJoin(rooms, eq(rooms.id, humanMember.roomId))
      .where(
        and(
          eq(humanMember.principalType, 'human'),
          eq(agentMember.principalType, 'agent'),
          eq(agentMember.principalId, agent.id),
          ne(rooms.kind, 'dm'),
          isNull(rooms.archivedAt),
        ),
      )
      .all())
      ids.add(r.humanId);
  }
  return ids;
}

/**
 * Whether ANY single human can currently see BOTH agents — the eligibility rule
 * for an agent↔agent DM (both at ensure-time and, as a revocation gate, at
 * send-time). Two agents may DM iff at least one human holds `canAccessAgent` on
 * each; under the default `room-members` mode that means agents visible to a
 * common human through shared rooms, and under `org` mode effectively every
 * agent in the org.
 *
 * Efficient by construction — never a naive per-org-human scan:
 *  1. **Owners first.** An owner always sees its OWN agent, so the pair is
 *     eligible the moment `a`'s owner can see `b` (or `b`'s owner can see `a`) —
 *     two `canAccessAgent` calls. This also subsumes every `org`-mode pair (the
 *     other agent's owner is an org member, so it sees an `org` agent), so the
 *     fallback below only ever runs for `selected`/`room-members` pairs.
 *  2. **Bounded intersection.** Otherwise intersect the two agents' exact viewer
 *     sets ({@link humansWhoCanSeeAgent}); non-empty ⇒ eligible.
 *
 * Complexity: the fast path is O(gₐ + g_b + rₐ + r_b) worst case (a
 * `canAccessAgent` may run the co-room query); the fallback adds the same again
 * to build both sets — where g = explicit grants and r = co-room humans, both
 * bounded by real membership, with no `org`-sized term (step 1 caught those).
 */
export function someHumanCanSeeBoth(ctx: AppContext, a: AgentRow, b: AgentRow): boolean {
  if (a.orgId !== b.orgId) return false; // an agent belongs to exactly one org
  if (canAccessAgent(ctx, b, a.ownerHumanId)) return true;
  if (canAccessAgent(ctx, a, b.ownerHumanId)) return true;
  const seeA = humansWhoCanSeeAgent(ctx, a);
  for (const humanId of humansWhoCanSeeAgent(ctx, b)) {
    if (seeA.has(humanId)) return true;
  }
  return false;
}

/**
 * Whether ONE named human may currently oversee an agent↔agent DM — the
 * read-side mirror of {@link someHumanCanSeeBoth}: the human gets the ambient
 * oversight box (and read access to the thread) exactly while they can see BOTH
 * agents. Losing sight of either drops both, with no denormalized state to
 * revoke.
 */
export function humanCanSeeBoth(
  ctx: AppContext,
  a: AgentRow,
  b: AgentRow,
  humanId: string,
): boolean {
  return canAccessAgent(ctx, a, humanId) && canAccessAgent(ctx, b, humanId);
}

/**
 * Mint an agent: insert the row, its owner visibility row, and return the row +
 * plaintext key (the caller returns the key exactly once). `keyHash` must be the
 * sha256 of the plaintext key. The name is assumed already unique in the org.
 */
export function insertAgent(
  ctx: AppContext,
  input: { orgId: string; ownerHumanId: string; name: string; keyHash: string },
): AgentRow {
  const ts = nowIso();
  const row: AgentRow = {
    id: newAgentId(),
    orgId: input.orgId,
    ownerHumanId: input.ownerHumanId,
    name: input.name,
    keyHash: input.keyHash,
    sharing: 'room-members',
    roleTitle: null,
    roleInstructions: null,
    roleUpdatedAt: null,
    lastSeenAt: null,
    createdAt: ts,
  };
  ctx.db.transaction((tx) => {
    tx.insert(agents).values(row).run();
    tx.insert(agentVisibility)
      .values({
        agentId: row.id,
        humanId: input.ownerHumanId,
        grantedByHumanId: input.ownerHumanId,
        createdAt: ts,
      })
      .run();
  });
  return row;
}

/** The unordered DM pairing key: `orgId|` + the two principal ids sorted. */
export function dmKey(orgId: string, a: string, b: string): string {
  return `${orgId}|${[a, b].sort().join('|')}`;
}

/**
 * Ensure a DM room between two principals of an org exists with both member
 * rows, returning its room id. Idempotent: re-uses the room keyed by `dm_key`
 * and re-adds any departed member. Used at agent-enrollment approval to make the
 * owner↔agent DM immediately reachable.
 */
export function ensureDmRoom(
  ctx: AppContext,
  orgId: string,
  a: { type: 'human' | 'agent'; id: string },
  b: { type: 'human' | 'agent'; id: string },
): string {
  const key = dmKey(orgId, a.id, b.id);
  let room = ctx.db.select().from(rooms).where(eq(rooms.dmKey, key)).get();
  const ts = nowIso();
  if (!room) {
    const id = newRoomId();
    ctx.db
      .insert(rooms)
      .values({
        id,
        orgId,
        name: '',
        kind: 'dm',
        dmKey: key,
        archivedAt: null,
        settings: '{}',
        createdAt: ts,
      })
      .run();
    room = ctx.db.select().from(rooms).where(eq(rooms.id, id)).get()!;
  }
  for (const p of [a, b]) {
    const existing = ctx.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.roomId, room.id),
          eq(members.principalType, p.type),
          eq(members.principalId, p.id),
        ),
      )
      .get();
    if (!existing) {
      ctx.db
        .insert(members)
        .values({
          id: newMemberId(),
          roomId: room.id,
          principalType: p.type,
          principalId: p.id,
          roomRole: 'member',
          lastSeenAt: null,
          createdAt: ts,
        })
        .run();
    }
  }
  return room.id;
}

/* ------------------------------------------------------------------ *
 * Principal-level event emission (delivered on the approvers'/grantee's
 * `/me/events`; the SSE surface itself is wired by Phase 3, but the emit call
 * sites live here now).
 * ------------------------------------------------------------------ */

/** The human ids that may approve an org's enrollments: owners + admins + the inviter. */
export function orgApproverHumanIds(
  ctx: AppContext,
  orgId: string,
  inviterHumanId?: string,
): string[] {
  const rows = ctx.db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, orgId))
    .all();
  const ids = new Set<string>();
  for (const r of rows) if (r.role === 'owner' || r.role === 'admin') ids.add(r.humanId);
  if (inviterHumanId) ids.add(inviterHumanId);
  return [...ids];
}

/** Emit `enrollment.requested` to every approver of the org. */
export function emitEnrollmentRequested(
  ctx: AppContext,
  orgId: string,
  inviterHumanId: string,
  summary: EnrollmentSummary,
): void {
  const payload: EnrollmentRequestedEvent = { enrollment: summary };
  for (const humanId of orgApproverHumanIds(ctx, orgId, inviterHumanId)) {
    ctx.bus.publish('human', humanId, 'enrollment.requested', payload);
  }
}

/** Emit `enrollment.resolved` to every approver of the org. */
export function emitEnrollmentResolved(
  ctx: AppContext,
  orgId: string,
  inviterHumanId: string,
  enrollmentId: string,
  status: 'approved' | 'denied',
): void {
  const payload: EnrollmentResolvedEvent = { enrollmentId, status };
  for (const humanId of orgApproverHumanIds(ctx, orgId, inviterHumanId)) {
    ctx.bus.publish('human', humanId, 'enrollment.resolved', payload);
  }
}

/** Emit `agent.shared` / `agent.unshared` to a grantee. */
export function emitAgentShare(
  ctx: AppContext,
  humanId: string,
  event: 'agent.shared' | 'agent.unshared',
  agent: AgentRow,
): void {
  ctx.bus.publish('human', humanId, event, { agent: toAgent(ctx, agent) });
}

/** A HumanRef for the wire (`{ id, displayName }`). */
export function humanRef(human: Pick<HumanRow, 'id' | 'displayName'>): {
  id: string;
  displayName: string;
} {
  return { id: human.id, displayName: human.displayName };
}
