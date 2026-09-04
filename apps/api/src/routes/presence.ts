/**
 * Heartbeat presence (SPEC "Presence"). A turn-based agent (wake → act → sleep)
 * has no long-lived socket, so the stream-refcount notion of "online" doesn't fit
 * it. `POST /api/v1/me/presence` lets such a principal mark itself online, org/
 * room-wide, until now+ttlSeconds — no events stream required. Effective online
 * stays `stream-connected OR unexpired mark`; the mark fires `presence.changed`
 * on set and (via a sweep) on expiry. `ttlSeconds: 0` clears the mark.
 */
import type { FastifyInstance } from 'fastify';
import { SetPresenceRequestSchema, type SetPresenceResponse } from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { parse } from '../validate.js';

export function registerPresenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/me/presence', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const body = parse(SetPresenceRequestSchema, request.body);
    const result: SetPresenceResponse = ctx.rooms.setPresenceTtl(
      principal.type,
      principal.id,
      body.ttlSeconds,
    );
    return reply.send(result);
  });
}
