/**
 * Human avatars (SPEC "Avatars"): a person uploads/clears their own avatar and
 * any signed-in principal who shares an org with the target can fetch it.
 *
 * - `PUT /api/v1/me/avatar`  — raw image body (png/jpeg/webp, ≤ AVATAR_MAX_BYTES).
 *   The bytes are stored on disk under the data dir's `avatars/{humanId}` (the
 *   same on-disk machinery message attachments use) and the content type is
 *   recorded on the human row. An uploaded avatar wins over the provider photo /
 *   gravatar in the resolution chain.
 * - `DELETE /api/v1/me/avatar` — clears the uploaded avatar (falls back down the
 *   chain).
 * - `GET /api/v1/avatars/:humanId` — serves the stored image (content type
 *   preserved, cached, private). 404 when there is none, or when the caller does
 *   not share an org with the target (indistinguishable — never leaks existence).
 *
 * Avatar changes propagate live: `member.updated` is emitted into every room the
 * human inhabits (members render their avatar live, same as a display-name rename).
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES } from '@sparrow/common-types';
import type { AvatarMutationResponse } from '@sparrow/common-types';
import type { AppContext, PrincipalIdent } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { agents, humans, members, orgMemberships } from '../db/schema.js';
import { avatarServePath, avatarUrlForHuman } from '../avatar-helpers.js';
import { toMember } from '../room-helpers.js';
import { emitMemberUpdated } from '../room-events.js';
import { badRequest, notFound, payloadTooLarge } from '../errors.js';

/** Emit `member.updated` in every room a human inhabits (live avatar propagation). */
function propagateAvatar(ctx: AppContext, humanId: string): void {
  const memberRows = ctx.db
    .select()
    .from(members)
    .where(and(eq(members.principalType, 'human'), eq(members.principalId, humanId)))
    .all();
  for (const m of memberRows) emitMemberUpdated(ctx, m.roomId, toMember(ctx, m));
}

/** Whether the calling principal shares at least one org with the target human. */
function sharesOrgWithHuman(
  ctx: AppContext,
  principal: PrincipalIdent,
  humanId: string,
): boolean {
  const targetOrgs = new Set(
    ctx.db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(eq(orgMemberships.humanId, humanId))
      .all()
      .map((r) => r.orgId),
  );
  if (targetOrgs.size === 0) return false;
  if (principal.type === 'human') {
    return ctx.db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(eq(orgMemberships.humanId, principal.id))
      .all()
      .some((r) => targetOrgs.has(r.orgId));
  }
  const agent = ctx.db.select().from(agents).where(eq(agents.id, principal.id)).get();
  return !!agent && targetOrgs.has(agent.orgId);
}

export function registerAvatarRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Buffer raw image bodies for the avatar upload. Registering the parser by a
  // content-type RegExp means any `image/*` body reaches the handler as a Buffer
  // (a non-accepted image subtype is then rejected 400 there); other content
  // types are unaffected and keep their existing parsers.
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  /* ------------------------------- Upload ---------------------------- */
  app.put('/api/v1/me/avatar', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!AVATAR_CONTENT_TYPES.includes(contentType)) {
      throw badRequest('Avatar must be a PNG, JPEG, or WebP image');
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty avatar upload');
    if (body.length > AVATAR_MAX_BYTES) throw payloadTooLarge('Avatar image is too large');

    writeFileSync(path.join(ctx.handle.avatarsDir, human.id), body);
    ctx.db.update(humans).set({ avatarAttachment: contentType }).where(eq(humans.id, human.id)).run();
    propagateAvatar(ctx, human.id);
    const response: AvatarMutationResponse = { avatarUrl: avatarServePath(human.id) };
    return reply.send(response);
  });

  /* ------------------------------- Delete ---------------------------- */
  app.delete('/api/v1/me/avatar', (request, reply) => {
    const human = ctx.auth.requireSession(request);
    ctx.db.update(humans).set({ avatarAttachment: null }).where(eq(humans.id, human.id)).run();
    try {
      unlinkSync(path.join(ctx.handle.avatarsDir, human.id));
    } catch {
      // No stored file (already cleared) — nothing to remove.
    }
    propagateAvatar(ctx, human.id);
    const fresh = ctx.db.select().from(humans).where(eq(humans.id, human.id)).get()!;
    const response: AvatarMutationResponse = { avatarUrl: avatarUrlForHuman(ctx, fresh) };
    return reply.send(response);
  });

  /* ------------------------------- Serve ----------------------------- */
  app.get<{ Params: { humanId: string } }>('/api/v1/avatars/:humanId', (request, reply) => {
    const principal = principalIdent(resolvePrincipal(ctx, request));
    const targetId = request.params.humanId;
    // Gate + existence collapse to the same 404 (never leak who has an avatar).
    if (!sharesOrgWithHuman(ctx, principal, targetId)) throw notFound('No such avatar');
    const target = ctx.db.select().from(humans).where(eq(humans.id, targetId)).get();
    if (!target || !target.avatarAttachment) throw notFound('No such avatar');
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(ctx.handle.avatarsDir, targetId));
    } catch {
      throw notFound('No such avatar');
    }
    return reply
      .header('content-type', target.avatarAttachment)
      .header('cache-control', 'private, max-age=300')
      .send(bytes);
  });
}
