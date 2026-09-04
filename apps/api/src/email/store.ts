/**
 * Storage + projection helpers for the email medium: rows in, wire shapes out.
 *
 * The medium owns its own tables (`external_contacts`, `email_threads`,
 * `emails`, `email_attachments`) and shares chat's attachment store
 * (`$DATA_DIR/attachments/{id}`). Nothing here decides trust — that is
 * `trust.ts` — and nothing here talks HTTP; the routes and the two pipelines do.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  EMAIL_REJECTED_RETENTION_DAYS,
  PREVIEW_LENGTH,
  newAttachmentId,
  newExternalContactId,
  type AttachmentMeta,
  type ContactTrust,
  type Email,
  type EmailDirection,
  type EmailDisposition,
  type EmailJudge,
  type EmailPreview,
  type EmailReason,
  type EmailThread,
  type EmailThreadRef,
  type EmailVerification,
  type ExternalContact,
  type Party,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { nowIso } from '../context.js';
import {
  agents,
  emailAttachments,
  emailQuarantine,
  emails,
  emailThreads,
  externalContacts,
  humans,
  orgMemberships,
} from '../db/schema.js';
import type { EmailRow, EmailThreadRow, ExternalContactRow, OrgRow } from '../db/schema.js';
import { canonicalAddress, orgAgentAddresses, orgMailDomain } from './addresses.js';
import type { TrustSet } from './trust.js';

/** The stored `participants` JSON of an email. */
export interface StoredParticipants {
  from: Party;
  to: Party[];
  cc: Party[];
  bcc: Party[];
}

/** Parse an email's `participants` JSON, tolerating a torn/legacy row. */
export function parseParticipants(raw: string): StoredParticipants {
  try {
    const obj = JSON.parse(raw) as Partial<StoredParticipants>;
    return {
      from: obj.from ?? { email: '' },
      to: obj.to ?? [],
      cc: obj.cc ?? [],
      bcc: [],
    };
  } catch {
    return { from: { email: '' }, to: [], cc: [], bcc: [] };
  }
}

/* ------------------------------------------------------------------ *
 * Contacts
 * ------------------------------------------------------------------ */

/** An org's contact row for an address, if one exists. */
export function contactByEmail(
  ctx: AppContext,
  orgId: string,
  email: string,
): ExternalContactRow | undefined {
  return ctx.db
    .select()
    .from(externalContacts)
    .where(
      and(eq(externalContacts.orgId, orgId), eq(externalContacts.email, canonicalAddress(email))),
    )
    .get();
}

/** A contact row by id, scoped to one org. */
export function contactById(
  ctx: AppContext,
  orgId: string,
  contactId: string,
): ExternalContactRow | undefined {
  const row = ctx.db
    .select()
    .from(externalContacts)
    .where(eq(externalContacts.id, contactId))
    .get();
  return row && row.orgId === orgId ? row : undefined;
}

/**
 * Upsert the contact for an address, refreshing `display_name` and NEVER
 * touching `trust`. Skipped by the caller when the address belongs to a
 * principal (a human account email or a sibling agent's address).
 */
export function upsertContact(
  ctx: AppContext,
  orgId: string,
  email: string,
  displayName?: string | null,
): ExternalContactRow {
  const addr = canonicalAddress(email);
  const existing = contactByEmail(ctx, orgId, addr);
  if (existing) {
    if (displayName && displayName !== existing.displayName) {
      ctx.db
        .update(externalContacts)
        .set({ displayName })
        .where(eq(externalContacts.id, existing.id))
        .run();
      return { ...existing, displayName };
    }
    return existing;
  }
  const row: ExternalContactRow = {
    id: newExternalContactId(),
    orgId,
    email: addr,
    displayName: displayName ?? null,
    trust: null,
    firstSeenAt: nowIso(),
    resolvedByHumanId: null,
    resolvedAt: null,
  };
  ctx.db.insert(externalContacts).values(row).run();
  return row;
}

