/**
 * Enrollment (SPEC "Invites & enrollment"): the knock at `POST /invite/:token/
 * enroll` (anonymous → agent enrollment, session → human enrollment), the poll
 * (`GET /invite/:token/enrollments/:eid`), and the approver surface
 * (list/approve/deny under `/orgs/:orgId/enrollments`). Approving an agent
 * enrollment mints the agent (owner = the inviter), its owner visibility row, and
 * the owner↔agent DM room; the `agk_` key is delivered exactly once on the first
 * approved poll.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  EnrollAgentRequestSchema,
  EnrollHumanRequestSchema,
  newAgentKey,
  newEnrollmentId,
  newEnrollmentToken,
  ENROLLMENT_POLL_RETRY_SECONDS,
  ENROLLMENT_EXPIRY_HOURS,
  ENROLLMENT_RATE_LIMIT,
  type EnrollmentSummary,
  type ListEnrollmentsResponse,
  type InviteInfoResponse,
  type OrgRole,
} from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import { agents, enrollments, humans, invites, orgMemberships, orgs } from '../db/schema.js';
import type { EnrollmentRow, InviteRow } from '../db/schema.js';
import { parse } from '../validate.js';
import { conflict, forbidden, notFound, rateLimited } from '../errors.js';
import { INVITE_UNKNOWN_MESSAGE, requireLiveInvite } from '../invite-helpers.js';
import {
  membershipOf,
  parseOrgSettings,
  roleAtLeast,
} from '../org-helpers.js';
import {
  toAgent,
  agentEmailAddress,
  assertNameAvailable,
  uniqueAgentName,
  insertAgent,
  ensureDmRoom,
  emitEnrollmentRequested,
  emitEnrollmentResolved,
} from '../agent-helpers.js';
import { ensureDmRoomWithEvents } from '../dm-helpers.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Refusal for an approve/deny that arrives after the TTL. Distinct from the
 * "already resolved" a genuine race returns: a stale request approved days
 * later used to mint an orphan agent whose key nobody ever received (issue
 * #53), and the old shared message left the approver unable to tell which had
 * happened.
 */
const ENROLLMENT_EXPIRED_MESSAGE =
  `This request expired (enrollment requests are only approvable for ${ENROLLMENT_EXPIRY_HOURS} hours). ` +
  'Ask the requester to run `sparrow enroll` again.';

/** Resolve an invite by its plaintext `ivk_` token, or undefined. */
function inviteByToken(ctx: AppContext, token: string): InviteRow | undefined {
  return ctx.db.select().from(invites).where(eq(invites.tokenHash, sha256Hex(token))).get();
}

function enrollmentExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + ENROLLMENT_EXPIRY_HOURS * HOUR_MS).toISOString();
}

/** Is this a still-pending enrollment whose TTL has already elapsed? */
function isExpired(row: EnrollmentRow): boolean {
  return row.status === 'pending' && Date.parse(row.expiresAt) <= Date.now();
}

/** A pending enrollment whose TTL elapsed reads as denied; reap it lazily. */
function reapIfExpired(ctx: AppContext, row: EnrollmentRow): EnrollmentRow {
  if (isExpired(row)) {
    const resolvedAt = nowIso();
    ctx.db
      .update(enrollments)
      .set({ status: 'denied', resolvedAt })
      .where(eq(enrollments.id, row.id))
      .run();
    return { ...row, status: 'denied', resolvedAt };
  }
  return row;
}

