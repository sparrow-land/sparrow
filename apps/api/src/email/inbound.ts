/**
 * The inbound pipeline (SPEC v4 "The email medium → The trust engine → Inbound
 * pipeline" + "The inbound payload").
 *
 * Steps 1–3 run once for the message; steps 4 onward run PER ANCHOR AGENT,
 * against that agent's org policy, and within one anchor the first terminal step
 * wins. The seam's contract is "I have taken custody of this message", not "I
 * liked it": every classification answers `202`, and a `4xx`/`5xx` means the
 * caller should retry or bounce.
 *
 * This module is also what `EMAIL_PROVIDER=fake`'s in-process `deliver()` runs —
 * one pipeline, no HTTP, no token.
 */
import {
  EMAIL_HTML_MAX_BYTES,
  EMAIL_NO_SUBJECT,
  EMAIL_TEXT_MAX_BYTES,
  InboundEmailPayloadSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  newEmailId,
  newEmailThreadId,
  type EmailReason,
  type InboundDelivery,
  type InboundDeliveryStatus,
  type InboundEmailPayload,
  type InboundEmailResponse,
  type InboundStatus,
  type OrgEmailSettings,
} from '@sparrow/common-types';
import { and, eq, gte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import { emailQuarantine, emailWireIds, emails, emailThreads } from '../db/schema.js';
import type { AgentRow, EmailRow, EmailThreadRow, OrgRow } from '../db/schema.js';
import { badRequest, payloadTooLarge, rateLimited } from '../errors.js';
import { parse } from '../validate.js';
import { parseOrgSettings } from '../org-helpers.js';
import { canonicalAddress, resolveAgentAddress } from './addresses.js';
import { announceEmail } from './notify.js';
import { buildJudgePrompt, runJudge } from './judge.js';
import { sanitizeEmailHtml } from './sanitize-html.js';
import {
  decodeAttachments,
  bumpThread,
  parseParticipants,
  resolveTrustSet,
  toParty,
  writeAttachments,
  type StoredParticipants,
} from './store.js';
import { classifyInbound } from './trust.js';

/** Per-org sliding-window inbound counters (in-process; one server, one window). */
const RATE_WINDOWS = new WeakMap<AppContext, Map<string, number[]>>();

/** Charge one inbound message against an org's per-minute cap. */
function chargeRate(ctx: AppContext, orgId: string, now = Date.now()): void {
  let windows = RATE_WINDOWS.get(ctx);
  if (!windows) {
    windows = new Map();
    RATE_WINDOWS.set(ctx, windows);
  }
  const cutoff = now - 60_000;
  const hits = (windows.get(orgId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= ctx.email.inboundRatePerMin) {
    windows.set(orgId, hits);
    throw rateLimited('Too many inbound emails for this org');
  }
  hits.push(now);
  windows.set(orgId, hits);
}

/** RFC 5322 message ids are opaque and compared case-sensitively; normalize the brackets. */
export function normalizeMessageId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return trimmed;
  const bare = trimmed.replace(/^<+/, '').replace(/>+$/, '');
  return `<${bare}>`;
}

/**
 * A relay-reported WIRE `Message-ID` we are willing to record, or `null`. It
 * must be angle-bracketed and carry an `@` — anything else is a provider handle
 * or a mangled value, never a `Message-ID`, and the locally generated id stands.
 */
export function wireMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(trimmed)) return null;
  return normalizeMessageId(trimmed);
}

/** Enforce the medium's size caps that the schema cannot express. */
function assertWithinCaps(payload: InboundEmailPayload): void {
  if (Buffer.byteLength(payload.text, 'utf8') > EMAIL_TEXT_MAX_BYTES) {
    throw payloadTooLarge('Email text body is too large');
  }
  if (payload.html && Buffer.byteLength(payload.html, 'utf8') > EMAIL_HTML_MAX_BYTES) {
    throw payloadTooLarge('Email HTML body is too large');
  }
  let total = 0;
  for (const att of payload.attachments) {
    const size = Buffer.from(att.dataBase64, 'base64').length;
    if (size > MAX_ATTACHMENT_BYTES) throw payloadTooLarge('Attachment is too large');
    total += size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw payloadTooLarge('Attachments are too large');
  }
}