/** Set (or clear) a contact's durable trust, recording who resolved it. */
export function setContactTrust(
  ctx: AppContext,
  contactId: string,
  trust: ContactTrust | null,
  byHumanId: string,
): void {
  ctx.db
    .update(externalContacts)
    .set({ trust, resolvedByHumanId: byHumanId, resolvedAt: nowIso() })
    .where(eq(externalContacts.id, contactId))
    .run();
}

/** Project a contact row to the wire shape. */
export function toExternalContact(ctx: AppContext, row: ExternalContactRow): ExternalContact {
  let resolvedBy: ExternalContact['resolvedBy'] = null;
  if (row.resolvedByHumanId) {
    const human = ctx.db.select().from(humans).where(eq(humans.id, row.resolvedByHumanId)).get();
    if (human) resolvedBy = { id: human.id, displayName: human.displayName };
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? null,
    trust: (row.trust as ContactTrust | null) ?? null,
    firstSeenAt: row.firstSeenAt,
    resolvedAt: row.resolvedAt ?? null,
    resolvedBy,
  };
}

/* ------------------------------------------------------------------ *
 * Parties
 * ------------------------------------------------------------------ */

/**
 * Resolve one address to a {@link Party}: `principalId` when it is an org
 * human's account email or an org agent's own address, `contactId` when an
 * `external_contacts` row exists. Both absent = an address seen once and never
 * trusted. `createContact` upserts the contact row for a non-principal address
 * (the inbound pipeline does this for every persisted email's From).
 */
export function toParty(
  ctx: AppContext,
  org: OrgRow,
  input: { email: string; name?: string | null },
  opts: { createContact?: boolean } = {},
): Party {
  const addr = canonicalAddress(input.email);
  const party: Party = { email: addr, name: input.name ?? null, principalId: null, contactId: null };

  const human = ctx.db
    .select({ id: humans.id })
    .from(humans)
    .innerJoin(orgMemberships, eq(orgMemberships.humanId, humans.id))
    .where(and(eq(orgMemberships.orgId, org.id), eq(humans.email, addr)))
    .get();
  if (human) {
    party.principalId = human.id;
    return party;
  }
  const domain = orgMailDomain(ctx, org);
  if (domain && addr.endsWith(`@${domain}`)) {
    const local = addr.slice(0, addr.length - domain.length - 1);
    const agent = ctx.db
      .select()
      .from(agents)
      .where(eq(agents.orgId, org.id))
      .all()
      .find((a) => a.name.toLowerCase() === local);
    if (agent) {
      party.principalId = agent.id;
      return party;
    }
  }
  const contact = opts.createContact
    ? upsertContact(ctx, org.id, addr, input.name ?? null)
    : contactByEmail(ctx, org.id, addr);
  if (contact) party.contactId = contact.id;
  return party;
}

/* ------------------------------------------------------------------ *
 * The trust set
 * ------------------------------------------------------------------ */

/** Resolve the org's (and optionally the thread's) trust inputs from the db. */
export function resolveTrustSet(
  ctx: AppContext,
  org: OrgRow,
  input: { threadTrusted?: boolean; trustedPatterns: string[] },
): TrustSet {
  const humanEmails = new Set(
    ctx.db
      .select({ email: humans.email })
      .from(humans)
      .innerJoin(orgMemberships, eq(orgMemberships.humanId, humans.id))
      .where(eq(orgMemberships.orgId, org.id))
      .all()
      .map((r) => r.email.toLowerCase()),
  );
  const contacts = new Map<string, ContactTrust>();
  for (const c of ctx.db
    .select()
    .from(externalContacts)
    .where(eq(externalContacts.orgId, org.id))
    .all()) {
    if (c.trust === 'approved' || c.trust === 'blocked') contacts.set(c.email, c.trust);
  }
  return {
    threadTrusted: input.threadTrusted ?? false,
    humanEmails,
    agentAddresses: orgAgentAddresses(ctx, org),
    contacts,
    trustedPatterns: input.trustedPatterns,
  };
}

/* ------------------------------------------------------------------ *
 * Threads & emails
 * ------------------------------------------------------------------ */

