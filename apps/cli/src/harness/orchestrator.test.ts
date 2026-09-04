/**
 * The run loop against fakes: a stub client and a stub runner, so the parts
 * that are slow or destructive in the integration test (three real failures, a
 * five-minute backoff, a resumed Claude session) are cheap to assert here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SparrowClient } from '@sparrow/client';
import type { InboxEntry } from '@sparrow/common-types';
import { runHarness, type WorkHandlers, type WorkSource } from './orchestrator.js';
import type { HarnessEvent } from './render.js';
import type { RunResult, RunnerCommand, RunnerConfig } from './runner.js';

function chatEntry(id: string, body: string, roomId = 'room_a'): InboxEntry {
  return {
    type: 'chat.message',
    id,
    from: { id: 'mem_1', kind: 'human', displayName: 'Jake Quist', avatarUrl: null },
    kind: 'chat',
    subject: null,
    preview: body,
    truncated: false,
    attachmentCount: 0,
    status: 'unread',
    createdAt: '2026-09-03T10:00:00.000Z',
    room: { id: roomId, name: 'Product', orgId: 'org_1', kind: 'project' },
  } as unknown as InboxEntry;
}

interface Fake {
  client: SparrowClient;
  sent: Array<{ roomId: string; body: string; inReplyTo?: string }>;
  read: string[];
  statuses: string[];
  order: string[];
  inbox: InboxEntry[];
}

function fakeClient(inbox: InboxEntry[]): Fake {
  const fake: Fake = { client: null as never, sent: [], read: [], statuses: [], order: [], inbox };
  fake.client = {
    meInbox: async () => ({ items: fake.inbox, nextCursor: null }),
    getMessage: async (id: string) => ({
      message: {
        id,
        from: { id: 'mem_1', kind: 'human', displayName: 'Jake Quist' },
        body: inbox.find((i) => i.id === id)?.preview ?? 'body',
        subject: null,
        createdAt: '2026-09-03T10:00:00.000Z',
      },
      room: { id: 'room_a', name: 'Product', orgId: 'org_1', kind: 'project' },
    }),
    listRoomMessages: async () => ({ items: [], nextBefore: null }),
    setStatus: async (_roomId: string, input: { state: string }) => {
      fake.statuses.push(input.state);
      return null;
    },
    sendMessage: async (roomId: string, input: { body: string; inReplyTo?: string }) => {
      fake.order.push('send');
      fake.sent.push({ roomId, body: input.body, inReplyTo: input.inReplyTo });
      return { message: { id: `msg_reply_${fake.sent.length}` }, unreadCount: 0 };
    },
    markRead: async (id: string) => {
      fake.order.push('ack');
      fake.read.push(id);
      fake.inbox = fake.inbox.filter((i) => i.id !== id);
      return { message: { id } };
    },
  } as unknown as SparrowClient;
  return fake;
}

const runner: RunnerConfig = {
  kind: 'claude',
  cwd: '/proj',
  permissionMode: 'acceptEdits',
  yolo: false,
  runTimeoutMs: 60_000,
};

/** A source that comes online, optionally pokes the loop, then waits to be stopped. */
function heldSource(after?: (h: WorkHandlers) => void): WorkSource {
  return async (handlers, signal) => {
    handlers.onOnline();
    after?.(handlers);
    if (!signal.aborted) {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    }
    return {};
  };
}

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ms: 10,
    text: 'ok',
    // The runner classifies its own failure (a codex turn can fail on exit 0);
    // for these fakes the exit code says it, unless a test says otherwise.
    failed: (over.code ?? 0) !== 0,
    resumeBroken: false,
    ...over,
  };
}

interface RunOpts {
  spawn: (cmd: RunnerCommand) => Promise<RunResult>;
  runner?: RunnerConfig;
  once?: boolean;
  batchWindowMs?: number;
  backoff?: (n: number) => number;
  source?: WorkSource;
  resumeSessions?: boolean;
  env?: Record<string, string | undefined>;
  /** Stop the (otherwise endless) loop as soon as this event lands. */
  stopWhen?: (ev: HarnessEvent) => boolean;
}

