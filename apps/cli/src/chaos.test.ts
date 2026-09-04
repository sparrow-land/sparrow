/**
 * Chaos scenario tests for the CLI's `/me/events` reliability stack.
 *
 * Each test is headed by the PRODUCTION INCIDENT it pins. They drive the REAL
 * `watch`/`loop` commands (via {@link runCli}) against a REAL minimal HTTP
 * upstream (SSE stream + journal-log read + inbox/pop — the same idioms the
 * stream-health suite uses) routed THROUGH {@link ChaosProxy}, a raw TCP relay
 * that reproduces the exact network pathologies the stack was built to survive:
 *  1. midstream black-hole (ESTAB, bytes stop, no FIN);
 *  2. a reconnect attempt that stalls before headers;
 *  3. an edge that buffers upstream bytes and bursts them later;
 *  4. path pinning (every connection from the client hits the same dead path).
 *
 * Timing is driven by tight env knobs (`SPARROW_RECONCILE_POLL_MS`,
 * `SPARROW_RECONCILE_TIMEOUT_MS`, `--stale-seconds`) and deadline loops (never
 * fixed sleeps for the assertion), so each test settles in a few seconds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { runCli, type CliIO } from './index.js';
import { ChaosProxy } from './chaos-proxy.js';

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

/* ------------------------------ IO capture ----------------------------- */

