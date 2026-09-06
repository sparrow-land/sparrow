/**
 * Regression: a per-profile persisted `/me/events` cursor that OUTLIVES a
 * database/journal wipe (or a re-enrollment) must SELF-HEAL, not silently kill
 * the live stream.
 *
 * Prod incident (2026-09-01): a profile's `state.json` held `lastEventId: 2634`
 * from the pre-wipe DB; the fresh journal's newest id was ~115. Every live frame
 * (fresh, LOW ids) was filtered by the client's `seen(id) = id <= lastId` gate as
 * "already surfaced" → the agent's live stream looked dead, and the reconcile poll
 * (`since=2634` → empty, no pruned-mark gap) could never rescue it.
 *
 * The fix pairs a SERVER signal (a `since` ahead of the journal's newest id is a
 * gap, on both `/me/events` replay.gap — carrying `latest` — and `/me/events/log`
 * gap:true+latest) with a CLIENT heal: watch/loop adopt the server's `latest` when
 * their cursor is beyond it, CLEAR the cursor when a pre-heal server sends no
 * `latest` at all (never keep a cursor the server just declared unreachable), say
 * so ONCE per gap in one actionable line, and — loop — drain the inbox. A cursor
 * is additionally scoped to the credential identity that earned it, so a
 * re-enrollment under a reused profile name starts fresh instead of inheriting a
 * dead cursor.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { runCli, type CliIO } from './index.js';
import { eventCursorIdentity } from './state.js';

/**
 * Isolated loop-state dir for every CLI run in this file. `watch`/`await`/`loop`
 * write their listener kind into `<state>/heartbeat`; without this the suite
 * stamps the developer's real ~/.sparrow/heartbeat with `watch`, which the
 * Stop hook then (correctly) blocks on.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-state-'));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SSE_HEAD = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

const sampleRoom = {
  id: 'room_dm',
  name: '',
  orgId: 'org_a',
  kind: 'dm',
  counterpart: { type: 'human', id: 'usr_o', displayName: 'Owner' },
};
const messageNewData = (preview: string): unknown => ({
  room: sampleRoom,
  messageId: 'msg_x',
  from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
  preview,
  kind: 'dm',
});
const sampleMessage = (body: string): unknown => ({
  id: 'msg_gap',
  from: { id: 'mem_owner', kind: 'human', displayName: 'Owner' },
  to: [{ id: 'mem_bot', kind: 'agent', displayName: 'bot' }],
  kind: 'dm',
  subject: null,
  body,
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-09-01T00:00:00Z',
});

interface JournalEntry {
  id: number;
  event: string;
  data: unknown;
}

interface Upstream {
  port: number;
  journal: JournalEntry[];
  /** Work items `POST /me/inbox/pop` hands out, oldest-first (loop's drain). */
  inbox: unknown[];
  /** Every `?since=` the SSE stream was opened with, in order. */
  streamSince: Array<number | undefined>;
  pops: number;
  pushMessage(id: number, preview: string): void;
  close(): Promise<void>;
}

const sinceParam = (u: string): string | null => new URL(u, 'http://x').searchParams.get('since');
const sinceOf = (u: string): number => Number(sinceParam(u) ?? '0');

/**
 * A minimal upstream mirroring the REAL server's stale-cursor semantics: a `since`
 * GREATER than the newest journal id is a generation mismatch → the log read flags
 * gap:true (+ real latest), and the SSE stream emits a structural `replay.gap`
 * (carrying latest) before going live.
 *
 * `carryLatest: false` models a PRE-HEAL server (v4.0): it still signals the gap
 * but its `replay.gap` frame has no `latest` for the client to adopt.
 */
