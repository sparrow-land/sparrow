/**
 * Invite routes (SPEC "Invites & enrollment"): create/list/revoke the revocable,
 * expiring tokens that are the one door into an org. The `ivk_` token appears
 * exactly once, inside the created invite's `url`.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  CreateInviteRequestSchema,
  type CreateInviteResponse,
  type ListInvitesResponse,
  type Invite,
  type OrgRole,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import { effectiveOrigin } from '../effective-origin.js';
import { humans, invites, orgs } from '../db/schema.js';
import type { InviteRow } from '../db/schema.js';
import { parse } from '../validate.js';
import { forbidden, notFound } from '../errors.js';
import { parseOrgSettings, requireMembership, roleAtLeast } from '../org-helpers.js';
import { createInvite } from '../invite-helpers.js';

function toInvite(ctx: AppContext, row: InviteRow): Invite {
  // An admin owner invite carries no inviter (NULL); member-created invites
  // always do. Owner invites are never surfaced on this member-facing list.
  const inviter = row.inviterHumanId
    ? ctx.db.select().from(humans).where(eq(humans.id, row.inviterHumanId)).get()
    : undefined;
  return {
    id: row.id,
    inviter: {
      id: inviter?.id ?? row.inviterHumanId ?? '',
      displayName: inviter?.displayName ?? '',
    },
    note: row.note ?? null,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ?? null,
    createdAt: row.createdAt,
  };
}

export function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* --------------------------- create ------------------------------- */
  app.post<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/invites',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const membership = requireMembership(ctx.db, request.params.orgId, human.id);
      const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
      if (!org) throw notFound('No such org');
      const settings = parseOrgSettings(org.settings);
      if (settings.invites.who === 'admins' && !roleAtLeast(membership.role as OrgRole, 'admin')) {
        throw forbidden('Only admins may create invites in this org');
      }
      const body = parse(CreateInviteRequestSchema, request.body ?? {});
      const { row, token } = createInvite(ctx, {
        orgId: org.id,
        inviterHumanId: human.id,
        note: body.note ?? null,
        expiresInDays: body.expiresInDays,
      });
      const response: CreateInviteResponse = {
        invite: toInvite(ctx, row),
        url: `${effectiveOrigin(request, ctx.config)}/invite/${token}`,
      };
      return reply.code(201).send(response);
    },
  );

  /* --------------------------- list --------------------------------- */
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/invites',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const membership = requireMembership(ctx.db, request.params.orgId, human.id);
      const seeAll = roleAtLeast(membership.role as OrgRole, 'admin');
      const rows = ctx.db
        .select()
        .from(invites)
        .where(
          seeAll
            ? eq(invites.orgId, request.params.orgId)
            : and(
                eq(invites.orgId, request.params.orgId),
                eq(invites.inviterHumanId, human.id),
              ),
        )
        .orderBy(asc(invites.createdAt), asc(invites.id))
        .all();
      const response: ListInvitesResponse = { items: rows.map((r) => toInvite(ctx, r)) };
      return reply.send(response);
    },
  );

  /* --------------------------- revoke ------------------------------- */
  app.delete<{ Params: { orgId: string; id: string } }>(
    '/api/v1/orgs/:orgId/invites/:id',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const membership = requireMembership(ctx.db, request.params.orgId, human.id);
      const row = ctx.db
        .select()
        .from(invites)
        .where(and(eq(invites.id, request.params.id), eq(invites.orgId, request.params.orgId)))
        .get();
      if (!row) throw notFound('No such invite');
      const isInviter = row.inviterHumanId === human.id;
      const isManager = roleAtLeast(membership.role as OrgRole, 'admin');
      if (!isInviter && !isManager) {
        throw forbidden('Only the inviter or an org admin may revoke this invite');
      }
      if (!row.revokedAt) {
        ctx.db
          .update(invites)
          .set({ revokedAt: nowIso() })
          .where(eq(invites.id, row.id))
          .run();
      }
      return reply.send({ ok: true });
    },
  );
}
