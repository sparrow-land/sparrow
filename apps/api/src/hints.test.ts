import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { HINT_TEXT_MAX, VOICE_REGISTER_NOTE, type Hint } from '@sparrow/common-types';
import { TRIGGERS } from './hints.js';
import {
  makeTestServer,
  auth,
  signup,
  firstOrgId,
  createRoom,
  makeAgent,
  type TestServer,
} from './test-helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * THE PRINCIPLE: the right time to teach an agent is BETWEEN tasks, and the right
 * channel is one the agent CHOSE. So there are exactly two hinted surfaces here:
 * the PAUSE (`POST /me/inbox/pop` returning `{ item: null }`) and the ASK
 * (`GET /me/hints`). A send never carries hints; a pop that hands back WORK never
 * carries hints. These tests pin that contract trigger by trigger.
 */

/** A room with an owner (human) and an agent that has been added as a member. */
interface Fixture {
  ts: TestServer;
  ownerToken: string;
  orgId: string;
  roomId: string;
  agentId: string;
  agentKey: string;
}

async function setup(overrides = {}): Promise<Fixture> {
  const ts = await makeTestServer(overrides);
  const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Olive' });
  const orgId = await firstOrgId(ts.app, owner.token);
  const roomId = await createRoom(ts.app, owner.token, orgId, 'ops');
  const agent = await makeAgent(ts.app, owner.token, orgId, 'deploy-bot');
  // Add the agent to the room so it can send.
  const add = await ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/members`,
    headers: auth(owner.token),
    payload: { principal: agent.id },
  });
  if (add.statusCode !== 201) throw new Error(`add agent failed: ${add.body}`);
  return { ts, ownerToken: owner.token, orgId, roomId, agentId: agent.id, agentKey: agent.key };
}

/** Send a message as the agent; returns the parsed response body. */
async function sendAs(
  app: FastifyInstance,
  key: string,
  roomId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ hints?: Hint[]; unreadCount: number }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/messages`,
    headers: { ...auth(key), ...headers },
    payload: body,
  });
  if (res.statusCode !== 201) throw new Error(`send failed (${res.statusCode}): ${res.body}`);
  return res.json();
}

/** Pop the caller's unified inbox; returns the parsed body (`{ item, hints? }`). */
async function popAs(
  app: FastifyInstance,
  key: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ item: unknown; hints?: Hint[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/inbox/pop',
    headers: { ...auth(key), ...headers },
    payload: body,
  });
  if (res.statusCode !== 200) throw new Error(`pop failed (${res.statusCode}): ${res.body}`);
  return res.json();
}

/** The PAUSE: pop an inbox already known to be empty, asserting `item: null`. */
async function pause(
  app: FastifyInstance,
  key: string,
  headers: Record<string, string> = {},
): Promise<{ item: unknown; hints?: Hint[] }> {
  const body = await popAs(app, key, {}, headers);
  if (body.item !== null) throw new Error(`expected an empty pop, got ${JSON.stringify(body.item)}`);
  return body;
}

/** Owner posts a message into the room (fills the agent's inbox). */
async function ownerSays(fx: Fixture, body: string): Promise<void> {
  const res = await fx.ts.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${fx.roomId}/messages`,
    headers: auth(fx.ownerToken),
    payload: { body },
  });
  if (res.statusCode !== 201) throw new Error(`owner send failed: ${res.body}`);
}

/** Mark the agent online via a heartbeat presence mark (suppresses start-listening). */
async function goOnline(app: FastifyInstance, key: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/presence',
    headers: auth(key),
    payload: { ttlSeconds: 120 },
  });
  if (res.statusCode !== 200) throw new Error(`presence failed: ${res.body}`);
}

/** Hold a working status for the agent in a room (suppresses set-a-status). */
async function holdStatus(app: FastifyInstance, key: string, roomId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomId}/status`,
    headers: auth(key),
    payload: { state: 'working', note: 'busy' },
  });
  if (res.statusCode !== 200) throw new Error(`status failed: ${res.body}`);
}

/** Age every message + read receipt so nothing counts as RECENT_ACTIVITY_MS-recent. */
function ageAllActivity(dataDir: string, msAgo: number): void {
  const db = new Database(path.join(dataDir, 'sparrow.db'));
  const at = new Date(Date.now() - msAgo).toISOString();
  db.prepare('UPDATE messages SET created_at = ?').run(at);
  db.prepare('UPDATE message_recipients SET read_at = ? WHERE read_at IS NOT NULL').run(at);
  db.close();
}

const LONG_PLAIN = 'the deployment ran cleanly and here is a long plain summary '.repeat(6); // >300, no md

let fx: Fixture;
afterEach(async () => {
  await fx.ts.close();
});

describe('hints attach to the PAUSE only', () => {
  it('a send response NEVER carries hints — teaching must not interrupt work in flight', async () => {
    fx = await setup();
    // An offline agent's send would have fired start-listening on the old wiring.
    const body = await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'hi' });
    expect('hints' in body).toBe(false);
    // The very same lesson is waiting at the pause.
    const paused = await pause(fx.ts.app, fx.agentKey);
    expect(paused.hints![0]!.id).toBe('start-listening');
  });

  it('a pop that returns WORK carries no hints; the empty pop after the drain does', async () => {
    fx = await setup();
    await ownerSays(fx, 'please deploy');
    await goOnline(fx.ts.app, fx.agentKey);
    const work = await popAs(fx.ts.app, fx.agentKey);
    expect((work.item as { type: string }).type).toBe('chat.message');
    expect('hints' in work).toBe(false);
    // Drained → the pause. The agent just read a message and advertises no
    // status, so the rehomed set-a-status lands here.
    const paused = await pause(fx.ts.app, fx.agentKey);
    expect(paused.hints![0]!.id).toBe('set-a-status');
  });

  it('an EMAIL work item carries no hints either (the register lesson waits for the pause)', async () => {
    // Covered end-to-end in email-events.test.ts; here we pin the chat half of
    // the contract: no hinted surface other than `{ item: null }`.
    fx = await setup();
    await ownerSays(fx, 'one');
    await ownerSays(fx, 'two');
    await goOnline(fx.ts.app, fx.agentKey);
    expect('hints' in (await popAs(fx.ts.app, fx.agentKey))).toBe(false);
    expect('hints' in (await popAs(fx.ts.app, fx.agentKey))).toBe(false);
  });

  it('hints are ABSENT (not an empty array) when nothing fires — old-shape compatible', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey); // suppress start-listening
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId); // suppress set-a-status
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });
});