/**
 * How far back the subject fallback will look for a live conversation. Past it
 * a repeated subject line is a new conversation, not a late reply.
 */
const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One leading reply/forward prefix, with the bracketed counter some mailers add
 * (`Re[2]:`, `Re(2):`). Applied repeatedly — chains like `Re: Fwd: Re:` are
 * ordinary. The list is the localized forms in the wild: English `Re`/`Fw`/`Fwd`,
 * German `Aw`, Swedish `Sv`, Dutch `Vs`, Italian Outlook's bare `R`.
 */
const REPLY_PREFIX = /^(?:re|fwd|fw|aw|sv|vs|r)\s*(?:[[(]\s*\d+\s*[\])])?\s*:\s*/i;

/**
 * A subject reduced to the thing two messages of one conversation share: no
 * reply/forward prefixes, whitespace collapsed, case-folded. Comparison key
 * only — the stored subjects are never rewritten.
 */
export function normalizeSubject(raw: string): string {
  let subject = raw.replace(/\s+/g, ' ').trim();
  for (;;) {
    const stripped = subject.replace(REPLY_PREFIX, '');
    if (stripped === subject) break;
    subject = stripped.trim();
  }
  return subject.toLowerCase();
}

/**
 * Every address that has appeared on a thread — `from`/`to`/`cc` of its emails,
 * on BOTH sides of the trust boundary (mirroring {@link anchorRowByRfc}: a
 * quarantined message is still part of the conversation's history).
 */
function threadCorrespondents(ctx: AppContext, threadId: string): Set<string> {
  const found = new Set<string>();
  const absorb = (rows: { participants: string }[]): void => {
    for (const row of rows) {
      const parties = parseParticipants(row.participants);
      for (const party of [parties.from, ...parties.to, ...parties.cc]) {
        if (party.email) found.add(canonicalAddress(party.email));
      }
    }
  };
  absorb(
    ctx.db
      .select({ participants: emails.participants })
      .from(emails)
      .where(eq(emails.threadId, threadId))
      .all(),
  );
  absorb(
    ctx.db
      .select({ participants: emailQuarantine.participants })
      .from(emailQuarantine)
      .where(eq(emailQuarantine.threadId, threadId))
      .all(),
  );
  return found;
}

/**
 * The PROVIDER-INDEPENDENT fallback (SPEC "Threading"), evaluated only for a
 * message that CLAIMS to be a reply — a non-empty `In-Reply-To` or `References`
 * — whose every `Message-ID` candidate missed. Not every relay puts the
 * `Message-ID` we minted on the wire, and the id it substituted may not be
 * knowable until its activity webhook reports it, so a human's reply can name an
 * id this instance has never seen. Rather than opening a stray thread, look for
 * the ONE live conversation the reply can only have come from:
 *
 * - same normalized subject as the thread's stored subject,
 * - the sender is already a correspondent on it, and
 * - it has been active within {@link SUBJECT_FALLBACK_WINDOW_MS}.
 *
 * **Ambiguity never joins**: two or more qualifying threads mean we cannot know
 * which, so a new thread opens. Subject matching alone merges unrelated
 * conversations — the reply evidence, the correspondent, the window, and the
 * uniqueness rule are together what make it safe. In particular, uniqueness
 * among existing threads is NOT evidence that a new message is a reply: without
 * threading headers a recurring subject ("Weekly status") is fresh mail, and
 * merging it would both fuse independent conversations and let a stranger
 * inherit a thread's human-granted trust.
 */
