/**
 * Agent↔agent DM governance (SPEC "Direct conversations"): the two questions a
 * pair of agents raises for the humans around them.
 *
 *  1. **May they meet at all?** {@link agentsHaveMet} — the raw-`agt_` door is
 *     the same width as the name door. An agent's directory IS its rooms (the
 *     CLI resolves a peer's name from `GET /me/rooms` → `GET /rooms/:id/members`
 *     and its owner, and has no other list), so first contact requires that the
 *     two agents co-inhabit a room. Knowing an id is not knowing an agent.
 *  2. **May the line stay up?** {@link severOf} — a durable, human-set block on
 *     one pair. Severing archives the DM room (ordinary tombstone semantics:
 *     `410` on every mutation, history still readable) AND records this row, so
 *     the pair stays severed until a human with the authority to lift it says
 *     otherwise. Nothing re-opens by itself.
 *
 * The oversight READ surface (`/orgs/:orgId/agent-dms`) is deliberately blind to
 * both: whoever could watch the pair can still read every message it exchanged.
 */
import { and, eq } from 'drizzle-orm';
import type { AgentDmSever, AgentDmSeverAuthority, DmSeveredEvent } from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { agentDmSevers, members, rooms } from './db/schema.js';
import type { AgentDmSeverRow, AgentRow, RoomRow } from './db/schema.js';
import {
  humanCanSeeBoth,
  humansWhoCanSeeAgent,
  principalsShareActiveRoom,
} from './agent-helpers.js';
import { agentById, humanById, isOrgAdminOrOwner } from './room-helpers.js';
import { emitRoomUpdated } from './room-events.js';

/**
 * The two agents of an agent↔agent DM room, or `null` when the room is not one
 * (a human is a member, or the pair is not exactly two agents). Archived rooms
 * are INCLUDED: a severed pair's room is archived, and its overseers keep the
 * box and the transcript.
 */
export function agentPairOf(ctx: AppContext, room: RoomRow): [AgentRow, AgentRow] | null {
  if (room.kind !== 'dm') return null;
  const mem = ctx.db.select().from(members).where(eq(members.roomId, room.id)).all();
  if (mem.length !== 2 || mem.some((m) => m.principalType !== 'agent')) return null;
  const a = agentById(ctx, mem[0]!.principalId);
  const b = agentById(ctx, mem[1]!.principalId);
  return a && b ? [a, b] : null;
}

/**
 * Whether two agents have MET — they co-inhabit at least one non-DM,
 * non-archived room. The gate on FIRST contact only: once a DM room exists the
 * pair has met for good, and the live gate is oversight (some human can see
 * both) plus the sever record. Shares its answer with the human↔agent sharing
 * mode via {@link principalsShareActiveRoom}.
 */
export function agentsHaveMet(ctx: AppContext, a: AgentRow, b: AgentRow): boolean {
  return principalsShareActiveRoom(ctx, { type: 'agent', id: a.id }, { type: 'agent', id: b.id });
}

/** The DM room for an agent pair, if one was ever ensured. */
export function agentDmRoom(ctx: AppContext, dmKey: string): RoomRow | undefined {
  return ctx.db.select().from(rooms).where(eq(rooms.dmKey, dmKey)).get();
}

/** The sever record for a DM room, or undefined when the pair is not severed. */
export function severOf(ctx: AppContext, roomId: string): AgentDmSeverRow | undefined {
  return ctx.db.select().from(agentDmSevers).where(eq(agentDmSevers.roomId, roomId)).get();
}

/**
 * The authority a human holds over one pair, or `null` when they hold none:
 *
 *  - `'org'` — an owner/admin of the org: may sever any pair in it, and is the
 *    only authority that can lift an `'org'` sever;
 *  - `'agent-owner'` — the owning human of EITHER agent: may sever the pair,
 *    and may lift an `'agent-owner'` sever (their own or the other owner's —
 *    the two owners are peers over a line that needs both of them).
 *
 * Deliberately NOT "anyone who can see both": oversight is a read right. The
 * off switch belongs to the people who answer for the agents or the org.
 */
export function severAuthorityOf(
  ctx: AppContext,
  orgId: string,
  humanId: string,
  pair: [AgentRow, AgentRow],
): AgentDmSeverAuthority | null {
  if (isOrgAdminOrOwner(ctx, orgId, humanId)) return 'org';
  if (pair.some((agent) => agent.ownerHumanId === humanId)) return 'agent-owner';
  return null;
}

/** Whether `held` may lift a sever recorded by `recorded`. */
export function canLift(recorded: AgentDmSeverAuthority, held: AgentDmSeverAuthority): boolean {
  return recorded === 'org' ? held === 'org' : true;
}

/** The wire shape of a sever record. */
export function toSever(
  ctx: AppContext,
  row: AgentDmSeverRow,
  pair: [AgentRow, AgentRow],
): AgentDmSever {
  const by = humanById(ctx, row.severedByHumanId);
  return {
    roomId: row.roomId,
    orgId: row.orgId,
    agents: [
      { id: pair[0].id, name: pair[0].name },
      { id: pair[1].id, name: pair[1].name },
    ],
    severedBy: { id: row.severedByHumanId, displayName: by?.displayName ?? '' },
    authority: row.authority as AgentDmSeverAuthority,
    severedAt: row.severedAt,
  };
}

