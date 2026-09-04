/**
 * `sparrow` CLI — the v4 command surface (chat + the medium-spanning attention
 * layer: typed work items, the unified inbox, the activity timeline). Exports
 * {@link runCli} for programmatic/test use; `bin.ts` calls it with `process.argv`
 * and exits with the returned code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Command, type Command as Cmd } from 'commander';
import {
  SparrowClient,
  ApiError,
  clientBuildVersion,
  type SparrowEvent,
  type PrincipalEvent,
  type EnsureDmResult,
  type EventStreamHandle,
  type MeEventsLogResult,
  type UnknownWorkItem,
} from '@sparrow/client';
import {
  deriveDefaultAgentName,
} from '@sparrow/common-types/identity';
import { CLAWBACK_WINDOW, minorVersionsAhead, PRESENCE_TTL_MAX } from '@sparrow/common-types';
import type {
  Hint,
  QuietableEvent,
  MePrincipal,
  MeOrg,
  MeRoom,
  OrgRoomSummary,
  AgentDmSever,
  WorkItem,
  InboxEntry,
  ChatInboxEntry,
  ActivityEntry,
  ActivityAppendedEvent,
  Email,
  EmailThread,
  EmailThreadRef,
  EmailAddressResponse,
  EmailApprovalItem,
  EmailDirection,
  Medium,
  RoomRef,
  Invite,
  CreateInviteResponse,
  EnrollmentSummary,
  VisibilityAgent,
  Member,
  Message,
  InboxItem,
  MessageStatus,
  MemberStatus,
  ListStatusesResponse,
  RoomInvitation,
  InboxRoomRef,
  EventRoomRef,
  DmCounterpart,
  AgentDmBox,
  AdminOrg,
  AdminRoom,
  PollEnrollmentResponse,
  MessageOrigin,
} from '@sparrow/common-types';
import {
  clearPending,
  loadPending,
  savePending,
  dedupeProfileName,
  loadCredentials,
  saveProfile,
  type SaveProfileResult,
  type PendingEnrollment,
} from './credentials.js';
import {
  CliError,
  CLI_CLIENT_IDENT,
  activeProfileName,
  buildClient,
  buildAttachments,
  buildEmailAttachments,
  parseInviteUrl,
  resolveAgent,
  resolveHumanId,
  resolveOrg,
  resolveOrgOptional,
  resolvePrincipal,
  resolveRoom,
  roomSelector,
  table,
  type Env,
  type GlobalOpts,
} from './util.js';
import {
  eventCursorIdentity,
  getProfileState,
  readEventCursor,
  updateProfileState,
  writeEventCursor,
  type LastInbound,
} from './state.js';
import { touchHeartbeat, markHeartbeatDead, skillInstall } from './loop-state.js';
import { runReconnectingStream } from './stream.js';
import {
  pollEnrollmentUntilResolved,
  saveApprovedProfile,
  type EnrollmentTimeout,
} from './harness/enroll-flow.js';
import { registerHarnessCommand } from './harness/command.js';

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  /** Injected stdin body (for `--stdin`). */
  stdin?: string;
  /** Prompt the user (login). `opts.hidden` masks input (passwords). */
  prompt?(question: string, opts?: { hidden?: boolean }): Promise<string>;
}

/** A prompt bound to one input stream; {@link Prompt.close} releases the reader. */
export type Prompt = ((question: string, opts?: { hidden?: boolean }) => Promise<string>) & {
  close(): void;
};

/**
 * What a prompt says when stdin can never answer it (`< /dev/null`, a drained
 * pipe, a daemon with no terminal). EOF is not an empty answer: the run must
 * fail loudly, naming the way in that needs no terminal at all.
 */
const NO_PASSWORD_ON_STDIN =
  'No password on stdin (input ended). Set SPARROW_PASSWORD, or run `sparrow login` on a terminal.';
const NO_INPUT_ON_STDIN =
  'No input on stdin (input ended). Pass --email (or set SPARROW_EMAIL) and set SPARROW_PASSWORD, ' +
  'or run `sparrow login` on a terminal.';

/**
 * Build a readline prompt over an explicit stdin/stdout pair, with optional
 * hidden (masked) input for passwords.
 *
 * The `terminal` flag tracks the REAL stdin. Forcing `terminal: true` made
 * readline echo every byte it read straight back to stdout — invisible on a TTY
 * (the terminal would have echoed it anyway), but on a PIPE it writes the input
 * into the caller's stdout: `echo "$PASSWORD" | sparrow login` printed the
 * password into whatever captured that run — CI logs, a transcript, a shell
 * recording. Off a TTY there is no echo to mask and no cursor to redraw, so
 * readline reads silently and the masking dance is skipped entirely.
 *
 * ONE interface serves every question this prompt asks, created lazily on the
 * first one (a run that never prompts never touches stdin). Building — and
 * closing — a fresh interface per question broke piped input twice over:
 * `printf 'email\npw\n' | sparrow login` handed the WHOLE chunk to the first
 * interface, whose `close()` then threw the password away, so the second prompt
 * hung on a stream with nothing left in it. Lines that arrive while no question
 * is pending are queued here instead, and the next question is answered from the
 * queue. When the stream ends with the queue empty, every pending and subsequent
 * question REJECTS ({@link NO_PASSWORD_ON_STDIN}) rather than hanging forever on
 * a promise readline will never settle — the old shape drained the event loop and
 * exited 0 having saved nothing.
 */
export function makePrompt(input: Readable & { isTTY?: boolean }, output: Writable): Prompt {
  const isTty = input.isTTY === true;
  let rl: ReturnType<typeof createInterface> | undefined;
  /** The INPUT ended (sticky — a stream cannot un-end); distinct from `close()`. */
  let ended = false;
  let closing = false;
  /** Lines read while no question was pending (a multi-line piped stdin). */
  const queued: string[] = [];
  /** Questions waiting for a line that has not arrived yet. */
  const waiting: Array<{
    hidden: boolean;
    resolve(line: string): void;
    reject(e: unknown): void;
  }> = [];

  const eofError = (hidden: boolean): CliError =>
    new CliError(hidden ? NO_PASSWORD_ON_STDIN : NO_INPUT_ON_STDIN);

  const ensure = (): ReturnType<typeof createInterface> => {
    if (rl) return rl;
    rl = createInterface({ input, output, terminal: isTty });
    // Only fires for lines readline did NOT hand to a pending question.
    rl.on('line', (line) => {
      const next = waiting.shift();
      if (next) next.resolve(line);
      else queued.push(line);
    });
    rl.on('close', () => {
      if (!closing) ended = true;
      const orphans = waiting.splice(0);
      // The question is already on the line; don't glue the error onto it.
      if (orphans.length > 0) output.write('\n');
      for (const w of orphans) w.reject(eofError(w.hidden));
    });
    return rl;
  };

  const prompt = (async (question, opts) => {
    const hidden = opts?.hidden === true;
    // A line already read (the second half of a piped chunk) answers immediately.
    const buffered = queued.shift();
    if (buffered !== undefined) {
      output.write(question);
      if (hidden && isTty) output.write('\n');
      return buffered;
    }
    if (ended) throw eofError(hidden);

    const iface = ensure();
    // Every line arrives through the ONE `line` listener above — `rl.question()`
    // would swallow the first line before that listener sees it, and settle a tick
    // later, which is exactly long enough for line two to be handed out first.
    const answer = new Promise<string>((resolve, reject) =>
      waiting.push({ hidden, resolve, reject }),
    );
    iface.setPrompt(question); // so a TTY redraw (backspace, resize) keeps it
    iface.prompt();

    if (hidden && isTty) {
      const onData = (): void => {
        // Overwrite the just-echoed char with the prompt (crude masking).
        output.write(`\x1b[2K\r${question}`);
      };
      input.on('data', onData);
      try {
        return await answer;
      } finally {
        input.off('data', onData);
        output.write('\n');
      }
    }
    return await answer;
  }) as Prompt;

  prompt.close = (): void => {
    closing = true;
    rl?.close();
    rl = undefined;
    closing = false;
    queued.length = 0;
  };
  return prompt;
}

/** Release a prompt's shared stdin reader, if it has one ({@link makePrompt}). */
function closePrompt(prompt: CliIO['prompt']): void {
  const close = (prompt as Partial<Prompt> | undefined)?.close;
  if (typeof close === 'function') close.call(prompt);
}

/** Readline prompt bound to this process's stdin/stdout. */
const defaultPrompt = makePrompt(process.stdin, process.stdout);

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  prompt: defaultPrompt,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stream-health defaults for `watch`/`loop`. The server heartbeats every 25s;
 * the watchdog waits ~3 missed heartbeats (75s) of total silence before deciding
 * a stream has gone zombie and forcing a reconnect. The max-age refresh re-opens
 * the stream every 5 minutes unconditionally (belt-and-suspenders).
 */
const STALE_SECONDS_DEFAULT = 75;
const MAX_STREAM_AGE_SECONDS_DEFAULT = 300;

/**
 * Reconcile-poll cadence for `watch`/`loop` on the `/me/events` path. Every 30s —
 * UNCONDITIONALLY, whether or not the stream is emitting bytes — a one-shot
 * `GET /me/events/log` read backfills anything a (possibly black-holed) stream
 * missed, so worst-case delivery latency is ~this even when SSE is fully wedged.
 * The poll is unconditional by design: a SICK stream can still dribble bytes, so
 * a "poll only when silent" gate would leave that failure class undetectable.
 */
const POLL_SECONDS_DEFAULT = 30;

/**
 * `await --turn-seconds`: how long the wake's heartbeat presence mark covers the
 * turn it is waking (SPEC "Presence → Self-reported heartbeat").
 *
 * THE BUG THIS EXISTS FOR: `await` wakes by EXITING, so from that instant until
 * the next `await`/`watch` the agent holds no stream — and a turn can run for
 * minutes. Past the 30s presence grace the agent read OFFLINE while it was
 * actively working on its owner's message: the owner saw the "isn't listening
 * yet" box and the start-listening hint fired at an agent mid-turn. The wake now
 * plants a mark that outlives the grace, so effective online (`stream OR
 * unexpired mark`) stays true across the whole turn; the next `await`/`watch`
 * resumes the stream and the mark quietly expires under it.
 *
 * Default 3 minutes — long enough for a real turn, short enough that a harness
 * that dies mid-turn shows offline soon after.
 */
const TURN_SECONDS_DEFAULT = 180;

/**
 * `sparrow await --wake-on <kinds>` — the kinds of work that wake you
 * IMMEDIATELY. `all` (the default, and the historical behaviour) is the absence
 * of a filter, so it is not a member here.
 *
 * `mention` has no structured backing: sparrow carries no mention refs on a
 * message, so it is the textual `@<my name>` convention, matched
 * case-insensitively as a whole word against the item's subject + body.
 */
const WAKE_KINDS = ['dm', 'mention', 'email'] as const;
type WakeKind = (typeof WAKE_KINDS)[number];

/**
 * How long unread-but-not-urgent work may sit before `--wake-on` lets it wake
 * you anyway (`--batch-after`, seconds). The default exists so `--wake-on` can
 * never MUTE: it batches. `--batch-after 0` opts out of the floor — the only
 * combination that defers indefinitely (the item still shows in `sparrow pop`).
 */
const BATCH_AFTER_DEFAULT = 600;

/**
 * How deep `--wake-on` looks into the queue. Filtered, the head of the queue is
 * not the answer — an urgent DM can sit behind a pile of broadcasts — so a page
 * is scanned rather than one item.
 */
const WAKE_SCAN_LIMIT = 50;

/**
 * Per-poll hard timeout for the reconcile poll's `GET /me/events/log`. Each poll
 * request is aborted after this long so ONE request hung on a dead pooled path
 * can never wedge the poll loop; the next interval's poll then runs normally.
 * `SPARROW_RECONCILE_TIMEOUT_MS` is a hidden millisecond override (keeps the hang
 * test fast, mirroring `SPARROW_RECONCILE_POLL_MS`).
 */
export const RECONCILE_POLL_TIMEOUT_MS = 10_000;

/**
 * Conventional shell exit codes for a signal death (128 + signo). A harness
 * reads these; nothing else in the CLI uses them.
 */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGTERM: 143, SIGHUP: 129 };

/**
 * Arm the termination signals every long-lived listener (`await`, `watch`,
 * `loop`) shares, and return the disarm function for its `finally`.
 *
 * WHY THIS EXISTS. `sparrow await` runs as a tracked background task and its
 * EXIT is a turn-based agent's wake signal. When the human interrupts the
 * session (Esc / Ctrl-C in Claude Code), the harness kills the whole process
 * tree — SIGTERM/SIGHUP, no warning. The listener is gone, but the heartbeat it
 * last touched stays FRESH for the full 120s window, so the Stop hook let the
 * next turn end silently and nothing told the agent it had gone deaf. That
 * happened three times in one production day.
 *
 * So a dying listener now says so, in the one place every reader already looks:
 * it stamps the heartbeat `killed:<signal>` (SIGTERM/SIGHUP — nobody asked) or
 * `stopped:SIGINT` (a deliberate Ctrl-C) and, for a kill, exits with the
 * conventional code IMMEDIATELY — no wake line, no presence mark, because there
 * is no turn to cover. SIGINT keeps today's behaviour: abort the stream and let
 * the command finish its normal, silent exit-0 path.
 *
 * The handler is idempotent (a tree kill can deliver more than one signal) and
 * never throws — a corpse cannot report an error. Normal exits (wake 0, timeout
 * 2, 426) stamp NOTHING: the turn that follows owns those.
 */
function armListenerSignals(env: Env, onInterrupt: () => void): () => void {
  let fired = false;
  const stamp = (reason: 'killed' | 'stopped', signal: string): boolean => {
    if (fired) return false;
    fired = true;
    try {
      markHeartbeatDead(env, reason, signal);
    } catch {
      /* best-effort: never throw on the way out */
    }
    return true;
  };
  const onInt = (): void => {
    if (!stamp('stopped', 'SIGINT')) return;
    onInterrupt();
  };
  const onKill = (signal: 'SIGTERM' | 'SIGHUP') => (): void => {
    if (!stamp('killed', signal)) return;
    // Leave NOW with the conventional code. Unwinding would risk printing a
    // wake line for an agent that is no longer there to read it.
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };
  const onTerm = onKill('SIGTERM');
  const onHup = onKill('SIGHUP');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  process.once('SIGHUP', onHup);
  return (): void => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  };
}

/** Resolve `--stale-seconds`/`--max-stream-age` (0 disables) into ms for the reconnect runner. */
function streamHealthOpts(opts: Record<string, unknown>): {
  staleMs: number | undefined;
  maxStreamAgeMs: number | undefined;
} {
  const staleSeconds = (opts.staleSeconds as number | undefined) ?? STALE_SECONDS_DEFAULT;
  const maxAgeSeconds = (opts.maxStreamAge as number | undefined) ?? MAX_STREAM_AGE_SECONDS_DEFAULT;
  return {
    staleMs: staleSeconds > 0 ? staleSeconds * 1000 : undefined,
    maxStreamAgeMs: maxAgeSeconds > 0 ? maxAgeSeconds * 1000 : undefined,
  };
}

/**
 * The two quiet axes every listener (`await`/`watch`/`loop`) shares.
 *
 * A listener is something an agent RUNS AND READS. Everything it prints about
 * ITSELF — reconnected, refreshing the stream, the reconcile poll's own
 * failures — is the runtime narrating its plumbing, and it drowns the signal
 * the agent is actually listening for. So the lifecycle chatter is silent by
 * default and `-v`/`--verbose` brings it back. Anomalies are never quieted: a
 * replay gap (events were MISSED), a terminal `426`, exhausted reconnect
 * retries, an unrecognized work item. And `-j` is untouched in both directions —
 * the JSON line protocols are a contract, so every lifecycle frame still lands
 * there byte-identically whether or not `-v` was passed.
 *
 * The second axis is what the SERVER is asked to send at all: presence and
 * status churn is the loudest traffic on `/me/events` and the least actionable
 * (a room of members flipping online/offline says nothing about work waiting for
 * you), so listeners subscribe with `?quiet=presence,status` by DEFAULT.
 * `--with-presence` / `--with-status` opt each one back in. This is a
 * subscription filter, not a mute: the journal keeps every frame, and any other
 * subscriber (the web) still sees them all.
 */
function listenerQuiet(opts: Record<string, unknown>): {
  verbose: boolean;
  quiet: QuietableEvent[];
} {
  const quiet: QuietableEvent[] = [];
  if (opts.withPresence !== true) quiet.push('presence');
  if (opts.withStatus !== true) quiet.push('status');
  return { verbose: opts.verbose === true, quiet };
}

/**
 * Resolve `--poll-seconds` (0 disables) into ms for the reconcile poll.
 * `SPARROW_RECONCILE_POLL_MS` is a hidden millisecond override (keeps integration
 * tests fast, mirroring `SPARROW_POLL_INTERVAL_MS` for enrollment).
 */
function pollMsOf(opts: Record<string, unknown>, env: Env): number | undefined {
  const seconds = (opts.pollSeconds as number | undefined) ?? POLL_SECONDS_DEFAULT;
  if (seconds <= 0) return undefined; // explicitly disabled — the override can't re-enable it
  const override = env.SPARROW_RECONCILE_POLL_MS
    ? Number.parseInt(env.SPARROW_RECONCILE_POLL_MS, 10)
    : undefined;
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return seconds * 1000;
}

/**
 * The per-poll abort timeout (ms). {@link RECONCILE_POLL_TIMEOUT_MS} unless
 * `SPARROW_RECONCILE_TIMEOUT_MS` overrides it (a hidden ms knob for fast tests).
 */
function pollTimeoutMsOf(env: Env): number {
  const override = env.SPARROW_RECONCILE_TIMEOUT_MS
    ? Number.parseInt(env.SPARROW_RECONCILE_TIMEOUT_MS, 10)
    : undefined;
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return RECONCILE_POLL_TIMEOUT_MS;
}

/** A fresh single-connection transport for ONE SSE (re)connect (see {@link loadUndici}). */
export interface FreshTransport {
  /** A fresh undici `Agent` (opaque to the client), passed as the fetch `dispatcher`. */
  dispatcher: unknown;
  /** undici's OWN `fetch` — the one that can actually drive `dispatcher`. */
  fetchImpl: typeof fetch;
  /** Close the underlying Agent when the stream ends. */
  close: () => void;
}

/** The undici surface we use — its `Agent` ctor and its matching `fetch`. */
export interface UndiciModule {
  Agent: new (opts: { connections: number; pipelining: number }) => { close(): Promise<void> };
  fetch: typeof fetch;
}

/**
 * Lazily resolve undici so the CLI can hand each SSE (re)connect a FRESH
 * single-connection dispatcher — a reconnect then can never reuse a pooled,
 * silently-dead keep-alive path to the same tunnel edge (the prod failure where a
 * black-holed stream also wedges its own retries). It is loaded via a non-literal
 * specifier so a missing dep degrades to `undefined` (the reconcile-poll floor
 * then carries the reliability guarantee alone) rather than crashing.
 */
export async function loadUndici(): Promise<UndiciModule | undefined> {
  try {
    const spec = 'undici';
    return (await import(spec)) as UndiciModule;
  } catch {
    return undefined;
  }
}

/**
 * A factory yielding a fresh transport per call, or one that yields `undefined`
 * when undici is unavailable (the poll floor then covers reconnect reliability).
 * Crucially, each transport pairs the fresh `Agent` with undici's OWN `fetch`:
 * Node's bundled global fetch cannot drive a `Dispatcher` from a separately
 * installed undici (a foreign type — the fetch silently hangs), so the dispatcher
 * MUST be consumed by the same undici's fetch.
 */
export function transportFactory(undici: UndiciModule | undefined): () => FreshTransport | undefined {
  if (!undici) return () => undefined;
  return () => {
    const agent = new undici.Agent({ connections: 1, pipelining: 0 });
    return {
      dispatcher: agent,
      fetchImpl: undici.fetch,
      close: () => void agent.close().catch(() => {}),
    };
  };
}

/**
 * The one `/me/events` cursor `watch`/`loop` live by. It is three things at once:
 * the `?since=` each (re)connect resumes from, the dedupe gate BOTH the stream and
 * the reconcile poll pass through (so neither surfaces a frame twice), and the
 * thing that heals when the server says the cursor is unreachable.
 *
 * The heal is the lesson of the 2026-09-01 outage: a cursor from a wiped journal
 * (2634) sat ABOVE every fresh id (~115), so `seen()` swallowed the entire live
 * stream while presence stayed green. The rule is now absolute — **a cursor the
 * server has declared unreachable is never filtered against again**:
 *
 *  - `latest` present and BELOW the cursor → adopt it (the wipe case: our cursor
 *    names events that never existed in this journal).
 *  - `latest` present and at/above the cursor → the ordinary pruned-retention gap.
 *    Ids still climb past our cursor, so nothing is being filtered wrongly, and
 *    the server is about to replay what it kept — adopting `latest` here would
 *    swallow that replay. Keep the cursor; the caller reconciles by draining.
 *  - `latest` ABSENT (a server predating the heal) → CLEAR the cursor. There is
 *    nothing to adopt and keeping a cursor the server just called unreachable is
 *    precisely the failure mode; a cleared cursor filters nothing, and the next
 *    poll backfills from the start of the journal.
 *
 * {@link EventCursor.gap} also answers whether the caller should ANNOUNCE this
 * gap: once per gap, not once per poll tick (the prod log carried ten identical
 * "replay gap" lines every five minutes and no way to act on any of them).
 */
interface EventCursor {
  /** The cursor to resume from, or `undefined` (start clean — filter nothing). */
  current(): string | undefined;
  /** Already surfaced by the other path? The stream ∩ poll dedupe gate. */
  seen(id?: string): boolean;
  /** Record a surfaced frame's id (advances the gate; persists). */
  advance(id: string): void;
  /** Apply a gap signal; returns true when the caller should announce it. */
  gap(latest?: string | number): boolean;
}

function makeEventCursor(
  initial: string | undefined,
  persist: (cursor: string | undefined) => void,
): EventCursor {
  let lastId = initial;
  // The cursor value we last announced a gap at (`null` = "no cursor"), or
  // undefined when nothing has been announced since the last delivered frame.
  let announcedAt: string | null | undefined;
  const set = (next: string | undefined): void => {
    lastId = next;
    persist(next);
  };
  return {
    current: () => lastId,
    seen: (id) => id !== undefined && lastId !== undefined && Number(id) <= Number(lastId),
    advance(id) {
      set(id);
      announcedAt = undefined; // progress: a later gap is genuinely new news
    },
    gap(latest) {
      const n = latest === undefined ? Number.NaN : Number(latest);
      if (Number.isFinite(n)) {
        if (lastId !== undefined && Number(lastId) > n) set(String(n)); // adopt `latest`
      } else if (lastId !== undefined) {
        set(undefined); // pre-heal server: nothing to adopt → never keep a dead cursor
      }
      const at = lastId ?? null;
      const announce = announcedAt !== at;
      announcedAt = at;
      return announce;
    },
  };
}

/**
 * Belt-and-suspenders reconcile poll for the `/me/events` path. Alongside the SSE
 * stream, every `pollMs` — UNCONDITIONALLY (not gated on stream silence: a sick
 * stream can still dribble bytes, which a "poll only when quiet" gate would treat
 * as health, leaving that failure class undetectable) — it reads
 * `GET /me/events/log?since=<lastId>` and feeds any frames through `onEvent`
 * exactly like live ones, advancing the SAME `lastId` gate both paths pass through
 * (so nothing is processed twice — dedupe is inherent, no gate needed). Because a
 * plain HTTP request opens a fresh exchange, it punches through a path stall that
 * has silently wedged the long-lived stream — bounding worst-case delivery latency
 * at ~`pollMs` even when SSE is fully black-holed.
 *
 * Two hardening guarantees keep the loop itself unwedgeable: (1) each request is
 * aborted after `timeoutMs`, so ONE read hung on a dead path can't stall the loop
 * forever; (2) each request runs over a FRESH single-connection transport (undici
 * Agent + its own fetch, via `newTransport`, closed after the request), so a
 * poisoned keep-alive pool can't wedge polls either — mirroring the SSE reconnect.
 * A previous poll still in flight skips the tick (no pileups). Poll failures /
 * timeouts are logged (json mode), non-fatal, and the next interval polls anyway.
 * Returns a stop() that cancels the timer.
 */