interface Capture {
  io: CliIO;
  out(): string;
  err(): string;
}
function capture(): Capture {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/* ------------------------------ sample event shapes ----------------------------- */

const sampleFrom = { id: 'mem_owner', kind: 'human', displayName: 'Owner' };
const sampleRoom = {
  id: 'room_dm',
  name: '',
  orgId: 'org_a',
  kind: 'dm',
  counterpart: { type: 'agent', id: 'agt_x', displayName: 'bot' },
};
const messageNewData = (preview: string): unknown => ({
  room: sampleRoom,
  messageId: 'msg_x',
  from: sampleFrom,
  preview,
  kind: 'dm',
});
const sampleMessage = (body: string): unknown => ({
  id: 'msg_x',
  from: sampleFrom,
  to: [{ id: 'mem_bot', kind: 'agent', displayName: 'bot' }],
  kind: 'dm',
  subject: null,
  body,
  attachments: [],
  suggestedReplies: [],
  inReplyTo: null,
  replyValue: null,
  origin: null,
  createdAt: '2026-08-24T00:00:00Z',
});

/* ------------------------------ upstream stub ----------------------------- */

interface JournalEntry {
  id: number;
  event: string;
  data: unknown;
}

interface Upstream {
  port: number;
  /** The `/me/events/log` journal (mutable; the log read filters `id > since`). */
  journal: JournalEntry[];
  /** `/me/inbox/pop` queue (mutable; each pop shifts one). */
  inbox: Array<{ message: unknown; room: unknown }>;
  /** When true, the log read reports `gap: true`. */
  gap: { value: boolean };
  /** Write a raw SSE frame to the most recent live stream response. */
  pushSse(frame: string): void;
  /** Emit a `message.new` frame (id, preview) on the live stream. */
  pushMessage(id: number, preview: string): void;
  sseConns: number;
  logReqs: number;
  popReqs: number;
  close(): Promise<void>;
}

const sinceOf = (u: string): number => Number(new URL(u, 'http://x').searchParams.get('since') ?? '0');

/**
 * A minimal real HTTP upstream: an SSE `/me/events` (replays journaled frames
 * with `id > since` on connect, then heartbeats), a `/me/events/log` journal
 * read, and `/me/inbox/pop`. Returns handles the test mutates to time server
 * behavior precisely.
 */
async function startUpstream(opts?: {
  heartbeat?: boolean;
  /**
   * Hold each `/me/events/log` read open this long before answering, with the
   * body computed at ANSWER time (as a real server computes it when the request
   * finally reaches its handler). Models a loaded CI runner, where a poll's
   * request/response straddles many event-loop turns instead of completing in
   * one — so a poll dialed BEFORE a test snapshot routinely returns journal
   * entries written AFTER it. Assertions must survive that.
   */
  logDelayMs?: number;
}): Promise<Upstream> {
  const journal: JournalEntry[] = [];
  const inbox: Array<{ message: unknown; room: unknown }> = [];
  const gap = { value: false };
  const beats = new Set<NodeJS.Timeout>();
  const slowLogs = new Set<NodeJS.Timeout>();
  let activeSse: http.ServerResponse | undefined;
  const state = { sseConns: 0, logReqs: 0, popReqs: 0 };

  const server = http.createServer((req, res) => {
    const u = req.url!;
    if (u.startsWith('/api/v1/me/events/log')) {
      state.logReqs += 1;
      const since = sinceOf(u);
      const answer = (): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            events: journal.filter((e) => e.id > since),
            latest: journal.length ? journal[journal.length - 1]!.id : 0,
            gap: gap.value,
          }),
        );
      };
      if (opts?.logDelayMs) {
        const t = setTimeout(answer, opts.logDelayMs);
        slowLogs.add(t);
        res.on('close', () => {
          clearTimeout(t);
          slowLogs.delete(t);
        });
      } else answer();
      return;
    }
    if (u.startsWith('/api/v1/me/events')) {
      state.sseConns += 1;
      const since = sinceOf(u);
      res.writeHead(200, SSE_HEAD);
      res.write(': open\n\n');
      for (const e of journal.filter((e) => e.id > since)) {
        res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      activeSse = res;
      if (opts?.heartbeat !== false) {
        const hb = setInterval(() => res.write(': ping\n\n'), 100);
        beats.add(hb);
        req.on('close', () => {
          clearInterval(hb);
          beats.delete(hb);
          if (activeSse === res) activeSse = undefined;
        });
      } else {
        req.on('close', () => {
          if (activeSse === res) activeSse = undefined;
        });
      }
      return;
    }
    if (u === '/api/v1/me/inbox/pop' && req.method === 'POST') {
      state.popReqs += 1;
      req.resume();
      const item = inbox.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
          JSON.stringify(
            item
              ? { item: { type: 'chat.message', message: item.message, room: item.room } }
              : { item: null },
          ),
        );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

  return {
    port: (server.address() as AddressInfo).port,
    journal,
    inbox,
    gap,
    pushSse: (frame) => activeSse?.write(frame),
    pushMessage: (id, preview) =>
      activeSse?.write(
        `id: ${id}\nevent: message.new\ndata: ${JSON.stringify(messageNewData(preview))}\n\n`,
      ),
    get sseConns() {
      return state.sseConns;
    },
    get logReqs() {
      return state.logReqs;
    },
    get popReqs() {
      return state.popReqs;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const hb of beats) clearInterval(hb);
        for (const t of slowLogs) clearTimeout(t);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * Base env for a chaos run. `XDG_CONFIG_HOME` is pinned to an ISOLATED empty temp
 * dir per test: with no credentials file there, no named profile resolves, so the
 * CLI seeds/persists NO per-profile cursor — and, critically, never touches the
 * developer's real `~/.config/sparrow` (doing so leaks a stale resume cursor that
 * silently filters out journaled ids and corrupts real profile state).
 */
const baseEnv = (
  proxyUrl: string,
  configDir: string,
  extra?: Record<string, string>,
): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: os.homedir(),
    SPARROW_STATE_DIR: stateDir,
  XDG_CONFIG_HOME: configDir,
  SPARROW_SERVER: proxyUrl,
  SPARROW_TOKEN: 'agk_stub',
  ...extra,
});

/* ================================================================== *
 * Scenarios
 * ================================================================== */

