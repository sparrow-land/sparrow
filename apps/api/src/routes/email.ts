/**
 * The email medium's HTTP surface (SPEC v4 "The email medium → Routes"):
 * the agent's own mailbox (`/me/email/*`, agent key), the human/org surfaces
 * (`/orgs/:orgId/email/*` + the per-agent reads, session), the inbound seam
 * (`POST /email/inbound`, bearer `EMAIL_INBOUND_TOKEN`), and the fake provider's
 * admin/test surface.
 *
 * Two rules run through everything here. **With the medium off every route
 * `404`s** — including for org owners; a client learns a medium exists from
 * `GET /capabilities`, never by taking a 404. And **mail is correspondence, not
 * room data**: reading an agent's threads requires its owner, an org
 * owner/admin, or the admin token — `canAccessAgent` does NOT admit a reader,
 * and a caller outside that set gets `404`, never `403`, so an agent mailbox's
 * existence never leaks.
 */
import { and, asc, desc, eq, inArray, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApproveEmailRequestSchema,
  DenyEmailRequestSchema,
  EMAIL_INBOUND_MAX_BYTES,
  ListContactsQuerySchema,
  ListEmailApprovalsQuerySchema,
  ListEmailThreadsQuerySchema,
  PageQuerySchema,
  ReadEmailQuerySchema,
  ReplyEmailRequestSchema,
  SendEmailRequestSchema,
  UpdateContactRequestSchema,
  type AdminEmailOutboxResponse,
  type EmailAddressResponse,
  type EmailApprovalItem,
  type EmailMutationResponse,
  type GetEmailResponse,
  type GetEmailThreadResponse,
  type InboundEmailResponse,
  type ListContactsResponse,
  type ListEmailApprovalsResponse,
  type ListEmailThreadsResponse,
  type OrgRole,
  type SendEmailResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso, resolvePrincipal } from '../context.js';
import {
  agents,
  emailAttachments,
  emailQuarantine,
  emails,
  emailThreads,
  externalContacts,
} from '../db/schema.js';
import type { AgentRow, EmailRow, EmailThreadRow, OrgRow } from '../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  payloadTooLarge,
  unauthorized,
} from '../errors.js';
import { membershipOf, roleAtLeast } from '../org-helpers.js';
import {
  beforeCondition,
  cursorCondition,
  pageResult,
  resolveLimit,
  transcriptResult,
  withCursor,
} from '../pagination.js';
import { parse } from '../validate.js';
import { adminGuard } from './admin.js';
import {
  agentAddress,
  agentAddressDomain,
  canonicalAddress,
  emailMediumOn,
  orgById,
} from '../email/addresses.js';
import { deliverInbound, orgEmailSettings } from '../email/inbound.js';
import { announceEmail } from '../email/notify.js';
import { relayAndFinish, sendOutbound } from '../email/outbound.js';
import {
  contactById,
  contactByEmail,
  emailById,
  markEmailRead,
  oversightEmailById,
  releaseFromQuarantine,
  rejectInQuarantine,
  parseParticipants,
  parseVerification,
  parseJudge,
  readAttachmentBytes,
  reapRejectedEmails,
  resolveTrustSet,
  setContactTrust,
  threadById,
  threadHasAgentVisibleMail,
  toEmail,
  toEmailPreview,
  toExternalContact,
  toThread,
  toThreadRef,
  trustThread,
  upsertContact,
} from '../email/store.js';
import { recognized } from '../email/trust.js';

/** With the medium off, every route in this file is invisible. */
function requireMedium(ctx: AppContext): void {
  if (!emailMediumOn(ctx)) throw notFound('Not found');
}

/**
 * The caller of a `/me/email/*` route. A HUMAN session is `403`: email addresses
 * belong to agents, and humans read their agents' mail through the org surfaces.
 */
function requireAgentCaller(
  ctx: AppContext,
  request: FastifyRequest,
): { agent: AgentRow; org: OrgRow; address: string } {
  const principal = resolvePrincipal(ctx, request);
  if (principal.type !== 'agent') throw forbidden('email addresses belong to agents');
  const org = orgById(ctx, principal.agent.orgId);
  const address = agentAddress(ctx, principal.agent);
  if (!org || !address) throw notFound('Not found');
  return { agent: principal.agent, org, address };
}

/** Whether the request carries the instance admin token (an operator read). */
function isAdminToken(ctx: AppContext, request: FastifyRequest): boolean {
  return !!ctx.config.adminToken && request.headers['x-admin-token'] === ctx.config.adminToken;
}

