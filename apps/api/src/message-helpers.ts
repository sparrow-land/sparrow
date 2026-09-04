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
import type { MemberRow, MessageRow } from './db/schema.js';
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
function refFor(ctx: AppContext, memberId: string, snapshot?: MemberIdentity): MemberRef {
  const row = memberById(ctx, memberId);
  if (row) return toMemberRef(ctx, row);

  const kind = snapshot?.principalType;
  const principalId = snapshot?.principalId;
  if ((kind === 'human' || kind === 'agent') && principalId) {
    const live = principalDisplayName(ctx, kind, principalId);
    return {
      id: memberId,
      kind,
      displayName: live || snapshot?.displayName || '',
      avatarUrl: avatarUrlForPrincipal(ctx, kind, principalId),
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
    by: refFor(ctx, recipientMemberId),
    receivedAt: ts,
  });
  return ts;
}

/** The `{ preview, truncated }` pair for a body (first {@link PREVIEW_LENGTH} chars). */
export function bodyPreview(body: string): { preview: string; truncated: boolean } {
  return { preview: body.slice(0, PREVIEW_LENGTH), truncated: body.length > PREVIEW_LENGTH };
}

/** Attachment metadata rows for a message (ascending by id). */
export function attachmentMetas(ctx: AppContext, messageId: string): AttachmentMeta[] {
  return ctx.db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.id))
    .all()
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
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
function recipientRefs(ctx: AppContext, messageId: string): MemberRef[] {
  return ctx.db
    .select()
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, messageId))
    .all()
    .map((r) =>
      refFor(ctx, r.recipientId, {
        principalType: r.recipientPrincipalType,
        principalId: r.recipientPrincipalId,
        displayName: r.recipientDisplayName,
      }),
    );
}

/** Project a message row to the full wire Message. */
export function toMessage(ctx: AppContext, row: MessageRow): Message {
  const to = recipientRefs(ctx, row.id);
  return {
    id: row.id,
    from: refFor(ctx, row.senderId, senderIdentity(row)),
    to,
    kind: row.kind as MessageKind,
    subject: row.subject ?? null,
    body: row.body,
    attachments: attachmentMetas(ctx, row.id),
    suggestedReplies: parseSuggestedReplies(row.suggestedReplies),
    inReplyTo: row.inReplyTo ?? null,
    replyValue: row.replyValue ?? null,
    origin: (row.origin as MessageOrigin | null) ?? null,
    createdAt: row.createdAt,
  };
}

/** Project a message row to a truncated inbox item for a given read status. */
export function toInboxItem(ctx: AppContext, row: MessageRow, status: ReadStatus): InboxItem {
  const { preview, truncated } = bodyPreview(row.body);
  const attachmentCount = ctx.db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.messageId, row.id))
    .all().length;
  return {
    id: row.id,
    from: refFor(ctx, row.senderId, senderIdentity(row)),
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