function startReconcilePoll(params: {
  client: SparrowClient;
  pollMs: number | undefined;
  /** Per-request abort timeout (ms) — bounds a hung read so it can't wedge the loop. */
  timeoutMs: number;
  signal: AbortSignal;
  /** A fresh per-poll transport (undici Agent + its fetch), or undefined without undici. */
  newTransport: () => FreshTransport | undefined;
  /**
   * The same `?quiet=` filter the SSE stream subscribed with. The poll is the
   * other door into the identical journal — without this, everything the stream
   * filtered out would walk straight back in through it.
   */
  quiet?: readonly QuietableEvent[];
  /** The shared cursor gate — read fresh each tick (advanced by stream AND poll). */
  getLastId: () => string | undefined;
  /** Handle one decoded frame — the SAME path a live frame takes (advances lastId). */
  onEvent: (e: PrincipalEvent) => void;
  /**
   * Replay is known-incomplete — reconcile. `since` is the cursor this poll asked
   * with and `latest` the server's real newest one; the caller heals the cursor
   * from them (see {@link makeEventCursor}) before anything is filtered again.
   */
  onGap: (info: { since: string; latest: string }) => void;
  onError: (e: unknown) => void;
}): () => void {
  const { client, pollMs, timeoutMs, signal } = params;
  if (pollMs === undefined) return () => {};
  let running = false;
  const tick = async (): Promise<void> => {
    if (signal.aborted || running) return; // skip while a prior poll is in flight
    running = true;
    try {
      // Backfill from the current cursor; when the stream never delivered a frame
      // (wedged from the start), from the beginning (0) so the backlog surfaces.
      let cursor = params.getLastId() ?? '0';
      for (;;) {
        // Each request: a fresh single-connection transport + a hard abort timeout,
        // so neither a poisoned pool nor a hung read can wedge the poll loop.
        const transport = params.newTransport();
        const ac = new AbortController();
        const onOuterAbort = (): void => ac.abort();
        signal.addEventListener('abort', onOuterAbort, { once: true });
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        let res: MeEventsLogResult;
        try {
          res = await client.meEventsLog(cursor, {
            signal: ac.signal,
            dispatcher: transport?.dispatcher,
            fetchImpl: transport?.fetchImpl,
            quiet: params.quiet,
          });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onOuterAbort);
          transport?.close();
        }
        if (signal.aborted) break;
        // onGap runs BEFORE the events: on a generation mismatch it heals the
        // cursor DOWN to `latest`, after which this page's (empty) events and every
        // subsequent fresh id pass the seen-gate again. A normal pruned-retention
        // gap keeps `latest` above the cursor, so the heal is a no-op there.
        if (res.gap) params.onGap({ since: cursor, latest: res.latest });
        for (const e of res.events) params.onEvent(e);
        // Only ids > cursor are ever returned, and onEvent advances lastId, so the
        // cursor strictly increases; stop if a capped page somehow didn't advance.
        const next = params.getLastId() ?? cursor;
        if (!res.more || next === cursor) break;
        cursor = next;
      }
    } catch (e) {
      params.onError(e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  (timer as { unref?: () => void }).unref?.();
  const onAbort = (): void => clearInterval(timer);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    clearInterval(timer);
    signal.removeEventListener('abort', onAbort);
  };
}

/* ------------------------------ formatters ----------------------------- */

/**
 * One line answering "am I actually online?" — effective presence as the server
 * sees it, and WHICH source carries it. A turn-based agent holding only a
 * heartbeat mark gets the mark's expiry (local wall-clock), so a stale mark is
 * visible at a glance rather than looking like a live connection.
 */
function formatPresence(p: MePrincipal): string {
  const { online, via, onlineUntil } = p.presence;
  if (!online || via === null) return 'OFFLINE — not holding a stream or mark';
  if (via === 'mark' && onlineUntil !== null) {
    return `online via mark until ${new Date(onlineUntil).toTimeString().slice(0, 8)}`;
  }
  return `online via ${via}`;
}

function formatPrincipal(p: MePrincipal): string {
  if (p.type === 'human') {
    return [
      `type:        human`,
      `id:          ${p.id}`,
      `displayName: ${p.displayName}`,
      `email:       ${p.email}`,
    ].join('\n');
  }
  const lines = [
    `type:        agent`,
    `id:          ${p.id}`,
    `name:        ${p.name}`,
    `orgId:       ${p.orgId}`,
    `owner:       ${p.owner.displayName} (${p.owner.id})`,
  ];
  // Role lines only when a role is set (title, instructions, or both) — a
  // roleless agent stays as terse as before.
  if (p.roleTitle !== null || p.roleInstructions !== null) {
    lines.push(`roleTitle:   ${p.roleTitle ?? '(none)'}`);
    if (p.roleInstructions !== null) lines.push(`roleInstructions: (${p.roleInstructions.length} chars)`);
    if (p.roleUpdatedAt !== null) lines.push(`roleUpdatedAt: ${p.roleUpdatedAt}`);
  }
  return lines.join('\n');
}

/** Human-readable `sparrow role` output for an agent's own role. */
function formatRole(p: Extract<MePrincipal, { type: 'agent' }>): string {
  if (p.roleTitle === null && p.roleInstructions === null) {
    return 'No role set. Set one with `sparrow role set --title … [--instructions …]`.';
  }
  const lines = [`roleTitle:    ${p.roleTitle ?? '(none)'}`];
  lines.push(`roleUpdatedAt: ${p.roleUpdatedAt ?? '(unknown)'}`);
  lines.push('roleInstructions:');
  lines.push(p.roleInstructions ?? '(none)');
  return lines.join('\n');
}

function formatOrgs(orgs: MeOrg[]): string {
  if (orgs.length === 0) return 'No orgs.';
  return table(
    ['ORG ID', 'SLUG', 'NAME', 'ROLE'],
    orgs.map((o) => [o.org.id, o.org.slug, o.org.name, o.role]),
  );
}

/** Label a room for aggregated output: a DM as `@counterpart`, else its name. */
function roomLabel(room: { id?: string; name: string; kind: string; counterpart?: DmCounterpart }): string {
  if (room.kind === 'dm') return `@${room.counterpart?.displayName || room.name || room.id || 'dm'}`;
  return room.name || room.id || '(room)';
}

function formatRooms(rooms: MeRoom[]): string {
  if (rooms.length === 0) return 'No room memberships.';
  return table(
    ['ROOM ID', 'NAME', 'KIND', 'ROLE'],
    rooms.map((r) => [r.room.id, roomLabel(r.room), r.room.kind, r.roomRole]),
  );
}

/**
 * `sparrow rooms --all` — the org owner/admin's governance table. Deliberately
 * structural (who many members, alive or archived, since when) and never a
 * preview: enumeration is not readership.
 */
function formatOrgRooms(items: OrgRoomSummary[]): string {
  if (items.length === 0) return 'No rooms in this org.';
  return table(
    ['ROOM ID', 'NAME', 'KIND', 'MEMBERS', 'ARCHIVED', 'CREATED'],
    items.map((r) => [
      r.id,
      r.name || '(unnamed)',
      r.kind,
      String(r.memberCount),
      r.archivedAt ?? '',
      r.createdAt,
    ]),
  );
}

function formatInvites(items: Invite[]): string {
  if (items.length === 0) return 'No invites.';
  return table(
    ['ID', 'INVITER', 'NOTE', 'EXPIRES', 'REVOKED'],
    items.map((i) => [
      i.id,
      i.inviter.displayName,
      i.note ?? '',
      i.expiresAt,
      i.revokedAt ?? '',
    ]),
  );
}

function formatCreatedInvite(res: CreateInviteResponse): string {
  return [
    `Invite ${res.invite.id} created (expires ${res.invite.expiresAt}).`,
    `Share this URL — the token appears only here:`,
    `  ${res.url}`,
  ].join('\n');
}

function formatEnrollments(items: EnrollmentSummary[]): string {
  if (items.length === 0) return 'No pending requests.';
  return table(
    ['ID', 'KIND', 'NAME/EMAIL', 'NOTE', 'INVITER'],
    items.map((e) => [
      e.id,
      e.kind,
      e.kind === 'agent' ? e.proposedName ?? '' : e.email ?? e.displayName ?? '',
      e.note ?? '',
      e.inviter.displayName,
    ]),
  );
}

function formatAgents(items: VisibilityAgent[]): string {
  if (items.length === 0) return 'No agents.';
  return table(
    ['ID', 'NAME', 'ONLINE', 'OWNER', 'SHARED BY'],
    items.map((a) => [
      a.agent.id,
      a.agent.name,
      a.agent.online ? 'yes' : 'no',
      a.owner.displayName,
      a.sharedBy ? a.sharedBy.displayName : '(yours)',
    ]),
  );
}

function formatMembers(items: Member[]): string {
  if (items.length === 0) return 'No members.';
  return table(
    ['MEMBER ID', 'KIND', 'PRINCIPAL', 'DISPLAY NAME', 'ROLE'],
    items.map((m) => [m.id, m.kind, m.principalId, m.displayName, m.roomRole]),
  );
}

function formatMessage(m: Message): string {
  const voiceTag = m.origin === 'voice' ? ' [voice]' : '';
  const lines = [
    `id:       ${m.id}`,
    `from:     ${m.from.displayName} (${m.from.id})${voiceTag}`,
    `to:       ${m.to.map((t) => t.displayName).join(', ')}`,
    `kind:     ${m.kind}`,
    `subject:  ${m.subject ?? ''}`,
    `created:  ${m.createdAt}`,
  ];
  if (m.inReplyTo) {
    const value = m.replyValue !== null ? ` (value: ${m.replyValue})` : '';
    lines.push(`reply to: ${m.inReplyTo}${value}`);
  }
  if (m.attachments.length > 0) {
    lines.push('attachments:');
    for (const a of m.attachments) {
      lines.push(`  - ${a.id}  ${a.filename}  ${a.contentType}  ${a.sizeBytes}B`);
    }
  }
  if (m.suggestedReplies.length > 0) {
    lines.push('suggested replies:');
    for (const s of m.suggestedReplies) {
      lines.push(s.label === s.value ? `  - ${s.label}` : `  - ${s.label} = ${s.value}`);
    }
  }
  lines.push('', m.body);
  return lines.join('\n');
}

function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) return 'Inbox empty.';
  return table(
    ['ID', 'FROM', 'KIND', 'SUBJECT', 'PREVIEW', 'ATT', 'STATUS'],
    items.map((m) => [
      m.id,
      m.from.displayName,
      m.kind,
      m.subject ?? '',
      m.preview.replace(/\s+/g, ' ').slice(0, 40),
      String(m.attachmentCount),
      m.status,
    ]),
  );
}

/** Collapse whitespace and clip a preview/summary for one table cell. */
function cell(s: string, width = 40): string {
  return s.replace(/\s+/g, ' ').slice(0, width);
}

/**
 * `GET /me/inbox` — the `type`-discriminated union across mediums. Every row
 * LEADS WITH ITS MEDIUM (SPEC → CLI "Typed work items"), then names where it
 * lives: the room for chat, the thread for email. Entries of a type this CLI
 * does not know never reach here — the client drops them (forward compat).
 */
function formatMeInbox(items: InboxEntry[]): string {
  if (items.length === 0) return 'Inbox empty.';
  return table(
    ['MEDIUM', 'WHERE', 'ID', 'FROM', 'SUBJECT', 'PREVIEW', 'ATT', 'STATUS'],
    items.map((i) =>
      i.type === 'chat.message'
        ? [
            'chat',
            roomLabel(i.room),
            i.id,
            i.from.displayName,
            i.subject ?? '',
            cell(i.preview),
            String(i.attachmentCount),
            i.status,
          ]
        : [
            'email',
            i.thread.id,
            i.id,
            i.from.name || i.from.email,
            i.subject,
            cell(i.preview),
            String(i.attachmentCount),
            i.status,
          ],
    ),
  );
}

/**
 * The medium header a popped chat item leads with: `[room: #deploys]` for a
 * project room, `[room: @dana]` for a DM.
 */
function roomHeader(room: RoomRef): string {
  const label =
    room.kind === 'dm'
      ? `@${room.counterpart?.displayName || room.name || room.id}`
      : `#${room.name || room.id}`;
  return `[room: ${label}]`;
}

/** Render one party as `addr` or `addr (Name)`. */
function party(p: { email: string; name?: string | null }): string {
  return p.name ? `${p.email} (${p.name})` : p.email;
}

/**
 * True for an email that reached its destination. Everything else —
 * `quarantined`, `held`, `rejected`, `send-failed` — is a state a reader must be
 * told about explicitly, because the mail is not where they think it is.
 */
function emailLanded(e: { disposition: string }): boolean {
  return e.disposition === 'delivered' || e.disposition === 'sent';
}

/**
 * A popped or read email, in the register the medium deserves: the thread it
 * belongs to, the full envelope (from/to/cc/subject), the inbound verification
 * result, the attachment ids, then the body. Headers first because an email is
 * read cold — the reader has none of a room's context.
 *
 * The thread label is `{threadId} · {subject}`. SPEC's illustration of this
 * header (CLI → "Typed work items") shows a POSITION instead — "3rd in thread" —
 * which no wire shape supports: a work item and a single-email read both carry
 * an {@link EmailThreadRef}, and the count lives only on the full `EmailThread`
 * behind another request. Paying a round trip per popped item inside
 * `sparrow loop` to print an ordinal is the wrong trade, so the subject — always
 * present, always useful — names the thread instead.
 *
 * `thread` is null when the caller fetched ONE email by id and never loaded its
 * thread; the header then names the thread by id alone.
 */
function formatEmail(email: Email, thread: EmailThreadRef | null): string {
  const label = thread ? `${thread.id} · ${thread.subject}` : email.threadId;
  const lines = [
    `[email: ${label}]`,
    `from: ${party(email.from)}`,
    `to:   ${email.to.map(party).join(', ')}`,
  ];
  if (email.cc.length > 0) lines.push(`cc:   ${email.cc.map(party).join(', ')}`);
  lines.push(`subj: ${email.subject}`, `id:   ${email.id}`, `date: ${email.createdAt}`);
  if (email.verification) {
    const v = email.verification;
    lines.push(`auth: spf=${v.spf} dkim=${v.dkim} dmarc=${v.dmarc}`);
  }
  // Only an email that did NOT land needs a state line: a `delivered`/`sent` one
  // is where the reader assumes it is, and saying so adds noise to every pop.
  if (!emailLanded(email)) {
    lines.push(`state: ${email.disposition}${email.reason ? ` (${email.reason})` : ''}`);
  }
  if (email.judge) {
    lines.push(`judge: ${email.judge.verdict ?? 'no answer'} — ${email.judge.reason}`);
  }
  if (email.attachments.length > 0) {
    lines.push('attachments:');
    for (const a of email.attachments) {
      lines.push(`  - ${a.id}  ${a.filename}  ${a.contentType}  ${a.sizeBytes}B`);
    }
  }
  lines.push('', email.text);
  return lines.join('\n');
}

/** One thread-list row's "who else is on this" — the non-agent participants. */
function threadRow(t: EmailThreadRef): string[] {
  return [t.id, t.subject, t.trusted ? 'yes' : 'no', t.lastEmailAt ?? '(none)', t.createdAt];
}

/**
 * `sparrow email threads` — the server hands back a TRANSCRIPT page, newest-first
 * by `lastEmailAt`; render it oldest-first (reading order), exactly as
 * {@link formatLog} does for a room. `-j` keeps the raw page, so the
 * `nextBefore` cursor a script pages with is never reordered away.
 */
function formatEmailThreads(items: EmailThreadRef[]): string {
  if (items.length === 0) return 'No email threads.';
  return table(
    ['THREAD ID', 'SUBJECT', 'TRUSTED', 'LAST EMAIL', 'CREATED'],
    [...items].reverse().map(threadRow),
  );
}

/**
 * `sparrow email read <ethId>` — a whole thread as an oldest-first transcript,
 * the same shape `sparrow log` gives a room. Each line carries the email's id
 * (so `sparrow email read <emlId>` / `email reply --to` can target it), the
 * direction, the other party, and the first line of the body.
 *
 * Emails that did NOT land — `quarantined`, `held`, `rejected`, `send-failed` —
 * are tagged inline rather than hidden: the route includes them precisely so an
 * agent can see what never went out.
 */
function formatEmailThreadTranscript(thread: EmailThread, items: Email[]): string {
  const head = [
    `thread ${thread.id} — “${thread.subject}” ` +
      `(${thread.emailCount} email${thread.emailCount === 1 ? '' : 's'}, ${thread.unreadCount} unread` +
      `${thread.trusted ? ', trusted' : ''})`,
    `participants: ${thread.participants.map(party).join(', ') || '(none)'}`,
    '',
  ];
  if (items.length === 0) return [...head, 'No emails in this page.'].join('\n');
  const lines = items.map((e) => {
    const arrow = e.direction === 'in' ? '←' : '→';
    const who = e.direction === 'in' ? party(e.from) : e.to.map((t) => t.email).join(', ');
    const firstLine = e.text.split('\n')[0] ?? '';
    const body = firstLine.length < e.text.length ? `${firstLine} …` : firstLine;
    const n = e.attachments.length;
    const att = n > 0 ? ` (${n} attachment${n === 1 ? '' : 's'})` : '';
    const tag = emailLanded(e) ? '' : ` [${e.disposition}${e.reason ? `: ${e.reason}` : ''}]`;
    return `${e.createdAt}  ${e.id}  ${arrow} ${who}: ${body}${att}${tag}`;
  });
  return [...head, ...lines].join('\n');
}

/** `sparrow email address` — the derivation, spelled out. */
function formatEmailAddress(a: EmailAddressResponse): string {
  return [
    `address: ${a.address}`,
    `domain:  ${a.domain}`,
    `agent:   ${a.agentId}`,
    `org:     ${a.orgId}`,
  ].join('\n');
}

/**
 * The report for an outbound email that landed in the owner's queue. A held mail
 * is NOT a failure — the command exits 0 — but it also has not gone anywhere, so
 * the message says who has it, what will tell the agent the answer, and (loudly)
 * that retrying is the wrong move: a loop that treats `held` as an error will
 * re-send the same mail until a human drowns (SPEC → CLI, "Email commands").
 */
function heldMessage(email: Email, ownerName: string): string {
  const to = email.to.map((t) => t.email).join(', ');
  return [
    `${email.id} to ${to} was NOT relayed — held for ${ownerName} to approve; ` +
      `you will get \`email.resolved\` when they decide.`,
    `Reason: ${email.reason ?? 'policy'}. A held mail is not a failure: do not retry it.`,
  ].join('\n');
}

/** `→ recipient` for outbound, `← sender` for inbound — the "other end" of one email. */
function emailCounterparty(e: { direction: string; from: { email: string }; to?: { email: string }[] }): string {
  return e.direction === 'in' ? e.from.email : (e.to?.map((t) => t.email).join(', ') ?? '');
}

/**
 * `sparrow approvals` — ONE list of everything waiting on this human, across two
 * subsystems, because the question is "what needs me?", not "which subsystem?".
 * `emailItems` is `null` when the instance has the email medium off (the caller
 * still gets the enrollment half; see the command).
 */
function formatApprovals(
  enrollments: EnrollmentSummary[],
  emailItems: EmailApprovalItem[] | null,
): string {
  const blocks: string[] = [];
  blocks.push(
    enrollments.length === 0
      ? 'Enrollments: none pending.'
      : `Enrollments (${enrollments.length}):\n${formatEnrollments(enrollments)}`,
  );
  if (emailItems === null) {
    blocks.push('Email: unavailable — email is not enabled on this server.');
  } else if (emailItems.length === 0) {
    blocks.push('Email: nothing waiting on you.');
  } else {
    blocks.push(
      `Email (${emailItems.length}):\n` +
        table(
          ['WHEN', 'AGENT', 'DIR', 'EMAIL ID', 'OTHER PARTY', 'SUBJECT', 'REASON'],
          emailItems.map((i) => [
            i.email.createdAt,
            i.agent.name,
            i.email.direction,
            i.email.id,
            emailCounterparty(i.email),
            cell(i.email.subject, 32),
            i.email.reason ?? '',
          ]),
        ),
    );
  }
  if (enrollments.length === 0 && emailItems !== null && emailItems.length === 0) {
    return 'Nothing needs you.';
  }
  return blocks.join('\n\n');
}

/**
 * One popped WORK ITEM, human-readable. Output leads with the medium so the
 * register is obvious before the body is read (SPEC → CLI "Typed work items").
 */
function formatWorkItem(item: WorkItem): string {
  switch (item.type) {
    case 'chat.message':
      return `${roomHeader(item.room)}\n${formatMessage(item.message)}`;
    case 'email':
      return formatEmail(item.email, item.thread);
  }
}

/**
 * A work item whose `type` this CLI predates. The forward-compat rule is "leave
 * it for a newer client, never error": print it raw and exit 0.
 */
function formatUnknownWorkItem(item: UnknownWorkItem): string {
  return [
    `[${item.type}] unrecognized work item — this sparrow CLI predates that medium.`,
    `Left for a newer client; nothing was done with it.`,
    JSON.stringify(item, null, 2),
  ].join('\n');
}

/** `actor → agent` on an activity entry (just the actor when they are the agent). */
function activityWho(e: ActivityEntry): string {
  if (e.agent && e.actor.id !== e.agent.id) return `${e.actor.displayName} → ${e.agent.name}`;
  return e.actor.displayName;
}

/** The ref an entry points at, so `sparrow read` / `email read` can fetch the body. */
function activityRef(e: ActivityEntry): string {
  return e.refs.messageId ?? e.refs.emailId ?? e.refs.emailThreadId ?? e.refs.roomId ?? '';
}

/**
 * The interleaved timeline, oldest-first: one line per entry with time, medium
 * and who. The wire is a TRANSCRIPT — newest-first, read backward from now — so
 * this reverses for reading order, exactly as {@link formatLog} does for a room;
 * `-j` prints the raw page (with its `nextBefore`) untouched.
 *
 * A REFERENCE list, not a mailbox — entries carry typed refs, so the bodies come
 * from `sparrow read` / `sparrow email read`.
 */
function formatActivity(items: ActivityEntry[]): string {
  // An EMPTY timeline is the normal state of a workspace whose agents have not
  // started working yet — the surface is agent-anchored by design, so a human-only
  // team sees nothing here forever. "No activity." on its own read as broken, so
  // the line below says what the timeline is anchored to. Human output only: `-j`
  // prints the raw page and never this prose.
  if (items.length === 0) {
    return (
      'No activity.\n' +
      'The timeline follows your agents — it fills in once an agent joins the conversation.'
    );
  }
  return [...items]
    .reverse()
    .map((e) => {
      const ref = activityRef(e);
      const summary = e.summary ? `: ${cell(e.summary, 80)}` : '';
      return `${e.createdAt}  [${e.medium}] ${activityWho(e)}${summary}${ref ? `  (${ref})` : ''}`;
    })
    .join('\n');
}

function formatOutbox(items: Message[]): string {
  if (items.length === 0) return 'Outbox empty.';
  const bodyCell = (m: Message): string => {
    let s = m.body.replace(/\s+/g, ' ').slice(0, 40);
    if (m.inReplyTo) s = `↩ ${s}`;
    if (m.suggestedReplies.length > 0) s = `${s} [+${m.suggestedReplies.length} suggested]`;
    return s;
  };
  return table(
    ['ID', 'TO', 'KIND', 'SUBJECT', 'BODY'],
    items.map((m) => [
      m.id,
      m.to.map((t) => t.displayName).join(','),
      m.kind,
      m.subject ?? '',
      bodyCell(m),
    ]),
  );
}

/**
 * A compact chronological transcript of a room's history. The server returns
 * messages newest-first; render them oldest-first (reading order) as
 * `time  sender: body`, with a voice tag and an attachment count. Multi-line
 * bodies collapse to the first line (with an ellipsis); short bodies show whole.
 */
function formatLog(items: Message[]): string {
  if (items.length === 0) return 'No messages.';
  return [...items]
    .reverse()
    .map((m) => {
      const voice = m.origin === 'voice' ? ' [voice]' : '';
      const firstLine = m.body.split('\n')[0] ?? '';
      const body = firstLine.length < m.body.length ? `${firstLine} …` : firstLine;
      const n = m.attachments.length;
      const att = n > 0 ? ` (${n} attachment${n === 1 ? '' : 's'})` : '';
      return `${m.createdAt}  ${m.from.displayName}${voice}: ${body}${att}`;
    })
    .join('\n');
}