describe('hints engine — triggers at the pause', () => {
  it('start-listening fires for an offline agent, with an events docs URL + action', async () => {
    fx = await setup();
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints).toBeDefined();
    expect(body.hints![0]!.id).toBe('start-listening');
    expect(body.hints![0]!.action).toEqual({ method: 'GET', path: '/api/v1/me/events' });
    expect(body.hints![0]!.docs).toBe('https://sparrow.land/docs/api/me/events.md');
    // The turn-based half of the nudge must prescribe a WAKE mechanism, not a
    // bare presence heartbeat — heartbeating while unable to react is the state
    // that reads online and behaves deaf.
    expect(body.hints![0]!.text).toMatch(/turn-based/i);
    expect(body.hints![0]!.text).toContain('sparrow await');
    // A hint over HINT_TEXT_MAX is rejected client-side, failing the pop that
    // carried it — length is a hard contract, not a style note.
    expect(body.hints![0]!.text.length).toBeLessThanOrEqual(HINT_TEXT_MAX);
  });

  it('start-listening honors presence MARKS, not just streams (a turn-based agent mid-turn)', async () => {
    // `sparrow await` wakes a turn-based agent by EXITING, so while the agent
    // processes the item it holds NO stream and rides a heartbeat mark instead.
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey); // a MARK only — no events stream anywhere
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints?.[0]?.id).not.toBe('start-listening');
  });

  it('set-a-status fires at the pause after a recent READ, with no status advertised', async () => {
    fx = await setup();
    await ownerSays(fx, 'please deploy');
    await goOnline(fx.ts.app, fx.agentKey);
    await popAs(fx.ts.app, fx.agentKey); // the drain: sets read_at → recent activity
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints![0]!.id).toBe('set-a-status');
    // The pause framing teaches the built-in ack switch, on the pop route.
    expect(body.hints![0]!.action).toEqual({
      method: 'POST',
      path: '/api/v1/me/inbox/pop',
      exampleBody: { ack: true, note: 'working on your request' },
    });
    expect(body.hints![0]!.text).toContain('ack');
    expect(body.hints![0]!.docs).toBe('https://sparrow.land/docs/api/rooms/status.md');
  });

  it('set-a-status also counts a recent SEND as activity', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'on it' });
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints![0]!.id).toBe('set-a-status');
  });

  it('set-a-status does NOT fire for an idle agent that has done nothing recently', async () => {
    // The pause of an agent with no recent work is not a teaching moment for
    // statuses — there is no job to advertise.
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('set-a-status does NOT fire while a status is held, nor while offline', async () => {
    fx = await setup();
    // Offline: reachability (start-listening) is the lesson.
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'zero' });
    const offline = await pause(fx.ts.app, fx.agentKey);
    expect(offline.hints![0]!.id).toBe('start-listening');
    // Online with a held status: nothing to teach.
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'one' });
    const held = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in held).toBe(false);
  });

  it('set-a-status ignores STALE activity (older than the recent-activity window)', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'ages ago' });
    ageAllActivity(fx.ts.dataDir, 2 * 60 * 60 * 1000); // 2h > RECENT_ACTIVITY_MS
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('markdown-renders fires at the pause after a recent 3-send plain-text streak', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId); // suppress set-a-status
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints![0]!.id).toBe('markdown-renders');
  });

  it('markdown-renders does NOT fire on a STALE streak (the lesson has lost its referent)', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    ageAllActivity(fx.ts.dataDir, 2 * 60 * 60 * 1000);
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('markdown-renders does NOT fire when one of the three sends is formatted', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: `**bold** ${LONG_PLAIN}` });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('drain-your-inbox can no longer fire at a pop (unread is 0 there) — only via the ASK', async () => {
    fx = await setup();
    // Six, so the count is still ≥ the threshold after the pop consumes one.
    for (let i = 0; i < 6; i++) await ownerSays(fx, `owner ${i}`);
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId);
    // With a backlog the pop returns WORK — and work is never hinted.
    const work = await popAs(fx.ts.app, fx.agentKey);
    expect(work.item).not.toBeNull();
    expect('hints' in work).toBe(false);
    // The idle-and-curious moment the lesson serves: `sparrow tips`.
    const tips = await fx.ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hints',
      headers: auth(fx.agentKey),
    });
    expect((tips.json().hints as Hint[]).map((h) => h.id)).toContain('drain-your-inbox');
  });
});

