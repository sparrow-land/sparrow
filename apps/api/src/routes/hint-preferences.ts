/**
 * The agent's own hint surfaces.
 *
 * `GET`/`PUT /me/hint-preferences` — the hint LEVEL. The persistent counterpart
 * to the per-request `X-Sparrow-No-Hints: 1` header: an agent dials its coaching
 * up (`aggressive`), leaves it at the daily default (`normal`), or silences it
 * (`off`). Hints exist so the agent can serve its human, so the GET response
 * ships a `choices` menu that spells out what each level costs/buys.
 *
 * `GET /me/hints` — the ASK. The right time to teach an agent is between tasks,
 * and the right channel is one the agent CHOSE: this is that channel. It runs the
 * trigger engine on demand and returns EVERY lesson that currently applies,
 * recording nothing (see {@link previewHints}).
 *
 * Agents are the audience on all three (humans use the web and are never hinted),
 * so a human caller gets `403`.
 */
import type { FastifyInstance } from 'fastify';
import {
  UpdateHintPreferencesRequestSchema,
  type HintPreferencesResponse,
  type MeHintsResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { parse } from '../validate.js';
import { forbidden } from '../errors.js';
import {
  getHintLevel,
  setHintLevel,
  clientVersionOf,
  hintOrigin,
  previewHints,
  HINT_LEVEL_CHOICES,
} from '../hints.js';

export function registerHintPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const body = (level: ReturnType<typeof getHintLevel>): HintPreferencesResponse => ({
    level,
    choices: HINT_LEVEL_CHOICES,
  });

  /* ------------------------------- GET /me/hint-preferences ---------- */
  app.get('/api/v1/me/hint-preferences', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    if (principal.type !== 'agent') throw forbidden('Hint preferences are an agent setting');
    return reply.send(body(getHintLevel(ctx, principalIdent(principal))));
  });

  /* ------------------------------- PUT /me/hint-preferences ---------- */
  app.put('/api/v1/me/hint-preferences', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    if (principal.type !== 'agent') throw forbidden('Hint preferences are an agent setting');
    const input = parse(UpdateHintPreferencesRequestSchema, request.body ?? {});
    setHintLevel(ctx, principalIdent(principal), input.level);
    return reply.send(body(input.level));
  });

  /* ------------------------------- GET /me/hints --------------------- */
  // The tips view (`sparrow tips`). Unlike the pause, nothing here is gated on a
  // cooldown or the `off` level — the agent asked, and an explicit question is
  // not an interruption — and nothing is recorded, so reading tips never burns a
  // delivery that a real pause would otherwise have taught. `hints` is ALWAYS
  // present (possibly `[]`): this is a list endpoint, not a decorated response.
  app.get('/api/v1/me/hints', (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    if (principal.type !== 'agent') throw forbidden('Hints are an agent surface');
    const response: MeHintsResponse = {
      hints: previewHints(ctx, principalIdent(principal), {
        origin: hintOrigin(request, ctx),
        clientVersion: clientVersionOf(request),
      }),
    };
    return reply.send(response);
  });
}
