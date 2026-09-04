/**
 * Docs-by-URL-convention: `GET /docs/api` (index) and `GET /docs/api/<segment>`
 * serve markdown to non-browser callers and fall through to the SPA for browsers
 * (the same Accept/User-Agent negotiation the invite doc uses), so an agent that
 * follows a hint's or an error's docs URL gets concrete markdown while a human
 * lands on the rendered docs page. Every page is anchored to the request's own
 * effective origin, keeping self-hosted instances self-referential.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ErrorResponse } from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { effectiveOrigin } from '../effective-origin.js';
import { userAgentPrefersMarkdown } from './onboarding.js';
import { renderDocPage, renderDocsIndex } from './docs-content.js';
import { emailMediumOn } from '../email/addresses.js';

/**
 * Fastify route pattern → docs segment, so 4xx responses on documented endpoints
 * can carry a `docs` URL (built from the request origin) without every throw
 * having to name its page. Keyed by the exact matched `routeOptions.url`.
 */
export const DOCS_BY_ROUTE: Record<string, string> = {
  '/api/v1/rooms/:roomId/messages': 'rooms/messages',
  '/api/v1/rooms/:roomId/inbox': 'me/inbox',
  '/api/v1/rooms/:roomId/inbox/pop': 'me/inbox',
  '/api/v1/rooms/:roomId/status': 'rooms/status',
  '/api/v1/rooms/:roomId/attachments/:id': 'attachments',
  '/api/v1/me/inbox': 'me/inbox',
  '/api/v1/me/inbox/pop': 'me/inbox',
  '/api/v1/me/messages/:messageId': 'me/messages',
  '/api/v1/me/messages/:messageId/read': 'me/messages',
  '/api/v1/me/events': 'me/events',
  '/api/v1/me/events/log': 'me/events',
  '/api/v1/me/presence': 'me/presence',
  '/api/v1/me/dms': 'me/dms',
  // Agent↔agent oversight + the sever/allow controls: the 403s here (no common
  // viewer, severed pair) are exactly the ones that need the rule spelled out.
  '/api/v1/orgs/:orgId/agent-dms': 'me/dms',
  '/api/v1/orgs/:orgId/agent-dms/:roomId/messages': 'me/dms',
  '/api/v1/orgs/:orgId/agent-dms/:roomId/sever': 'me/dms',
  '/api/v1/orgs/:orgId/agent-dms/:roomId/allow': 'me/dms',
  // Org room governance (list + archive/restore) lives on the orgs page.
  '/api/v1/orgs/:orgId/rooms': 'orgs',
  '/api/v1/orgs/:orgId/rooms/:roomId': 'orgs',
  // The invite door. A DEAD invite is the most common 4xx a stranger meets, and
  // the envelope is all a CLI or a fetch-only agent has to go on — point it at
  // the page that explains 404-vs-410.
  '/invite/:token': 'invite',
  '/api/v1/invite/:token/info': 'invite',
  '/api/v1/invite/:token/enroll': 'invite',
  '/api/v1/invite/:token/enrollments/:eid': 'invite',
  '/api/v1/me/hint-preferences': 'me/hint-preferences',
  '/api/v1/me/hints': 'me/hint-preferences',
  '/api/v1/me': 'me',
  // The email medium's surfaces (their pages are served only when it is on).
  '/api/v1/me/email/address': 'me/email/threads',
  '/api/v1/me/email/threads': 'me/email/threads',
  '/api/v1/me/email/threads/:threadId': 'me/email/threads',
  '/api/v1/me/email/threads/:threadId/reply': 'me/email/threads',
  '/api/v1/me/email/send': 'me/email/threads',
  '/api/v1/me/email/emails/:emailId': 'me/email/threads',
  '/api/v1/me/email/emails/:emailId/retry': 'me/email/threads',
  '/api/v1/me/email/attachments/:attachmentId': 'me/email/threads',
  '/api/v1/orgs/:orgId/email/approvals': 'orgs/email/approvals',
  '/api/v1/orgs/:orgId/email/emails/:emailId': 'orgs/email/approvals',
  '/api/v1/orgs/:orgId/email/emails/:emailId/approve': 'orgs/email/approvals',
  '/api/v1/orgs/:orgId/email/emails/:emailId/deny': 'orgs/email/approvals',
  '/api/v1/orgs/:orgId/email/contacts': 'orgs/email/approvals',
  '/api/v1/orgs/:orgId/email/contacts/:contactId': 'orgs/email/approvals',
};

interface DocsOptions {
  /** Static web root (contains index.html) when the SPA is bundled; else undefined. */
  staticRoot?: string;
}

function notFoundEnvelope(message = 'No such docs page'): ErrorResponse {
  return { error: { code: 'not_found', message } };
}

function serveSpaOr404(reply: FastifyReply, staticRoot: string | undefined): FastifyReply {
  if (staticRoot) {
    const indexPath = path.join(staticRoot, 'index.html');
    if (existsSync(indexPath)) {
      return reply.type('text/html').send(readFileSync(indexPath));
    }
  }
  return reply.code(404).type('application/json').send(notFoundEnvelope());
}

/** Whether this request should get markdown rather than the SPA. */
function wantsMarkdown(
  accept: string,
  format: string | undefined,
  ua: string | undefined,
): boolean {
  const forced = format === 'md' || format === 'markdown';
  if (forced) return true;
  // Browsers (browser UA + text/html) keep the SPA; everyone else gets markdown.
  return userAgentPrefersMarkdown(ua) || !accept.includes('text/html');
}

export function registerDocsRoutes(app: FastifyInstance, ctx: AppContext, opts: DocsOptions): void {
  /* ------------------------------- index ----------------------------- */
  app.get<{ Querystring: { format?: string } }>('/docs/api', (request, reply) => {
    const accept = request.headers.accept ?? '';
    const format = typeof request.query.format === 'string' ? request.query.format.toLowerCase() : undefined;
    if (!wantsMarkdown(accept, format, request.headers['user-agent'])) {
      return serveSpaOr404(reply, opts.staticRoot);
    }
    return reply
      .type('text/markdown; charset=utf-8')
      .send(renderDocsIndex(effectiveOrigin(request, ctx.config), { email: emailMediumOn(ctx) }));
  });

  /* ------------------------------- page ------------------------------ */
  app.get<{ Params: { '*': string }; Querystring: { format?: string } }>(
    '/docs/api/*',
    (request, reply) => {
      const accept = request.headers.accept ?? '';
      const format =
        typeof request.query.format === 'string' ? request.query.format.toLowerCase() : undefined;
      const browser = !wantsMarkdown(accept, format, request.headers['user-agent']);
      if (browser) return serveSpaOr404(reply, opts.staticRoot);
      const segment = (request.params['*'] ?? '').replace(/\/+$/, '');
      const md = renderDocPage(effectiveOrigin(request, ctx.config), segment, {
        email: emailMediumOn(ctx),
      });
      if (md === undefined) {
        return reply.code(404).type('application/json').send(notFoundEnvelope());
      }
      return reply.type('text/markdown; charset=utf-8').send(md);
    },
  );
}