describe('hints engine — cooldown, one-per-response, kill switches', () => {
  it('a fired hint re-fires at most once per 24h window', async () => {
    fx = await setup();
    const first = await pause(fx.ts.app, fx.agentKey);
    expect(first.hints![0]!.id).toBe('start-listening');
    // Immediately again — start-listening is on cooldown; the agent is still
    // OFFLINE so set-a-status stays dormant, and nothing else applies.
    const second = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in second).toBe(false);
  });

  it('every delivered hint lands on the agent timeline as a hint.delivered entry', async () => {
    fx = await setup();
    const first = await pause(fx.ts.app, fx.agentKey);
    const firedId = first.hints![0]!.id;

    const hintEntries = async () => {
      const res = await fx.ts.app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${fx.orgId}/agents/${fx.agentId}/activity`,
        headers: auth(fx.ownerToken),
      });
      if (res.statusCode !== 200) throw new Error(`activity failed: ${res.body}`);
      return (res.json().items as Array<Record<string, any>>).filter(
        (e) => e.type === 'hint.delivered',
      );
    };

    const entries = await hintEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.medium).toBe('system');
    expect(entries[0]!.agent.id).toBe(fx.agentId);
    // The platform is the actor, not any principal.
    expect(entries[0]!.actor.kind).toBe('system');
    expect(entries[0]!.actor.id).toBeNull();
    // The summary is the trigger's OWNER LABEL — a third-person sentence for
    // the human reader, not the agent-directed imperative.
    const trigger = TRIGGERS.find((t) => t.id === firedId)!;
    expect(entries[0]!.summary).toBe(trigger.ownerLabel);
    // The verbatim text conveyed to the agent rides the entry's hint payload,
    // now alongside the ledger link and the serve-time resolution.
    expect(entries[0]!.hint).toMatchObject({ id: firedId, text: first.hints![0]!.text });
    expect(entries[0]!.hint.deliveryId).toBeTypeOf('string');

    // A cooldown-suppressed pause delivers nothing → journals nothing.
    await pause(fx.ts.app, fx.agentKey);
    expect(await hintEntries()).toHaveLength(1);
  });

  it('at most ONE hint per response (priority = list order)', async () => {
    fx = await setup();
    // Online, statusless, freshly active AND riding a plain-text streak:
    // set-a-status AND markdown-renders both apply → only the higher priority.
    await goOnline(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    const res = await pause(fx.ts.app, fx.agentKey);
    expect(res.hints).toHaveLength(1);
    expect(res.hints![0]!.id).toBe('set-a-status');
  });

  it('the env kill-switch (hintsEnabled:false) suppresses all hints', async () => {
    fx = await setup({ hintsEnabled: false });
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('the X-Sparrow-No-Hints: 1 header suppresses hints for that request only', async () => {
    fx = await setup();
    const optedOut = await pause(fx.ts.app, fx.agentKey, { 'x-sparrow-no-hints': '1' });
    expect('hints' in optedOut).toBe(false);
    // A following request without the header still gets coached.
    const normal = await pause(fx.ts.app, fx.agentKey);
    expect(normal.hints![0]!.id).toBe('start-listening');
  });

  it('humans are never hinted', async () => {
    fx = await setup();
    // The owner (human, offline) pauses on an empty inbox — would trip
    // start-listening if humans were hinted.
    const res = await fx.ts.app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/pop',
      headers: auth(fx.ownerToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect('hints' in res.json()).toBe(false);
  });
});

describe('hints engine — level (off/aggressive) + meta-hint', () => {
  async function setLevel(app: FastifyInstance, key: string, level: string): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/hint-preferences',
      headers: auth(key),
      payload: { level },
    });
    if (res.statusCode !== 200) throw new Error(`set level failed: ${res.body}`);
  }

  /** Backdate a hint's delivery row via a second connection to the same DB. */
  function backdate(dataDir: string, agentId: string, hintId: string, msAgo: number): void {
    const db = new Database(path.join(dataDir, 'sparrow.db'));
    const at = new Date(Date.now() - msAgo).toISOString();
    db.prepare(
      `UPDATE hint_deliveries SET delivered_at = ? WHERE principal_type='agent' AND principal_id = ? AND hint_id = ?`,
    ).run(at, agentId, hintId);
    db.close();
  }

  it('level off suppresses all hints', async () => {
    fx = await setup();
    await setLevel(fx.ts.app, fx.agentKey, 'off');
    const body = await pause(fx.ts.app, fx.agentKey);
    expect('hints' in body).toBe(false);
  });

  it('level aggressive shortens the cooldown (~1h) — normal keeps 24h', async () => {
    fx = await setup();
    // Aggressive agent: fire, backdate 90 min, refire (90m > 1h window).
    await setLevel(fx.ts.app, fx.agentKey, 'aggressive');
    const first = await pause(fx.ts.app, fx.agentKey);
    expect(first.hints![0]!.id).toBe('start-listening');
    backdate(fx.ts.dataDir, fx.agentId, 'start-listening', 90 * 60 * 1000);
    const refire = await pause(fx.ts.app, fx.agentKey);
    expect(refire.hints![0]!.id).toBe('start-listening');

    // Normal agent: same 90-min gap stays within the 24h window → suppressed.
    const other = await makeAgent(fx.ts.app, fx.ownerToken, fx.orgId, 'other-bot');
    await fx.ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${fx.roomId}/members`,
      headers: auth(fx.ownerToken),
      payload: { principal: other.id },
    });
    const n1 = await pause(fx.ts.app, other.key);
    expect(n1.hints![0]!.id).toBe('start-listening');
    backdate(fx.ts.dataDir, other.id, 'start-listening', 90 * 60 * 1000);
    const n2 = await pause(fx.ts.app, other.key);
    expect('hints' in n2).toBe(false);
  });

  it('the control-your-hints meta-hint fires exactly once after the 3rd delivery', async () => {
    fx = await setup();
    // #1 start-listening (offline).
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('start-listening');
    // #2 set-a-status (now online, freshly active, still statusless).
    await goOnline(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: 'b' });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('set-a-status');
    // #3 refresh-your-role (the owner sets a role).
    await fx.ts.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${fx.agentId}`,
      headers: auth(fx.ownerToken),
      payload: { roleTitle: 'Ops' },
    });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('refresh-your-role');
    // 4th pause: 3 distinct hints delivered → the meta-hint fires (priority LAST).
    const meta = await pause(fx.ts.app, fx.agentKey);
    expect(meta.hints![0]!.id).toBe('control-your-hints');
    expect(meta.hints![0]!.action).toEqual({
      method: 'PUT',
      path: '/api/v1/me/hint-preferences',
      exampleBody: { level: 'normal' },
    });
    // It fires ONCE ever — a later eligible pause does not repeat it.
    const again = await pause(fx.ts.app, fx.agentKey);
    expect(again.hints?.[0]?.id).not.toBe('control-your-hints');
  });
});

/**
 * `GET /me/hints` — the ASK. An explicit question is not an interruption, so the
 * preview deliberately ignores every suppression that exists to protect work in
 * flight (cooldown, `permanent`, the `off` level, the no-hints header) and shows
 * EVERY applying lesson. It records nothing, so looking never costs a delivery.
 */
describe('GET /me/hints — the read-only tips view', () => {
  const tips = async (
    key: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; hints: Hint[] }> => {
    const res = await fx.ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hints',
      headers: { ...auth(key), ...headers },
    });
    return { status: res.statusCode, hints: (res.json().hints ?? []) as Hint[] };
  };

  it('returns EVERY applying hint, in priority order, with docs URLs', async () => {
    fx = await setup();
    for (let i = 0; i < 5; i++) await ownerSays(fx, `owner ${i}`);
    const { status, hints } = await tips(fx.agentKey);
    expect(status).toBe(200);
    expect(hints.map((h) => h.id)).toEqual(['start-listening', 'drain-your-inbox']);
    expect(hints[0]!.docs).toBe('https://sparrow.land/docs/api/me/events.md');
    expect(hints[1]!.docs).toBe('https://sparrow.land/docs/api/me/inbox.md');
  });

  it('always carries a `hints` array — empty when nothing applies', async () => {
    fx = await setup();
    await goOnline(fx.ts.app, fx.agentKey);
    await holdStatus(fx.ts.app, fx.agentKey, fx.roomId);
    const res = await fx.ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hints',
      headers: auth(fx.agentKey),
    });
    expect(res.json()).toEqual({ hints: [] });
  });

  it('records NOTHING — viewing tips never suppresses a real delivery', async () => {
    fx = await setup();
    expect((await tips(fx.agentKey)).hints.map((h) => h.id)).toEqual(['start-listening']);
    // No ledger row, no activity entry: the very next pause still delivers it.
    const paused = await pause(fx.ts.app, fx.agentKey);
    expect(paused.hints![0]!.id).toBe('start-listening');
    const activity = await fx.ts.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${fx.orgId}/agents/${fx.agentId}/activity`,
      headers: auth(fx.ownerToken),
    });
    expect(
      (activity.json().items as Array<Record<string, unknown>>).filter(
        (e) => e.type === 'hint.delivered',
      ),
    ).toHaveLength(1);
  });

  it('ignores the cooldown ledger — a just-delivered hint still shows in tips', async () => {
    fx = await setup();
    await pause(fx.ts.app, fx.agentKey); // delivers (and cools down) start-listening
    expect((await tips(fx.agentKey)).hints.map((h) => h.id)).toContain('start-listening');
  });

  it('ignores the `off` level and the X-Sparrow-No-Hints header — the agent is ASKING', async () => {
    fx = await setup();
    await fx.ts.app.inject({
      method: 'PUT',
      url: '/api/v1/me/hint-preferences',
      headers: auth(fx.agentKey),
      payload: { level: 'off' },
    });
    const { hints } = await tips(fx.agentKey, { 'x-sparrow-no-hints': '1' });
    expect(hints.map((h) => h.id)).toContain('start-listening');
  });

  it('honors the instance kill-switch only', async () => {
    fx = await setup({ hintsEnabled: false });
    expect((await tips(fx.agentKey)).hints).toEqual([]);
  });

  it('403s a human — hints are an agent surface', async () => {
    fx = await setup();
    const res = await fx.ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hints',
      headers: auth(fx.ownerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});

/**
 * `voice-is-a-different-register` — the spoken twin of the email register hint.
 *
 * A message carrying `origin: 'voice'` came out of hands-free mode: the human
 * DICTATED it and is sitting there listening, so whatever the agent writes back
 * is read aloud to them by a synthetic voice. A table, a fenced code block or a
 * 900-character essay is unlistenable. The trigger derives that miss from the
 * db at the PAUSE (never on the send it judges): the agent's most recent OWN
 * reply to a voice-origin message, inside `RECENT_ACTIVITY_MS`, is not
 * speakable.
 */
describe('voice-is-a-different-register', () => {
  /** The owner speaks: a message with `origin: 'voice'`, returning its id. */
  async function ownerSpeaks(f: Fixture, body: string): Promise<string> {
    const res = await f.ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${f.roomId}/messages`,
      headers: auth(f.ownerToken),
      payload: { body, origin: 'voice' },
    });
    if (res.statusCode !== 201) throw new Error(`voice send failed: ${res.body}`);
    return res.json().message.id as string;
  }

  /** Quiet the higher-priority triggers so the voice hint is what we observe. */
  async function quiet(f: Fixture): Promise<void> {
    await goOnline(f.ts.app, f.agentKey);
    await holdStatus(f.ts.app, f.agentKey, f.roomId);
  }

  const TABLE_REPLY = 'Here you go:\n\n| env | status |\n| --- | --- |\n| prd | green |\n';
  const CODE_REPLY = 'Run this:\n\n```sh\nsparrow pop\n```\n';
  const LONG_REPLY = 'x'.repeat(601);

  it('fires when the reply to a spoken message carries a markdown TABLE', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how is prod looking');
    await popAs(fx.ts.app, fx.agentKey); // drain, so the pause is empty
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY, inReplyTo: spoken });
    const body = await pause(fx.ts.app, fx.agentKey);
    const hint = body.hints![0]!;
    expect(hint.id).toBe('voice-is-a-different-register');
    expect(hint.docs).toBe('https://sparrow.land/docs/api/voice.md');
    expect(hint.text).toMatch(/hear/i);
    expect(hint.text).toContain('listening, not reading');
    expect(hint.text.length).toBeLessThanOrEqual(HINT_TEXT_MAX);
    expect(hint.action!.method).toBe('POST');
    expect(hint.action!.path).toBe(`/api/v1/rooms/${fx.roomId}/messages`);
    expect(hint.action!.exampleBody).toEqual({ text: '…', inReplyTo: '…' });
  });

  it('fires on a FENCED CODE BLOCK reply, and on an over-long one', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how do I drain');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: CODE_REPLY, inReplyTo: spoken });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe(
      'voice-is-a-different-register',
    );

    // A second agent, same instance, replying at length instead of in code.
    const other = await makeAgent(fx.ts.app, fx.ownerToken, fx.orgId, 'other-bot');
    await fx.ts.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${fx.roomId}/members`,
      headers: auth(fx.ownerToken),
      payload: { principal: other.id },
    });
    await goOnline(fx.ts.app, other.key);
    await holdStatus(fx.ts.app, other.key, fx.roomId);
    const spoken2 = await ownerSpeaks(fx, 'and the rollout');
    // Drain both messages this agent can see, so its pause is genuinely empty.
    while ((await popAs(fx.ts.app, other.key)).item !== null) {
      /* drain */
    }
    await sendAs(fx.ts.app, other.key, fx.roomId, { body: LONG_REPLY, inReplyTo: spoken2 });
    expect((await pause(fx.ts.app, other.key)).hints![0]!.id).toBe(
      'voice-is-a-different-register',
    );
  });

  it('counts an UNTHREADED reply — the next thing the agent said in that room', async () => {
    // Nothing forces `inReplyTo`, so the trigger falls back to conversational
    // adjacency: the newest message in the room before the agent's own send.
    fx = await setup();
    await quiet(fx);
    await ownerSpeaks(fx, 'read me the deploy table');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe(
      'voice-is-a-different-register',
    );
  });

  it('does NOT fire when the reply to a spoken message is speakable', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how is prod looking');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, {
      body: 'Production is green. The last deploy finished eleven minutes ago.',
      inReplyTo: spoken,
    });
    expect('hints' in (await pause(fx.ts.app, fx.agentKey))).toBe(false);
  });

  it('does NOT fire for a long, table-laden reply to a TYPED message', async () => {
    // The register lesson is about the SENDER'S channel, not the agent's style —
    // `markdown-renders` is the hint for chat prose, and it must not be
    // shadowed by a voice lesson with no voice in it.
    fx = await setup();
    await quiet(fx);
    await ownerSays(fx, 'how is prod looking'); // typed: origin null
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY });
    const body = await pause(fx.ts.app, fx.agentKey);
    expect(body.hints?.[0]?.id).not.toBe('voice-is-a-different-register');
  });

  it('does NOT fire on a STALE exchange (the lesson has lost its referent)', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how is prod looking');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY, inReplyTo: spoken });
    ageAllActivity(fx.ts.dataDir, 2 * 60 * 60 * 1000);
    expect('hints' in (await pause(fx.ts.app, fx.agentKey))).toBe(false);
  });

  it('fires ONCE ever — the register lesson is permanent, like its email sibling', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how is prod looking');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY, inReplyTo: spoken });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe(
      'voice-is-a-different-register',
    );
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY, inReplyTo: spoken });
    const again = await pause(fx.ts.app, fx.agentKey);
    expect(again.hints?.[0]?.id).not.toBe('voice-is-a-different-register');
  });

  it('sits right after the email register hint in priority order', async () => {
    const ids = TRIGGERS.map((t) => t.id);
    expect(ids.indexOf('voice-is-a-different-register')).toBe(
      ids.indexOf('email-is-a-different-register') + 1,
    );
    const trigger = TRIGGERS.find((t) => t.id === 'voice-is-a-different-register')!;
    expect(trigger.permanent).toBe(true);
    expect(trigger.docs).toBe('voice');
  });

  it('carries the canonical VOICE_REGISTER_NOTE verbatim (no drift)', async () => {
    fx = await setup();
    await quiet(fx);
    const spoken = await ownerSpeaks(fx, 'how is prod looking');
    await popAs(fx.ts.app, fx.agentKey);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: TABLE_REPLY, inReplyTo: spoken });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.text).toContain(VOICE_REGISTER_NOTE);
  });
});

