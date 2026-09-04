/**
 * The docs door — a pure REDIRECT surface (SPEC "Canonical public homes").
 *
 * Documentation has ONE home, `DOCS_URL` (default `https://sparrow.land/docs`),
 * built from this same source tree and published at site deploy. The instance
 * serves none of it: `GET /docs` and `GET /docs/*` answer `302` to the matching
 * page under that home, so old links and old clients keep working while every
 * document, dialog, hint and README names the canonical URL.
 *
 * `/docs/api/<segment>` keeps the invite doc's Accept/User-Agent negotiation —
 * a machine caller is sent to the `.md` file it can actually parse, a browser to
 * the rendered reference — because the `docs` URLs the API emits (hints, 4xx
 * envelopes) are the `.md` ones, and an agent following an old instance-local
 * link must land on markdown, not on HTML it has to scrape. There is one human
 * REST reference page (`DOCS_URL/api/`), so every browser lands there whichever
 * segment it asked for; only the markdown is per-segment.
 *
 * The markdown itself still lives in `docs-content.ts`: the website build dumps
 * it with `pnpm --filter @sparrow/api dump-docs`, so the pages at the home and
 * the server that emits their URLs never drift apart.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { apiDocMarkdownUrl, apiDocPageUrl, docsHome, docsPageUrl } from '../public-homes.js';
import { userAgentPrefersMarkdown } from './onboarding.js';

/**
 * Fastify route pattern → docs segment, so 4xx responses on documented endpoints
 * can carry a `docs` URL (`DOCS_URL/api/<segment>.md`) without every throw having
 * to name its page. Keyed by the exact matched `routeOptions.url`.
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
  // The voice medium. Both transcription shapes and the speech-back route hang
  // off one page, and so does the `origin: 'voice'` marker they produce — a
  // `404` here (no speech provider) is exactly the case that needs the page.
  '/api/v1/voice/transcriptions': 'voice',
  '/api/v1/voice/transcriptions/stream': 'voice',
  '/api/v1/rooms/:roomId/messages/:id/speech': 'voice',
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

/**
 * Whether this request should be sent to the raw markdown rather than the
 * rendered page. Same rule as `/invite/:token`: `?format=md` forces markdown, an
 * agent-ish User-Agent gets markdown, and anything not asking for `text/html`
 * gets markdown.
 */
export function wantsMarkdown(
  accept: string,
  format: string | undefined,
  ua: string | undefined,
): boolean {
  if (format === 'md' || format === 'markdown') return true;
  return userAgentPrefersMarkdown(ua) || !accept.includes('text/html');
}

/** `?format=` normalized to lowercase, or undefined. */
function formatOf(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.toLowerCase() : undefined;
}

/** Trim the surrounding slashes off a wildcard capture. */
function trimSlashes(raw: string | undefined): string {
  return (raw ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function registerDocsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const home = (): string => docsHome(ctx.config);
  const go = (reply: FastifyReply, url: string): FastifyReply => reply.redirect(url, 302);

  /* ------------------------- getting-started root -------------------- */
  app.get('/docs', (_request, reply) => go(reply, docsPageUrl(home())));

  /* ---------------------------- API index ---------------------------- */
  app.get<{ Querystring: { format?: string } }>('/docs/api', (request, reply) => {
    const md = wantsMarkdown(
      request.headers.accept ?? '',
      formatOf(request.query.format),
      request.headers['user-agent'],
    );
    return go(reply, md ? apiDocMarkdownUrl(home()) : apiDocPageUrl(home()));
  });

  /* ---------------------------- API page ----------------------------- */
  app.get<{ Params: { '*': string }; Querystring: { format?: string } }>(
    '/docs/api/*',
    (request, reply) => {
      const segment = trimSlashes(request.params['*']);
      // An unknown segment redirects too: the home is the authority on which
      // pages exist, and a 404 rendered here would be a second, staler answer.
      const md = wantsMarkdown(
        request.headers.accept ?? '',
        formatOf(request.query.format),
        request.headers['user-agent'],
      );
      // The human REST reference is ONE page (`DOCS_URL/api/`); only the machine
      // side is per-segment, so a browser always lands on that single page.
      return go(reply, md ? apiDocMarkdownUrl(home(), segment) : apiDocPageUrl(home()));
    },
  );

  /* ------------------- every other docs page (HTML) ------------------ */
  // `concepts`, `cli`, `mcp`, `self-hosting`, … are prose pages that only ever
  // existed as rendered HTML, so there is nothing to negotiate: one target each.
  app.get<{ Params: { '*': string } }>('/docs/*', (request, reply) =>
    go(reply, docsPageUrl(home(), trimSlashes(request.params['*']))),
  );
}
