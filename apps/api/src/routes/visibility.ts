/**
 * Agent visibility routes (SPEC "Agent visibility"): tags, the messaging policy,
 * delegated grants and analytics. Every route takes a human session OR an agent
 * key — agents can hold grants and act on the agents they manage. Authority is
 * decided by `visibility-authority.ts`; a refusal is `403` with `error.reason`
 * `self` | `outranked` | `grant_required`.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  AgentAnalyticsQuerySchema,
  CreateGrantRequestSchema,
  PutAgentMessagingRequestSchema,
  PutAgentTagsRequestSchema,
  newGrantId,
  type CreateGrantResponse,
  type GrantListResponse,
  type PutAgentMessagingResponse,
  type PutAgentTagsResponse,
} from '@sparrow-land/sdk/types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal } from '../context.js';
import { agents, grants } from '../db/schema.js';
import { parse } from '../validate.js';
import { forbiddenBecause, notFound } from '../errors.js';
import { canAccessAgent, humanRef, toAgent } from '../agent-helpers.js';
import { humanById } from '../room-helpers.js';
import {
  decideAnalyticsRead,
  decideGrantCreate,
  decideGrantDelete,
  decideMessaging,
  decideTags,
  type Verdict,
} from '../visibility-authority.js';
import {
  actorFacts,
  agentAnalytics,
  agentTargetFacts,
  grantsOfOrg,
  orgAgentOr404,
  principalTargetFacts,
  revokeUnjustifiedGrants,
  scopesOf,
  setAgentTags,
  toGrant,
} from '../visibility.js';

/** Throw the verdict's `403` (with its reason) unless it allows. */
function enforce(verdict: Verdict): void {
  if (!verdict.ok) throw forbiddenBecause(verdict.reason, verdict.message);
}

type OrgAgentParams = { Params: { orgId: string; agentId: string } };