describe('sparrow CLI — chaos: /me/events reliability under a hostile edge', () => {
  let upstream: Upstream | undefined;
  let proxy: ChaosProxy | undefined;
  let configDir: string;

  // Trap unhandled promise rejections for the whole suite: the prod crash was an
  // UNHANDLED rejection escaping the fresh-transport path. A healthy stack surfaces
  // every transport error through its awaited handler — so this array MUST stay
  // empty, in every scenario.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-chaos-cfg-'));
  });

  afterEach(async () => {
    process.emit('SIGINT'); // ensure any still-running watch/loop is stopped
    if (proxy) await proxy.close();
    if (upstream) await upstream.close();
    await nap(50); // let any late rejection surface before we judge
    process.off('unhandledRejection', onUnhandled);
    fs.rmSync(configDir, { recursive: true, force: true });
    proxy = undefined;
    upstream = undefined;
    expect(unhandled).toEqual([]); // no fresh-transport rejection ever floated
  });

  // INCIDENT 1 — midstream black-hole: a connection stays ESTAB but bytes stop
  // mid-stream (no FIN). The reconcile poll, dialing FRESH connections, must take
  // a healthy path and deliver within the poll floor. Modeled by wedging ONLY the
  // stream's (already-live) connection; connections opened afterwards are healthy.
  it('midstream-black-hole: the poll punches through on a fresh conn after the stream wedges', async () => {
    // The log read answers SLOWLY (a loaded runner): a poll is routinely already
    // in flight when the test looks, which is precisely the case a snapshot-and-
    // compare connection count gets wrong.
    upstream = await startUpstream({ logDelayMs: 120 });
    proxy = new ChaosProxy({ upstreamPort: upstream.port });
    await proxy.start();
    const env = baseEnv(proxy.url, configDir, { SPARROW_RECONCILE_POLL_MS: '80' });
    const cap = capture();
    // Watchdog + max-age OFF: recovery here is the POLL alone, not a reconnect.
    const watch = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'], env, cap.io);
    try {
      // Wait until the stream is live AND the reconcile poll has dialed at least
      // once, so the run is in its steady state (a poll in flight) before the
      // wedge — the state a loaded runner is almost always in, and the one this
      // scenario's assertions have to survive.
      let deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(upstream.sseConns >= 1 && upstream.logReqs >= 1))
        await nap(10);
      expect(upstream.sseConns).toBe(1);

      // The stream delivers a first frame live.
      upstream.journal.push({ id: 1, event: 'message.new', data: messageNewData('via-stream') });
      upstream.pushMessage(1, 'via-stream');
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('via-stream')) await nap(25);
      expect(cap.out()).toContain('via-stream');

      const opensBeforeWedge = proxy.connectionsOpened;
      const logReqsBeforeWedge = upstream.logReqs;
      // Bytes stop mid-stream: black-hole ONLY the stream's connection (id 1).
      proxy.wedge((c) => c.id === 1);
      // A message journals during the wedge — the wedged stream can never carry it.
      upstream.journal.push({ id: 2, event: 'message.new', data: messageNewData('via-poll-after-wedge') });

      // Wait for BOTH observable facts, not just the first: the frame arrives,
      // and the poll dials a connection that did not exist before the wedge.
      // Snapshotting the dial count and comparing it the instant the frame lands
      // is a RACE — the poll that carried the frame was often already in flight
      // when the snapshot was taken, so its connection is counted on both sides
      // and the next dial is still up to one interval away. (That is exactly how
      // this read "expected 2 to be greater than 2" on a loaded CI runner.)
      // A poll that dialed and reached upstream entirely AFTER the wedge. Both
      // counters are needed and neither may be sampled instantaneously: the poll
      // that carried the frame was often already dialed AND already counted
      // upstream before the wedge (its answer merely landed later), so at the
      // moment of delivery both counters can still read exactly what they read
      // before it.
      const polledSinceWedge = (): boolean =>
        proxy!.connectionsOpened > opensBeforeWedge && upstream!.logReqs > logReqsBeforeWedge;
      deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !(cap.out().includes('via-poll-after-wedge') && polledSinceWedge())
      )
        await nap(25);
      expect(cap.out()).toContain('via-poll-after-wedge'); // delivered by the reconcile poll
      // Proof it did NOT come down the stream: the one and only SSE connection
      // ever opened is the wedged one (watchdog and max-age are off, so nothing
      // reconnects it), and a wedged connection carries zero bytes in either
      // direction. The reconcile poll's log reads are the only door left.
      expect(upstream.sseConns).toBe(1);
      expect(proxy.stats().find((s) => s.id === 1)?.wedged).toBe(true);
      expect(upstream.logReqs).toBeGreaterThan(logReqsBeforeWedge);
      // And the poll keeps dialing FRESH connections rather than reusing a pool
      // that the dead path poisoned.
      expect(proxy.connectionsOpened).toBeGreaterThan(opensBeforeWedge);
    } finally {
      process.emit('SIGINT');
      expect(await watch).toBe(0);
    }
  }, 20000);

  // INCIDENT 2 — stalled reconnect: after a stream wedges, the FIRST reconnect
  // attempt's response stalls before headers (onOpen never fires). The watchdog is
  // pre-armed BEFORE connect, so it must abandon the hung attempt; a later attempt
  // then resumes and replays. Recovery is bounded by stale (not max-age). The poll
  // is disabled so recovery here is purely the SSE reconnect ladder.
  it('stalled-reconnect: the pre-armed watchdog abandons a headerless attempt; a later one replays', async () => {
    upstream = await startUpstream();
    proxy = new ChaosProxy({ upstreamPort: upstream.port });
    await proxy.start();
    const env = baseEnv(proxy.url, configDir);
    const cap = capture();
    // stale 1s, max-age OFF, poll OFF: only the SSE reconnect ladder can recover.
    const watch = runCli(
      ['watch', '--stale-seconds', '1', '--max-stream-age', '0', '--poll-seconds', '0', '--json'],
      env,
      cap.io,
    );
    try {
      // Let conn 1 (the live stream) establish + heartbeat.
      let deadline = Date.now() + 4000;
      while (Date.now() < deadline && upstream.sseConns < 1) await nap(25);
      expect(upstream.sseConns).toBe(1);

      // A message is journaled — it will only surface once a healthy conn replays it.
      upstream.journal.push({ id: 1, event: 'message.new', data: messageNewData('after-stall') });
      // Black-hole the live stream (heartbeats stop) AND stall the NEXT dial (the
      // reconnect attempt): it establishes at TCP but its headers never arrive.
      proxy.wedge((c) => c.id === 1);
      proxy.stallNext();

      const started = Date.now();
      deadline = started + 8000;
      while (Date.now() < deadline && !cap.out().includes('after-stall')) await nap(25);
      const elapsed = Date.now() - started;
      expect(cap.out()).toContain('after-stall'); // a later attempt replayed it
      expect(cap.out()).toContain('watch.stale'); // the watchdog fired (JSON log)
      // Three CLIENT dials: the live stream, the stalled reconnect, the healthy one.
      // But only TWO reach the upstream — the stalled attempt's request is
      // black-holed at the proxy and never forwarded, so it is invisible upstream.
      // That gap IS the stall: a dialed attempt that produced no upstream request.
      expect(proxy.connectionsOpened).toBeGreaterThanOrEqual(3);
      expect(upstream.sseConns).toBeGreaterThanOrEqual(2);
      expect(upstream.sseConns).toBeLessThan(proxy.connectionsOpened);
      // Bounded by stale+ladder (a few seconds), NOT the 5-min max-age default.
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      process.emit('SIGINT');
      expect(await watch).toBe(0);
    }
  }, 20000);

  // INCIDENT 3 — burst release: a tunnel edge BUFFERS upstream bytes and releases
  // them minutes later in a burst. The poll (fresh conn) must deliver first; when
  // the buffered burst is finally released and the stream re-delivers the SAME
  // frame, the cursor gate must drop the duplicate (no double surface).
  it('burst-release: the poll delivers first; the released burst duplicate is de-duped', async () => {
    upstream = await startUpstream();
    proxy = new ChaosProxy({ upstreamPort: upstream.port });
    await proxy.start();
    const env = baseEnv(proxy.url, configDir, { SPARROW_RECONCILE_POLL_MS: '80' });
    const cap = capture();
    // Watchdog + max-age OFF so the buffered stream is never torn down before the
    // release — the test is the poll floor + the dedupe gate, nothing else.
    const watch = runCli(['watch', '--stale-seconds', '0', '--max-stream-age', '0', '--json'], env, cap.io);
    try {
      // Let the stream (conn 1) establish.
      let deadline = Date.now() + 4000;
      while (Date.now() < deadline && proxy.liveConnections() < 1) await nap(25);

      // The edge starts buffering the stream's downstream bytes.
      proxy.holdDownstream((c) => c.id === 1);
      // A message is journaled AND pushed on the (now-buffered) stream: the poll
      // will read it from the journal; the stream's copy sits in the edge buffer.
      upstream.journal.push({ id: 1, event: 'message.new', data: messageNewData('burst-body') });
      upstream.pushMessage(1, 'burst-body');

      // The poll delivers it first, via a fresh connection.
      deadline = Date.now() + 5000;
      while (Date.now() < deadline && !cap.out().includes('burst-body')) await nap(25);
      expect(cap.out()).toContain('burst-body'); // delivered BEFORE release
      const countAfterPoll = cap
        .out()
        .split('\n')
        .filter((l) => l.includes('burst-body')).length;
      expect(countAfterPoll).toBe(1);

      // Now the edge bursts the buffered bytes — the stream re-delivers id 1.
      proxy.release((c) => c.id === 1);
      await nap(400); // give the flushed duplicate time to (not) re-surface

      const finalCount = cap
        .out()
        .split('\n')
        .filter((l) => l.includes('burst-body')).length;
      expect(finalCount).toBe(1); // the cursor gate dropped the burst duplicate
    } finally {
      process.emit('SIGINT');
      expect(await watch).toBe(0);
    }
  }, 20000);

  // INCIDENT 4 — dead-path pinning: EVERY connection from the client hits the same
  // dead path. The poll's fresh transports + per-request timeout must keep the loop
  // ALIVE (it never wedges, it keeps dialing) through the dead window; after heal()
  // a fresh connection recovers and nothing is lost or duplicated.
  it('dead-path-pinning: the loop stays alive dialing fresh conns; heal() recovers with no loss', async () => {
    upstream = await startUpstream();
    proxy = new ChaosProxy({ upstreamPort: upstream.port });
    await proxy.start();
    const env = baseEnv(proxy.url, configDir, {
      SPARROW_RECONCILE_POLL_MS: '80',
      SPARROW_RECONCILE_TIMEOUT_MS: '150',
    });
    const cap = capture();
    // stale 1s so the wedged stream keeps forcing reconnects (each a dead dial);
    // max-age OFF so recovery isn't attributable to the periodic refresh.
    const watch = runCli(['watch', '--stale-seconds', '1', '--max-stream-age', '0', '--json'], env, cap.io);
    try {
      // Let the stream (conn 1) establish + heartbeat healthily.
      let deadline = Date.now() + 4000;
      while (Date.now() < deadline && proxy.liveConnections() < 1) await nap(25);

      // The path goes fully dead: every NEW connection is wedged (pinPath) AND the
      // live stream is black-holed too. Now nothing the client dials can succeed.
      proxy.pinPath();
      proxy.wedge();
      const opensAtPin = proxy.connectionsOpened;

      // A message journals DURING the dead window — unreachable until heal().
      upstream.journal.push({ id: 1, event: 'message.new', data: messageNewData('after-heal') });

      // The loop must stay alive: it keeps DIALING fresh connections (reconnects +
      // polls), none of which deliver, and it never hangs or exits.
      deadline = Date.now() + 2500;
      while (Date.now() < deadline && proxy.connectionsOpened < opensAtPin + 3) await nap(25);
      expect(proxy.connectionsOpened).toBeGreaterThanOrEqual(opensAtPin + 3); // still dialing
      expect(cap.out()).not.toContain('after-heal'); // nothing delivered while dead

      // Heal the path: connections opened from here forward normally.
      proxy.heal();
      deadline = Date.now() + 6000;
      while (Date.now() < deadline && !cap.out().includes('after-heal')) await nap(25);
      expect(cap.out()).toContain('after-heal'); // a fresh conn recovered it
      await nap(300); // let any second path (reconnect replay AND poll) also fire

      const count = cap
        .out()
        .split('\n')
        .filter((l) => l.includes('after-heal')).length;
      expect(count).toBe(1); // exactly once — the cursor gate deduped the two paths
    } finally {
      process.emit('SIGINT');
      expect(await watch).toBe(0);
    }
  }, 20000);

  // INCIDENT 5 (behavioral half) — connect refused on a fresh transport (prod
  // crash, 2026-08-29): the edge briefly REFUSES new connects, so a fresh-transport
  // SSE reconnect (and poll) rejects with a NON-abort connect error before the
  // watchdog aborts. Here we assert the OBSERVABLE recovery: the process stays alive
  // and keeps dialing through the refused window, then heal() recovers with no loss.
  // The CRASH itself — the unhandled rejection off `void handle.closed.finally(...)`
  // — does NOT surface inside vitest's worker (vite's module graph swallows this
  // async undici rejection), so the true regression guard is the SUBPROCESS test in
  // the sibling describe below, which runs a REAL `node` process and counts leaks.
  it('connect-refused: a refused fresh transport does not crash watch; it recovers on heal', async () => {
    upstream = await startUpstream();
    proxy = new ChaosProxy({ upstreamPort: upstream.port });
    await proxy.start();
    const env = baseEnv(proxy.url, configDir, {
      SPARROW_RECONCILE_POLL_MS: '80',
      SPARROW_RECONCILE_TIMEOUT_MS: '150',
    });
    const cap = capture();
    // stale 1s so the wedged stream forces reconnects (each a refused fresh dial);
    // the poll dials refused fresh transports too. Both rejection paths must be safe.
    const watch = runCli(['watch', '--stale-seconds', '1', '--max-stream-age', '0', '--json'], env, cap.io);
    try {
      // Let the stream (conn 1) establish.
      let deadline = Date.now() + 4000;
      while (Date.now() < deadline && proxy.liveConnections() < 1) await nap(25);

      // A message journals; then the edge refuses ALL new connects and black-holes
      // the live stream — so every fresh transport the client dials is reset.
      upstream.journal.push({ id: 1, event: 'message.new', data: messageNewData('survived-refuse') });
      proxy.refuseNew();
      proxy.wedge();
      const opensAtRefuse = proxy.connectionsOpened;

      // The process must SURVIVE and keep dialing refused connections (reconnects +
      // polls), without delivering and without an unhandled rejection (suite trap).
      deadline = Date.now() + 2500;
      while (Date.now() < deadline && proxy.connectionsOpened < opensAtRefuse + 3) await nap(25);
      expect(proxy.connectionsOpened).toBeGreaterThanOrEqual(opensAtRefuse + 3); // still alive, dialing
      expect(cap.out()).not.toContain('survived-refuse');

      // Heal: fresh transports reach upstream again and recovery proceeds.
      proxy.heal();
      deadline = Date.now() + 6000;
      while (Date.now() < deadline && !cap.out().includes('survived-refuse')) await nap(25);
      expect(cap.out()).toContain('survived-refuse'); // the next poll/reconnect delivered
    } finally {
      process.emit('SIGINT');
      expect(await watch).toBe(0); // clean exit — the process never died
    }
  }, 20000);
});

