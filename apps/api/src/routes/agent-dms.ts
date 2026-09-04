/**
 * Agent↔agent DM oversight (SPEC "Direct conversations" + "Unified attention").
 *
 * An agent↔agent DM is a private room between two agents, but it is never truly
 * private FROM humans: it exists only while at least one human can see BOTH
 * agents, and every such human gets an ambient, read-only oversight box. These
 * routes are that box's data — a human READ surface onto a room they are NOT a
 * member of, mirroring how the email medium exposes an agent's threads to its
 * overseers (`/orgs/:orgId/agents/:agentId/email/...`) rather than through room
 * membership.
 *
 *  - `GET /orgs/:orgId/agent-dms` — the caller's boxes (every agent↔agent DM in
 *    the org whose two agents they can BOTH currently see, newest first).
 *  - `GET /orgs/:orgId/agent-dms/:roomId/messages` — one box's transcript,
 *    read-only (writes no read state), gated by that same "sees both" predicate.
 *  - `POST /orgs/:orgId/agent-dms/:roomId/sever` / `.../allow` — the one WRITE
 *    here, and it is governance, not participation: an org owner/admin or an
 *    owning human cuts the pair's line (or permits it again). Watching a pair
 *    never confers it; see `severAuthorityOf`.
 *
 * Ambient by design: no unread count rides a box and reading marks nothing.
 * Dynamic by design: the predicate is evaluated per request, so a human who
 * loses sight of either agent loses the box AND its read access with no
 * denormalized state to revoke. A caller who fails the predicate — or is not a
 * member of the org — gets `404` (agent/room existence never leaks), never `403`.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  ListRoomMessagesQuerySchema,
  MESSAGES_LIST_DEFAULT_LIMIT,
  type AgentDmBox,
  type AllowAgentDmResponse,
  type ListAgentDmsResponse,
  type SeverAgentDmResponse,
  type ListRoomMessagesResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { messages, rooms } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { membershipOf } from '../org-helpers.js';
import { bodyPreview, toMessage } from '../message-helpers.js';
import {
  agentPairOf,
  allowAgentDm,
  canLift,
  canOverseePair,
  severAgentDm,
  severAuthorityOf,
  severOf,
  seversOfOrg,
} from '../agent-dm-helpers.js';

/** The tiebreak column shared with room history: SQLite insertion order. */
const MSG_ROWID = sql`${messages}.rowid`;

/**
 * The newest LIVE message in a room, projected to the box's `lastMessage`.
 * Clawed-back rows don't count — a box whose only message was clawed reads as
 * empty and drops out of the oversight listing entirely.
 */
function lastMessageOf(ctx: AppContext, roomId: string): AgentDmBox['lastMessage'] {
  const row = ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.roomId, roomId), isNull(messages.clawedBackAt)))
    .orderBy(desc(messages.createdAt), desc(MSG_ROWID))
    .limit(1)
    .get();
  if (!row) return null;
  return { preview: bodyPreview(row.body).preview, at: row.createdAt };
}

