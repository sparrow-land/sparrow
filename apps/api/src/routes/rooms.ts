/**
 * Rooms, members, and room invitations (SPEC "Rooms & members"). Rooms have no
 * door — membership changes are verbs performed by insiders. Room-scoped routes
 * are member-authed via the room-in-URL form; CreateRoom + invitation-admin
 * routes fold in the org-owner/admin implicit room-admin grant and the instance
 * admin escape hatch. DM rooms reject member-management + PATCH with `400`.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import {
  CreateRoomRequestSchema,
  UpdateRoomRequestSchema,
  UpdateOrgRoomRequestSchema,
  AddMemberRequestSchema,
  SetMemberRoleRequestSchema,
  InviteHumanRequestSchema,
  PageQuerySchema,
  newMemberId,
  newRoomId,
  newRoomInvitationId,
  type CreateRoomResponse,
  type GetRoomResponse,
  type UpdateRoomResponse,
  type ListOrgRoomsResponse,
  type OrgRoomSummary,
  type UpdateOrgRoomResponse,
  type ListMembersResponse,
  type GetMemberResponse,
  type MemberResponse,
  type RoomInvitationAdmin,
  type InviteHumanResponse,
  type ListRoomInvitationsResponse,
  type RoomRole,
  type OrgRole,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal, principalIdent } from '../context.js';
import { members, orgs, rooms, roomInvitations } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, conflict, forbidden, gone, notFound } from '../errors.js';
import { requireMembership, membershipOf, parseOrgSettings, roleAtLeast } from '../org-helpers.js';
import { resolveLimit, cursorCondition, withCursor, pageResult } from '../pagination.js';
import { canAccessAgent, humanRef } from '../agent-helpers.js';
import {
  requireRoomMember,
  effectiveRoomRank,
  roomRoleRank,
  roomOwnerCount,
  assertNotArchived,
  assertNotDm,
  memberOf,
  membersOf,
  resolveMemberTarget,
  agentById,
  humanById,
  resolveHumanByIdOrEmail,
  toMember,
  toRoom,
} from '../room-helpers.js';
import {
  emitMemberJoined,
  emitMemberUpdated,
  emitMemberRemoved,
  emitRoomUpdated,
} from '../room-events.js';

/**
 * The governance projection of a room: what an org owner/admin may know about a
 * room they are not in. Everything here is structural — no settings, no
 * messages, no member identities.
 */
function toOrgRoomSummary(ctx: AppContext, room: typeof rooms.$inferSelect): OrgRoomSummary {
  const memberCount =
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(members)
      .where(eq(members.roomId, room.id))
      .get()?.n ?? 0;
  return {
    id: room.id,
    name: room.name,
    kind: room.kind as OrgRoomSummary['kind'],
    memberCount,
    archivedAt: room.archivedAt ?? null,
    createdAt: room.createdAt,
  };
}

/** Build the invitee-facing RoomInvitation (for the `room.invitation` event). */
function inviteeInvitation(
  ctx: AppContext,
  row: typeof roomInvitations.$inferSelect,
): { id: string; room: { id: string; name: string; orgId: string }; invitedBy: { id: string; displayName: string }; createdAt: string } {
  const room = ctx.db.select().from(rooms).where(eq(rooms.id, row.roomId)).get()!;
  const inviter = humanById(ctx, row.invitedByHumanId);
  return {
    id: row.id,
    room: { id: room.id, name: room.name, orgId: room.orgId },
    invitedBy: inviter ? humanRef(inviter) : { id: row.invitedByHumanId, displayName: '' },
    createdAt: row.createdAt,
  };
}