/* ================================================================== *
 * INCIDENT 5 (crash guard) — the actual production crash, in a REAL process.
 *
 * The unhandled rejection that killed `watch` in prod (a fresh-transport connect
 * error floating off `void handle.closed.finally(transport.close)`) does NOT
 * surface inside vitest's worker — vite's module graph swallows this async undici
 * rejection, so an in-worker `process.on('unhandledRejection')` trap never fires
 * (verified: the reverted, buggy code passes every in-worker assertion). The only
 * faithful reproduction is a REAL `node` process, where the reverted code floats
 * exactly one leak per refused reconnect and the fix floats none.
 *
 * So this spawns the built CLI in a child `node`, drives a `watch` whose every
 * reconnect dials a REFUSED fresh transport (ChaosProxy.refuseNew), and asserts
 * the child counted ZERO unhandled rejections and exited 0. Without the one-line
 * `.catch(() => {})` fix this fails (unhandled ≥ 1); with it, it passes.
 * ================================================================== */

describe('sparrow CLI — chaos: fresh-transport connect-refused does not crash a real process', () => {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.join(cliRoot, 'dist');

  beforeAll(() => {
    // Build so the child runs THIS working tree's code (dist mirrors src, fix and
    // all). tsc emits both dist/index.js and dist/chaos-proxy.js, which the harness
    // imports. If the fix is reverted, the rebuilt dist reproduces the crash.
    execFileSync('npm', ['run', 'build'], { cwd: cliRoot, timeout: 120_000, stdio: 'ignore' });
  }, 120_000);

  it('a real node watch survives repeated refused reconnects with zero unhandled rejections', () => {
    const harness = `
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ChaosProxy } from ${JSON.stringify(path.join(distDir, 'chaos-proxy.js'))};
import { runCli } from ${JSON.stringify(path.join(distDir, 'index.js'))};

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
const reasons = [];
// Count leaks WITHOUT letting them crash the child, so we can report the number
// deterministically. A real deployment has no such handler — so any count > 0 here
// IS a process-killing bug in the field.
process.on('unhandledRejection', (e) => {
  unhandled += 1;
  reasons.push(String((e && e.message) || e));
});

// Minimal SSE upstream: establishes, then heartbeats.
const up = http.createServer((req, res) => {
  const u = req.url;
  if (u.startsWith('/api/v1/me/events/log')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: [], latest: 0 }));
    return;
  }
  if (u.startsWith('/api/v1/me/events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\\n\\n');
    const hb = setInterval(() => res.write(': ping\\n\\n'), 100);
    req.on('close', () => clearInterval(hb));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const proxy = new ChaosProxy({ upstreamPort: up.address().port });
await proxy.start();

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-'));
const env = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
    SPARROW_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cli-state-')),
  XDG_CONFIG_HOME: configDir,
  SPARROW_SERVER: proxy.url,
  SPARROW_TOKEN: 'agk_stub',
};
const p = runCli(
  ['watch', '--stale-seconds', '1', '--max-stream-age', '0', '--poll-seconds', '0', '--json'],
  env,
  { out: () => {}, err: () => {} },
);

// Let the stream establish, then make the edge refuse every new connect and
// black-hole the live stream: each watchdog-forced reconnect (~1s) now dials a
// REFUSED fresh transport, whose rejection is the prod crash's trigger.
const d1 = Date.now() + 4000;
while (Date.now() < d1 && proxy.liveConnections() < 1) await nap(25);
proxy.refuseNew();
proxy.wedge();
await nap(3500); // ~3 stale cycles → ~3 refused reconnects

process.emit('SIGINT');
const exit = await p;
await nap(150);
await proxy.close();
await new Promise((r) => up.close(r));
fs.rmSync(configDir, { recursive: true, force: true });
process.stdout.write('RESULT ' + JSON.stringify({ unhandled, reasons, exit }) + '\\n');
process.exit(0);
`;
    const harnessPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-harness-src-')), 'harness.mjs');
    fs.writeFileSync(harnessPath, harness);
    let out: string;
    try {
      out = execFileSync('node', [harnessPath], { cwd: cliRoot, timeout: 30_000 }).toString();
    } finally {
      fs.rmSync(path.dirname(harnessPath), { recursive: true, force: true });
    }
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `harness produced no RESULT line; output was:\n${out}`).toBeDefined();
    const res = JSON.parse(line!.slice('RESULT '.length)) as {
      unhandled: number;
      reasons: string[];
      exit: number;
    };
    // The guard: a real process must survive refused reconnects with NO leak. The
    // reverted (buggy) build reports unhandled ≥ 1 (one UND_ERR_SOCKET per reconnect).
    expect(res.unhandled, `leaked reasons: ${JSON.stringify(res.reasons)}`).toBe(0);
    expect(res.exit).toBe(0);
  }, 60_000);
});