function subjectFallbackThread(
  ctx: AppContext,
  agent: AgentRow,
  subject: string,
  from: string,
  at: string,
): EmailThreadRow | undefined {
  const key = normalizeSubject(subject);
  const sender = canonicalAddress(from);
  if (key === '' || sender === '') return undefined;
  const since = new Date(Date.parse(at) - SUBJECT_FALLBACK_WINDOW_MS).toISOString();
  // A thread with `last_email_at` NULL has never carried a delivered message;
  // `>= since` drops it with the stale ones.
  const live = ctx.db
    .select()
    .from(emailThreads)
    .where(and(eq(emailThreads.agentId, agent.id), gte(emailThreads.lastEmailAt, since)))
    .all();
  const qualifying = live.filter(
    (thread) =>
      normalizeSubject(thread.subject) === key &&
      threadCorrespondents(ctx, thread.id).has(sender),
  );
  return qualifying.length === 1 ? qualifying[0] : undefined;
}

/**
 * Thread joining, evaluated within the ANCHOR AGENT's own mail (SPEC
 * "Threading"): `inReplyTo` first, then `references` right to left (nearest
 * ancestor first), then the subject + correspondent fallback, else a new
 * thread. Threads therefore never span agents by construction.
 */
export function joinThread(
  ctx: AppContext,
  agent: AgentRow,
  payload: { inReplyTo: string | null; references: string[]; subject: string; from: string },
  at: string,
): EmailThreadRow {
  const candidates = [
    ...(payload.inReplyTo ? [normalizeMessageId(payload.inReplyTo)] : []),
    ...[...payload.references].reverse().map(normalizeMessageId),
  ];
  for (const rfc of candidates) {
    // An ancestor may live on EITHER side of the trust boundary: a reply to a
    // still-quarantined message must join the quarantined ancestor's thread, so
    // an eventual approval delivers one coherent conversation.
    const hit = anchorRowByRfc(ctx, agent.id, rfc);
    if (hit) {
      const thread = ctx.db.select().from(emailThreads).where(eq(emailThreads.id, hit.threadId)).get();
      if (thread) return thread;
    }
  }
  // Headers first, ALWAYS — and the fallback is for a reply whose headers we
  // could not resolve, never for mail that never claimed to be one.
  const claimsReply =
    (payload.inReplyTo ?? '').trim() !== '' || payload.references.some((r) => r.trim() !== '');
  if (claimsReply) {
    const bySubject = subjectFallbackThread(ctx, agent, payload.subject, payload.from, at);
    if (bySubject) return bySubject;
  }
  const row: EmailThreadRow = {
    id: newEmailThreadId(),
    orgId: agent.orgId,
    agentId: agent.id,
    // A re-subjecting reply joins unchanged: the thread keeps its FIRST subject.
    subject: payload.subject.trim() === '' ? EMAIL_NO_SUBJECT : payload.subject,
    trusted: 0,
    createdAt: at,
    lastEmailAt: null,
  };
  ctx.db.insert(emailThreads).values(row).run();
  return row;
}

/**
 * One anchor agent's row for an rfc message id, across BOTH storage sides —
 * `emails` (delivered inbound + outbound) first, then `email_quarantine`, then
 * the outbound ALIAS set (`email_wire_ids`: the extra per-recipient wire ids a
 * provider stamped on one of our sends). The pair `(agent_id, rfc_message_id)`
 * is the idempotency key, and neither the storage split nor the alias set may
 * weaken it: a message that was quarantined yesterday is still a duplicate
 * today, and an id we are known by is an id we hold.
 */
function anchorRowByRfc(ctx: AppContext, agentId: string, rfc: string): EmailRow | undefined {
  const direct =
    ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.agentId, agentId), eq(emails.rfcMessageId, rfc)))
      .get() ??
    ctx.db
      .select()
      .from(emailQuarantine)
      .where(and(eq(emailQuarantine.agentId, agentId), eq(emailQuarantine.rfcMessageId, rfc)))
      .get();
  if (direct) return direct;
  const alias = ctx.db
    .select()
    .from(emailWireIds)
    .where(eq(emailWireIds.rfcMessageId, rfc))
    .get();
  if (!alias) return undefined;
  // Aliases name outbound rows, which only ever live in `emails`; the anchor
  // filter still applies, so an alias never pulls another agent's mail in.
  return ctx.db
    .select()
    .from(emails)
    .where(and(eq(emails.agentId, agentId), eq(emails.id, alias.emailId)))
    .get();
}

