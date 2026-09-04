/**
 * Room, member, and DM primitives shared by the Phase-3 rooms/members/messages/
 * DM/status/events routes. Pure DB helpers (no SSE/presence): resolution of
 * rooms and members, live-display-name projection, role/capability checks, the
 * archive guard, and DM counterpart resolution.
 */
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  type Member,
  type MemberRef,
  type Room,
  type RoomKind,
  type RoomRole,
  type DmCounterpart,
  type PrincipalKind,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { avatarUrlForPrincipal } from './avatar-helpers.js';
import { agents, humans, members, orgMemberships, rooms } from './db/schema.js';
import type { AgentRow, HumanRow, MemberRow, RoomRow } from './db/schema.js';
import { parseRoomSettings } from './room-settings.js';
import { badRequest, forbidden, gone, notFound } from './errors.js';

/** Room-role rank so `has >= need` comparisons are simple. */
const ROOM_ROLE_RANK: Record<RoomRole, number> = { member: 0, admin: 1, owner: 2 };

/** Numeric rank of a room role. */
export function roomRoleRank(role: RoomRole): number {
  return ROOM_ROLE_RANK[role];
}

/** Whether the request carries the instance admin token (operator escape hatch). */
export function hasAdminToken(ctx: AppContext, request: FastifyRequest): boolean {
  return !!ctx.config.adminToken && request.headers['x-admin-token'] === ctx.config.adminToken;
}

/** A room row by id, or undefined. */
export function roomById(ctx: AppContext, roomId: string): RoomRow | undefined {
  return ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
}

/** A member row by id, or undefined. */
export function memberById(ctx: AppContext, id: string): MemberRow | undefined {
  return ctx.db.select().from(members).where(eq(members.id, id)).get();
}

/** The member row for a principal in a room, or undefined. */
export function memberOf(
  ctx: AppContext,
  roomId: string,
  principalType: PrincipalKind,
  principalId: string,
): MemberRow | undefined {
  return ctx.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.roomId, roomId),
        eq(members.principalType, principalType),
        eq(members.principalId, principalId),
      ),
    )
    .get();
}

/** Every member row of a room, ordered ascending by (createdAt, id). */
export function membersOf(ctx: AppContext, roomId: string): MemberRow[] {
  return ctx.db
    .select()
    .from(members)
    .where(eq(members.roomId, roomId))
    .all()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The live display name for a principal (human displayName or agent name). */
export function principalDisplayName(
  ctx: AppContext,
  principalType: PrincipalKind,
  principalId: string,
): string {
  if (principalType === 'human') {
    const h = ctx.db.select().from(humans).where(eq(humans.id, principalId)).get();
    return h?.displayName ?? '';
  }
  const a = ctx.db.select().from(agents).where(eq(agents.id, principalId)).get();
  return a?.name ?? '';
}

/** Project a member row to the wire Member resource (display name + avatar are live). */
export function toMember(ctx: AppContext, row: MemberRow): Member {
  const kind = row.principalType as PrincipalKind;
  return {
    id: row.id,
    kind,
    principalId: row.principalId,
    displayName: principalDisplayName(ctx, kind, row.principalId),
    avatarUrl: avatarUrlForPrincipal(ctx, kind, row.principalId),
    roomRole: row.roomRole as RoomRole,
    lastSeenAt: row.lastSeenAt ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Project a member row to a compact MemberRef (`{ id, kind, displayName,
 * avatarUrl, principalId }`). `id` is the per-room member id (`mem_…`);
 * `principalId` is the stable identity (`agt_…`/`usr_…`) so clients seed
 * procedural avatars off identity, not membership.
 */
export function toMemberRef(ctx: AppContext, row: MemberRow): MemberRef {
  const kind = row.principalType as PrincipalKind;
  return {
    id: row.id,
    kind,
    displayName: principalDisplayName(ctx, kind, row.principalId),
    avatarUrl: avatarUrlForPrincipal(ctx, kind, row.principalId),
    principalId: row.principalId,
  };
}

/** Project a room row to the full GetRoom wire resource (settings defaults-merged). */
export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: row.kind as RoomKind,
    archivedAt: row.archivedAt ?? null,
    settings: parseRoomSettings(row.settings),
  };
}

/** A resolved caller of a room-scoped route: the room + the caller's member row. */
export interface RoomCaller {
  room: RoomRow;
  member: MemberRow;
  /** True when the request additionally carried a valid instance admin token. */
  instanceAdmin: boolean;
}

/** Whether a principal belongs to an org (human membership, or the agent's org). */
export function principalInOrg(
  ctx: AppContext,
  orgId: string,
  principal: { type: PrincipalKind; id: string },
): boolean {
  if (principal.type === 'human') {
    return (
      ctx.db
        .select({ humanId: orgMemberships.humanId })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.humanId, principal.id)))
        .get() !== undefined
    );
  }
  return agentById(ctx, principal.id)?.orgId === orgId;
}

