/**
 * Working status + presence snapshot (SPEC "Working status" / "Presence").
 * Statuses are ephemeral (in-memory, TTL'd). `working` upserts on key
 * `(memberId, to)`; `idle` clears (a `to` narrows the clear). Listing returns the
 * statuses visible to the caller (room-wide, scoped-to-caller, own) plus the
 * room's online member ids.
 */
import type { FastifyInstance } from 'fastify';
import {
  SetStatusRequestSchema,
  STATUS_TTL_DEFAULT,
  type SetStatusResponse,
  type ListStatusesResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { parse } from '../validate.js';
import { notFound } from '../errors.js';
import { requireRoomMember, assertNotArchived, resolveMemberTarget, toMemberRef } from '../room-helpers.js';
import { emitStatusChanged } from '../room-events.js';
import { toMemberStatus, statusToRef, statusAudience } from '../status-helpers.js';

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- SetStatus ------------------------- */
  app.post<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/status', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    assertNotArchived(caller.room);
    const body = parse(SetStatusRequestSchema, request.body);

    let toMemberId: string | null = null;
    if (body.to !== undefined) {
      const target = resolveMemberTarget(ctx, caller.room.id, body.to);
      if (!target) throw notFound('No such member');
      toMemberId = target.id;
    }

    if (body.state === 'working') {
      const sticky = body.sticky ?? false;
      const record = ctx.statuses.upsert({
        roomId: caller.room.id,
        memberId: caller.member.id,
        note: body.note ?? null,
        toMemberId,
        sticky,
        ttlSeconds: body.ttlSeconds ?? STATUS_TTL_DEFAULT,
      });
      // A sticky status set while its member is already offline must still lapse
      // at the horizon, so arm the countdown now (a no-op if they're online — the
      // hub arms it when they next go offline).
      if (sticky && !ctx.rooms.isPrincipalOnline(principal.type, principal.id)) {
        ctx.statuses.armStickyExpiry(caller.room.id, caller.member.id);
      }
      emitStatusChanged(ctx, caller.room.id, statusAudience(record), {
        member: toMemberRef(ctx, caller.member),
        state: 'working',
        note: record.note,
        to: statusToRef(ctx, record.toMemberId),
        sinceAt: record.sinceAt,
        sticky: record.sticky,
        expiresAt: record.expiresAt,
      });
      const response: SetStatusResponse = { status: toMemberStatus(ctx, record) };
      return reply.send(response);
    }

    // idle — clear (to narrows). Emit an idle change for each cleared entry.
    const removed = ctx.statuses.clear(
      caller.room.id,
      caller.member.id,
      body.to !== undefined ? toMemberId : undefined,
    );
    for (const record of removed) {
      emitStatusChanged(ctx, caller.room.id, statusAudience(record), {
        member: toMemberRef(ctx, caller.member),
        state: 'idle',
        note: null,
        to: statusToRef(ctx, record.toMemberId),
        sinceAt: null,
        sticky: false,
        expiresAt: null,
      });
    }
    const response: SetStatusResponse = { status: null };
    return reply.send(response);
  });

  /* ------------------------------- ListStatuses ---------------------- */
  app.get<{ Params: { roomId: string } }>('/api/v1/rooms/:roomId/status', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
    const visible = ctx.statuses
      .list(caller.room.id)
      .filter(
        (r) =>
          r.toMemberId === null ||
          r.toMemberId === caller.member.id ||
          r.memberId === caller.member.id,
      );
    const response: ListStatusesResponse = {
      items: visible.map((r) => toMemberStatus(ctx, r)),
      presence: { online: ctx.rooms.onlineMemberIds(caller.room.id) },
    };
    return reply.send(response);
  });
}