function formatMessageStatus(s: MessageStatus): string {
  const head = `message ${s.id} (${s.kind}) — sent ${s.createdAt}`;
  const rows = table(
    ['RECIPIENT', 'STATUS', 'RECEIVED AT', 'READ AT'],
    s.recipients.map((r) => [r.displayName, r.status, r.receivedAt ?? '', r.readAt ?? '']),
  );
  return `${head}\n${rows}`;
}

function formatOneStatus(s: MemberStatus): string {
  const scope = s.to ? `→ ${s.to.displayName}` : 'room-wide';
  const lifetime = s.sticky ? 'sticky' : `until ${s.expiresAt}`;
  return `working ${scope}${s.note ? ` — ${s.note}` : ''} (${lifetime})`;
}

function formatStatusList(res: ListStatusesResponse): string {
  const online = `online: ${res.presence.online.length === 0 ? '(none)' : res.presence.online.join(', ')}`;
  if (res.items.length === 0) return `No active statuses.\n${online}`;
  const rows = table(
    ['MEMBER', 'STATE', 'NOTE', 'TO', 'EXPIRES'],
    res.items.map((s) => [
      s.displayName,
      s.state,
      s.note ?? '',
      s.to?.displayName ?? '(room)',
      s.sticky ? 'sticky' : (s.expiresAt ?? ''),
    ]),
  );
  return `${rows}\n${online}`;
}

function formatRoomInvitations(items: RoomInvitation[]): string {
  if (items.length === 0) return 'No room invitations.';
  return table(
    ['ID', 'ROOM', 'ORG', 'INVITED BY', 'CREATED'],
    items.map((i) => [i.id, i.room.name, i.room.orgId, i.invitedBy.displayName, i.createdAt]),
  );
}

/**
 * Render server hints as ORDINARY HUMAN OUTPUT — the lines that follow
 * `Inbox empty.` at the end of a drain, and the body of `sparrow tips`.
 *
 * Two rules decided this shape. **The right time is between tasks**: a hint
 * rides exactly one response, the `{ item: null }` pop, so printing it is a
 * normal part of that command's output rather than an interjection — no stderr
 * channel, nothing to filter, nothing that looks like a warning. **The right
 * channel is the one the agent chose**: under `-j` the hint is already inside
 * the `{ item: null, hints }` envelope the caller asked for, so nothing extra is
 * printed there; a machine reading JSON gets JSON.
 *
 * One line per hint, plus the action (a runnable next call, `exampleBody`
 * included) and the docs URL when the hint carries them. The CLI never dedupes
 * or suppresses — the server's cooldown owns frequency.
 */
function formatHints(hints: Hint[] | undefined): string[] {
  const lines: string[] = [];
  for (const h of hints ?? []) {
    lines.push(`[hint] ${h.id}: ${h.text}`);
    if (h.action) {
      const body = h.action.exampleBody ? ` ${JSON.stringify(h.action.exampleBody)}` : '';
      lines.push(`[hint]   -> ${h.action.method} ${h.action.path}${body}`);
    }
    if (h.docs) lines.push(`[hint]   docs: ${h.docs}`);
  }
  return lines;
}

/** `sparrow tips` when the engine has nothing to say — an answer, not silence. */
const NO_TIPS_MESSAGE = "Nothing right now — you're set up well.";

function formatEvent(e: SparrowEvent): string {
  return `[${e.type}] ${JSON.stringify(e.data)}`;
}

function formatMeEvent(e: PrincipalEvent): string {
  // `activity.appended` is the live half of the timeline (principal-level, so
  // never wrapped in a room): render it as the timeline line it will become,
  // not as a JSON blob.
  if (e.type === 'activity.appended') {
    const { entry } = e.data as ActivityAppendedEvent;
    const ref = activityRef(entry);
    const summary = entry.summary ? `: ${cell(entry.summary, 80)}` : '';
    return `[activity] ${entry.type}  ${activityWho(entry)}${summary}${ref ? `  (${ref})` : ''}`;
  }
  const label = e.room ? `[${roomLabel(e.room)}] ` : '';
  return `${label}${formatEvent(e)}`;
}

function dmSummary(dm: EnsureDmResult): string {
  const verb = dm.created ? 'Opened' : 'Using';
  return `${verb} DM ${dm.room.id} with @${dm.counterpart.displayName} (${dm.counterpart.id}).`;
}

/**
 * `sparrow agent-dms` — the caller's agent↔agent DM oversight boxes, newest
 * activity first (server order). One line per box: the room id LEADS so
 * `sparrow agent-dms read <roomId>` is a copy-paste away, then the unordered
 * pair as `a ↔ b` and the collapsed preview of the newest line. Ambient by
 * design — no unread column ever appears here, and reading marks nothing.
 * `lastMessage` is null only for the degenerate empty-room case (the server
 * skips those today); rendered honestly rather than dropped.
 */
function formatAgentDms(items: AgentDmBox[]): string {
  if (items.length === 0) return 'No agent↔agent conversations are visible to you.';
  return items
    .map((b) => {
      const pair = `${b.agents[0].name} ↔ ${b.agents[1].name}`;
      const last = b.lastMessage
        ? `${cell(b.lastMessage.preview, 60)}  (${b.lastMessage.at})`
        : '(no messages)';
      return `${b.roomId}  ${pair} — ${last}`;
    })
    .join('\n');
}

/**
 * The one line every credential-writing command prints about `defaultProfile`.
 *
 * A machine hosting three agents under one unix user shares ONE credentials.json,
 * so "which profile do bare commands use?" is load-bearing state that nobody may
 * change by accident. When this save left the default alone, the line says so AND
 * says how to address the profile just written — otherwise the agent would go on
 * running as its neighbour without noticing.
 */
function defaultProfileNote(r: SaveProfileResult): string {
  if (r.defaultProfile === r.name) {
    return r.changed && r.previousDefault
      ? `defaultProfile: "${r.previousDefault}" → "${r.defaultProfile}"`
      : `defaultProfile: "${r.defaultProfile}"`;
  }
  return (
    `defaultProfile stays "${r.defaultProfile}" — pass --profile ${r.name} ` +
    `(or SPARROW_PROFILE=${r.name}) on commands for this workspace, or re-run with --set-default.`
  );
}

/**
 * Success banner for a completed agent enrollment. Enrolling only mints a key —
 * an agent is online only while it holds an open events stream — so the banner
 * pushes the agent to START LISTENING (`sparrow watch` holds `/me/events` open,
 * which is what flips presence to online) rather than stopping here.
 */
function enrolledMessage(
  agentName: string,
  orgName: string,
  profileName: string,
  emailAddress: string | null = null,
  defaultNote = '',
): string {
  return [
    `You are ${agentName} in ${orgName}.`,
    // When the delivery carries an address, the very FIRST thing the agent learns
    // about its second medium is that it HAS one (SPEC → CLI, enroll banner).
    ...(emailAddress ? [`People outside ${orgName} can reach you at ${emailAddress}.`] : []),
    `Saved profile "${profileName}".`,
    ...(defaultNote ? [defaultNote] : []),
    ``,
    `Enrollment is complete — but you are NOT online yet. You are online only while you`,
    `hold an open events stream. Start listening now and keep it running:`,
    ``,
    `  sparrow watch          # streams events and is what marks you ONLINE`,
    ``,
    `Come online FIRST: start \`sparrow watch\` before you report back to your human, then say`,
    `"I'm online" (as a \`sparrow send\`). Never leave a gap where you're enrolled but dark.`,
    `Handle each message as it arrives (reply with \`sparrow send\`), and run \`sparrow inbox\``,
    `to catch anything already waiting.`,
    ``,
    `You installed the CLI, so \`sparrow watch\`/\`send\` are now your main line in. To lean on`,
    `sparrow for everything, add \`sparrow skill install\` so a Stop hook keeps your loop alive.`,
    `Not happy with the name? Change it anytime with \`sparrow rename <name>\`.`,
  ].join('\n');
}

/**
 * The `sparrow rename` report. With the email medium enabled an agent's address
 * is derived from its name and never aliased, so a rename MOVES the mailbox:
 * print the old and the new address and warn, on one line, that mail to the old
 * one bounces (SPEC → CLI, `sparrow rename`). Until the medium exists both
 * addresses are null and this stays the v3 one-liner.
 */
function formatRenamed(
  shown: string,
  oldAddress: string | null,
  newAddress: string | null,
): string {
  const lines = [`Renamed to “${shown}”.`];
  if (newAddress && oldAddress && oldAddress !== newAddress) {
    lines.push(
      `Your email address changed: ${oldAddress} → ${newAddress}.`,
      `Mail sent to ${oldAddress} will now BOUNCE (addresses are derived from your ` +
        `name, never aliased) — tell your correspondents before they write again.`,
    );
  } else if (newAddress) {
    lines.push(`People outside your org can reach you at ${newAddress}.`);
  }
  return lines.join('\n');
}

/** Parse a `--suggest "LABEL[=VALUE]"` token; split on the FIRST `=`. */
function parseSuggest(token: string): { label: string; value?: string } {
  const eq = token.indexOf('=');
  if (eq === -1) return { label: token };
  return { label: token.slice(0, eq), value: token.slice(eq + 1) };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function readStdin(io: CliIO): Promise<string> {
  if (io.stdin !== undefined) return io.stdin;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Remember an INBOUND message as the active profile's "last inbound" so
 * `sparrow reply` can target its sender with no id copy-paste. Best-effort: skips
 * when there is no named profile (e.g. a bare `SPARROW_TOKEN`) and never throws.
 */
function recordInbound(env: Env, opts: GlobalOpts, msg: Message, roomId: string): void {
  const name = activeProfileName(opts, env);
  if (!name) return;
  const lastInbound: LastInbound = {
    messageId: msg.id,
    roomId,
    senderMemberId: msg.from.id,
  };
  try {
    updateProfileState(env, name, { lastInbound });
  } catch {
    /* state is a convenience — never fail the command over it */
  }
}

/**
 * Remember an inbound EMAIL as the profile's "last email" so `sparrow email
 * reply` can answer its thread with no id copy-paste. Deliberately a SEPARATE
 * pointer from {@link recordInbound}: a popped email must never re-target
 * `sparrow reply`, which always answers chat.
 */
function recordEmail(env: Env, opts: GlobalOpts, email: { id: string; threadId: string }): void {
  const name = activeProfileName(opts, env);
  if (!name) return;
  try {
    updateProfileState(env, name, { lastEmail: { emailId: email.id, threadId: email.threadId } });
  } catch {
    /* state is a convenience — never fail the command over it */
  }
}

/**
 * Run `cmd` (via the shell) with the payload JSON on stdin; resolve when it
 * exits. `label` names the unit of work in the nonzero-exit log — a message id
 * for a room drain, a work item's id for the medium-spanning one.
 */
function runExec(cmd: string, payload: unknown, io: CliIO, label: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (err) => {
      io.err(`exec error: ${(err as Error).message}\n`);
      resolve();
    });
    child.on('close', (code) => {
      if (code) io.err(`exec: handler exited ${code} (${label}); continuing.\n`);
      resolve();
    });
    child.stdin.on('error', () => {
      /* handler may not read stdin */
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

/**
 * Run `cmd` (via the shell) the moment enrollment completes — the enroll `--exec`
 * hook. Mirrors {@link runExec}'s spawn, but inherits stdin too (there is no
 * per-item payload) and RESOLVES WITH THE EXIT CODE so the caller can propagate a
 * nonzero handler exit as the enroll exit code — loop's per-item runExec swallows
 * a nonzero exit to keep looping; enroll must surface it instead. Rejects only
 * when the shell fails to spawn at all.
 */
function runEnrollExec(cmd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: 'inherit' });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * Map a 401 from an authenticated command into a profile-aware {@link CliError}: a
 * dead, revoked, or wrong-identity credential otherwise surfaces as a bare
 * "Invalid agent key" that names neither the offending profile nor a way out. Any
 * non-401 error passes through unchanged.
 */
/**
 * A `426 client_upgrade_required` from the server's client-version gate: this
 * build is below the floor the server enforces. Unlike every other stream
 * failure it is NOT transient — retrying re-sends the same version header — so
 * `watch`/`loop` treat it as fatal instead of reconnect-looping (and holding a
 * presence that can never receive anything).
 */
function isUpgradeRequired(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 426 || e.code === 'client_upgrade_required');
}

/**
 * Guarantee the 426 an agent sees names the way out. The server's envelope
 * normally says it already; when it doesn't, append the action. Kept an
 * {@link ApiError} so `-j` still reports `client_upgrade_required`.
 */
function explainUpgradeRequired(e: unknown): unknown {
  if (!isUpgradeRequired(e)) return e;
  const err = e as ApiError;
  if (/sparrow upgrade/i.test(err.message)) return err;
  return new ApiError({
    code: err.code,
    status: err.status,
    message: `${err.message} — this CLI is below the server's minimum: run \`sparrow upgrade\`.`,
  });
}

/**
 * What a dead invite says when the SERVER didn't say anything useful — an older
 * server answers every unknown/revoked/expired token with a flat
 * `404 {"code":"not_found","message":"Not found"}`, which tells the human
 * holding the link nothing at all.
 */
const INVITE_DEAD_FALLBACK =
  'This invite link is not valid, or it has expired or been revoked. ' +
  'Ask whoever invited you for a new link.';

/**
 * `POST /invite/:token/enroll` refusing the token — the most common first-run
 * failure there is. The server now distinguishes the cases (`404 not_found` for
 * an unknown token, `410 gone` for revoked/expired) and its sentence is written
 * for the person holding the link, so it passes through verbatim; only a missing
 * or generic "Not found" is replaced. The error stays an {@link ApiError} with
 * the original `code`/`status` so `-j` still reports what the server actually
 * said, and a trailing line names the invite that failed (a harness often has
 * several in flight).
 */
function explainDeadInvite(e: unknown, target: string): unknown {
  if (!(e instanceof ApiError)) return e;
  if (e.status !== 404 && e.status !== 410) return e;
  const said = e.message.trim();
  const useful = said !== '' && !/^not found\.?$/i.test(said);
  return new ApiError({
    code: e.code,
    status: e.status,
    message: `${useful ? said : INVITE_DEAD_FALLBACK}\nInvite: ${target}`,
  });
}

function explainAuthError(e: unknown, opts: GlobalOpts, env: Env): unknown {
  if (e instanceof ApiError && e.status === 401) {
    const pname = activeProfileName(opts, env);
    const who = pname ? `profile "${pname}"` : 'your credentials';
    return new CliError(
      `${e.message} — ${who} is not authenticated (the key may be revoked or expired). ` +
        'Re-enroll (`sparrow enroll`) or log in again (`sparrow login`), ' +
        'or select another with `--profile <name>`.',
    );
  }
  return e;
}

/* ------------------------- client/server versions ---------------------- */

/**
 * Best-effort read of the server's advertised version from `GET /api/v1/meta`
 * (unauthenticated, never gated). Returns undefined on any failure — the caller
 * (the `whoami` skew note) stays silent when it can't tell.
 */
async function fetchServerVersion(server: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/v1/meta`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { server?: { version?: string }; version?: string };
    return body?.server?.version ?? body?.version;
  } catch {
    return undefined;
  }
}

/**
 * A one-line stderr note when THIS client is meaningfully newer than the server
 * it just talked to (a minor+ gap) — a heads-up that the server may be behind.
 * Silent when versions can't be read/compared or the gap is only a patch. Returns
 * the note string (for tests) or undefined.
 */
export function serverSkewNote(clientVersion: string, serverVersion: string | undefined): string | undefined {
  if (!serverVersion) return undefined;
  if (minorVersionsAhead(clientVersion, serverVersion) < 1) return undefined;
  return `note: this client (${clientVersion}) is newer than the server (${serverVersion}) — the server may be behind.`;
}

/* ------------------------ the canonical install home ------------------------ */

/**
 * Where the client bundles come from. The installer and the docs have ONE home
 * each, independent of which instance you talk to (SPEC → *Canonical public
 * homes*): a per-instance installer teaches every reader a different command,
 * and instances therefore serve neither — `GET /install.sh` and `GET /install/*`
 * answer `302` here. `SPARROW_INSTALL_URL` lets a self-hoster point at their own
 * mirror (an instance URL still works: the download follows redirects).
 */
export const INSTALL_URL_DEFAULT = 'https://sparrow.land';

/** The canonical installer one-liner — the only install instruction the CLI prints. */
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL_DEFAULT}/install.sh | sh`;

/**
 * Resolve the install home for this run: `SPARROW_INSTALL_URL` when set to
 * something non-blank, else the canonical home. Trailing slashes are stripped so
 * callers can join paths naively. The active profile's `server` is deliberately
 * NOT consulted.
 */
export function installBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env.SPARROW_INSTALL_URL?.trim();
  return (raw && raw.length > 0 ? raw : INSTALL_URL_DEFAULT).replace(/\/+$/, '');
}

/* -------------------------- the email medium --------------------------- */

/**
 * The ONE sentence a sparrow CLI ever says about an instance without the email
 * medium. The CLI must never pretend the medium exists (SPEC → CLI, the
 * email-disabled rule), so no email command degrades into a half-answer.
 */
const EMAIL_DISABLED = 'email is not enabled on this server';

/**
 * Is the medium off on this server? `GET /capabilities` is the AUTHORITY — a
 * `404` from an email route is not, because that is also what an unknown or
 * foreign id returns. Unauthenticated and cheap; a failure to reach it answers
 * "no" so a network blip never mislabels a real error as "not enabled".
 */
async function emailMediumOff(client: SparrowClient): Promise<boolean> {
  try {
    return (await client.getCapabilities()).email === false;
  } catch {
    return false;
  }
}

/**
 * Run one email-route call, translating the medium's OFF state into
 * {@link EMAIL_DISABLED}. Every `/me/email/*` and `/orgs/:orgId/email/*` route
 * `404`s when the medium is unconfigured — but so does an unknown thread id, so
 * capabilities is consulted only AFTER a 404, and only to decide which of the
 * two truths to tell. Costs nothing on the happy path.
 */
async function emailCall<T>(client: SparrowClient, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && (await emailMediumOff(client))) {
      throw new CliError(EMAIL_DISABLED);
    }
    throw e;
  }
}

/**
 * Whose mailbox an `sparrow email` command acts on.
 *
 * An AGENT profile IS a mailbox: its mail hangs off its own principal
 * (`/me/email/*`), so it needs neither `--room` nor `--org`, and `--agent` can
 * only ever name itself. A HUMAN profile owns no address — it reaches one of its
 * agents' mailboxes through the org routes, named by `--agent` (automatic when
 * the human owns exactly one agent with email).
 */
type EmailTarget =
  | { kind: 'agent' }
  | { kind: 'human'; orgId: string; agentId: string; agentName: string };

/**
 * Open `$EDITOR` on a temp file and return what the human wrote. Deliberately
 * tiny and tightly guarded: it runs ONLY when there is no positional body, no
 * `--stdin`, and stdin is a real TTY — which never holds for an in-process
 * `runCli`, so this path is out of reach of the test suite by construction.
 */
