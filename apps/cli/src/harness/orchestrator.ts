/**
 * The `sparrow harness` run loop: hold a work source open, and when work lands,
 * spawn an agent to answer it.
 *
 * The whole design is one sentence: **peek, run, then ack**. `sparrow loop
 * --exec` pops first and loses the item when the handler dies; the harness
 * never consumes anything it has not already answered, so a crashed runner, a
 * killed process or a laptop lid costs a repeated turn and never a lost
 * message. That is at-least-once, chosen deliberately over at-most-once.
 *
 * The "wait for work" primitive is INJECTED ({@link WorkSource}) rather than
 * hard-wired to the events stream, so the loop is drivable from a test with no
 * SSE at all, and the live listener can be swapped underneath it.
 *
 * Concurrency in v1 is one runner at a time, globally. Per-ROOM concurrency is
 * the obvious next step (`nextRunnable` already picks a group, and groups are
 * independent by construction) — it is held back only because two agents
 * writing the same working tree at once is a worse failure than a queued reply.
 */
import { randomUUID } from 'node:crypto';
import type { SparrowClient } from '@sparrow/client';
import type { Email, InboxEntry, Message } from '@sparrow/common-types';
import type { Env } from '../util.js';
import {
  backoffMs,
  dropItem,
  groupKeyOf,
  mergeIntoGroups,
  msUntilRunnable,
  nextRunnable,
  type PendingGroup,
} from './group.js';
import { NO_REPLY, buildPrompt, type PromptMessage } from './prompt.js';
import { buildRunnerCommand, resumeLooksBroken, runRunner, type RunResult, type RunnerConfig } from './runner.js';
import { dropSession, readSession, writeSession } from './sessions.js';
import type { HarnessEvent } from './render.js';

/** Longest reply the harness will post; past this it posts a prefix and says so. */
export const REPLY_MAX_CHARS = 8_000;

/** Consecutive failures of one group before the harness gives up and says so in the room. */
const MAX_GROUP_FAILURES = 3;

/** How many inbox entries one peek reads. A burst larger than this drains over two passes. */
const PEEK_LIMIT = 50;

/** What a {@link WorkSource} tells the loop while it runs. */
export interface WorkHandlers {
  /** The listener is established — the agent is genuinely online. */
  onOnline(): void;
  /** The listener re-established itself after a drop. */
  onReconnect(): void;
  /** Work MAY be waiting (a new message, a delivered email, a replay gap, a poll). */
  onWork(reason: string): void;
  /** A sender retracted a message: drop it if it has not been handed to a runner. */
  onClawback(messageId: string): void;
  /** Anything worth a dim line (stale stream, poll error). */
  onNote(message: string): void;
}

/**
 * The injected "wait for work" primitive: start listening, call the handlers,
 * and resolve when the source ends. Resolving with an `error` ends the harness
 * with that error; resolving bare means a clean stop.
 */
export type WorkSource = (
  handlers: WorkHandlers,
  signal: AbortSignal,
) => Promise<{ error?: unknown }>;

export interface HarnessOptions {
  client: SparrowClient;
  env: Env;
  /** Credential profile name — the session store's outer key. */
  profileName?: string;
  agent: { name: string; orgName: string };
  /** The server the agent is enrolled against — banner/JSON only, never a token. */
  server: string;
  runner: RunnerConfig;
  /** Burst-collection window before a group is handed to a runner. */
  batchWindowMs: number;
  /** `--context <n>`: transcript messages prepended to the prompt. */
  contextCount: number;
  /** `--no-resume` clears this: claude sessions are then never reused. */
  resumeSessions: boolean;
  /** `--once`: handle what is waiting now, then return. */
  once: boolean;
  emit: (ev: HarnessEvent) => void;
  /** `-v`: called with each chunk of the runner's stderr. */
  onRunnerStderr?: (chunk: string) => void;
  signal: AbortSignal;
  workSource: WorkSource;
  // ---- injectables (tests) ----
  now?: () => number;
  spawn?: typeof runRunner;
  /** Retry delay for the n-th consecutive failure of a group (default {@link backoffMs}). */
  backoff?: (failures: number) => number;
}