/**
 * Announce a sever/lift: to BOTH agents (their line moved) and to every human
 * who can currently see both (an open oversight view updates in place). The
 * actor is included even when they cannot see both — they just acted, so they
 * always learn the outcome.
 */
function emitSeverEvent(
  ctx: AppContext,
  event: 'dm.severed' | 'dm.allowed',
  room: RoomRow,
  pair: [AgentRow, AgentRow],
  actorHumanId: string,
  severedAt: string | null,
): void {
  const actor = humanById(ctx, actorHumanId);
  const payload: DmSeveredEvent = {
    roomId: room.id,
    orgId: room.orgId,
    agents: [
      { id: pair[0].id, name: pair[0].name },
      { id: pair[1].id, name: pair[1].name },
    ],
    severedAt,
    by: { id: actorHumanId, displayName: actor?.displayName ?? '' },
  };
  for (const agent of pair) ctx.bus.publish('agent', agent.id, event, payload);
  const audience = new Set<string>([actorHumanId]);
  const seeA = humansWhoCanSeeAgent(ctx, pair[0]);
  for (const humanId of humansWhoCanSeeAgent(ctx, pair[1])) {
    if (seeA.has(humanId)) audience.add(humanId);
  }
  for (const humanId of audience) ctx.bus.publish('human', humanId, event, payload);
}

/**
 * Sever a pair: archive the DM room (so every further send answers `410` under
 * the ordinary archived-room rule) and write the durable block. Idempotent — a
 * second sever returns the record already standing, without re-stamping it.
 */
export function severAgentDm(
  ctx: AppContext,
  room: RoomRow,
  pair: [AgentRow, AgentRow],
  humanId: string,
  authority: AgentDmSeverAuthority,
): AgentDmSever {
  const existing = severOf(ctx, room.id);
  if (existing) return toSever(ctx, existing, pair);
  const severedAt = nowIso();
  const row: AgentDmSeverRow = {
    roomId: room.id,
    orgId: room.orgId,
    severedByHumanId: humanId,
    authority,
    severedAt,
  };
  ctx.db.transaction((tx) => {
    tx.insert(agentDmSevers).values(row).run();
    tx.update(rooms).set({ archivedAt: severedAt }).where(eq(rooms.id, room.id)).run();
  });
  const updated = ctx.db.select().from(rooms).where(eq(rooms.id, room.id)).get()!;
  emitRoomUpdated(ctx, updated);
  emitSeverEvent(ctx, 'dm.severed', updated, pair, humanId, severedAt);
  return toSever(ctx, row, pair);
}

/**
 * Lift a sever. The pair is PERMITTED again, not reconnected: the room stays
 * archived until the agents ensure the DM once more and pass the ordinary gate
 * — so a re-opened line is always something an agent chose, after a human
 * allowed it.
 */
export function allowAgentDm(
  ctx: AppContext,
  room: RoomRow,
  pair: [AgentRow, AgentRow],
  humanId: string,
): void {
  ctx.db.delete(agentDmSevers).where(eq(agentDmSevers.roomId, room.id)).run();
  emitSeverEvent(ctx, 'dm.allowed', room, pair, humanId, null);
}

/**
 * Re-open a severed-then-allowed room at ensure time: an archived agent↔agent
 * DM with no sever standing is restored, because the only thing that archives
 * one is a sever.
 */
export function reopenAllowedAgentDm(ctx: AppContext, room: RoomRow): void {
  // Scoped to agent↔agent DMs on purpose: a sever is the only thing that can
  // archive one, so "archived with no sever standing" means "allowed again".
  // No other DM can be archived at all, and this must never become a way to
  // un-archive something else by ensuring into it.
  if (!room.archivedAt || !agentPairOf(ctx, room) || severOf(ctx, room.id)) return;
  ctx.db.update(rooms).set({ archivedAt: null }).where(eq(rooms.id, room.id)).run();
  const updated = ctx.db.select().from(rooms).where(eq(rooms.id, room.id)).get()!;
  emitRoomUpdated(ctx, updated);
}

/** Whether a human may currently WATCH this pair (the oversight predicate). */
export function canOverseePair(
  ctx: AppContext,
  pair: [AgentRow, AgentRow],
  humanId: string,
): boolean {
  return humanCanSeeBoth(ctx, pair[0], pair[1], humanId);
}

/** All sever rows of an org, keyed by room id (one query for a listing). */
export function seversOfOrg(ctx: AppContext, orgId: string): Map<string, AgentDmSeverRow> {
  const rows = ctx.db
    .select()
    .from(agentDmSevers)
    .where(and(eq(agentDmSevers.orgId, orgId)))
    .all();
  return new Map(rows.map((r) => [r.roomId, r]));
}