function editorBody(env: Env): string {
  const editor = env.EDITOR ?? env.VISUAL;
  if (!editor) {
    throw new CliError('No message body. Pass it as an argument, use --stdin, or set $EDITOR.');
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-mail-')), 'message.txt');
  fs.writeFileSync(file, '');
  const res = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
  if (res.status !== 0) throw new CliError(`$EDITOR (${editor}) exited ${res.status}; nothing sent.`);
  const body = fs.readFileSync(file, 'utf8');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (body.trim() === '') throw new CliError('Empty message body; nothing sent.');
  return body;
}

/* ----------------------------- clawback -------------------------------- */

/**
 * The caller's last {@link CLAWBACK_WINDOW} messages in `roomId`, NEWEST first.
 * `GET /rooms/:id/outbox` pages ASCENDING, so walk to the final page keeping a
 * rolling tail — only the last window can be clawback-eligible anyway.
 */
async function ownOutboxTail(client: SparrowClient, roomId: string): Promise<Message[]> {
  let cursor: string | undefined;
  let tail: Message[] = [];
  for (let page = 0; page < 200; page++) {
    const res = await client.listOutbox(roomId, { limit: 100, cursor });
    tail = [...tail, ...res.items].slice(-CLAWBACK_WINDOW);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return tail.reverse();
}

/**
 * Name the server's clawback refusal in one line (SPEC "Clawback"): `409` for a
 * message someone already READ, one outside the sender's last
 * {@link CLAWBACK_WINDOW}, or one already clawed back; `404` for anything that
 * is not the caller's own message in the room. Matches on the error CODE first
 * and falls back to the message text, so either envelope style reads the same;
 * an unrecognized refusal passes through untouched (the server's line is honest).
 */
function clawbackReason(e: ApiError): string | undefined {
  const probe = `${e.code} ${e.message}`.toLowerCase();
  // `behind_read` BEFORE the bare 'read' probe — both contain the word.
  if (probe.includes('behind_read')) {
    return 'a newer message of yours was already read — clawback stops at the first read message';
  }
  if (probe.includes('read')) return 'a recipient has already read it';
  if (probe.includes('window') || probe.includes('recent')) {
    return `it is not among your last ${CLAWBACK_WINDOW} messages in this room`;
  }
  if (probe.includes('claw')) return 'it was already clawed back';
  return undefined;
}

/** True for the one refusal a no-arg walk may skip: this row was already clawed. */
function isAlreadyClawedBack(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && `${e.code} ${e.message}`.toLowerCase().includes('claw');
}

/** Map a clawback refusal to a clear one-liner naming the message and the reason. */
function explainClawbackRefusal(e: unknown, messageId: string): unknown {
  if (!(e instanceof ApiError)) return e;
  if (e.status === 404) {
    return new ApiError({
      code: e.code,
      status: e.status,
      message: `Cannot claw back ${messageId} — it is not your own message in this room (or it no longer exists).`,
    });
  }
  const why = e.status === 409 ? clawbackReason(e) : undefined;
  if (why) {
    return new ApiError({
      code: e.code,
      status: e.status,
      message: `Cannot claw back ${messageId} — ${why}.`,
    });
  }
  return e;
}

/* ------------------------------ runCli --------------------------------- */

export async function runCli(argv: string[], env: Env = process.env, io: CliIO = defaultIO): Promise<number> {
  const ctx = { json: false, exitCode: 0 };

  const print = (data: unknown, human: string): void => {
    if (ctx.json) io.out(`${JSON.stringify(data, null, 2)}\n`);
    else io.out(`${human}\n`);
  };

  const printError = (e: unknown): void => {
    const err = e as { code?: unknown; message?: string };
    const code = e instanceof ApiError ? String(e.code) : e instanceof CliError ? 'cli_error' : 'error';
    const message = err?.message ?? String(e);
    if (ctx.json) io.err(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`Error: ${message}\n`);
  };

  const action =
    (handler: (opts: GlobalOpts & Record<string, unknown>, args: string[]) => Promise<void>) =>
    async (...cbArgs: unknown[]): Promise<void> => {
      const command = cbArgs[cbArgs.length - 1] as Cmd;
      const args = cbArgs.slice(0, cbArgs.length - 2) as string[];
      const opts = command.optsWithGlobals() as GlobalOpts & Record<string, unknown>;
      ctx.json = Boolean(opts.json);
      try {
        await handler(opts, args);
      } catch (e) {
        ctx.exitCode = 1;
        // One place, every command: a client-version rejection always prints the
        // upgrade path (`pop`/`send` included), never a bare 426.
        printError(explainUpgradeRequired(e));
      }
    };

  const program = new Command();
  program
    .name('sparrow')
    .description('sparrow command-line client')
    .version(clientBuildVersion())
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });

  /* -------- shared option groups -------- */
  const withCommon = (cmd: Cmd): Cmd =>
    cmd
      .option('-j, --json', 'output machine-readable JSON')
      .option('--profile <name>', 'credential profile to use')
      .option('--server <url>', 'server URL override');

  // The three connective options are also accepted in the GLOBAL position, before
  // the command name — `sparrow --profile deploy-bot send hi` is the shape people
  // reach for when the profile is the subject of the sentence, and it used to die
  // with a bare "unknown option '--profile'" naming a flag that plainly exists.
  // `optsWithGlobals()` already merges parents, so every handler sees them either
  // way; commander omits an unset option entirely, so the global copy only wins
  // when it was actually typed.
  withCommon(program);
  const withRoom = (cmd: Cmd): Cmd =>
    withCommon(cmd).option('--room <roomId|name>', 'the room to act in (or SPARROW_ROOM)');
  const withOrg = (cmd: Cmd): Cmd =>
    withCommon(cmd).option('--org <orgId|slug>', 'the org to act in (or SPARROW_ORG)');
  /**
   * The listener trio's shared quiet knobs (`await`/`watch`/`loop`) — see
   * {@link listenerQuiet}. Both axes default to QUIET: a listener should print
   * what the agent is listening FOR, not what the runtime is doing.
   */
  const withListener = (cmd: Cmd): Cmd =>
    cmd
      .option(
        '-v, --verbose',
        'print routine lifecycle lines too (reconnects, stream refreshes, reconcile-poll failures); ' +
          'anomalies — replay gaps, a terminal 426, exhausted retries — always print. No effect on -j output',
      )
      .option(
        '--with-presence',
        '(no --room) also receive presence.changed; filtered out at subscription time by default',
      )
      .option(
        '--with-status',
        '(no --room) also receive status.changed; filtered out at subscription time by default',
      );

  /* ============================ login ============================ */
  withCommon(program.command('login'))
    .description('log in as a human (email + password prompt); stores a ses_ session profile')
    .option('--email <email>', 'account email (prompted when omitted)')
    .option('--set-default', 'also make this profile the default for bare commands')
    .action(
      action(async (opts) => {
        const server = opts.server ?? env.SPARROW_SERVER;
        if (!server) throw new CliError('login requires --server <url> (or SPARROW_SERVER).');
        let email = (opts.email as string | undefined) ?? env.SPARROW_EMAIL;
        let password = env.SPARROW_PASSWORD;
        try {
          if (!email) {
            if (!io.prompt) throw new CliError('No prompt available; pass --email.');
            email = (await io.prompt('Email: ')).trim();
          }
          if (!password) {
            if (!io.prompt) throw new CliError('No prompt available; set SPARROW_PASSWORD.');
            password = await io.prompt('Password: ', { hidden: true });
          }
        } finally {
          // Both answers are in (or the prompt gave up): release the stdin reader
          // so nothing holds the event loop open past the command.
          closePrompt(io.prompt);
        }
        const client = new SparrowClient({ server, clientIdent: CLI_CLIENT_IDENT });
        const res = await client.login({ email, password });
        const name = (opts.profile as string | undefined) ?? email;
        const saved = saveProfile(
          env,
          name,
          { server, token: res.token, kind: 'human' },
          { setDefault: Boolean(opts.setDefault) },
        );
        print(
          { user: res.user, profile: name, defaultProfile: saved.defaultProfile, server },
          `Logged in as ${res.user.displayName} (${res.user.email}).\n` +
            `Saved profile "${name}". ${defaultProfileNote(saved)}\n` +
            `Try \`sparrow whoami\`.`,
        );
      }),
    );

  /* ============================ login-agent ============================ */
  withCommon(program.command('login-agent'))
    .description('store an agent-key (agk_) credential profile')
    .argument('<agkKey>', 'the agk_ agent key (shown once at mint/rotation)')
    .option('--set-default', 'also make this profile the default for bare commands')
    .action(
      action(async (opts, args) => {
        const token = args[0]!;
        if (!token.startsWith('agk_')) {
          throw new CliError('login-agent expects an `agk_…` agent key.');
        }
        const server = opts.server ?? env.SPARROW_SERVER;
        if (!server) throw new CliError('login-agent requires --server <url> (or SPARROW_SERVER).');
        const client = new SparrowClient({ server, token, clientIdent: CLI_CLIENT_IDENT });
        const me = await client.me();
        if (me.type !== 'agent') throw new CliError('That key does not resolve to an agent.');
        const name = (opts.profile as string | undefined) ?? me.name;
        const saved = saveProfile(
          env,
          name,
          { server, token, kind: 'agent' },
          { setDefault: Boolean(opts.setDefault) },
        );
        print(
          { principal: me, profile: name, defaultProfile: saved.defaultProfile, server },
          `You are agent ${me.name} (${me.id}) in org ${me.orgId}.\n` +
            `Saved profile "${name}". ${defaultProfileNote(saved)}`,
        );
      }),
    );

  /* ============================ enroll ============================ */
  // The instructive line printed (to stderr) while enroll blocks on approval. It
  // is deliberately more than "Waiting…": the agent should run enroll as a tracked
  // BACKGROUND TASK and treat its exit as the go-signal, because the human approves
  // from the Sparrow window and may never look at the terminal again.
  const WAITING_FOR_APPROVAL_MSG =
    'Waiting for approval… (leave this running as a background task — when it exits 0 you are ' +
    "enrolled; your human approves from the Sparrow window, so report there once you're online)\n";

  // Poll a pending agent enrollment until it resolves, times out, or is
  // interrupted. Honors retryAfterSeconds (SPARROW_POLL_INTERVAL_MS overrides it).
  // The polling itself lives in harness/enroll-flow.ts — `sparrow harness --url`
  // follows the same invite and must not drift from this command.
  const waitForEnrollment = (
    client: SparrowClient,
    ref: { inviteToken: string; enrollmentId: string; enrollmentToken: string },
    timeoutMs: number,
  ): Promise<PollEnrollmentResponse | EnrollmentTimeout> =>
    pollEnrollmentUntilResolved(client, ref, timeoutMs, env);

  // Save an approved agent enrollment as a default profile + report it. The
  // write (and its "the key is shown exactly once" guards) is shared with the
  // harness; only the report below belongs to `sparrow enroll`.
  const saveApprovedAgent = (pending: PendingEnrollment, poll: PollEnrollmentResponse): void => {
    const { agent, org, dmRoomId, saved } = saveApprovedProfile(env, pending, poll);
    print(
      {
        agent,
        org,
        dmRoomId,
        profile: pending.profileName,
        defaultProfile: saved.defaultProfile,
      },
      enrolledMessage(
        agent.name,
        org.name,
        pending.profileName,
        agent.emailAddress,
        defaultProfileNote(saved),
      ),
    );
  };

  const resolvePendingEnrollment = async (pending: PendingEnrollment, timeoutMs: number): Promise<void> => {
    const client = new SparrowClient({ server: pending.server, clientIdent: CLI_CLIENT_IDENT });
    const poll = await waitForEnrollment(
      client,
      {
        inviteToken: pending.inviteToken,
        enrollmentId: pending.enrollmentId,
        enrollmentToken: pending.enrollmentToken,
      },
      timeoutMs,
    );
    if (poll.status === 'timeout') {
      // Two different truths wear the same exit code. "Still waiting" claims the
      // server told us it was still pending; when we never reached it at all,
      // say THAT — and still name the recovery, because the request really is
      // saved and `--resume` really does pick it back up.
      if (poll.unreachable) {
        throw new CliError(
          `Lost contact with the server while waiting for approval (${poll.lastError ?? 'unreachable'}). ` +
            'Your request is saved — run `sparrow enroll --resume` to keep waiting.',
        );
      }
      throw new CliError(
        'Still waiting for approval. The request is saved — run `sparrow enroll --resume` to keep waiting.',
      );
    }
    if (poll.status === 'denied') {
      clearPending(env);
      throw new CliError('Your enrollment request was denied.');
    }
    saveApprovedAgent(pending, poll);
  };

  withCommon(program.command('enroll'))
    .description('follow an invite URL to enroll an agent; waits for approval')
    .argument('[inviteUrl]', 'the invite URL ({BASE_URL}/invite/<token>)')
    .option('--name <name>', 'agent name (default {host}-{folder}, or SPARROW_NAME)')
    .option('--note <note>', 'a note shown to approvers')
    .option('--resume', 'resume waiting on a stored pending enrollment')
    .option(
      '--set-default',
      'make this profile the default for bare commands (otherwise an existing default is kept)',
    )
    .option('--exec <cmd>', "run a command the moment enrollment completes (e.g. --exec 'sparrow watch')")
    .option('--timeout <seconds>', 'max seconds to wait for approval (default 600)', (v) =>
      Number.parseInt(v, 10),
    )
    .addHelpText(
      'after',
      [
        '',
        'Several agents on one machine share one credentials.json. An explicit --profile',
        'never moves defaultProfile: it is set by the FIRST enrollment on the machine, or by',
        '--set-default. Otherwise pass --profile <name> (or export SPARROW_PROFILE=<name>) on',
        'the commands for this workspace.',
      ].join('\n'),
    )
    .action(
      action(async (opts, args) => {
        const timeoutMs = ((opts.timeout as number | undefined) ?? 600) * 1000;

        // On successful enrollment (instant admit OR approval), run the --exec
        // handler via the shell, propagating a nonzero handler exit as the enroll
        // exit code. Only reached after the profile is saved and the banner printed.
        const runPostEnrollExec = async (): Promise<void> => {
          const cmd = opts.exec as string | undefined;
          if (!cmd) return;
          if (!ctx.json) io.err(`enrollment complete — running --exec: ${cmd}\n`);
          let code: number;
          try {
            code = await runEnrollExec(cmd);
          } catch (e) {
            throw new CliError(`--exec failed to start (${cmd}): ${(e as Error).message}`);
          }
          if (code !== 0) throw new CliError(`--exec command exited ${code} (${cmd}).`);
        };

        if (opts.resume) {
          const pending = loadPending(env);
          if (!pending) throw new CliError('No pending enrollment to resume. Run `sparrow enroll <url>` first.');
          if (!ctx.json) io.err(WAITING_FOR_APPROVAL_MSG);
          await resolvePendingEnrollment(pending, timeoutMs);
          await runPostEnrollExec();
          return;
        }

        const target = args[0];
        if (!target) throw new CliError('enroll requires an invite URL (or use --resume).');
        const { token: inviteToken, server } = parseInviteUrl(target, opts.server ?? env.SPARROW_SERVER);
        const name =
          (opts.name as string | undefined) ?? env.SPARROW_NAME ?? deriveDefaultAgentName();

        // Resolve the profile name to write the approved key under. An EXPLICIT
        // `--profile` is honored verbatim (the caller named it): if a profile
        // already exists under that name we OVERWRITE it, with a one-line notice —
        // silently saving to `name-2` and making THAT default (the old behavior)
        // drops the key somewhere other than where the caller asked. Only the
        // implicit default-name path auto-suffixes, so we never clobber a profile
        // the user never named.
        const resolveProfileName = (): string => {
          const explicit = opts.profile as string | undefined;
          const existing = loadCredentials(env).profiles;
          if (explicit) {
            if (explicit in existing && !ctx.json) {
              io.err(`Replacing existing profile "${explicit}".\n`);
            }
            return explicit;
          }
          return dedupeProfileName(name, existing);
        };

        const client = new SparrowClient({ server, clientIdent: CLI_CLIENT_IDENT });
        let res: Awaited<ReturnType<SparrowClient['enrollAgent']>>;
        try {
          res = await client.enrollAgent(inviteToken, {
            name,
            note: opts.note as string | undefined,
          });
        } catch (e) {
          throw explainDeadInvite(e, target);
        }

        if (res.status === 'admitted') {
          const profileName = resolveProfileName();
          const saved = saveProfile(
            env,
            profileName,
            { server, token: res.key, kind: 'agent' },
            { setDefault: Boolean(opts.setDefault) },
          );
          clearPending(env);
          print(
            {
              agent: res.agent,
              org: res.org,
              dmRoomId: res.dmRoomId,
              profile: profileName,
              defaultProfile: saved.defaultProfile,
            },
            enrolledMessage(
              res.agent.name,
              res.org.name,
              profileName,
              res.agent.emailAddress,
              defaultProfileNote(saved),
            ),
          );
          await runPostEnrollExec();
          return;
        }

        // Held for approval (202): persist the pending record, then wait.
        const profileName = resolveProfileName();
        const pending: PendingEnrollment = {
          server,
          inviteToken,
          enrollmentId: res.enrollment.id,
          enrollmentToken: res.enrollmentToken,
          name,
          profileName,
          setDefault: Boolean(opts.setDefault),
        };
        savePending(env, pending);
        if (!ctx.json) io.err(WAITING_FOR_APPROVAL_MSG);
        await resolvePendingEnrollment(pending, timeoutMs);
        await runPostEnrollExec();
      }),
    );

  /* ============================ whoami ============================ */
  withCommon(program.command('whoami'))
    .description('show your own principal (GET /me)')
    .action(
      action(async (opts) => {
        const { client, server } = buildClient(opts, env);
        let me: MePrincipal;
        try {
          me = await client.me();
        } catch (e) {
          throw explainAuthError(e, opts, env);
        }
        const name = activeProfileName(opts, env);
        const st = name ? getProfileState(env, name) : {};
        const defaults = { room: st.defaultRoom ?? null, org: st.defaultOrg ?? null };
        const human =
          `${formatPrincipal(me)}\n` +
          `defaultRoom: ${defaults.room ?? '(none)'}\n` +
          `defaultOrg:  ${defaults.org ?? '(none)'}\n` +
          formatPresence(me);
        print({ ...me, defaults }, human);
        // Bidirectional skew: whoami is a cheap, natural spot to compare this
        // client to the server (a single extra unauthenticated meta call, only
        // here — never on every command). A one-line stderr note when the client
        // is newer than the server by a minor+; silent otherwise / on failure.
        const note = serverSkewNote(clientBuildVersion(), await fetchServerVersion(server));
        if (note) io.err(`${note}\n`);
      }),
    );

  /* ============================ rename ============================ */
  withCommon(program.command('rename'))
    .description('rename yourself (agent self-rename via PATCH /me)')
    .argument('<newName>', 'the new name (1–60 chars, lowercase and email-safe; org-unique)')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const name = args[0]!;
        try {
          // An agent's address is DERIVED from its name and never aliased, so a
          // rename silently moves the mailbox. Read the old address first (cheap,
          // best-effort) so the warning can name both sides of the move.
          let oldAddress: string | null = null;
          try {
            const before = await client.me();
            if (before.type === 'agent') oldAddress = before.emailAddress;
          } catch {
            /* the rename itself is the command — never fail it over the preamble */
          }
          const me = await client.updateMe({ name });
          const shown = me.type === 'agent' ? me.name : name;
          const newAddress = me.type === 'agent' ? me.emailAddress : null;
          print(me, formatRenamed(shown, oldAddress, newAddress));
        } catch (e) {
          // A name already taken in the org comes back as 409 — surface the
          // server's suggestion to pick another, verbatim.
          if (e instanceof ApiError && e.status === 409) {
            throw new CliError(e.message);
          }
          throw e;
        }
      }),
    );

  /* ============================ role ============================ */
  // An agent's persistent job description: a `roleTitle` (org-visible) and
  // `roleInstructions` (private to the owner + the agent). `role` shows the
  // caller's own; `role set` writes it via PATCH /me. Agent-only.
  const roleCmd = withCommon(program.command('role'))
    .description('show your role (agent job description; see `role set` to change it)')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        let me: MePrincipal;
        try {
          me = await client.me();
        } catch (e) {
          throw explainAuthError(e, opts, env);
        }
        if (me.type !== 'agent') {
          throw new CliError('Only an agent has a role; sign in as an agent to view it.');
        }
        print(me, formatRole(me));
      }),
    );

  withCommon(roleCmd.command('set'))
    .description('set or clear your role (title + private instructions)')
    .option('--title <title>', 'the org-visible role title (≤60 chars)')
    .option('--instructions <text>', 'the private markdown instructions')
    .option('--instructions-file <path>', 'read the private instructions from a file')
    .option('--none', 'clear the whole role (both title and instructions)')
    .action(
      action(async (opts) => {
        const title = opts.title as string | undefined;
        const instructions = opts.instructions as string | undefined;
        const instructionsFile = opts.instructionsFile as string | undefined;
        const none = Boolean(opts.none);

        if (instructions !== undefined && instructionsFile !== undefined) {
          throw new CliError('Pass only one of --instructions or --instructions-file.');
        }
        if (none && (title !== undefined || instructions !== undefined || instructionsFile !== undefined)) {
          throw new CliError('--none clears the whole role; do not combine it with --title/--instructions.');
        }

        // Build the patch: --none clears both halves; otherwise send only the
        // fields the caller provided (an absent field is left untouched).
        const patch: { roleTitle?: string | null; roleInstructions?: string | null } = {};
        if (none) {
          patch.roleTitle = null;
          patch.roleInstructions = null;
        } else {
          if (title !== undefined) patch.roleTitle = title;
          if (instructionsFile !== undefined) patch.roleInstructions = fs.readFileSync(instructionsFile, 'utf8');
          else if (instructions !== undefined) patch.roleInstructions = instructions;
        }
        if (Object.keys(patch).length === 0) {
          throw new CliError('Nothing to set. Pass --title and/or --instructions[-file], or --none to clear.');
        }

        const { client } = buildClient(opts, env);
        let me: MePrincipal;
        try {
          me = await client.updateMe(patch);
        } catch (e) {
          throw explainAuthError(e, opts, env);
        }
        if (me.type !== 'agent') {
          throw new CliError('Only an agent has a role; sign in as an agent to set it.');
        }
        print(me, formatRole(me));
      }),
    );

  /* ============================ orgs ============================ */
  withCommon(program.command('orgs'))
    .description('list your orgs')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const orgs = await client.meOrgs();
        print({ items: orgs }, formatOrgs(orgs));
      }),
    );

  /* ============================ rooms ============================ */
  withOrg(program.command('rooms'))
    .description('list your room memberships (--all: every room in the org, for owners/admins)')
    .option('--all', 'every room in the org, joined or not (org owner/admin only)')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        // Governance view: the org's whole room list, membership irrelevant. It
        // carries no messages — archiving a room is cleanup, not surveillance.
        if (opts.all) {
          const orgId = await resolveOrg(client, opts, env);
          const items = await client.listOrgRooms(orgId);
          print({ items }, formatOrgRooms(items));
          return;
        }
        const org = await resolveOrgOptional(client, opts, env);
        const rooms = await client.meRooms(org ? { org } : undefined);
        print({ items: rooms }, formatRooms(rooms));
      }),
    );

  /* ============================ invites ============================ */
  const invites = withOrg(program.command('invites')).description('manage org invites');
  const listInvites = action(async (opts) => {
    const { client } = buildClient(opts, env);
    const orgId = await resolveOrg(client, opts, env);
    const items = await client.listInvites(orgId);
    print({ items }, formatInvites(items));
  });
  invites.action(listInvites);
  withOrg(invites.command('list')).description('list invites').action(listInvites);
  withOrg(invites.command('create'))
    .description('create an invite (URL shown once)')
    .option('--note <note>', 'a note shown to approvers')
    .option('--days <days>', 'days until expiry (1–30)', (v) => Number.parseInt(v, 10))
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const res = await client.createInvite(orgId, {
          note: opts.note as string | undefined,
          expiresInDays: opts.days as number | undefined,
        });
        print(res, formatCreatedInvite(res));
      }),
    );
  withOrg(invites.command('revoke'))
    .description('revoke an invite')
    .argument('<inviteId>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        await client.revokeInvite(orgId, args[0]!);
        print({ ok: true, inviteId: args[0] }, `Revoked ${args[0]}.`);
      }),
    );

  /* ============================ requests (enrollments) ============================ */
  const requests = withOrg(program.command('requests')).description('review pending enrollments (approver)');
  const listRequests = action(async (opts) => {
    const { client } = buildClient(opts, env);
    const orgId = await resolveOrg(client, opts, env);
    const items = await client.listEnrollments(orgId);
    print({ items }, formatEnrollments(items));
  });
  requests.action(listRequests);
  withOrg(requests.command('list')).description('list pending enrollments').action(listRequests);
  withOrg(requests.command('approve'))
    .description('approve a pending enrollment (yes/no; the proposed name is final)')
    .argument('<enrollmentId>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        await client.approveEnrollment(orgId, args[0]!);
        print({ ok: true, enrollmentId: args[0] }, `Approved ${args[0]}.`);
      }),
    );
  withOrg(requests.command('deny'))
    .description('deny a pending enrollment')
    .argument('<enrollmentId>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        await client.denyEnrollment(orgId, args[0]!);
        print({ ok: true, enrollmentId: args[0] }, `Denied ${args[0]}.`);
      }),
    );

  /* ============================ agents ============================ */
  // `GET /me/agents` is the human VISIBILITY list — which agents may I see and
  // govern? — and that is a HUMAN concept, so the route is session-only and an
  // agent key gets a bare `401 Sign-in required` there. That error reads like
  // broken credentials rather than the wrong KIND of credential, so an agent
  // that runs `sparrow agents` learns nothing. Fail before the call instead,
  // and name the surfaces an agent legitimately resolves names from: its rooms'
  // member lists, and the DM it can open with anyone it shares a room with.
  const AGENTS_HUMAN_ONLY =
    '`sparrow agents` lists the agents visible to a signed-in human; an agent key can’t use it. ' +
    'To find another agent, use `sparrow dm <name>` (any agent you share a room with) or ' +
    '`sparrow members --room <room>`.';
  withOrg(program.command('agents'))
    .description('list agents visible to you (a signed-in HUMAN; not an agent key)')
    .action(
      action(async (opts) => {
        const { client, kind, token } = buildClient(opts, env);
        // The profile records the kind; a bare `SPARROW_TOKEN` does not, so fall
        // back to the key's own prefix (`agk_` agent key vs `ses_` session).
        const credential =
          kind ??
          (token?.startsWith('agk_') ? 'agent' : token?.startsWith('ses_') ? 'human' : undefined);
        if (credential === 'agent') throw new CliError(AGENTS_HUMAN_ONLY);
        try {
          const org = await resolveOrgOptional(client, opts, env);
          const items = await client.listAgents(org ? { org } : undefined);
          print({ items }, formatAgents(items));
        } catch (e) {
          // Detection failed (an opaque credential) and the route said no: on
          // THIS route a 401 means "not a signed-in human", so give the same
          // explanation — plus the one thing an actual human would need.
          if (e instanceof ApiError && e.status === 401 && credential !== 'human') {
            throw new CliError(
              `${AGENTS_HUMAN_ONLY} (If you are a human, your session has expired — run ` +
                '`sparrow login`.)',
            );
          }
          throw e;
        }
      }),
    );

  /* ============================ share / unshare ============================ */
  withOrg(program.command('share'))
    .description('grant a human visibility on an agent you own')
    .argument('<agent>', 'agent name or agt_ id')
    .argument('<human>', 'email or usr_ id')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const org = await resolveOrgOptional(client, opts, env);
        const agent = await resolvePrincipal(client, args[0]!, org);
        await client.shareAgent(agent.id, args[1]!);
        print(
          { ok: true, agentId: agent.id, human: args[1] },
          `Shared ${agent.name} (${agent.id}) with ${args[1]}.`,
        );
      }),
    );
  withOrg(program.command('unshare'))
    .description('revoke a human’s visibility on an agent you own')
    .argument('<agent>', 'agent name or agt_ id')
    .argument('<human>', 'email or usr_ id')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const org = await resolveOrgOptional(client, opts, env);
        const agent = await resolvePrincipal(client, args[0]!, org);
        const humanId = await resolveHumanId(client, agent.orgId, args[1]!);
        await client.unshareAgent(agent.id, humanId);
        print(
          { ok: true, agentId: agent.id, humanId },
          `Unshared ${agent.name} (${agent.id}) from ${humanId}.`,
        );
      }),
    );

  /* ============================ members ============================ */
  withRoom(program.command('members'))
    .description('list a room’s members')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const res = await client.listMembers(roomId);
        print(res, formatMembers(res.items));
      }),
    );

  /* ============================ send ============================ */
  withRoom(program.command('send'))
    .description('send a message to a room (every message reaches the whole room)')
    .argument('[recipient]', 'ignored; accepted so `send <recipient> <message>` still parses')
    .argument('[message]')
    .option('--all', 'accepted for backward compatibility (every message already reaches the whole room)')
    .option('--subject <s>', 'subject line')
    .option('--attach <file>', 'attach a file (repeatable)', collect, [])
    .option('--stdin', 'read the body from stdin')
    .option('--suggest <label[=value]>', 'one-tap reply suggestion (repeatable, up to 4)', collect, [])
    .option('--in-reply-to <messageId>', 'mark this a reply to a message you can read')
    .option('--reply-value <value>', 'the chosen reply value (requires --in-reply-to)')
    .option('--origin <origin>', "provenance of the body (only 'voice'): dictated via speech")
    .action(
      action(async (opts, args) => {
        const origin = opts.origin as string | undefined;
        if (origin !== undefined && origin !== 'voice') {
          throw new CliError(`--origin must be 'voice' (got '${origin}').`);
        }
        const files = (opts.attach as string[]) ?? [];
        const suggestedReplies = (opts.suggest as string[]).map(parseSuggest);
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const attachments = await buildAttachments(client, roomId, files);

        // Every message reaches the whole room, so there is no recipient to target.
        // The recipient positional is accepted-and-ignored for backward
        // compatibility: with two positionals the first is the (ignored) legacy
        // recipient and the second is the body; a single positional is the body.
        const [arg0, arg1] = args as [string | undefined, string | undefined];
        const bodyArg = arg1 !== undefined ? arg1 : arg0;
        let body = bodyArg ?? '';
        if (opts.stdin) body = await readStdin(io);
        // `origin` is carried on the wire (client forwards the body as-is) even
        // though client.sendMessage's param type does not yet list it — the client
        // package owns threading `origin` through its signature. Kept as an
        // un-annotated const so the extra key passes structurally without a cast.
        const request = {
          subject: opts.subject as string | undefined,
          body,
          attachments: attachments.length > 0 ? attachments : undefined,
          suggestedReplies: suggestedReplies.length > 0 ? suggestedReplies : undefined,
          inReplyTo: opts.inReplyTo as string | undefined,
          replyValue: opts.replyValue as string | undefined,
          origin: origin as MessageOrigin | undefined,
        };
        const res = await client.sendMessage(roomId, request);
        const recipients = res.message.to.map((t) => t.displayName).join(', ');
        print(
          res,
          `Sent ${res.message.id}${recipients ? ` to ${recipients}` : ''} ` +
            `(${res.message.kind}); ${res.unreadCount} unread in this room.`,
        );
      }),
    );

  /* ============================ inbox ============================ */
  withRoom(program.command('inbox'))
    .description(
      'list inbox previews (unread by default). Without --room: /me/inbox — typed ' +
        'previews across mediums (chat and email in one list). With --room it stays ' +
        "the room's chat inbox.",
    )
    .option('--all', 'include already-read messages')
    .option('--limit <n>', 'max items', (v) => Number.parseInt(v, 10))
    .option('--medium <chat|email>', 'narrow to one medium (no --room)')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomSel = roomSelector(opts, env);
        try {
          if (!roomSel) {
            const org = await resolveOrgOptional(client, opts, env);
            const res = await client.meInbox({
              all: Boolean(opts.all),
              limit: opts.limit as number | undefined,
              medium: opts.medium as 'chat' | 'email' | undefined,
              org,
            });
            print(res, formatMeInbox(res.items));
            return;
          }
          const roomId = await resolveRoom(client, opts, env);
          const res = await client.listInbox(roomId, {
            all: Boolean(opts.all),
            limit: opts.limit as number | undefined,
          });
          print(res, formatInbox(res.items));
        } catch (e) {
          throw explainAuthError(e, opts, env);
        }
      }),
    );

  /* ============================ pop ============================ */
  withRoom(program.command('pop'))
    .description(
      'pop the oldest unread WORK ITEM. Without --room this drains the ONE queue that ' +
        'spans mediums (chat.message | email) — -j prints the `{ item }` envelope ' +
        "verbatim; switch on `item.type`. With --room it stays the room's chat pop.",
    )
    .option('--ack', 'after popping, advertise "working" scoped to the sender (chat only)')
    .option('--note <note>', 'note for the --ack status')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomSel = roomSelector(opts, env);
        const ackOpts = opts.ack ? { ack: true, note: opts.note as string | undefined } : undefined;
        if (!roomSel) {
          const res = await client.meInboxPop(ackOpts);
          // A type this CLI predates: print it raw and leave it for a newer
          // client. Forward compat is a RULE here — never an error, always exit 0.
          if (res.unknownItem) {
            print({ item: res.unknownItem }, formatUnknownWorkItem(res.unknownItem));
            return;
          }
          const item = res.item;
          if (!item) {
            // THE PAUSE. An empty queue is the one moment this agent is
            // between tasks, so it is the one moment sparrow may say something
            // — as ordinary output, right under "Inbox empty.". Under `-j` the
            // hints already ride the envelope; nothing extra is printed there.
            print(
              res.hints ? { item: null, hints: res.hints } : { item: null },
              ['Inbox empty.', ...formatHints(res.hints)].join('\n'),
            );
            return;
          }
          // A popped item is, by definition, inbound — remember it so `reply`
          // (chat) / `email reply` (email) need no id. The two never cross.
          if (item.type === 'chat.message') recordInbound(env, opts, item.message, item.room.id);
          else recordEmail(env, opts, item.email);
          // A pop that HANDS BACK WORK carries no hints — the server does not
          // attach them mid-stride, and the CLI has none to render.
          print({ item }, formatWorkItem(item));
          return;
        }
        const roomId = await resolveRoom(client, opts, env);
        // The room-scoped pop is NOT a hinted surface: `POST
        // /rooms/:roomId/inbox/pop` returns `{ message }` with no `hints` field
        // (only the unified pop's empty response carries them), so there is
        // nothing to print here — and nothing may be invented.
        const msg = await client.popNextMessage(roomId, ackOpts);
        if (!msg) {
          print({ message: null }, 'Inbox empty.');
          return;
        }
        recordInbound(env, opts, msg, roomId);
        const room = await client.getRoom(roomId);
        // The room-scoped pop keeps its v3 `{ message, room }` shape (rooms have
        // no email) — only the human header now leads with the medium.
        const roomRef = { id: room.id, name: room.name, kind: room.kind, orgId: room.orgId };
        print({ message: msg, room: roomRef }, `${roomHeader(roomRef)}\n${formatMessage(msg)}`);
      }),
    );

  /* ============================ tips ============================ */
  // The PULL half of the attention design. A delivered hint is at most one, at
  // the pause, on the server's cooldown; `tips` is everything the same engine
  // would say, whenever the agent asks. Being asked is not an interruption, so
  // the read burns nothing: no delivery is recorded and no cooldown is spent —
  // looking at your tips never costs you the hint you would otherwise be handed
  // at your next empty pop.
  withCommon(program.command('tips'))
    .description(
      "everything sparrow would tell you about how you're using this workspace, on demand. " +
        'Read-only: it records no delivery and burns no cooldown, so asking never suppresses ' +
        'a hint you would have been handed at your next empty `pop`. Agents only.',
    )
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const res = await client.meHints();
        print(
          res,
          res.hints.length === 0 ? NO_TIPS_MESSAGE : formatHints(res.hints).join('\n'),
        );
      }),
    );

  /* ============================ read ============================ */
  withRoom(program.command('read'))
    .description(
      'handle a specific message by id: acks it (marks read) and prints the body. ' +
        '--peek fetches without marking read. Without --room, acks by id across memberships ' +
        '(the precise alternative to `pop`, which drains the oldest unread).',
    )
    .argument('<messageId>')
    .option('--peek', 'do not mark the message read')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const roomSel = roomSelector(opts, env);

        // No --room: principal-scoped ack-by-id (peek fetches; else marks read).
        // This is the watcher-driven path — target exactly the id you were shown.
        if (!roomSel) {
          const res = opts.peek
            ? await client.getMessage(args[0]!)
            : await client.markRead(args[0]!);
          // Best-effort inbound record for `reply`, gated on a cheap whoami.
          try {
            const me = await client.whoami(res.room.id);
            if (res.message.from.id !== me.id) recordInbound(env, opts, res.message, res.room.id);
          } catch {
            /* whoami failed — skip the convenience record, never fail `read` */
          }
          print(res, `[${roomLabel(res.room)}]\n${formatMessage(res.message)}`);
          return;
        }

        const roomId = await resolveRoom(client, opts, env);
        const msg = await client.readMessage(roomId, args[0]!, { peek: Boolean(opts.peek) });
        // Record as "last inbound" only when the message is inbound (not the
        // caller's own) — best-effort, gated on a cheap whoami.
        try {
          const me = await client.whoami(roomId);
          if (msg.from.id !== me.id) recordInbound(env, opts, msg, roomId);
        } catch {
          /* whoami failed — skip the convenience record, never fail `read` */
        }
        print(msg, formatMessage(msg));
      }),
    );

  /* ============================ reply ============================ */
  withRoom(program.command('reply'))
    .description('reply to your last inbound message (or --to <messageId>) without copy-pasting ids')
    .argument('<text>', 'the reply body')
    .option('--last', 'reply to the last message you popped/read (the default)')
    .option('--to <messageId>', 'reply to a specific message id (room resolved from the message; --room overrides)')
    .option('--value <v>', 'a structured reply value (echoed as replyValue)')
    .option('--attach <file>', 'attach a file (repeatable)', collect, [])
    .action(
      action(async (opts, args) => {
        const text = args[0]!;
        const { client } = buildClient(opts, env);
        const files = (opts.attach as string[]) ?? [];

        let roomId: string;
        let toMember: string;
        let inReplyTo: string;

        const toId = opts.to as string | undefined;
        if (toId) {
          if (roomSelector(opts, env)) {
            // Explicit --room (or SPARROW_ROOM/default): room-scoped peek to learn
            // the target's sender (the reply's recipient).
            roomId = await resolveRoom(client, opts, env);
            const target = await client.readMessage(roomId, toId, { peek: true });
            toMember = target.from.id;
            inReplyTo = target.id;
          } else {
            // No --room needed: resolve the room from the message itself via the
            // principal-scoped fetch (`GET /me/messages/:messageId`), which returns
            // the message AND its room. A 404 (unknown/foreign id) surfaces as a
            // clear error through the client.
            const res = await client.getMessage(toId);
            roomId = res.room.id;
            toMember = res.message.from.id;
            inReplyTo = res.message.id;
          }
        } else {
          const name = activeProfileName(opts, env);
          const last = name ? getProfileState(env, name).lastInbound : undefined;
          if (!last) {
            throw new CliError(
              'No last inbound message to reply to. Run `sparrow pop`/`sparrow read` first, ' +
                'or use `sparrow reply <text> --to <messageId> --room R`.',
            );
          }
          roomId = last.roomId;
          toMember = last.senderMemberId;
          inReplyTo = last.messageId;
        }

        const attachments = await buildAttachments(client, roomId, files);
        const res = await client.sendMessage(roomId, {
          to: toMember,
          body: text,
          inReplyTo,
          replyValue: opts.value as string | undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
        print(
          res,
          `Replied ${res.message.id} to ${res.message.to.map((t) => t.displayName).join(', ')} ` +
            `(↩ ${inReplyTo}); ${res.unreadCount} unread in this room.`,
        );
      }),
    );

  /* ============================ outbox ============================ */
  withRoom(program.command('outbox'))
    .description('list messages you have sent')
    .option('--limit <n>', 'max items', (v) => Number.parseInt(v, 10))
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const res = await client.listOutbox(roomId, { limit: opts.limit as number | undefined });
        print(res, formatOutbox(res.items));
      }),
    );

  /* ============================ clawback ============================ */
  // SPEC "Clawback": retract your OWN message while nobody has read it. Success
  // prints the body VERBATIM so a terminal agent can re-edit and resend it.
  withRoom(program.command('clawback'))
    .description(
      'retract your own still-unread message (no id: your most recent message in the room); ' +
        'prints the body back so you can edit and resend',
    )
    .argument('[messageId]', 'the message to claw back (default: your newest message in the room)')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);

        const attempt = async (id: string): Promise<void> => {
          const res = await client.clawbackMessage(roomId, id);
          print(res, `Clawed back ${res.message.id} — body restored below:\n${res.message.body}`);
        };

        const explicit = args[0];
        if (explicit) {
          try {
            await attempt(explicit);
          } catch (e) {
            throw explainClawbackRefusal(e, explicit);
          }
          return;
        }

        // No id: target the caller's MOST RECENT message, newest-first. A 409
        // refusal (someone read it / out of window) STOPS the walk with its
        // reason — silently clawing back an OLDER message than the one on
        // screen would surprise. Only an `already clawed back` row (a raced
        // double-clawback) is skipped, since it is already gone.
        const own = await ownOutboxTail(client, roomId);
        if (own.length === 0) {
          throw new CliError('You have no messages in this room to claw back.');
        }
        for (const msg of own) {
          try {
            await attempt(msg.id);
            return;
          } catch (e) {
            if (isAlreadyClawedBack(e)) continue;
            throw explainClawbackRefusal(e, msg.id);
          }
        }
        throw new CliError(
          'Your recent messages in this room are already clawed back; nothing to retract.',
        );
      }),
    );

  /* ============================ log ============================ */
  withRoom(program.command('log'))
    .description('print the room conversation history as a chronological transcript; -j for raw JSON')
    .option('--limit <n>', 'how many recent messages to fetch (default 50, max 200)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--before <messageId>', 'page backwards: fetch messages older than this id')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const res = await client.listRoomMessages(roomId, {
          limit: opts.limit as number | undefined,
          before: opts.before as string | undefined,
        });
        print(res, formatLog(res.items));
      }),
    );

  /* ============================ activity ============================ */
  withOrg(program.command('activity'))
    .description(
      'the interleaved timeline: chat and email in one chronological list, oldest ' +
        'first (-j is the raw newest-first page plus nextBefore). Without --agent: ' +
        'everything involving you. With --agent: that ' +
        "agent's timeline (its owner and org owners/admins may watch).",
    )
    .option('--agent <name|agt_>', "one agent's timeline (owner / org admin only)")
    .option('--limit <n>', 'max entries (default 25, max 100)', (v) => Number.parseInt(v, 10))
    .option('--medium <chat|email|voice>', 'narrow to one medium')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const limit = opts.limit as number | undefined;
        const medium = opts.medium as Medium | undefined;
        const agentSel = opts.agent as string | undefined;
        try {
          // A timeline is a REFERENCE list, not a mailbox: reading it writes
          // nothing — no read state, no pop, ever.
          if (agentSel) {
            // A timeline is correspondence: only the agent's OWNER and org
            // owners/admins may watch one. Say that plainly to an agent profile
            // rather than resolving a name it cannot use and letting the route's
            // 401 read as "your key is dead" — the same rule the email medium
            // states for `--agent` ("an agent reads only its own mailbox").
            const me = await client.me();
            if (me.type === 'agent') {
              if (agentSel !== me.id && agentSel.toLowerCase() !== me.name.toLowerCase()) {
                throw new CliError(
                  `An agent watches only its own timeline; --agent ${agentSel} names someone ` +
                    'else. Drop --agent, or run this from the owning human’s profile.',
                );
              }
              const own = await client.meActivity({ limit, medium });
              print(own, formatActivity(own.items));
              return;
            }
            const orgId = await resolveOrg(client, opts, env);
            const target = await resolvePrincipal(client, agentSel, orgId);
            const res = await client.agentActivity(orgId, target.id, { limit, medium });
            print(res, formatActivity(res.items));
            return;
          }
          const org = await resolveOrgOptional(client, opts, env);
          const res = await client.meActivity({ org, limit, medium });
          print(res, formatActivity(res.items));
        } catch (e) {
          throw explainAuthError(e, opts, env);
        }
      }),
    );

  /* ============================ the email medium ============================ */

  /**
   * Which mailbox an email command acts on. An AGENT profile is its own mailbox
   * and reaches it through `/me/email/*`; a HUMAN profile owns no address and
   * reaches one of its agents' mailboxes through `/orgs/:orgId/agents/:agentId/
   * email/*`, named by `--agent` — automatic when it owns exactly one agent with
   * email, required otherwise (SPEC → CLI, "Email commands").
   */
  const resolveEmailTarget = async (
    client: SparrowClient,
    opts: GlobalOpts & Record<string, unknown>,
  ): Promise<EmailTarget> => {
    const me = await client.me();
    const sel = opts.agent as string | undefined;
    if (me.type === 'agent') {
      // "an agent profile ignores `--agent` for anything but itself" — naming
      // someone else's mailbox is a mistake worth catching before the round trip.
      if (sel && sel !== me.id && sel.toLowerCase() !== me.name.toLowerCase()) {
        throw new CliError(
          `An agent reads only its own mailbox; --agent ${sel} names someone else. ` +
            'Drop --agent, or run this from the owning human’s profile.',
        );
      }
      return { kind: 'agent' };
    }
    const org = await resolveOrgOptional(client, opts, env);
    if (sel) {
      const found = await resolveAgent(client, sel, org);
      return {
        kind: 'human',
        orgId: found.agent.orgId,
        agentId: found.agent.id,
        agentName: found.agent.name,
      };
    }
    const agents = await client.listAgents(org ? { org } : undefined);
    const owned = agents.filter((a) => a.owner.id === me.id && a.agent.emailAddress !== null);
    if (owned.length === 1) {
      const a = owned[0]!.agent;
      return { kind: 'human', orgId: a.orgId, agentId: a.id, agentName: a.name };
    }
    if (owned.length === 0) {
      // Agents exist but none has an address ⇒ the MEDIUM is off, not the roster
      // empty. Say the honest thing rather than "you own no agent with email".
      if (await emailMediumOff(client)) throw new CliError(EMAIL_DISABLED);
      throw new CliError(
        'You own no agent with an email address. Enroll one (`sparrow enroll`) or check ' +
          '`sparrow agents`.',
      );
    }
    throw new CliError(
      `You own ${owned.length} agents with email; pass --agent <name|agt_>: ` +
        `${owned.map((a) => `${a.agent.name} (${a.agent.id})`).join(', ')}.`,
    );
  };

  /**
   * The org for the two id-addressed reads a human does — one email and one
   * attachment. Those hang off the ORG, not off an agent
   * (`/orgs/:orgId/email/emails/:id`, `/orgs/:orgId/email/attachments/:id`;
   * there is no per-agent form), so `--org` alone suffices and `--agent`, when
   * given, merely names the org too.
   */
  const emailOrgId = async (
    client: SparrowClient,
    opts: GlobalOpts & Record<string, unknown>,
  ): Promise<string> => {
    const sel = opts.agent as string | undefined;
    if (sel) {
      const org = await resolveOrgOptional(client, opts, env);
      return (await resolveAgent(client, sel, org)).agent.orgId;
    }
    return resolveOrg(client, opts, env);
  };

  /**
   * A mail body, from the three sources the SPEC names in that order: the
   * positional argument, `--stdin`, then `$EDITOR` when neither is given and
   * stdin is a TTY. With no TTY and no body, erroring beats opening an editor
   * nothing can drive.
   */
  const mailBody = async (
    positional: string | undefined,
    opts: Record<string, unknown>,
  ): Promise<string> => {
    if (positional !== undefined && positional !== '') return positional;
    if (opts.stdin) return readStdin(io);
    if (process.stdin.isTTY) return editorBody(env);
    throw new CliError(
      'No message body. Pass it as an argument, use --stdin, or run in a terminal with $EDITOR set.',
    );
  };

  /** The human who approves this agent's mail — named in every "held" report. */
  const ownerName = async (client: SparrowClient): Promise<string> => {
    try {
      const me = await client.me();
      if (me.type === 'agent') return me.owner.displayName;
    } catch {
      /* naming the owner is a courtesy — never fail a successful send over it */
    }
    return 'your owner';
  };

  const emailCmd = program
    .command('email')
    .description('the email medium: your agent’s line to people outside sparrow');
  /**
   * Email needs no `--room` (an agent's mail hangs off its principal) and no
   * `--org` for the agent's own routes; `--agent`/`--org` exist for the HUMAN
   * twin, where a person addresses one of their agents' mailboxes.
   */
  const withEmail = (cmd: Cmd): Cmd =>
    withOrg(cmd).option(
      '--agent <name|agt_>',
      'whose mailbox (human profiles; required when you own more than one agent with email)',
    );

  withEmail(emailCmd.command('address'))
    .description('print the derived email address (yours, or --agent’s)')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const target = await resolveEmailTarget(client, opts);
        const res = await emailCall(client, () =>
          target.kind === 'agent'
            ? client.meEmailAddress()
            : client.agentEmailAddress(target.orgId, target.agentId),
        );
        print(res, formatEmailAddress(res));
      }),
    );

  withEmail(emailCmd.command('threads'))
    .description(
      'list email threads as an oldest-first table; -j is the raw newest-first page ' +
        '(descending lastEmailAt) plus nextBefore',
    )
    .option('--limit <n>', 'max threads (default 25, max 100)', (v) => Number.parseInt(v, 10))
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const target = await resolveEmailTarget(client, opts);
        const page = { limit: opts.limit as number | undefined };
        const res = await emailCall(client, () =>
          target.kind === 'agent'
            ? client.listEmailThreads(page)
            : client.agentEmailThreads(target.orgId, target.agentId, page),
        );
        print(res, formatEmailThreads(res.items));
      }),
    );

  withEmail(emailCmd.command('read'))
    .description(
      'an eth_ id prints the whole thread as an oldest-first transcript (the shape ' +
        '`sparrow log` gives a room); an eml_ id prints ONE email in full — headers, ' +
        'inbound verification, body, attachment ids.',
    )
    .argument('<id>', 'an eth_ thread id or an eml_ email id')
    .option('--limit <n>', 'max emails when reading a thread', (v) => Number.parseInt(v, 10))
    .action(
      action(async (opts, args) => {
        const id = args[0]!;
        const { client } = buildClient(opts, env);

        if (/^eth_/.test(id)) {
          const target = await resolveEmailTarget(client, opts);
          const page = { limit: opts.limit as number | undefined };
          const res = await emailCall(client, () =>
            target.kind === 'agent'
              ? client.getEmailThread(id, page)
              : client.agentEmailThread(target.orgId, target.agentId, id, page),
          );
          print(res, formatEmailThreadTranscript(res.thread, res.items));
          return;
        }
        if (!/^eml_/.test(id)) {
          throw new CliError(
            `\`sparrow email read\` takes an eth_ thread id or an eml_ email id (got "${id}").`,
          );
        }
        // One email by id. An AGENT's read marks it read (the only read state
        // email has, and only on inbound `delivered` mail); a HUMAN reads through
        // the org route, which is always a peek — a human reading never marks
        // their agent's mail read.
        const me = await client.me();
        const orgId = me.type === 'agent' ? undefined : await emailOrgId(client, opts);
        const email = await emailCall(client, () =>
          orgId === undefined ? client.readEmail(id) : client.getOrgEmail(orgId, id),
        );
        // Reading an email is exactly as much of a targeting act as popping one:
        // record it so `sparrow email reply --last` needs no id copy-paste.
        recordEmail(env, opts, email);
        print(email, formatEmail(email, null));
      }),
    );

  withCommon(emailCmd.command('reply'))
    .description(
      'reply inside the thread of your last popped/read email (or --to <emlId>). The ' +
        'subject and the recipient set come from the thread — you write only the body.',
    )
    .argument('[text]', 'the reply body (or --stdin, or $EDITOR on a TTY)')
    .option('--last', 'answer the last email you popped or read (the default)')
    .option('--to <emailId>', 'answer the thread that this email belongs to')
    .option('--cc <address>', 'add a Cc recipient (repeatable)', collect, [])
    .option('--attach <file>', 'attach a file (repeatable)', collect, [])
    .option('--stdin', 'read the body from stdin')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const toId = opts.to as string | undefined;
        let threadId: string;
        if (toId) {
          // A PEEK: naming an email to answer must not mark it read.
          const target = await emailCall(client, () => client.readEmail(toId, { peek: true }));
          threadId = target.threadId;
        } else {
          const name = activeProfileName(opts, env);
          const last = name ? getProfileState(env, name).lastEmail : undefined;
          if (!last) {
            throw new CliError(
              'No last email to reply to. Run `sparrow pop` or `sparrow email read <emlId>` ' +
                'first, or use `sparrow email reply <text> --to <emlId>`.',
            );
          }
          threadId = last.threadId;
        }
        const text = await mailBody(args[0] as string | undefined, opts);
        const attachments = await buildEmailAttachments(client, (opts.attach as string[]) ?? []);
        const cc = (opts.cc as string[]) ?? [];
        const email = await emailCall(client, () =>
          client.replyEmail(threadId, {
            text,
            cc: cc.length > 0 ? cc : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
          }),
        );
        if (email.disposition === 'held') {
          print(email, heldMessage(email, await ownerName(client)));
          return;
        }
        print(
          email,
          `Replied ${email.id} in thread ${threadId} — ${email.disposition} to ` +
            `${email.to.map((t) => t.email).join(', ')}.`,
        );
      }),
    );

  withCommon(emailCmd.command('send'))
    .description(
      'start a NEW email thread. --to is repeatable; a recipient the org does not already ' +
        'trust puts the mail in your owner’s approval queue (held, and that is not a failure).',
    )
    .argument('[message]', 'the body (or --stdin, or $EDITOR on a TTY)')
    .option('--to <address>', 'a recipient (repeatable; at least one required)', collect, [])
    .option('--cc <address>', 'a Cc recipient (repeatable)', collect, [])
    .requiredOption('--subject <s>', 'the subject line')
    .option('--attach <file>', 'attach a file (repeatable)', collect, [])
    .option('--stdin', 'read the body from stdin')
    .action(
      action(async (opts, args) => {
        // `--to` carries a default (`[]`) so `collect` has something to append
        // to, which also makes commander's own mandatory check a no-op — the
        // emptiness check has to live here.
        const to = (opts.to as string[]) ?? [];
        if (to.length === 0) {
          throw new CliError('`sparrow email send` needs at least one --to <address>.');
        }
        const { client } = buildClient(opts, env);
        const text = await mailBody(args[0] as string | undefined, opts);
        const attachments = await buildEmailAttachments(client, (opts.attach as string[]) ?? []);
        const cc = (opts.cc as string[]) ?? [];
        const res = await emailCall(client, () =>
          client.sendEmail({
            to,
            cc: cc.length > 0 ? cc : undefined,
            subject: opts.subject as string,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
          }),
        );
        if (res.email.disposition === 'held') {
          print(res, heldMessage(res.email, await ownerName(client)));
          return;
        }
        print(
          res,
          `Sent ${res.email.id} to ${res.email.to.map((t) => t.email).join(', ')} — ` +
            `thread ${res.thread.id}.`,
        );
      }),
    );

  const emailAttachment = emailCmd
    .command('attachment')
    .description('email attachment operations');
  withEmail(emailAttachment.command('get'))
    .description('download an email attachment (forced download, as in chat)')
    .argument('<attachmentId>')
    .option('-o, --output <file>', 'output path (default: original filename in cwd)')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        // An agent reads its own attachments; a human reads them through the ORG
        // route (there is no per-agent form of this one).
        const me = await client.me();
        const orgId = me.type === 'agent' ? undefined : await emailOrgId(client, opts);
        const dl = await emailCall(client, () =>
          orgId === undefined
            ? client.getEmailAttachment(args[0]!)
            : client.getOrgEmailAttachment(orgId, args[0]!),
        );
        const outPath = (opts.output as string | undefined) ?? path.join(process.cwd(), dl.filename);
        fs.writeFileSync(outPath, dl.bytes);
        print(
          {
            path: outPath,
            filename: dl.filename,
            contentType: dl.contentType,
            sizeBytes: dl.bytes.length,
          },
          `Saved ${dl.filename} (${dl.bytes.length} bytes) to ${outPath}`,
        );
      }),
    );

  /* ============================ approvals ============================ */

  /**
   * `sparrow approvals` is the OWNING HUMAN's command and refuses an agent
   * profile: an agent never approves mail addressed to itself (SPEC → CLI).
   *
   * The refusal happens HERE rather than at the server. SPEC calls it a `403`,
   * but `/orgs/:orgId/email/approvals` is session-authed, so an agent key never
   * reaches the email code at all — it gets a bare `401 unauthorized`
   * ("Sign-in required") off the auth gate, which is true and useless: it names
   * neither this command's rule nor the way out.
   */
  const requireApprovingHuman = async (client: SparrowClient): Promise<void> => {
    const me = await client.me();
    if (me.type === 'agent') {
      throw new CliError(
        '`sparrow approvals` is the owning human’s command — you are an agent, and an agent ' +
          'never approves mail addressed to itself. Run it from your owner’s profile ' +
          '(`sparrow login`).',
      );
    }
  };

  const approvals = program
    .command('approvals')
    .description(
      'the owning human’s queue: pending enrollments from your OWN invites PLUS quarantined ' +
        'inbound and held outbound mail for agents you own — because the question is ' +
        '“what needs me?”, not “which subsystem?”.',
    );
  const withApprovals = (cmd: Cmd): Cmd =>
    withOrg(cmd)
      .option('--agent <name|agt_>', 'narrow the email half to one agent you own')
      .option('--direction <in|out>', 'narrow the email half to inbound or outbound mail')
      .option('--limit <n>', 'max email items (default 25, max 100)', (v) => Number.parseInt(v, 10));

  const listApprovals = action(async (opts) => {
    const { client } = buildClient(opts, env);
    await requireApprovingHuman(client);
    const orgId = await resolveOrg(client, opts, env);
    // `?mine=true`: the enrollments from the CALLER's own invites, matching the
    // email half's scope (agents they own), not every enrollment in the org.
    const enrollments = await client.listEnrollments(orgId, { mine: true });

    // The email half is the only half that can be missing: with the medium off
    // its route 404s while enrollments keep answering. On such an instance we
    // still PRINT the enrollments — a human reading a short list must never
    // conclude "nothing needs me" — and then exit 1, because the email half did
    // not answer (SPEC → CLI: "the email half of `sparrow approvals` exits 1
    // with 'email is not enabled on this server'"). `approve`/`deny` are pure
    // email, so they refuse outright with nothing to show.
    let emailItems: EmailApprovalItem[] | null = null;
    let disabled = false;
    try {
      const agentSel = opts.agent as string | undefined;
      const agentId = agentSel ? (await resolveAgent(client, agentSel, orgId)).agent.id : undefined;
      const res = await emailCall(client, () =>
        client.listEmailApprovals(orgId, {
          agent: agentId,
          direction: opts.direction as EmailDirection | undefined,
          limit: opts.limit as number | undefined,
        }),
      );
      emailItems = res.items;
    } catch (e) {
      if (e instanceof CliError && e.message === EMAIL_DISABLED) disabled = true;
      else throw e;
    }
    print({ enrollments, email: emailItems }, formatApprovals(enrollments, emailItems));
    if (disabled) throw new CliError(EMAIL_DISABLED);
  });
  withApprovals(approvals).action(listApprovals);
  withApprovals(approvals.command('list'))
    .description('list everything waiting on you: enrollments + email')
    .action(listApprovals);

  withOrg(approvals.command('approve'))
    .description(
      'approve a quarantined inbound / held outbound email. Trusts the other party durably ' +
        '(the thread AND the external contact) unless --no-trust.',
    )
    .argument('<emailId>', 'the eml_ id from `sparrow approvals`')
    .option('--no-trust', 'approve just this one email; trust nothing durably')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        await requireApprovingHuman(client);
        const orgId = await resolveOrg(client, opts, env);
        const trustSender = opts.trust !== false;
        const email = await emailCall(client, () =>
          client.approveEmail(orgId, args[0]!, { trustSender }),
        );
        print(
          email,
          `Approved ${email.id} — now ${email.disposition}. ` +
            (trustSender
              ? `${emailCounterparty(email)} is trusted from now on.`
              : 'This email only — nothing was trusted.'),
        );
      }),
    );

  withOrg(approvals.command('deny'))
    .description('refuse a pending email; --block also blocks that contact for the org')
    .argument('<emailId>', 'the eml_ id from `sparrow approvals`')
    .option('--block', 'block that contact for the org (durable, forward-looking)')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        await requireApprovingHuman(client);
        const orgId = await resolveOrg(client, opts, env);
        const blockSender = Boolean(opts.block);
        const email = await emailCall(client, () =>
          client.denyEmail(orgId, args[0]!, { blockSender }),
        );
        print(
          email,
          `Denied ${email.id} — now ${email.disposition}.` +
            (blockSender ? ` Blocked ${emailCounterparty(email)} for this org.` : ''),
        );
      }),
    );

  /* ============================ status ============================ */
  const statusCmd = withRoom(program.command('status'))
    .description('show a message read-status (<messageId>) or manage your working indicator')
    .argument('[messageId]', 'message id for per-recipient read status')
    .action(
      action(async (opts, args) => {
        const mid = args[0];
        if (!mid) {
          throw new CliError('status: provide a <messageId>, or use `status working|idle|list`.');
        }
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const s = await client.getMessageStatus(roomId, mid);
        print(s, formatMessageStatus(s));
      }),
    );
  withRoom(statusCmd.command('working'))
    .description('advertise that you are working (auto-expires, or --sticky for long tasks)')
    .option('--note <note>', 'short note shown with the indicator')
    .option('--to <member>', 'scope to one recipient (member/principal id)')
    .option('--ttl <seconds>', 'seconds until it auto-expires (1–600)', (v) => Number.parseInt(v, 10))
    .option('--sticky', 'no TTL — persist until idle/clear (best for long tasks; excludes --ttl)')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const st = await client.setStatus(roomId, {
          state: 'working',
          note: opts.note as string | undefined,
          to: opts.to as string | undefined,
          ttlSeconds: opts.ttl as number | undefined,
          sticky: opts.sticky ? true : undefined,
        });
        print(st, st ? formatOneStatus(st) : 'No status.');
      }),
    );
  withRoom(statusCmd.command('idle'))
    .description('clear your working indicator')
    .option('--to <member>', 'clear only the status scoped to this recipient')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        await client.setStatus(roomId, { state: 'idle', to: opts.to as string | undefined });
        print({ status: null }, 'Status cleared.');
      }),
    );
  withRoom(statusCmd.command('list'))
    .description('list active statuses visible to you + room presence')
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const res = await client.listStatuses(roomId);
        print(res, formatStatusList(res));
      }),
    );

  /* ============================ presence (heartbeat) ============================ */
  // Turn-based agents (wake → act → sleep) can show online without holding an
  // events stream: mark presence with a TTL each turn, `--ttl 0` to clear.
  withCommon(program.command('presence'))
    .description('heartbeat online without an open events stream (for turn-based agents)')
    .option('--ttl <seconds>', 'seconds to stay online (0–300; 0 clears the mark)', (v) =>
      Number.parseInt(v, 10),
    )
    .action(
      action(async (opts) => {
        const { client } = buildClient(opts, env);
        const ttl = (opts.ttl as number | undefined) ?? 300;
        const res = await client.setPresence(ttl);
        print(
          res,
          res.onlineUntil ? `Online until ${res.onlineUntil}.` : 'Presence mark cleared.',
        );
      }),
    );

  /* ============================ upgrade ============================ */
  // Re-download the CLI + MCP bundles from the CANONICAL install home (see
  // {@link installBaseUrl}) into $SPARROW_BIN_DIR (default ~/.local/bin — the
  // install.sh layout), then report old → new. Deliberately independent of the
  // active profile: the bundles do not come from your instance (which 302s
  // /install/* to sparrow.land), so `upgrade` works with no profile at all.
  // Only meaningful for an install.sh install; a workspace/dev checkout has no
  // installed bundle.
  withCommon(program.command('upgrade'))
    .alias('update')
    .description(
      're-download the sparrow CLI + MCP bundles from https://sparrow.land into $SPARROW_BIN_DIR (default ~/.local/bin)',
    )
    .addHelpText(
      'after',
      [
        '',
        'Also available as `sparrow update` (same command).',
        '',
        'Bundles come from the canonical install home, https://sparrow.land — not from',
        'your instance — so this works whatever server your profile points at, and',
        '--server/--profile are accepted but unused here. Set SPARROW_INSTALL_URL to',
        'pull from a mirror instead. Installs over the bundles',
        'install.sh wrote: set SPARROW_BIN_DIR to the same directory you installed into',
        'if it was not the default ~/.local/bin.',
      ].join('\n'),
    )
    .action(
      action(async () => {
        // The canonical install home — never the profile's server. The /install/*
        // endpoints are unauthenticated (and never gated).
        const base = installBaseUrl(env);
        const home = env.HOME ?? os.homedir();
        // Same resolution order as install.sh: $SPARROW_BIN_DIR, else ~/.local/bin.
        const binDir = env.SPARROW_BIN_DIR?.trim() || path.join(home, '.local', 'bin');
        const cliPath = path.join(binDir, 'sparrow.mjs');
        const mcpPath = path.join(binDir, 'sparrow-mcp.mjs');
        if (!fs.existsSync(cliPath)) {
          throw new CliError(
            `sparrow does not appear to be installed via install.sh (no ${cliPath}). ` +
              `If you installed somewhere else, set SPARROW_BIN_DIR to that directory. ` +
              `Install it with: ${INSTALL_COMMAND}`,
          );
        }
        // Read a bundle's own version by executing it (`--version`); best-effort.
        const readVersion = (p: string): string | undefined => {
          try {
            return execFileSync(process.execPath, [p, '--version'], { encoding: 'utf8' }).trim();
          } catch {
            return undefined;
          }
        };
        const oldVersion = readVersion(cliPath);

        const download = async (url: string, dest: string): Promise<void> => {
          let res: Response;
          try {
            // `redirect: 'follow'` is the default and is stated here on purpose:
            // an instance URL in SPARROW_INSTALL_URL answers /install/* with a
            // 302 to the canonical home, and that must still install.
            res = await fetch(url, { redirect: 'follow' });
          } catch {
            throw new CliError(
              `Could not reach ${url} to download the sparrow bundles (network unreachable). ` +
                `The install home is ${base}` +
                (env.SPARROW_INSTALL_URL?.trim() ? ' (from SPARROW_INSTALL_URL)' : '') +
                '.',
            );
          }
          if (!res.ok) throw new CliError(`Install home returned ${res.status} for ${url}.`);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
        };

        await download(`${base}/install/sparrow.js`, cliPath);
        await download(`${base}/install/sparrow-mcp.js`, mcpPath);
        const newVersion = readVersion(cliPath);
        print(
          { old: oldVersion ?? null, new: newVersion ?? null, installUrl: base, cli: cliPath, mcp: mcpPath },
          `Upgraded sparrow: ${oldVersion ?? '?'} → ${newVersion ?? '?'} (from ${base}).`,
        );
      }),
    );

  /* ============================ skill ============================ */
  withCommon(program.command('skill [command]'))
    .description('manage the Sparrow Claude Code skill: install | uninstall | pause | resume | status')
    .option('--user', 'install into ~/.claude (user scope) instead of the project')
    .option('--shared', 'project scope: write the COMMITTED .claude/settings.json (default: settings.local.json)')
    .addHelpText(
      'after',
      [
        '',
        'A project install is personal by default: hooks go in .claude/settings.local.json,',
        'state in <project>/.sparrow (so agents in other checkouts never share your loop',
        'switch or heartbeat), and both are added to .git/info/exclude. Each hook command is',
        'stamped with SPARROW_STATE_DIR and the SPARROW_PROFILE this install ran as',
        '(--profile <name>, else $SPARROW_PROFILE, else defaultProfile).',
      ].join('\n'),
    )
    .action(
      action(async (opts, args) => {
        const argv = [
          args[0] ?? 'install',
          ...(opts.user ? ['--user'] : []),
          ...(opts.shared ? ['--shared'] : []),
          // The profile this install should ACT AS — stamped into every hook
          // command it writes, so the hooks speak as this agent and not as
          // whichever neighbour happens to own `defaultProfile`.
          ...(opts.profile ? ['--profile', String(opts.profile)] : []),
        ];
        const code = await skillInstall(argv, { cwd: process.cwd(), env, log: (m) => io.out(`${m}\n`) });
        if (code !== 0) throw new CliError(`sparrow skill ${argv[0]} failed`);
      }),
    );

  /* ============================ attachment ============================ */
  const attachment = program.command('attachment').description('attachment operations');
  withRoom(attachment.command('get'))
    .description('download an attachment')
    .argument('<attachmentId>')
    .option('-o, --output <file>', 'output path (default: original filename in cwd)')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const dl = await client.getAttachment(roomId, args[0]!);
        const outPath = (opts.output as string | undefined) ?? path.join(process.cwd(), dl.filename);
        fs.writeFileSync(outPath, dl.bytes);
        print(
          { path: outPath, filename: dl.filename, contentType: dl.contentType, sizeBytes: dl.bytes.length },
          `Saved ${dl.filename} (${dl.bytes.length} bytes) to ${outPath}`,
        );
      }),
    );

  /* ============================ await ============================ */
  /**
   * The WAKE primitive for TURN-BASED agents — the ones that think only when
   * their harness invokes them.
   *
   * `watch`/`loop` solve the wrong half of the problem for such an agent: a
   * background listener makes you ONLINE, not ATTENTIVE. Presence goes green,
   * the human sees a live dot, and the agent sits deaf because nothing ever
   * re-enters its turn. (Field report, 2026-09: an agent followed the onboarding
   * doc exactly — `sparrow watch` running, presence green — and missed seven
   * consecutive DMs.) `loop --exec` does not fix it either: a handler cannot
   * re-enter an interactive agent session, and it CONSUMES the item, so the
   * agent never sees the mail that was addressed to it.
   *
   * The one wake signal every turn-based harness already understands is PROCESS
   * EXIT: a tracked background task that exits gets its owner re-invoked. So
   * `await` holds the events stream (presence rides it exactly as in `watch`)
   * until a work item is AVAILABLE for the caller, prints ONE JSON line naming
   * it, and exits 0 — deliberately WITHOUT consuming it. The point is that the
   * woken agent pops it IN-TURN, having actually read it.
   *
   * Availability is defined by the QUEUE, not by the stream: an event only makes
   * `await` re-ask `GET /me/inbox`, and the answer decides. That keeps it honest
   * against events that imply no work (a message the caller itself sent, a
   * `message.new` for something already read elsewhere) and correct for every
   * medium the inbox spans, chat and email alike.
   *
   * Exit codes ARE the contract: `0` = work is waiting, drain now; `2` = the
   * `--timeout` elapsed with nothing waiting (re-arm); `1` = a real failure,
   * including the `426` client floor, which no re-arm can clear.
   */
  const AWAIT_DRAIN_CMD = 'sparrow pop';
  const runAwait = async (opts: GlobalOpts & Record<string, unknown>): Promise<void> => {
    if (roomSelector(opts, env)) {
      throw new CliError(
        '`sparrow await` watches the ONE work queue, which spans rooms and mediums — drop ' +
          '--room (and `sparrow use --clear` if a sticky default set it).',
      );
    }
    const { client, server, token } = buildClient(opts, env);
    const { staleMs, maxStreamAgeMs } = streamHealthOpts(opts);
    const timeoutSeconds = (opts.timeout as number | undefined) ?? 0;

    /* ------------------------- wake granularity -------------------------
     * `--wake-on` narrows what wakes you IMMEDIATELY; `--batch-after` is the
     * floor under it. The field report this answers asked for GRANULARITY, not
     * muting: in a five-member room every status broadcast woke the agent, but
     * it still wanted to read that traffic — just not to be re-invoked for it.
     * So a filtered item is never dropped from the queue; it is only deferred,
     * and anything unread still wakes you once it has waited `--batch-after`
     * seconds. `--batch-after 0` is the ONE combination that defers
     * indefinitely (the item is still there for `sparrow pop`).
     * ------------------------------------------------------------------ */
    const wakeOn = new Set<WakeKind>();
    {
      const raw = (opts.wakeOn as string | undefined)?.trim();
      const parts = raw ? raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean) : [];
      const bad = parts.filter((p) => p !== 'all' && !(WAKE_KINDS as readonly string[]).includes(p));
      if (bad.length > 0) {
        throw new CliError(
          `Unknown --wake-on kind${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}. ` +
            `Valid kinds are ${WAKE_KINDS.join(', ')} and all (comma-separated, e.g. --wake-on dm,mention).`,
        );
      }
      // `all` anywhere in the list wins — the widest setting, i.e. no filter.
      if (parts.length > 0 && !parts.includes('all')) for (const p of parts) wakeOn.add(p as WakeKind);
    }
    const filtering = wakeOn.size > 0;
    const batchAfterOpt = opts.batchAfter as number | undefined;
    const batchAfterMs =
      filtering
        ? Math.max(Number.isFinite(batchAfterOpt) ? batchAfterOpt! : BATCH_AFTER_DEFAULT, 0) * 1000
        : 0;

    // stdout carries EXACTLY ONE line, ever — the machine signal. Every
    // diagnostic (reconnects, stale streams, poll errors) goes to stderr so a
    // harness can parse stdout without a filter.
    let emitted = false;
    const emit = (line: Record<string, unknown>): void => {
      if (emitted) return;
      emitted = true;
      io.out(`${JSON.stringify(line)}\n`);
    };
    const { verbose, quiet } = listenerQuiet(opts);
    /** An ANOMALY: something the agent must know about. Never quieted. */
    const note = (json: Record<string, unknown>, human: string): void => {
      io.err(ctx.json ? `${JSON.stringify(json)}\n` : `${human}\n`);
    };
    /**
     * ROUTINE LIFECYCLE: the runtime narrating its own plumbing. Silent in human
     * mode unless `-v`; the `-j` line protocol is a contract and is unchanged.
     */
    const lifecycle = (json: Record<string, unknown>, human: string): void => {
      if (ctx.json) io.err(`${JSON.stringify(json)}\n`);
      else if (verbose) io.err(`${human}\n`);
    };

    /** The oldest work item WAITING for the caller, or null. Reads; never consumes. */
    const oldestWaiting = async (): Promise<InboxEntry | null> => {
      const res = await client.meInbox({ limit: 1 });
      return res.items[0] ?? null;
    };
    /**
     * The turn heartbeat. `await` wakes by EXITING, so the agent processes the
     * item holding NO stream — past the presence grace it would read offline
     * mid-turn. Plant a `POST /me/presence` mark (effective online = stream OR
     * unexpired mark) that covers the turn instead. Clamped to the server's cap,
     * because a TTL over it is a 400, not a longer mark.
     *
     * BEST-EFFORT, ALWAYS: presence is cosmetic and the wake is the contract, so
     * a failure here is a stderr note and nothing else — never an exit code,
     * never a swallowed wake line.
     */
    const turnSecondsOpt = opts.turnSeconds as number | undefined;
    const turnSeconds = Math.min(
      Math.max(Number.isFinite(turnSecondsOpt) ? turnSecondsOpt! : TURN_SECONDS_DEFAULT, 0),
      PRESENCE_TTL_MAX,
    );
    const markTurn = async (): Promise<void> => {
      if (turnSeconds <= 0) return; // `--turn-seconds 0` — opted out
      try {
        await client.setPresence(turnSeconds);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        note(
          { type: 'await.presence_error', turnSeconds, message },
          `[await] presence heartbeat failed (${message}) — you may read offline while you work`,
        );
      }
    };

    const wake = (reason: string, item: InboxEntry | null, extra?: Record<string, unknown>): void =>
      emit({
        type: 'await.item',
        reason,
        item,
        // Stated in the payload because it is the whole point: this is a
        // NOTIFICATION. The item is still unread and still in the queue.
        consumed: false,
        drain: AWAIT_DRAIN_CMD,
        ...extra,
      });

    /**
     * How `--wake-on mention` recognises "me". Sparrow has no structured mention
     * model on the wire (no mention refs on a message, nothing in
     * common-types) — a mention is a TEXTUAL `@name` convention. So match
     * `@<my name>` case-insensitively, as a whole word: the caller's own name
     * from `GET /me` (an agent's `name`, a human's `displayName`).
     */
    const mentionRe = await (async (): Promise<RegExp | undefined> => {
      if (!wakeOn.has('mention')) return undefined;
      const principal = await client.me();
      const name = principal.type === 'agent' ? principal.name : principal.displayName;
      if (!name) return undefined;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`@${escaped}(?![\\w-])`, 'i');
    })();
    // A scan can repeat (every event, every batch deadline) and a truncated
    // preview costs a peek, so remember what each item already decided.
    const mentionSeen = new Map<string, boolean>();
    const mentions = async (entry: ChatInboxEntry): Promise<boolean> => {
      if (mentionRe === undefined) return false;
      const cached = mentionSeen.get(entry.id);
      if (cached !== undefined) return cached;
      let text = `${entry.subject ?? ''}\n${entry.preview}`;
      if (entry.truncated) {
        // The preview is cut at PREVIEW_LENGTH — a mention past the cut must
        // still wake. `GET /me/messages/:id` is a pure peek (no read state), so
        // this cannot consume the very item we are about to advertise.
        try {
          const full = await client.getMessage(entry.id);
          text = `${full.message.subject ?? ''}\n${full.message.body}`;
        } catch {
          /* fall back to the preview — batching is still the floor */
        }
      }
      const hit = mentionRe.test(text);
      mentionSeen.set(entry.id, hit);
      return hit;
    };
    /** Which `--wake-on` kind this item satisfies, if any. */
    const urgency = async (entry: InboxEntry): Promise<WakeKind | undefined> => {
      if (entry.type === 'email') return wakeOn.has('email') ? 'email' : undefined;
      if (wakeOn.has('dm') && entry.room.kind === 'dm') return 'dm';
      return (await mentions(entry)) ? 'mention' : undefined;
    };

    /**
     * The wake decision: an item to wake on (with WHAT matched), a delay after
     * which deferred work becomes batch-eligible, or nothing waiting at all.
     * Unfiltered this is exactly the old one-item question.
     */
    type WakeDecision = { item: InboxEntry; matched: string } | { deferMs: number } | undefined;
    const nextWake = async (): Promise<WakeDecision> => {
      if (!filtering) {
        const item = await oldestWaiting();
        return item ? { item, matched: 'all' } : undefined;
      }
      // Filtered, the HEAD of the queue is not the answer — an urgent DM can sit
      // behind a pile of broadcasts — so scan a page of it.
      const { items } = await client.meInbox({ limit: WAKE_SCAN_LIMIT });
      for (const entry of items) {
        const matched = await urgency(entry);
        if (matched) return { item: entry, matched };
      }
      const oldest = items[0];
      if (!oldest || batchAfterMs <= 0) return undefined;
      const waited = Date.now() - Date.parse(oldest.createdAt);
      if (!Number.isFinite(waited) || waited >= batchAfterMs) return { item: oldest, matched: 'batch' };
      return { deferMs: batchAfterMs - waited };
    };

    /** Set when the first (pre-stream) look found only deferred work. */
    let firstDeferMs: number | undefined;
    let batchTimer: ReturnType<typeof setTimeout> | undefined;

    // A restarting turn-based agent must never block on a stream while its mail
    // sits unread — so ask the queue BEFORE opening anything.
    const alreadyWaiting = await nextWake();
    if (alreadyWaiting && 'item' in alreadyWaiting) {
      wake('waiting', alreadyWaiting.item, { matched: alreadyWaiting.matched });
      await markTurn();
      return;
    }
    if (alreadyWaiting) firstDeferMs = alreadyWaiting.deferMs;

    const controller = new AbortController();
    const disarmSignals = armListenerSignals(env, () => controller.abort());

    // The same cursor discipline as watch/loop: resume with `?since=`, persist
    // per credential, and heal on a gap (see makeEventCursor).
    const stateProfile = activeProfileName(opts, env);
    const identity = eventCursorIdentity(server, token);
    const cursor = makeEventCursor(
      stateProfile ? readEventCursor(env, stateProfile, identity) : undefined,
      (id) => {
        if (!stateProfile) return;
        try {
          writeEventCursor(env, stateProfile, identity, id);
        } catch {
          /* best-effort */
        }
      },
    );

    // Serialize inbox checks (events arrive in bursts) and remember the last
    // in-flight one so the exit path can settle before choosing an exit code.
    let checking = false;
    let recheck = false;
    let pending: Promise<void> | undefined;
    const consider = (reason: string): void => {
      if (emitted || controller.signal.aborted) return;
      if (checking) {
        recheck = true;
        return;
      }
      checking = true;
      pending = (async () => {
        try {
          do {
            recheck = false;
            const decision = await nextWake();
            if (decision && 'item' in decision) {
              wake(reason, decision.item, { matched: decision.matched });
              controller.abort(); // the wake IS the exit
              return;
            }
            // Only deferred work is waiting: nothing here will produce another
            // event, so the batch deadline has to arm its own alarm clock.
            if (decision) armBatch(decision.deferMs);
          } while (recheck && !emitted);
        } catch (e) {
          // A transient inbox read must never end the wait — the next event or
          // poll tick asks again.
          note(
            { type: 'await.check_error', message: String((e as Error)?.message ?? e) },
            `[await] inbox check failed (${String((e as Error)?.message ?? e)}) — still waiting`,
          );
        } finally {
          checking = false;
        }
      })();
    };

    /**
     * The `--batch-after` alarm: re-ask when the oldest deferred item becomes
     * batch-eligible. Re-armed (never stacked) on each look, and cleared with
     * the rest of the timers on exit.
     */
    function armBatch(ms: number): void {
      if (batchTimer !== undefined) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        consider('batch');
      }, Math.max(ms, 10));
      (batchTimer as unknown as { unref?: () => void }).unref?.();
    }
    if (firstDeferMs !== undefined) armBatch(firstDeferMs);

    // A gap means events were missed, so work MAY be waiting and the stream can
    // no longer prove otherwise. Heal the cursor, then WAKE regardless — naming
    // the item when the inbox still shows one, and the drain instruction when it
    // does not. Sitting on a gap is exactly the deafness this command exists to
    // end.
    const onGap = (since?: string | number, latest?: string | number): void => {
      if (emitted || controller.signal.aborted) return;
      cursor.gap(latest);
      pending = (async () => {
        let item: InboxEntry | null = null;
        try {
          item = await oldestWaiting();
        } catch {
          /* the gap itself is the news */
        }
        wake('replay.gap', item, {
          // A gap is missed events: `--wake-on` cannot rule anything out from
          // here, and sitting on it is the deafness this command exists to end.
          matched: 'gap',
          since: since ?? null,
          latest: latest ?? null,
          cursor: cursor.current() ?? null,
        });
        controller.abort();
      })();
    };

    const onEvent = (e: PrincipalEvent): void => {
      if (e.type === 'replay.gap') {
        const gap = e.data as { since?: number; latest?: number };
        onGap(gap.since, gap.latest);
        return;
      }
      if (cursor.seen(e.id)) return; // already surfaced by the other path
      if (e.id !== undefined) cursor.advance(e.id);
      // The two events that can mark inbox availability for the caller: a new
      // chat message, and inbound mail delivered to this agent. Both are only a
      // PROMPT to re-ask the queue — the queue decides.
      if (e.type === 'message.new' || e.type === 'email.received') consider(e.type);
    };

    const newTransport = transportFactory(await loadUndici());
    const open = (onOpen: () => void, onActivity: () => void): EventStreamHandle => {
      const transport = newTransport(); // fresh socket per (re)connect
      const handle = client.meEvents(onEvent, {
        since: cursor.current(),
        // Presence/status churn is filtered SERVER-SIDE for this subscription
        // (see listenerQuiet): `await` is watching for WORK, and nothing about
        // who just came online can put work in its queue.
        quiet,
        onOpen,
        onActivity: () => {
          touchHeartbeat(env, 'await');
          onActivity();
        },
        dispatcher: transport?.dispatcher,
        fetchImpl: transport?.fetchImpl,
      });
      // See watch: this chain exists only to close the Agent, so its inherited
      // rejection MUST be swallowed or it kills the process.
      if (transport) void handle.closed.finally(transport.close).catch(() => {});
      return handle;
    };

    const stopPoll = startReconcilePoll({
      client,
      pollMs: pollMsOf(opts, env),
      timeoutMs: pollTimeoutMsOf(env),
      signal: controller.signal,
      newTransport,
      quiet,
      getLastId: () => cursor.current(),
      onEvent,
      onGap: ({ since, latest }) => onGap(since, latest),
      onError: (e) =>
        lifecycle(
          { type: 'await.poll_error', message: String((e as Error)?.message ?? e) },
          `[await] reconcile poll failed (${String((e as Error)?.message ?? e)})`,
        ),
    });

    let timedOut = false;
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutSeconds * 1000)
        : undefined;
    (timer as { unref?: () => void } | undefined)?.unref?.();

    try {
      const result = await runReconnectingStream({
        open,
        staleMs,
        maxStreamAgeMs,
        signal: controller.signal,
        // A client-version floor (426) is terminal: re-arming against it would
        // burn the harness's wake budget forever while the agent stays deaf.
        isFatal: isUpgradeRequired,
        onReconnect: () =>
          lifecycle(
            { type: 'await.reconnected', since: cursor.current() ?? null },
            `[await] reconnected${cursor.current() !== undefined ? ` (from ${cursor.current()})` : ''}`,
          ),
        onStale: (ms) =>
          lifecycle(
            { type: 'await.stale', staleSeconds: ms / 1000 },
            `[await] stale stream (no data for ${ms / 1000}s) — reconnecting`,
          ),
        onMaxAge: () =>
          lifecycle(
            { type: 'await.refresh', maxStreamAgeSeconds: maxStreamAgeMs! / 1000 },
            `[await] refreshing stream (max age ${maxStreamAgeMs! / 1000}s)`,
          ),
      });
      if (result.reason === 'error') throw result.error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (batchTimer !== undefined) clearTimeout(batchTimer);
      stopPoll();
      disarmSignals();
    }

    // Let an inbox check that was in flight when the stream ended finish, so a
    // wake that had already been decided still wins over the timeout.
    await pending;
    if (emitted) {
      // exit 0 — the wake line is already on stdout; cover the turn it starts.
      await markTurn();
      return;
    }
    // A --timeout expiry plants NOTHING: a harness that re-arms is not a turn,
    // and marking it online would be the same lie in the other direction.
    if (timedOut) {
      emit({ type: 'await.timeout', timeoutSeconds });
      ctx.exitCode = 2; // nothing waiting — a harness re-arms
    }
    // Otherwise: interrupted (Ctrl-C). Exit 0 silently, as `watch` does.
  };

  withListener(withCommon(program.command('await')))
    .description(
      'WAKE primitive for turn-based agents: hold the events stream (presence rides it) until a ' +
        'work item is waiting, print it as one JSON line WITHOUT consuming it, and exit 0 so your ' +
        'harness re-invokes you — then drain with `sparrow pop`. On wake it heartbeats presence ' +
        '(--turn-seconds) so you stay online while you work. Exit 2 = --timeout elapsed (re-arm). ' +
        'Use --wake-on to wake urgently for DMs/mentions/email and batch the rest (--batch-after).',
    )
    .option('--timeout <seconds>', 'give up (exit 2) after this long with nothing waiting', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--stale-seconds <seconds>',
      `reconnect if no data (events or heartbeats) arrive for this long (default ${STALE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--max-stream-age <seconds>',
      `periodically re-establish the stream this often even when healthy (default ${MAX_STREAM_AGE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--poll-seconds <seconds>',
      `reconcile via GET /me/events/log this often, so a black-holed stream can't delay your wake (default ${POLL_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--turn-seconds <seconds>',
      `on wake, heartbeat presence for this long so you stay online while you process the item (default ${TURN_SECONDS_DEFAULT}, max ${PRESENCE_TTL_MAX}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--wake-on <kinds>',
      'wake IMMEDIATELY only for these kinds of work: a comma list of dm, mention, email, all ' +
        '(default all — any work item wakes). Nothing is muted: see --batch-after.',
    )
    .option(
      '--batch-after <seconds>',
      `(with --wake-on) wake anyway once ANY unread work has waited this long, so filtered work ` +
        `is deferred and never muted (default ${BATCH_AFTER_DEFAULT}; 0 = never wake for it — it ` +
        `still shows in \`${AWAIT_DRAIN_CMD}\`)`,
      (v) => Number.parseInt(v, 10),
    )
    .action(action(async (opts) => runAwait(opts)));

  /* ============================ watch ============================ */
  // DELIBERATELY NO TURN HEARTBEAT ON EXIT (unlike `await`). `watch`'s contract
  // is stream-held presence: it is online exactly as long as it runs, and its
  // termination — Ctrl-C, SIGTERM, a killed harness — MEANS going offline. There
  // is no turn on the other side of that exit to cover; painting a mark over it
  // would manufacture the deafness the presence axis exists to expose (online and
  // not listening is worse than honestly offline). `await` is the exception only
  // because exiting is how it HANDS OFF to a turn that is about to run.
  withListener(withRoom(program.command('watch')))
    .description('tail SSE events until Ctrl-C; auto-reconnects (holds presence) unless --no-reconnect')
    .option(
      '--exit-on-item',
      'alias for `sparrow await`: exit 0 on the first waiting work item (printed, NOT consumed) instead of tailing',
    )
    .option('--timeout <seconds>', '(with --exit-on-item) give up (exit 2) after this long', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--turn-seconds <seconds>',
      `(with --exit-on-item) heartbeat presence for this long on wake (default ${TURN_SECONDS_DEFAULT}, max ${PRESENCE_TTL_MAX}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--wake-on <kinds>',
      '(with --exit-on-item) wake only for these kinds of work: dm, mention, email, all (default all)',
    )
    .option(
      '--batch-after <seconds>',
      `(with --exit-on-item and --wake-on) wake anyway once any unread work has waited this long (default ${BATCH_AFTER_DEFAULT}; 0 = never)`,
      (v) => Number.parseInt(v, 10),
    )
    .option('--no-reconnect', 'exit on first disconnect (old behavior) instead of reconnecting')
    .option('--retry-max <seconds>', 'give up (exit 1) after this many seconds of failed reconnects', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--stale-seconds <seconds>',
      `reconnect if no data (events or heartbeats) arrive for this long (default ${STALE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--max-stream-age <seconds>',
      `periodically re-establish the stream this often even when healthy (default ${MAX_STREAM_AGE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--poll-seconds <seconds>',
      `(no --room) reconcile via GET /me/events/log this often (unconditionally), so a black-holed stream can't delay delivery (default ${POLL_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .action(
      action(async (opts) => {
        // `watch --exit-on-item` IS `sparrow await` — one implementation, so the
        // two can never drift on the not-consumed guarantee or the exit codes.
        if (opts.exitOnItem) return runAwait(opts);
        const { client, server, token } = buildClient(opts, env);
        const roomSel = roomSelector(opts, env);
        const roomId = roomSel ? await resolveRoom(client, opts, env) : undefined;
        const { staleMs, maxStreamAgeMs } = streamHealthOpts(opts);
        const { verbose, quiet } = listenerQuiet(opts);
        /**
         * ROUTINE LIFECYCLE: the runtime narrating its own plumbing. Silent in
         * human mode unless `-v`; the `-j` line protocol is a contract and every
         * frame still lands on stdout byte-identically either way. Anomalies —
         * the replay-gap line below, exhausted retries, a terminal 426 — never
         * come through here.
         */
        const lifecycle = (json: Record<string, unknown>, human: string): void => {
          if (ctx.json) io.out(`${JSON.stringify(json)}\n`);
          else if (verbose) io.out(`${human}\n`);
        };

        const controller = new AbortController();
        const disarmSignals = armListenerSignals(env, () => controller.abort());

        // Remember the last-seen `/me/events` cursor across ALL reconnects
        // (watchdog, max-age, error) so each re-open resumes with `?since=` and
        // the server replays what was missed instead of dropping it. This single
        // cursor is also the dedupe gate the reconcile poll passes through, so the
        // stream and the poll never surface the same frame twice.
        // Cursor continuity ACROSS processes: resume from the persisted
        // per-profile cursor so a restarted watch replays exactly what was
        // missed while it was down — and never re-floods the retained journal
        // the way a cursorless backfill-from-0 would. Advances write through
        // (best-effort) on every surfaced frame. The stored cursor is scoped to
        // the CREDENTIAL that earned it, so a re-enrolled profile never inherits
        // a dead cursor from the identity it replaced.
        const stateProfile = activeProfileName(opts, env);
        const identity = eventCursorIdentity(server, token);
        const cursor = makeEventCursor(
          stateProfile ? readEventCursor(env, stateProfile, identity) : undefined,
          (id) => {
            if (!stateProfile) return;
            try {
              writeEventCursor(env, stateProfile, identity, id);
            } catch {
              /* state is a convenience — never fail the stream over it */
            }
          },
        );
        // ONE actionable line per gap — not one per poll tick, and never the raw
        // structural frame. Whatever the server could not replay is recovered by
        // draining the inbox, so that is what it says.
        const noteGap = (since: string | number | undefined, latest?: string | number): void => {
          const before = cursor.current();
          if (!cursor.gap(latest)) return;
          const after = cursor.current();
          io.out(
            ctx.json
              ? `${JSON.stringify({
                  type: 'watch.gap',
                  since: since ?? before ?? null,
                  latest: latest ?? null,
                  cursor: after ?? null,
                })}\n`
              : `[watch] events were missed — the server cannot replay from cursor ${before ?? 'none'} ` +
                  `(now ${after ?? 'cleared'}); drain your inbox to catch up: \`sparrow pop\`\n`,
          );
        };
        const printMe = (e: PrincipalEvent): void => {
          if (e.type === 'replay.gap') {
            const gap = e.data as { since?: number; latest?: number };
            noteGap(gap.since, gap.latest);
            return; // structural frame — the notice above replaces the raw dump
          }
          if (cursor.seen(e.id)) return; // already surfaced by the other path
          if (e.id !== undefined) cursor.advance(e.id);
          io.out(ctx.json ? `${JSON.stringify(e)}\n` : `${formatMeEvent(e)}\n`);
        };
        const newTransport = transportFactory(await loadUndici());
        const open = (onOpen: () => void, onActivity: () => void): EventStreamHandle => {
          const transport = newTransport(); // fresh socket per (re)connect
          const handle = roomId
            ? client.events(
                roomId,
                (e) => io.out(ctx.json ? `${JSON.stringify(e)}\n` : `${formatEvent(e)}\n`),
                {
                  onOpen,
                  onActivity: () => {
                    touchHeartbeat(env, 'watch');
                    onActivity();
                  },
                  dispatcher: transport?.dispatcher,
                  fetchImpl: transport?.fetchImpl,
                },
              )
            : client.meEvents(printMe, {
                since: cursor.current(),
                // Filtered server-side for THIS subscription only (see
                // listenerQuiet): the journal keeps every frame, and the web —
                // which subscribes unfiltered — still renders the glyphs.
                quiet,
                onOpen,
                onActivity: () => {
                  touchHeartbeat(env, 'watch');
                  onActivity();
                },
                dispatcher: transport?.dispatcher,
                fetchImpl: transport?.fetchImpl,
              });
          // Close the fresh transport once this stream ends. `handle.closed` is
          // authoritatively awaited by runReconnectingStream; THIS chain exists only
          // to close the Agent, so its inherited rejection MUST be swallowed. Without
          // the `.catch`, a fresh-transport SSE fetch that rejects with a non-abort
          // connect error (UND_ERR_CONNECT_TIMEOUT / ECONNREFUSED — a CDN edge briefly
          // refusing connects) floats an UNHANDLED rejection off this `void` chain and
          // kills the whole `watch`/`loop` process. (Prod incident, 2026-08-29.)
          if (transport) void handle.closed.finally(transport.close).catch(() => {});
          return handle;
        };

        // The reconcile poll is the `/me/events` fan-in's belt-and-suspenders; a
        // room-scoped stream has no journal to poll.
        const stopPoll =
          roomId !== undefined
            ? (): void => {}
            : startReconcilePoll({
                client,
                pollMs: pollMsOf(opts, env),
                timeoutMs: pollTimeoutMsOf(env),
                signal: controller.signal,
                newTransport,
                quiet,
                getLastId: () => cursor.current(),
                onEvent: printMe,
                onGap: ({ since, latest }) => noteGap(since, latest),
                onError: (e) => {
                  if (ctx.json) {
                    io.out(
                      `${JSON.stringify({ type: 'watch.poll_error', message: String((e as Error)?.message ?? e) })}\n`,
                    );
                  }
                },
              });

        try {
          const result = await runReconnectingStream({
            open,
            reconnect: opts.reconnect !== false,
            retryMaxMs:
              opts.retryMax !== undefined ? (opts.retryMax as number) * 1000 : undefined,
            staleMs,
            maxStreamAgeMs,
            signal: controller.signal,
            // A client-version floor (426) is the one failure retrying cannot
            // clear — stop instead of reconnect-looping against it.
            isFatal: isUpgradeRequired,
            onReconnect: () =>
              lifecycle(
                { type: 'watch.reconnected', since: cursor.current() ?? null },
                cursor.current() !== undefined
                  ? `[watch] resumed from ${cursor.current()}`
                  : '[watch] reconnected',
              ),
            onStale: (ms) =>
              lifecycle(
                { type: 'watch.stale', staleSeconds: ms / 1000 },
                `[watch] stale stream (no data for ${ms / 1000}s) — reconnecting`,
              ),
            onMaxAge: () =>
              lifecycle(
                { type: 'watch.refresh', maxStreamAgeSeconds: maxStreamAgeMs! / 1000 },
                `[watch] refreshing stream (max age ${maxStreamAgeMs! / 1000}s)`,
              ),
          });
          if (result.reason === 'exhausted') {
            throw new CliError('watch: reconnect retries exhausted (see --retry-max).');
          }
          if (result.reason === 'error') throw result.error;
        } finally {
          stopPoll();
          disarmSignals();
        }
      }),
    );

  /* ============================ loop ============================ */
  withListener(withRoom(program.command('loop')))
    .description(
      'agent runtime: hold the events stream open (auto-reconnect) and drain `pop` on ' +
        'connect and on every new work item. Without --room each item is a typed WORK ITEM ' +
        '(chat.message | email) printed as a JSON line — handlers MUST switch on `type`, the ' +
        'shape differs per medium; with --room it stays a stream of chat messages. ' +
        'With --exec, runs a handler per item.',
    )
    .option('--exec <cmd>', 'run this command per item (work-item JSON on stdin; a bare message with --room); nonzero exit logs, does not stop the loop')
    .option('--no-reconnect', 'exit on first disconnect instead of reconnecting')
    .option('--retry-max <seconds>', 'give up (exit 1) after this many seconds of failed reconnects', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--stale-seconds <seconds>',
      `reconnect if no data (events or heartbeats) arrive for this long (default ${STALE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--max-stream-age <seconds>',
      `periodically re-establish the stream this often even when healthy (default ${MAX_STREAM_AGE_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--poll-seconds <seconds>',
      `(no --room) reconcile via GET /me/events/log this often (unconditionally), so a black-holed stream can't delay draining (default ${POLL_SECONDS_DEFAULT}; 0 disables)`,
      (v) => Number.parseInt(v, 10),
    )
    .action(
      action(async (opts) => {
        const { client, server, token } = buildClient(opts, env);
        const roomSel = roomSelector(opts, env);
        const roomId = roomSel ? await resolveRoom(client, opts, env) : undefined;
        const exec = opts.exec as string | undefined;
        const { staleMs, maxStreamAgeMs } = streamHealthOpts(opts);
        const { verbose, quiet } = listenerQuiet(opts);
        /**
         * ROUTINE LIFECYCLE. `loop`'s stdout is a machine work-item stream, so
         * the human forms have always gone to stderr; now they go there only
         * under `-v`. The `-j` frames still land on stdout unchanged — the line
         * protocol is a contract. Anomalies (the gap line, an unrecognized work
         * item, exhausted retries) are never routed through here.
         */
        const lifecycle = (json: Record<string, unknown>, human: string): void => {
          if (ctx.json) io.out(`${JSON.stringify(json)}\n`);
          else if (verbose) io.err(`${human}\n`);
        };

        // The room-scoped drain stays chat-only (rooms have no email): a bare
        // Message per item, exactly as in v3.
        const handleMessage = async (msg: Message, roomOfMsg: string): Promise<void> => {
          recordInbound(env, opts, msg, roomOfMsg);
          if (exec) await runExec(exec, msg, io, `message ${msg.id}`);
          else io.out(`${JSON.stringify(msg)}\n`);
        };

        // The medium-spanning drain hands the handler a typed WORK ITEM — the
        // shape differs per medium, so handlers MUST switch on `type`.
        const handleWorkItem = async (item: WorkItem): Promise<void> => {
          if (item.type === 'chat.message') {
            recordInbound(env, opts, item.message, item.room.id);
          } else {
            recordEmail(env, opts, item.email);
          }
          const id = item.type === 'chat.message' ? item.message.id : item.email.id;
          if (exec) await runExec(exec, item, io, `${item.type} ${id}`);
          else io.out(`${JSON.stringify(item)}\n`);
        };

        // Serialize drains: a message arriving mid-drain flags one more pass.
        let draining = false;
        let rerun = false;
        const drain = async (): Promise<void> => {
          if (draining) {
            rerun = true;
            return;
          }
          draining = true;
          try {
            do {
              rerun = false;
              for (;;) {
                if (roomId) {
                  const msg = await client.popNextMessage(roomId);
                  if (!msg) break;
                  await handleMessage(msg, roomId);
                } else {
                  const res = await client.meInboxPop();
                  // `loop`'s stdout is a MACHINE STREAM — one JSON work item per
                  // line, in both output modes — so the hint riding this drain's
                  // final empty pop is deliberately not rendered here. The
                  // channel an agent chose by running `loop` is a work-item
                  // protocol, and a `[hint]` line in it would be a protocol
                  // break, not a nudge. That agent asks with `sparrow tips`.
                  if (res.unknownItem) {
                    // A medium this CLI predates: leave it for a newer client and
                    // keep draining. Never an error, never a stopped loop.
                    io.err(
                      ctx.json
                        ? `${JSON.stringify({ type: 'loop.unknown_item', item: res.unknownItem })}\n`
                        : `[loop] unrecognized work item type "${res.unknownItem.type}" — left for a newer client\n`,
                    );
                    continue;
                  }
                  if (!res.item) break;
                  await handleWorkItem(res.item);
                }
              }
            } while (rerun);
          } catch (e) {
            // A drain runs fire-and-forget (on connect and per new-message event),
            // so a transient pop failure — a reconnect tearing the socket down,
            // a blip — must NOT become an unhandled rejection or stop the loop.
            // The next event/(re)connect drain retries; only surface it in -j mode.
            if (ctx.json) io.err(`${JSON.stringify({ type: 'loop.drain_error', message: String((e as Error)?.message ?? e) })}\n`);
          } finally {
            draining = false;
          }
        };

        const controller = new AbortController();
        const disarmSignals = armListenerSignals(env, () => controller.abort());

        // Remember the last-seen `/me/events` cursor so each reconnect resumes
        // with `?since=` and the server REPLAYS what was missed. A replayed
        // `message.new` drives the same pop-drain a live one does; `replay.gap`
        // (replay is known-incomplete, e.g. beyond retention) falls back to a
        // full inbox reconcile.
        // This single cursor is BOTH the reconnect resume point and the dedupe
        // gate the reconcile poll passes through, so a live frame and a polled one
        // never trigger the drain twice for the same id.
        // Cursor continuity ACROSS processes (see watch): resume from the
        // persisted per-profile cursor — scoped to the credential that earned it,
        // so a re-enrolled profile starts clean — and the first-open inbox drain
        // (below) is the additional belt-and-suspenders for anything unread.
        const stateProfile = activeProfileName(opts, env);
        const identity = eventCursorIdentity(server, token);
        const cursor = makeEventCursor(
          stateProfile ? readEventCursor(env, stateProfile, identity) : undefined,
          (id) => {
            if (!stateProfile) return;
            try {
              writeEventCursor(env, stateProfile, identity, id);
            } catch {
              /* best-effort */
            }
          },
        );
        // A gap means events were missed: heal the cursor (see makeEventCursor),
        // say so ONCE in one line, and reconcile the only way a client can — the
        // full inbox drain loop already runs on connect.
        const onGap = (since: string | number | undefined, latest?: string | number): void => {
          const before = cursor.current();
          if (cursor.gap(latest)) {
            const after = cursor.current();
            if (ctx.json) {
              io.out(
                `${JSON.stringify({
                  type: 'loop.gap',
                  since: since ?? before ?? null,
                  latest: latest ?? null,
                  cursor: after ?? null,
                })}\n`,
              );
            } else {
              io.err(
                `[loop] events were missed — the server cannot replay from cursor ${before ?? 'none'} ` +
                  `(now ${after ?? 'cleared'}); draining the inbox to catch up\n`,
              );
            }
          }
          void drain();
        };
        const onEvent = (e: PrincipalEvent): void => {
          if (e.type === 'replay.gap') {
            const gap = e.data as { since?: number; latest?: number };
            onGap(gap.since, gap.latest);
            return;
          }
          if (cursor.seen(e.id)) return; // already handled by the other path
          if (e.id !== undefined) cursor.advance(e.id);
          if (e.type === 'message.new') void drain();
        };
        const newTransport = transportFactory(await loadUndici());
        let firstOpen = true;
        const open = (onOpen: () => void, onActivity: () => void): EventStreamHandle => {
          const transport = newTransport(); // fresh socket per (re)connect
          const handle = roomId
            ? client.events(roomId, onEvent, {
                onOpen: () => {
                  onOpen();
                  void drain(); // room streams don't resume — drain on (re)connect
                },
                onActivity: () => {
                  touchHeartbeat(env, 'loop');
                  onActivity();
                },
                dispatcher: transport?.dispatcher,
                fetchImpl: transport?.fetchImpl,
              })
            : client.meEvents(onEvent, {
                since: cursor.current(),
                // Filtered server-side for THIS subscription (see listenerQuiet):
                // only `message.new` drives a drain, and presence/status churn
                // can never put work in the queue.
                quiet,
                onOpen: () => {
                  // The FIRST connect drains the pre-startup backlog (the seeded
                  // cursor deliberately skips old journal events); reconnects
                  // trust replay and reconcile only on replay.gap.
                  const initial = firstOpen;
                  firstOpen = false;
                  onOpen();
                  if (initial) void drain();
                },
                onActivity: () => {
                  touchHeartbeat(env, 'loop');
                  onActivity();
                },
                dispatcher: transport?.dispatcher,
                fetchImpl: transport?.fetchImpl,
              });
          // Close the fresh transport once this stream ends. `handle.closed` is
          // authoritatively awaited by runReconnectingStream; THIS chain exists only
          // to close the Agent, so its inherited rejection MUST be swallowed. Without
          // the `.catch`, a fresh-transport SSE fetch that rejects with a non-abort
          // connect error (UND_ERR_CONNECT_TIMEOUT / ECONNREFUSED — a CDN edge briefly
          // refusing connects) floats an UNHANDLED rejection off this `void` chain and
          // kills the whole `watch`/`loop` process. (Prod incident, 2026-08-29.)
          if (transport) void handle.closed.finally(transport.close).catch(() => {});
          return handle;
        };

        // Reconcile poll for the `/me/events` fan-in: a polled `message.new` drives
        // the same drain a live one does; a `gap` triggers a full inbox reconcile.
        const stopPoll =
          roomId !== undefined
            ? (): void => {}
            : startReconcilePoll({
                client,
                pollMs: pollMsOf(opts, env),
                timeoutMs: pollTimeoutMsOf(env),
                signal: controller.signal,
                newTransport,
                quiet,
                getLastId: () => cursor.current(),
                onEvent,
                onGap: ({ since, latest }) => onGap(since, latest),
                onError: (e) => {
                  if (ctx.json) {
                    io.err(
                      `${JSON.stringify({ type: 'loop.poll_error', message: String((e as Error)?.message ?? e) })}\n`,
                    );
                  }
                },
              });

        try {
          const result = await runReconnectingStream({
            open,
            reconnect: opts.reconnect !== false,
            retryMaxMs:
              opts.retryMax !== undefined ? (opts.retryMax as number) * 1000 : undefined,
            staleMs,
            maxStreamAgeMs,
            signal: controller.signal,
            // A client-version floor (426) cannot be retried away — stop on it.
            isFatal: isUpgradeRequired,
            onReconnect: () => {
              const at = cursor.current();
              lifecycle(
                { type: 'watch.reconnected', since: at ?? null },
                at !== undefined ? `[loop] resumed from ${at}` : '[loop] reconnected',
              );
            },
            onStale: (ms) =>
              lifecycle(
                { type: 'watch.stale', staleSeconds: ms / 1000 },
                `[loop] stale stream (no data for ${ms / 1000}s) — reconnecting`,
              ),
            onMaxAge: () =>
              lifecycle(
                { type: 'watch.refresh', maxStreamAgeSeconds: maxStreamAgeMs! / 1000 },
                `[loop] refreshing stream (max age ${maxStreamAgeMs! / 1000}s)`,
              ),
          });
          if (result.reason === 'exhausted') {
            throw new CliError('loop: reconnect retries exhausted (see --retry-max).');
          }
          if (result.reason === 'error') throw result.error;
        } finally {
          stopPoll();
          disarmSignals();
        }
      }),
    );

  registerHarnessCommand(program, { env, io, withCommon, action });

  /* ============================ use ============================ */
  const useCmd = withCommon(program.command('use'))
    .description('set sticky defaults on the active profile: `sparrow use <room|org>`; --clear; bare prints them')
    .argument('[target]', 'a room or org (id, name, or slug)')
    .option('--clear', 'clear the stored defaults')
    .action(
      action(async (opts, args) => {
        const name = activeProfileName(opts, env);
        if (!name) {
          throw new CliError('`sparrow use` needs an active profile. Run `sparrow login`/`login-agent` first.');
        }
        const target = args[0];

        if (opts.clear) {
          updateProfileState(env, name, { defaultRoom: null, defaultOrg: null });
          print({ profile: name, defaultRoom: null, defaultOrg: null }, 'Cleared sticky defaults.');
          return;
        }

        if (!target) {
          const st = getProfileState(env, name);
          print(
            { profile: name, defaultRoom: st.defaultRoom ?? null, defaultOrg: st.defaultOrg ?? null },
            `Profile "${name}" defaults:\n` +
              `  room: ${st.defaultRoom ?? '(none)'}\n` +
              `  org:  ${st.defaultOrg ?? '(none)'}`,
          );
          return;
        }

        const { client } = buildClient(opts, env);
        // Explicit id prefixes are unambiguous; otherwise try room, then org.
        if (/^org_/.test(target)) {
          const orgId = await resolveOrg(client, { ...opts, org: target }, env);
          updateProfileState(env, name, { defaultOrg: orgId });
          print({ profile: name, defaultOrg: orgId }, `Default org set to ${orgId}.`);
          return;
        }
        if (/^room_/.test(target)) {
          const rid = await resolveRoom(client, { ...opts, room: target }, env);
          updateProfileState(env, name, { defaultRoom: rid });
          print({ profile: name, defaultRoom: rid }, `Default room set to ${rid}.`);
          return;
        }
        // A bare name/slug: prefer a room match, fall back to an org.
        try {
          const rid = await resolveRoom(client, { ...opts, room: target }, env);
          updateProfileState(env, name, { defaultRoom: rid });
          print({ profile: name, defaultRoom: rid }, `Default room set to ${rid}.`);
          return;
        } catch (roomErr) {
          try {
            const orgId = await resolveOrg(client, { ...opts, org: target }, env);
            updateProfileState(env, name, { defaultOrg: orgId });
            print({ profile: name, defaultOrg: orgId }, `Default org set to ${orgId}.`);
            return;
          } catch {
            throw roomErr instanceof CliError
              ? new CliError(`No room or org "${target}" found among your memberships.`)
              : roomErr;
          }
        }
      }),
    );
  void useCmd;

  /* ============================ dm ============================ */
  withOrg(program.command('dm'))
    .description('ensure a DM with a principal (or visible agent); optionally send a message')
    .argument('<target>', 'a principal id (usr_/agt_) or an agent name')
    .argument('[message]', 'message to send into the DM')
    .option('--subject <s>', 'subject line')
    .action(
      action(async (opts, args) => {
        const target = args[0]!;
        const message = args[1];
        const { client } = buildClient(opts, env);
        const org = await resolveOrgOptional(client, opts, env);
        let principal = target;
        if (!/^(usr_|agt_)/.test(target)) {
          principal = (await resolvePrincipal(client, target, org)).id;
        }
        const dm = await client.ensureDm({ principal, orgId: org });
        if (message !== undefined) {
          const sent = await client.sendMessage(dm.room.id, {
            to: 'all',
            subject: opts.subject as string | undefined,
            body: message,
          });
          print({ dm, sent }, `${dmSummary(dm)}\nSent ${sent.message.id} (${sent.message.kind}).`);
          return;
        }
        print({ dm }, dmSummary(dm));
      }),
    );

  /* ============================ agent-dms ============================ */
  // The human-oversight surface onto agent↔agent DMs: list the boxes you may
  // watch, read one as a transcript. Read-only end to end — no send, no ack,
  // and the read route itself writes no read state.
  const agentDmsCmd = withOrg(program.command('agent-dms')).description(
    'agent↔agent DM oversight: conversations between two agents you can both see (read-only)',
  );
  // The routes take HUMAN sessions only, so a valid AGENT key still 401s — a
  // "wrong kind of credential" that the generic auth advice ("re-enroll") would
  // misdiagnose as a broken key. When the active profile IS an agent, name the
  // surface and the agent's actual tool; a human's 401 stays a real auth error.
  const explainOversight401 = (e: unknown, kind: 'human' | 'agent' | undefined): unknown =>
    e instanceof ApiError && e.status === 401 && kind === 'agent'
      ? new CliError(
          'agent-dms is the human oversight surface — it takes a signed-in HUMAN ' +
            '(session credentials), never an agent key. As an agent, talk to another ' +
            'agent directly with `sparrow dm <agent> "<message>"`.',
        )
      : e;
  const listAgentDms = action(async (opts) => {
    const { client, kind } = buildClient(opts, env);
    try {
      const orgId = await resolveOrg(client, opts, env);
      const res = await client.agentDms(orgId);
      print(res, formatAgentDms(res.items));
    } catch (e) {
      throw explainOversight401(e, kind);
    }
  });
  agentDmsCmd.action(listAgentDms);
  withOrg(agentDmsCmd.command('read'))
    .description('read one oversight box as an oldest-first transcript (writes no read state)')
    .argument('<roomId>', 'the box room id (first column of `sparrow agent-dms`)')
    .option('--limit <n>', 'how many recent messages to fetch (default 50, max 200)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--before <messageId>', 'page backwards: fetch messages older than this id')
    .action(
      action(async (opts, args) => {
        const { client, kind } = buildClient(opts, env);
        try {
          const orgId = await resolveOrg(client, opts, env);
          const res = await client.agentDmMessages(orgId, args[0]!, {
            limit: opts.limit as number | undefined,
            before: opts.before as string | undefined,
          });
          print(res, formatLog(res.items));
        } catch (e) {
          throw explainOversight401(e, kind);
        }
      }),
    );

  /**
   * The off switch (`sparrow agent-dms sever|allow`). Governance, not oversight:
   * watching a pair never confers it — you must be an org owner/admin or an
   * owner of one of the two agents, else the server answers "No such
   * conversation" exactly as it does for a room you cannot watch at all.
   */
  const severSummary = (s: AgentDmSever): string =>
    `Severed ${s.agents[0].name} ↔ ${s.agents[1].name} (${s.roomId}) at ${s.severedAt}.\n` +
    `Both agents are cut off; you and every other overseer keep the transcript.\n` +
    `Re-allow with: sparrow agent-dms allow ${s.roomId}`;

  withOrg(agentDmsCmd.command('sever'))
    .description('cut an agent↔agent DM (owner/admin, or an owner of either agent)')
    .argument('<roomId>', 'the box room id (first column of `sparrow agent-dms`)')
    .action(
      action(async (opts, args) => {
        const { client, kind } = buildClient(opts, env);
        try {
          const orgId = await resolveOrg(client, opts, env);
          const sever = await client.severAgentDm(orgId, args[0]!);
          print({ sever }, severSummary(sever));
        } catch (e) {
          throw explainOversight401(e, kind);
        }
      }),
    );

  withOrg(agentDmsCmd.command('allow'))
    .description('lift a sever — the agents may open the conversation again')
    .argument('<roomId>', 'the severed box room id')
    .action(
      action(async (opts, args) => {
        const { client, kind } = buildClient(opts, env);
        try {
          const orgId = await resolveOrg(client, opts, env);
          await client.allowAgentDm(orgId, args[0]!);
          print(
            { roomId: args[0]!, allowed: true },
            `Allowed ${args[0]!}. The pair may open the conversation again — nothing ` +
              `re-opens until one of the agents does.`,
          );
        } catch (e) {
          throw explainOversight401(e, kind);
        }
      }),
    );

  /* ============================ room ============================ */
  const room = program.command('room').description('room operations');
  withOrg(room.command('create'))
    .description('create a project room (you become owner)')
    .argument('<name>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const orgId = await resolveOrg(client, opts, env);
        const created = await client.createRoom(orgId, { name: args[0]! });
        print(created, `Room "${created.name}" created (${created.id}).`);
      }),
    );
  /**
   * Archive / restore. Two doors, one command: a room's own owner may PATCH it,
   * and an org owner/admin may archive ANY room in the org without joining it
   * (SPEC "Rooms & members → Org room governance"). We try the member door
   * first and fall back to the governance one, so the caller never has to know
   * which hat they are wearing.
   */
  const setArchived = async (
    opts: Record<string, unknown>,
    roomId: string,
    archived: boolean,
  ): Promise<{ id: string; name: string; archivedAt: string | null }> => {
    const { client } = buildClient(opts, env);
    try {
      const updated = await client.updateRoom(roomId, { archived });
      return { id: updated.id, name: updated.name, archivedAt: updated.archivedAt };
    } catch (e) {
      if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
      const orgId = await resolveOrg(client, opts, env);
      const room = await client.setOrgRoomArchived(orgId, roomId, archived);
      return { id: room.id, name: room.name, archivedAt: room.archivedAt };
    }
  };

  withOrg(room.command('archive'))
    .description('archive a room (its owner, or an org owner/admin for any room in the org)')
    .argument('<roomId>', 'the room id (`sparrow rooms`, or `sparrow rooms --all` as an admin)')
    .action(
      action(async (opts, args) => {
        const updated = await setArchived(opts, args[0]!, true);
        print(
          { room: updated },
          `Archived ${updated.name || updated.id} (${updated.id}). Members keep the history; ` +
            `every further change answers 410 until it is restored.`,
        );
      }),
    );

  withOrg(room.command('restore'))
    .description('restore an archived room')
    .argument('<roomId>', 'the room id')
    .action(
      action(async (opts, args) => {
        const updated = await setArchived(opts, args[0]!, false);
        print({ room: updated }, `Restored ${updated.name || updated.id} (${updated.id}).`);
      }),
    );

  withRoom(room.command('add'))
    .description('attach a visible agent to a room')
    .argument('<agent>', 'agent name or agt_ id')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const org = await resolveOrgOptional(client, opts, env);
        const agent = await resolvePrincipal(client, args[0]!, org);
        const member = await client.addMember(roomId, agent.id);
        print(member, `Added ${member.displayName} (${member.principalId}) as ${member.id}.`);
      }),
    );
  withRoom(room.command('invite'))
    .description('invite a human to a room (they accept)')
    .argument('<human>', 'email or usr_ id')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const roomId = await resolveRoom(client, opts, env);
        const res = await client.inviteHuman(roomId, args[0]!);
        print(
          res,
          `${res.created ? 'Invited' : 'Already invited'} ${res.invitation.human.displayName} ` +
            `(${res.invitation.id}).`,
        );
      }),
    );

  /* ============================ invitations ============================ */
  const invitations = withCommon(program.command('invitations')).description('your room invitations');
  const listInvitations = action(async (opts) => {
    const { client } = buildClient(opts, env);
    const items = await client.meRoomInvitations();
    print({ items }, formatRoomInvitations(items));
  });
  invitations.action(listInvitations);
  withCommon(invitations.command('list')).description('list your room invitations').action(listInvitations);
  withCommon(invitations.command('accept'))
    .description('accept a room invitation')
    .argument('<invitationId>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        const res = await client.acceptRoomInvitation(args[0]!);
        print(res, `Joined "${res.room.name}" (${res.room.id}) as ${res.member.roomRole}.`);
      }),
    );
  withCommon(invitations.command('decline'))
    .description('decline a room invitation')
    .argument('<invitationId>')
    .action(
      action(async (opts, args) => {
        const { client } = buildClient(opts, env);
        await client.declineRoomInvitation(args[0]!);
        print({ ok: true, invitationId: args[0] }, `Declined ${args[0]}.`);
      }),
    );

  /* ============================ admin ============================ */
  const admin = program.command('admin').description('instance admin operations (require --admin-token)');
  const adminTokenOf = (opts: Record<string, unknown>): string => {
    const t = (opts.adminToken as string | undefined) ?? env.ADMIN_TOKEN ?? env.SPARROW_ADMIN_TOKEN;
    if (!t) throw new CliError('admin commands require --admin-token <token> (or ADMIN_TOKEN).');
    return t;
  };
  const adminServerOf = (opts: GlobalOpts): string => {
    const s = opts.server ?? env.SPARROW_SERVER;
    if (!s) throw new CliError('admin commands require --server <url> (or SPARROW_SERVER).');
    return s;
  };
  const withAdmin = (cmd: Cmd): Cmd =>
    cmd
      .option('-j, --json', 'output machine-readable JSON')
      .option('--server <url>', 'server URL')
      .option('--admin-token <token>', 'instance admin token');

  withAdmin(admin.command('orgs'))
    .description('list all orgs with counts')
    .action(
      action(async (opts) => {
        const client = new SparrowClient({ server: adminServerOf(opts), clientIdent: CLI_CLIENT_IDENT });
        const items = await client.adminListOrgs(adminTokenOf(opts));
        print(
          { items },
          items.length === 0
            ? 'No orgs.'
            : table(
                ['ID', 'SLUG', 'NAME', 'HUMANS', 'AGENTS', 'ROOMS'],
                items.map((o: AdminOrg) => [
                  o.id,
                  o.slug,
                  o.name,
                  String(o.humanCount),
                  String(o.agentCount),
                  String(o.roomCount),
                ]),
              ),
        );
      }),
    );
  withAdmin(admin.command('rooms'))
    .description('list all rooms (incl. archived + DMs) with counts')
    .option('--org <orgId>', 'narrow to one org')
    .action(
      action(async (opts) => {
        const client = new SparrowClient({ server: adminServerOf(opts), clientIdent: CLI_CLIENT_IDENT });
        const items = await client.adminListRooms({
          org: opts.org as string | undefined,
          adminToken: adminTokenOf(opts),
        });
        print(
          { items },
          items.length === 0
            ? 'No rooms.'
            : table(
                ['ID', 'ORG', 'NAME', 'KIND', 'MEMBERS', 'MESSAGES'],
                items.map((r: AdminRoom) => [
                  r.id,
                  r.orgId,
                  r.name || '(dm)',
                  r.kind,
                  String(r.memberCount),
                  String(r.messageCount),
                ]),
              ),
        );
      }),
    );
  withAdmin(admin.command('delete'))
    .description('hard-delete a resource and cascade')
    .argument('<kind>', 'org | room | agent | human')
    .argument('<id>')
    .action(
      action(async (opts, args) => {
        const client = new SparrowClient({ server: adminServerOf(opts), clientIdent: CLI_CLIENT_IDENT });
        const token = adminTokenOf(opts);
        const kind = args[0];
        const id = args[1]!;
        switch (kind) {
          case 'org':
            await client.adminDeleteOrg(id, token);
            break;
          case 'room':
            await client.adminDeleteRoom(id, token);
            break;
          case 'agent':
            await client.adminDeleteAgent(id, token);
            break;
          case 'human':
            await client.adminDeleteHuman(id, token);
            break;
          default:
            throw new CliError(`Unknown delete kind "${kind}" (expected org|room|agent|human).`);
        }
        print({ ok: true, kind, id }, `Deleted ${kind} ${id}.`);
      }),
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    const ce = e as { code?: string; exitCode?: number };
    // An option typed one word early is the commonest near-miss, and commander's
    // bare "unknown option '--room'" points at a flag that plainly exists —
    // leaving the reader to conclude the CLI does not support it. Say where it
    // belongs instead, but ONLY when it really was in the global position: the
    // same code fires for a genuine typo after the command, where "move it later"
    // would be nonsense.
    if (ce.code === 'commander.unknownOption') {
      const flag = /'(--?[^']+)'/.exec(String((e as Error).message ?? ''))?.[1];
      const names = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
      const flagIndex = flag ? argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`)) : -1;
      const commandIndex = argv.findIndex((a) => names.has(a));
      if (flag && flagIndex >= 0 && (commandIndex === -1 || flagIndex < commandIndex)) {
        io.err(
          `\n${flag} is a command option, and it belongs AFTER the command: ` +
            `sparrow <command> ${flag} …\n` +
            'Only --json, --profile and --server may come before the command.\n',
        );
      }
    }
    if (
      ce.code === 'commander.helpDisplayed' ||
      ce.code === 'commander.version' ||
      ce.code === 'commander.help'
    ) {
      return 0;
    }
    if (ctx.exitCode === 0) {
      ctx.exitCode = typeof ce.exitCode === 'number' && ce.exitCode !== 0 ? ce.exitCode : 1;
    }
  }
  return ctx.exitCode;
}

// Re-export commonly used types for tests / embedders.
export type { EventRoomRef, InboxRoomRef };
