/**
 * Message projection helpers (SPEC "Messages"). Build the full Message resource
 * and the truncated inbox preview from stored rows, resolving live MemberRefs and
 * attachment metadata. `from`/`to` are MemberRefs; display names are live.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  PREVIEW_LENGTH,
  type Message,
  type InboxItem,
  type MemberRef,
  type MessageKind,
  type MessageOrigin,
  type PrincipalKind,
  type ReadStatus,
  type SuggestedReply,
  type AttachmentMeta,
} from '@sparrow/common-types';
import type { AppContext } from './context.js';
import { attachments, members, messageRecipients, messages } from './db/schema.js';
import type { MemberRow, MessageRecipientRow, MessageRow } from './db/schema.js';
import { avatarUrlForPrincipal } from './avatar-helpers.js';
import { memberById, principalDisplayName, toMemberRef } from './room-helpers.js';
import { emitMessageReceived } from './room-events.js';

/**
 * The frozen identity of a party to a message, as stored on the message row
 * (sender) or the delivery row (recipient). Columns are nullable purely for rows
 * written before the snapshot existed.
 */
export interface MemberIdentity {
  principalType: string | null;
  principalId: string | null;
  displayName: string | null;
}

/**
 * Snapshot a member's identity for storage at send time. A missing member row
 * yields an all-null snapshot (the ref will later render as `unknown` rather
 * than being guessed into a human).
 */
export function memberIdentity(ctx: AppContext, row: MemberRow | undefined): MemberIdentity {
  if (!row) return { principalType: null, principalId: null, displayName: null };
  const kind = row.principalType as PrincipalKind;
  return {
    principalType: row.principalType,
    principalId: row.principalId,
    displayName: principalDisplayName(ctx, kind, row.principalId),
  };
}

/**
 * The MemberRef for one party to a message. Resolution is by IDENTITY, not by
 * membership — a message's authorship must not change when its author leaves.
 *
 *  1. **Live member row** → the live ref (name, avatar, room-scoped member id).
 *  2. **Membership gone, snapshot present** → the frozen `kind` + `principalId`,
 *     with the principal's LIVE name when the principal still exists (so a
 *     rename keeps rendering on old messages) and the captured name when it does
 *     not (a destroyed agent).
 *  3. **Nothing resolvable** → `kind: 'unknown'`. Never `'human'`: defaulting an
 *     unresolved ref to a blank human is what silently converted an agent's
 *     transcript into a human's and misrouted on `kind`.
 */
function refFor(
  ctx: AppContext,
  memberId: string,
  snapshot?: MemberIdentity,
  page?: MessagePageRefs,
): MemberRef {
  // `page.memberIds` records which ids the page RESOLVED, so a miss inside it is
  // an authoritative "no such member" rather than a cache miss — a member who
  // left costs no extra query on the batched path either.
  const row =
    page && page.memberIds.has(memberId) ? page.members.get(memberId) : memberById(ctx, memberId);
  if (row) {
    const kind = row.principalType as PrincipalKind;
    const { displayName, avatarUrl } = identityOf(ctx, kind, row.principalId, page);
    return { id: row.id, kind, displayName, avatarUrl, principalId: row.principalId };
  }

  const kind = snapshot?.principalType;
  const principalId = snapshot?.principalId;
  if ((kind === 'human' || kind === 'agent') && principalId) {
    const { displayName: live, avatarUrl } = identityOf(ctx, kind, principalId, page);
    return {
      id: memberId,
      kind,
      displayName: live || snapshot?.displayName || '',
      avatarUrl,
      principalId,
    };
  }
  return { id: memberId, kind: 'unknown', displayName: snapshot?.displayName ?? '', avatarUrl: null };
}

/** The sender's frozen identity, as carried on the message row. */
function senderIdentity(row: MessageRow): MemberIdentity {
  return {
    principalType: row.senderPrincipalType,
    principalId: row.senderPrincipalId,
    displayName: row.senderDisplayName,
  };
}

/**
 * Derive a recipient's three-valued read state (SPEC "Read state"): `read` iff
 * read_at is set, else `received` iff received_at is set, else `unread`.
 */
export function recipientStatus(readAt: string | null, receivedAt: string | null): ReadStatus {
  if (readAt) return 'read';
  if (receivedAt) return 'received';
  return 'unread';
}

/**
 * Mark a recipient's row `received` (server-observed delivery) when not already,
 * emitting `message.received` to the sender only when this call set it. Returns
 * the receivedAt timestamp when newly set, else null (set-once semantics). The
 * caller decides *when* delivery is observed (an open stream at send time, or an
 * inbox listing); this only performs the guarded write + emit.
 */
