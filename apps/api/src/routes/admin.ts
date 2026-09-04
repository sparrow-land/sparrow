/**
 * Admin routes (SPEC "Admin"): the `X-Admin-Token`-only instance surface. When
 * `ADMIN_TOKEN` is unset every admin path `404`s; a wrong token → `401`.
 * (Admin ROOM routes are Phase 3 — the rooms/messaging layer owns them.)
 */
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  AdminCreateOrgRequestSchema,
  AddOrgMemberRequestSchema,
  newInviteId,
  newInviteToken,
  newUserId,
  INVITE_EXPIRY_DAYS_DEFAULT,
  type AdminCreateOrgResponse,
  type AdminListOrgMembersResponse,
  type AdminAddOrgMemberResponse,
  type AdminRemoveOrgMemberResponse,
  type ListAdminOrgsResponse,
  type ListAdminRoomsResponse,
  type OrgRole,
  type RoomKind,
} from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import { toHumanContact } from '../avatar-helpers.js';
import { effectiveOrigin } from '../effective-origin.js';
import {
  activityEntries,
  agents,
  agentVisibility,
  attachments,
  enrollments,
  humans,
  invites,
  members,
  messages,
  messageRecipients,
  orgs,
  orgMemberships,
  roomInvitations,
  rooms,
  userSessions,
} from '../db/schema.js';
import type { InviteRow } from '../db/schema.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import {
  addMemberByEmail,
  createOrg,
  createOwnerlessOrg,
  membershipOf,
  removeOrgMembership,
  toOrg,
} from '../org-helpers.js';
import { parse } from '../validate.js';
import { deleteAgentEmailCascade, deleteOrgEmailCascade } from '../email/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Admin auth (v3): the `X-Admin-Token` header must equal `ADMIN_TOKEN`. `404`
 * when `ADMIN_TOKEN` is unset (routes hidden); `401` on a wrong/absent token.
 */
export function adminGuard(ctx: AppContext, request: FastifyRequest): void {
  if (!ctx.config.adminToken) throw notFound('Not found');
  if (request.headers['x-admin-token'] !== ctx.config.adminToken) {
    throw unauthorized('Invalid admin token');
  }
}