/** A thread row by id. */
export function threadById(ctx: AppContext, threadId: string): EmailThreadRow | undefined {
  return ctx.db.select().from(emailThreads).where(eq(emailThreads.id, threadId)).get();
}

/**
 * A LEGIT email row by id — `emails` only (delivered inbound + the agent's own
 * outbound). This is what every agent-credential surface resolves through; a
 * quarantine-side id simply does not exist here.
 */
export function emailById(ctx: AppContext, emailId: string): EmailRow | undefined {
  return ctx.db.select().from(emails).where(eq(emails.id, emailId)).get();
}

/** A quarantine-side row by id (inbound `quarantined`/`rejected` only). */
export function quarantineById(ctx: AppContext, emailId: string): EmailRow | undefined {
  return ctx.db.select().from(emailQuarantine).where(eq(emailQuarantine.id, emailId)).get();
}

/**
 * An email by id across BOTH sides of the trust boundary — the OVERSIGHT
 * resolver (org reads, approvals, approve/deny). `quarantined` says which table
 * the row came from, so a resolution knows what to move or update.
 */
export function oversightEmailById(
  ctx: AppContext,
  emailId: string,
): { row: EmailRow; quarantined: boolean } | undefined {
  const legit = emailById(ctx, emailId);
  if (legit) return { row: legit, quarantined: false };
  const held = quarantineById(ctx, emailId);
  return held ? { row: held, quarantined: true } : undefined;
}

/**
 * The quarantine-side rows of one thread, ascending (createdAt, id) — what the
 * oversight transcript interleaves with the legit rows.
 */
export function quarantineThreadRows(ctx: AppContext, threadId: string): EmailRow[] {
  return ctx.db
    .select()
    .from(emailQuarantine)
    .where(eq(emailQuarantine.threadId, threadId))
    .orderBy(asc(emailQuarantine.createdAt), asc(emailQuarantine.id))
    .all();
}

/** Project a thread row to the compact wire ref. */
export function toThreadRef(row: EmailThreadRow): EmailThreadRef {
  return {
    id: row.id,
    orgId: row.orgId,
    agentId: row.agentId,
    subject: row.subject,
    trusted: row.trusted === 1,
    lastEmailAt: row.lastEmailAt ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Project a thread row to the full wire thread (counts + cast + last outcome).
 *
 * The projection is computed over the `emails` table only — the agent's own
 * outbound rows plus DELIVERED inbound. Quarantined/rejected inbound rows live
 * in `email_quarantine` and must never shape a thread's badges: a pending
 * stranger's message would otherwise leak its existence (`emailCount`,
 * `lastDisposition`) and its sender (`participants`) into the agent's triage
 * list. The direction/disposition filter is kept on top of the table split as
 * a second, cheap layer.
 */
export function toThread(ctx: AppContext, row: EmailThreadRow): EmailThread {
  const rows = ctx.db
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.threadId, row.id),
        or(eq(emails.direction, 'out'), eq(emails.disposition, 'delivered'))!,
      ),
    )
    .all();
  const unreadCount = rows.filter(
    (e) => e.direction === 'in' && e.disposition === 'delivered' && !e.readAt,
  ).length;
  // The cast: every distinct address that has appeared on the thread, in first
  // appearance order (the agent's own address included — it is a participant).
  const ordered = [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const seen = new Map<string, Party>();
  for (const e of ordered) {
    const p = parseParticipants(e.participants);
    for (const party of [p.from, ...p.to, ...p.cc]) {
      if (party.email && !seen.has(party.email)) seen.set(party.email, party);
    }
  }
  // What a triage row badges: how the NEWEST email in the thread ended. `null`
  // only on a thread that holds no email at all.
  const newest = ordered[ordered.length - 1];
  return {
    ...toThreadRef(row),
    emailCount: rows.length,
    unreadCount,
    lastDisposition: (newest?.disposition as EmailThread['lastDisposition']) ?? null,
    participants: [...seen.values()],
  };
}