export function registerAgentDmRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* --------------------------- ListAgentDms -------------------------- */
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/agent-dms', (request, reply) => {
    const { orgId } = request.params;
    const human = ctx.auth.requireSession(request);
    // A non-member of the org sees nothing — an empty list, not a 404: the org
    // path itself is not a secret, only which agent-DMs exist within it.
    if (!membershipOf(ctx.db, orgId, human.id)) {
      return reply.send({ items: [] } satisfies ListAgentDmsResponse);
    }
    const dmRooms = ctx.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.orgId, orgId), eq(rooms.kind, 'dm')))
      .all();
    const severs = seversOfOrg(ctx, orgId);
    const boxes: (AgentDmBox & { _at: string })[] = [];
    for (const room of dmRooms) {
      const pair = agentPairOf(ctx, room);
      if (!pair) continue;
      const [a, b] = pair;
      if (!canOverseePair(ctx, pair, human.id)) continue;
      const last = lastMessageOf(ctx, room.id);
      // A box with no message yet is not worth surfacing — the ambient box is
      // for conversations that are happening, not for empty ensured rooms.
      if (!last) continue;
      boxes.push({
        roomId: room.id,
        orgId,
        agents: [
          { id: a.id, name: a.name },
          { id: b.id, name: b.name },
        ],
        lastMessage: last,
        // A severed pair keeps its box: severing cuts the AGENTS' line, it
        // never hides what they already said from the humans who oversaw it.
        severedAt: severs.get(room.id)?.severedAt ?? null,
        canSever: severAuthorityOf(ctx, orgId, human.id, pair) !== null,
        _at: last.at,
      });
    }
    // Newest activity first; id as a stable tiebreak.
    boxes.sort((x, y) => (x._at !== y._at ? (x._at < y._at ? 1 : -1) : x.roomId < y.roomId ? 1 : -1));
    const response: ListAgentDmsResponse = {
      items: boxes.map(({ _at, ...box }) => box),
    };
    return reply.send(response);
  });

  /* ------------------------ ListAgentDmMessages ---------------------- */
  // The box's transcript: full Messages newest-first, walked backward with a
  // message-id `before` cursor — identical mechanics to room history, but the
  // reader is a NON-member who oversees the pair, and no read state is written.
  app.get<{ Params: { orgId: string; roomId: string } }>(
    '/api/v1/orgs/:orgId/agent-dms/:roomId/messages',
    (request, reply) => {
      const { orgId, roomId } = request.params;
      const human = ctx.auth.requireSession(request);
      const room = ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
      // Room must be an agent↔agent DM in this org, and the caller must see both
      // agents right now. Any failure is one 404 — existence never leaks.
      const pair = room && room.orgId === orgId ? agentPairOf(ctx, room) : null;
      if (
        !room ||
        !pair ||
        !membershipOf(ctx.db, orgId, human.id) ||
        !canOverseePair(ctx, pair, human.id)
      ) {
        throw notFound('No such conversation');
      }
      const query = parse(ListRoomMessagesQuerySchema, request.query ?? {});
      const limit = query.limit ?? MESSAGES_LIST_DEFAULT_LIMIT;

      let beforeCond: SQL | undefined;
      if (query.before) {
        const anchor = ctx.db
          .select({ createdAt: messages.createdAt, rowid: MSG_ROWID })
          .from(messages)
          .where(and(eq(messages.id, query.before), eq(messages.roomId, room.id)))
          .get() as { createdAt: string; rowid: number } | undefined;
        if (!anchor) throw badRequest('Invalid before cursor');
        beforeCond = or(
          lt(messages.createdAt, anchor.createdAt),
          and(eq(messages.createdAt, anchor.createdAt), lt(MSG_ROWID, anchor.rowid)),
        );
      }

      // Clawed messages leave the oversight transcript like every other view.
      const rows = ctx.db
        .select({ msg: messages })
        .from(messages)
        .where(and(eq(messages.roomId, room.id), isNull(messages.clawedBackAt), beforeCond))
        .orderBy(desc(messages.createdAt), desc(MSG_ROWID))
        .limit(limit + 1)
        .all();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const response: ListRoomMessagesResponse = {
        items: page.map((r) => toMessage(ctx, r.msg)),
        nextBefore: hasMore && page.length > 0 ? page[page.length - 1]!.msg.id : null,
      };
      return reply.send(response);
    },
  );

  /* ------------------------- Sever / Allow --------------------------- */
  /**
   * The off switch (SPEC "Direct conversations → Severing an agent↔agent DM").
   * `sever` archives the pair's room and records a durable block; `allow`
   * removes the block and nothing else — the agents themselves must re-ensure.
   *
   * Both resolve the pair the same way and answer `404` for everything they are
   * not: a room that is not an agent↔agent DM of this org, a caller who holds no
   * authority over the pair. The one `403` is the honest, informative case — a
   * human WITH authority trying to lift a sever that outranks theirs.
   */
  const resolveGovernable = (
    request: { params: { orgId: string; roomId: string } },
    human: { id: string },
  ) => {
    const { orgId, roomId } = request.params;
    const room = ctx.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
    const pair = room && room.orgId === orgId ? agentPairOf(ctx, room) : null;
    if (!room || !pair || !membershipOf(ctx.db, orgId, human.id)) {
      throw notFound('No such conversation');
    }
    const authority = severAuthorityOf(ctx, orgId, human.id, pair);
    if (!authority) throw notFound('No such conversation');
    return { room, pair, authority };
  };

  app.post<{ Params: { orgId: string; roomId: string } }>(
    '/api/v1/orgs/:orgId/agent-dms/:roomId/sever',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const { room, pair, authority } = resolveGovernable(request, human);
      const sever = severAgentDm(ctx, room, pair, human.id, authority);
      return reply.send({ sever } satisfies SeverAgentDmResponse);
    },
  );

  app.post<{ Params: { orgId: string; roomId: string } }>(
    '/api/v1/orgs/:orgId/agent-dms/:roomId/allow',
    (request, reply) => {
      const human = ctx.auth.requireSession(request);
      const { room, pair, authority } = resolveGovernable(request, human);
      const standing = severOf(ctx, room.id);
      if (standing && !canLift(standing.authority as 'org' | 'agent-owner', authority)) {
        throw forbidden(
          'This pair was severed by an org owner or admin; only an org owner or admin can allow it again',
        );
      }
      if (standing) allowAgentDm(ctx, room, pair, human.id);
      return reply.send({ roomId: room.id, allowed: true } satisfies AllowAgentDmResponse);
    },
  );
}