export function registerVisibilityRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ---------------- GET /orgs/:orgId/agents/:agentId ----------------- */
  // ONE agent, readable by any member of its org (human or agent): the wire
  // Agent (org-visible fields: name, role TITLE, tags, messaging, …) plus its
  // owner's ref; presence and address only for callers who can access it. Never the private role instructions, key or mail counts — those
  // stay on the owner's visibility-list entry and the agent's own `GET /me`.
  // It is how a grant holder (often an agent) reads the tags it is about to edit.
  app.get<OrgAgentParams>('/api/v1/orgs/:orgId/agents/:agentId', (request, reply) => {
    const { orgId, agentId } = request.params;
    const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const agent = orgAgentOr404(ctx, orgId, agentId);
    const owner = humanById(ctx, agent.ownerHumanId);
    // Presence and address follow today's SHARING rules, not org membership: the
    // agent itself, its owner, org owners/admins and humans who can access it
    // (canAccessAgent) see them; any other caller — including every other agent —
    // gets the org-visible fields with presence and address blanked.
    const fullView =
      actor.id === agent.id ||
      (actor.kind === 'human' &&
        (actor.orgAdmin || agent.ownerHumanId === actor.id || canAccessAgent(ctx, agent, actor.id)));
    const wire = toAgent(ctx, agent);
    return reply.send({
      agent: fullView ? wire : { ...wire, online: false, lastSeenAt: null, emailAddress: null },
      owner: owner ? humanRef(owner) : { id: agent.ownerHumanId, displayName: '' },
    });
  });

  /* ---------------- PUT /orgs/:orgId/agents/:agentId/tags ------------ */
  app.put<OrgAgentParams>('/api/v1/orgs/:orgId/agents/:agentId/tags', (request, reply) => {
    const { orgId, agentId } = request.params;
    const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const agent = orgAgentOr404(ctx, orgId, agentId);
    const body = parse(PutAgentTagsRequestSchema, request.body);
    const target = agentTargetFacts(ctx, agent);
    const next = new Set(body.tags);
    const added = body.tags.filter((t) => !target.tags.includes(t));
    const removed = target.tags.filter((t) => !next.has(t));
    enforce(decideTags(actor, target, added, removed));
    if (added.length > 0 || removed.length > 0) setAgentTags(ctx.db, agent.id, body.tags);
    const response: PutAgentTagsResponse = { agent: toAgent(ctx, agent) };
    return reply.send(response);
  });

  /* ------------- PUT /orgs/:orgId/agents/:agentId/messaging ---------- */
  app.put<OrgAgentParams>('/api/v1/orgs/:orgId/agents/:agentId/messaging', (request, reply) => {
    const { orgId, agentId } = request.params;
    const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const agent = orgAgentOr404(ctx, orgId, agentId);
    const body = parse(PutAgentMessagingRequestSchema, request.body);
    enforce(decideMessaging(actor, agentTargetFacts(ctx, agent)));
    ctx.db.update(agents).set({ messaging: body.messaging }).where(eq(agents.id, agent.id)).run();
    const response: PutAgentMessagingResponse = {
      agent: toAgent(ctx, { ...agent, messaging: body.messaging }),
    };
    return reply.send(response);
  });

  /* ---------------------- GET /orgs/:orgId/grants -------------------- */
  // Any member of the org (human or agent) may read the org's grants: who can
  // change what is part of understanding the org, like the tags themselves.
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/grants', (request, reply) => {
    const { orgId } = request.params;
    actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const response: GrantListResponse = { items: grantsOfOrg(ctx.db, orgId).map(toGrant) };
    return reply.send(response);
  });

  /* ---------------------- POST /orgs/:orgId/grants ------------------- */
  // A duplicate (same principal + scope) answers `200` with the standing grant.
  app.post<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/grants', (request, reply) => {
    const { orgId } = request.params;
    const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const body = parse(CreateGrantRequestSchema, request.body);
    const target = principalTargetFacts(ctx, orgId, body.principalId);
    enforce(decideGrantCreate(actor, target, body.scope));
    const existing = ctx.db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.orgId, orgId),
          eq(grants.principalId, body.principalId),
          eq(grants.scope, body.scope),
        ),
      )
      .get();
    if (existing) {
      const response: CreateGrantResponse = { grant: toGrant(existing) };
      return reply.send(response);
    }
    const row = {
      id: newGrantId(),
      orgId,
      principalId: body.principalId,
      principalKind: target.kind,
      scope: body.scope,
      grantedBy: actor.id,
      createdAt: nowIso(),
    };
    ctx.db.insert(grants).values(row).run();
    const response: CreateGrantResponse = { grant: toGrant(row) };
    return reply.code(201).send(response);
  });

  /* ---------------- DELETE /orgs/:orgId/grants/:grantId -------------- */
  app.delete<{ Params: { orgId: string; grantId: string } }>(
    '/api/v1/orgs/:orgId/grants/:grantId',
    (request, reply) => {
      const { orgId, grantId } = request.params;
      const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
      const row = ctx.db
        .select()
        .from(grants)
        .where(and(eq(grants.id, grantId), eq(grants.orgId, orgId)))
        .get();
      if (!row) throw notFound('No such grant');
      const holder =
        row.principalKind === 'agent'
          ? agentTargetFacts(ctx, orgAgentOr404(ctx, orgId, row.principalId))
          : {
              kind: 'human' as const,
              id: row.principalId,
              tags: [],
              scopes: scopesOf(ctx.db, orgId, row.principalId),
            };
      enforce(decideGrantDelete(actor, holder, row.grantedBy));
      // Grants the holder created stand only while it can justify them: losing
      // its `tags:*` takes them (and, recursively, theirs) in the same transaction.
      ctx.db.transaction((tx) => {
        tx.delete(grants).where(eq(grants.id, row.id)).run();
        revokeUnjustifiedGrants(tx, [{ orgId, principalId: row.principalId }]);
      });
      return reply.send({ ok: true });
    },
  );

  /* ------------ GET /orgs/:orgId/agents/:agentId/analytics ----------- */
  app.get<OrgAgentParams>('/api/v1/orgs/:orgId/agents/:agentId/analytics', (request, reply) => {
    const { orgId, agentId } = request.params;
    const actor = actorFacts(ctx, orgId, resolvePrincipal(ctx, request));
    const agent = orgAgentOr404(ctx, orgId, agentId);
    const query = parse(AgentAnalyticsQuerySchema, request.query ?? {});
    // The target's real scopes: reads pass the same `outranked` guard as writes.
    enforce(decideAnalyticsRead(actor, agentTargetFacts(ctx, agent)));
    return reply.send(agentAnalytics(ctx, agent, query.window));
  });
}