/** Attachment metadata for one email (ascending by id). */
export function emailAttachmentMetas(ctx: AppContext, emailId: string): AttachmentMeta[] {
  return ctx.db
    .select()
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, emailId))
    .orderBy(asc(emailAttachments.id))
    .all()
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
}

/** How many attachments hang off an email (the preview's count). */
export function emailAttachmentCount(ctx: AppContext, emailId: string): number {
  return ctx.db
    .select({ id: emailAttachments.id })
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, emailId))
    .all().length;
}

/** Parse a stored judge record (null when no judge ran). */
export function parseJudge(raw: string | null): EmailJudge | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as EmailJudge;
    return { verdict: obj.verdict ?? null, reason: obj.reason ?? '', provider: obj.provider ?? '' };
  } catch {
    return null;
  }
}

/** Parse a stored verification block (null on outbound). */
export function parseVerification(raw: string | null): EmailVerification | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EmailVerification;
  } catch {
    return null;
  }
}

/**
 * The two-valued read state: `unread` only for an INBOUND `delivered` email with
 * no `read_at`. Outbound and non-delivered email is never "waiting on" the agent.
 */
export function emailStatus(row: EmailRow): 'unread' | 'read' {
  return row.direction === 'in' && row.disposition === 'delivered' && !row.readAt
    ? 'unread'
    : 'read';
}

/** Project an email row to the full wire shape. */
export function toEmail(ctx: AppContext, row: EmailRow): Email {
  const p = parseParticipants(row.participants);
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction as EmailDirection,
    from: p.from,
    to: p.to,
    cc: p.cc,
    // Always `[]` in v4, in both directions.
    bcc: [],
    subject: row.subject,
    // A rejected inbound email keeps metadata only — `text` renders "" for such
    // rows, and is never null on the wire.
    text: row.textBody ?? '',
    html: row.htmlBody ?? null,
    attachments: emailAttachmentMetas(ctx, row.id),
    rfcMessageId: row.rfcMessageId,
    inReplyTo: row.inReplyTo ?? null,
    verification: parseVerification(row.verification),
    disposition: row.disposition as EmailDisposition,
    reason: (row.reason as EmailReason | null) ?? null,
    judge: parseJudge(row.judge),
    status: emailStatus(row),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

/** Project an email row to THE preview shape (queue, events, inbox alike). */
export function toEmailPreview(ctx: AppContext, row: EmailRow): EmailPreview {
  const p = parseParticipants(row.participants);
  const text = row.textBody ?? '';
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction as EmailDirection,
    from: p.from,
    subject: row.subject,
    preview: text.slice(0, PREVIEW_LENGTH),
    truncated: text.length > PREVIEW_LENGTH,
    attachmentCount: emailAttachmentCount(ctx, row.id),
    disposition: row.disposition as EmailDisposition,
    reason: (row.reason as EmailReason | null) ?? null,
    status: emailStatus(row),
    createdAt: row.createdAt,
  };
}

/**
 * Bump a thread's `last_email_at` — called ONLY for a `delivered`/`sent` email,
 * so a thread whose only email was quarantined/held/rejected stays invisible.
 */
export function bumpThread(ctx: AppContext, threadId: string, at: string): void {
  ctx.db.update(emailThreads).set({ lastEmailAt: at }).where(eq(emailThreads.id, threadId)).run();
}

/**
 * APPROVAL's storage half: move a quarantined row across the trust boundary —
 * out of `email_quarantine`, into `emails` as a freshly `delivered`, UNREAD
 * email. The id is stable, so its attachment rows/blobs and every activity ref
 * follow it for free. One transaction: the row is never on both sides, and
 * never on neither.
 */
export function releaseFromQuarantine(ctx: AppContext, row: EmailRow, at: string): EmailRow {
  const moved: EmailRow = {
    ...row,
    disposition: 'delivered',
    reason: null,
    resolvedAt: at,
    // Fresh read state: delivery via approval starts unread, like any delivery.
    readAt: null,
  };
  ctx.db.transaction((tx) => {
    tx.delete(emailQuarantine).where(eq(emailQuarantine.id, row.id)).run();
    tx.insert(emails).values(moved).run();
  });
  return moved;
}

