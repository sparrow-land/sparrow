/**
 * The outbound pipeline (SPEC v4 "The email medium → The trust engine →
 * Outbound pipeline" + "Threading → Outbound header generation").
 *
 * An outbound email's row is written (with its `Message-ID`) BEFORE the relay
 * call, so a crash mid-relay leaves an auditable `send-failed`, never a silent
 * gap. Intra-instance mail is NOT short-circuited: an agent emailing a sibling
 * goes out through the relay and comes back through the inbound seam like any
 * other mail — one code path, one trust evaluation.
 */
import { and, asc, desc, eq, or } from 'drizzle-orm';
import {
  EMAIL_NO_SUBJECT,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_REFERENCES_MAX,
  EMAIL_SUBJECT_MAX,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  newEmailId,
  newEmailThreadId,
  type AttachmentInput,
  type CapturedEmail,
  type EmailReason,
  type OutboundEmailHeaders,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import { emails, emailThreads } from '../db/schema.js';
import type { AgentRow, EmailRow, EmailThreadRow, OrgRow } from '../db/schema.js';
import { badRequest, forbidden, payloadTooLarge } from '../errors.js';
import { canonicalAddress } from './addresses.js';
import { buildJudgePrompt, runJudge } from './judge.js';
import { announceEmail } from './notify.js';
import { orgEmailSettings } from './inbound.js';
import {
  bumpThread,
  decodeAttachments,
  emailAttachmentMetas,
  parseParticipants,
  readAttachmentBytes,
  resolveTrustSet,
  toEmail,
  toParty,
  writeAttachments,
  type DecodedAttachment,
  type StoredParticipants,
} from './store.js';
import { classifyOutbound } from './trust.js';

/** What a send/reply needs to compose one outbound email. */
export interface OutboundInput {
  agent: AgentRow;
  org: OrgRow;
  agentAddress: string;
  /** An existing thread (reply), or undefined to start a new one (send). */
  thread?: EmailThreadRow;
  /** Explicit recipients (send) — replies derive theirs from the thread. */
  to?: string[];
  cc?: string[];
  subject?: string;
  text: string;
  attachments?: AttachmentInput[];
}

/** The persisted outcome of one outbound attempt. */
export interface OutboundResult {
  email: EmailRow;
  thread: EmailThreadRow;
  /** `201` sent, `202` held/send-failed, `403` refused by policy. */
  http: 201 | 202 | 403;
}

/** Enforce chat's attachment caps (one store, one policy, one set of tests). */
function decodeWithCaps(inputs: AttachmentInput[] | undefined): DecodedAttachment[] {
  const decoded = decodeAttachments(inputs ?? []);
  let total = 0;
  for (const att of decoded) {
    if (att.bytes.length > MAX_ATTACHMENT_BYTES) throw payloadTooLarge('Attachment is too large');
    total += att.bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw payloadTooLarge('Attachments are too large');
  }
  return decoded;
}

/**
 * The AGENT-VISIBLE emails of a thread, oldest first (outbound rows + delivered
 * inbound — the same rows the agent's transcript shows). This feeds the reply's
 * threading headers: In-Reply-To/References must never point at a quarantined
 * stranger's message the agent cannot see. Post table-split the `emails` table
 * holds nothing else; the filter is armor.
 */
function threadEmails(ctx: AppContext, threadId: string): EmailRow[] {
  return ctx.db
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.threadId, threadId),
        or(eq(emails.direction, 'out'), eq(emails.disposition, 'delivered'))!,
      ),
    )
    .orderBy(asc(emails.createdAt), asc(emails.id))
    .all();
}

/**
 * The thread's most recent DELIVERED inbound email (a reply's recipient basis).
 * The disposition filter matters: a quarantined stranger's reply must never
 * steer who the agent addresses — the agent answers the mail it can SEE. Post
 * table-split the `emails` table holds no other inbound; the filter is armor.
 */
