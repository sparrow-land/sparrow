import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { HINT_TEXT_MAX, type Hint } from '@sparrow/common-types';
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
    // The verbatim text conveyed to the agent rides the entry's hint payload.
    expect(entries[0]!.hint).toEqual({ id: firedId, text: first.hints![0]!.text });

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
