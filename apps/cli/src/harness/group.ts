/**
 * Batching + grouping for `sparrow harness`.
 *
 * The harness PEEKS `GET /me/inbox` (it never pops) and then decides how to
 * spend runner invocations. One runner per *conversation*, never one per
 * message: three lines typed into `#Product` in five seconds are one turn to a
 * human and must be one turn to the agent too. So waiting items are grouped by
 * ROOM (chat) or THREAD (email), a short `--batch-window` collects the burst,
 * and each group is handed to exactly one runner in arrival order.
 *
 * Everything here is pure and synchronous — the orchestrator owns the clock and
 * the network; this file owns the shape of the queue.
 */
import type { InboxEntry } from '@sparrow/common-types';

/** Retry ladder for a group whose runner keeps failing: 30s, 60s, 120s… capped at 5 min. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 300_000;

/** One conversation's worth of waiting work — the unit a single runner handles. */
export interface PendingGroup {
  /** Stable identity of the conversation: `room:<roomId>` or `thread:<threadId>`. */
  key: string;
  kind: 'chat' | 'email';
  /** The room id (chat) or thread id (email). */
  id: string;
  /** Human label for the timeline: `#Product`, `@Jake Quist (dm)`, `“Subject”`. */
  label: string;
  /** The room's kind (`project`/`dm`) — chat groups only. */
  roomKind?: string;
  /** The thread's subject — email groups only. */
  subject?: string;
  /** Waiting items, arrival order. */
  items: InboxEntry[];
  /** Consecutive failed runner attempts on this group. */
  failures: number;
  /** Epoch ms before which this group must not be retried (0 = now). */
  nextAttemptAt: number;
}

/** The conversation an inbox entry belongs to. */
export function groupKeyOf(entry: InboxEntry): string {
  return entry.type === 'email' ? `thread:${entry.thread.id}` : `room:${entry.room.id}`;
}

/**
 * The label the timeline shows for an entry's conversation. A DM reads as the
 * person on the other end (`@Jake Quist (dm)`), a project room as `#Product`,
 * an email thread as its quoted subject — the three things a human scanning the
 * harness log actually looks for.
 */
export function groupLabelOf(entry: InboxEntry): string {
  if (entry.type === 'email') return `“${entry.thread.subject || '(no subject)'}”`;
  const room = entry.room;
  if (room.kind === 'dm') {
    return `@${room.counterpart?.displayName || room.name || room.id} (dm)`;
  }
  return `#${room.name || room.id}`;
}

function newGroup(entry: InboxEntry): PendingGroup {
  return entry.type === 'email'
    ? {
        key: groupKeyOf(entry),
        kind: 'email',
        id: entry.thread.id,
        label: groupLabelOf(entry),
        subject: entry.thread.subject,
        items: [],
        failures: 0,
        nextAttemptAt: 0,
      }
    : {
        key: groupKeyOf(entry),
        kind: 'chat',
        id: entry.room.id,
        label: groupLabelOf(entry),
        roomKind: entry.room.kind,
        items: [],
        failures: 0,
        nextAttemptAt: 0,
      };
}

/** Group a peeked inbox page into conversations, preserving arrival order. */
export function groupInbox(entries: InboxEntry[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  mergeIntoGroups(groups, entries);
  return groups;
}

/**
 * Fold a fresh peek into the groups already pending, IN PLACE. Items already
 * queued are skipped (a peek re-reads everything still unread, and re-adding
 * them would hand the runner the same message twice); per-group failure and
 * backoff bookkeeping survives, so a retrying group is not reset by an
 * unrelated new message landing beside it.
 *
 * Returns the entries that were genuinely new, so the caller can log exactly
 * the work it just learned about.
 */
export function mergeIntoGroups(
  groups: PendingGroup[],
  entries: InboxEntry[],
): { added: InboxEntry[] } {
  const added: InboxEntry[] = [];
  for (const entry of entries) {
    const key = groupKeyOf(entry);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = newGroup(entry);
      groups.push(group);
    }
    if (group.items.some((i) => i.id === entry.id)) continue;
    group.items.push(entry);
    added.push(entry);
  }
  return { added };
}

/**
 * Remove one item by id (a `message.clawback` for work not yet handed to a
 * runner), pruning a group that empties. Returns whether anything was dropped.
 */
export function dropItem(groups: PendingGroup[], itemId: string): boolean {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const at = group.items.findIndex((item) => item.id === itemId);
    if (at === -1) continue;
    group.items.splice(at, 1);
    if (group.items.length === 0) groups.splice(i, 1);
    return true;
  }
  return false;
}

/** Delay before the `n`-th consecutive retry of a failing group. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/**
 * The group to run next: the eligible one (past its backoff) whose oldest item
 * has waited longest, so a burst never starves an older conversation.
 */
export function nextRunnable(groups: PendingGroup[], now: number): PendingGroup | undefined {
  const eligible = groups.filter((g) => g.items.length > 0 && g.nextAttemptAt <= now);
  if (eligible.length === 0) return undefined;
  return eligible.reduce((best, g) =>
    Date.parse(g.items[0]!.createdAt) < Date.parse(best.items[0]!.createdAt) ? g : best,
  );
}

/** ms until the earliest backing-off group becomes runnable (undefined = none waiting). */
export function msUntilRunnable(groups: PendingGroup[], now: number): number | undefined {
  const waiting = groups.filter((g) => g.items.length > 0).map((g) => g.nextAttemptAt - now);
  if (waiting.length === 0) return undefined;
  return Math.max(0, Math.min(...waiting));
}