function insertEnrollment(
  ctx: AppContext,
  input: {
    inviteId: string;
    orgId: string;
    kind: 'human' | 'agent';
    humanId?: string | null;
    proposedName?: string | null;
    note?: string | null;
    tokenHash?: string | null;
    status?: 'pending' | 'approved' | 'denied';
    issuedKey?: string | null;
  },
): EnrollmentRow {
  const createdAt = nowIso();
  const row: EnrollmentRow = {
    id: newEnrollmentId(),
    inviteId: input.inviteId,
    orgId: input.orgId,
    kind: input.kind,
    humanId: input.humanId ?? null,
    proposedName: input.proposedName ?? null,
    note: input.note ?? null,
    tokenHash: input.tokenHash ?? null,
    status: input.status ?? 'pending',
    issuedKey: input.issuedKey ?? null,
    createdAt,
    resolvedAt: input.status && input.status !== 'pending' ? createdAt : null,
    expiresAt: enrollmentExpiresAt(createdAt),
  };
  ctx.db.insert(enrollments).values(row).run();
  return row;
}

function toEnrollmentSummary(ctx: AppContext, row: EnrollmentRow): EnrollmentSummary {
  const invite = ctx.db.select().from(invites).where(eq(invites.id, row.inviteId)).get();
  const inviterRow =
    invite && invite.inviterHumanId
      ? ctx.db.select().from(humans).where(eq(humans.id, invite.inviterHumanId)).get()
      : undefined;
  const summary: EnrollmentSummary = {
    id: row.id,
    kind: row.kind as EnrollmentSummary['kind'],
    proposedName: row.proposedName ?? null,
    note: row.note ?? null,
    inviter: {
      id: inviterRow?.id ?? invite?.inviterHumanId ?? '',
      displayName: inviterRow?.displayName ?? '',
    },
    createdAt: row.createdAt,
  };
  if (row.humanId) {
    const h = ctx.db.select().from(humans).where(eq(humans.id, row.humanId)).get();
    if (h) {
      summary.email = h.email;
      summary.displayName = h.displayName;
    }
  }
  return summary;
}

/** Whether the request carries the instance admin token. */
function adminTokenOk(ctx: AppContext, request: FastifyRequest): boolean {
  return (
    !!ctx.config.adminToken && request.headers['x-admin-token'] === ctx.config.adminToken
  );
}

/**
 * Authorize an approver for a specific enrollment: the instance admin token,
 * an org owner/admin, or the inviter who created the enrollment's invite.
 */
function requireEnrollmentApprover(
  ctx: AppContext,
  request: FastifyRequest,
  orgId: string,
  row: EnrollmentRow,
): void {
  if (adminTokenOk(ctx, request)) return;
  const human = ctx.auth.requireSession(request);
  const membership = membershipOf(ctx.db, orgId, human.id);
  if (membership && roleAtLeast(membership.role as OrgRole, 'admin')) return;
  const invite = ctx.db.select().from(invites).where(eq(invites.id, row.inviteId)).get();
  if (invite && invite.inviterHumanId === human.id) return;
  throw forbidden('You are not an approver for this org');
}

