import { describe, it, expect } from 'vitest';
import type { InboxItem, ListStatusesResponse } from '@sparrow/common-types';
import type { PrincipalEvent } from '@sparrow/client';
import {
  RoomStreams,
  type MultiplexedStream,
  type RoomConnection,
  type RoomStreamEvent,
} from './roomStreams.js';
import { PresenceStore } from './presenceStore.js';

/**
 * RoomStreams is a ROUTER, not a connection owner (issue #54). It used to hold
 * one SSE connection per joined room, which saturated the browser's ~6 HTTP/1.1
 * sockets per origin at four rooms; `/me/events` was already the server's
 * multiplexed stream, so this now subscribes there once and routes wrapped
 * frames by `room.id`. Reconnect and cursor resume belong to that shared stream
 * (see `meEvents.test.ts`); what is tested here is the routing.
 */

/** A controllable stand-in for the shared `/me/events` stream. */
function fakeStream(): {
  stream: MultiplexedStream;
  push: (ev: PrincipalEvent) => void;
  reconnect: () => void;
  subscribers: () => number;
} {
  const subs = new Set<(ev: PrincipalEvent) => void>();
  const recon = new Set<() => void>();
  return {
    stream: {
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      onReconnect: (fn) => {
        recon.add(fn);
        return () => recon.delete(fn);
      },
    },
    push: (ev) => {
      for (const fn of [...subs]) fn(ev);
    },
    reconnect: () => {
      for (const fn of [...recon]) fn();
    },
    subscribers: () => subs.size,
  };
}

