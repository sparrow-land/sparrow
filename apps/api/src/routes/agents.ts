/**
 * Agent, visibility & sharing routes (SPEC "Agents, visibility & sharing"). All
 * session-authed, owner-only unless noted. `GET /me/agents` returns the caller's
 * VISIBILITY list (owned + shared-to-them); create/rotate return the `agk_` key
 * exactly once.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  CreateAgentRequestSchema,
  ListAgentsQuerySchema,
  ShareAgentRequestSchema,
  UpdateAgentRequestSchema,
  newAgentKey,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type UpdateAgentResponse,
  type VisibilityAgent,
} from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import {
  activityEntries,
  agents,
  agentVisibility,
  emails,
  humans,
  members,
  orgMemberships,
  rooms,
} from '../db/schema.js';
import type { AgentRow, AgentVisibilityRow, HumanRow } from '../db/schema.js';
import { parse } from '../validate.js';
import { deleteAgentEmailCascade } from '../email/store.js';
import { emailMediumOn } from '../email/addresses.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { membershipOf } from '../org-helpers.js';
import {
  toAgent,
  agentEmailAddress,
  agentByNameInOrg,
  assertNameAvailable,
  canAccessAgent,
  grantVisibility,
  insertAgent,
  renameAgent,
  setAgentRole,
  emitAgentShare,
  humanRef,
} from '../agent-helpers.js';

/**
 * One agent's unread mail: delivered INBOUND email with no `read_at` — the same
 * rule a thread's `unreadCount` uses, summed across the agent's threads. The
 * `emails.agent_id` denormalization makes it one index scan, which is why the
 * count can ride along on the visibility list instead of costing the client a
 * walk of every thread.
 */
function agentEmailUnreadCount(ctx: AppContext, agentId: string): number {
  return ctx.db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        eq(emails.agentId, agentId),
        eq(emails.direction, 'in'),
        eq(emails.disposition, 'delivered'),
        isNull(emails.readAt),
      ),
    )
    .all().length;
}

/**
 * Build the visibility-list entries a human can see (optionally org-filtered).
 *
 * Candidates are the union of (a) EXPLICIT `agent_visibility` grants and (b)
 * agents the caller can reach via the agent's sharing mode (`room-members` /
 * `org`) — see `canAccessAgent`. Dynamic access carries NO `agent_visibility`
 * row, so such entries have `sharedBy: null` (they weren't shared to anyone in
 * particular). Owned agents (always present via the owner's own grant row) keep
 * their `rooms` + `sharedWith` management metadata.
 */
