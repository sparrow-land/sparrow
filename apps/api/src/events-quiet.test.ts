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
 * `?quiet=presence,status` — subscription-time opt-out of the two highest-volume
 * ambient event families. An always-on agent that only reacts to work should not
 * have to burn a turn on every teammate blinking online.
 *
 * The contract this file pins:
 *  - the filter applies AT EMISSION TO THAT SUBSCRIBER ONLY (a second, unfiltered
 *    subscription on the same principal still sees everything);
 *  - the JOURNAL is untouched — quieted frames are still journaled and still
 *    consume cursor ids, so cursors never lie and a later unfiltered reconnect
 *    sees them;
 *  - `?since=` replay honors the same filter, so a resume shows exactly what the
 *    live stream would have;
 *  - `/me/events/log` (the non-streaming twin the CLI reconcile poll uses) takes
 *    the same `?quiet=`, or the noise would come back through the poll;
 *  - unknown tokens are IGNORED, never a `400`.
 */
describe('GET /me/events?quiet= — presence/status opt-out', () => {
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

  /** Owner advertises a working status in the room → `status.changed` to all. */
  async function ownerStatus(note: string): Promise<void> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/status`,
      headers: auth(owner.token),
      payload: { state: 'working', note },
    });
    if (res.statusCode !== 200) throw new Error(`status failed: ${res.body}`);
  }

  async function send(body: string): Promise<void> {
    const res = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/messages`,
      headers: auth(owner.token),
      payload: { body },
    });
    if (res.statusCode !== 201) throw new Error(`send failed: ${res.body}`);
  }

  /** Read alice's journal through the non-streaming twin. */
  async function log(query: string): Promise<{
    events: Array<{ id: number; event: string }>;
    latest: number;
  }> {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/api/v1/me/events/log?${query}`,
      headers: auth(alice.token),
    });
    if (res.statusCode !== 200) throw new Error(`log failed (${res.statusCode}): ${res.body}`);
    return res.json();
  }

  beforeEach(async () => {
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

  it('suppresses presence/status frames live, while an unfiltered subscriber still gets them', async () => {
    const quiet = track(
      await openSse(base, '/api/v1/me/events?quiet=presence,status', alice.token),
    );
    const loud = track(await openSse(base, '/api/v1/me/events', alice.token));
    // The owner coming online fans `presence.changed` into alice's streams…
    track(await openSse(base, '/api/v1/me/events', owner.token));
    // …and a working status fans `status.changed`.
    await ownerStatus('deploying');
    await send('hello');

    // The unfiltered subscription on the SAME principal sees all three families.
    await loud.waitFor((e) => e.event === 'presence.changed');
    const loudStatus = await loud.waitFor((e) => e.event === 'status.changed');
    const loudMessage = await loud.waitFor((e) => e.event === 'message.new');

    // The quiet one sees only the work.
    const quietMessage = await quiet.waitFor((e) => e.event === 'message.new');
    expect(quiet.events.map((e) => e.event)).not.toContain('presence.changed');
    expect(quiet.events.map((e) => e.event)).not.toContain('status.changed');

    // Cursors are SHARED: the quieted frame still consumed an id, and the frame
    // the quiet client did receive carries exactly the id it would have anyway.
    expect(quietMessage.id).toBe(loudMessage.id);
    expect(Number(loudStatus.id)).toBeLessThan(Number(loudMessage.id));
  });

  it('journals quieted frames anyway — a later unfiltered read sees them, cursors intact', async () => {
    const quiet = track(
      await openSse(base, '/api/v1/me/events?quiet=presence,status', alice.token),
    );
    await ownerStatus('deploying');
    await send('hello');
    await quiet.waitFor((e) => e.event === 'message.new');

    const full = await log('since=0');
    expect(full.events.map((e) => e.event)).toContain('status.changed');
    const message = full.events.find((e) => e.event === 'message.new')!;
    expect(message).toBeDefined();
    // The quiet live client saw the same id for the frame it DID receive.
    expect(String(message.id)).toBe(quiet.events.find((e) => e.event === 'message.new')!.id);
  });

  it('honors ?quiet= on ?since= replay, so a resume shows what the live stream would have', async () => {
    await ownerStatus('deploying');
    await send('hello');

    const replay = track(
      await openSse(base, '/api/v1/me/events?since=0&quiet=presence,status', alice.token),
    );
    const message = await replay.waitFor((e) => e.event === 'message.new');
    expect(replay.events.map((e) => e.event)).not.toContain('status.changed');
    expect(replay.events.map((e) => e.event)).not.toContain('presence.changed');

    // The id space is the journal's, unchanged by the filter.
    const full = await log('since=0');
    expect(message.id).toBe(String(full.events.find((e) => e.event === 'message.new')!.id));
  });

  it('applies the same ?quiet= to /me/events/log — latest and ids come from the FULL journal', async () => {
    await ownerStatus('deploying');
    await send('hello');

    const full = await log('since=0');
    const filtered = await log('since=0&quiet=presence,status');
    expect(full.events.map((e) => e.event)).toContain('status.changed');
    expect(filtered.events.map((e) => e.event)).not.toContain('status.changed');
    expect(filtered.events.map((e) => e.event)).not.toContain('presence.changed');
    expect(filtered.events.map((e) => e.event)).toContain('message.new');
    // `latest` is computed from the UNFILTERED journal (the cursor space is
    // shared; only what is HANDED BACK is filtered).
    expect(filtered.latest).toBe(full.latest);
    expect(filtered.events.find((e) => e.event === 'message.new')!.id).toBe(
      full.events.find((e) => e.event === 'message.new')!.id,
    );
  });

  it('ignores unknown ?quiet= tokens — never a 400', async () => {
    const stream = track(
      await openSse(base, '/api/v1/me/events?quiet=telepathy,,status', alice.token),
    );
    await ownerStatus('deploying');
    await send('hello');
    await stream.waitFor((e) => e.event === 'message.new');
    expect(stream.events.map((e) => e.event)).not.toContain('status.changed');

    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/events/log?since=0&quiet=telepathy',
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().events as Array<{ event: string }>).map((e) => e.event)).toContain(
      'status.changed',
    );
  });
});