/**
 * Resolve the caller's member row in a room, three-tiered so a room never leaks
 * its existence across orgs (SPEC): an unknown room OR a caller who is not a
 * member of the room's ORG → `404` (indistinguishable); an org member with no
 * member row in the room → `403`. The credential is a principal (session human
 * or agent key).
 */
export function requireRoomMember(
  ctx: AppContext,
  request: FastifyRequest,
  roomId: string,
  principal: { type: PrincipalKind; id: string },
): RoomCaller {
  const room = roomById(ctx, roomId);
  // Outsiders to the room's org cannot distinguish it from a nonexistent room.
  if (!room || !principalInOrg(ctx, room.orgId, principal)) throw notFound('No such room');
  const member = memberOf(ctx, roomId, principal.type, principal.id);
  if (!member) throw forbidden('You are not a member of this room');
  // last_seen_at (member) is bumped on every authenticated room request.
  touchMember(ctx, member.id, nowIso());
  return { room, member, instanceAdmin: hasAdminToken(ctx, request) };
}

/** Whether a human is an org owner/admin (implicit room-admin capability). */
export function isOrgAdminOrOwner(ctx: AppContext, orgId: string, humanId: string): boolean {
  const m = ctx.db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.humanId, humanId)))
    .get();
  return !!m && (m.role === 'owner' || m.role === 'admin');
}

/**
 * The caller's effective room-capability rank, folding in the operator escape
 * hatch (instance admin → unbounded) and the org-owner/admin implicit room-admin
 * grant (at least `admin`). Agents get only their member role.
 */
export function effectiveRoomRank(
  ctx: AppContext,
  caller: RoomCaller,
  callerPrincipalType: PrincipalKind,
): number {
  if (caller.instanceAdmin) return Number.POSITIVE_INFINITY;
  let rank = roomRoleRank(caller.member.roomRole as RoomRole);
  if (
    callerPrincipalType === 'human' &&
    isOrgAdminOrOwner(ctx, caller.room.orgId, caller.member.principalId)
  ) {
    rank = Math.max(rank, ROOM_ROLE_RANK.admin);
  }
  return rank;
}

/** Throw `410 gone` when a room is archived (used to gate every mutation). */
export function assertNotArchived(room: RoomRow): void {
  if (room.archivedAt) throw gone('This room is archived');
}

/** Throw `400` when a room is a DM (member-management / role verbs are invalid there). */
export function assertNotDm(room: RoomRow): void {
  if (room.kind === 'dm') throw badRequest('That action is not available in a direct conversation');
}

/** How many owners a room currently has (last-owner guard). */
export function roomOwnerCount(ctx: AppContext, roomId: string): number {
  return ctx.db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.roomRole, 'owner')))
    .all().length;
}

/**
 * Resolve a message/DM `to` or member `:id` target within a room to a member
 * row. Accepts a member id (`mem_`) or a principal id (`usr_`/`agt_`). Returns
 * undefined when the target resolves to nothing in this room.
 */
export function resolveMemberTarget(
  ctx: AppContext,
  roomId: string,
  target: string,
): MemberRow | undefined {
  if (target.startsWith('mem_')) {
    const row = memberById(ctx, target);
    return row && row.roomId === roomId ? row : undefined;
  }
  if (target.startsWith('usr_')) return memberOf(ctx, roomId, 'human', target);
  if (target.startsWith('agt_')) return memberOf(ctx, roomId, 'agent', target);
  return undefined;
}

/** The two members of a DM room; the "counterpart" is the one that is not `self`. */
export function dmCounterpart(
  ctx: AppContext,
  room: RoomRow,
  selfPrincipalId: string,
): DmCounterpart | undefined {
  if (room.kind !== 'dm') return undefined;
  const rows = ctx.db.select().from(members).where(eq(members.roomId, room.id)).all();
  const other = rows.find((m) => m.principalId !== selfPrincipalId);
  if (!other) return undefined;
  const kind = other.principalType as PrincipalKind;
  return {
    type: kind,
    id: other.principalId,
    displayName: principalDisplayName(ctx, kind, other.principalId),
    avatarUrl: avatarUrlForPrincipal(ctx, kind, other.principalId),
  };
}

/** Resolve a human by `usr_...` id or email (for share/invite targets). */
export function resolveHumanByIdOrEmail(ctx: AppContext, value: string): HumanRow | undefined {
  const byId = ctx.db.select().from(humans).where(eq(humans.id, value)).get();
  if (byId) return byId;
  return ctx.db.select().from(humans).where(eq(humans.email, value.trim().toLowerCase())).get();
}

/** Bump a member's `last_seen_at` (called on authenticated room activity). */
export function touchMember(ctx: AppContext, memberId: string, ts: string): void {
  ctx.db.update(members).set({ lastSeenAt: ts }).where(eq(members.id, memberId)).run();
}

/** An agent row by id, or undefined. */
export function agentById(ctx: AppContext, id: string): AgentRow | undefined {
  return ctx.db.select().from(agents).where(eq(agents.id, id)).get();
}

/** A human row by id, or undefined. */
export function humanById(ctx: AppContext, id: string): HumanRow | undefined {
  return ctx.db.select().from(humans).where(eq(humans.id, id)).get();
}
