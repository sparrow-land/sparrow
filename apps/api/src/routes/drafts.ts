/**
 * Message drafts (personal, room-scoped). A draft belongs to exactly one
 * authoring member in one room; only its author may list or delete it. Another
 * member's drafts are invisible — listing returns only your own, and deleting a
 * foreign or unknown id `404`s (never `403`) so a draft's existence never leaks.
 * There are no SSE events for drafts in v1.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  CreateDraftRequestSchema,
  DRAFTS_PER_ROOM_MAX,
  MAX_BODY_BYTES,
  newDraftId,
  type CreateDraftResponse,
  type ListDraftsResponse,
  type OkResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal, principalIdent } from '../context.js';
import { drafts } from '../db/schema.js';
import { parse } from '../validate.js';
import { badRequest, notFound, payloadTooLarge } from '../errors.js';
import { requireRoomMember, assertNotArchived } from '../room-helpers.js';

export function registerDraftRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- ListDrafts ------------------------ */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/drafts', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const rows = ctx.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.roomId, caller.room.id), eq(drafts.memberId, caller.member.id)))
      .orderBy(asc(drafts.createdAt), asc(drafts.id))
      .all();
    const response: ListDraftsResponse = {
      items: rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt })),
    };
    return reply.send(response);
  });

  /* ------------------------------- CreateDraft ----------------------- */
  app.post<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/drafts', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    assertNotArchived(caller.room);
    const body = parse(CreateDraftRequestSchema, request.body);

    if (Buffer.byteLength(body.text, 'utf8') > MAX_BODY_BYTES) {
      throw payloadTooLarge('Draft text is too large');
    }

    const count = ctx.db
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.roomId, caller.room.id), eq(drafts.memberId, caller.member.id)))
      .all().length;
    if (count >= DRAFTS_PER_ROOM_MAX) {
      throw badRequest(`You can keep at most ${DRAFTS_PER_ROOM_MAX} drafts in a room`);
    }

    const id = newDraftId();
    const createdAt = nowIso();
    ctx.db
      .insert(drafts)
      .values({ id, roomId: caller.room.id, memberId: caller.member.id, text: body.text, createdAt })
      .run();
    const response: CreateDraftResponse = { draft: { id, text: body.text, createdAt } };
    return reply.code(201).send(response);
  });

  /* ------------------------------- DeleteDraft ----------------------- */
  app.delete<{ Params: { roomId: string; draftId: string } }>(
    '/api/v1/rooms/:roomId/drafts/:draftId',
    (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      // Scope to the caller's own draft in this room: a foreign/unknown id 404s.
      const row = ctx.db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.id, request.params.draftId),
            eq(drafts.roomId, caller.room.id),
            eq(drafts.memberId, caller.member.id),
          ),
        )
        .get();
      if (!row) throw notFound('No such draft');
      ctx.db.delete(drafts).where(eq(drafts.id, row.id)).run();
      const response: OkResponse = { ok: true };
      return reply.send(response);
    },
  );
}