/* ================================================================== *
 * Payload-keyed cooldown + server-checkable resolution
 * ================================================================== */

/** `X-Sparrow-Client` headers for a given CLI version. */
const CLI = (version: string): Record<string, string> => ({
  'x-sparrow-client': `sparrow-cli/${version}`,
});

/** Open the test server's DB on a second connection (the tests' only peek). */
function openDb(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'sparrow.db'));
}

/** One row of the append-only delivery ledger. */
interface LedgerRow {
  id: string | null;
  payload_key: string;
  delivered_at: string;
  resolved_at: string | null;
}

/**
 * EVERY delivery event for one (agent, ledger key), oldest first. The ledger is
 * append-only — one row per telling — so a test that asks about "the row" has to
 * say which one.
 */
function deliveryRows(dataDir: string, agentId: string, hintId: string): LedgerRow[] {
  const db = openDb(dataDir);
  const rows = db
    .prepare(
      `SELECT id, payload_key, delivered_at, resolved_at FROM hint_deliveries
        WHERE principal_type='agent' AND principal_id = ? AND hint_id = ?
        ORDER BY delivered_at ASC, rowid ASC`,
    )
    .all(agentId, hintId) as LedgerRow[];
  db.close();
  return rows;
}

/** The MOST RECENT delivery event for one (agent, ledger key) — what the cooldown reads. */
function deliveryRow(dataDir: string, agentId: string, hintId: string): LedgerRow {
  const rows = deliveryRows(dataDir, agentId, hintId);
  return rows[rows.length - 1]!;
}

