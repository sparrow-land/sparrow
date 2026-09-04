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
  makeAgent,
  listen,
  openSse,
  type TestServer,
  type SignedUpHuman,
  type SseClient,
} from './test-helpers.js';

/**
 * `GET /me/events/log?since=<id>` — the NON-streaming counterpart to `/me/events`.
 * A one-shot JSON read of the same per-principal journal (backs the CLI reconcile
 * poll that punches through a black-holed SSE path). It must mirror the stream's
 * replay semantics exactly: same events/ids/shapes after the cursor, a structural
 * `gap` when the cursor predates retention, and a `latest` cursor probe when no
 * `since` is given. Capped pages flag `more`.
 */
describe('GET /me/events/log — non-streaming journal read', () => {
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

  async function readLog(
    query: string,
    token?: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: any }> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/events/log${query}`,
      headers: { ...(token ? auth(token) : {}), ...(headers ?? {}) },
    });
    return { statusCode: res.statusCode, body: res.statusCode === 200 ? res.json() : undefined };
  }

  beforeEach(async () => {
    // Long grace so alice's own presence.changed(offline) never fires mid-test.
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

  it('since=0 replays the same message.new events/ids/shapes the SSE stream carried', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('first');
    const e1 = await s.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'first',
    );
    await send('second');
    const e2 = await s.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'second',
    );
    s.close();

    const { statusCode, body } = await readLog('?since=0', alice.token);
    expect(statusCode).toBe(200);
    const msgs = (body.events as { id: number; event: string; data: unknown }[]).filter(
      (ev) => ev.event === 'message.new',
    );
    // Ids match the live frames' cursors, in order…
    expect(msgs.map((m) => m.id)).toEqual([Number(e1.id), Number(e2.id)]);
    // …and the parsed payloads are byte-for-byte the room-wrapped SSE `data:`.
    expect(msgs[0]!.data).toEqual(e1.data);
    expect(msgs[1]!.data).toEqual(e2.data);
    // latest is the principal's newest cursor (>= the last message.new).
    expect(body.latest).toBeGreaterThanOrEqual(Number(e2.id));
    expect(body.gap).toBeUndefined();
    expect(body.more).toBeUndefined();
  });

  it('since replays strictly after the cursor (already-seen is not returned)', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('kept-before');
    const e1 = await s.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'kept-before',
    );
    await send('after-cursor');
    const e2 = await s.waitFor(
      (ev) => ev.event === 'message.new' && (ev.data as { preview: string }).preview === 'after-cursor',
    );
    s.close();

    const { body } = await readLog(`?since=${e1.id}`, alice.token);
    const previews = (body.events as { event: string; data: any }[])
      .filter((ev) => ev.event === 'message.new')
      .map((ev) => ev.data.preview);
    expect(previews).toContain('after-cursor');
    expect(previews).not.toContain('kept-before');
    expect(body.events.every((ev: { id: number }) => ev.id > Number(e1.id))).toBe(true);
    expect(body.latest).toBeGreaterThanOrEqual(Number(e2.id));
  });

  it('no since → empty events + the current latest cursor (a cheap probe)', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('probe');
    const e = await s.waitFor((ev) => ev.event === 'message.new');
    s.close();

    const { body } = await readLog('', alice.token);
    expect(body.events).toEqual([]);
    expect(body.latest).toBeGreaterThanOrEqual(Number(e.id));

    // A principal that never journaled anything → latest 0, no events. A fresh
    // agent (never in a room, never the target of a principal-level event) is the
    // clean empty case.
    const agent = await makeAgent(ts.app, owner.token, orgId, 'log-bot');
    const fresh = await readLog('', agent.key);
    expect(fresh.body).toEqual({ events: [], latest: 0 });
  });

  it('an AGENT is a journalable recipient — its own cursor space, replayed here', async () => {
    // v4 keys the journal by (principalType, principalId), not by human id: the
    // email medium's `email.received`/`email.sent` target agents. Chat proves the
    // key today — an agent replays the room events it received, on its own cursor.
    const agent = await makeAgent(ts.app, owner.token, orgId, 'journal-bot');
    await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/members`,
      headers: auth(owner.token),
      payload: { principal: agent.id },
    });
    await send('for the agent');

    const { body } = await readLog('?since=0', agent.key);
    const names = (body.events as { event: string; data: any }[]).map((e) => e.event);
    expect(names).toContain('message.new');
    expect(body.latest).toBeGreaterThan(0);
    // Alice's cursor space is separate — her ids are not the agent's.
    const mine = await readLog('?since=0', alice.token);
    const agentIds = (body.events as { id: number }[]).map((e) => e.id);
    const aliceIds = (mine.body.events as { id: number }[]).map((e) => e.id);
    expect(agentIds.some((id) => aliceIds.includes(id))).toBe(false);
  });

  it('sets gap:true (mirroring replay.gap) when the cursor predates retention', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('kept');
    const kept = await s.waitFor((ev) => ev.event === 'message.new');
    s.close();
    const keptId = Number(kept.id);

    // Simulate everything up to keptId pruned: set the per-principal high-water mark.
    const raw = new Database(path.join(ts.dataDir, 'sparrow.db'));
    raw
      .prepare(
        'INSERT INTO me_event_journal_marks (principal_type, principal_id, max_pruned_id) VALUES (?, ?, ?)',
      )
      .run('human', alice.userId, keptId);
    raw.close();

    const { body } = await readLog(`?since=${keptId - 1}`, alice.token);
    expect(body.gap).toBe(true);
    // The surviving row (id > cursor) still comes back alongside the gap flag.
    expect((body.events as { data: any }[]).some((ev) => ev.data?.preview === 'kept')).toBe(true);
  });

  it('flags gap:true + the real latest when the cursor is AHEAD of the journal (post-wipe generation mismatch)', async () => {
    // The pre-wipe cursor OUTLIVES a fresh (wiped) journal: a survived state.json
    // carries a huge lastEventId while the new journal's ids restart low. A `since`
    // GREATER than the principal's newest id can't be resumed — the events it names
    // never existed in THIS journal — so the read must flag `gap` and hand back the
    // real `latest` for the client to re-seed to. (Prod: cursor 2634 vs journal 115
    // → a silently dead poll, because the pruned-mark gap check could never fire.)
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('post-wipe');
    await s.waitFor((ev) => ev.event === 'message.new');
    s.close();

    const probe = await readLog('', alice.token);
    const latest = probe.body.latest as number;
    expect(latest).toBeGreaterThan(0);

    const { body } = await readLog(`?since=${latest + 100000}`, alice.token);
    expect(body.gap).toBe(true);
    expect(body.events).toEqual([]); // nothing is > an ahead-of-latest cursor
    expect(body.latest).toBe(latest); // the real newest cursor, to re-seed from
  });

  it('since === latest is NOT a gap (the normal caught-up case)', async () => {
    const s = track(await openSse(base, '/api/v1/me/events', alice.token));
    await send('caught-up');
    await s.waitFor((ev) => ev.event === 'message.new');
    s.close();
    const latest = (await readLog('', alice.token)).body.latest as number;

    const { body } = await readLog(`?since=${latest}`, alice.token);
    expect(body.gap).toBeUndefined();
    expect(body.events).toEqual([]);
  });

  it('caps the page at 500 and flags more:true; latest exceeds the capped window', async () => {
    // Insert 600 journal rows directly (fast, and the pipeline is proven elsewhere).
    const raw = new Database(path.join(ts.dataDir, 'sparrow.db'));
    const stmt = raw.prepare(
      'INSERT INTO me_event_journal (principal_type, principal_id, event, data, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    let lastRowId = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < 600; i++) {
      const info = stmt.run('human', alice.userId, 'message.new', JSON.stringify({ preview: `m${i}` }), now);
      lastRowId = Number(info.lastInsertRowid);
    }
    raw.close();

    const { body } = await readLog('?since=0', alice.token);
    expect(body.events).toHaveLength(500);
    expect(body.more).toBe(true);
    expect(body.latest).toBe(lastRowId);
    // The capped page is the OLDEST 500 (ascending) — the client polls again from
    // the last returned id to get the remainder.
    expect(body.events[0]!.id).toBeLessThan(body.events[499]!.id);
    expect(body.latest).toBeGreaterThan(body.events[499]!.id);
  });

  it('honors ?limit= (page size) and flags more:true when it truncates', async () => {
    // Insert a chunk of rows on top of whatever the membership setup journaled.
    const raw = new Database(path.join(ts.dataDir, 'sparrow.db'));
    const stmt = raw.prepare(
      'INSERT INTO me_event_journal (principal_type, principal_id, event, data, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      stmt.run('human', alice.userId, 'message.new', JSON.stringify({ preview: `m${i}` }), now);
    }
    raw.close();

    // Learn the true total after the cursor (setup may have journaled extra rows).
    const all = await readLog('?since=0&limit=500', alice.token);
    const total = all.body.events.length as number;
    const lastId = all.body.events[total - 1]!.id as number;
    expect(total).toBeGreaterThanOrEqual(10);
    expect(all.body.more).toBeUndefined(); // 500 >= total → no truncation

    // limit below the total → truncated page + more:true, exactly `limit` rows.
    const three = await readLog('?since=0&limit=3', alice.token);
    expect(three.statusCode).toBe(200);
    expect(three.body.events).toHaveLength(3);
    expect(three.body.more).toBe(true);
    // latest still points past the capped window (client re-polls from the last id).
    expect(three.body.latest).toBe(lastId);

    // limit just under the total → still truncated.
    const nearly = await readLog(`?since=0&limit=${total - 1}`, alice.token);
    expect(nearly.body.events).toHaveLength(total - 1);
    expect(nearly.body.more).toBe(true);

    // limit exactly equal to the total → full page, no more flag.
    const exact = await readLog(`?since=0&limit=${total}`, alice.token);
    expect(exact.body.events).toHaveLength(total);
    expect(exact.body.more).toBeUndefined();
  });

  it('rejects a non-numeric or out-of-range ?limit= with 400 + a docs link', async () => {
    for (const bad of ['0', '501', 'abc', '-1', '3.5']) {
      const res = await ts.app.inject({
        method: 'GET',
        url: `/api/v1/me/events/log?since=0&limit=${bad}`,
        headers: auth(alice.token),
      });
      expect(res.statusCode, `limit=${bad}`).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
      expect(res.json().error.docs).toBe('http://localhost:8722/docs/api/me/events');
    }
    // A valid bound at each edge still passes.
    expect((await readLog('?since=0&limit=1', alice.token)).statusCode).toBe(200);
    expect((await readLog('?since=0&limit=500', alice.token)).statusCode).toBe(200);
    // A bad limit is rejected even on the cursor-less probe.
    const probe = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/events/log?limit=999',
      headers: auth(alice.token),
    });
    expect(probe.statusCode).toBe(400);
  });

  it('authenticates via bearer OR ?token=, and rejects missing credentials', async () => {
    await send('m');
    const viaBearer = await readLog('?since=0', alice.token);
    expect(viaBearer.statusCode).toBe(200);
    const viaToken = await readLog(`?since=0&token=${alice.token}`);
    expect(viaToken.statusCode).toBe(200);
    const noAuth = await readLog('?since=0');
    expect(noAuth.statusCode).toBe(401);
  });
});
