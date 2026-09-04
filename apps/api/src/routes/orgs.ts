/**
 * Org routes (SPEC "Orgs"): the caller's orgs, org creation (subject to
 * `orgs.openCreation`), org read/update, the human roster with role management +
 * removal (last-owner + owns-agents guards), the directory search, and the
 * governance agent list. All session-authed.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  CreateOrgRequestSchema,
  UpdateOrgRequestSchema,
  SetOrgRoleRequestSchema,
  AddOrgMemberRequestSchema,
  PageQuerySchema,
  type CreateOrgResponse,
  type GetOrgResponse,
  type MeOrgsResponse,
  type ListOrgHumansResponse,
  type AddOrgMemberResponse,
  type DirectoryResponse,
  type ListOrgAgentsResponse,
  type ResolveOrgResponse,
  type OrgRole,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { agents, humans, orgs, orgMemberships } from '../db/schema.js';
import { agentEmailAddress } from '../agent-helpers.js';
import { parse } from '../validate.js';
import { conflict, forbidden, notFound } from '../errors.js';
import {
  addMemberByEmail,
  createOrg,
  isReservedSlug,
  membershipOf,
  mergeOrgSettings,
  ownerCount,
  parseOrgSettings,
  regeneratedSlug,
  removeOrgMembership,
  requireMembership,
  toOrg,
} from '../org-helpers.js';
import { toHumanContact } from '../avatar-helpers.js';
import { resolveLimit, cursorCondition, withCursor, pageResult } from '../pagination.js';
import { effectiveOrigin } from '../effective-origin.js';
import { createInvite, renderInviteEmail } from '../invite-helpers.js';
import { sendEmail } from '../email.js';

export function registerOrgRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- /me/orgs ---------------------------- */
  app.get('/api/v1/me/orgs', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const rows = ctx.db
      .select({ org: orgs, role: orgMemberships.role, createdAt: orgMemberships.createdAt })
      .from(orgMemberships)
      .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
      .where(eq(orgMemberships.humanId, human.id))
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const response: MeOrgsResponse = {
      items: rows.map((r) => ({
        org: { id: r.org.id, name: r.org.name, slug: r.org.slug },
        role: r.role as OrgRole,
      })),
    };
    return reply.send(response);
  });

  /* ------------------------------- POST /orgs -------------------------- */
  app.post('/api/v1/orgs', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    if (!ctx.configStore.getBoolean('orgs.openCreation')) {
      throw forbidden('Creating new workspaces is disabled on this instance');
    }
    const body = parse(CreateOrgRequestSchema, request.body);
    const org = createOrg(ctx.db, {
      name: body.name,
      slug: body.slug,
      ownerHumanId: human.id,
    });
    const response: CreateOrgResponse = { org: toOrg(org) };
    return reply.code(201).send(response);
  });

  /* ------------------------------- GET /orgs/resolve/:slug ------------- */
  // The slug→org seam (SPEC "Org resolution is a seam"). Session-authed; returns
  // the org summary + the caller's role ONLY for a member. A non-member and an
  // unknown slug both 404 — orgs never leak their existence. Backs host/path
  // scoped SPA boot (`<slug><suffix>` or `/orgs/:slug`); the wire stays canonical
  // org-id-in-URL. Declared before `/orgs/:orgId` for clarity (paths differ in
  // depth, so ordering is not load-bearing).
  app.get<{ Params: { slug: string } }>('/api/v1/orgs/resolve/:slug', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const org = ctx.db.select().from(orgs).where(eq(orgs.slug, request.params.slug)).get();
    if (!org) throw notFound('No such org');
    const membership = membershipOf(ctx.db, org.id, human.id);
    if (!membership) throw notFound('No such org');
    const response: ResolveOrgResponse = {
      org: { id: org.id, name: org.name, slug: org.slug },
      role: membership.role as OrgRole,
    };
    return reply.send(response);
  });

  /* ------------------------------- GET /orgs/:orgId -------------------- */
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    requireMembership(ctx.db, request.params.orgId, human.id);
    const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
    if (!org) throw notFound('No such org');
    const response: GetOrgResponse = { org: toOrg(org) };
    return reply.send(response);
  });

  /* ------------------------------- PATCH /orgs/:orgId ----------------- */
  app.patch<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    requireMembership(ctx.db, request.params.orgId, human.id, 'admin');
    const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
    if (!org) throw notFound('No such org');
    const body = parse(UpdateOrgRequestSchema, request.body);

    const updates: Partial<typeof orgs.$inferInsert> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.slug !== undefined && body.slug !== org.slug) {
      // Same rules as creation (`resolveNewSlug`): a rename must not move the
      // org onto a reserved route/host name any more than founding may.
      if (isReservedSlug(body.slug)) throw conflict('That workspace address is reserved');
      const taken = ctx.db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, body.slug)).get();
      if (taken) throw conflict('That workspace address is taken');
      updates.slug = body.slug;
      // Naming an address makes it YOURS: it is now permanent, and no later
      // rename regenerates it.
      updates.slugCustom = 1;
    } else if (body.name !== undefined && body.name !== org.name) {
      // A RENAME regenerates a slug we derived in the first place — the bootstrap
      // org founded as "alice@example.com's org" should not be stuck at
      // `alice-example-coms-org` forever. A slug someone CHOSE (and one whose
      // provenance predates the flag) is never touched; `regeneratedSlug` also
      // returns undefined when the new name derives the slug the org already has.
      const next = regeneratedSlug(ctx.db, org, body.name);
      if (next !== undefined) updates.slug = next;
    }
    // `settings` is a merge-patch: fold what the body names into the stored
    // policy and persist the COMPLETE result, so the response below (which
    // re-reads the row) is exactly the new persisted state.
    if (body.settings !== undefined) {
      updates.settings = JSON.stringify(
        mergeOrgSettings(parseOrgSettings(org.settings), body.settings),
      );
    }

    if (Object.keys(updates).length > 0) {
      ctx.db.update(orgs).set(updates).where(eq(orgs.id, org.id)).run();
    }
    const updated = ctx.db.select().from(orgs).where(eq(orgs.id, org.id)).get()!;
    const response: GetOrgResponse = { org: toOrg(updated) };
    return reply.send(response);
  });

  /* ------------------------------- GET /orgs/:orgId/humans ------------ */
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/humans',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      requireMembership(ctx.db, request.params.orgId, human.id);
      const query = parse(PageQuerySchema, request.query ?? {});
      const limit = resolveLimit(query.limit);
      const cursor = cursorCondition(
        orgMemberships.createdAt,
        orgMemberships.humanId,
        query.cursor,
      );
      const where = withCursor(eq(orgMemberships.orgId, request.params.orgId), cursor);
      const rows = ctx.db
        .select({ human: humans, role: orgMemberships.role, joinedAt: orgMemberships.createdAt })
        .from(orgMemberships)
        .innerJoin(humans, eq(humans.id, orgMemberships.humanId))
        .where(where)
        .orderBy(asc(orgMemberships.createdAt), asc(orgMemberships.humanId))
        .limit(limit + 1)
        .all();
      const response: ListOrgHumansResponse = pageResult(
        rows,
        limit,
        (r) => ({
          human: toHumanContact(ctx, r.human),
          role: r.role as OrgRole,
          joinedAt: r.joinedAt,
        }),
        (r) => ({ createdAt: r.joinedAt, id: r.human.id }),
      );
      return reply.send(response);
    },
  );

  /* ------------------------------- POST /orgs/:orgId/members ---------- */
  // Owner/admin invites a person to the org by email — the low-friction path.
  // It pre-provisions the human + membership (resolve by normalized email, or
  // mint an externally-provisioned account: no password, provider `admin`) AND
  // mints a standard org invite so the recipient gets a one-click door. If an
  // email webhook is configured, the invitation is emailed; either way the
  // fresh `inviteUrl` is returned so the caller can share it directly.
  //
  // Why an invite token even though the membership is already provisioned: the
  // recipient may sign in under a DIFFERENT email than the one we provisioned.
  // The token admits whoever holds it via the normal invite-redemption flow, so
  // the person lands inside the org regardless of which identity they present
  // (a matching email would resolve to the pre-provisioned human directly; a
  // different one redeems the invite). Already a member → 409; invalid email → 400.
  app.post<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/members', async (request, reply) => {
    const caller = ctx.auth.requireSession(request);
    requireMembership(ctx.db, request.params.orgId, caller.id, 'admin');
    const org = ctx.db.select().from(orgs).where(eq(orgs.id, request.params.orgId)).get();
    if (!org) throw notFound('No such org');
    const body = parse(AddOrgMemberRequestSchema, request.body);
    const role: OrgRole = body.role ?? 'member';

    // Resolve-or-provision the human + add the membership (shared with the admin
    // control-plane add). An existing human is reused as-is — their display name
    // and other memberships are never touched. Already a member → 409.
    const { human } = addMemberByEmail(ctx, org.id, { email: body.email, role });

    // Mint a standard invite (inviter = the acting human), built the same
    // effective-origin way as every other invite so the link lands on the org host.
    const { row: invite, token } = createInvite(ctx, { orgId: org.id, inviterHumanId: caller.id });
    const origin = effectiveOrigin(request, ctx.config);
    const inviteUrl = `${origin}/invite/${token}`;

    // Best-effort invitation email (never fails the request). Sent only when an
    // email webhook is configured; `emailSent` reflects the hook result.
    let emailSent = false;
    const webhookUrl = String(ctx.configStore.get('email.webhookUrl') ?? '');
    if (webhookUrl.trim()) {
      const { subject, text, html } = renderInviteEmail({
        inviterName: caller.displayName,
        orgName: org.name,
        inviteUrl,
      });
      const result = await sendEmail(
        {
          webhookUrl,
          webhookToken: String(ctx.configStore.get('email.webhookToken') ?? ''),
        },
        // The v4 envelope — the ONE outbound mail shape in the system (`to` is
        // always an array; `headers` carries the message identity a relay passes
        // through verbatim).
        {
          from: caller.email,
          to: [human.email],
          subject,
          text,
          html,
          headers: { messageId: `<${invite.id}@${originHost(origin)}>` },
        },
      );
      emailSent = result.sent;
    }

    const response: AddOrgMemberResponse = {
      member: {
        human: toHumanContact(ctx, human),
        role,
      },
      inviteUrl,
      emailSent,
    };
    return reply.code(201).send(response);
  });

  /* ---------------------- PATCH /orgs/:orgId/humans/:humanId ---------- */
  app.patch<{ Params: { orgId: string; humanId: string } }>(
    '/api/v1/orgs/:orgId/humans/:humanId',
    (request, reply) => {
      const caller = ctx.auth.requireSession(request);
      const callerM = requireMembership(ctx.db, request.params.orgId, caller.id, 'admin');
      const body = parse(SetOrgRoleRequestSchema, request.body);
      const target = membershipOf(ctx.db, request.params.orgId, request.params.humanId);
      if (!target) throw notFound('No such member');
      const currentRole = target.role as OrgRole;
      const nextRole = body.role;

      // Admins may only move members between member↔admin; anything touching an
      // owner (as source or target role) requires an owner caller.
      const touchesOwner = currentRole === 'owner' || nextRole === 'owner';
      if (touchesOwner && callerM.role !== 'owner') {
        throw forbidden('Only an owner can manage owner roles');
      }
      // Last-owner demotion → 409.
      if (currentRole === 'owner' && nextRole !== 'owner' && ownerCount(ctx.db, request.params.orgId) === 1) {
        throw conflict('The last owner cannot be demoted — promote another owner first');
      }
      if (currentRole !== nextRole) {
        ctx.db
          .update(orgMemberships)
          .set({ role: nextRole })
          .where(
            and(
              eq(orgMemberships.orgId, request.params.orgId),
              eq(orgMemberships.humanId, request.params.humanId),
            ),
          )
          .run();
      }
      return reply.send({ ok: true });
    },
  );

  /* ---------------------- DELETE /orgs/:orgId/humans/:humanId --------- */
  app.delete<{ Params: { orgId: string; humanId: string } }>(
    '/api/v1/orgs/:orgId/humans/:humanId',
    (request, reply) => {
      const caller = ctx.auth.requireSession(request);
      const orgId = request.params.orgId;
      const targetId = request.params.humanId;
      const isSelf = caller.id === targetId;
      const callerM = requireMembership(ctx.db, orgId, caller.id, isSelf ? 'member' : 'admin');
      const target = membershipOf(ctx.db, orgId, targetId);
      if (!target) throw notFound('No such member');
      const targetRole = target.role as OrgRole;

      // Removing an owner (other than yourself leaving) is owner-only.
      if (!isSelf && targetRole === 'owner' && callerM.role !== 'owner') {
        throw forbidden('Only an owner can remove an owner');
      }
      // Enforce the data invariants (owns-agents / last-owner → 409) and delete
      // the membership + room member rows (shared with the admin removal).
      removeOrgMembership(ctx, orgId, targetId, targetRole);
      return reply.send({ ok: true });
    },
  );

  /* ------------------------------- GET /orgs/:orgId/directory --------- */
  app.get<{ Params: { orgId: string }; Querystring: { q?: string } }>(
    '/api/v1/orgs/:orgId/directory',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      requireMembership(ctx.db, request.params.orgId, human.id);
      const q = (request.query.q ?? '').trim().toLowerCase();
      const rows = ctx.db
        .select({ human: humans })
        .from(orgMemberships)
        .innerJoin(humans, eq(humans.id, orgMemberships.humanId))
        .where(eq(orgMemberships.orgId, request.params.orgId))
        .all()
        .map((r) => r.human)
        .filter(
          (h) =>
            q.length === 0 ||
            h.displayName.toLowerCase().startsWith(q) ||
            h.email.toLowerCase().startsWith(q),
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, 25);
      const response: DirectoryResponse = {
        items: rows.map((h) => toHumanContact(ctx, h)),
      };
      return reply.send(response);
    },
  );

  /* ------------------------------- GET /orgs/:orgId/agents ------------ */
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/agents',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      requireMembership(ctx.db, request.params.orgId, human.id, 'admin');
      const rows = ctx.db
        .select({ agent: agents, owner: humans })
        .from(agents)
        .innerJoin(humans, eq(humans.id, agents.ownerHumanId))
        .where(eq(agents.orgId, request.params.orgId))
        .all()
        .sort((a, b) => a.agent.createdAt.localeCompare(b.agent.createdAt));
      const response: ListOrgAgentsResponse = {
        items: rows.map((r) => ({
          agent: {
            id: r.agent.id,
            name: r.agent.name,
            emailAddress: agentEmailAddress(ctx, r.agent),
            createdAt: r.agent.createdAt,
          },
          owner: { id: r.owner.id, displayName: r.owner.displayName },
        })),
      };
      return reply.send(response);
    },
  );
}

/** The host of an absolute origin — the domain half of a generated Message-ID. */
function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return 'sparrow.local';
  }
}