export function markReceived(
  ctx: AppContext,
  roomId: string,
  senderMemberId: string,
  messageId: string,
  recipientMemberId: string,
  ts: string,
  /** The listing's page bundle, so the emitted `by` ref costs no extra query. */
  page?: MessagePageRefs,
): string | null {
  const res = ctx.db
    .update(messageRecipients)
    .set({ receivedAt: ts })
    .where(
      and(
        eq(messageRecipients.messageId, messageId),
        eq(messageRecipients.recipientId, recipientMemberId),
        isNull(messageRecipients.receivedAt),
      ),
    )
    .run();
  if (res.changes === 0) return null;
  emitMessageReceived(ctx, roomId, senderMemberId, {
    messageId,
    by: refFor(ctx, recipientMemberId, undefined, page),
    receivedAt: ts,
  });
  return ts;
}

/** The `{ preview, truncated }` pair for a body (first {@link PREVIEW_LENGTH} chars). */
export function bodyPreview(body: string): { preview: string; truncated: boolean } {
  return { preview: body.slice(0, PREVIEW_LENGTH), truncated: body.length > PREVIEW_LENGTH };
}

/** Project one attachment row to its wire metadata. */
function toAttachmentMeta(a: typeof attachments.$inferSelect): AttachmentMeta {
  return { id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes };
}

/** Attachment metadata rows for a message (ascending by id). */
export function attachmentMetas(ctx: AppContext, messageId: string): AttachmentMeta[] {
  return ctx.db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.id))
    .all()
    .map(toAttachmentMeta);
}

/**
 * How many ids one batched lookup binds at a time. SQLite's bound-parameter
 * ceiling is finite, and a page is never near this — the chunk exists so a
 * caller that hands over an unbounded id list still degrades to a few queries
 * instead of failing.
 */
const PAGE_LOOKUP_CHUNK = 500;

/** Split ids into bind-sized chunks (empty in, empty out). */
function chunked(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PAGE_LOOKUP_CHUNK) out.push(ids.slice(i, i + PAGE_LOOKUP_CHUNK));
  return out;
}

/**
 * Everything a PAGE of messages needs from the database beyond its own rows,
 * resolved in a handful of queries instead of a handful PER MESSAGE.
 *
 * Serializing a message used to cost one attachments query, one recipients
 * query, and then — for the sender and every recipient — a member lookup plus a
 * display-name and avatar lookup. On a 50-message room page with three members
 * that was hundreds of round trips whose only variable was how much of the room
 * you had scrolled through. This bundle is built once per page and threaded
 * through {@link toMessage} / {@link toInboxItem}; single-message routes pass
 * nothing and keep the original one-row-at-a-time path.
 */
export interface MessagePageRefs {
  /** Attachment metadata by message id (absent = none). */
  attachments: Map<string, AttachmentMeta[]>;
  /**
   * Delivery rows by message id, ascending by recipient id. Undefined when the
   * page does not render `to` at all (inbox previews carry only a sender), in
   * which case {@link toMessage} falls back to its own per-message query.
   */
  recipients?: Map<string, MessageRecipientRow[]>;
  /** The member ids this page resolved — a miss here means the member is GONE. */
  memberIds: Set<string>;
  /** The live member rows among them. */
  members: Map<string, MemberRow>;
  /** Memo of `${kind}:${principalId}` → live display name + avatar. */
  identities: Map<string, { displayName: string; avatarUrl: string | null }>;
}

/**
 * A principal's live display name and avatar, memoized per page. Refs repeat
 * hard on a transcript — the same handful of people wrote all fifty messages —
 * so this collapses the name/avatar lookups from one per REF to one per distinct
 * principal. The miss path calls exactly the helpers the unbatched ref uses, so
 * the projection is identical either way.
 */
function identityOf(
  ctx: AppContext,
  kind: PrincipalKind,
  principalId: string,
  page?: MessagePageRefs,
): { displayName: string; avatarUrl: string | null } {
  const key = `${kind}:${principalId}`;
  const hit = page?.identities.get(key);
  if (hit) return hit;
  const resolved = {
    displayName: principalDisplayName(ctx, kind, principalId),
    avatarUrl: avatarUrlForPrincipal(ctx, kind, principalId),
  };
  page?.identities.set(key, resolved);
  return resolved;
}

/** Resolve the member rows for a set of member ids, in bind-sized batches. */
function membersByIdFor(ctx: AppContext, memberIds: string[]): Map<string, MemberRow> {
  const byId = new Map<string, MemberRow>();
  for (const chunk of chunked(memberIds)) {
    for (const row of ctx.db.select().from(members).where(inArray(members.id, chunk)).all()) {
      byId.set(row.id, row);
    }
  }
  return byId;
}

/**
 * The page bundle for full Messages: attachments, delivery rows, and every
 * member named by a sender or a recipient — three queries for the page.
 */