/**
 * Rewrite ONE ledger row's `resolved_at` by id. Used to plant a distinctive
 * historical timestamp so "the old entry still reads its OWN resolution" cannot
 * be satisfied by a coincidental same-millisecond re-stamp.
 */
function setResolvedAt(dataDir: string, deliveryId: string, at: string): void {
  const db = openDb(dataDir);
  db.prepare('UPDATE hint_deliveries SET resolved_at = ? WHERE id = ?').run(at, deliveryId);
  db.close();
}

/** Force every delivery event for one (agent, ledger key) to the same instant. */
function collapseDeliveredAt(dataDir: string, agentId: string, hintId: string, at: string): void {
  const db = openDb(dataDir);
  db.prepare(
    `UPDATE hint_deliveries SET delivered_at = ?
      WHERE principal_type='agent' AND principal_id = ? AND hint_id = ?`,
  ).run(at, agentId, hintId);
  db.close();
}

/** The agent row's presence/version stamps. */
function agentStamps(
  dataDir: string,
  agentId: string,
): { last_seen_at: string | null; last_client_version: string | null } {
  const db = openDb(dataDir);
  const row = db
    .prepare('SELECT last_seen_at, last_client_version FROM agents WHERE id = ?')
    .get(agentId) as any;
  db.close();
  return row;
}