/**
 * Whether a human may read an agent's mail: its OWNER, or an org owner/admin.
 * Deliberately not `canAccessAgent` — a colleague with `sharing: 'org'` access
 * may DM the agent but may not read its correspondence.
 */
function mayReadAgentMail(ctx: AppContext, agent: AgentRow, humanId: string): boolean {
  if (agent.ownerHumanId === humanId) return true;
  const membership = membershipOf(ctx.db, agent.orgId, humanId);
  return !!membership && roleAtLeast(membership.role as OrgRole, 'admin');
}

/** Resolve `(orgId, agentId)` for a human/admin reader, 404ing on every failure. */
function requireReadableAgent(
  ctx: AppContext,
  request: FastifyRequest,
  orgId: string,
  agentId: string,
): { agent: AgentRow; org: OrgRow } {
  const agent = ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
  const org = orgById(ctx, orgId);
  if (!agent || !org || agent.orgId !== orgId) throw notFound('No such agent');
  if (!isAdminToken(ctx, request)) {
    const human = ctx.auth.requireSession(request);
    if (!mayReadAgentMail(ctx, agent, human.id)) throw notFound('No such agent');
  }
  return { agent, org };
}

/** The org membership a `/orgs/:orgId/email/*` caller needs, or the admin token. */
function requireOrgReader(
  ctx: AppContext,
  request: FastifyRequest,
  orgId: string,
): { humanId: string | null; role: OrgRole | null; org: OrgRow } {
  const org = orgById(ctx, orgId);
  if (!org) throw notFound('No such org');
  if (isAdminToken(ctx, request)) return { humanId: null, role: null, org };
  const human = ctx.auth.requireSession(request);
  const membership = membershipOf(ctx.db, orgId, human.id);
  // Non-members of the org get `404` on every `/orgs/:orgId/email/*` route.
  if (!membership) throw notFound('No such org');
  return { humanId: human.id, role: membership.role as OrgRole, org };
}

/** A thread the caller's agent anchors, else 404 (foreign is indistinguishable). */
function requireOwnThread(ctx: AppContext, agent: AgentRow, threadId: string): EmailThreadRow {
  const thread = threadById(ctx, threadId);
  if (!thread || thread.agentId !== agent.id) throw notFound('No such thread');
  return thread;
}

/**
 * The AGENT-caller variant: additionally 404s a thread that holds no
 * agent-visible mail. A thread whose only message is a quarantined/rejected
 * stranger's must not exist for the agent — not its id, not its subject —
 * exactly as the thread LIST already hides it (`lastEmailAt` null).
 */
function requireOwnVisibleThread(
  ctx: AppContext,
  agent: AgentRow,
  threadId: string,
): EmailThreadRow {
  const thread = requireOwnThread(ctx, agent, threadId);
  if (!threadHasAgentVisibleMail(ctx, thread.id)) throw notFound('No such thread');
  return thread;
}

/** The thread list's tiebreak: insertion order, as every transcript uses. */
const THREAD_ROWID = sql`${emailThreads}.rowid`;

/**
 * One page of an agent's threads (≥1 delivered/sent email). A TRANSCRIPT:
 * newest-first by `lastEmailAt` — the key its index and its UI both order by —
 * walked backward with a thread-id `before` cursor.
 *
 * Items are FULL threads, not refs. A triage list that cannot show unread, who
 * is on the thread, or how the last email ended is not a triage list, and the
 * alternative — a client enriching each row — costs one request per row.
 */
function threadPage(
  ctx: AppContext,
  agentId: string,
  query: { limit?: number; before?: string },
): ListEmailThreadsResponse {
  const limit = resolveLimit(query.limit);
  const base = and(eq(emailThreads.agentId, agentId), isNotNull(emailThreads.lastEmailAt));
  // `before` is a THREAD-ID cursor resolved inside this agent's own listing, so
  // a foreign or invisible id is as invalid as one that never existed.
  let anchor: { orderValue: string; tiebreak: unknown } | undefined;
  if (query.before) {
    const row = ctx.db
      .select({ lastEmailAt: emailThreads.lastEmailAt, rowid: THREAD_ROWID })
      .from(emailThreads)
      .where(withCursor(base, eq(emailThreads.id, query.before)))
      .get() as { lastEmailAt: string | null; rowid: number } | undefined;
    if (!row?.lastEmailAt) throw badRequest('Invalid before cursor');
    anchor = { orderValue: row.lastEmailAt, tiebreak: row.rowid };
  }
  const rows = ctx.db
    .select({ row: emailThreads, rowid: THREAD_ROWID })
    .from(emailThreads)
    .where(withCursor(base, beforeCondition(emailThreads.lastEmailAt, THREAD_ROWID, anchor)))
    .orderBy(desc(emailThreads.lastEmailAt), desc(THREAD_ROWID))
    .limit(limit + 1)
    .all() as { row: EmailThreadRow; rowid: number }[];
  return transcriptResult(
    rows,
    limit,
    (r) => toThread(ctx, r.row),
    (r) => r.row.id,
  );
}