/** The org's email policy, defaults merged. */
export function orgEmailSettings(org: OrgRow): OrgEmailSettings {
  return parseOrgSettings(org.settings).email;
}

/**
 * Run the whole inbound pipeline for one normalized payload. Always resolves —
 * the classification rides in the response, never in the status code. Throws
 * only for the seam's own failures: shape (`400`), caps (`413`), rate (`429`).
 */
export async function deliverInbound(
  ctx: AppContext,
  raw: unknown,
): Promise<InboundEmailResponse> {
  // 1. Shape (the bearer check is the route's) + the caps.
  const payload = parse(InboundEmailPayloadSchema, raw ?? {});
  assertWithinCaps(payload);
  const rfcMessageId = normalizeMessageId(payload.rfcMessageId);
  if (rfcMessageId === '<>') throw badRequest('rfcMessageId is required');

  // 2. Routing — `to` then `cc`, in order. EVERY resolvable recipient is an
  // anchor agent; the message fans out to one row per anchor.
  const anchors: { agent: AgentRow; org: OrgRow }[] = [];
  const seen = new Set<string>();
  for (const party of [...payload.to, ...payload.cc]) {
    const hit = resolveAgentAddress(ctx, party.email);
    if (hit && !seen.has(hit.agent.id)) {
      seen.add(hit.agent.id);
      anchors.push(hit);
    }
  }
  // Zero resolvable recipients → nothing is persisted (mail for a deleted or
  // renamed agent leaves no trace), and the edge can reject at SMTP time.
  if (anchors.length === 0) {
    return { status: 'unknown-recipient', reason: null, email: null, deliveries: [] };
  }
  for (const orgId of new Set(anchors.map((a) => a.org.id))) chargeRate(ctx, orgId);

  const deliveries: InboundDelivery[] = [];
  for (const anchor of anchors) {
    deliveries.push(await deliverToAnchor(ctx, anchor, payload, rfcMessageId));
  }
  return summarize(deliveries);
}

/** The most permissive outcome present summarizes the fan-out for the edge. */
function summarize(deliveries: InboundDelivery[]): InboundEmailResponse {
  const order: InboundDeliveryStatus[] = ['delivered', 'quarantined', 'rejected', 'duplicate'];
  const winner = order.find((s) => deliveries.some((d) => d.status === s));
  const lead = deliveries.find((d) => d.status === winner) ?? deliveries[0];
  const first = deliveries[0];
  return {
    status: (winner ?? 'duplicate') as InboundStatus,
    reason: lead?.reason ?? null,
    email: first ? { id: first.emailId, threadId: first.threadId } : null,
    deliveries,
  };
}