export function latestInbound(ctx: AppContext, threadId: string): EmailRow | undefined {
  return ctx.db
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.threadId, threadId),
        eq(emails.direction, 'in'),
        eq(emails.disposition, 'delivered'),
      ),
    )
    .orderBy(desc(emails.createdAt), desc(emails.id))
    .limit(1)
    .get();
}

/**
 * Reply recipients: the thread's most recent inbound email's `from` + `to` +
 * `cc`, minus the agent's own address, de-duplicated, plus any `cc` in the
 * request. Self-addressing the anchor agent is dropped, not an error.
 */
export function replyRecipients(
  ctx: AppContext,
  threadId: string,
  agentAddress: string,
  extraCc: string[] = [],
): { to: string[]; cc: string[] } | undefined {
  const parent = latestInbound(ctx, threadId);
  if (!parent) return undefined;
  const p = parseParticipants(parent.participants);
  const seen = new Set<string>([agentAddress]);
  const to: string[] = [];
  for (const party of [p.from, ...p.to, ...p.cc]) {
    const addr = canonicalAddress(party.email);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    to.push(addr);
  }
  const cc: string[] = [];
  for (const raw of extraCc) {
    const addr = canonicalAddress(raw);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    cc.push(addr);
  }
  return { to, cc };
}

/** `Re: {subject}` with at most one `Re: ` prefix. */
export function replySubject(threadSubject: string): string {
  return /^re:\s/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`;
}

/** The outbound threading headers for a new email in a thread. */
export function outboundHeaders(
  ctx: AppContext,
  thread: EmailThreadRow | undefined,
  messageId: string,
): OutboundEmailHeaders {
  const headers: OutboundEmailHeaders = { messageId };
  if (!thread) return headers;
  const prior = threadEmails(ctx, thread.id);
  const parent = prior[prior.length - 1];
  if (!parent) return headers;
  headers.inReplyTo = parent.rfcMessageId;
  // The parent's References + the parent's Message-ID, trimmed to the last 20.
  let refs: string[] = [];
  if (parent.referencesJson) {
    try {
      const parsed = JSON.parse(parent.referencesJson) as unknown;
      if (Array.isArray(parsed)) refs = parsed.filter((r): r is string => typeof r === 'string');
    } catch {
      refs = [];
    }
  }
  if (refs.length === 0) refs = prior.slice(0, -1).map((e) => e.rfcMessageId);
  const chain = [...refs, parent.rfcMessageId].slice(-EMAIL_REFERENCES_MAX);
  headers.references = chain.join(' ');
  return headers;
}

/**
 * Compose, classify, persist and (when allowed) relay one outbound email.
 * Nothing is persisted for a blocked recipient — that is a `403` and the send
 * never happened.
 */
export async function sendOutbound(
  ctx: AppContext,
  input: OutboundInput,
): Promise<OutboundResult> {
  const { agent, org, agentAddress } = input;
  const at = nowIso();

  // 1. Recipients.
  let to: string[];
  let cc: string[];
  if (input.thread) {
    const derived = replyRecipients(ctx, input.thread.id, agentAddress, input.cc ?? []);
    if (!derived) throw badRequest('This thread has no inbound email to reply to');
    to = derived.to;
    cc = derived.cc;
  } else {
    const seen = new Set<string>([agentAddress]);
    to = [];
    cc = [];
    for (const raw of input.to ?? []) {
      const addr = canonicalAddress(raw);
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      to.push(addr);
    }
    for (const raw of input.cc ?? []) {
      const addr = canonicalAddress(raw);
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      cc.push(addr);
    }
  }
  const recipients = [...to, ...cc];
  if (recipients.length === 0) throw badRequest('At least one recipient is required');
  if (recipients.length > EMAIL_RECIPIENTS_MAX) {
    throw badRequest(`At most ${EMAIL_RECIPIENTS_MAX} recipients (to + cc)`);
  }

  const decoded = decodeWithCaps(input.attachments);
  const policy = orgEmailSettings(org);
  const trust = resolveTrustSet(ctx, org, {
    threadTrusted: input.thread ? input.thread.trusted === 1 : false,
    trustedPatterns: policy.trustedPatterns,
  });

  const subject = (
    input.thread ? replySubject(input.thread.subject) : (input.subject ?? '').trim()
  ).slice(0, EMAIL_SUBJECT_MAX);

  // 2–4. The trust engine decides; a `judge` decision is resolved here.
  const decision = classifyOutbound({ recipients, trust, policy: policy.outboundUnrecognized });
  if (decision.kind === 'blocked') {
    throw forbidden('recipient is blocked');
  }
  let disposition: 'sent' | 'held' | 'rejected';
  let reason: EmailReason | null = null;
  let judgeRecord: { verdict: 'allow' | 'deny' | null; reason: string; provider: string } | null =
    null;
  let unrecognized: string[] = [];
  if (decision.kind === 'send') {
    disposition = 'sent';
  } else if (decision.kind === 'terminal') {
    disposition = decision.disposition;
    reason = decision.reason;
    unrecognized = decision.unrecognized;
  } else {
    unrecognized = decision.unrecognized;
    judgeRecord = await runJudge(ctx.email.judge, ctx.email.judgeTimeoutMs, {
      prompt: buildJudgePrompt(policy.judgePrompt),
      email: {
        direction: 'out',
        from: agentAddress,
        to,
        cc,
        subject,
        text: input.text,
        attachments: decoded.map((a) => ({ filename: a.filename, contentType: a.contentType })),
        verification: null,
        orgName: org.name,
        agentName: agent.name,
        agentAddress,
      },
    });
    if (judgeRecord?.verdict === 'allow') {
      disposition = 'sent';
    } else if (judgeRecord?.verdict === 'deny') {
      disposition = 'rejected';
      reason = 'judge-deny';
    } else {
      // Degrade to approve: the human decides, and the agent is told.
      disposition = 'held';
      reason = 'judge-unavailable';
    }
  }

  // The thread exists before the row does (a send opens one).
  const thread =
    input.thread ??
    (() => {
      const row: EmailThreadRow = {
        id: newEmailThreadId(),
        orgId: org.id,
        agentId: agent.id,
        subject: subject === '' ? EMAIL_NO_SUBJECT : subject,
        trusted: 0,
        createdAt: at,
        lastEmailAt: null,
      };
      ctx.db.insert(emailThreads).values(row).run();
      return row;
    })();

  const emailId = newEmailId();
  const domain = agentAddress.slice(agentAddress.indexOf('@') + 1);
  const messageId = `<${emailId}@${domain}>`;
  const headers = outboundHeaders(ctx, input.thread, messageId);
  const participants: StoredParticipants = {
    from: toParty(ctx, org, { email: agentAddress, name: agent.name }),
    to: to.map((addr) => toParty(ctx, org, { email: addr })),
    cc: cc.map((addr) => toParty(ctx, org, { email: addr })),
    bcc: [],
  };
  const row: EmailRow = {
    id: emailId,
    threadId: thread.id,
    orgId: org.id,
    agentId: agent.id,
    direction: 'out',
    rfcMessageId: messageId,
    inReplyTo: headers.inReplyTo ?? null,
    referencesJson: headers.references ? JSON.stringify(headers.references.split(' ')) : null,
    participants: JSON.stringify(participants),
    subject,
    // Outbound keeps its body in every disposition, so an agent can see what did
    // not go out.
    textBody: input.text,
    htmlBody: null,
    verification: null,
    disposition,
    reason,
    judge: judgeRecord ? JSON.stringify(judgeRecord) : null,
    readAt: null,
    createdAt: at,
    resolvedAt: disposition === 'sent' ? at : null,
  };
  // The row (with its Message-ID) is written BEFORE the relay call.
  ctx.db.insert(emails).values(row).run();
  if (decoded.length > 0) writeAttachments(ctx, row.id, decoded, at);

  // Unrecognized recipients are still remembered as contacts, so approving with
  // `trustSender` has a row to flip.
  for (const addr of unrecognized) toParty(ctx, org, { email: addr }, { createContact: true });

  if (disposition === 'sent') {
    await relayAndFinish(ctx, { agent, org, thread, row, headers, to, cc, agentAddress });
  } else {
    announceEmail(ctx, { agent, thread, email: row });
  }

  const http: 201 | 202 | 403 =
    row.disposition === 'sent' ? 201 : row.disposition === 'rejected' ? 403 : 202;
  return { email: row, thread, http };
}

/**
 * Hand a `sent` row to the relay, flipping it to `send-failed`
 * (`reason: "relay-error"`) when the relay refuses. Announces whichever outcome
 * happened — the row is already durable either way.
 */
export async function relayAndFinish(
  ctx: AppContext,
  input: {
    agent: AgentRow;
    org: OrgRow;
    thread: EmailThreadRow;
    row: EmailRow;
    headers?: OutboundEmailHeaders;
    to?: string[];
    cc?: string[];
    agentAddress: string;
    /** A human resolution to announce alongside the outcome (approve). */
    resolution?: 'approved';
    by?: { id: string; displayName: string } | null;
  },
): Promise<EmailRow> {
  const { agent, thread, row, agentAddress } = input;
  const participants = parseParticipants(row.participants);
  const to = input.to ?? participants.to.map((p) => p.email);
  const cc = input.cc ?? participants.cc.map((p) => p.email);
  // A re-relay (retry, or an approval minutes later) rebuilds the threading
  // identity from the row itself — the core owns it, and it must not drift.
  const headers: OutboundEmailHeaders = input.headers ?? {
    messageId: row.rfcMessageId,
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
    ...(storedReferences(row).length > 0
      ? { references: storedReferences(row).join(' ') }
      : {}),
  };
  const attachments = emailAttachmentMetas(ctx, row.id).map((a) => {
    const bytes = readAttachmentBytes(ctx, a.id);
    return {
      filename: a.filename,
      contentType: a.contentType,
      dataBase64: bytes ? bytes.toString('base64') : '',
    };
  });
  const payload = {
    from: agentAddress,
    to,
    cc,
    bcc: [],
    subject: row.subject,
    text: row.textBody ?? '',
    html: null,
    headers,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  const captured: CapturedEmail = {
    email: toEmail(ctx, row),
    headers,
    to: [...to, ...cc],
    raw: { subject: row.subject, text: row.textBody ?? '', html: null },
  };
  const result = ctx.email.provider
    ? await ctx.email.provider.relay(payload, captured)
    : ({ ok: false, reason: 'no email provider' } as const);

  const at = nowIso();
  if (result.ok) {
    ctx.db
      .update(emails)
      .set({ disposition: 'sent', reason: null, resolvedAt: at })
      .where(eq(emails.id, row.id))
      .run();
    row.disposition = 'sent';
    row.reason = null;
    row.resolvedAt = at;
    bumpThread(ctx, thread.id, at);
    thread.lastEmailAt = at;
    announceEmail(ctx, {
      agent,
      thread,
      email: row,
      ...(input.resolution ? { resolution: input.resolution, by: input.by ?? null } : {}),
    });
  } else {
    ctx.db
      .update(emails)
      .set({ disposition: 'send-failed', reason: 'relay-error', resolvedAt: at })
      .where(eq(emails.id, row.id))
      .run();
    row.disposition = 'send-failed';
    row.reason = 'relay-error';
    row.resolvedAt = at;
    // A send failure resolves the email with no human behind it.
    announceEmail(ctx, { agent, thread, email: row, resolution: 'send-failed', by: null });
  }
  return row;
}

/** The `References` chain stored on a row, or `[]` when it carries none. */
function storedReferences(row: EmailRow): string[] {
  if (!row.referencesJson) return [];
  try {
    const parsed = JSON.parse(row.referencesJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