/**
 * One page of a thread's emails, ascending, always a peek.
 *
 * The AGENT reads the `emails` table only — its own outbound rows (whatever
 * their fate) and DELIVERED inbound; the direction/disposition filter is kept
 * as armor on top of the table split. A quarantined stranger's message is the
 * HUMAN's to see first — it enters the agent's transcript only when approval
 * moves it across. Overseers (owner / org admins via the org route) read the
 * UNION of both tables, quarantine rows interleaved by `(createdAt, id)`: that
 * view is the approval surface.
 */
function threadEmailPage(
  ctx: AppContext,
  thread: EmailThreadRow,
  query: { limit?: number; cursor?: string },
  audience: 'agent' | 'overseer' = 'overseer',
): GetEmailThreadResponse {
  const limit = resolveLimit(query.limit);
  const cursor = cursorCondition(emails.createdAt, emails.id, query.cursor);
  const visible =
    audience === 'agent'
      ? and(
          eq(emails.threadId, thread.id),
          or(eq(emails.direction, 'out'), eq(emails.disposition, 'delivered'))!,
        )!
      : eq(emails.threadId, thread.id);
  let rows = ctx.db
    .select()
    .from(emails)
    .where(withCursor(visible, cursor))
    .orderBy(asc(emails.createdAt), asc(emails.id))
    .limit(limit + 1)
    .all();
  if (audience === 'overseer') {
    const qCursor = cursorCondition(emailQuarantine.createdAt, emailQuarantine.id, query.cursor);
    const qRows = ctx.db
      .select()
      .from(emailQuarantine)
      .where(withCursor(eq(emailQuarantine.threadId, thread.id), qCursor))
      .orderBy(asc(emailQuarantine.createdAt), asc(emailQuarantine.id))
      .limit(limit + 1)
      .all();
    rows = [...rows, ...qRows]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit + 1);
  }
  const page = pageResult(
    rows,
    limit,
    (r) => toEmail(ctx, r),
    (r) => ({ createdAt: r.createdAt, id: r.id }),
  );
  return { thread: toThread(ctx, thread), items: page.items, nextCursor: page.nextCursor };
}

/** Send an attachment as a forced download (mirroring chat's GetAttachment). */
function sendAttachment(
  ctx: AppContext,
  reply: FastifyReply,
  attachmentId: string,
  emailIds: Set<string>,
): unknown {
  const att = ctx.db
    .select()
    .from(emailAttachments)
    .where(eq(emailAttachments.id, attachmentId))
    .get();
  if (!att || !emailIds.has(att.emailId)) throw notFound('No such attachment');
  const bytes = readAttachmentBytes(ctx, att.id);
  if (!bytes) throw notFound('Attachment file missing');
  return reply
    .header('content-type', att.contentType)
    .header('content-disposition', `attachment; filename="${att.filename.replace(/"/g, '')}"`)
    .send(bytes);
}

/**
 * Every email id the AGENT may read attachments of: its own outbound rows and
 * DELIVERED inbound (the attachment read gate). Quarantined/rejected inbound
 * rows live in `email_quarantine` and never enter this set — the direction/
 * disposition filter is kept anyway as a second, cheap layer.
 */
function agentEmailIds(ctx: AppContext, agentId: string): Set<string> {
  return new Set(
    ctx.db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.agentId, agentId),
          or(eq(emails.direction, 'out'), eq(emails.disposition, 'delivered'))!,
        ),
      )
      .all()
      .map((r) => r.id),
  );
}

/** The agents whose approvals a caller may see: theirs (owner) or all (admin). */
function approvableAgentIds(
  ctx: AppContext,
  orgId: string,
  reader: { humanId: string | null; role: OrgRole | null },
): string[] | null {
  if (reader.humanId === null) return null; // admin token: everything
  if (reader.role && roleAtLeast(reader.role, 'admin')) return null; // org owner/admin
  return ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.ownerHumanId, reader.humanId)))
    .all()
    .map((r) => r.id);
}

/**
 * An email in an org that the caller may resolve/read, else 404. An OVERSIGHT
 * resolver: it reads across both storage sides — `emails` and
 * `email_quarantine` — and says which one held the row, so approve/deny know
 * whether a resolution moves the row or updates it in place.
 */