export function messagePageRefs(ctx: AppContext, rows: MessageRow[]): MessagePageRefs {
  const ids = [...new Set(rows.map((row) => row.id))];
  const recipients = new Map<string, MessageRecipientRow[]>();
  const recipientIds: string[] = [];
  for (const chunk of chunked(ids)) {
    const recRows = ctx.db
      .select()
      .from(messageRecipients)
      .where(inArray(messageRecipients.messageId, chunk))
      // The per-message query reads these off the (message_id, recipient_id)
      // primary key and so sees them recipient-id ascending; ordering explicitly
      // is what makes the batched `to` array byte-for-byte the same.
      .orderBy(asc(messageRecipients.messageId), asc(messageRecipients.recipientId))
      .all();
    for (const rec of recRows) {
      recipientIds.push(rec.recipientId);
      const list = recipients.get(rec.messageId);
      if (list) list.push(rec);
      else recipients.set(rec.messageId, [rec]);
    }
  }
  const memberIds = [...new Set([...rows.map((row) => row.senderId), ...recipientIds])];
  return {
    attachments: attachmentMetasFor(ctx, ids),
    recipients,
    memberIds: new Set(memberIds),
    members: membersByIdFor(ctx, memberIds),
    identities: new Map(),
  };
}

/**
 * The page bundle for inbox PREVIEWS. A preview renders the sender and an
 * attachment count and never the recipient list, so it skips the delivery-row
 * read entirely — the inbox query already did that join.
 */
export function inboxPageRefs(
  ctx: AppContext,
  rows: MessageRow[],
  /**
   * Extra member ids the page will resolve refs for beyond the senders — the
   * RECIPIENTS whose delivery this listing observes, whose refs ride along on
   * the `message.received` events it emits (see {@link markReceived}).
   */
  alsoResolve: string[] = [],
): MessagePageRefs {
  const memberIds = [...new Set([...rows.map((row) => row.senderId), ...alsoResolve])];
  return {
    attachments: attachmentMetasFor(ctx, rows.map((row) => row.id)),
    memberIds: new Set(memberIds),
    members: membersByIdFor(ctx, memberIds),
    identities: new Map(),
  };
}

/**
 * Attachment metadata for MANY messages at once, keyed by message id — the
 * batched twin of {@link attachmentMetas}. Serializing a page used to ask the
 * database once per message, so a 50-message history page issued 50 extra
 * queries and got slower the more of a room you loaded; this asks once for the
 * whole page. Messages with no attachments are simply absent from the map (read
 * it with `?? []`). Ordering within a message matches the single-message helper
 * exactly (ascending by attachment id), which is what lets the batched
 * projection be byte-for-byte identical.
 */
export function attachmentMetasFor(
  ctx: AppContext,
  messageIds: string[],
): Map<string, AttachmentMeta[]> {
  const byMessage = new Map<string, AttachmentMeta[]>();
  for (const chunk of chunked([...new Set(messageIds)])) {
    const rows = ctx.db
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, chunk))
      .orderBy(asc(attachments.messageId), asc(attachments.id))
      .all();
    for (const a of rows) {
      const list = byMessage.get(a.messageId);
      if (list) list.push(toAttachmentMeta(a));
      else byMessage.set(a.messageId, [toAttachmentMeta(a)]);
    }
  }
  return byMessage;
}

/** Parse a message's stored `suggested_replies` JSON to the wire array. */
export function parseSuggestedReplies(raw: string | null): SuggestedReply[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.label === 'string' && typeof r.value === 'string')
      .map((r) => ({ label: r.label as string, value: r.value as string }));
  } catch {
    return [];
  }
}

/** The recipient member ids of a message (ascending by insertion). */
export function recipientMemberIds(ctx: AppContext, messageId: string): string[] {
  return ctx.db
    .select({ recipientId: messageRecipients.recipientId })
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, messageId))
    .all()
    .map((r) => r.recipientId);
}

/** The recipient refs of a message, each resolved through its frozen identity. */
function recipientRefs(ctx: AppContext, messageId: string, page?: MessagePageRefs): MemberRef[] {
  const rows =
    page?.recipients
      ? (page.recipients.get(messageId) ?? [])
      : ctx.db
          .select()
          .from(messageRecipients)
          .where(eq(messageRecipients.messageId, messageId))
          .all();
  return rows.map((r) =>
    refFor(
      ctx,
      r.recipientId,
      {
        principalType: r.recipientPrincipalType,
        principalId: r.recipientPrincipalId,
        displayName: r.recipientDisplayName,
      },
      page,
    ),
  );
}

/**
 * Project a message row to the full wire Message. Pass `page` — a
 * {@link messagePageRefs} bundle covering this row — when serializing a PAGE, so
 * attachments, delivery rows and member refs cost a few queries for the whole
 * page instead of several per message; omit it on single-message routes, which
 * then resolve the row's dependencies one query at a time as before.
 */