async function startUpstream(opts?: {
  carryLatest?: boolean;
  /**
   * The principal's pruned high-water mark: a `since` BELOW it is rule (1) of the
   * real server's `hasGap` — retention lost events the client never saw.
   */
  prunedMark?: number;
  /**
   * The newest journaled id when it is NOT replayable to this subscriber (the
   * production shape: a day of presence/status churn the `?quiet=` filter drops
   * server-side still advances the journal, but never reaches the client).
   */
  unreplayableLatest?: number;
}): Promise<Upstream> {
  const carryLatest = opts?.carryLatest ?? true;
  const prunedMark = opts?.prunedMark ?? 0;
  const journal: JournalEntry[] = [];
  const inbox: unknown[] = [];
  const streamSince: Array<number | undefined> = [];
  const beats = new Set<NodeJS.Timeout>();
  let activeSse: http.ServerResponse | undefined;
  let pops = 0;
  const latestOf = (): number =>
    Math.max(journal.length ? journal[journal.length - 1]!.id : 0, opts?.unreplayableLatest ?? 0);
  // Mirrors `EventJournal.hasGap`: (1) pruned — an event above `since` is gone;
  // (2) generation mismatch — `since` is beyond the newest id.
  const hasGap = (since: number): boolean => since < prunedMark || since > latestOf();

  const server = http.createServer((req, res) => {
    const u = req.url!;
    if (u.startsWith('/api/v1/me/events/log')) {
      const since = sinceOf(u);
      const latest = latestOf();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          events: journal.filter((e) => e.id > since),
          latest,
          gap: hasGap(since),
        }),
      );
      return;
    }
    if (u.startsWith('/api/v1/me/events')) {
      const raw = sinceParam(u);
      streamSince.push(raw === null ? undefined : Number(raw));
      const since = sinceOf(u);
      const latest = latestOf();
      res.writeHead(200, SSE_HEAD);
      res.write(': open\n\n');
      if (raw !== null && hasGap(since)) {
        const data = carryLatest ? { since, latest } : { since };
        res.write(`event: replay.gap\ndata: ${JSON.stringify(data)}\n\n`);
      }
      for (const e of journal.filter((e) => e.id > since)) {
        res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      activeSse = res;
      const hb = setInterval(() => res.write(': ping\n\n'), 100);
      beats.add(hb);
      req.on('close', () => {
        clearInterval(hb);
        beats.delete(hb);
        if (activeSse === res) activeSse = undefined;
      });
      return;
    }
    if (u.startsWith('/api/v1/me/inbox?') || u === '/api/v1/me/inbox') {
      // What `await` reads (never consumes) to decide whether work is waiting.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: inbox, nextCursor: null }));
      return;
    }
    if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
      req.resume();
      pops += 1;
      const item = inbox.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item ? { item } : { item: null }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    journal,
    inbox,
    streamSince,
    get pops() {
      return pops;
    },
    pushMessage: (id, preview) => {
      journal.push({ id, event: 'message.new', data: messageNewData(preview) });
      activeSse?.write(
        `id: ${id}\nevent: message.new\ndata: ${JSON.stringify(messageNewData(preview))}\n\n`,
      );
    },
    close: () =>
      new Promise<void>((r) => {
        for (const hb of beats) clearInterval(hb);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function capture(): { io: CliIO; out(): string; err(): string; all(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
    all: () => out.join('') + err.join(''),
  };
}

describe('sparrow CLI — persisted cursor self-heals across a journal wipe', () => {
  let upstream: Upstream | undefined;
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-wipe-cfg-'));
  });
  afterEach(async () => {
    process.emit('SIGINT');
    if (upstream) await upstream.close();
    await nap(30);
    fs.rmSync(configDir, { recursive: true, force: true });
    upstream = undefined;
  });

  const STALE = 2634; // a pre-wipe cursor; the fresh journal's ids restart LOW
  const TOKEN = 'agk_stub';

  function seedProfile(serverUrl: string, state?: Record<string, unknown>, token = TOKEN): void {
    const dir = path.join(configDir, 'sparrow');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({
        defaultProfile: 'wipebot',
        profiles: { wipebot: { server: serverUrl, token, kind: 'agent' } },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ profiles: { wipebot: state ?? { lastEventId: String(STALE) } } }),
    );
  }
  const profileState = (): Record<string, unknown> => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(configDir, 'sparrow', 'state.json'), 'utf8'));
      return (s.profiles?.wipebot ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const persistedCursor = (): string | undefined =>
    profileState().lastEventId as string | undefined;

  const baseEnv = (extra?: Record<string, string>): Record<string, string | undefined> => ({
    PATH: process.env.PATH,
    HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
    XDG_CONFIG_HOME: configDir,
    ...extra,
  });

  it('watch: a stale-huge cursor is re-seeded to latest and fresh (low-id) live events are delivered', async () => {
    upstream = await startUpstream();
    upstream.journal.push({ id: 5, event: 'message.new', data: messageNewData('pre-existing') });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl);
    expect(persistedCursor()).toBe(String(STALE));

    const env = baseEnv({ SPARROW_RECONCILE_POLL_MS: '60' });
    const cap = capture();
    const watch = runCli(
      ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'],
      env,
      cap.io,
    );
    try {
      // An UNSTAMPED cursor from an older CLI is grandfathered in — the stream
      // resumes from it (and then heals), rather than being dropped on upgrade.
      let deadline = Date.now() + 5000;
      while (Date.now() < deadline && upstream.streamSince.length === 0) await nap(20);
      expect(upstream.streamSince[0]).toBe(STALE);

      // The gap signal (SSE replay.gap and/or the poll) re-seeds the persisted
      // cursor DOWN from the stale 2634 to the server's real latest (5).
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && Number(persistedCursor() ?? STALE) >= STALE) await nap(20);
      expect(persistedCursor()).toBe('5'); // exactly the server's `latest`

      // A fresh, LOW-id live event (id 6 << 2634) now flows instead of being
      // filtered as already-seen — the previously dead stream is alive.
      upstream.pushMessage(6, 'healed-live');
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('healed-live')) await nap(20);
      expect(cap.out()).toContain('healed-live');

      // The corrected cursor advanced with the delivered frame (persisted as 6).
      expect(persistedCursor()).toBe('6');
    } finally {
      process.emit('SIGINT');
      await watch;
    }
  });

  it('watch: the SSE replay.gap frame ALONE heals the cursor (no reconcile poll)', async () => {
    // The poll is disabled, so the ONLY gap signal is the stream frame. It must
    // adopt `latest` on its own — a stream-only client (--poll-seconds 0) is
    // otherwise permanently deaf after a wipe.
    upstream = await startUpstream();
    upstream.journal.push({ id: 4, event: 'message.new', data: messageNewData('pre-existing') });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl);

    const cap = capture();
    const watch = runCli(
      ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
      baseEnv(),
      cap.io,
    );
    try {
      let deadline = Date.now() + 5000;
      while (Date.now() < deadline && persistedCursor() !== '4') await nap(20);
      expect(persistedCursor()).toBe('4');

      upstream.pushMessage(5, 'healed-live-sse');
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('healed-live-sse')) await nap(20);
      expect(cap.out()).toContain('healed-live-sse');
      expect(persistedCursor()).toBe('5');
    } finally {
      process.emit('SIGINT');
      await watch;
    }
  });

  it('watch: a pre-heal gap (no `latest`) CLEARS the dead cursor so live events still flow', async () => {
    // A server that predates the heal signals the gap but cannot name its newest
    // id. Keeping a cursor the server just declared unreachable is what killed
    // delivery in prod, so the client drops it entirely.
    upstream = await startUpstream({ carryLatest: false });
    upstream.journal.push({ id: 3, event: 'message.new', data: messageNewData('pre-existing') });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl);

    const cap = capture();
    const watch = runCli(
      ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
      baseEnv(),
      cap.io,
    );
    try {
      let deadline = Date.now() + 5000;
      while (Date.now() < deadline && persistedCursor() !== undefined) await nap(20);
      expect(persistedCursor()).toBeUndefined(); // the dead cursor is gone

      upstream.pushMessage(4, 'flows-after-clear');
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('flows-after-clear')) await nap(20);
      expect(cap.out()).toContain('flows-after-clear');
      expect(persistedCursor()).toBe('4'); // and the fresh generation is tracked again
    } finally {
      process.emit('SIGINT');
      await watch;
    }
  });

  it('watch: ONE actionable gap line, not one per poll tick', async () => {
    // The prod log had ten "replay gap" lines per five-minute cycle and no way to
    // act on any of them. One line, once, that says what to do.
    upstream = await startUpstream({ carryLatest: false }); // gap keeps recurring while unhealed
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl);

    const cap = capture();
    const watch = runCli(
      ['watch', '--stale-seconds', '0', '--max-stream-age', '0'],
      baseEnv({ SPARROW_RECONCILE_POLL_MS: '40' }),
      cap.io,
    );
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !/missed/i.test(cap.all())) await nap(20);
      await nap(500); // ~12 more poll ticks; a per-tick logger would repeat here

      const lines = cap
        .all()
        .split('\n')
        .filter((l) => /missed/i.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/sparrow pop|inbox/); // actionable: drain the inbox
      // and the raw structural frame is no longer dumped at the user
      expect(cap.all()).not.toContain('[replay.gap]');
    } finally {
      process.emit('SIGINT');
      await watch;
    }
  });

  it('loop: a gap heals the cursor AND drains the inbox', async () => {
    upstream = await startUpstream();
    upstream.journal.push({ id: 7, event: 'message.new', data: messageNewData('pre-existing') });
    upstream.inbox.push({
      type: 'chat.message',
      message: sampleMessage('drained-after-wipe'),
      room: sampleRoom,
    });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl);

    const cap = capture();
    const loop = runCli(
      ['loop', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
      baseEnv(),
      cap.io,
    );
    try {
      let deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('drained-after-wipe')) await nap(20);
      expect(cap.out()).toContain('drained-after-wipe'); // reconciled via the drain

      deadline = Date.now() + 5000;
      while (Date.now() < deadline && persistedCursor() !== '7') await nap(20);
      expect(persistedCursor()).toBe('7'); // healed down to the server's latest
      expect(cap.all()).toMatch(/missed/i); // and said so, once
    } finally {
      process.emit('SIGINT');
      await loop;
    }
  });

  it('await: a PRUNED cursor (below the retention mark, nothing replayable) heals to `latest` and does not re-gap', async () => {
    // The production failure (2026-09-06): a turn-based agent's cursor sat at
    // 31079 for a day while only quiet-filtered presence churn was journaled.
    // Retention then pruned past it. Every reconnect replayed the same
    // `replay.gap` — and `await` woke INSTANTLY, every time, with a phantom
    // item: a wake loop that burns a full agent turn per arm. The heal must
    // adopt `latest` for a cursor BEHIND the journal, not only one ahead of it.
    const PRUNED = 31079;
    const LATEST = 44426;
    upstream = await startUpstream({ prunedMark: 40000, unreplayableLatest: LATEST });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(serverUrl, { lastEventId: String(PRUNED) });

    // First arm: the gap wakes (events WERE missed — the inbox is the truth now)…
    const first = capture();
    expect(
      await runCli(
        ['await', '--timeout', '5', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        baseEnv(),
        first.io,
      ),
      first.err(),
    ).toBe(0);
    const wake = JSON.parse(first.out().trim().split('\n').filter(Boolean)[0]!);
    expect(wake.type).toBe('await.item');
    expect(wake.reason).toBe('replay.gap');
    expect(wake.item).toBeNull();
    // …and HEALS the persisted cursor to the server's `latest`, not the dead 31079.
    expect(wake.cursor).toBe(String(LATEST));
    expect(persistedCursor()).toBe(String(LATEST));

    // Second arm: resumes from the healed cursor, sees NO gap, and holds until
    // its timeout (exit 2) — the phantom-wake loop is over.
    const second = capture();
    expect(
      await runCli(
        ['await', '--timeout', '1', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
        baseEnv(),
        second.io,
      ),
      second.err(),
    ).toBe(2);
    expect(upstream.streamSince[1]).toBe(LATEST);
    expect(second.out()).not.toContain('replay.gap');
  });

  it('a re-enrolled profile never resumes from the PREVIOUS identity’s cursor', async () => {
    // Re-enrollment overwrites the profile in place (same name, new agent key).
    // The cursor is scoped to the credential that earned it, so the new identity
    // starts clean instead of inheriting a cursor from an agent that no longer
    // exists.
    upstream = await startUpstream();
    upstream.journal.push({ id: 2, event: 'message.new', data: messageNewData('for-new-agent') });
    const serverUrl = `http://127.0.0.1:${upstream.port}`;
    seedProfile(
      serverUrl,
      {
        lastEventId: String(STALE),
        eventCursorIdentity: eventCursorIdentity(serverUrl, 'agk_previous_agent'),
      },
      'agk_new_agent',
    );

    const cap = capture();
    const watch = runCli(
      ['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--poll-seconds', '0'],
      baseEnv(),
      cap.io,
    );
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && upstream.streamSince.length === 0) await nap(20);
      // No `?since=` at all: the inherited cursor was dropped before connecting,
      // so nothing was filtered against a stranger's journal position.
      expect(upstream.streamSince[0]).toBeUndefined();
      expect(persistedCursor()).not.toBe(String(STALE));

      upstream.pushMessage(3, 'new-identity-live');
      let d2 = Date.now() + 5000;
      while (Date.now() < d2 && !cap.out().includes('new-identity-live')) await nap(20);
      expect(cap.out()).toContain('new-identity-live');
      // The new cursor is stamped with the CURRENT identity.
      d2 = Date.now() + 2000;
      while (Date.now() < d2 && persistedCursor() !== '3') await nap(20);
      expect(profileState().eventCursorIdentity).toBe(eventCursorIdentity(serverUrl, 'agk_new_agent'));
    } finally {
      process.emit('SIGINT');
      await watch;
    }
  });
});