/**
 * DENY's storage half: the row STAYS quarantine-side forever — flipped to
 * `rejected`/`denied` and stripped to metadata (no body; a refusal is a
 * security record, not a mailbox).
 */
export function rejectInQuarantine(ctx: AppContext, row: EmailRow, at: string): EmailRow {
  ctx.db
    .update(emailQuarantine)
    .set({
      disposition: 'rejected',
      reason: 'denied',
      resolvedAt: at,
      textBody: null,
      htmlBody: null,
    })
    .where(eq(emailQuarantine.id, row.id))
    .run();
  return { ...row, disposition: 'rejected', reason: 'denied', resolvedAt: at, textBody: null, htmlBody: null };
}

/**
 * Whether a thread holds ANY agent-visible mail (an outbound row, or delivered
 * inbound). A thread whose only mail is quarantined/rejected inbound does not —
 * to its own AGENT such a thread must not exist at all (its subject is the
 * stranger's), while the oversight routes read it freely. Post table-split the
 * `emails` table can only hold visible rows; the filter stays as armor.
 */
export function threadHasAgentVisibleMail(ctx: AppContext, threadId: string): boolean {
  return (
    ctx.db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.threadId, threadId),
          or(eq(emails.direction, 'out'), eq(emails.disposition, 'delivered'))!,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/** Mark a thread durably trusted (an approval is the only way trust is created). */
export function trustThread(ctx: AppContext, threadId: string): void {
  ctx.db.update(emailThreads).set({ trusted: 1 }).where(eq(emailThreads.id, threadId)).run();
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/** A decoded attachment on its way to disk. */
export interface DecodedAttachment {
  id: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Decode base64 attachment inputs, minting their ids (size caps are the caller's). */
export function decodeAttachments(
  inputs: { filename: string; contentType: string; dataBase64: string }[],
): DecodedAttachment[] {
  return inputs.map((a) => ({
    id: newAttachmentId(),
    filename: a.filename,
    contentType: a.contentType,
    bytes: Buffer.from(a.dataBase64, 'base64'),
  }));
}

/** Persist attachment rows + blobs for an email (chat's store, chat's caps). */
export function writeAttachments(
  ctx: AppContext,
  emailId: string,
  decoded: DecodedAttachment[],
  at: string,
): void {
  for (const att of decoded) {
    ctx.db
      .insert(emailAttachments)
      .values({
        id: att.id,
        emailId,
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.bytes.length,
        createdAt: at,
      })
      .run();
    writeFileSync(path.join(ctx.handle.attachmentsDir, att.id), att.bytes);
  }
}

/** Read one attachment's bytes, or undefined when the blob is gone. */
export function readAttachmentBytes(ctx: AppContext, attachmentId: string): Buffer | undefined {
  try {
    return readFileSync(path.join(ctx.handle.attachmentsDir, attachmentId));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Lazily reap `rejected` INBOUND rows older than
 * {@link EMAIL_REJECTED_RETENTION_DAYS} (30 days), so the queue of refusals
 * cannot grow without bound. Their `email.rejected` activity entries persist
 * independently under the timeline's own retention — the owner can still see
 * that something was refused, and by whom, after the row itself is gone.
 */
export function reapRejectedEmails(ctx: AppContext, now = new Date()): number {
  const cutoff = new Date(
    now.getTime() - EMAIL_REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // Inbound rejections live in `email_quarantine` (the direction filter is
  // armor — that table holds nothing else). Outbound `rejected` rows (denied
  // sends) are the agent's own compositions in `emails` and are never reaped,
  // exactly as before the split.
  const doomed = ctx.db
    .select({ id: emailQuarantine.id })
    .from(emailQuarantine)
    .where(
      and(
        eq(emailQuarantine.direction, 'in'),
        eq(emailQuarantine.disposition, 'rejected'),
        lt(emailQuarantine.createdAt, cutoff),
      ),
    )
    .all()
    .map((r) => r.id);
  for (const id of doomed) {
    ctx.db.delete(emailAttachments).where(eq(emailAttachments.emailId, id)).run();
    ctx.db.delete(emailQuarantine).where(eq(emailQuarantine.id, id)).run();
  }
  return doomed.length;
}

/**
 * Delete an agent's mail: its threads, its emails, and its attachment rows AND
 * blobs (SPEC "Data model (SQLite)" — *deleting an agent takes its threads,
 * emails, and attachment blobs with it*). Contacts are org data and survive;
 * they are deleted only with the org.
 */
export function deleteAgentEmailCascade(ctx: AppContext, agentIds: string[]): void {
  if (agentIds.length === 0) return;
  // Both sides of the trust boundary go: the legit rows AND the quarantine rows
  // (a deleted agent leaves no pending strangers' mail behind either).
  const emailIds = [
    ...ctx.db
      .select({ id: emails.id })
      .from(emails)
      .where(inArray(emails.agentId, agentIds))
      .all(),
    ...ctx.db
      .select({ id: emailQuarantine.id })
      .from(emailQuarantine)
      .where(inArray(emailQuarantine.agentId, agentIds))
      .all(),
  ].map((r) => r.id);
  const attachmentIds =
    emailIds.length === 0
      ? []
      : ctx.db
          .select({ id: emailAttachments.id })
          .from(emailAttachments)
          .where(inArray(emailAttachments.emailId, emailIds))
          .all()
          .map((r) => r.id);
  if (emailIds.length > 0) {
    ctx.db.delete(emailAttachments).where(inArray(emailAttachments.emailId, emailIds)).run();
  }
  ctx.db.delete(emails).where(inArray(emails.agentId, agentIds)).run();
  ctx.db.delete(emailQuarantine).where(inArray(emailQuarantine.agentId, agentIds)).run();
  ctx.db.delete(emailThreads).where(inArray(emailThreads.agentId, agentIds)).run();
  for (const id of attachmentIds) {
    try {
      rmSync(path.join(ctx.handle.attachmentsDir, id), { force: true });
    } catch {
      // A missing blob is not an error — the row is what mattered.
    }
  }
}

/** Delete an org's mail AND its external contacts (the org-level cascade). */
export function deleteOrgEmailCascade(ctx: AppContext, orgId: string): void {
  const agentIds = ctx.db
    .select({ agentId: emailThreads.agentId })
    .from(emailThreads)
    .where(eq(emailThreads.orgId, orgId))
    .all()
    .map((r) => r.agentId);
  deleteAgentEmailCascade(ctx, [...new Set(agentIds)]);
  // Belt and braces: rows whose thread is already gone still carry the org id.
  ctx.db.delete(emails).where(eq(emails.orgId, orgId)).run();
  ctx.db.delete(emailQuarantine).where(eq(emailQuarantine.orgId, orgId)).run();
  ctx.db.delete(emailThreads).where(eq(emailThreads.orgId, orgId)).run();
  ctx.db.delete(externalContacts).where(eq(externalContacts.orgId, orgId)).run();
}

/**
 * The oldest unread email work item for an agent: an INBOUND `delivered` email
 * with `read_at IS NULL`, ascending `createdAt` then insertion order.
 */
export function oldestUnreadEmail(ctx: AppContext, agentId: string): EmailRow | undefined {
  return ctx.db
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.agentId, agentId),
        eq(emails.direction, 'in'),
        eq(emails.disposition, 'delivered'),
        isNull(emails.readAt),
      ),
    )
    .orderBy(asc(emails.createdAt), asc(sql`${emails}.rowid`))
    .limit(1)
    .get();
}

/** Mark an email read for its anchor agent (idempotent; returns the timestamp used). */
export function markEmailRead(ctx: AppContext, row: EmailRow, at = nowIso()): string {
  if (row.readAt) return row.readAt;
  ctx.db.update(emails).set({ readAt: at }).where(eq(emails.id, row.id)).run();
  row.readAt = at;
  return at;
}