/** Steps 3–11 for one anchor agent. */
async function deliverToAnchor(
  ctx: AppContext,
  anchor: { agent: AgentRow; org: OrgRow },
  payload: InboundEmailPayload,
  rfcMessageId: string,
): Promise<InboundDelivery> {
  const { agent, org } = anchor;

  // 3. Idempotency, per anchor: an anchor that already holds this message id —
  // on EITHER side of the trust boundary — is skipped: nothing is written, no
  // event fires, no judge runs.
  const existing = anchorRowByRfc(ctx, agent.id, rfcMessageId);
  if (existing) {
    return {
      agentId: agent.id,
      emailId: existing.id,
      threadId: existing.threadId,
      status: 'duplicate',
      reason: (existing.reason as EmailReason | null) ?? null,
    };
  }

  const at = nowIso();
  const thread = joinThread(
    ctx,
    agent,
    {
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      subject: payload.subject,
      from: payload.from.email,
    },
    at,
  );
  const policy = orgEmailSettings(org);
  const trust = resolveTrustSet(ctx, org, {
    threadTrusted: thread.trusted === 1,
    trustedPatterns: policy.trustedPatterns,
  });

  // 4–11: the trust engine decides; a `judge` decision is resolved here.
  const decision = classifyInbound({
    from: payload.from.email,
    verification: payload.verification,
    trust,
    policy: policy.inboundUnrecognized,
  });
  let disposition: 'delivered' | 'quarantined' | 'rejected';
  let reason: EmailReason | null;
  let judgeRecord: { verdict: 'allow' | 'deny' | null; reason: string; provider: string } | null =
    null;
  if (decision.kind === 'terminal') {
    disposition = decision.disposition;
    reason = decision.reason;
  } else {
    judgeRecord = await runJudge(ctx.email.judge, ctx.email.judgeTimeoutMs, {
      prompt: buildJudgePrompt(policy.judgePrompt),
      email: {
        direction: 'in',
        from: canonicalAddress(payload.from.email),
        to: payload.to.map((p) => canonicalAddress(p.email)),
        cc: payload.cc.map((p) => canonicalAddress(p.email)),
        subject: payload.subject,
        text: payload.text,
        attachments: payload.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
        })),
        verification: payload.verification,
        orgName: org.name,
        agentName: agent.name,
        agentAddress: `${agent.name}@${org.slug}${ctx.config.emailOrgSuffix ?? ''}`,
      },
    });
    if (judgeRecord?.verdict === 'allow') {
      disposition = 'delivered';
      reason = null;
    } else if (judgeRecord?.verdict === 'deny') {
      disposition = 'rejected';
      reason = 'judge-deny';
    } else {
      // No judge registered, or one that errored/timed out/answered malformed:
      // a `judge` policy degrades to APPROVE, never to allow.
      disposition = 'quarantined';
      reason = 'judge-unavailable';
    }
  }

  // Persist. A rejected INBOUND email is a security record, not a mailbox: it
  // keeps metadata only — no body, no attachment bytes.
  const rejected = disposition === 'rejected';
  const participants: StoredParticipants = {
    from: toParty(ctx, org, payload.from, { createContact: true }),
    to: payload.to.map((p) => toParty(ctx, org, p)),
    cc: payload.cc.map((p) => toParty(ctx, org, p)),
    bcc: [],
  };
  const row: EmailRow = {
    id: newEmailId(),
    threadId: thread.id,
    orgId: org.id,
    agentId: agent.id,
    direction: 'in',
    rfcMessageId,
    inReplyTo: payload.inReplyTo ? normalizeMessageId(payload.inReplyTo) : null,
    referencesJson: JSON.stringify(payload.references.map(normalizeMessageId)),
    participants: JSON.stringify(participants),
    subject: payload.subject,
    textBody: rejected ? null : payload.text,
    // `html` is sanitized ONCE, at ingest; the original is discarded.
    htmlBody: rejected || !payload.html ? null : sanitizeEmailHtml(payload.html),
    verification: JSON.stringify(payload.verification),
    disposition,
    reason,
    judge: judgeRecord ? JSON.stringify(judgeRecord) : null,
    readAt: null,
    createdAt: at,
    resolvedAt: null,
  };
  // THE trust boundary, in storage: only a DELIVERED row enters `emails`.
  // Quarantined and rejected inbound rows go to `email_quarantine`, so no query
  // against the legit table — in-app or out-of-band — can ever surface them.
  // (The thread row itself was created eagerly by `joinThread`; with
  // `last_email_at` still null it is invisible everywhere until a delivered
  // email lands, and the approvals/oversight surfaces reach it by id.)
  if (disposition === 'delivered') {
    ctx.db.insert(emails).values(row).run();
  } else {
    ctx.db.insert(emailQuarantine).values(row).run();
  }
  if (!rejected && payload.attachments.length > 0) {
    writeAttachments(ctx, row.id, decodeAttachments(payload.attachments), at);
  }
  // `last_email_at` is bumped ONLY by a delivered email, so a quarantined
  // stranger cannot push their subject line into an agent's thread list.
  if (disposition === 'delivered') {
    bumpThread(ctx, thread.id, at);
    thread.lastEmailAt = at;
  }

  announceEmail(ctx, { agent, thread, email: row });

  return {
    agentId: agent.id,
    emailId: row.id,
    threadId: thread.id,
    status: disposition,
    reason,
  };
}
