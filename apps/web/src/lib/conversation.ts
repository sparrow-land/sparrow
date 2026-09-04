import type { InboxItem, Message, ReadStatus } from '@sparrow/common-types';

/** A member selector: a specific agent id, or the broadcast pseudo-target. */
export type ConversationTarget = string | 'all';

/**
 * One entry in a rendered conversation thread. Both directions are backed by a
 * FULL message from the room history (`GET /rooms/:id/messages`); the inbound
 * variant additionally carries the caller's delivery state as a preview-shaped
 * `inbox` record, which is what the bubble reads for its unread/received/read
 * behaviour. Both carry `createdAt` for ordering.
 */
export type ThreadItem =
  | { id: string; direction: 'in'; createdAt: string; inbox: InboxItem }
  | { id: string; direction: 'out'; createdAt: string; outbox: Message };

export interface BuildConversationArgs {
  /**
   * The room's conversation history — `GET /rooms/:roomId/messages`, the ONE
   * route that interleaves the whole room (SPEC "Room history"). Newest-first as
   * the server returns it; this reverses to transcript order.
   */
  history: Message[];
  /** The caller's own member id (resolves each message's direction). */
  selfId: string;
  /** Selected member id, or 'all' for the broadcast view. */
  selected: ConversationTarget;
  /**
   * When true the room is a `kind:'dm'` room — a single conversation with the
   * counterpart. Broadcasts (`to:"all"`, as `sparrow dm` and bots use, since the
   * room has one counterpart) are folded into the counterpart's thread so
   * nothing is hidden. `selected` is the counterpart's member id.
   */
  dmRoom?: boolean;
  /**
   * The caller's delivery state per message id, from the room inbox. Only
   * messages the caller has a delivery row for appear here; everything else —
   * notably every message sent BEFORE the caller joined — carries no delivery
   * state at all and is rendered as plain history (`read`), never as unread.
   */
  status?: Record<string, ReadStatus>;
}

/** Delivery-state view of a history message, for the inbound bubble. */
function asPreview(msg: Message, status: ReadStatus): InboxItem {
  return {
    id: msg.id,
    from: msg.from,
    kind: msg.kind,
    subject: msg.subject,
    // History carries the WHOLE body — never the 200-char triage preview.
    preview: msg.body,
    truncated: false,
    attachmentCount: msg.attachments.length,
    status,
    createdAt: msg.createdAt,
  };
}

/**
 * Turn the room history into a single time-ordered thread.
 *
 * The history route is the authority on WHAT is in the room: any current member
 * reads every message, including ones sent before they joined. Delivery rows
 * (inbox/outbox) are state about the caller, never a visibility filter — reading
 * the thread off them is what hid the whole conversation from late joiners.
 *
 * - 'all' (a project room) → the room's one flat conversation, every message.
 * - A DM room (`dmRoom`) → the counterpart's messages AND every broadcast,
 *   merged into the one conversation the room actually is.
 *
 * Ordering is `createdAt` ascending. Ties keep the SERVER's order (history
 * arrives newest-first, so reversing it restores the insertion order the server
 * broke ties on) rather than re-sorting by id.
 */
export function buildConversation({
  history,
  selfId,
  selected,
  dmRoom = false,
  status = {},
}: BuildConversationArgs): ThreadItem[] {
  const items: ThreadItem[] = [];

  // Newest-first → oldest-first, preserving the server's tie order.
  for (const msg of [...history].reverse()) {
    const include =
      selected === 'all' ||
      msg.kind === 'broadcast' ||
      msg.from.id === selected ||
      msg.to.some((t) => t.id === selected) ||
      (dmRoom && msg.from.id === selfId);
    if (!include) continue;
    if (msg.from.id === selfId) {
      items.push({ id: msg.id, direction: 'out', createdAt: msg.createdAt, outbox: msg });
    } else {
      items.push({
        id: msg.id,
        direction: 'in',
        createdAt: msg.createdAt,
        inbox: asPreview(msg, status[msg.id] ?? 'read'),
      });
    }
  }

  // Stable sort: equal timestamps keep the server order restored above.
  items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return items;
}

/** Count of unread inbound messages grouped by conversation key (sender id or 'all'). */
export function unreadCounts(inbox: InboxItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of inbox) {
    if (it.status !== 'unread') continue;
    const key = it.kind === 'broadcast' ? 'all' : it.from.id;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Delivery state by message id, from the caller's room inbox listing. */
export function statusById(inbox: InboxItem[]): Record<string, ReadStatus> {
  const map: Record<string, ReadStatus> = {};
  for (const it of inbox) map[it.id] = it.status;
  return map;
}
