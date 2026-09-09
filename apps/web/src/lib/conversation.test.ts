import { describe, it, expect } from 'vitest';
import type { InboxItem, Message } from '@sparrow/common-types';
import { appendOlder, buildConversation, mergeTail, statusById, unreadCounts } from './conversation.js';

const SELF = 'agt_self';
const A = 'agt_alice';
const B = 'agt_bob';

const alice = { id: A, kind: 'agent' as const, avatarUrl: null, displayName: 'alice' };
const bob = { id: B, kind: 'agent' as const, avatarUrl: null, displayName: 'bob' };
const me = { id: SELF, kind: 'agent' as const, avatarUrl: null, displayName: 'web-me' };

const inItem = (over: Partial<InboxItem> & Pick<InboxItem, 'id' | 'from' | 'kind' | 'createdAt'>): InboxItem => ({
  subject: null,
  preview: 'hi',
  truncated: false,
  attachmentCount: 0,
  status: 'unread',
  ...over,
});

const msg = (over: Partial<Message> & Pick<Message, 'id' | 'from' | 'to' | 'kind' | 'createdAt'>): Message => ({
  subject: null,
  body: 'yo',
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  ...over,
});

/** The server returns history NEWEST-first; these fixtures are written that way. */
describe('buildConversation', () => {
  const history: Message[] = [
    msg({ id: 'msg_ob', from: me, to: [alice, bob], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    msg({ id: 'msg_ib', from: alice, to: [me, bob], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' }),
    msg({ id: 'msg_i2', from: bob, to: [me], kind: 'dm', createdAt: '2026-08-12T10:01:00Z' }),
    msg({ id: 'msg_o1', from: me, to: [alice], kind: 'dm', createdAt: '2026-08-12T10:00:30Z' }),
    msg({ id: 'msg_i1', from: alice, to: [me], kind: 'dm', createdAt: '2026-08-12T10:00:00Z' }),
  ];

  it('builds the project-room view for "all": the WHOLE room, oldest-first', () => {
    // A project room IS a single conversation, and `GET /rooms/:id/messages` is
    // the route that carries all of it — including messages sent before the
    // caller joined (they have no delivery row for those, which is exactly why
    // assembling the thread from inbox+outbox showed a late joiner nothing).
    const thread = buildConversation({ history, selfId: SELF, selected: 'all' });
    expect(thread.map((t) => t.id)).toEqual(['msg_i1', 'msg_o1', 'msg_i2', 'msg_ib', 'msg_ob']);
    expect(thread.map((t) => t.direction)).toEqual(['in', 'out', 'in', 'in', 'out']);
  });

  it('renders a message with NO delivery row as plain, already-read history', () => {
    // A pre-join message: nothing in the caller's inbox mentions it. It must
    // render, and it must not masquerade as unread (no badge, no mark-read).
    const thread = buildConversation({ history, selfId: SELF, selected: 'all' });
    const pre = thread.find((t) => t.id === 'msg_i1')!;
    expect(pre.direction).toBe('in');
    expect(pre.direction === 'in' && pre.inbox.status).toBe('read');
  });

  it('carries the caller\'s delivery state onto the messages that have one', () => {
    const thread = buildConversation({
      history,
      selfId: SELF,
      selected: 'all',
      status: { msg_i1: 'unread', msg_i2: 'received' },
    });
    const byId = Object.fromEntries(
      thread.filter((t) => t.direction === 'in').map((t) => [t.id, t.direction === 'in' ? t.inbox.status : null]),
    );
    expect(byId).toEqual({ msg_i1: 'unread', msg_i2: 'received', msg_ib: 'read' });
  });

  it('gives inbound bubbles the FULL body (history is never a truncated preview)', () => {
    const long = 'x'.repeat(500);
    const thread = buildConversation({
      history: [msg({ id: 'msg_l', from: alice, to: [me], kind: 'broadcast', body: long, createdAt: 't' })],
      selfId: SELF,
      selected: 'all',
    });
    const item = thread[0]!;
    expect(item.direction === 'in' && item.inbox.preview).toBe(long);
    expect(item.direction === 'in' && item.inbox.truncated).toBe(false);
  });

  it('builds a DM thread with a member, both directions, ordered', () => {
    const thread = buildConversation({ history, selfId: SELF, selected: A, dmRoom: true });
    expect(thread.map((t) => t.id)).toEqual(['msg_i1', 'msg_o1', 'msg_ib', 'msg_ob']);
  });

  it('excludes another member\'s directed messages from a DM thread', () => {
    // msg_i2 is bob→me: it belongs to bob's conversation, not alice's.
    const thread = buildConversation({ history, selfId: SELF, selected: A, dmRoom: true });
    expect(thread.map((t) => t.id)).not.toContain('msg_i2');
  });

  it('merges broadcasts + the counterpart bucket into ONE thread for a DM room', () => {
    // A kind:'dm' room is a single conversation with the counterpart: a message
    // the counterpart sent as a broadcast (to:"all", as `sparrow dm` uses) must
    // appear alongside their direct messages, in chronological order.
    const dmHistory: Message[] = [
      msg({ id: 'msg_other', from: bob, to: [me], kind: 'dm', createdAt: '2026-08-12T10:02:00Z' }),
      msg({ id: 'msg_bc', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:01:00Z' }),
      msg({ id: 'msg_out', from: me, to: [alice], kind: 'dm', createdAt: '2026-08-12T10:00:30Z' }),
      msg({ id: 'msg_dm', from: alice, to: [me], kind: 'dm', createdAt: '2026-08-12T10:00:00Z' }),
    ];
    const thread = buildConversation({ history: dmHistory, selfId: SELF, selected: A, dmRoom: true });
    expect(thread.map((t) => t.id)).toEqual(['msg_dm', 'msg_out', 'msg_bc']);
  });

  it('orders by createdAt, keeping the server order for ties', () => {
    // Same instant: the server broke the tie by insertion order and returned
    // them newest-first, so reversing restores it — never a re-sort by id.
    const same: Message[] = [
      msg({ id: 'msg_b', from: alice, to: [me], kind: 'dm', createdAt: '2026-08-12T10:00:00Z' }),
      msg({ id: 'msg_a', from: alice, to: [me], kind: 'dm', createdAt: '2026-08-12T10:00:00Z' }),
    ];
    const thread = buildConversation({ history: same, selfId: SELF, selected: A, dmRoom: true });
    expect(thread.map((t) => t.id)).toEqual(['msg_a', 'msg_b']);
  });
});

describe('unreadCounts', () => {
  it('groups unread by sender and broadcasts under "all"', () => {
    const inbox: InboxItem[] = [
      inItem({ id: '1', from: alice, kind: 'dm', createdAt: 't', status: 'unread' }),
      inItem({ id: '2', from: alice, kind: 'dm', createdAt: 't', status: 'unread' }),
      inItem({ id: '3', from: bob, kind: 'dm', createdAt: 't', status: 'read' }),
      inItem({ id: '4', from: bob, kind: 'broadcast', createdAt: 't', status: 'unread' }),
    ];
    expect(unreadCounts(inbox)).toEqual({ [A]: 2, all: 1 });
  });
});

describe('statusById', () => {
  it('maps the caller\'s open delivery rows by message id', () => {
    const inbox: InboxItem[] = [
      inItem({ id: 'msg_1', from: alice, kind: 'broadcast', createdAt: 't', status: 'unread' }),
      inItem({ id: 'msg_2', from: bob, kind: 'dm', createdAt: 't', status: 'received' }),
    ];
    expect(statusById(inbox)).toEqual({ msg_1: 'unread', msg_2: 'received' });
  });
});

/**
 * Reverse paging (the room opens on the newest page and walks backwards). The
 * loaded set is the union of every page fetched so far; a REFETCHED tail must
 * merge into it rather than replace it, or every older page the reader scrolled
 * back for would vanish on the next reconcile.
 */
describe('appendOlder', () => {
  const loaded: Message[] = [
    msg({ id: 'm5', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:05:00Z' }),
    msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
  ];

  it('appends an older page BELOW the loaded history, still newest-first', () => {
    const older: Message[] = [
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
      msg({ id: 'm2', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' }),
    ];
    expect(appendOlder(loaded, older).map((m) => m.id)).toEqual(['m5', 'm4', 'm3', 'm2']);
  });

  it('de-dupes an overlapping page, keeping the already-loaded copy', () => {
    const older: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', body: 'stale', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    ];
    const out = appendOlder(loaded, older);
    expect(out.map((m) => m.id)).toEqual(['m5', 'm4', 'm3']);
    expect(out.find((m) => m.id === 'm4')!.body).toBe('yo');
  });

  it('never drops loaded history for an empty page', () => {
    expect(appendOlder(loaded, []).map((m) => m.id)).toEqual(['m5', 'm4']);
  });
});

describe('mergeTail', () => {
  /** Two older pages the reader scrolled back for, plus the tail on top. */
  const loaded: Message[] = [
    msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
    msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    msg({ id: 'm2', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' }),
    msg({ id: 'm1', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:01:00Z' }),
  ];

  it('keeps older pages and folds in messages the tail brings', () => {
    const tail: Message[] = [
      msg({ id: 'm5', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:05:00Z' }),
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    ];
    expect(mergeTail(loaded, tail).map((m) => m.id)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
  });

  it('prefers the TAIL copy of an overlapping message (it is the fresher one)', () => {
    const tail: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', body: 'edited', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    ];
    expect(mergeTail(loaded, tail).find((m) => m.id === 'm4')!.body).toBe('edited');
  });

  it('drops a loaded message the tail no longer carries INSIDE the tail window (clawed)', () => {
    // m4 and m3 are inside the refetched window; the tail came back without m3,
    // so it is gone (SPEC "Clawback" — history excludes clawed rows).
    const tail: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
    ];
    expect(mergeTail(loaded, tail).map((m) => m.id)).toEqual(['m4', 'm3', 'm2', 'm1']);
  });

  it('drops a message NEWER than the tail\'s oldest that the tail omits', () => {
    const tail: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm2', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' }),
    ];
    // m3 sits strictly inside the window and is absent → gone. m1 is older than
    // the window and must survive.
    expect(mergeTail(loaded, tail).map((m) => m.id)).toEqual(['m4', 'm2', 'm1']);
  });

  it('keeps a message that merely TIES the tail\'s oldest timestamp', () => {
    // Only `createdAt` is comparable here — a tie says nothing about which side
    // of the page boundary the message fell on, so it is kept, not assumed dead.
    const tied = msg({ id: 'm2b', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' });
    const tail: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
      msg({ id: 'm2', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:02:00Z' }),
    ];
    expect(mergeTail([...loaded.slice(0, 3), tied, ...loaded.slice(3)], tail).map((m) => m.id)).toEqual([
      'm4', 'm3', 'm2', 'm2b', 'm1',
    ]);
  });

  it('is the WHOLE truth when the tail covers the whole room', () => {
    // `nextBefore: null` on a tail listing means the page IS the room; anything
    // else we hold is stale.
    const tail: Message[] = [
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
    ];
    expect(mergeTail(loaded, tail, { tailIsWholeRoom: true }).map((m) => m.id)).toEqual(['m4']);
  });

  it('yields to a tail that does not TOUCH the loaded set', () => {
    // A burst landed between the two listings: every message in the fresh tail
    // is newer than everything we hold, so there is a hole between them that no
    // cursor can fill. A transcript with an invisible gap in it is worse than a
    // short one, so the tail wins outright and the reader pages back again.
    const tail: Message[] = [
      msg({ id: 'm9', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:09:00Z' }),
      msg({ id: 'm8', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:08:00Z' }),
    ];
    expect(mergeTail(loaded, tail).map((m) => m.id)).toEqual(['m9', 'm8']);
  });

  it('orders the merged set newest-first by createdAt', () => {
    const tail: Message[] = [
      msg({ id: 'm6', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:06:00Z' }),
      msg({ id: 'm5', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:05:00Z' }),
      msg({ id: 'm4', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:04:00Z' }),
      msg({ id: 'm3', from: alice, to: [me], kind: 'broadcast', createdAt: '2026-08-12T10:03:00Z' }),
    ];
    const out = mergeTail(loaded, tail);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1]!.createdAt >= out[i]!.createdAt).toBe(true);
    }
  });
});
