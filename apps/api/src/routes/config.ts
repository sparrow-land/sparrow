/**
 * Runtime config routes: `GET /config` / `PUT /config`.
 *
 * Auth (v3): the instance admin token (`X-Admin-Token`) ONLY — there are no
 * instance-admin humans (org roles replaced them). When `ADMIN_TOKEN` is unset
 * these paths `404`; a wrong token → `401`.
 */
import type { FastifyInstance } from 'fastify';
import { PutConfigRequestSchema, type GetConfigResponse } from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { parse } from '../validate.js';
import { adminGuard } from './admin.js';

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/config', (request, reply) => {
    adminGuard(ctx, request);
    const response: GetConfigResponse = { entries: ctx.configStore.entries() };
    return reply.send(response);
  });

  app.put('/api/v1/config', (request, reply) => {
    adminGuard(ctx, request);
    const body = parse(PutConfigRequestSchema, request.body);
    const entries = ctx.configStore.put(body.values);
    const response: GetConfigResponse = { entries };
    return reply.send(response);
  });
}