function deleteRoomsCascade(ctx: AppContext, roomIds: string[]): void {
  if (roomIds.length === 0) return;
  const msgIds = ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.roomId, roomIds))
    .all()
    .map((m) => m.id);
  const attRows =
    msgIds.length > 0
      ? ctx.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(inArray(attachments.messageId, msgIds))
          .all()
      : [];
  ctx.db.transaction((tx) => {
    if (msgIds.length > 0) {
      tx.delete(attachments).where(inArray(attachments.messageId, msgIds)).run();
      tx.delete(messageRecipients).where(inArray(messageRecipients.messageId, msgIds)).run();
    }
    tx.delete(messages).where(inArray(messages.roomId, roomIds)).run();
    tx.delete(members).where(inArray(members.roomId, roomIds)).run();
    tx.delete(roomInvitations).where(inArray(roomInvitations.roomId, roomIds)).run();
    tx.delete(rooms).where(inArray(rooms.id, roomIds)).run();
  });
  for (const a of attRows) {
    try {
      unlinkSync(path.join(ctx.handle.attachmentsDir, a.id));
    } catch {
      /* ignore missing files */
    }
  }
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- POST /admin/orgs ------------------ */
  // Provision an org. Two modes (see AdminCreateOrgRequestSchema):
  //
  // - **owner-pending** (no `owner`): create an org with no members and mint its
  //   owner invite — whoever redeems the returned `url` becomes the first
  //   `owner`. The invite carries a NULL inviter — the signal that redeeming it
  //   grants `owner` (see enrollment).
  // - **pre-provisioned owner** (`owner` present): create the org AND add
  //   `owner.email` as its `owner`, resolving an existing human by (normalized)
  //   email or creating one (no password, provider `admin`). No invite is
  //   minted; `url` is the org's base URL (effective-origin org host) and the
  //   response carries `owner`.
  //
  // Slug rules mirror POST /orgs (reserved/taken → 409, invalid → 400).
  app.post('/api/v1/admin/orgs', (request, reply) => {
    adminGuard(ctx, request);
    const body = parse(AdminCreateOrgRequestSchema, request.body);

    if (body.owner) {
      const email = body.owner.email.trim().toLowerCase();
      // Resolve the human by email, or create an externally-provisioned account
      // (no password; `provider: 'admin'` records how it was minted). An existing
      // human is reused as-is — their other memberships are never touched.
      let human = ctx.auth.humanByEmail(email);
      if (!human) {
        human = {
          id: newUserId(),
          email,
          displayName: body.owner.displayName?.trim() || email,
          passwordHash: null,
          provider: 'admin',
          avatarAttachment: null,
          providerAvatarUrl: null,
          theme: null,
          createdAt: nowIso(),
        };
        ctx.db.insert(humans).values(human).run();
      }
      // Create the org with this human as owner (NOT owner-pending; no invite).
      const org = createOrg(ctx.db, { name: body.name, slug: body.slug, ownerHumanId: human.id });
      const response: AdminCreateOrgResponse = {
        org: toOrg(org),
        url: effectiveOrigin(request, ctx.config),
        owner: { id: human.id, email: human.email },
      };
      return reply.code(201).send(response);
    }

    const org = createOwnerlessOrg(ctx.db, { name: body.name, slug: body.slug });
    const token = newInviteToken();
    const createdAt = nowIso();
    const expiresAt = new Date(
      Date.parse(createdAt) + INVITE_EXPIRY_DAYS_DEFAULT * DAY_MS,
    ).toISOString();
    const invite: InviteRow = {
      id: newInviteId(),
      orgId: org.id,
      inviterHumanId: null,
      tokenHash: sha256Hex(token),
      note: null,
      expiresAt,
      revokedAt: null,
      createdAt,
    };
    ctx.db.insert(invites).values(invite).run();
    const response: AdminCreateOrgResponse = {
      org: toOrg(org),
      url: `${effectiveOrigin(request, ctx.config)}/invite/${token}`,
    };
    return reply.code(201).send(response);
  });

  /* ------------------------------- GET /admin/orgs ------------------- */
  app.get('/api/v1/admin/orgs', (request, reply) => {
    adminGuard(ctx, request);
    const rows = ctx.db.select().from(orgs).all();
    const items = rows.map((org) => {
      const humanCount =
        ctx.db
          .select({ n: sql<number>`count(*)` })
          .from(orgMemberships)
          .where(eq(orgMemberships.orgId, org.id))
          .get()?.n ?? 0;
      const agentCount =
        ctx.db
          .select({ n: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.orgId, org.id))
          .get()?.n ?? 0;
      const roomCount =
        ctx.db
          .select({ n: sql<number>`count(*)` })
          .from(rooms)
          .where(eq(rooms.orgId, org.id))
          .get()?.n ?? 0;
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        humanCount,
        agentCount,
        roomCount,
        createdAt: org.createdAt,
      };
    });
    const response: ListAdminOrgsResponse = { items };
    return reply.send(response);
  });

  /* ------------------------------- DELETE /admin/orgs/:id ------------ */
  app.delete<{ Params: { id: string } }>('/api/v1/admin/orgs/:id', (request, reply) => {
    adminGuard(ctx, request);
    const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.id)).get();
    if (!org) throw notFound('No such org');
    const orgId = org.id;
    const roomIds = ctx.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.orgId, orgId))
      .all()
      .map((r) => r.id);
    const agentIds = ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .all()
      .map((a) => a.id);
    deleteRoomsCascade(ctx, roomIds);
    ctx.db.transaction((tx) => {
      if (agentIds.length > 0) {
        tx.delete(agentVisibility).where(inArray(agentVisibility.agentId, agentIds)).run();
      }
      tx.delete(agents).where(eq(agents.orgId, orgId)).run();
      // Layer 3: activity entries are durable ORG data and cascade with the org.
      tx.delete(activityEntries).where(eq(activityEntries.orgId, orgId)).run();
      tx.delete(enrollments).where(eq(enrollments.orgId, orgId)).run();
      tx.delete(invites).where(eq(invites.orgId, orgId)).run();
      tx.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId)).run();
      tx.delete(orgs).where(eq(orgs.id, orgId)).run();
    });
    // The email medium: an org's mail AND its external contacts go with it.
    deleteOrgEmailCascade(ctx, orgId);
    return reply.send({ ok: true });
  });

  /* ---------------------- GET /admin/orgs/:orgId/members ------------- */
  // The org roster for the control plane: same `{ human, role }` shape as the
  // session roster (minus `joinedAt`), unpaged. Unknown org → 404.
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/admin/orgs/:orgId/members',
    (request, reply) => {
      adminGuard(ctx, request);
      const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
      if (!org) throw notFound('No such org');
      const rows = ctx.db
        .select({ human: humans, role: orgMemberships.role })
        .from(orgMemberships)
        .innerJoin(humans, eq(humans.id, orgMemberships.humanId))
        .where(eq(orgMemberships.orgId, org.id))
        .orderBy(asc(orgMemberships.createdAt), asc(orgMemberships.humanId))
        .all();
      const response: AdminListOrgMembersResponse = {
        members: rows.map((r) => ({
          human: toHumanContact(ctx, r.human),
          role: r.role as OrgRole,
        })),
      };
      return reply.send(response);
    },
  );

  /* ---------------------- POST /admin/orgs/:orgId/members ------------ */
  // Control-plane direct add: resolve-or-provision the human + add the
  // membership (shared machinery with the session add-by-email) but mint NO
  // invite and send NO email — the control plane adds members directly. Already
  // a member → 409; invalid email / role owner → 400 (schema); unknown org → 404.
  app.post<{ Params: { orgId: string } }>(
    '/api/v1/admin/orgs/:orgId/members',
    (request, reply) => {
      adminGuard(ctx, request);
      const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
      if (!org) throw notFound('No such org');
      const body = parse(AddOrgMemberRequestSchema, request.body);
      const role: OrgRole = body.role ?? 'member';
      const { human } = addMemberByEmail(ctx, org.id, { email: body.email, role });
      const response: AdminAddOrgMemberResponse = {
        member: {
          human: toHumanContact(ctx, human),
          role,
        },
      };
      return reply.code(201).send(response);
    },
  );

  /* ------------------- DELETE /admin/orgs/:orgId/members/:humanId ---- */
  // Control-plane removal: enforces the SAME data invariants as the session
  // removal (owns-agents → 409, last-owner → 409) via the shared helper, so an
  // admin removal can't corrupt them. Unknown org/human/membership → 404.
  app.delete<{ Params: { orgId: string; humanId: string } }>(
    '/api/v1/admin/orgs/:orgId/members/:humanId',
    (request, reply) => {
      adminGuard(ctx, request);
      const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
      if (!org) throw notFound('No such org');
      const membership = membershipOf(ctx.db, org.id, request.params.humanId);
      if (!membership) throw notFound('No such member');
      removeOrgMembership(ctx, org.id, request.params.humanId, membership.role as OrgRole);
      const response: AdminRemoveOrgMemberResponse = { removed: true };
      return reply.send(response);
    },
  );

  /* ------------------------------- GET /admin/rooms ------------------ */
  app.get<{ Querystring: { org?: string } }>('/api/v1/admin/rooms', (request, reply) => {
    adminGuard(ctx, request);
    const all = ctx.db.select().from(rooms).all();
    const filtered = request.query.org ? all.filter((r) => r.orgId === request.query.org) : all;
    const items = filtered
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((room) => {
        const memberCount =
          ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(members)
            .where(eq(members.roomId, room.id))
            .get()?.n ?? 0;
        const messageCount =
          ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(messages)
            .where(eq(messages.roomId, room.id))
            .get()?.n ?? 0;
        return {
          id: room.id,
          orgId: room.orgId,
          name: room.name,
          kind: room.kind as RoomKind,
          archivedAt: room.archivedAt ?? null,
          memberCount,
          messageCount,
          createdAt: room.createdAt,
        };
      });
    const response: ListAdminRoomsResponse = { items };
    return reply.send(response);
  });

  /* ------------------------------- DELETE /admin/rooms/:id ----------- */
  app.delete<{ Params: { id: string } }>('/api/v1/admin/rooms/:id', (request, reply) => {
    adminGuard(ctx, request);
    const room = ctx.db.select().from(rooms).where(eq(rooms.id, request.params.id)).get();
    if (!room) throw notFound('No such room');
    deleteRoomsCascade(ctx, [room.id]);
    ctx.statuses.clearRoom(room.id);
    return reply.send({ ok: true });
  });

  /* ------------------------------- DELETE /admin/agents/:id ---------- */
  app.delete<{ Params: { id: string } }>('/api/v1/admin/agents/:id', (request, reply) => {
    adminGuard(ctx, request);
    const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
    if (!agent) throw notFound('No such agent');
    ctx.db.transaction((tx) => {
      tx.delete(members)
        .where(eq(members.principalId, agent.id))
        .run();
      tx.delete(agentVisibility).where(eq(agentVisibility.agentId, agent.id)).run();
      // Deleting an agent takes its timeline with it (SPEC "Unified attention →
      // Retention"), the same cascade the owner-facing delete performs.
      tx.delete(activityEntries).where(eq(activityEntries.agentId, agent.id)).run();
      tx.delete(agents).where(eq(agents.id, agent.id)).run();
    });
    deleteAgentEmailCascade(ctx, [agent.id]);
    return reply.send({ ok: true });
  });

  /* ------------------------------- DELETE /admin/humans/:id ---------- */
  app.delete<{ Params: { id: string } }>('/api/v1/admin/humans/:id', (request, reply) => {
    adminGuard(ctx, request);
    const human = ctx.db.select().from(humans).where(eq(humans.id, request.params.id)).get();
    if (!human) throw notFound('No such human');
    const ownsAgent = ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.ownerHumanId, human.id))
      .get();
    if (ownsAgent) {
      throw conflict('This account still owns agents — delete them first');
    }
    ctx.db.transaction((tx) => {
      tx.delete(orgMemberships).where(eq(orgMemberships.humanId, human.id)).run();
      tx.delete(members)
        .where(eq(members.principalId, human.id))
        .run();
      tx.delete(agentVisibility).where(eq(agentVisibility.humanId, human.id)).run();
      tx.delete(userSessions).where(eq(userSessions.humanId, human.id)).run();
      tx.delete(humans).where(eq(humans.id, human.id)).run();
    });
    return reply.send({ ok: true });
  });
}
