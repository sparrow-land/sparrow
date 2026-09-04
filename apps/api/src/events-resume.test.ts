import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  joinOrg,
  createRoom,
  listen,
  openSse,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

/**
 * SSE resume (`/me/events` journal): every `/me/events` frame carries an `id:`
 * cursor; reconnecting with `?since=`/`Last-Event-ID` replays journaled events
 * after the cursor before going live; a pruned cursor yields a `replay.gap`.
 */
describe('SSE resume — /me/events journal', () => {
  let ts: TestServer;
  let base: string;
  let owner: SignedUpHuman;
  let alice: SignedUpHuman;
  let orgId: string;
  let roomId: string;
  const open: SseClient[] = [];

  const track = (c: SseClient): SseClient => {
    open.push(c);
    return c;
  };

  async function invite(invitee: SignedUpHuman): Promise<void> {
    const inv = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/invitations`,
      headers: auth(owner.token),
      payload: { human: invitee.userId },
    });
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/me/room-invitations/${inv.json().invitation.id}/accept`,
      headers: auth(invitee.token),
    });
  }

  async function send(body: string): Promise<void> {
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { to: alice.userId, body },
    });
  }

  beforeEach(async () => {
    // A long grace so alice's own presence.changed(offline) never fires mid-test.
    ts = await makeTestServer({ presenceGraceSeconds: 30 });
    base = await listen(ts);
    owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
    orgId = await firstOrgId(ts.app, owner.token);
    alice = await joinOrg(ts.app, owner.token, orgId, 'alice@example.com', 'Alice');
    roomId = await createRoom(ts.app, owner.token, orgId, 'general');
    await invite(alice);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await ts.close();
  });

  it('every /me/events frame carries an id cursor', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('hello');
    const e = await s.waitFor((ev) => ev.event === 'message.new');
    expect(e.id).toBeDefined();
    expect(Number.parseInt(e.id!, 10)).toBeGreaterThan(0);
  });

  it('since replays events strictly after the cursor, then continues live', async () => {
    const s1 = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('first');
    const e1 = await s1.waitFor((ev) => ev.event === 'message.new');
    const cursor = e1.id!;
    s1.close();

    // Sent while alice is disconnected — recoverable only via replay.
    await send('second');

    const s2 = track(await openSse(base, `/api/v1/me/events?since=${cursor}`, alice.token));
    const e2 = await s2.waitFor((ev) => ev.event === 'message.new');
    expect((e2.data as { preview: string }).preview).toBe('second');
    expect(Number(e2.id)).toBeGreaterThan(Number(cursor));
    // The already-seen 'first' is NOT replayed.
    expect(
      s2.events.some((ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'first'),
    ).toBe(false);

    // …and the stream is live: a new message flows immediately.
    await send('third');
    const e3 = await s2.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'third',
    );
    expect(Number(e3.id)).toBeGreaterThan(Number(e2.id));
  });

  it('a replayed frame is byte-identical to the live one', async () => {
    const s1 = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('same-bytes');
    const live = await s1.waitFor((ev) => ev.event === 'message.new');
    s1.close();

    const s2 = track(await openSse(base, '/api/v1/me/events?since=0', alice.token));
    const replayed = await s2.waitFor((ev) => ev.event === 'message.new');
    expect(replayed.raw).toBe(live.raw);
  });

  it('honors Last-Event-ID, and ?since wins over it', async () => {
    // Journal m1, m2 with no live stream (journaling is connection-independent).
    const s0 = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('m1');
    const m1 = await s0.waitFor((ev) => ev.event === 'message.new');
    await send('m2');
    const m2 = await s0.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'm2',
    );
    s0.close();

    // Header-only resume from m1 → replays m2.
    const sHeader = track(
      await openSse(base, '/api/v1/me/events', alice.token, { 'last-event-id': m1.id! }),
    );
    const viaHeader = await sHeader.waitFor((ev) => ev.event === 'message.new');
    expect((viaHeader.data as { preview: string }).preview).toBe('m2');
    expect(viaHeader.id).toBe(m2.id);
    sHeader.close();

    // Query wins: header says m1 (would replay m2), query says m2 (replays nothing).
    // A subsequent live send is therefore the FIRST message.new seen.
    const sBoth = track(
      await openSse(base, `/api/v1/me/events?since=${m2.id}`, alice.token, {
        'last-event-id': m1.id!,
      }),
    );
    await send('m3');
    const first = await sBoth.waitFor((ev) => ev.event === 'message.new');
    expect((first.data as { preview: string }).preview).toBe('m3');
  });

  it('emits replay.gap first when the requested cursor has been pruned', async () => {
    const s0 = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('kept');
    const kept = await s0.waitFor((ev) => ev.event === 'message.new');
    s0.close();
    const keptId = Number(kept.id);

    // Simulate that everything up to keptId was pruned: set the per-principal
    // high-water mark directly (the route reads it to decide gap).
    const raw = new Database(path.join(ts.dataDir, 'sparrow.db'));
    raw
      .prepare(
        'INSERT INTO me_event_journal_marks (principal_type, principal_id, max_pruned_id) VALUES (?, ?, ?)',
      )
      .run('human', alice.userId, keptId);
    raw.close();

    // Resume from before the pruned mark → a structural replay.gap FIRST, then
    // whatever survives (the 'kept' row, id > cursor).
    const s2 = track(await openSse(base, `/api/v1/me/events?since=${keptId - 1}`, alice.token));
    const gap = await s2.waitFor((ev) => ev.event === 'replay.gap');
    expect((gap.data as { since: number }).since).toBe(keptId - 1);
    expect(gap.id).toBeUndefined(); // structural: no cursor
    // The gap is the first frame; the surviving 'kept' event replays after it.
    expect(s2.events[0]!.event).toBe('replay.gap');
    const kept2 = await s2.waitFor((ev) => ev.event === 'message.new');
    expect((kept2.data as { preview: string }).preview).toBe('kept');
  });

  it('emits replay.gap (carrying latest) when the cursor is AHEAD of the journal — a post-wipe generation mismatch', async () => {
    // A survived state.json carries a cursor from a PRIOR journal generation (the
    // DB was wiped, ids restarted low). A `since` far beyond the newest id can't be
    // resumed — nothing to replay, but replay is provably impossible — so the stream
    // must announce a structural replay.gap FIRST and carry the real `latest` so the
    // client can re-seed its stale cursor and stop filtering the fresh ids.
    const s0 = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('post-wipe');
    const kept = await s0.waitFor((ev) => ev.event === 'message.new');
    s0.close();
    const staleSince = Number(kept.id) + 100000;

    const s = track(await openSse(base, `/api/v1/me/events?since=${staleSince}`, alice.token));
    const gap = await s.waitFor((ev) => ev.event === 'replay.gap');
    expect(s.events[0]!.event).toBe('replay.gap'); // structural, first
    expect(gap.id).toBeUndefined();
    const gapLatest = (gap.data as { since: number; latest: number }).latest;
    expect(typeof gapLatest).toBe('number');
    expect(gapLatest).toBeGreaterThan(0);
    expect(gapLatest).toBeLessThan(staleSince); // the real newest, below the stale cursor

    // …and the stream is LIVE despite the client's stale high cursor: a new event
    // (a fresh, low id) still flows.
    await send('live-after-heal');
    const live = await s.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'live-after-heal',
    );
    expect(Number(live.id)).toBeGreaterThan(gapLatest);
    expect(Number(live.id)).toBeLessThan(staleSince);
  });
});
