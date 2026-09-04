/**
 * The activity stream (v4): the pure half of "a conversation pane is one
 * time-ordered column of everything that happened", and of the agent page's
 * timeline.
 *
 * Two steps, both pure and both testable without a network:
 *  1. {@link mergeStream} — merge the chat thread (the room route stays the
 *     authority for chat) with the non-chat timeline entries, dropping entries
 *     whose medium or type this client does not recognize (the registry is
 *     additive; a v4 client must survive a v5 medium).
 *  2. {@link collapseStream} — apply the collapsing rules to what is RENDERED:
 *     same-thread runs of 3+, consecutive rejections, and the two dispositions
 *     that may never collapse. Every collapse is expandable and none of them
 *     hides state the viewer must act on.
 */
import type { ActivityEntry, AgentDmBox, EmailDisposition } from '@sparrow/common-types';
import type { ThreadItem } from './conversation.js';
import { headFromEntry, isEmailEntry, isPending } from './email.js';

/** One row of the merged stream, before collapsing. */
export type StreamRow =
  | { kind: 'chat'; id: string; createdAt: string; item: ThreadItem }
  | { kind: 'email'; id: string; createdAt: string; entry: ActivityEntry }
  | { kind: 'hint'; id: string; createdAt: string; entry: ActivityEntry };

/** True for the entries this client renders as hint cards (sparrow speaking). */
export function isHintEntry(entry: ActivityEntry): boolean {
  return entry.medium === 'system' && entry.type === 'hint.delivered';
}

/** Same-instant tie rank: chat first (the default register), then the boxes. */
const KIND_RANK: Record<StreamRow['kind'], number> = { chat: 0, email: 1, hint: 2 };

/**
 * Merge chat bubbles and timeline entries into one ascending column. Entries of
 * medium `chat` are ignored (they are the same messages the room route already
 * supplies — rendering both would double every bubble), as are entry types this
 * client does not render.
 *
 * Ties break chat-first, then by kind, then by id, so the order is total and
 * stable.
 */
export function mergeStream(chat: ThreadItem[], entries: ActivityEntry[]): StreamRow[] {
  const rows: StreamRow[] = [];
  for (const item of chat) {
    rows.push({ kind: 'chat', id: item.id, createdAt: item.createdAt, item });
  }
  for (const entry of entries) {
    if (isEmailEntry(entry)) {
      rows.push({ kind: 'email', id: entry.id, createdAt: entry.createdAt, entry });
    } else if (isHintEntry(entry)) {
      rows.push({ kind: 'hint', id: entry.id, createdAt: entry.createdAt, entry });
    }
  }
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

/** One rendered row: a bubble, a card, or a collapsed run (always expandable). */
export type RenderRow =
  | { kind: 'chat'; key: string; item: ThreadItem }
  | { kind: 'email'; key: string; entry: ActivityEntry }
  | { kind: 'hint'; key: string; entry: ActivityEntry }
  | {
      kind: 'thread-run';
      key: string;
      threadId: string;
      subject: string;
      entries: ActivityEntry[];
      /** The newest entry — it supplies the summary row's snippet and badge. */
      newest: ActivityEntry;
    }
  | { kind: 'rejected-run'; key: string; entries: ActivityEntry[] };

/** How many consecutive same-thread entries it takes to collapse a run. */
const RUN_MIN = 3;

/**
 * Apply the collapsing rules to a merged stream.
 *
 * - a run of {@link RUN_MIN}+ consecutive entries in the same thread collapses to
 *   one summary row;
 * - consecutive `rejected` entries collapse to one muted divider — a refusal is a
 *   security record, not a conversation, so it never occupies the stream by
 *   default and is never silently dropped either;
 * - `quarantined` and `held` entries never collapse: they need the owner;
 * - an `email.resolved` entry is FOLDED INTO the card it resolves when that card
 *   is in the window (the card mutates; a second row would say nothing new). Only
 *   an orphaned resolution — its email paged out — renders on its own.
 *
 * Collapsing reads the entry's OWN type, never a live override: an
 * `email.resolved` event mutates the card it lands on (a `Held` badge flips to
 * none, a denial grays it to "Denied" — see `EmailCard`), it does not re-flow
 * the column under the viewer's cursor. An entry that arrived quarantined or
 * held therefore keeps its own row for the life of the pane, whatever happens to
 * it afterwards.
 */
export function collapseStream(rows: StreamRow[]): RenderRow[] {
  const emailIds = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'email' || row.entry.type === 'email.resolved') continue;
    const id = row.entry.refs.emailId;
    if (id) emailIds.add(id);
  }

  // Drop resolutions whose email is already rendered in this window.
  const visible = rows.filter(
    (row) =>
      row.kind !== 'email' ||
      row.entry.type !== 'email.resolved' ||
      !(row.entry.refs.emailId && emailIds.has(row.entry.refs.emailId)),
  );

  const disposition = (entry: ActivityEntry): EmailDisposition | null =>
    headFromEntry(entry).disposition;

  const out: RenderRow[] = [];
  let i = 0;
  while (i < visible.length) {
    const row = visible[i]!;
    if (row.kind === 'chat') {
      out.push({ kind: 'chat', key: row.id, item: row.item });
      i += 1;
      continue;
    }
    // A hint never collapses — each is its own card, and (by sitting between
    // them) it breaks an email run the way any non-email row does.
    if (row.kind === 'hint') {
      out.push({ kind: 'hint', key: row.id, entry: row.entry });
      i += 1;
      continue;
    }

    const d = disposition(row.entry);

    // Quarantined / held: always their own card, and they break any run.
    if (isPending(d)) {
      out.push({ kind: 'email', key: row.id, entry: row.entry });
      i += 1;
      continue;
    }

    // Rejected: gather the consecutive rejected run (one row, even for one entry).
    if (d === 'rejected') {
      const entries: ActivityEntry[] = [];
      while (i < visible.length) {
        const next = visible[i]!;
        if (next.kind !== 'email' || disposition(next.entry) !== 'rejected') break;
        entries.push(next.entry);
        i += 1;
      }
      out.push({ kind: 'rejected-run', key: `rejected:${entries[0]!.id}`, entries });
      continue;
    }

    // Ordinary mail: gather the consecutive same-thread run.
    const threadId = row.entry.refs.emailThreadId ?? '';
    const entries: ActivityEntry[] = [];
    while (i < visible.length) {
      const next = visible[i]!;
      if (next.kind !== 'email') break;
      const nd = disposition(next.entry);
      if (isPending(nd) || nd === 'rejected') break;
      if ((next.entry.refs.emailThreadId ?? '') !== threadId) break;
      entries.push(next.entry);
      i += 1;
    }
    if (entries.length >= RUN_MIN) {
      const newest = entries[entries.length - 1]!;
      out.push({
        kind: 'thread-run',
        key: `run:${entries[0]!.id}`,
        threadId,
        subject: newest.summary ?? '(no subject)',
        entries,
        newest,
      });
    } else {
      for (const entry of entries) out.push({ kind: 'email', key: entry.id, entry });
    }
  }
  return out;
}