/** Build the admin-facing RoomInvitationAdmin. */
function adminInvitation(
  ctx: AppContext,
  row: typeof roomInvitations.$inferSelect,
): RoomInvitationAdmin {
  const invitee = humanById(ctx, row.humanId);
  const inviter = humanById(ctx, row.invitedByHumanId);
  return {
    id: row.id,
    human: invitee ? humanRef(invitee) : { id: row.humanId, displayName: '' },
    invitedBy: inviter ? humanRef(inviter) : { id: row.invitedByHumanId, displayName: '' },
    status: row.status as RoomInvitationAdmin['status'],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* --------------------------- ListOrgRooms -------------------------- */
  /**
   * Org room governance (SPEC "Rooms & members → Org room governance"): the
   * owner/admin's view of every PROJECT room in the org, member or not.
   *
   * A summary, never content: id, name, kind, member count, archived, created.
   * Enumeration is not readership — nothing here (and nothing in the archive
   * route below) grants sight of a single message, and neither ever adds the
   * caller to a room. DM rooms are excluded outright: their very EXISTENCE is
   * the private fact (who talks to whom), and they have their own controls
   * (`/orgs/:orgId/agent-dms`, and the room's own members for the rest).
   */
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/rooms', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    requireMembership(ctx.db, request.params.orgId, human.id, 'admin');
    const rows = ctx.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.orgId, request.params.orgId), ne(rooms.kind, 'dm')))
      .all();
    const items = rows
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((room) => toOrgRoomSummary(ctx, room));
    const response: ListOrgRoomsResponse = { items };
    return reply.send(response);
  });

  /* -------------------------- UpdateOrgRoom -------------------------- */
  /**
   * Archive (or restore) any project room in the org as its owner/admin,
   * without joining it. The archived room then behaves exactly as one archived
   * by its own owner — `410` on every mutation, history still readable to its
   * members — and its members get the same `room.updated`. `archived` is the
   * ONLY key: renaming and settings stay with the room's members.
   */
  app.patch<{ Params: { orgId: string; roomId: string } }>(
    '/api/v1/orgs/:orgId/rooms/:roomId',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      requireMembership(ctx.db, request.params.orgId, human.id, 'admin');
      const body = parse(UpdateOrgRoomRequestSchema, request.body);
      const room = ctx.db.select().from(rooms).where(eq(rooms.id, request.params.roomId)).get();
      // A room of another org, or a DM, is simply not governable here.
      if (!room || room.orgId !== request.params.orgId || room.kind === 'dm') {
        throw notFound('No such room');
      }
      const archivedAt = body.archived ? nowIso() : null;
      if ((room.archivedAt ?? null) !== archivedAt) {
        ctx.db.update(rooms).set({ archivedAt }).where(eq(rooms.id, room.id)).run();
      }
      const updated = ctx.db.select().from(rooms).where(eq(rooms.id, room.id)).get()!;
      emitRoomUpdated(ctx, updated);
      const response: UpdateOrgRoomResponse = { room: toOrgRoomSummary(ctx, updated) };
      return reply.send(response);
    },
  );

  /* ------------------------------ CreateRoom ------------------------- */
  app.post<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/rooms', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const m = requireMembership(ctx.db, request.params.orgId, human.id);
    // rooms.create policy: 'members' (default) or 'admins'.
    const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
    const policy = parseOrgSettings(org?.settings);
    if (policy.rooms.create === 'admins' && !roleAtLeast(m.role as OrgRole, 'admin')) {
      throw forbidden('Only admins can create rooms in this org');
    }
    const body = parse(CreateRoomRequestSchema, request.body);
    const ts = nowIso();
    const roomId = newRoomId();
    ctx.db.transaction((tx) => {
      tx.insert(rooms)
        .values({
          id: roomId,
          orgId: request.params.orgId,
          name: body.name,
          kind: 'project',
          dmKey: null,
          archivedAt: null,
          settings: '{}',
          createdAt: ts,
        })
        .run();
      tx.insert(members)
        .values({
          id: newMemberId(),
          roomId,
          principalType: 'human',
          principalId: human.id,
          roomRole: 'owner',
          lastSeenAt: ts,
          createdAt: ts,
        })
        .run();
    });
    const room = ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get()!;
    const response: CreateRoomResponse = { room: toRoom(room) };
    return reply.code(201).send(response);
  });

  /* ------------------------------- GetRoom --------------------------- */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const { room } = requireRoomMember(ctx, request, request.params.roomId, principal);
    const response: GetRoomResponse = toRoom(room);
    return reply.send(response);
  });

  /* ------------------------------ UpdateRoom ------------------------- */
  app.patch<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
    assertNotDm(caller.room);
    const body = parse(UpdateRoomRequestSchema, request.body);

    // Archived tombstone: PATCH is refused (410) unless it is exactly the restore.
    if (caller.room.archivedAt && body.archived !== false) {
      throw gone('This room is archived');
    }

    const rank = effectiveRoomRank(ctx, caller, principal.type);
    const needsOwner = body.archived !== undefined;
    const need = needsOwner ? roomRoleRank('owner') : roomRoleRank('admin');
    if (rank < need) throw forbidden('You do not have permission to change this room');

    const updates: Partial<typeof rooms.$inferInsert> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.settings !== undefined) updates.settings = JSON.stringify(body.settings);
    if (body.archived !== undefined) updates.archivedAt = body.archived ? nowIso() : null;
    if (Object.keys(updates).length > 0) {
      ctx.db.update(rooms).set(updates).where(eq(rooms.id, caller.room.id)).run();
    }
    const updated = ctx.db.select().from(rooms).where(eq(rooms.id, caller.room.id)).get()!;
    emitRoomUpdated(ctx, updated);
    const response: UpdateRoomResponse = { room: toRoom(updated) };
    return reply.send(response);
  });

  /* ------------------------------ ListMembers ------------------------ */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/members', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    requireRoomMember(ctx, request, request.params.roomId, principal);
    const query = parse(PageQuerySchema, request.query ?? {});
    const limit = resolveLimit(query.limit);
    const cursor = cursorCondition(members.createdAt, members.id, query.cursor);
    const where = withCursor(eq(members.roomId, request.params.roomId), cursor);
    const rows = ctx.db
      .select()
      .from(members)
      .where(where)
      .orderBy(asc(members.createdAt), asc(members.id))
      .limit(limit + 1)
      .all();
    const response: ListMembersResponse = pageResult(
      rows,
      limit,
      (r) => toMember(ctx, r),
      (r) => ({ createdAt: r.createdAt, id: r.id }),
    );
    return reply.send(response);
  });

  /* ------------------------------- GetMember ------------------------- */
  app.get<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/members/:id',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      requireRoomMember(ctx, request, request.params.roomId, principal);
      const target = resolveMemberTarget(ctx, request.params.roomId, request.params.id);
      if (!target) throw notFound('No such member');
      const response: GetMemberResponse = toMember(ctx, target);
      return reply.send(response);
    },
  );

  /* ------------------------------- AddMember ------------------------- */
  app.post<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/members', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
    assertNotDm(caller.room);
    assertNotArchived(caller.room);
    const body = parse(AddMemberRequestSchema, request.body);
    // Agents only — humans are never added directly (invite them instead).
    if (!body.principal.startsWith('agt_')) {
      throw badRequest('Only agents can be added directly; invite humans instead');
    }
    const agent = agentById(ctx, body.principal);
    if (!agent || agent.orgId !== caller.room.orgId) throw forbidden('No such agent');
    // Caller must hold visibility on the agent (owner or grantee) — humans only.
    if (principal.type !== 'human' || !canAccessAgent(ctx, agent, principal.human.id)) {
      throw forbidden('You do not have access to that agent');
    }
    if (memberOf(ctx, caller.room.id, 'agent', agent.id)) {
      throw conflict('That agent is already a member of this room');
    }
    const ts = nowIso();
    const memberId = newMemberId();
    ctx.db
      .insert(members)
      .values({
        id: memberId,
        roomId: caller.room.id,
        principalType: 'agent',
        principalId: agent.id,
        roomRole: 'member',
        lastSeenAt: null,
        createdAt: ts,
      })
      .run();
    const member = toMember(ctx, ctx.db.select().from(members).where(eq(members.id, memberId)).get()!);
    emitMemberJoined(ctx, caller.room.id, member);
    ctx.rooms.onMembershipChanged('agent', agent.id);
    const response: MemberResponse = { member };
    return reply.code(201).send(response);
  });

  /* ----------------------------- SetMemberRole ---------------------- */
  app.patch<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/members/:id',
    (request, reply) => {
      const principal = resolvePrincipal(ctx, request);
      const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
      assertNotDm(caller.room);
      assertNotArchived(caller.room);
      const target = resolveMemberTarget(ctx, caller.room.id, request.params.id);
      if (!target) throw notFound('No such member');
      // Roles above member require a human principal; setting an agent role → 400.
      if (target.principalType === 'agent') {
        throw badRequest('Agents cannot hold a room role above member');
      }
      const body = parse(SetMemberRoleRequestSchema, request.body);
      const currentRole = target.roomRole as RoomRole;
      const nextRole = body.roomRole;
      const rank = effectiveRoomRank(ctx, caller, principal.type);
      // Touching an owner (as current or next) requires owner capability; else admin.
      const touchesOwner = currentRole === 'owner' || nextRole === 'owner';
      const need = touchesOwner ? roomRoleRank('owner') : roomRoleRank('admin');
      if (rank < need) throw forbidden('You do not have permission to change roles');
      if (
        currentRole === 'owner' &&
        nextRole !== 'owner' &&
        roomOwnerCount(ctx, caller.room.id) === 1
      ) {
        throw conflict('The last owner cannot be demoted — promote another owner first');
      }
      if (currentRole !== nextRole) {
        ctx.db.update(members).set({ roomRole: nextRole }).where(eq(members.id, target.id)).run();
      }
      const member = toMember(ctx, ctx.db.select().from(members).where(eq(members.id, target.id)).get()!);
      emitMemberUpdated(ctx, caller.room.id, member);
      const response: MemberResponse = { member };
      return reply.send(response);
    },
  );

  /* ------------------------------ RemoveMember ---------------------- */
  app.delete<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/members/:id',
    (request, reply) => {
      const principal = resolvePrincipal(ctx, request);
      const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
      assertNotDm(caller.room);
      assertNotArchived(caller.room);
      const target = resolveMemberTarget(ctx, caller.room.id, request.params.id);
      if (!target) throw notFound('No such member');
      if (target.id === caller.member.id) throw badRequest('Use leave to remove yourself');

      const targetRole = target.roomRole as RoomRole;
      const rank = effectiveRoomRank(ctx, caller, principal.type);
      // The agent's owner may always remove it, regardless of room role.
      const isAgentsOwner =
        target.principalType === 'agent' &&
        principal.type === 'human' &&
        agentById(ctx, target.principalId)?.ownerHumanId === principal.human.id;
      if (!isAgentsOwner) {
        const need = targetRole === 'owner' ? roomRoleRank('owner') : roomRoleRank('admin');
        if (rank < need) throw forbidden('You do not have permission to remove that member');
      }
      if (
        targetRole === 'owner' &&
        roomOwnerCount(ctx, caller.room.id) === 1 &&
        !caller.instanceAdmin
      ) {
        throw conflict('The last owner cannot be removed — transfer or archive first');
      }
      const displayName = toMember(ctx, target).displayName;
      ctx.db.delete(members).where(eq(members.id, target.id)).run();
      emitMemberRemoved(ctx, caller.room.id, { id: target.id, displayName });
      ctx.rooms.onMembershipChanged(target.principalType as 'human' | 'agent', target.principalId);
      return reply.send({ ok: true });
    },
  );

  /* ----------------------------- InviteHuman ------------------------ */
  app.post<{ Params: { roomId: string } }>(
    '/api/v1/rooms/:roomId/invitations',
    (request, reply) => {
      const principal = resolvePrincipal(ctx, request);
      const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
      assertNotDm(caller.room);
      assertNotArchived(caller.room);
      if (effectiveRoomRank(ctx, caller, principal.type) < roomRoleRank('admin')) {
        throw forbidden('Only room admins can invite people');
      }
      const body = parse(InviteHumanRequestSchema, request.body);
      const target = resolveHumanByIdOrEmail(ctx, body.human);
      if (!target || !membershipOf(ctx.db, caller.room.orgId, target.id)) {
        throw badRequest('That person is not a member of this org');
      }
      if (memberOf(ctx, caller.room.id, 'human', target.id)) {
        throw conflict('That person is already a member of this room');
      }
      const existing = ctx.db
        .select()
        .from(roomInvitations)
        .where(
          and(
            eq(roomInvitations.roomId, caller.room.id),
            eq(roomInvitations.humanId, target.id),
            eq(roomInvitations.status, 'pending'),
          ),
        )
        .get();
      if (existing) {
        const response: InviteHumanResponse = { invitation: adminInvitation(ctx, existing) };
        return reply.code(200).send(response);
      }
      const ts = nowIso();
      const row = {
        id: newRoomInvitationId(),
        roomId: caller.room.id,
        humanId: target.id,
        invitedByHumanId: principal.type === 'human' ? principal.human.id : caller.member.principalId,
        status: 'pending' as const,
        createdAt: ts,
        resolvedAt: null,
      };
      ctx.db.insert(roomInvitations).values(row).run();
      ctx.bus.publish('human', target.id, 'room.invitation', {
        invitation: inviteeInvitation(ctx, row),
      });
      const response: InviteHumanResponse = { invitation: adminInvitation(ctx, row) };
      return reply.code(201).send(response);
    },
  );

  /* ---------------------------- ListInvitations --------------------- */
  app.get<{ Params: { roomId: string } }>(
    '/api/v1/rooms/:roomId/invitations',
    (request, reply) => {
      const principal = resolvePrincipal(ctx, request);
      const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
      if (effectiveRoomRank(ctx, caller, principal.type) < roomRoleRank('admin')) {
        throw forbidden('Only room admins can view invitations');
      }
      const rows = ctx.db
        .select()
        .from(roomInvitations)
        .where(
          and(
            eq(roomInvitations.roomId, caller.room.id),
            eq(roomInvitations.status, 'pending'),
          ),
        )
        .orderBy(asc(roomInvitations.createdAt), asc(roomInvitations.id))
        .all();
      const response: ListRoomInvitationsResponse = {
        items: rows.map((r) => adminInvitation(ctx, r)),
      };
      return reply.send(response);
    },
  );

  /* ---------------------------- RevokeInvitation -------------------- */
  app.delete<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/invitations/:id',
    (request, reply) => {
      const principal = resolvePrincipal(ctx, request);
      const caller = requireRoomMember(ctx, request, request.params.roomId, principalIdent(principal));
      if (effectiveRoomRank(ctx, caller, principal.type) < roomRoleRank('admin')) {
        throw forbidden('Only room admins can revoke invitations');
      }
      const row = ctx.db
        .select()
        .from(roomInvitations)
        .where(
          and(eq(roomInvitations.id, request.params.id), eq(roomInvitations.roomId, caller.room.id)),
        )
        .get();
      if (!row) throw notFound('No such invitation');
      ctx.db.delete(roomInvitations).where(eq(roomInvitations.id, row.id)).run();
      return reply.send({ ok: true });
    },
  );
}

/** Exported for reuse by the invitee-surface routes (`/me/room-invitations`). */
export { inviteeInvitation };