function visibilityList(ctx: AppContext, humanId: string, orgId?: string): VisibilityAgent[] {
  const mediumOn = emailMediumOn(ctx);
  const visRows = ctx.db
    .select()
    .from(agentVisibility)
    .where(eq(agentVisibility.humanId, humanId))
    .all();
  const explicitByAgent = new Map<string, AgentVisibilityRow>();
  for (const vis of visRows) explicitByAgent.set(vis.agentId, vis);

  // Candidate agents: explicit grants first, then dynamically-visible agents in
  // each org the caller belongs to (or just `orgId` when the list is scoped).
  const candidates = new Map<string, AgentRow>();
  for (const vis of visRows) {
    const agent = ctx.db.select().from(agents).where(eq(agents.id, vis.agentId)).get();
    if (agent) candidates.set(agent.id, agent);
  }
  const orgIds = orgId
    ? [orgId]
    : ctx.db
        .select({ orgId: orgMemberships.orgId })
        .from(orgMemberships)
        .where(eq(orgMemberships.humanId, humanId))
        .all()
        .map((r) => r.orgId);
  for (const oid of orgIds) {
    const orgAgents = ctx.db.select().from(agents).where(eq(agents.orgId, oid)).all();
    for (const agent of orgAgents) {
      if (candidates.has(agent.id)) continue;
      if (canAccessAgent(ctx, agent, humanId)) candidates.set(agent.id, agent);
    }
  }

  const entries: VisibilityAgent[] = [];
  for (const agent of candidates.values()) {
    if (orgId && agent.orgId !== orgId) continue;
    const vis = explicitByAgent.get(agent.id);
    const owner = ctx.db.select().from(humans).where(eq(humans.id, agent.ownerHumanId)).get();
    const isOwner = agent.ownerHumanId === humanId;
    let sharedBy: VisibilityAgent['sharedBy'] = null;
    if (!isOwner && vis) {
      const granter = ctx.db
        .select()
        .from(humans)
        .where(eq(humans.id, vis.grantedByHumanId))
        .get();
      sharedBy = granter ? humanRef(granter) : null;
    }
    const entry: VisibilityAgent = {
      agent: toAgent(ctx, agent),
      owner: owner ? humanRef(owner) : { id: agent.ownerHumanId, displayName: '' },
      sharedBy,
      // The AGENTS badge's email half. Mail is correspondence, not room data, so
      // only the OWNER learns a count; everyone else — and everyone when the
      // medium is off — gets `null`, which folds in as nothing.
      emailUnreadCount: isOwner && mediumOn ? agentEmailUnreadCount(ctx, agent.id) : null,
      // The private half of the role: instructions ride the entry for the OWNER
      // only (the org-visible title is already on `agent`). A non-owner gets null,
      // mirroring the isOwner-only rooms/sharedWith extras.
      roleInstructions: isOwner ? (agent.roleInstructions ?? null) : null,
    };
    if (isOwner) {
      const roomRows = ctx.db
        .select({ id: rooms.id, name: rooms.name, memberId: members.id })
        .from(members)
        .innerJoin(rooms, eq(rooms.id, members.roomId))
        .where(and(eq(members.principalType, 'agent'), eq(members.principalId, agent.id)))
        .all();
      entry.rooms = roomRows.map((r) => ({ id: r.id, name: r.name, memberId: r.memberId }));
      // sharedWith: the visibility grants on this agent, minus the owner's own row.
      const shareRows = ctx.db
        .select({ humanId: agentVisibility.humanId, createdAt: agentVisibility.createdAt })
        .from(agentVisibility)
        .where(eq(agentVisibility.agentId, agent.id))
        .all()
        .filter((s) => s.humanId !== agent.ownerHumanId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      entry.sharedWith = shareRows.map((s) => {
        const grantee = ctx.db.select().from(humans).where(eq(humans.id, s.humanId)).get();
        return {
          id: s.humanId,
          displayName: grantee?.displayName ?? '',
          createdAt: s.createdAt,
        };
      });
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.agent.createdAt.localeCompare(b.agent.createdAt));
  return entries;
}

/** Resolve a share target (`usr_...` id or email) to a human, or throw notFound. */
function resolveHumanTarget(ctx: AppContext, human: string): HumanRow {
  const byId = ctx.db.select().from(humans).where(eq(humans.id, human)).get();
  if (byId) return byId;
  const byEmail = ctx.db
    .select()
    .from(humans)
    .where(eq(humans.email, human.trim().toLowerCase()))
    .get();
  if (byEmail) return byEmail;
  throw notFound('No such person');
}

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- create ---------------------------- */
  app.post('/api/v1/me/agents', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const body = parse(CreateAgentRequestSchema, request.body);
    if (!membershipOf(ctx.db, body.orgId, human.id)) {
      throw notFound('No such org');
    }
    // The v4 name rule: shape is the schema's `400`; reserved and taken are both
    // `409` (SPEC "Identity & addressing → Agent names & addresses").
    assertNameAvailable(body.name);
    if (agentByNameInOrg(ctx, body.orgId, body.name)) {
      throw conflict('An agent with that name already exists in this org');
    }
    const key = newAgentKey();
    const agent = insertAgent(ctx, {
      orgId: body.orgId,
      ownerHumanId: human.id,
      name: body.name,
      keyHash: sha256Hex(key),
    });
    const response: CreateAgentResponse = { agent: toAgent(ctx, agent), key };
    return reply.code(201).send(response);
  });

  /* ------------------------------- list ------------------------------ */
  app.get('/api/v1/me/agents', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const query = parse(ListAgentsQuerySchema, request.query ?? {});
    const response: ListAgentsResponse = { items: visibilityList(ctx, human.id, query.org) };
    return reply.send(response);
  });

  /* -------------------- sidebar: org-scoped visibility --------------- */
  app.get<{ Params: { orgId: string } }>(
    '/api/v1/orgs/:orgId/me/agents',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      if (!membershipOf(ctx.db, request.params.orgId, human.id)) throw notFound('No such org');
      const response: ListAgentsResponse = {
        items: visibilityList(ctx, human.id, request.params.orgId),
      };
      return reply.send(response);
    },
  );

  /* ------------------------------- rotate ---------------------------- */
  app.post<{ Params: { id: string } }>('/api/v1/me/agents/:id/rotate', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
    if (!agent || agent.ownerHumanId !== human.id) throw notFound('No such agent');
    const key = newAgentKey();
    ctx.db.update(agents).set({ keyHash: sha256Hex(key) }).where(eq(agents.id, agent.id)).run();
    const response: CreateAgentResponse = { agent: toAgent(ctx, agent), key };
    return reply.send(response);
  });

  /* ----------------------- update sharing / name --------------------- */
  // Owner-only change of the agent's sharing mode and/or its display name. A
  // non-owner who addresses a real agent gets `403` (not `404`) here — this route
  // is reached from the agent profile, which the caller can only open for an agent
  // they can already see, so existence isn't being leaked. Dynamic sharing modes
  // emit NO per-human `agent.shared`/`agent.unshared` events (see `canAccessAgent`);
  // only the explicit share/unshare routes do. A `name` change is org-unique
  // (case-insensitive, `409` on collision, never auto-suffixed) and ripples
  // `member.updated` to every room the agent inhabits (see `renameAgent`).
  app.patch<{ Params: { id: string } }>('/api/v1/me/agents/:id', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
    if (!agent) throw notFound('No such agent');
    if (agent.ownerHumanId !== human.id) throw forbidden('Only the owner can change this agent');
    const body = parse(UpdateAgentRequestSchema, request.body);
    let next = agent;
    if (body.name !== undefined) {
      const before = next.name;
      next = renameAgent(ctx, next, body.name);
      // Attribution: an owner-path rename is done BY a human TO one of their
      // agents. Record who acted on a real change, so a surprised agent (or an
      // operator) can trace an unexpected rename to its actor. `member.updated`
      // has no actor slot on the wire, so this is the only attribution channel
      // today; a persisted audit trail is a recommended follow-up.
      if (next.name !== before) {
        request.log.info(
          { event: 'agent.renamed', actorHumanId: human.id, agentId: agent.id, from: before, to: next.name },
          'owner renamed agent',
        );
      }
    }
    if (body.sharing !== undefined) {
      ctx.db.update(agents).set({ sharing: body.sharing }).where(eq(agents.id, agent.id)).run();
      next = { ...next, sharing: body.sharing };
    }
    // Owner-set role — same helper (and same `role.updated` nudge to the agent)
    // as the agent's own PATCH /me; the nudge fires no matter who changed it.
    if (body.roleTitle !== undefined || body.roleInstructions !== undefined) {
      next = setAgentRole(ctx, next, {
        roleTitle: body.roleTitle,
        roleInstructions: body.roleInstructions,
      });
    }
    const response: UpdateAgentResponse = { agent: toAgent(ctx, next) };
    return reply.send(response);
  });

  /* ------------------------------- delete ---------------------------- */
  app.delete<{ Params: { id: string } }>('/api/v1/me/agents/:id', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
    if (!agent || agent.ownerHumanId !== human.id) throw notFound('No such agent');
    ctx.db.transaction((tx) => {
      tx.delete(members)
        .where(and(eq(members.principalType, 'agent'), eq(members.principalId, agent.id)))
        .run();
      tx.delete(agentVisibility).where(eq(agentVisibility.agentId, agent.id)).run();
      // Layer 3: entries cascade-delete with their agent (SPEC "Unified attention
      // → Retention"), consistent with v3's hard-delete posture.
      tx.delete(activityEntries).where(eq(activityEntries.agentId, agent.id)).run();
      tx.delete(agents).where(eq(agents.id, agent.id)).run();
    });
    // The email medium's half of the cascade: threads, emails, and the
    // attachment blobs on disk (SPEC "Data model (SQLite)").
    deleteAgentEmailCascade(ctx, [agent.id]);
    return reply.send({ ok: true });
  });

  /* ------------------------------- share ----------------------------- */
  app.post<{ Params: { id: string } }>('/api/v1/me/agents/:id/share', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
    if (!agent || agent.ownerHumanId !== human.id) throw notFound('No such agent');
    const body = parse(ShareAgentRequestSchema, request.body);
    const target = resolveHumanTarget(ctx, body.human);
    // Target must be a member of the agent's org.
    if (!membershipOf(ctx.db, agent.orgId, target.id)) {
      throw forbidden('That person is not a member of this agent’s org');
    }
    const created = grantVisibility(ctx, agent.id, target.id, human.id);
    if (created) emitAgentShare(ctx, target.id, 'agent.shared', agent);
    return reply.code(created ? 201 : 200).send({ ok: true });
  });

  /* ------------------------------- unshare --------------------------- */
  app.delete<{ Params: { id: string; humanId: string } }>(
    '/api/v1/me/agents/:id/share/:humanId',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const agent = ctx.db.select().from(agents).where(eq(agents.id, request.params.id)).get();
      if (!agent || agent.ownerHumanId !== human.id) throw notFound('No such agent');
      // The owner's own visibility row is irrevocable.
      if (request.params.humanId === agent.ownerHumanId) {
        throw badRequest('The owner’s visibility cannot be revoked');
      }
      const existing = ctx.db
        .select()
        .from(agentVisibility)
        .where(
          and(
            eq(agentVisibility.agentId, agent.id),
            eq(agentVisibility.humanId, request.params.humanId),
          ),
        )
        .get();
      if (existing) {
        ctx.db
          .delete(agentVisibility)
          .where(
            and(
              eq(agentVisibility.agentId, agent.id),
              eq(agentVisibility.humanId, request.params.humanId),
            ),
          )
          .run();
        emitAgentShare(ctx, request.params.humanId, 'agent.unshared', agent);
      }
      return reply.send({ ok: true });
    },
  );
}