/** Rewrite a ledger row's payload key — simulates a row written before the column. */
function setPayloadKey(dataDir: string, agentId: string, hintId: string, key: string): void {
  const db = openDb(dataDir);
  db.prepare(
    `UPDATE hint_deliveries SET payload_key = ?
      WHERE principal_type='agent' AND principal_id = ? AND hint_id = ?`,
  ).run(key, agentId, hintId);
  db.close();
}

/** The agent's `hint.delivered` entries, as the OWNER reads them off the route. */
async function hintEntries(f: Fixture): Promise<any[]> {
  const res = await f.ts.app.inject({
    method: 'GET',
    url: `/api/v1/orgs/${f.orgId}/agents/${f.agentId}/activity`,
    headers: auth(f.ownerToken),
  });
  if (res.statusCode !== 200) throw new Error(`activity failed: ${res.body}`);
  return (res.json().items as any[]).filter((e) => e.type === 'hint.delivered');
}

/** A pause with the upgrade hint's two higher-priority rivals suppressed. */
async function quietOnline(f: Fixture): Promise<void> {
  await goOnline(f.ts.app, f.agentKey);
  await holdStatus(f.ts.app, f.agentKey, f.roomId);
}

describe('payload-keyed cooldown — a hint whose MESSAGE changed re-teaches', () => {
  it('a changed payload re-fires INSIDE the cooldown window', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    const first = await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    expect(first.hints![0]!.id).toBe('upgrade-your-cli');
    expect(first.hints![0]!.text).toContain('0.1.25');
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').payload_key).toBe('0.1.25');

    // Same recommendation, minutes later: nothing new to say → still muted.
    expect('hints' in (await pause(fx.ts.app, fx.agentKey, CLI('0.1.20')))).toBe(false);

    // The operator moves the floor. The hint now SAYS something different, so
    // the ledger must not mute it — the real defect this fixes (0.1.25 → 0.1.30
    // within hours, and the agent never learned).
    fx.ts.config.clientRecommendedVersion = '0.1.30';
    const third = await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    expect(third.hints![0]!.id).toBe('upgrade-your-cli');
    expect(third.hints![0]!.text).toContain('0.1.30');
    // The re-fire records the NEW key, so the window restarts against it.
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').payload_key).toBe('0.1.30');
    expect('hints' in (await pause(fx.ts.app, fx.agentKey, CLI('0.1.20')))).toBe(false);
  });

  it('a trigger with no payloadKey keys on the id alone — exactly today’s behavior', async () => {
    fx = await setup();
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('start-listening');
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').payload_key).toBe('');
    expect('hints' in (await pause(fx.ts.app, fx.agentKey))).toBe(false);
  });

  it('a LEGACY row (payload key written as empty) suppresses just as it always did', async () => {
    fx = await setup();
    await pause(fx.ts.app, fx.agentKey);
    // A row written by a build that predates the column reads as ''.
    setPayloadKey(fx.ts.dataDir, fx.agentId, 'start-listening', '');
    expect('hints' in (await pause(fx.ts.app, fx.agentKey))).toBe(false);
  });
});

describe('hint resolution — the server checks, the agent never self-reports', () => {
  it('stamps the agent’s lastClientVersion from X-Sparrow-Client, alongside lastSeenAt', async () => {
    fx = await setup();
    expect(agentStamps(fx.ts.dataDir, fx.agentId).last_client_version).toBeNull();
    await pause(fx.ts.app, fx.agentKey, CLI('0.9.9'));
    const stamps = agentStamps(fx.ts.dataDir, fx.agentId);
    expect(stamps.last_client_version).toBe('0.9.9');
    expect(stamps.last_seen_at).not.toBeNull();
    // A header-less call leaves the last known version alone rather than erasing it.
    await pause(fx.ts.app, fx.agentKey);
    expect(agentStamps(fx.ts.dataDir, fx.agentId).last_client_version).toBe('0.9.9');
  });

  it('stamps resolvedAt at a LATER pause, once the taught condition cleared', async () => {
    fx = await setup();
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('start-listening');
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').resolved_at).toBeNull();
    // The agent did the thing: it is now reachable.
    await goOnline(fx.ts.app, fx.agentKey);
    await pause(fx.ts.app, fx.agentKey);
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').resolved_at).not.toBeNull();
  });

  it('upgrade-your-cli resolves once the agent CALLS IN at the recommended version', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').resolved_at).toBeNull();
    // Still behind → still unresolved.
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.24'));
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').resolved_at).toBeNull();
    // Upgraded: the next call identifies at the floor.
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.25'));
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').resolved_at).not.toBeNull();
  });

  it('GET /me/hints (the ASK) stamps resolutions too, while still recording no delivery', async () => {
    fx = await setup();
    await pause(fx.ts.app, fx.agentKey); // start-listening delivered
    await goOnline(fx.ts.app, fx.agentKey);
    const res = await fx.ts.app.inject({
      method: 'GET',
      url: '/api/v1/me/hints',
      headers: auth(fx.agentKey),
    });
    expect(res.statusCode).toBe(200);
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').resolved_at).not.toBeNull();
    // …and the tips view still wrote no new ledger row.
    expect(await hintEntries(fx)).toHaveLength(1);
  });
});