/** A room's REST snapshot source, counting reads and serving mutable state. */
function fakeConn(): { make: (roomId: string) => RoomConnection; unreadCalls: () => number; setItems: (i: InboxItem[]) => void } {
  let unreadCalls = 0;
  let items: InboxItem[] = [];
  return {
    make: () => ({
      listUnread: async () => {
        unreadCalls += 1;
        return items;
      },
      getStatus: async () => ({ items: [], presence: { online: [] } }) as ListStatusesResponse,
    }),
    unreadCalls: () => unreadCalls,
    setItems: (i) => {
      items = i;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A room-wrapped `/me/events` frame, exactly as the API builds and the client decodes it. */
function wrapped(roomId: string, type: string, data: unknown, id?: string): PrincipalEvent {
  return {
    type,
    data,
    room: { id: roomId, name: roomId, orgId: 'org_1', kind: 'project' },
    ...(id ? { id } : {}),
  } as PrincipalEvent;
}

const BOT = { id: 'mem_bot', kind: 'agent' as const, avatarUrl: null, displayName: 'bot' };

const unreadItem = (id: string): InboxItem =>
  ({
    id,
    from: BOT,
    kind: 'broadcast',
    subject: null,
    preview: 'oops',
    truncated: false,
    attachmentCount: 0,
    status: 'unread',
    createdAt: '2026-09-01T10:00:00Z',
  }) as InboxItem;

describe('RoomStreams holds no connection of its own', () => {
  it('subscribes to the shared stream ONCE, whatever the room count', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });

    streams.ensure(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    await flush();
    expect(s.subscribers()).toBe(1);
    expect(Object.keys(streams.snapshot())).toHaveLength(8);

    streams.dispose();
    expect(s.subscribers()).toBe(0);
  });

  it('releases the subscription when the last room goes away', async () => {
    const s = fakeStream();
    const streams = new RoomStreams({ stream: s.stream, connect: fakeConn().make, presence: new PresenceStore() });
    streams.ensure(['r1']);
    expect(s.subscribers()).toBe(1);
    streams.ensure([]);
    expect(s.subscribers()).toBe(0);
    // …and re-attaches when rooms come back (a re-scoped workspace).
    streams.ensure(['r2']);
    expect(s.subscribers()).toBe(1);
    streams.dispose();
  });
});

describe('RoomStreams routes wrapped frames by room id', () => {
  it('credits message.new to the frame’s OWN room, and drops untracked rooms', async () => {
    const s = fakeStream();
    const streams = new RoomStreams({ stream: s.stream, connect: fakeConn().make, presence: new PresenceStore() });
    streams.ensure(['r1', 'r2']);
    await flush();

    s.push(wrapped('r2', 'message.new', { messageId: 'm1', from: BOT, preview: 'hi', kind: 'broadcast' }));
    expect(streams.snapshot()['r2']!.unread).toEqual({ all: 1 });
    expect(streams.snapshot()['r1']!.unread).toEqual({});

    // A room this workspace does not track (another org's, say) is not ours.
    s.push(wrapped('r_other', 'message.new', { messageId: 'm2', from: BOT, preview: 'x', kind: 'broadcast' }));
    expect(streams.snapshot()['r_other']).toBeUndefined();

    // Unwrapped principal-level frames belong to the workspace, not here.
    s.push({ type: 'agent.shared', data: { agent: { id: 'agt_1' } } } as PrincipalEvent);
    expect(Object.keys(streams.snapshot())).toEqual(['r1', 'r2']);

    streams.dispose();
  });

  it('fans a room’s frames out to that room’s subscribers only', async () => {
    const s = fakeStream();
    const streams = new RoomStreams({ stream: s.stream, connect: fakeConn().make, presence: new PresenceStore() });
    const seen1: RoomStreamEvent[] = [];
    const seen2: RoomStreamEvent[] = [];
    streams.ensure(['r1', 'r2']);
    streams.subscribe('r1', (ev) => seen1.push(ev));
    streams.subscribe('r2', (ev) => seen2.push(ev));
    await flush();

    s.push(wrapped('r1', 'message.read', { messageId: 'm1', by: BOT, readAt: '2026-09-01T10:00:00Z' }));
    expect(seen1.map((e) => e.type)).toContain('message.read');
    expect(seen2.map((e) => e.type)).not.toContain('message.read');

    streams.dispose();
  });

  /**
   * `room.updated` is the one event whose payload carries its OWN top-level
   * `room` key, which the fan-in wrapper collides with — so the client hands it
   * back as `ev.room` with `ev.data.room` gone. Subscribers (the Room view) read
   * one shape, so the router splices it back.
   */
  it('restores room.updated to the room-stream payload shape', async () => {
    const s = fakeStream();
    const streams = new RoomStreams({ stream: s.stream, connect: fakeConn().make, presence: new PresenceStore() });
    const seen: RoomStreamEvent[] = [];
    streams.ensure(['r1']);
    streams.subscribe('r1', (ev) => seen.push(ev));
    await flush();

    s.push({
      type: 'room.updated',
      data: { settings: { description: 'new' } },
      room: { id: 'r1', name: 'renamed', archivedAt: null },
    } as unknown as PrincipalEvent);

    const ev = seen.find((e) => e.type === 'room.updated')!;
    expect((ev.data as { room: { id: string; name: string } }).room).toEqual({
      id: 'r1',
      name: 'renamed',
      archivedAt: null,
    });
    expect((ev.data as { settings: { description: string } }).settings.description).toBe('new');

    streams.dispose();
  });

  it('feeds presence.changed into the shared store, keyed by the principal id', async () => {
    const store = new PresenceStore();
    const s = fakeStream();
    const streams = new RoomStreams({ stream: s.stream, connect: fakeConn().make, presence: store });
    streams.ensure(['r1']);
    await flush();

    const member = { id: 'mem_bot', kind: 'agent', displayName: 'Botty', avatarUrl: null, principalId: 'agt_1' };
    s.push(wrapped('r1', 'presence.changed', { member, state: 'online' }));
    expect(store.isOnline('agt_1')).toBe(true);
    s.push(wrapped('r1', 'presence.changed', { member, state: 'offline' }));
    expect(store.isOnline('agt_1')).toBe(false);

    // A pre-fix payload without a principal id is ignored (no member-id key leaks in).
    s.push(
      wrapped('r1', 'presence.changed', {
        member: { id: 'mem_x', kind: 'human', displayName: 'X', avatarUrl: null },
        state: 'online',
      }),
    );
    expect(store.isOnline('mem_x')).toBeUndefined();

    streams.dispose();
  });
});

describe('RoomStreams snapshot budget + reconcile', () => {
  it('snapshots the head of the room set, active room FIRST', async () => {
    const s = fakeStream();
    const reads: string[] = [];
    const streams = new RoomStreams({
      stream: s.stream,
      maxSnapshots: 2,
      presence: new PresenceStore(),
      connect: (roomId) => ({
        listUnread: async () => {
          reads.push(roomId);
          return [];
        },
        getStatus: async () => ({ items: [], presence: { online: [] } }) as ListStatusesResponse,
      }),
    });

    streams.ensure(['r1', 'r2', 'r3', 'r4'], 'r4');
    await flush();
    // The active room is snapshotted even though it is last in the list.
    expect(reads).toEqual(['r4', 'r1']);

    // Rooms past the budget still get LIVE badges — the frames are free now.
    s.push(wrapped('r3', 'message.new', { messageId: 'm1', from: BOT, preview: 'hi', kind: 'broadcast' }));
    expect(streams.snapshot()['r3']!.unread).toEqual({ all: 1 });

    streams.dispose();
  });

  it('re-syncs every snapshotted room when the shared stream RE-connects', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });
    const syncs: string[] = [];
    streams.ensure(['r1', 'r2']);
    streams.subscribe('r1', (ev) => syncs.push(ev.type));
    await flush();
    expect(conn.unreadCalls()).toBe(2); // one per room at attach

    s.reconnect();
    await flush();
    expect(conn.unreadCalls()).toBe(4);
    // The Room view is told to reconcile (its snapshot may have moved).
    expect(syncs.filter((t) => t === 'sync').length).toBeGreaterThanOrEqual(2);

    streams.dispose();
  });

  /**
   * `replay.gap` means our journal cursor predates retention: the resume was
   * INCOMPLETE, so no live patch can be trusted and every room re-reads.
   */
  it('re-syncs on replay.gap', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });
    streams.ensure(['r1', 'r2']);
    await flush();
    expect(conn.unreadCalls()).toBe(2);

    s.push({ type: 'replay.gap', data: { since: 5, latest: 99 } } as PrincipalEvent);
    await flush();
    expect(conn.unreadCalls()).toBe(4);

    streams.dispose();
  });

  /**
   * Clawback (SPEC "Clawback"): `message.clawback` fans out to ALL room members,
   * and a clawed message may have been counted unread by a viewer who never read
   * it. The event carries neither the conversation key nor the kind, so the
   * manager re-fetches the unread page — the server has already killed the row —
   * instead of guessing a decrement. It is still forwarded to room subscribers
   * (the active Room view drops the bubble from its own state).
   */
  it('refetches unread on message.clawback so no phantom badge survives', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    conn.setItems([unreadItem('msg_1')]);
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });
    const seen: string[] = [];
    streams.ensure(['r1']);
    streams.subscribe('r1', (ev) => seen.push(ev.type));
    await flush();
    expect(streams.snapshot()['r1']!.unread).toEqual({ all: 1 });

    conn.setItems([]);
    s.push(
      wrapped('r1', 'message.clawback', {
        messageId: 'msg_1',
        by: BOT,
        clawedBackAt: '2026-09-01T10:01:00Z',
      }),
    );
    await flush();

    expect(conn.unreadCalls()).toBeGreaterThanOrEqual(2); // attach snapshot + the re-count
    expect(streams.snapshot()['r1']!.unread).toEqual({});
    expect(seen).toContain('message.clawback');

    streams.dispose();
  });
});

