/**
 * Shared instance-auth routes (v3): `GET /auth/config` advertises the registered
 * login providers; `/auth/me` + `/auth/logout` are session-only; `GET /me`
 * returns the principal union (human session OR agent key). The provider routes
 * (`POST /auth/signup|login`, google redirect/callback) are registered by the
 * providers themselves.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { UpdateMeRequestSchema, UpdateMeAgentRequestSchema } from '@sparrow/common-types';
import type { AuthConfigResponse, AuthMeResponse, MeResponse } from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal } from '../context.js';
import { effectiveOrigin } from '../effective-origin.js';
import { isAnonymousRequest, resolveTheme, toUser } from '../auth.js';
import { humans } from '../db/schema.js';
import { parse } from '../validate.js';
import { agentEmailAddress, renameAgent, setAgentRole } from '../agent-helpers.js';
import { emitPrincipalRenamed } from '../room-events.js';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/auth/config', (request, reply) => {
    // Anchor each provider's login button to the request's effective origin, so
    // buttons served on an org-scoped host (`<slug><ORG_HOST_SUFFIX>`) point back
    // at that host rather than the static BASE_URL apex.
    const origin = effectiveOrigin(request, ctx.config);
    const response: AuthConfigResponse = {
      providers: ctx.providers.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        ...(p.loginUrl ? { loginUrl: p.loginUrl(origin) } : {}),
        ...(p.primary ? { primary: true } : {}),
      })),
      allowSignup: ctx.configStore.getBoolean('auth.allowSignup'),
      // Only ever present as `true`, and only while the next signup really would
      // found the instance's first workspace — see `AuthService.bootstrapOrgPending`
      // for why that conjunction is what keeps this safe on an anonymous route.
      ...(ctx.auth.bootstrapOrgPending() ? { bootstrapOrg: true } : {}),
    };
    return reply.send(response);
  });

  // GET /auth/me — "who am I?", and being nobody is a valid answer. A caller
  // that presented NO credential gets `200 { user: null }`: this is the first
  // call of every anonymous page load, and answering `401` made the BROWSER
  // write a red line into its own network console before any JS could swallow
  // it. A credential that IS present but no longer resolves (expired/revoked
  // cookie, dead `ses_`, or an `agk_` agent key on this human-only route) keeps
  // its `401` — that is the different fact "clear your stale state".
  app.get('/api/v1/auth/me', (request, reply) => {
    if (isAnonymousRequest(request)) {
      const response: AuthMeResponse = { user: null };
      return reply.send(response);
    }
    const human = ctx.auth.requireSession(request);
    const response: AuthMeResponse = { user: toUser(human) };
    return reply.send(response);
  });

  app.post('/api/v1/auth/logout', (request, reply) => {
    ctx.auth.requireSession(request);
    ctx.auth.logout(request, reply);
    return reply.send({ ok: true });
  });

  // GET /me — the principal union (session human OR agent key), plus the
  // caller's own effective presence: "am I actually online?" answered in the
  // same call that resolves who you are. Read from the event hub, the one place
  // that already computes principal-level online for every other surface.
  app.get('/api/v1/me', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    if (principal.type === 'human') {
      const response: MeResponse = {
        principal: {
          type: 'human',
          id: principal.human.id,
          email: principal.human.email,
          displayName: principal.human.displayName,
          theme: resolveTheme(principal.human.theme),
          presence: ctx.rooms.principalPresence('human', principal.human.id),
        },
      };
      return reply.send(response);
    }
    const owner = ctx.db
      .select()
      .from(humans)
      .where(eq(humans.id, principal.agent.ownerHumanId))
      .get();
    const response: MeResponse = {
      principal: {
        type: 'agent',
        id: principal.agent.id,
        name: principal.agent.name,
        orgId: principal.agent.orgId,
        // The derived address, or null with the email medium off.
        emailAddress: agentEmailAddress(ctx, principal.agent),
        owner: { id: owner?.id ?? principal.agent.ownerHumanId, displayName: owner?.displayName ?? '' },
        // The agent reads its OWN role in full here — including the private
        // instructions, which no other principal's view exposes.
        roleTitle: principal.agent.roleTitle ?? null,
        roleInstructions: principal.agent.roleInstructions ?? null,
        roleUpdatedAt: principal.agent.roleUpdatedAt ?? null,
        presence: ctx.rooms.principalPresence('agent', principal.agent.id),
      },
    };
    return reply.send(response);
  });

  // PATCH /me — update the caller's principal. A human account takes
  // `{ displayName?, theme? }` (≥1 field); an AGENT renames itself with
  // `{ name }`. Both are the display layer over a permanent id — a rename is live
  // in rooms (members render principal names live), so `member.updated` is emitted
  // in every room the principal inhabits when (and only when) the name changed. A
  // human `theme` update is private to the caller and emits nothing.
  app.patch('/api/v1/me', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);

    // Agent self-rename: org-unique (case-insensitive), 409 on collision (never
    // auto-suffixed), and ripples member.updated to all of the agent's rooms.
    if (principal.type === 'agent') {
      const body = parse(UpdateMeAgentRequestSchema, request.body);
      // Rename first (may 409 on a name collision, before any role write), then
      // apply any role change — each emits its own live ripple.
      let updated = principal.agent;
      if (body.name !== undefined) updated = renameAgent(ctx, updated, body.name);
      if (body.roleTitle !== undefined || body.roleInstructions !== undefined) {
        updated = setAgentRole(ctx, updated, {
          roleTitle: body.roleTitle,
          roleInstructions: body.roleInstructions,
        });
      }
      const owner = ctx.db
        .select()
        .from(humans)
        .where(eq(humans.id, updated.ownerHumanId))
        .get();
      const response: MeResponse = {
        principal: {
          type: 'agent',
          id: updated.id,
          name: updated.name,
          orgId: updated.orgId,
          // A rename MOVES the address (no alias, no grace window).
          emailAddress: agentEmailAddress(ctx, updated),
          owner: {
            id: owner?.id ?? updated.ownerHumanId,
            displayName: owner?.displayName ?? '',
          },
          roleTitle: updated.roleTitle ?? null,
          roleInstructions: updated.roleInstructions ?? null,
          roleUpdatedAt: updated.roleUpdatedAt ?? null,
          // The response shape is shared with GET /me; send the caller's real
          // presence rather than letting the schema default it to "offline".
          presence: ctx.rooms.principalPresence('agent', updated.id),
        },
      };
      return reply.send(response);
    }

    const human = principal.human;
    const body = parse(UpdateMeRequestSchema, request.body);

    const patch: { displayName?: string; theme?: string } = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.theme !== undefined) patch.theme = body.theme;
    ctx.db.update(humans).set(patch).where(eq(humans.id, human.id)).run();

    if (body.displayName !== undefined && body.displayName !== human.displayName) {
      emitPrincipalRenamed(ctx, 'human', human.id);
    }

    const response: MeResponse = {
      principal: {
        type: 'human',
        id: human.id,
        email: human.email,
        displayName: body.displayName ?? human.displayName,
        theme: resolveTheme(body.theme ?? human.theme),
        presence: ctx.rooms.principalPresence('human', human.id),
      },
    };
    return reply.send(response);
  });
}