describe('hint resolution on the wire — decorated at SERVE time, never stored', () => {
  it('carries the deliveryId and flips unresolved → resolved on a later read', async () => {
    fx = await setup();
    await pause(fx.ts.app, fx.agentKey); // start-listening (the agent is offline)
    const before = (await hintEntries(fx))[0]!;
    expect(before.hint.id).toBe('start-listening');
    expect(before.hint.deliveryId).toBe(
      deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').id,
    );
    expect(before.hint.resolution).toEqual({ state: 'unresolved' });

    // The agent opens a stream / marks presence: the condition cleared. The read
    // evaluates and stamps — no stored entry is ever mutated.
    await goOnline(fx.ts.app, fx.agentKey);
    const after = (await hintEntries(fx))[0]!;
    expect(after.hint.resolution.state).toBe('resolved');
    expect(after.hint.resolution.resolvedAt).toBe(
      deliveryRow(fx.ts.dataDir, fx.agentId, 'start-listening').resolved_at,
    );
    // Stored columns untouched: only id + text were ever written.
    const db = openDb(fx.ts.dataDir);
    const stored = db
      .prepare("SELECT hint_id, hint_text FROM activity_entries WHERE type='hint.delivered'")
      .all() as any[];
    db.close();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hint_id).toBe('start-listening');
  });

  it('a trigger with no honest check reads `unknown` — never a guess', async () => {
    fx = await setup();
    await quietOnline(fx);
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    await sendAs(fx.ts.app, fx.agentKey, fx.roomId, { body: LONG_PLAIN });
    expect((await pause(fx.ts.app, fx.agentKey)).hints![0]!.id).toBe('markdown-renders');
    const entry = (await hintEntries(fx)).find((e) => e.hint.id === 'markdown-renders')!;
    expect(entry.hint.deliveryId).toBeTypeOf('string');
    expect(entry.hint.resolution).toEqual({ state: 'unknown' });
  });

  it('a LEGACY entry with no deliveryId reads `unknown`', async () => {
    fx = await setup();
    const db = openDb(fx.ts.dataDir);
    const owner = db
      .prepare('SELECT owner_human_id FROM agents WHERE id = ?')
      .get(fx.agentId) as { owner_human_id: string };
    db.prepare(
      `INSERT INTO activity_entries
        (id, org_id, agent_id, owner_human_id, medium, type, actor_kind, actor_label,
         summary, hint_id, hint_text, created_at)
       VALUES (?,?,?,?,'system','hint.delivered','system','sparrow',?,?,?,?)`,
    ).run(
      'act_legacyhintrow000000000',
      fx.orgId,
      fx.agentId,
      owner.owner_human_id,
      'Sparrow hinted the agent to open an events stream so it stays reachable.',
      'start-listening',
      'you look offline',
      new Date().toISOString(),
    );
    db.close();
    const entry = (await hintEntries(fx))[0]!;
    expect(entry.hint).toEqual({
      id: 'start-listening',
      text: 'you look offline',
      resolution: { state: 'unknown' },
    });
  });
});

/* ================================================================== *
 * The ledger is APPEND-ONLY — one row per delivery EVENT
 * ================================================================== */

describe('the delivery ledger is append-only — a journaled entry never changes its answer', () => {
  /**
   * THE HEADLINE. A timeline is a journal: an entry that was true when it was
   * written must stay true. The old ledger kept ONE row per (principal, hint)
   * and rewrote it on every re-fire, so a second telling silently un-resolved
   * the first entry and then lent it the SECOND telling's resolution — a past,
   * genuinely-finished event reading first "not yet" and then "done" with a
   * duration measured from the wrong lesson. A journal whose past entries mutate
   * is worse than no badge at all.
   */
  it('a re-fire neither un-resolves the EARLIER entry nor lends it the later resolution', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);

    // T1 — the hint fires against the 0.1.25 floor.
    expect((await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'))).hints![0]!.id).toBe(
      'upgrade-your-cli',
    );
    const first = deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(first).toHaveLength(1);
    const idA = first[0]!.id!;
    const entryOf = async (id: string): Promise<any> =>
      (await hintEntries(fx)).find((e) => e.hint.deliveryId === id)!;
    expect((await entryOf(idA)).hint.resolution).toEqual({ state: 'unresolved' });

    // T2 — the agent upgrades: it calls in at the floor it was told about. Plant
    // a distinctive historical stamp, so the assertions below cannot be
    // satisfied by a coincidental same-millisecond re-stamp.
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.25'));
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').resolved_at).not.toBeNull();
    const RESOLVED_AT_T2 = '2026-01-01T00:00:00.000Z';
    setResolvedAt(fx.ts.dataDir, idA, RESOLVED_AT_T2);
    expect((await entryOf(idA)).hint.resolution).toEqual({
      state: 'resolved',
      resolvedAt: RESOLVED_AT_T2,
    });

    // T3 — the operator raises the floor. The hint now SAYS something new, so it
    // re-fires — appending a second row with its own id, not rewriting the first.
    fx.ts.config.clientRecommendedVersion = '0.1.30';
    expect((await pause(fx.ts.app, fx.agentKey, CLI('0.1.25'))).hints![0]!.id).toBe(
      'upgrade-your-cli',
    );
    const rows = deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(rows).toHaveLength(2);
    const idB = rows[1]!.id!;
    expect(idB).not.toBe(idA);
    // The EARLIER entry is untouched: still resolved, still at ITS OWN timestamp.
    expect((await entryOf(idA)).hint.resolution).toEqual({
      state: 'resolved',
      resolvedAt: RESOLVED_AT_T2,
    });
    // …and the NEW entry answers for itself: the agent is behind the new floor.
    expect((await entryOf(idB)).hint.resolution).toEqual({ state: 'unresolved' });

    // T4 — the agent upgrades again. Only the SECOND delivery resolves; the
    // first keeps the resolution it earned instead of borrowing this one.
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.30'));
    expect((await entryOf(idA)).hint.resolution).toEqual({
      state: 'resolved',
      resolvedAt: RESOLVED_AT_T2,
    });
    const later = (await entryOf(idB)).hint.resolution;
    expect(later.state).toBe('resolved');
    expect(later.resolvedAt).not.toBe(RESOLVED_AT_T2);
  });

  it('a re-fire APPENDS a row — two delivery events, two distinct ids, one mutated row', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const before = deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(before).toHaveLength(1);

    fx.ts.config.clientRecommendedVersion = '0.1.30';
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const after = deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.id)).size).toBe(2);
    expect(after.every((r) => typeof r.id === 'string' && r.id.startsWith('hdl_'))).toBe(true);
    // The first row is exactly as it was written: what it said, and when.
    expect(after[0]!.payload_key).toBe('0.1.25');
    expect(after[0]!.delivered_at).toBe(before[0]!.delivered_at);
    expect(after[1]!.payload_key).toBe('0.1.30');
  });

  it('the cooldown asks the MOST RECENT row, not the first one ever written', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    fx.ts.config.clientRecommendedVersion = '0.1.30';
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    expect(deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli')).toHaveLength(2);
    // The newest row says '0.1.30', which is still what the hint would say — so
    // the cooldown mutes. Reading the OLDEST row ('0.1.25') would re-fire forever.
    expect('hints' in (await pause(fx.ts.app, fx.agentKey, CLI('0.1.20')))).toBe(false);
    expect(deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli')).toHaveLength(2);
  });

  it('ties on delivered_at break by insertion order — the newest row still wins', async () => {
    // Two deliveries can share an ISO millisecond (tests do it routinely, and a
    // busy instance can too), so "most recent" must not be left to chance.
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    fx.ts.config.clientRecommendedVersion = '0.1.30';
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    collapseDeliveredAt(
      fx.ts.dataDir,
      fx.agentId,
      'upgrade-your-cli',
      new Date().toISOString(),
    );
    // Both rows now carry the same instant. The LAST one inserted is the telling
    // that happened, so its key ('0.1.30') is the one the cooldown compares.
    expect('hints' in (await pause(fx.ts.app, fx.agentKey, CLI('0.1.20')))).toBe(false);
  });
});