/**
 * Issue #59 — a room the workspace cache has never learned. A DM created
 * out-of-band (`sparrow dm` from another machine) exists on the server before
 * this tab's rooms list mentions it, so nothing here tracks it: every wrapped
 * frame for it was dropped, and an open Room view on it received NOTHING —
 * no message, not even the synthetic `sync` that would make it reconcile.
 */
describe('RoomStreams learns rooms the cache does not know', () => {
  it('tracks the ACTIVE room even when it is absent from the known set', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });
    const seen: string[] = [];
    streams.subscribe('r_new', (ev) => seen.push(ev.type));

    // The rooms list only knows r1; the router is on r_new.
    streams.ensure(['r1'], 'r_new');
    await flush();

    expect(Object.keys(streams.snapshot())).toContain('r_new');
    // Its snapshot was fetched, and the view was told to reconcile.
    expect(seen).toContain('sync');

    // And its live frames now route (before: dropped on the floor).
    s.push(wrapped('r_new', 'message.new', { messageId: 'm1', from: BOT, preview: 'hi', kind: 'broadcast' }));
    expect(streams.snapshot()['r_new']!.unread).toEqual({ all: 1 });
    expect(seen).toContain('message.new');

    streams.dispose();
  });

  it('reports an unknown room ONCE so the workspace can refetch its rooms', async () => {
    const s = fakeStream();
    const conn = fakeConn();
    const streams = new RoomStreams({ stream: s.stream, connect: conn.make, presence: new PresenceStore() });
    const unknown: string[] = [];
    streams.onUnknownRoom((roomId) => unknown.push(roomId));
    streams.ensure(['r1']);
    await flush();

    const frame = (id: string): PrincipalEvent =>
      wrapped(id, 'message.new', { messageId: 'm1', from: BOT, preview: 'hi', kind: 'broadcast' });

    s.push(frame('r_new'));
    s.push(frame('r_new'));
    expect(unknown).toEqual(['r_new']);
    // A tracked room is never reported.
    s.push(frame('r1'));
    expect(unknown).toEqual(['r_new']);

    // Once the workspace catches up and the room IS tracked, it is forgotten —
    // so if we ever lose it again the workspace is told again.
    streams.ensure(['r1', 'r_new']);
    await flush();
    streams.ensure(['r1']);
    s.push(frame('r_new'));
    expect(unknown).toEqual(['r_new', 'r_new']);

    streams.dispose();
  });
});
