/**
 * Activity routes (SPEC v4 "Unified attention → Activity routes"):
 * `GET /me/activity` (the caller's own timeline) and
 * `GET /orgs/:orgId/agents/:agentId/activity` (one agent's).
 *
 * A timeline is correspondence, not room data: `canAccessAgent` alone does NOT
 * admit a reader — only the agent's owner, org owners/admins, or the admin token.
 * A caller who fails every test gets `404`, never `403` (agent existence never
 * leaks). Reading writes nothing, ever: no read state, no `peek`, no `?all=`.
 *
 * Both routes are TRANSCRIPTS (SPEC *HTTP API → Conventions*): newest-first,
 * walked backward with an entry-id `before=` cursor and a `nextBefore` key,
 * exactly as room history is — a timeline reads backward from now.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  MeActivityQuerySchema,
  AgentActivityQuerySchema,
  type ListActivityResponse,
  type OrgRole,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { principalIdent, resolvePrincipal } from '../context.js';
import { activityEntries, agents, emails } from '../db/schema.js';
import type { ActivityEntryRow } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, notFound } from '../errors.js';
import { membershipOf, roleAtLeast } from '../org-helpers.js';
import { resolveLimit, beforeCondition, withCursor, transcriptResult } from '../pagination.js';
import { toActivityEntry } from '../activity.js';

/**
 * The timeline's tiebreak column: SQLite's insertion order (`rowid`), matching
 * the spec's "newest-first by `createdAt`, ties by insertion order" — the same
 * tiebreak room history uses.
 */
const ENTRY_ROWID = sql`${activityEntries}.rowid`;

/** One page of the timeline for a WHERE clause, shared by both routes. */
function page(
  ctx: AppContext,
  base: SQL | undefined,
  query: { limit?: number; before?: string; medium?: string },
): ListActivityResponse {
  const limit = resolveLimit(query.limit);
  // `?medium=` narrows; an unrecognized value never reaches here (the schema
  // rejects it as `bad_request`).
  const filtered =
    query.medium && base
      ? and(base, eq(activityEntries.medium, query.medium))
      : query.medium
        ? eq(activityEntries.medium, query.medium)
        : base;
  // `before` is an ENTRY-ID cursor: resolve its (createdAt, rowid) anchor inside
  // the caller's own scope, so an id from someone else's timeline is as invalid
  // as an id that never existed. Only the anchor's POSITION is used.
  let anchor: { orderValue: string; tiebreak: unknown } | undefined;
  if (query.before) {
    const row = ctx.db
      .select({ createdAt: activityEntries.createdAt, rowid: ENTRY_ROWID })
      .from(activityEntries)
      .where(withCursor(base, eq(activityEntries.id, query.before)))
      .get() as { createdAt: string; rowid: number } | undefined;
    if (!row) throw badRequest('Invalid before cursor');
    anchor = { orderValue: row.createdAt, tiebreak: row.rowid };
  }
  const rows = ctx.db
    .select({ row: activityEntries, rowid: ENTRY_ROWID })
    .from(activityEntries)
    .where(withCursor(filtered, beforeCondition(activityEntries.createdAt, ENTRY_ROWID, anchor)))
    .orderBy(desc(activityEntries.createdAt), desc(ENTRY_ROWID))
    .limit(limit + 1)
    .all() as { row: ActivityEntryRow; rowid: number }[];
  return transcriptResult(
    rows,
    limit,
    (r) => toActivityEntry(ctx, r.row),
    (r) => r.row.id,
  );
}

/**
 * Whether the caller may read `agent`'s timeline through the org route: its
 * OWNER, or an org owner/admin. Deliberately not `canAccessAgent` — a colleague
 * with `sharing: 'org'` would otherwise see every contact who ever wrote to it.
 */
function mayReadAgentTimeline(
  ctx: AppContext,
  agentId: string,
  orgId: string,
  humanId: string,
): boolean {
  const agent = ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || agent.orgId !== orgId) return false;
  if (agent.ownerHumanId === humanId) return true;
  const membership = membershipOf(ctx.db, orgId, humanId);
  return !!membership && roleAtLeast(membership.role as OrgRole, 'admin');
}

/** The entry types whose `summary` is a (possibly still-quarantined) subject line. */
const GUARDED_EMAIL_TYPES = new Set(['email.quarantined', 'email.rejected', 'email.resolved']);

/**
 * Redact, for an AGENT reader, the `summary` of email entries whose referenced
 * email the agent may not see. An `email.quarantined`/`email.rejected`/
 * `email.resolved` entry is a legitimate REF on the agent's own timeline, but
 * its summary is the sender's subject line — quarantined content until a human
 * approves it. The email is agent-visible exactly when it (still) exists in the
 * `emails` table (delivered inbound / the agent's own outbound); a quarantine-
 * side, denied, or reaped email is not, and its subject stays withheld.
 */
function redactForAgent(ctx: AppContext, response: ListActivityResponse): ListActivityResponse {
  for (const entry of response.items) {
    if (entry.medium !== 'email' || entry.summary === null) continue;
    if (!GUARDED_EMAIL_TYPES.has(entry.type)) continue;
    const emailId = entry.refs.emailId;
    const row = emailId
      ? ctx.db.select().from(emails).where(eq(emails.id, emailId)).get()
      : undefined;
    const visible = !!row && (row.direction === 'out' || row.disposition === 'delivered');
    if (!visible) entry.summary = null;
  }
  return response;
}

/** Whether the request carries the instance admin token (an operator read). */
function isAdminToken(ctx: AppContext, request: FastifyRequest): boolean {
  return (
    !!ctx.config.adminToken && request.headers['x-admin-token'] === ctx.config.adminToken
  );
}

export function registerActivityRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- GET /me/activity ------------------ */
  // Agent caller: `agent_id = me`. Human caller: `owner_human_id = me OR
  // actor_principal_id = me` — everything involving them, whether they were the
  // actor or the owner of the agent involved.
  app.get('/api/v1/me/activity', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const query = parse(MeActivityQuerySchema, request.query ?? {});
    const scope =
      principal.type === 'agent'
        ? eq(activityEntries.agentId, principal.id)
        : or(
            eq(activityEntries.ownerHumanId, principal.id),
            eq(activityEntries.actorPrincipalId, principal.id),
          );
    const base = query.org ? and(scope, eq(activityEntries.orgId, query.org)) : scope;
    let response: ListActivityResponse = page(ctx, base, query);
    if (principal.type === 'agent') response = redactForAgent(ctx, response);
    return reply.send(response);
  });

  /* ------------- GET /orgs/:orgId/agents/:agentId/activity ----------- */
  app.get<{ Params: { orgId: string; agentId: string } }>(
    '/api/v1/orgs/:orgId/agents/:agentId/activity',
    (request, reply) => {
      const { orgId, agentId } = request.params;
      const query = parse(AgentActivityQuerySchema, request.query ?? {});
      if (!isAdminToken(ctx, request)) {
        const human = ctx.auth.requireSession(request);
        // A non-member of the org, a non-qualifying member, and an unknown agent
        // are all the same answer: 404. Existence never leaks.
        if (!mayReadAgentTimeline(ctx, agentId, orgId, human.id)) throw notFound('No such agent');
      } else if (
        !ctx.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
          .get()
      ) {
        throw notFound('No such agent');
      }
      const response: ListActivityResponse = page(
        ctx,
        eq(activityEntries.agentId, agentId),
        query,
      );
      return reply.send(response);
    },
  );
}