export function toMessage(ctx: AppContext, row: MessageRow, page?: MessagePageRefs): Message {
  const to = recipientRefs(ctx, row.id, page);
  return {
    id: row.id,
    from: refFor(ctx, row.senderId, senderIdentity(row), page),
    to,
    kind: row.kind as MessageKind,
    subject: row.subject ?? null,
    body: row.body,
    attachments: page ? (page.attachments.get(row.id) ?? []) : attachmentMetas(ctx, row.id),
    suggestedReplies: parseSuggestedReplies(row.suggestedReplies),
    inReplyTo: row.inReplyTo ?? null,
    replyValue: row.replyValue ?? null,
    origin: (row.origin as MessageOrigin | null) ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Project a whole PAGE of message rows, resolving every row's attachments in one
 * query. The list-route form of {@link toMessage} — use it wherever a route
 * serializes more than one message.
 */
export function toMessages(ctx: AppContext, rows: MessageRow[]): Message[] {
  const page = messagePageRefs(ctx, rows);
  return rows.map((row) => toMessage(ctx, row, page));
}

/**
 * Project a message row to a truncated inbox item for a given read status. Takes
 * an {@link inboxPageRefs} bundle for the same reason {@link toMessage} does: a
 * preview needs only the sender and an attachment COUNT, but resolving those per
 * row is the same N+1.
 */
export function toInboxItem(
  ctx: AppContext,
  row: MessageRow,
  status: ReadStatus,
  page?: MessagePageRefs,
): InboxItem {
  const { preview, truncated } = bodyPreview(row.body);
  const attachmentCount = page
    ? (page.attachments.get(row.id)?.length ?? 0)
    : ctx.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.messageId, row.id))
        .all().length;
  return {
    id: row.id,
    from: refFor(ctx, row.senderId, senderIdentity(row), page),
    kind: row.kind as MessageKind,
    subject: row.subject ?? null,
    preview,
    truncated,
    attachmentCount,
    status,
    createdAt: row.createdAt,
  };
}

/**
 * Whether a member (by id) can read a message: any current member of the
 * message's room can read every message in that room (Slack-channel semantics).
 * Recipient rows are delivery state only and no longer gate visibility. Used for
 * message get, `inReplyTo` echoes, and status/attachment access.
 */
export function memberCanReadMessage(ctx: AppContext, memberId: string, row: MessageRow): boolean {
  const member = memberById(ctx, memberId);
  return !!member && member.roomId === row.roomId;
}

/**
 * A LIVE message row by id constrained to a room, or undefined. A clawed-back
 * row (SPEC "Clawback") is treated as nonexistent — every by-id surface built
 * on this (read, status, attachments, `inReplyTo` echoes) 404s on it, exactly
 * like an unknown id. The clawback route itself queries the table directly (it
 * must distinguish "already clawed" from "never existed").
 */
export function messageInRoom(ctx: AppContext, roomId: string, messageId: string): MessageRow | undefined {
  const row = ctx.db.select().from(messages).where(eq(messages.id, messageId)).get();
  return row && row.roomId === roomId && !row.clawedBackAt ? row : undefined;
}

/** The current members of a room excluding one member id (broadcast recipients). */
export function broadcastRecipientIds(ctx: AppContext, roomId: string, exceptMemberId: string): string[] {
  return ctx.db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.roomId, roomId))
    .all()
    .map((m) => m.id)
    .filter((id) => id !== exceptMemberId);
}

/** Count of the caller's unread received messages (their unread inbox size). */
export function unreadCountForMember(ctx: AppContext, memberId: string): number {
  return ctx.db
    .select({ messageId: messageRecipients.messageId })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .where(
      and(
        eq(messageRecipients.recipientId, memberId),
        isNull(messageRecipients.readAt),
        // A clawed message no longer counts against anyone's badge.
        isNull(messages.clawedBackAt),
      ),
    )
    .all().length;
}

/**
 * The oldest unread message across a set of recipient member ids (ascending by
 * createdAt then SQLite insertion order), with the recipient id it is unread for.
 */
export function oldestUnreadAcrossMembers(
  ctx: AppContext,
  memberIds: string[],
): { row: MessageRow; recipientId: string } | undefined {
  if (memberIds.length === 0) return undefined;
  const hit = ctx.db
    .select({ msg: messages, recipientId: messageRecipients.recipientId })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .where(
      and(
        inArray(messageRecipients.recipientId, memberIds),
        isNull(messageRecipients.readAt),
        // A clawed message must never pop (SPEC "Clawback").
        isNull(messages.clawedBackAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(sql`${messages}.rowid`))
    .limit(1)
    .get();
  return hit ? { row: hit.msg, recipientId: hit.recipientId } : undefined;
}