/** A conversation-pane row: a rendered stream row, or an interleaved oversight box. */
export type PaneRow = RenderRow | { kind: 'agent-dm'; key: string; box: AgentDmBox };

/** When a rendered row happened, for interleaving (runs sit at their newest entry). */
function renderRowAt(row: RenderRow): string {
  switch (row.kind) {
    case 'chat':
      return row.item.createdAt;
    case 'email':
    case 'hint':
      return row.entry.createdAt;
    case 'thread-run':
      return row.newest.createdAt;
    case 'rejected-run':
      return row.entries[row.entries.length - 1]!.createdAt;
  }
}

/**
 * Interleave agent↔agent DM oversight boxes into a rendered column (SPEC
 * "Direct conversations" — the box rides the SAME rail as the email cards, in
 * the human's DM pane with an involved agent). Each box sits at its
 * `lastMessage.at` — the conversation's latest activity — AFTER any row of the
 * same instant, so a box never splits a bubble from the reply it answers. A box
 * with no message yet is dropped (nothing to oversee); ties between boxes break
 * by roomId so the order is total and stable.
 */
export function interleaveAgentDms(rows: RenderRow[], boxes: AgentDmBox[]): PaneRow[] {
  const live = boxes
    .filter((b): b is AgentDmBox & { lastMessage: NonNullable<AgentDmBox['lastMessage']> } =>
      b.lastMessage !== null,
    )
    .sort((a, b) =>
      a.lastMessage.at !== b.lastMessage.at
        ? a.lastMessage.at < b.lastMessage.at
          ? -1
          : 1
        : a.roomId < b.roomId
          ? -1
          : 1,
    );
  if (live.length === 0) return rows;
  const out: PaneRow[] = [];
  let bi = 0;
  for (const row of rows) {
    const at = renderRowAt(row);
    while (bi < live.length && live[bi]!.lastMessage.at < at) {
      const box = live[bi]!;
      out.push({ kind: 'agent-dm', key: `agent-dm:${box.roomId}`, box });
      bi += 1;
    }
    out.push(row);
  }
  for (; bi < live.length; bi += 1) {
    const box = live[bi]!;
    out.push({ kind: 'agent-dm', key: `agent-dm:${box.roomId}`, box });
  }
  return out;
}