async function run(fake: Fake, opts: RunOpts): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const controller = new AbortController();
  await runHarness({
    client: fake.client,
    env: opts.env ?? {},
    profileName: 'work',
    agent: { name: 'bot', orgName: 'Acme' },
    server: 'https://s',
    runner: opts.runner ?? runner,
    batchWindowMs: opts.batchWindowMs ?? 0,
    contextCount: 0,
    resumeSessions: opts.resumeSessions ?? false,
    once: opts.once ?? true,
    emit: (ev) => {
      events.push(ev);
      if (opts.stopWhen?.(ev)) controller.abort();
    },
    signal: controller.signal,
    workSource: opts.source ?? heldSource(),
    backoff: opts.backoff,
    spawn: async (cmd) => opts.spawn(cmd),
  });
  return events;
}

/** A scratch state dir for the session-store tests. */
function stateEnv(): Record<string, string | undefined> {
  return { SPARROW_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-orch-')) };
}

describe('harness orchestrator', () => {
  it('sets sticky working before the run and idle after it', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    await run(fake, { spawn: async () => result() });
    expect(fake.statuses).toEqual(['working', 'idle']);
  });

  it('acks only after the reply is posted', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    await run(fake, { spawn: async () => result({ text: 'sure' }) });
    expect(fake.order).toEqual(['send', 'ack']);
    expect(fake.sent[0]!.inReplyTo).toBe('msg_1');
  });

  it('a failed run acks nothing, posts nothing, and names the retry delay', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    const events = await run(fake, {
      spawn: async () => result({ code: 2, text: '' }),
      once: false,
      backoff: () => 60_000,
      stopWhen: (ev) => ev.type === 'harness.run.failed',
    });
    expect(fake.read).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(events.filter((e) => e.type === 'harness.run.failed')[0]).toMatchObject({
      code: 2,
      retryInSeconds: 60,
    });
  });

  it('gives up after three consecutive failures: says so in the room and acks', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    let attempts = 0;
    const events = await run(fake, {
      spawn: async () => {
        attempts += 1;
        return result({ code: 7, text: '' });
      },
      once: false,
      backoff: () => 0,
      stopWhen: (ev) => ev.type === 'harness.ack',
    });
    expect(attempts).toBe(3);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.body).toContain('I hit an error handling this');
    expect(fake.sent[0]!.body).toContain('runner exited 7');
    expect(fake.read).toEqual(['msg_1']);
    const failed = events.filter((e) => e.type === 'harness.run.failed');
    expect(failed).toHaveLength(3);
    expect(failed[2]).toMatchObject({ gaveUp: true });
  });

  it('holds a failing group off until its backoff elapses', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    let attempts = 0;
    const started = Date.now();
    await run(fake, {
      spawn: async () => {
        attempts += 1;
        return result({ code: 1, text: '' });
      },
      once: false,
      backoff: (n) => (n === 1 ? 150 : 0),
      stopWhen: (ev) => ev.type === 'harness.ack',
    });
    expect(attempts).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });

  it('a clawback during the batch window drops the item before any runner sees it', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'keep'), chatEntry('msg_2', 'drop')]);
    const prompts: string[] = [];
    await run(fake, {
      batchWindowMs: 80,
      spawn: async (cmd) => {
        prompts.push(cmd.stdin);
        return result({ text: 'ok' });
      },
      // The retraction lands after the peek that queued it — the real ordering.
      source: heldSource((h) => setTimeout(() => h.onClawback('msg_2'), 10)),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('keep');
    expect(prompts[0]).not.toContain('drop');
  });

  it('keeps one claude session per room: --session-id first, --resume next', async () => {
    const env = stateEnv();
    const seen: string[][] = [];
    const spawn = async (cmd: RunnerCommand): Promise<RunResult> => {
      seen.push(cmd.args);
      return result({ text: 'ok', sessionId: 'sess-abc' });
    };
    await run(fakeClient([chatEntry('msg_1', 'one')]), { resumeSessions: true, env, spawn });
    await run(fakeClient([chatEntry('msg_2', 'two')]), { resumeSessions: true, env, spawn });

    expect(seen[0]).toContain('--session-id');
    expect(seen[1]).toContain('--resume');
    expect(seen[1]![seen[1]!.indexOf('--resume') + 1]).toBe('sess-abc');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('--no-resume never passes a session at all', async () => {
    const env = stateEnv();
    const seen: string[][] = [];
    const spawn = async (cmd: RunnerCommand): Promise<RunResult> => {
      seen.push(cmd.args);
      return result({ text: 'ok', sessionId: 'sess-abc' });
    };
    await run(fakeClient([chatEntry('msg_1', 'one')]), { resumeSessions: false, env, spawn });
    await run(fakeClient([chatEntry('msg_2', 'two')]), { resumeSessions: false, env, spawn });
    expect(seen[0]).not.toContain('--session-id');
    expect(seen[1]).not.toContain('--resume');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('a broken --resume drops the stored session and retries once, fresh', async () => {
    const env = stateEnv();
    await run(fakeClient([chatEntry('msg_1', 'one')]), {
      resumeSessions: true,
      env,
      spawn: async () => result({ text: 'ok', sessionId: 'sess-dead' }),
    });

    const attempts: string[][] = [];
    const again = fakeClient([chatEntry('msg_2', 'two')]);
    await run(again, {
      resumeSessions: true,
      env,
      spawn: async (cmd) => {
        attempts.push(cmd.args);
        return attempts.length === 1
          ? result({
              code: 1,
              text: '',
              stderr: 'No conversation found with session ID: sess-dead',
              resumeBroken: true,
            })
          : result({ text: 'recovered', sessionId: 'sess-new' });
      },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain('--resume');
    expect(attempts[1]).toContain('--session-id');
    expect(again.sent[0]!.body).toBe('recovered');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('a runner exiting 0 with empty output posts nothing but still acks', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    await run(fake, { spawn: async () => result({ text: '' }) });
    expect(fake.sent).toEqual([]);
    expect(fake.read).toEqual(['msg_1']);
  });

  /* ------------------------------------------------------------------ *
   * codex: the runner mints its own thread id, so continuity runs the
   * other way round — the FIRST run reports the id, later runs resume it.
   * ------------------------------------------------------------------ */

  const codex: RunnerConfig = { ...runner, kind: 'codex' };

  it('codex: the first run names no session, the next resumes the thread codex reported', async () => {
    const env = stateEnv();
    const seen: string[][] = [];
    const spawn = async (cmd: RunnerCommand): Promise<RunResult> => {
      seen.push(cmd.args);
      return result({ text: 'ok', sessionId: 'thr-abc' });
    };
    await run(fakeClient([chatEntry('msg_1', 'one')]), { runner: codex, resumeSessions: true, env, spawn });
    await run(fakeClient([chatEntry('msg_2', 'two')]), { runner: codex, resumeSessions: true, env, spawn });

    expect(seen[0]).not.toContain('resume');
    expect(seen[1]!.slice(0, 3)).toEqual(['exec', 'resume', 'thr-abc']);
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('codex: the standing framing rides only the FIRST turn of a thread', async () => {
    const env = stateEnv();
    const stdins: string[] = [];
    const spawn = async (cmd: RunnerCommand): Promise<RunResult> => {
      stdins.push(cmd.stdin);
      return result({ text: 'ok', sessionId: 'thr-abc' });
    };
    await run(fakeClient([chatEntry('msg_1', 'one')]), { runner: codex, resumeSessions: true, env, spawn });
    await run(fakeClient([chatEntry('msg_2', 'two')]), { runner: codex, resumeSessions: true, env, spawn });

    expect(stdins[0]).toContain('YOUR FINAL TEXT RESPONSE IS YOUR REPLY');
    expect(stdins[1]).not.toContain('YOUR FINAL TEXT RESPONSE IS YOUR REPLY');
    expect(stdins[1]).toContain('two');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('a runner that fails while exiting 0 still fails the group, and says why', async () => {
    const fake = fakeClient([chatEntry('msg_1', 'hello')]);
    const events = await run(fake, {
      runner: codex,
      spawn: async () => result({ code: 0, failed: true, error: 'model stream closed', text: '' }),
      once: false,
      backoff: () => 60_000,
      stopWhen: (ev) => ev.type === 'harness.run.failed',
    });
    expect(fake.sent).toEqual([]);
    expect(fake.read).toEqual([]);
    expect(events.filter((e) => e.type === 'harness.note')).toContainEqual({
      type: 'harness.note',
      message: 'runner: model stream closed',
    });
  });

  it('codex: a dead thread drops the stored id and retries fresh, exactly once', async () => {
    const env = stateEnv();
    await run(fakeClient([chatEntry('msg_1', 'one')]), {
      runner: codex,
      resumeSessions: true,
      env,
      spawn: async () => result({ text: 'ok', sessionId: 'thr-dead' }),
    });

    const attempts: string[][] = [];
    const again = fakeClient([chatEntry('msg_2', 'two')]);
    await run(again, {
      runner: codex,
      resumeSessions: true,
      env,
      spawn: async (cmd) => {
        attempts.push(cmd.args);
        return attempts.length === 1
          ? result({
              code: 1,
              text: '',
              stderr: 'thread/resume failed: no rollout found for thread id thr-dead',
              resumeBroken: true,
            })
          : result({ text: 'recovered', sessionId: 'thr-new' });
      },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain('resume');
    expect(attempts[1]).not.toContain('resume');
    expect(again.sent[0]!.body).toBe('recovered');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('a failed first run leaves no session behind to resume into', async () => {
    const env = stateEnv();
    await run(fakeClient([chatEntry('msg_1', 'one')]), {
      runner: codex,
      resumeSessions: true,
      env,
      // codex announces its thread id before it does any work, so a failed run
      // still reports one.
      spawn: async () => result({ code: 1, text: '', sessionId: 'thr-stillborn' }),
    });
    const seen: string[][] = [];
    await run(fakeClient([chatEntry('msg_2', 'two')]), {
      runner: codex,
      resumeSessions: true,
      env,
      spawn: async (cmd) => {
        seen.push(cmd.args);
        return result({ text: 'ok', sessionId: 'thr-real' });
      },
    });
    expect(seen[0]).not.toContain('resume');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('gemini keeps no session at all: every run is a first run', async () => {
    const env = stateEnv();
    const seen: string[][] = [];
    const gemini: RunnerConfig = { ...runner, kind: 'gemini' };
    const spawn = async (cmd: RunnerCommand): Promise<RunResult> => {
      seen.push(cmd.args);
      return result({ text: 'ok', sessionId: 'ignored' });
    };
    await run(fakeClient([chatEntry('msg_1', 'one')]), { runner: gemini, resumeSessions: true, env, spawn });
    await run(fakeClient([chatEntry('msg_2', 'two')]), { runner: gemini, resumeSessions: true, env, spawn });
    expect(seen[1]!.join(' ')).toContain('YOUR FINAL TEXT RESPONSE IS YOUR REPLY');
    fs.rmSync(env.SPARROW_STATE_DIR!, { recursive: true, force: true });
  });

  it('surfaces a fatal work-source error instead of exiting quietly', async () => {
    const boom = new Error('client_upgrade_required');
    await expect(
      run(fakeClient([]), {
        once: false,
        spawn: async () => result(),
        source: async () => ({ error: boom }),
      }),
    ).rejects.toBe(boom);
  });
});