function requireOrgEmail(
  ctx: AppContext,
  orgId: string,
  emailId: string,
  scope: string[] | null,
): { email: EmailRow; thread: EmailThreadRow; agent: AgentRow; quarantined: boolean } {
  const found = oversightEmailById(ctx, emailId);
  if (!found || found.row.orgId !== orgId) throw notFound('No such email');
  const row = found.row;
  if (scope && !scope.includes(row.agentId)) throw notFound('No such email');
  const thread = threadById(ctx, row.threadId);
  const agent = ctx.db.select().from(agents).where(eq(agents.id, row.agentId)).get();
  if (!thread || !agent) throw notFound('No such email');
  return { email: row, thread, agent, quarantined: found.quarantined };
}

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ================================================================== *
   * The inbound seam
   * ================================================================== */
  // Bearer `EMAIL_INBOUND_TOKEN` (constant-time compare) else 401. Without the
  // token configured this ONE route 404s even while the medium is on — an
  // inbound seam with no credential is not a seam.
  app.post('/api/v1/email/inbound', async (request, reply) => {
    requireMedium(ctx);
    const expected = ctx.email.inboundToken;
    if (!expected) throw notFound('Not found');
    const header = request.headers.authorization ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!constantTimeEquals(presented, expected)) throw unauthorized('Invalid inbound token');
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > EMAIL_INBOUND_MAX_BYTES) {
      throw payloadTooLarge('Inbound email is too large');
    }
    // Lazily reap 30-day-old rejections so the queue of refusals stays bounded.
    reapRejectedEmails(ctx);
    const response: InboundEmailResponse = await deliverInbound(ctx, request.body);
    return reply.code(202).send(response);
  });

  /* ================================================================== *
   * Agent surfaces — `/me/email/*`
   * ================================================================== */
  app.get('/api/v1/me/email/address', (request, reply) => {
    requireMedium(ctx);
    const caller = requireAgentCaller(ctx, request);
    const response: EmailAddressResponse = {
      address: caller.address,
      domain: agentAddressDomain(ctx, caller.agent) ?? '',
      orgId: caller.agent.orgId,
      agentId: caller.agent.id,
    };
    return reply.send(response);
  });

  app.get('/api/v1/me/email/threads', (request, reply) => {
    requireMedium(ctx);
    const caller = requireAgentCaller(ctx, request);
    const query = parse(ListEmailThreadsQuerySchema, request.query ?? {});
    return reply.send(threadPage(ctx, caller.agent.id, query));
  });

  app.get<{ Params: { threadId: string } }>(
    '/api/v1/me/email/threads/:threadId',
    (request, reply) => {
      requireMedium(ctx);
      const caller = requireAgentCaller(ctx, request);
      const thread = requireOwnVisibleThread(ctx, caller.agent, request.params.threadId);
      const query = parse(PageQuerySchema, request.query ?? {});
      return reply.send(threadEmailPage(ctx, thread, query, 'agent'));
    },
  );

  app.get<{ Params: { emailId: string } }>('/api/v1/me/email/emails/:emailId', (request, reply) => {
    requireMedium(ctx);
    const caller = requireAgentCaller(ctx, request);
    const row = emailById(ctx, request.params.emailId);
    if (!row || row.agentId !== caller.agent.id) throw notFound('No such email');
    // Inbound mail exists for the AGENT only once `delivered` — a quarantined
    // or rejected stranger's message must not leak (body OR existence) before
    // the human rules on it. 404, indistinguishable from no-such-id.
    if (row.direction === 'in' && row.disposition !== 'delivered') {
      throw notFound('No such email');
    }
    const query = parse(ReadEmailQuerySchema, request.query ?? {});
    // A non-peek read sets `read_at` — but only on an inbound DELIVERED email,
    // the only kind that carries read state.
    if (!query.peek && row.direction === 'in' && row.disposition === 'delivered') {
      markEmailRead(ctx, row);
    }
    const response: GetEmailResponse = { email: toEmail(ctx, row) };
    return reply.send(response);
  });

  app.post<{ Params: { threadId: string } }>(
    '/api/v1/me/email/threads/:threadId/reply',
    async (request, reply) => {
      requireMedium(ctx);
      const caller = requireAgentCaller(ctx, request);
      const thread = requireOwnVisibleThread(ctx, caller.agent, request.params.threadId);
      const body = parse(ReplyEmailRequestSchema, request.body ?? {});
      const result = await sendOutbound(ctx, {
        agent: caller.agent,
        org: caller.org,
        agentAddress: caller.address,
        thread,
        cc: body.cc,
        text: body.text,
        attachments: body.attachments,
      });
      const response: EmailMutationResponse = { email: toEmail(ctx, result.email) };
      if (result.http === 403) throw forbidden('This email was refused by your org’s email policy');
      return reply.code(result.http).send(response);
    },
  );

  app.post('/api/v1/me/email/send', async (request, reply) => {
    requireMedium(ctx);
    const caller = requireAgentCaller(ctx, request);
    const body = parse(SendEmailRequestSchema, request.body ?? {});
    const result = await sendOutbound(ctx, {
      agent: caller.agent,
      org: caller.org,
      agentAddress: caller.address,
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      text: body.text,
      attachments: body.attachments,
    });
    if (result.http === 403) throw forbidden('This email was refused by your org’s email policy');
    const response: SendEmailResponse = {
      email: toEmail(ctx, result.email),
      thread: toThreadRef(result.thread),
    };
    return reply.code(result.http).send(response);
  });

  app.post<{ Params: { emailId: string } }>(
    '/api/v1/me/email/emails/:emailId/retry',
    async (request, reply) => {
      requireMedium(ctx);
      const caller = requireAgentCaller(ctx, request);
      const row = emailById(ctx, request.params.emailId);
      if (!row || row.agentId !== caller.agent.id) throw notFound('No such email');
      if (row.disposition !== 'send-failed') throw conflict('This email is not send-failed');
      const thread = threadById(ctx, row.threadId);
      if (!thread) throw notFound('No such email');
      const relayed = await relayAndFinish(ctx, {
        agent: caller.agent,
        org: caller.org,
        thread,
        row,
        agentAddress: caller.address,
      });
      const response: EmailMutationResponse = { email: toEmail(ctx, relayed) };
      return reply.code(202).send(response);
    },
  );

  app.get<{ Params: { attachmentId: string } }>(
    '/api/v1/me/email/attachments/:attachmentId',
    (request, reply) => {
      requireMedium(ctx);
      const caller = requireAgentCaller(ctx, request);
      return sendAttachment(
        ctx,
        reply as unknown as FastifyReply,
        request.params.attachmentId,
        agentEmailIds(ctx, caller.agent.id),
      );
    },
  );

  /* ================================================================== *
   * Human / org surfaces
   * ================================================================== */
  app.get<{ Params: { orgId: string; agentId: string } }>(
    '/api/v1/orgs/:orgId/agents/:agentId/email/address',
    (request, reply) => {
      requireMedium(ctx);
      const { agent } = requireReadableAgent(ctx, request, request.params.orgId, request.params.agentId);
      const response: EmailAddressResponse = {
        address: agentAddress(ctx, agent) ?? '',
        domain: agentAddressDomain(ctx, agent) ?? '',
        orgId: agent.orgId,
        agentId: agent.id,
      };
      return reply.send(response);
    },
  );

  app.get<{ Params: { orgId: string; agentId: string } }>(
    '/api/v1/orgs/:orgId/agents/:agentId/email/threads',
    (request, reply) => {
      requireMedium(ctx);
      const { agent } = requireReadableAgent(ctx, request, request.params.orgId, request.params.agentId);
      const query = parse(ListEmailThreadsQuerySchema, request.query ?? {});
      return reply.send(threadPage(ctx, agent.id, query));
    },
  );

  app.get<{ Params: { orgId: string; agentId: string; threadId: string } }>(
    '/api/v1/orgs/:orgId/agents/:agentId/email/threads/:threadId',
    (request, reply) => {
      requireMedium(ctx);
      const { agent } = requireReadableAgent(ctx, request, request.params.orgId, request.params.agentId);
      const thread = requireOwnThread(ctx, agent, request.params.threadId);
      const query = parse(PageQuerySchema, request.query ?? {});
      // Always a peek: a human reading never marks the agent's mail read.
      return reply.send(threadEmailPage(ctx, thread, query));
    },
  );

  app.get<{ Params: { orgId: string; emailId: string } }>(
    '/api/v1/orgs/:orgId/email/emails/:emailId',
    (request, reply) => {
      requireMedium(ctx);
      const reader = requireOrgReader(ctx, request, request.params.orgId);
      const scope = approvableAgentIds(ctx, request.params.orgId, reader);
      const { email } = requireOrgEmail(ctx, request.params.orgId, request.params.emailId, scope);
      const response: GetEmailResponse = { email: toEmail(ctx, email) };
      return reply.send(response);
    },
  );

  app.get<{ Params: { orgId: string; attachmentId: string } }>(
    '/api/v1/orgs/:orgId/email/attachments/:attachmentId',
    (request, reply) => {
      requireMedium(ctx);
      const reader = requireOrgReader(ctx, request, request.params.orgId);
      const scope = approvableAgentIds(ctx, request.params.orgId, reader);
      // Oversight downloads span the split: a human ruling on a quarantined
      // email must be able to open what it carries.
      const readable = new Set(
        [
          ...ctx.db
            .select({ id: emails.id, agentId: emails.agentId })
            .from(emails)
            .where(eq(emails.orgId, request.params.orgId))
            .all(),
          ...ctx.db
            .select({ id: emailQuarantine.id, agentId: emailQuarantine.agentId })
            .from(emailQuarantine)
            .where(eq(emailQuarantine.orgId, request.params.orgId))
            .all(),
        ]
          .filter((r) => !scope || scope.includes(r.agentId))
          .map((r) => r.id),
      );
      return sendAttachment(ctx, reply as unknown as FastifyReply, request.params.attachmentId, readable);
    },
  );

  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/email/approvals', (request, reply) => {
    requireMedium(ctx);
    const reader = requireOrgReader(ctx, request, request.params.orgId);
    const query = parse(ListEmailApprovalsQuerySchema, request.query ?? {});
    const scope = approvableAgentIds(ctx, request.params.orgId, reader);
    const limit = resolveLimit(query.limit);
    if (scope && scope.length === 0) {
      // An owner with no agents sees an empty queue, not everyone's.
      return reply.send({ items: [], nextCursor: null });
    }
    // The queue spans the split: `held` rows are the agent's own outbound and
    // live in `emails`; `quarantined` rows are strangers' inbound and live in
    // `email_quarantine`. Two indexed reads, merged on the one queue order
    // `(createdAt, id)` the cursor already encodes.
    const heldFilters: SQL[] = [
      eq(emails.orgId, request.params.orgId),
      eq(emails.disposition, 'held'),
    ];
    const quarantinedFilters: SQL[] = [
      eq(emailQuarantine.orgId, request.params.orgId),
      eq(emailQuarantine.disposition, 'quarantined'),
    ];
    if (scope) {
      heldFilters.push(inArray(emails.agentId, scope));
      quarantinedFilters.push(inArray(emailQuarantine.agentId, scope));
    }
    if (query.agent) {
      heldFilters.push(eq(emails.agentId, query.agent));
      quarantinedFilters.push(eq(emailQuarantine.agentId, query.agent));
    }
    if (query.direction) {
      heldFilters.push(eq(emails.direction, query.direction));
      quarantinedFilters.push(eq(emailQuarantine.direction, query.direction));
    }
    const cursor = cursorCondition(emails.createdAt, emails.id, query.cursor);
    const qCursor = cursorCondition(emailQuarantine.createdAt, emailQuarantine.id, query.cursor);
    const rows = [
      ...ctx.db
        .select()
        .from(emails)
        .where(withCursor(and(...heldFilters), cursor))
        .orderBy(asc(emails.createdAt), asc(emails.id))
        .limit(limit + 1)
        .all(),
      ...ctx.db
        .select()
        .from(emailQuarantine)
        .where(withCursor(and(...quarantinedFilters), qCursor))
        .orderBy(asc(emailQuarantine.createdAt), asc(emailQuarantine.id))
        .limit(limit + 1)
        .all(),
    ]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit + 1);
    const response: ListEmailApprovalsResponse = pageResult(
      rows,
      limit,
      (r): EmailApprovalItem => {
        const thread = threadById(ctx, r.threadId);
        const agent = ctx.db.select().from(agents).where(eq(agents.id, r.agentId)).get();
        return {
          email: toEmailPreview(ctx, r),
          thread: thread
            ? toThreadRef(thread)
            : {
                id: r.threadId,
                orgId: r.orgId,
                agentId: r.agentId,
                subject: r.subject,
                trusted: false,
                lastEmailAt: null,
                createdAt: r.createdAt,
              },
          agent: { id: r.agentId, name: agent?.name ?? r.agentId },
          verification: parseVerification(r.verification),
          judge: parseJudge(r.judge),
        };
      },
      (r) => ({ createdAt: r.createdAt, id: r.id }),
    );
    return reply.send(response);
  });

  /* ---------------------------- approve ------------------------------ */
  app.post<{ Params: { orgId: string; emailId: string } }>(
    '/api/v1/orgs/:orgId/email/emails/:emailId/approve',
    async (request, reply) => {
      requireMedium(ctx);
      const reader = requireOrgReader(ctx, request, request.params.orgId);
      const scope = approvableAgentIds(ctx, request.params.orgId, reader);
      const { email, thread, agent } = requireOrgEmail(
        ctx,
        request.params.orgId,
        request.params.emailId,
        scope,
      );
      const body = parse(ApproveEmailRequestSchema, request.body ?? {});
      if (email.disposition !== 'quarantined' && email.disposition !== 'held') {
        throw conflict('This email is not waiting on a human');
      }
      const org = reader.org;
      const by = reader.humanId
        ? {
            id: reader.humanId,
            displayName: ctx.auth.requireSession(request).displayName,
          }
        : null;
      const resolverId = reader.humanId ?? agent.ownerHumanId;
      const at = nowIso();
      // Approving is the only way trust is created — and it is durable.
      trustThread(ctx, thread.id);
      thread.trusted = 1;
      const participants = parseParticipants(email.participants);

      if (email.direction === 'in') {
        if (body.trustSender) {
          approveContact(ctx, org, participants.from.email, resolverId);
        }
        // The row MOVES across the trust boundary: out of `email_quarantine`,
        // into `emails` as a freshly delivered, unread email (same id — its
        // attachments and refs follow for free).
        Object.assign(email, releaseFromQuarantine(ctx, email, at));
        ctx.db
          .update(emailThreads)
          .set({ lastEmailAt: at })
          .where(eq(emailThreads.id, thread.id))
          .run();
        thread.lastEmailAt = at;
        announceEmail(ctx, { agent, thread, email, resolution: 'approved', by });
      } else {
        if (body.trustSender) {
          const policy = orgEmailSettings(org);
          const trust = resolveTrustSet(ctx, org, {
            threadTrusted: false,
            trustedPatterns: policy.trustedPatterns,
          });
          for (const party of [...participants.to, ...participants.cc]) {
            if (!recognized(party.email, trust)) approveContact(ctx, org, party.email, resolverId);
          }
        }
        const address = agentAddress(ctx, agent);
        if (!address) throw notFound('No such email');
        await relayAndFinish(ctx, {
          agent,
          org,
          thread,
          row: email,
          agentAddress: address,
          resolution: 'approved',
          by,
        });
      }
      const response: EmailMutationResponse = { email: toEmail(ctx, email) };
      return reply.send(response);
    },
  );

  /* ------------------------------ deny ------------------------------- */
  app.post<{ Params: { orgId: string; emailId: string } }>(
    '/api/v1/orgs/:orgId/email/emails/:emailId/deny',
    (request, reply) => {
      requireMedium(ctx);
      const reader = requireOrgReader(ctx, request, request.params.orgId);
      const scope = approvableAgentIds(ctx, request.params.orgId, reader);
      const { email, thread, agent } = requireOrgEmail(
        ctx,
        request.params.orgId,
        request.params.emailId,
        scope,
      );
      const body = parse(DenyEmailRequestSchema, request.body ?? {});
      if (email.disposition !== 'quarantined' && email.disposition !== 'held') {
        throw conflict('This email is not waiting on a human');
      }
      const by = reader.humanId
        ? { id: reader.humanId, displayName: ctx.auth.requireSession(request).displayName }
        : null;
      const resolverId = reader.humanId ?? agent.ownerHumanId;
      const at = nowIso();
      const participants = parseParticipants(email.participants);
      if (body.blockSender) {
        const targets =
          email.direction === 'in'
            ? [participants.from.email]
            : [...participants.to, ...participants.cc].map((p) => p.email);
        for (const addr of targets) blockContact(ctx, reader.org, addr, resolverId);
      }
      if (email.direction === 'in') {
        // A denied INBOUND email becomes a refusal: it STAYS quarantine-side
        // forever — flipped to rejected/denied, metadata only, no body.
        Object.assign(email, rejectInQuarantine(ctx, email, at));
      } else {
        // A denied OUTBOUND email is the agent's own composition: it stays in
        // `emails`, body intact, so the agent can see what did not go out.
        ctx.db
          .update(emails)
          .set({ disposition: 'rejected', reason: 'denied', resolvedAt: at })
          .where(eq(emails.id, email.id))
          .run();
        email.disposition = 'rejected';
        email.reason = 'denied';
        email.resolvedAt = at;
      }
      // The thread's `trusted` flag is NOT cleared by a deny (a bad message in a
      // good conversation stays a bad message).
      announceEmail(ctx, { agent, thread, email, resolution: 'denied', by });
      const response: EmailMutationResponse = { email: toEmail(ctx, email) };
      return reply.send(response);
    },
  );

  /* ---------------------------- contacts ----------------------------- */
  app.get<{ Params: { orgId: string } }>('/api/v1/orgs/:orgId/email/contacts', (request, reply) => {
    requireMedium(ctx);
    const reader = requireOrgReader(ctx, request, request.params.orgId);
    // Not open to plain org members: the contact list is every external address
    // that has ever written to the org's agents.
    if (reader.humanId !== null && !(reader.role && roleAtLeast(reader.role, 'admin'))) {
      throw notFound('No such org');
    }
    const query = parse(ListContactsQuerySchema, request.query ?? {});
    const limit = resolveLimit(query.limit);
    const filters: SQL[] = [eq(externalContacts.orgId, request.params.orgId)];
    if (query.trust === 'unknown') filters.push(sql`${externalContacts.trust} IS NULL`);
    else if (query.trust) filters.push(eq(externalContacts.trust, query.trust));
    if (query.q) filters.push(like(externalContacts.email, `${canonicalAddress(query.q)}%`));
    const cursor = cursorCondition(
      externalContacts.firstSeenAt,
      externalContacts.id,
      query.cursor,
    );
    const rows = ctx.db
      .select()
      .from(externalContacts)
      .where(withCursor(and(...filters), cursor))
      .orderBy(asc(externalContacts.firstSeenAt), asc(externalContacts.id))
      .limit(limit + 1)
      .all();
    const response: ListContactsResponse = pageResult(
      rows,
      limit,
      (r) => toExternalContact(ctx, r),
      (r) => ({ createdAt: r.firstSeenAt, id: r.id }),
    );
    return reply.send(response);
  });

  app.patch<{ Params: { orgId: string; contactId: string } }>(
    '/api/v1/orgs/:orgId/email/contacts/:contactId',
    (request, reply) => {
      requireMedium(ctx);
      const reader = requireOrgReader(ctx, request, request.params.orgId);
      if (reader.humanId !== null && !(reader.role && roleAtLeast(reader.role, 'admin'))) {
        throw notFound('No such org');
      }
      const contact = contactById(ctx, request.params.orgId, request.params.contactId);
      if (!contact) throw notFound('No such contact');
      const body = parse(UpdateContactRequestSchema, request.body ?? {});
      // Forward-looking: already-delivered email is never withdrawn.
      setContactTrust(ctx, contact.id, body.trust, reader.humanId ?? '');
      const updated = contactById(ctx, request.params.orgId, contact.id)!;
      return reply.send({ contact: toExternalContact(ctx, updated) });
    },
  );

  /* ================================================================== *
   * The fake provider's admin/test surface (present ONLY under `fake`)
   * ================================================================== */
  app.get('/api/v1/admin/email/outbox', (request, reply) => {
    // Present ONLY under `fake` — the absence check comes first so the route is
    // genuinely invisible on every other provider.
    const fake = ctx.email.fake;
    if (!fake) throw notFound('Not found');
    adminGuard(ctx, request);
    const response: AdminEmailOutboxResponse = { items: [...fake.sent] };
    return reply.send(response);
  });

  app.delete('/api/v1/admin/email/outbox', (request, reply) => {
    const fake = ctx.email.fake;
    if (!fake) throw notFound('Not found');
    adminGuard(ctx, request);
    fake.clear();
    return reply.send({ ok: true });
  });

  app.post('/api/v1/admin/email/inject', async (request, reply) => {
    const fake = ctx.email.fake;
    if (!fake) throw notFound('Not found');
    adminGuard(ctx, request);
    // The same pipeline and the same `202` — a scenario chooses the verification
    // verdicts (pass, fail, spoof, spam, virus) without a real MTA.
    const response = await fake.deliver(request.body);
    return reply.code(202).send(response);
  });
}

/** Flip a contact to `approved`, creating the row when this address is new. */
function approveContact(ctx: AppContext, org: OrgRow, address: string, byHumanId: string): void {
  const existing = contactByEmail(ctx, org.id, address) ?? upsertContact(ctx, org.id, address);
  setContactTrust(ctx, existing.id, 'approved', byHumanId);
}

/** Flip a contact to `blocked`, creating the row when this address is new. */
function blockContact(ctx: AppContext, org: OrgRow, address: string, byHumanId: string): void {
  const existing = contactByEmail(ctx, org.id, address) ?? upsertContact(ctx, org.id, address);
  setContactTrust(ctx, existing.id, 'blocked', byHumanId);
}

/** Length-safe constant-time string compare for the inbound bearer. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