export function registerEnrollmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Per-IP sliding window for the enroll knock (10/hour/IP).
  const enrollHits = new Map<string, number[]>();

  /* ------------------------------- enroll ---------------------------- */
  app.post<{ Params: { token: string } }>('/api/v1/invite/:token/enroll', (request, reply) => {
    // Rate limit: 10/hour/IP.
    const ip = request.ip;
    const now = Date.now();
    const hits = (enrollHits.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (hits.length >= ENROLLMENT_RATE_LIMIT) {
      throw rateLimited('Too many enrollment attempts; slow down');
    }
    hits.push(now);
    enrollHits.set(ip, hits);

    // Unknown → 404; revoked/expired → 410 naming which. Mirrors `…/info` and the
    // doc route exactly: telling the two apart here leaks nothing beyond what
    // `…/info` already answers for the same token, and it is the difference
    // between an agent retrying forever and an agent reporting "ask for a new
    // link" to its human.
    const invite = requireLiveInvite(inviteByToken(ctx, request.params.token));
    const orgRow = ctx.db.select().from(orgs).where(eq(orgs.id, invite.orgId)).get();
    if (!orgRow) throw notFound(INVITE_UNKNOWN_MESSAGE);
    const settings = parseOrgSettings(orgRow.settings);

    const sessionHuman = ctx.auth.sessionHuman(request);

    /* -------- session caller → human enrollment -------- */
    if (sessionHuman) {
      const existingMembership = membershipOf(ctx.db, invite.orgId, sessionHuman.id);
      if (existingMembership) {
        return reply.code(200).send({
          org: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
          role: existingMembership.role as OrgRole,
        });
      }
      // Admin owner invite (NULL inviter): an owner-pending org has no members to
      // review a knock, so the redeemer becomes the org's first `owner`
      // instantly. No inviter → no auto-DM.
      if (invite.inviterHumanId === null) {
        const ts = nowIso();
        ctx.db
          .insert(orgMemberships)
          .values({ orgId: invite.orgId, humanId: sessionHuman.id, role: 'owner', createdAt: ts })
          .run();
        insertEnrollment(ctx, {
          inviteId: invite.id,
          orgId: invite.orgId,
          kind: 'human',
          humanId: sessionHuman.id,
          status: 'approved',
        });
        return reply.code(201).send({
          org: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
          role: 'owner',
        });
      }
      // Holding a valid (unexpired, unrevoked) invite token IS the approval —
      // the inviter already chose this person. A signed-in human redeeming a
      // member invite is admitted as `member` immediately; there is no human
      // admission policy. This mirrors the owner-invite auto-admit above. (The
      // `enroll.agents` approval policy still governs the agent open-enrollment
      // path below.)
      const body = parse(EnrollHumanRequestSchema, request.body ?? {});
      const ts = nowIso();
      ctx.db
        .insert(orgMemberships)
        .values({ orgId: invite.orgId, humanId: sessionHuman.id, role: 'member', createdAt: ts })
        .run();
      insertEnrollment(ctx, {
        inviteId: invite.id,
        orgId: invite.orgId,
        kind: 'human',
        humanId: sessionHuman.id,
        note: body.note ?? null,
        status: 'approved',
      });
      // Auto-ensure the inviter↔joiner DM so each appears in the other's HUMANS list.
      if (invite.inviterHumanId && invite.inviterHumanId !== sessionHuman.id) {
        ensureDmRoomWithEvents(
          ctx,
          invite.orgId,
          { type: 'human', id: invite.inviterHumanId },
          { type: 'human', id: sessionHuman.id },
        );
      }
      return reply.code(201).send({
        org: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
        role: 'member',
      });
    }

    /* -------- anonymous caller → agent enrollment -------- */
    // An owner invite (NULL inviter) has no human to own a minted agent — it
    // admits a human owner only. Treat an anonymous knock like an unusable token.
    if (invite.inviterHumanId === null) throw notFound(INVITE_UNKNOWN_MESSAGE);
    const inviterHumanId = invite.inviterHumanId;
    const body = parse(EnrollAgentRequestSchema, request.body ?? {});
    // The proposed name is validated AT THE KNOCK so an approver never inherits
    // an invalid name: shape is the schema's `400`, a reserved local part is a
    // `409` (SPEC "Identity & addressing"). Collision resolution stays at
    // approval time, where v3's `-2`/`-3` suffixing is the documented exception.
    assertNameAvailable(body.name);
    if (settings.enroll.agents === 'open') {
      const name = uniqueAgentName(ctx, invite.orgId, body.name);
      const key = newAgentKey();
      const agent = insertAgent(ctx, {
        orgId: invite.orgId,
        ownerHumanId: inviterHumanId,
        name,
        keyHash: sha256Hex(key),
      });
      const { roomId: dmRoomId } = ensureDmRoomWithEvents(
        ctx,
        invite.orgId,
        { type: 'human', id: inviterHumanId },
        { type: 'agent', id: agent.id },
      );
      insertEnrollment(ctx, {
        inviteId: invite.id,
        orgId: invite.orgId,
        kind: 'agent',
        proposedName: name,
        note: body.note ?? null,
        status: 'approved',
      });
      return reply.code(201).send({
        agent: toAgent(ctx, agent),
        key,
        org: { id: orgRow.id, name: orgRow.name },
        dmRoomId,
        emailAddress: agentEmailAddress(ctx, agent),
      });
    }
    // approval → pending; the enr_ token is returned exactly once.
    const enrToken = newEnrollmentToken();
    const row = insertEnrollment(ctx, {
      inviteId: invite.id,
      orgId: invite.orgId,
      kind: 'agent',
      proposedName: body.name,
      note: body.note ?? null,
      tokenHash: sha256Hex(enrToken),
    });
    emitEnrollmentRequested(ctx, invite.orgId, inviterHumanId, toEnrollmentSummary(ctx, row));
    return reply.code(202).send({
      enrollment: { id: row.id, status: 'pending' },
      enrollmentToken: enrToken,
    });
  });

  /* ------------------------------- info ------------------------------ */
  // Browser-facing landing metadata for the invite SPA hero (no auth). Reveals
  // only the org name, inviter display name, and agent policy; the markdown
  // onboarding doc stays generic. A DEAD invite reads dead the same way the doc
  // route does: unknown → `404`, revoked/expired → `410` with a message naming
  // which, so the invite page can tell the human what actually happened instead
  // of one vague "invalid, expired, or revoked". Neither message names the org.
  app.get<{ Params: { token: string } }>(
    '/api/v1/invite/:token/info',
    (request, reply) => {
      const invite = requireLiveInvite(inviteByToken(ctx, request.params.token));
      const orgRow = ctx.db.select().from(orgs).where(eq(orgs.id, invite.orgId)).get();
      if (!orgRow) throw notFound(INVITE_UNKNOWN_MESSAGE);
      // An admin owner invite carries no inviter (NULL) — the landing page shows
      // the org with no inviter attribution.
      const inviter = invite.inviterHumanId
        ? ctx.db.select().from(humans).where(eq(humans.id, invite.inviterHumanId)).get()
        : undefined;
      const settings = parseOrgSettings(orgRow.settings);
      const response: InviteInfoResponse = {
        org: { name: orgRow.name },
        inviter: { displayName: inviter?.displayName ?? '', email: inviter?.email ?? '' },
        agentPolicy: settings.enroll.agents,
      };
      return reply.send(response);
    },
  );

  /* ------------------------------- poll ------------------------------ */
  app.get<{ Params: { token: string; eid: string } }>(
    '/api/v1/invite/:token/enrollments/:eid',
    (request, reply) => {
      const invite = inviteByToken(ctx, request.params.token);
      if (!invite) throw notFound('Not found');
      const found = ctx.db
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.id, request.params.eid), eq(enrollments.inviteId, invite.id)))
        .get();
      if (!found) throw notFound('Not found');

      // Auth must match the enrollment: its enr_ token (bearer) or the knocking session.
      let ok = false;
      if (found.tokenHash) {
        const header = request.headers.authorization;
        const bearer = header?.toLowerCase().startsWith('bearer ')
          ? header.slice(7).trim()
          : undefined;
        ok = !!bearer && sha256Hex(bearer) === found.tokenHash;
      } else if (found.humanId) {
        ok = ctx.auth.sessionHuman(request)?.id === found.humanId;
      }
      if (!ok) throw notFound('Not found');

      const row = reapIfExpired(ctx, found);
      if (row.status === 'pending') {
        return reply.send({ status: 'pending', retryAfterSeconds: ENROLLMENT_POLL_RETRY_SECONDS });
      }
      if (row.status === 'denied') {
        return reply.send({ status: 'denied' });
      }
      // approved
      const orgRow = ctx.db.select().from(orgs).where(eq(orgs.id, row.orgId)).get();
      if (row.kind === 'human') {
        const membership = row.humanId
          ? membershipOf(ctx.db, row.orgId, row.humanId)
          : undefined;
        return reply.send({
          status: 'approved',
          org: orgRow
            ? { id: orgRow.id, name: orgRow.name, slug: orgRow.slug }
            : { id: row.orgId, name: '', slug: '' },
          role: (membership?.role ?? 'member') as OrgRole,
        });
      }
      // agent — deliver the key exactly once (first approved poll).
      const agent = ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.orgId, row.orgId), eq(agents.name, row.proposedName ?? '')))
        .get();
      const dmRoomId = agent
        ? ensureDmRoom(
            ctx,
            row.orgId,
            { type: 'human', id: agent.ownerHumanId },
            { type: 'agent', id: agent.id },
          )
        : '';
      const base: Record<string, unknown> = {
        status: 'approved',
        agent: agent ? toAgent(ctx, agent) : null,
        org: orgRow ? { id: orgRow.id, name: orgRow.name } : { id: row.orgId, name: '' },
        dmRoomId,
        // The address rides WITH the key: an agent learns it has a second medium
        // at the moment it gets its credential. `null` while the medium is off.
        emailAddress: agent ? agentEmailAddress(ctx, agent) : null,
      };
      if (row.issuedKey) {
        base.key = row.issuedKey;
        ctx.db.update(enrollments).set({ issuedKey: null }).where(eq(enrollments.id, row.id)).run();
      }
      return reply.send(base);
    },
  );

  /* ------------------------------- list ------------------------------ */
  app.get<{ Params: { orgId: string }; Querystring: { mine?: string } }>(
    '/api/v1/orgs/:orgId/enrollments',
    (request, reply) => {
      const orgId = request.params.orgId;
      const mine =
        request.query.mine === 'true' ||
        request.query.mine === '1' ||
        (request.query.mine as unknown) === true;
      // Scope: org owners/admins (and the admin token) see ALL pending; a
      // plain-member inviter sees ONLY their own invites' enrollments. `?mine=true`
      // restricts anyone (including admins) to their own invites' enrollments.
      const adminTok = adminTokenOk(ctx, request);
      let callerHumanId: string | undefined;
      let orgAdmin = false;
      if (adminTok) {
        callerHumanId = ctx.auth.sessionHuman(request)?.id;
      } else {
        const human = ctx.auth.requireSession(request);
        callerHumanId = human.id;
        const membership = membershipOf(ctx.db, orgId, human.id);
        if (!membership) throw notFound('No such org');
        orgAdmin = roleAtLeast(membership.role as OrgRole, 'admin');
      }
      const seeAll = (adminTok || orgAdmin) && !mine;
      const rows = ctx.db
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.orgId, orgId), eq(enrollments.status, 'pending')))
        .orderBy(asc(enrollments.createdAt), asc(enrollments.id))
        .all()
        .map((r) => reapIfExpired(ctx, r))
        .filter((r) => r.status === 'pending');
      const visible = seeAll
        ? rows
        : rows.filter((r) => {
            const invite = ctx.db.select().from(invites).where(eq(invites.id, r.inviteId)).get();
            return invite?.inviterHumanId === callerHumanId;
          });
      const response: ListEnrollmentsResponse = {
        items: visible.map((r) => toEnrollmentSummary(ctx, r)),
      };
      return reply.send(response);
    },
  );

  /* ------------------------------- approve --------------------------- */
  app.post<{ Params: { orgId: string; eid: string } }>(
    '/api/v1/orgs/:orgId/enrollments/:eid/approve',
    (request, reply) => {
      const orgId = request.params.orgId;
      const found = ctx.db
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.id, request.params.eid), eq(enrollments.orgId, orgId)))
        .get();
      if (!found) throw notFound('No such enrollment');
      requireEnrollmentApprover(ctx, request, orgId, found);
      // Approval is strictly yes/no — the body carries no name. The agent's
      // proposed name (chosen at enroll) is final, subject only to the per-org
      // uniqueness auto-suffix below.
      // Note the expiry BEFORE reaping, so the refusal can say which it was.
      const expired = isExpired(found);
      const row = reapIfExpired(ctx, found);
      if (expired) throw conflict(ENROLLMENT_EXPIRED_MESSAGE);
      if (row.status !== 'pending') throw conflict('This request has already been resolved');
      const invite = ctx.db.select().from(invites).where(eq(invites.id, row.inviteId)).get();
      if (!invite) throw conflict('This request has already been resolved');

      if (row.kind === 'human') {
        if (row.humanId && !membershipOf(ctx.db, orgId, row.humanId)) {
          ctx.db
            .insert(orgMemberships)
            .values({ orgId, humanId: row.humanId, role: 'member', createdAt: nowIso() })
            .run();
        }
        ctx.db
          .update(enrollments)
          .set({ status: 'approved', resolvedAt: nowIso() })
          .where(eq(enrollments.id, row.id))
          .run();
        // Auto-ensure the inviter↔joiner DM (mirror of the agent path). Skipped
        // for an inviter-less admin owner invite (which never reaches here — it
        // admits instantly — but guard for null all the same).
        if (invite.inviterHumanId && row.humanId && row.humanId !== invite.inviterHumanId) {
          ensureDmRoomWithEvents(
            ctx,
            orgId,
            { type: 'human', id: invite.inviterHumanId },
            { type: 'human', id: row.humanId },
          );
        }
      } else {
        // Agent: mint owned by the INVITER, unique-suffix the name, hold the key.
        // An owner invite (NULL inviter) never mints agents (blocked at the knock).
        if (!invite.inviterHumanId) throw conflict('This request has already been resolved');
        // Collision resolution keeps v3's `-2`/`-3` suffixing (name-safe by
        // construction) — the ONE exception to the `409` rule. Reservation is
        // NOT suffixed away: it was rejected at the knock and stays a conflict.
        assertNameAvailable(row.proposedName ?? 'agent');
        const name = uniqueAgentName(ctx, orgId, row.proposedName ?? 'agent');
        const key = newAgentKey();
        const agent = insertAgent(ctx, {
          orgId,
          ownerHumanId: invite.inviterHumanId,
          name,
          keyHash: sha256Hex(key),
        });
        ensureDmRoomWithEvents(
          ctx,
          orgId,
          { type: 'human', id: invite.inviterHumanId },
          { type: 'agent', id: agent.id },
        );
        ctx.db
          .update(enrollments)
          .set({ status: 'approved', resolvedAt: nowIso(), issuedKey: key, proposedName: name })
          .where(eq(enrollments.id, row.id))
          .run();
      }
      emitEnrollmentResolved(ctx, orgId, invite.inviterHumanId ?? '', row.id, 'approved');
      return reply.send({ ok: true });
    },
  );

  /* ------------------------------- deny ------------------------------ */
  app.post<{ Params: { orgId: string; eid: string } }>(
    '/api/v1/orgs/:orgId/enrollments/:eid/deny',
    (request, reply) => {
      const orgId = request.params.orgId;
      const found = ctx.db
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.id, request.params.eid), eq(enrollments.orgId, orgId)))
        .get();
      if (!found) throw notFound('No such enrollment');
      requireEnrollmentApprover(ctx, request, orgId, found);
      const expired = isExpired(found);
      const row = reapIfExpired(ctx, found);
      if (expired) throw conflict(ENROLLMENT_EXPIRED_MESSAGE);
      if (row.status !== 'pending') throw conflict('This request has already been resolved');
      const invite = ctx.db.select().from(invites).where(eq(invites.id, row.inviteId)).get();
      ctx.db
        .update(enrollments)
        .set({ status: 'denied', resolvedAt: nowIso() })
        .where(eq(enrollments.id, row.id))
        .run();
      emitEnrollmentResolved(ctx, orgId, invite?.inviterHumanId ?? '', row.id, 'denied');
      return reply.send({ ok: true });
    },
  );
}
