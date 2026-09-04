/**
 * Direct conversations (SPEC "Direct conversations"). `POST /me/dms` ensures the
 * one DM room per (org, unordered principal pair). Eligibility (else 403,
 * indistinguishable from a nonexistent principal):
 *   - human → agent: caller holds visibility;
 *   - agent → its owner: always;
 *   - human → human: both members of the org;
 *   - agent → human (not its owner): that human holds visibility on the agent;
 *   - agent → agent: they have MET (co-inhabit a room) on first contact, some
 *     human can oversee both, and the pair is not severed.
 * `orgId` is required only when the eligible pair shares more than one org.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  EnsureDmRequestSchema,
  type EnsureDmResponse,
  type PrincipalKind,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { orgMemberships, rooms } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, forbidden } from '../errors.js';
import {
  AGENT_DM_NO_COMMON_VIEWER_MESSAGE,
  AGENT_DM_SEVERED_MESSAGE,
  DM_NOT_ELIGIBLE_MESSAGE,
} from '@sparrow/common-types';
import { canAccessAgent, dmKey, someHumanCanSeeBoth } from '../agent-helpers.js';
import { agentById, humanById, memberOf, dmCounterpart } from '../room-helpers.js';
import { ensureDmRoomWithEvents } from '../dm-helpers.js';
import {
  agentDmRoom,
  agentsHaveMet,
  reopenAllowedAgentDm,
  severOf,
} from '../agent-dm-helpers.js';

/** The org ids a principal belongs to. */
function orgsOfPrincipal(ctx: AppContext, type: PrincipalKind, id: string): string[] {
  if (type === 'agent') {
    const agent = agentById(ctx, id);
    return agent ? [agent.orgId] : [];
  }
  return ctx.db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.humanId, id))
    .all()
    .map((r) => r.orgId);
}

export function registerDmRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/me/dms', (request, reply) => {
    const caller = principalIdent(resolvePrincipal(ctx, request));
    const body = parse(EnsureDmRequestSchema, request.body);
    const targetId = body.principal;
    if (targetId === caller.id) throw badRequest('You cannot start a direct conversation with yourself');

    const cpType: PrincipalKind = targetId.startsWith('agt_')
      ? 'agent'
      : targetId.startsWith('usr_')
        ? 'human'
        : (() => {
            throw badRequest('Invalid principal id');
          })();

    // Existence: a nonexistent counterpart is indistinguishable from an ineligible one.
    const cpExists = cpType === 'agent' ? !!agentById(ctx, targetId) : !!humanById(ctx, targetId);
    if (!cpExists) throw forbidden(DM_NOT_ELIGIBLE_MESSAGE);

    const callerOrgs = new Set(orgsOfPrincipal(ctx, caller.type, caller.id));
    const shared = orgsOfPrincipal(ctx, cpType, targetId).filter((o) => callerOrgs.has(o));

    /**
     * The agent↔agent gate, as a REASON rather than a boolean: the refusal
     * message depends on how much the caller could already know. `'unmet'` is
     * the no-oracle case — the caller has no standing to learn this agent
     * exists, so it gets the same refusal a fabricated id gets.
     */
    const agentPairVerdict = (
      orgId: string,
      a: ReturnType<typeof agentById>,
      b: ReturnType<typeof agentById>,
    ): 'ok' | 'unmet' | 'no-viewer' | 'severed' => {
      if (!a || !b || a.orgId !== orgId || b.orgId !== orgId) return 'unmet';
      // First contact is gated on having MET: an agent's directory is its rooms,
      // so a raw `agt_` id must not open a door its name could not.
      const room = agentDmRoom(ctx, dmKey(orgId, a.id, b.id));
      if (!room && !agentsHaveMet(ctx, a, b)) return 'unmet';
      // A severed pair stays severed until a human allows it again.
      if (room && severOf(ctx, room.id)) return 'severed';
      // The live rule, for first contact and every re-ensure alike: some human
      // can currently see BOTH (the `canAccessAgent` sharing machinery).
      return someHumanCanSeeBoth(ctx, a, b) ? 'ok' : 'no-viewer';
    };

    /** Whether a DM between the pair is eligible in a specific org. */
    const eligibleInOrg = (orgId: string): boolean => {
      // human ↔ human: both members of the org (already ensured by `shared`).
      if (caller.type === 'human' && cpType === 'human') return true;
      if (caller.type === 'agent' && cpType === 'agent') {
        return (
          agentPairVerdict(orgId, agentById(ctx, caller.id), agentById(ctx, targetId)) === 'ok'
        );
      }
      // Identify the (agent, human) pair.
      const agentId = caller.type === 'agent' ? caller.id : targetId;
      const humanId = caller.type === 'human' ? caller.id : targetId;
      const agent = agentById(ctx, agentId);
      if (!agent || agent.orgId !== orgId) return false;
      if (agent.ownerHumanId === humanId) return true; // agent ↔ its owner
      return canAccessAgent(ctx, agent, humanId); // explicit grant OR the agent's sharing mode
    };

    const eligible = shared.filter(eligibleInOrg);
    if (eligible.length === 0) {
      // A refused agent↔agent pair that has already MET may hear WHY: the caller
      // can read the counterpart out of a shared room's member list anyway, so
      // naming the rule leaks nothing. Every other refusal — including a real
      // agent the caller has never met — is the one uninformative sentence, so
      // `POST /me/dms` is never an existence oracle for an `agt_`/`usr_` id.
      if (caller.type === 'agent' && cpType === 'agent') {
        for (const orgId of shared) {
          const verdict = agentPairVerdict(
            orgId,
            agentById(ctx, caller.id),
            agentById(ctx, targetId),
          );
          if (verdict === 'severed') throw forbidden(AGENT_DM_SEVERED_MESSAGE);
          if (verdict === 'no-viewer') throw forbidden(AGENT_DM_NO_COMMON_VIEWER_MESSAGE);
        }
      }
      throw forbidden(DM_NOT_ELIGIBLE_MESSAGE);
    }
    let orgId: string;
    if (body.orgId !== undefined) {
      if (!eligible.includes(body.orgId)) {
        throw forbidden(DM_NOT_ELIGIBLE_MESSAGE);
      }
      orgId = body.orgId;
    } else if (eligible.length === 1) {
      orgId = eligible[0]!;
    } else {
      throw badRequest('orgId is required — the pair shares more than one org');
    }

    const { roomId, created } = ensureDmRoomWithEvents(
      ctx,
      orgId,
      { type: caller.type, id: caller.id },
      { type: cpType, id: targetId },
    );
    // A pair that was severed and then allowed again re-opens HERE, on the
    // agents' own initiative — the allow only removed the block.
    reopenAllowedAgentDm(ctx, ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get()!);
    const room = ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get()!;

    const callerMember = memberOf(ctx, roomId, caller.type, caller.id)!;
    const counterpart = dmCounterpart(ctx, room, caller.id)!;
    const response: EnsureDmResponse = {
      room: { id: room.id, kind: 'dm', orgId: room.orgId },
      counterpart,
      memberId: callerMember.id,
    };
    return reply.code(created ? 201 : 200).send(response);
  });
}