/* ================================================================== *
 * Resolution is judged against WHAT THE DELIVERY ASKED FOR
 * ================================================================== */

describe('resolution judges each delivery against its own stored target', () => {
  it('a delivery resolves when the agent reaches the version IT named, even after the floor moved on', async () => {
    // The failure this pins: told "upgrade to 0.1.32", the agent does exactly
    // that — but the operator has since moved the floor to 0.1.33, so comparing
    // against CURRENT config leaves the entry reading "not yet", possibly
    // forever, for an agent that obeyed.
    fx = await setup({ clientRecommendedVersion: '0.1.32' });
    await quietOnline(fx);
    expect((await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'))).hints![0]!.id).toBe(
      'upgrade-your-cli',
    );
    const asked = deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(asked.payload_key).toBe('0.1.32');
    const id = asked.id!;

    fx.ts.config.clientRecommendedVersion = '0.1.33';
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.32'));

    const entry = (await hintEntries(fx)).find((e) => e.hint.deliveryId === id)!;
    expect(entry.hint.resolution.state).toBe('resolved');
  });

  it('each delivery is judged independently — an earlier target met, a later one not yet', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.32' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const idA = deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').id!;
    // The agent reaches A's target; the floor then moves and the hint re-fires.
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.32'));
    fx.ts.config.clientRecommendedVersion = '0.1.40';
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.32'));
    const rows = deliveryRows(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli');
    expect(rows).toHaveLength(2);
    const idB = rows[1]!.id!;

    const entries = await hintEntries(fx);
    expect(entries.find((e) => e.hint.deliveryId === idA)!.hint.resolution.state).toBe('resolved');
    expect(entries.find((e) => e.hint.deliveryId === idB)!.hint.resolution).toEqual({
      state: 'unresolved',
    });
  });
});

/* ================================================================== *
 * Abstention is a STATE, not a verdict
 * ================================================================== */

describe('a check that cannot judge reads `unknown` — never "not yet"', () => {
  it('an agent that has never identified its client reads unknown, not unresolved', async () => {
    // `upgrade-your-cli` fires off the request's X-Sparrow-Client header, so a
    // delivery can exist while `agents.last_client_version` is still null (the
    // header-carrying request is not the one that stamped it — e.g. the stamp
    // was cleared, or the hint came from a differently-identified call). The
    // server then has NO IDEA whether the agent upgraded; saying "not yet"
    // would be an accusation it cannot support.
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const id = deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').id!;
    const db = openDb(fx.ts.dataDir);
    db.prepare('UPDATE agents SET last_client_version = NULL WHERE id = ?').run(fx.agentId);
    db.close();
    const entry = (await hintEntries(fx)).find((e) => e.hint.deliveryId === id)!;
    expect(entry.hint.resolution).toEqual({ state: 'unknown' });
  });

  it('an UNPARSEABLE reported version reads unknown, not unresolved', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const id = deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').id!;
    const db = openDb(fx.ts.dataDir);
    db.prepare('UPDATE agents SET last_client_version = ? WHERE id = ?').run('nightly', fx.agentId);
    db.close();
    const entry = (await hintEntries(fx)).find((e) => e.hint.deliveryId === id)!;
    expect(entry.hint.resolution).toEqual({ state: 'unknown' });
  });

  it('a LEGACY delivery with no stored target abstains rather than falling back to current config', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const id = deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').id!;
    // A row written before payload keys existed carries ''. There is no target
    // to judge against, and today's floor is not what that delivery asked for.
    setPayloadKey(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli', '');
    const db = openDb(fx.ts.dataDir);
    db.prepare('UPDATE agents SET last_client_version = ? WHERE id = ?').run('0.9.9', fx.agentId);
    db.close();
    const entry = (await hintEntries(fx)).find((e) => e.hint.deliveryId === id)!;
    expect(entry.hint.resolution).toEqual({ state: 'unknown' });
  });

  it('an abstention is never STAMPED — the ledger row stays open for a real answer', async () => {
    fx = await setup({ clientRecommendedVersion: '0.1.25' });
    await quietOnline(fx);
    await pause(fx.ts.app, fx.agentKey, CLI('0.1.20'));
    const db = openDb(fx.ts.dataDir);
    db.prepare('UPDATE agents SET last_client_version = NULL WHERE id = ?').run(fx.agentId);
    db.close();
    await pause(fx.ts.app, fx.agentKey); // the engine runs; nothing to conclude
    expect(deliveryRow(fx.ts.dataDir, fx.agentId, 'upgrade-your-cli').resolved_at).toBeNull();
  });
});