/** Sleep that ends early on abort or on a `wake()`. */
function makeWaiter(signal: AbortSignal): { wait: (ms?: number) => Promise<void>; wake: () => void } {
  let resolveWait: (() => void) | undefined;
  const wake = (): void => {
    const r = resolveWait;
    resolveWait = undefined;
    r?.();
  };
  signal.addEventListener('abort', wake);
  const wait = (ms?: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      resolveWait = resolve;
      if (ms === undefined) return;
      const timer = setTimeout(() => {
        if (resolveWait === resolve) resolveWait = undefined;
        resolve();
      }, Math.max(ms, 0));
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  return { wait, wake };
}

function displayName(from: { displayName?: string; name?: string | null; email?: string }): string {
  if (from.displayName) return from.displayName;
  if (from.name && from.email) return `${from.name} <${from.email}>`;
  return from.email ?? from.name ?? 'someone';
}

function messageToPrompt(m: Message): PromptMessage {
  return { from: displayName(m.from), at: m.createdAt, subject: m.subject, body: m.body };
}

function emailToPrompt(e: Email): PromptMessage {
  return { from: displayName(e.from), at: e.createdAt, subject: e.subject, body: e.text ?? '' };
}

/** Run the harness until the work source ends (Ctrl-C), or — with `--once` — until one pass completes. */
export async function runHarness(opts: HarnessOptions): Promise<void> {
  const { client, env, signal, emit } = opts;
  const now = opts.now ?? Date.now;
  const spawn = opts.spawn ?? runRunner;
  const backoff = opts.backoff ?? backoffMs;
  const groups: PendingGroup[] = [];
  const { wait, wake } = makeWaiter(signal);

  let needPeek = true;
  /** Epoch ms until which a burst is still being collected (0 = not collecting). */
  let batchUntil = 0;

  /* ---------------------------------------------------------------- *
   * Peek — never pop.
   * ---------------------------------------------------------------- */
  const peek = async (): Promise<void> => {
    let items: InboxEntry[];
    try {
      // Entries of a type this client does not know are dropped by the client
      // (the registry is additive): logged as nothing, left in the queue for a
      // newer harness. Never an error.
      items = (await client.meInbox({ limit: PEEK_LIMIT })).items;
    } catch (e) {
      emit({ type: 'harness.note', message: `inbox peek failed (${String((e as Error)?.message ?? e)})` });
      return;
    }
    const before = groups.length;
    const { added } = mergeIntoGroups(groups, items);
    if (added.length === 0) return;
    // One line per CONVERSATION that just gained work, not one per message —
    // three lines typed into a room are one arrival to the person reading this.
    const byGroup = new Map<string, InboxEntry[]>();
    for (const entry of added) {
      const key = groupKeyOf(entry);
      byGroup.set(key, [...(byGroup.get(key) ?? []), entry]);
    }
    for (const [key, entries] of byGroup) {
      const group = groups.find((g) => g.key === key)!;
      emit({
        type: 'harness.work',
        group: group.label,
        from: displayName(entries[0]!.from),
        preview: entries[0]!.preview,
        count: entries.length,
      });
    }
    // Collect a burst: the window opens on the first arrival and is not
    // extended by later ones, so a busy room can never defer its own reply.
    if (before === 0 || batchUntil <= now()) batchUntil = now() + opts.batchWindowMs;
  };

  /* ---------------------------------------------------------------- *
   * Building one run's prompt: full bodies (peeks, never acks) + context.
   * ---------------------------------------------------------------- */
  const resolveItems = async (items: InboxEntry[]): Promise<PromptMessage[]> => {
    const out: PromptMessage[] = [];
    for (const item of items) {
      if (item.type === 'email') {
        const email = await client.readEmail(item.id, { peek: true });
        out.push(emailToPrompt(email));
      } else {
        // `GET /me/messages/:id` is a pure peek — reading a body here must not
        // ack the very item the runner has not answered yet.
        const { message } = await client.getMessage(item.id);
        out.push(messageToPrompt(message));
      }
    }
    return out;
  };

  const resolveTranscript = async (group: PendingGroup, excludeIds: Set<string>): Promise<PromptMessage[]> => {
    if (opts.contextCount <= 0) return [];
    try {
      if (group.kind === 'email') {
        const { items } = await client.getEmailThread(group.id, { limit: opts.contextCount });
        return items.filter((e) => !excludeIds.has(e.id)).map(emailToPrompt);
      }
      const { items } = await client.listRoomMessages(group.id, { limit: opts.contextCount });
      // Newest-first on the wire; a transcript reads oldest-first.
      return [...items].reverse().filter((m) => !excludeIds.has(m.id)).map(messageToPrompt);
    } catch {
      // Context is a nicety. A run with no transcript is still a correct run.
      return [];
    }
  };

  /* ---------------------------------------------------------------- *
   * Status: sticky `working` for the life of the run, `idle` after.
   * ---------------------------------------------------------------- */
  const setStatus = async (group: PendingGroup, state: 'working' | 'idle', note?: string): Promise<void> => {
    if (group.kind !== 'chat') return; // an email thread has no room to be busy in
    try {
      await client.setStatus(group.id, state === 'working' ? { state, note, sticky: true } : { state });
    } catch {
      /* a status is cosmetic; never fail a reply over it */
    }
  };

  /* ---------------------------------------------------------------- *
   * Posting the reply.
   * ---------------------------------------------------------------- */
  const postReply = async (
    group: PendingGroup,
    items: InboxEntry[],
    text: string,
  ): Promise<{ chars: number; truncated: boolean }> => {
    const truncated = text.length > REPLY_MAX_CHARS;
    const body = truncated
      ? `${text.slice(0, REPLY_MAX_CHARS)}\n\n(truncated — the full answer was ${text.length} characters)`
      : text;
    if (group.kind === 'email') {
      await client.replyEmail(group.id, { text: body });
    } else {
      await client.sendMessage(group.id, { body, inReplyTo: items[items.length - 1]!.id });
    }
    return { chars: body.length, truncated };
  };

  /** Ack every handled item BY ID — only ever after its reply is on the wire. */
  const ackItems = async (group: PendingGroup, items: InboxEntry[]): Promise<void> => {
    for (const item of items) {
      try {
        if (item.type === 'email') await client.readEmail(item.id);
        else await client.markRead(item.id);
      } catch {
        // A failed ack means the item comes back on the next peek: the reply is
        // already posted, so the cost is a duplicate turn, not a lost message.
      }
    }
    emit({ type: 'harness.ack', group: group.label, ids: items.map((i) => i.id) });
  };

  /* ---------------------------------------------------------------- *
   * One group, one runner.
   * ---------------------------------------------------------------- */
  const runGroup = async (group: PendingGroup): Promise<void> => {
    const items = [...group.items]; // items arriving mid-run wait for the next pass
    const ids = new Set(items.map((i) => i.id));
    const sessionKey = group.key;
    const useSessions = opts.runner.kind === 'claude' && opts.resumeSessions && opts.profileName !== undefined;
    let storedSession = useSessions ? readSession(env, opts.profileName!, sessionKey) : undefined;

    const attempt = async (resuming: boolean): Promise<RunResult> => {
      const messages = await resolveItems(items);
      // A resumed claude session already holds the transcript; re-sending it
      // wastes context and makes the agent read its own words as new.
      const transcript = resuming ? [] : await resolveTranscript(group, ids);
      const prompt = buildPrompt({
        agent: opts.agent,
        group: { kind: group.kind, label: group.label, roomKind: group.roomKind, subject: group.subject },
        transcript,
        messages,
      });
      const session = useSessions
        ? resuming
          ? { sessionId: storedSession, resume: true }
          : { sessionId: randomUUID(), resume: false }
        : {};
      const cmd = buildRunnerCommand(opts.runner, prompt, session);
      emit({ type: 'harness.run.start', runner: cmd.label, group: group.label, items: items.length });
      await setStatus(group, 'working', `thinking… (${opts.runner.kind})`);
      const result = await spawn(cmd, opts.runner, { signal, onStderr: opts.onRunnerStderr });
      if (useSessions && !resuming && result.sessionId) {
        writeSession(env, opts.profileName!, sessionKey, result.sessionId);
      }
      return result;
    };

    let result = await attempt(storedSession !== undefined);
    if (
      result.code !== 0 &&
      storedSession !== undefined &&
      !signal.aborted &&
      resumeLooksBroken(result.stdout, result.stderr)
    ) {
      // The stored id names a session that is gone. That costs one fresh retry,
      // not a permanently broken conversation.
      emit({ type: 'harness.note', message: `stored session for ${group.label} is gone — starting fresh` });
      dropSession(env, opts.profileName!, sessionKey);
      storedSession = undefined;
      result = await attempt(false);
    }

    if (signal.aborted) {
      await setStatus(group, 'idle');
      return; // stopped mid-run: ack nothing, say nothing
    }

    const seconds = result.ms / 1000;
    try {
      if (result.code !== 0) {
        await failGroup(group, items, result, seconds);
        return;
      }
      const text = result.text.trim();
      const silent = text === '' || text === NO_REPLY;
      try {
        if (!silent) {
          const { chars, truncated } = await postReply(group, items, text);
          emit({ type: 'harness.reply', group: group.label, chars, seconds, truncated });
        }
        emit({ type: 'harness.run.done', group: group.label, seconds, chars: text.length, replied: !silent });
        // ACK LAST. Everything above can fail and cost a repeated turn; acking
        // first would cost the message itself.
        await ackItems(group, items);
        for (const item of items) dropItem(groups, item.id);
        group.failures = 0;
        group.nextAttemptAt = 0;
      } catch (e) {
        // The runner succeeded but Sparrow refused the reply. Nothing is acked,
        // so this retries exactly like a failed run.
        await failGroup(
          group,
          items,
          { ...result, code: 1, stderr: String((e as Error)?.message ?? e) },
          seconds,
        );
      }
    } finally {
      await setStatus(group, 'idle');
    }
  };

  /**
   * A failed group: nothing acked, one red line, exponential backoff. The third
   * consecutive failure is where a poison item would wedge the queue forever, so
   * the harness says so IN THE ROOM (the humans there are the ones waiting) and
   * acks it.
   */
  const failGroup = async (
    group: PendingGroup,
    items: InboxEntry[],
    result: RunResult,
    seconds: number,
  ): Promise<void> => {
    group.failures += 1;
    const gaveUp = group.failures >= MAX_GROUP_FAILURES;
    if (gaveUp) {
      const note =
        `I hit an error handling this (runner exited ${result.timedOut ? 'timeout' : (result.code ?? '?')}); ` +
        `a human may need to look at the harness logs.`;
      try {
        await postReply(group, items, note);
      } catch {
        /* if even that cannot be posted, the ack below still unwedges the queue */
      }
      await ackItems(group, items);
      for (const item of items) dropItem(groups, item.id);
      group.failures = 0;
      group.nextAttemptAt = 0;
    } else if (opts.once) {
      // One pass only: a failed group is reported and left unread, never retried.
      group.nextAttemptAt = Number.POSITIVE_INFINITY;
    } else {
      group.nextAttemptAt = now() + backoff(group.failures);
    }
    emit({
      type: 'harness.run.failed',
      runner: opts.runner.kind === 'exec' ? 'runner' : opts.runner.kind,
      group: group.label,
      code: result.code,
      seconds,
      timedOut: result.timedOut,
      ...(gaveUp
        ? { gaveUp: true }
        : opts.once
          ? {}
          : { retryInSeconds: backoff(group.failures) / 1000 }),
    });
  };

  /* ---------------------------------------------------------------- *
   * The listener + the loop.
   * ---------------------------------------------------------------- */
  const handlers: WorkHandlers = {
    onOnline: () => {
      emit({ type: 'harness.online', agent: opts.agent.name, org: opts.agent.orgName, server: opts.server });
      needPeek = true;
      wake();
    },
    onReconnect: () => {
      emit({ type: 'harness.reconnected' });
      needPeek = true;
      wake();
    },
    onWork: () => {
      needPeek = true;
      wake();
    },
    onClawback: (messageId) => {
      if (dropItem(groups, messageId)) {
        emit({ type: 'harness.note', message: `a message was retracted before I answered it` });
      }
    },
    onNote: (message) => emit({ type: 'harness.note', message }),
  };

  // The source runs under a controller of our own so `--once` (and any other
  // early exit) can shut the listener down without the caller's signal.
  const stop = new AbortController();
  const relayAbort = (): void => stop.abort();
  signal.addEventListener('abort', relayAbort, { once: true });

  let sourceEnded = false;
  let sourceError: unknown;
  const sourceDone = opts.workSource(handlers, stop.signal).then(
    (r) => {
      sourceEnded = true;
      sourceError = r.error;
      wake();
      return r;
    },
    (e: unknown) => {
      sourceEnded = true;
      sourceError = e;
      wake();
      return {};
    },
  );

  for (;;) {
    if (signal.aborted) break;
    if (needPeek) {
      needPeek = false;
      await peek();
      if (signal.aborted) break;
    }
    const at = now();
    if (groups.length > 0 && batchUntil > at) {
      await wait(batchUntil - at);
      continue;
    }
    const group = nextRunnable(groups, at);
    if (group) {
      await runGroup(group);
      continue;
    }
    if (opts.once) break;
    if (sourceEnded) break;
    await wait(msUntilRunnable(groups, at));
  }

  stop.abort();
  signal.removeEventListener('abort', relayAbort);
  await sourceDone;
  if (sourceError !== undefined) throw sourceError;
}
