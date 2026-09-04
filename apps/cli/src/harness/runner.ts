/**
 * Spawning an agent runner for `sparrow harness`.
 *
 * Four runners, one contract: hand it a prompt, get back one final text. The
 * differences are all flags and plumbing, so command CONSTRUCTION is pure and
 * unit-tested here, and {@link runRunner} is the thin impure half (spawn, feed
 * stdin, collect output, enforce the timeout).
 *
 * Each runner is ONE {@link RunnerAdapter} in {@link RUNNERS} — how to build its
 * command, how to read its output, whether it can continue a conversation, and
 * how to tell a failed run from a finished one. Everything above this file
 * (the orchestrator, the command surface) asks the adapter and knows no flags:
 * adding a fifth runner is one record entry, not five `switch` arms to keep in
 * sync.
 *
 * Two details that are not obvious:
 *  - The child gets its own PROCESS GROUP (`detached`). A run that must be
 *    killed at `--run-timeout` is an agent that has itself spawned a build, a
 *    test run, a dev server; killing only the direct child orphans all of it.
 *  - `claude -p` DENIES a permission it would otherwise prompt for, so an
 *    unattended run can fail but can never hang waiting for a human.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BuiltPrompt } from './prompt.js';

/** Which agent CLI a run spawns. */
export type RunnerKind = 'claude' | 'codex' | 'gemini' | 'exec';

/** `codex exec -s` — the only runner with a sandbox posture we pass through. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/**
 * What our default permission posture means for codex: the analogue of the
 * `acceptEdits` claude gets here — "you may edit this working tree".
 *
 * PINNED EXPLICITLY, not inherited. codex's own `exec` default is
 * `workspace-write` in 0.153.3, but that default has already moved between
 * versions, and an unattended harness whose agent silently loses the ability
 * to write is a support ticket rather than an error. Passing `-s` on every run
 * makes the posture ours and version-proof.
 */
export const CODEX_DEFAULT_SANDBOX = 'workspace-write';

export interface RunnerConfig {
  kind: RunnerKind;
  /** The shell command — `--exec` only. */
  command?: string;
  model?: string;
  /** Working directory the runner is spawned in: the project the agent works in. */
  cwd: string;
  /** claude's `--permission-mode` (ignored by the other runners). */
  permissionMode: string;
  /** codex's `--sandbox` (ignored by the other runners; default {@link CODEX_DEFAULT_SANDBOX}). */
  sandbox?: string;
  /** `--yolo`: bypass permissions where the runner has such a switch. */
  yolo: boolean;
  runTimeoutMs: number;
}

/** Conversation continuity for one run (only runners with a {@link ResumeCapability}). */
export interface SessionPlan {
  /**
   * The id to use. Absent means "no continuity for this run" — which is also
   * how a runner that MINTS its own id (codex) starts a fresh conversation.
   */
  sessionId?: string;
  /** True → continue the named session; false → start one under that name. */
  resume?: boolean;
}

/** A fully-resolved spawn plan — everything {@link runRunner} needs, and nothing else. */
export interface RunnerCommand {
  /** Executable (or, with `shell`, the whole command line). */
  file: string;
  args: string[];
  shell: boolean;
  cwd: string;
  /** Written to the child's stdin, then closed. */
  stdin: string;
  /** Short label for the timeline: `claude fable`, `codex`, the exec command. */
  label: string;
  /** codex only: the file `--output-last-message` writes the final text to. */
  lastMessageFile?: string;
}

/** What a runner produced: the reply, and the id needed to continue this conversation. */
export interface ParsedOutput {
  text: string;
  sessionId?: string;
}

/** Whether a finished run failed — and, if so, whether the stored session is why. */
export interface RunFailure {
  failed: boolean;
  /** The failure looks like "that conversation is gone", worth one fresh retry. */
  resumeBroken: boolean;
  /** The runner's own words for the failure, when it gave any. */
  message?: string;
}

/** A finished run, as the classifier sees it. */
export interface FinishedRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** How one runner continues a conversation across invocations. */
export interface ResumeCapability {
  /**
   * The id a FRESH run should be told to use, or `undefined` when the runner
   * mints its own and reports it back (codex's `thread.started`). This is the
   * whole of what the orchestrator needs to know about the difference.
   */
  newSessionId(): string | undefined;
}

/** Everything the harness knows about one runner. One entry per {@link RunnerKind}. */
export interface RunnerAdapter {
  kind: RunnerKind;
  /** The timeline label for a given config. */
  label(cfg: RunnerConfig): string;
  /**
   * `separate` — the runner has a system-prompt channel of its own, so the
   * framing rides a flag and only the user body goes to stdin. `combined` — it
   * has none, so the framing is prepended to the body (and, where the runner
   * can resume, only on the FIRST turn of a conversation).
   */
  systemPromptChannel: 'separate' | 'combined';
  /** Absent when this runner cannot continue a conversation at all. */
  resume?: ResumeCapability;
  /** True when `--sandbox` means something here. */
  sandbox: boolean;
  /** The permission posture this config produces, in this runner's own words (banner). */
  posture(cfg: RunnerConfig): string;
  buildCommand(cfg: RunnerConfig, prompt: BuiltPrompt, session: SessionPlan): RunnerCommand;
  parseOutput(stdout: string, lastMessage?: string): ParsedOutput;
  classifyFailure(run: FinishedRun): RunFailure;
}

/** claude's `-p` output envelope (only the two fields the harness reads). */
interface ClaudeResult {
  result?: unknown;
  session_id?: unknown;
}

/** Where a codex run parks its final message (deleted after the run). */
function tempLastMessageFile(): string {
  return path.join(os.tmpdir(), `sparrow-harness-${randomUUID()}.txt`);
}

/** The runner's timeline label — the CLI plus its model. */
function cliLabel(cfg: RunnerConfig): string {
  return cfg.model ? `${cfg.kind} ${cfg.model}` : cfg.kind;
}

/**
 * The prompt body for a runner with no system channel: the whole framing on a
 * conversation's first turn, and the user's words alone on every turn after —
 * the framing is already in the transcript the runner resumed.
 */
function combinedBody(prompt: BuiltPrompt, session: SessionPlan): string {
  return session.resume ? prompt.user : prompt.combined;
}

/** The banner's permission line for every runner whose posture is claude-shaped. */
function permissionModePosture(cfg: RunnerConfig): string {
  return cfg.yolo ? 'bypassPermissions' : cfg.permissionMode;
}

/** Exit code is the whole contract (claude, gemini, exec). */
function exitCodeFailure(run: FinishedRun, resumeBroken = false): RunFailure {
  return { failed: run.code !== 0, resumeBroken };
}

/* ====================================================================== *
 * codex `--json`
 * ====================================================================== */

/** One line of `codex exec --json`. Only the fields the harness reads. */
interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  item?: { type?: unknown; text?: unknown; message?: unknown };
}

/**
 * The JSONL events on codex's stdout, ignoring everything else on it.
 *
 * codex interleaves plain prose (`Reading prompt from stdin…`, warnings) with
 * its event lines, and a killed run can leave a half-written one. Neither may
 * cost us the reply, so anything that is not a complete JSON object is simply
 * not an event.
 */
function codexEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as CodexEvent);
      }
    } catch {
      /* a truncated or non-JSON line is not an event */
    }
  }
  return events;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The flags that give a codex run its permission posture. */
function codexSandboxArgs(cfg: RunnerConfig, resuming: boolean): string[] {
  if (cfg.yolo) return ['--dangerously-bypass-approvals-and-sandbox'];
  const mode = cfg.sandbox ?? CODEX_DEFAULT_SANDBOX;
  // `codex exec resume` takes a REDUCED flag set — no `-s` (verified against
  // codex-cli 0.153.3, which errors "unexpected argument '-s'"). The config
  // override is accepted on both, but `-s` reads better on the first run.
  return resuming ? ['-c', `sandbox_mode=${mode}`] : ['-s', mode];
}

/* ====================================================================== *
 * The adapters
 * ====================================================================== */

export const RUNNERS: Record<RunnerKind, RunnerAdapter> = {
  claude: {
    kind: 'claude',
    label: cliLabel,
    systemPromptChannel: 'separate',
    // claude is TOLD its session id, so the harness can name a conversation
    // before the first run has produced anything.
    resume: { newSessionId: () => randomUUID() },
    sandbox: false,
    posture: permissionModePosture,
    buildCommand(cfg, prompt, session) {
      const args = ['-p', '--output-format', 'json'];
      if (cfg.model) args.push('--model', cfg.model);
      args.push('--permission-mode', cfg.yolo ? 'bypassPermissions' : cfg.permissionMode);
      if (session.sessionId) {
        args.push(session.resume ? '--resume' : '--session-id', session.sessionId);
      }
      args.push('--append-system-prompt', prompt.system);
      return {
        file: 'claude',
        args,
        shell: false,
        cwd: cfg.cwd,
        stdin: prompt.user,
        label: cliLabel(cfg),
      };
    },
    parseOutput(stdout) {
      try {
        const parsed = JSON.parse(stdout.trim()) as ClaudeResult;
        const text = typeof parsed.result === 'string' ? parsed.result : '';
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
        if (text || sessionId) return { text: text.trim(), sessionId };
      } catch {
        /* not the JSON envelope — fall through to raw stdout */
      }
      return { text: stdout.trim() };
    },
    classifyFailure(run) {
      return exitCodeFailure(run, resumeLooksBroken(run.stdout, run.stderr));
    },
  },

  codex: {
    kind: 'codex',
    label: cliLabel,
    // codex has no system-prompt channel at all, so the framing is part of the
    // first turn and the RESUMED thread carries it from there.
    systemPromptChannel: 'combined',
    // codex mints its own thread id and announces it in `thread.started`; there
    // is nothing to hand it up front.
    resume: { newSessionId: () => undefined },
    sandbox: true,
    posture: (cfg) =>
      cfg.yolo ? 'sandbox bypassed' : (cfg.sandbox ?? CODEX_DEFAULT_SANDBOX),
    buildCommand(cfg, prompt, session) {
      const lastMessageFile = tempLastMessageFile();
      const resuming = session.resume === true && session.sessionId !== undefined;
      const args = resuming ? ['exec', 'resume', session.sessionId!] : ['exec'];
      args.push('--skip-git-repo-check', '--json');
      if (cfg.model) args.push('-m', cfg.model);
      args.push(...codexSandboxArgs(cfg, resuming));
      // `-o <file>` is the authoritative final message: stdout is the whole
      // event stream, and only this file is the agent's actual answer.
      args.push('-o', lastMessageFile, '-');
      return {
        file: 'codex',
        args,
        shell: false,
        cwd: cfg.cwd,
        stdin: combinedBody(prompt, session),
        label: cliLabel(cfg),
        lastMessageFile,
      };
    },
    parseOutput(stdout, lastMessage) {
      const events = codexEvents(stdout);
      let sessionId: string | undefined;
      let streamed: string | undefined;
      for (const ev of events) {
        if (ev.type === 'thread.started') sessionId = str(ev.thread_id) ?? sessionId;
        // Best-effort second source for the reply: the shape of a completed
        // agent message could not be verified against a live authenticated run,
        // so `-o` stays primary and this only ever fills an empty answer.
        if (ev.type === 'item.completed' && ev.item && /message/.test(String(ev.item.type ?? ''))) {
          streamed = str(ev.item.text) ?? str(ev.item.message) ?? streamed;
        }
      }
      const fromFile = lastMessage?.trim();
      if (fromFile) return { text: fromFile, sessionId };
      if (streamed) return { text: streamed.trim(), sessionId };
      // With no answer in hand, RAW STDOUT is the reply only when it is not the
      // event stream: posting a wall of JSONL into a room is worse than silence.
      return { text: events.length > 0 ? '' : stdout.trim(), sessionId };
    },
    classifyFailure(run) {
      // `codex exec` documents no exit-code contract, so the stream is the
      // truth: a `turn.failed` is a failure whatever the process exited with.
      const events = codexEvents(run.stdout);
      let completed = false;
      let turnFailed: string | undefined;
      let lastError: string | undefined;
      for (const ev of events) {
        if (ev.type === 'turn.completed') completed = true;
        else if (ev.type === 'turn.failed') turnFailed = str(ev.error?.message) ?? 'the turn failed';
        else if (ev.type === 'error') lastError = str(ev.message) ?? lastError;
      }
      // `error` is ALSO how codex narrates a retry it recovers from
      // ("Reconnecting… 2/5"), so an error only condemns a turn that never
      // completed. Verified against codex-cli 0.153.3.
      const message = turnFailed ?? (completed ? undefined : lastError);
      const failed = turnFailed !== undefined || run.code !== 0 || (!completed && lastError !== undefined);
      return { failed, resumeBroken: failed && codexResumeBroken(run), message };
    },
  },

  gemini: {
    kind: 'gemini',
    label: cliLabel,
    systemPromptChannel: 'combined',
    sandbox: false,
    posture: permissionModePosture,
    buildCommand(cfg, prompt, session) {
      // `-p/--prompt` is gemini's documented headless trigger and an EMPTY one
      // is falsy (it would drop back to interactive), so the whole prompt rides
      // on argv here rather than stdin.
      const args: string[] = [];
      if (cfg.model) args.push('-m', cfg.model);
      if (cfg.yolo) args.push('-y');
      args.push('--output-format', 'text', '--prompt', combinedBody(prompt, session));
      return { file: 'gemini', args, shell: false, cwd: cfg.cwd, stdin: '', label: cliLabel(cfg) };
    },
    parseOutput: (stdout) => ({ text: stdout.trim() }),
    classifyFailure: (run) => exitCodeFailure(run),
  },

  exec: {
    kind: 'exec',
    label: (cfg) => cfg.command ?? 'exec',
    systemPromptChannel: 'combined',
    sandbox: false,
    posture: permissionModePosture,
    buildCommand(cfg, prompt, session) {
      return {
        file: cfg.command ?? '',
        args: [],
        shell: true,
        cwd: cfg.cwd,
        stdin: combinedBody(prompt, session),
        label: cfg.command ?? 'exec',
      };
    },
    parseOutput: (stdout) => ({ text: stdout.trim() }),
    classifyFailure: (run) => exitCodeFailure(run),
  },
};

/** The adapter for one runner. */
export function runnerAdapter(kind: RunnerKind): RunnerAdapter {
  return RUNNERS[kind];
}

/** Can this runner continue a conversation across invocations? */
export function supportsResume(kind: RunnerKind): boolean {
  return runnerAdapter(kind).resume !== undefined;
}

/**
 * Build the spawn plan for one runner invocation. Pure — no filesystem, no
 * spawn — so every flag combination is a unit test rather than a live agent.
 */
export function buildRunnerCommand(
  cfg: RunnerConfig,
  prompt: BuiltPrompt,
  session: SessionPlan,
): RunnerCommand {
  return runnerAdapter(cfg.kind).buildCommand(cfg, prompt, session);
}

/**
 * Extract the reply text (and the id that continues this conversation) from what
 * a runner produced. Every runner degrades to "stdout is the reply", which is
 * also the `--exec` contract.
 */
export function parseRunnerOutput(
  kind: RunnerKind,
  stdout: string,
  lastMessage?: string,
): ParsedOutput {
  return runnerAdapter(kind).parseOutput(stdout, lastMessage);
}

/** Did this run fail — and is a dead stored session the reason? */
export function classifyRunFailure(kind: RunnerKind, run: FinishedRun): RunFailure {
  return runnerAdapter(kind).classifyFailure(run);
}

/**
 * Does this failure look like a DEAD SESSION rather than a real error? A stored
 * resume id can outlive the session it names (a cleared cache, a different
 * machine, a rotated project dir); that must cost one fresh retry, not a
 * permanent broken group.
 */
export function resumeLooksBroken(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (!text.includes('session')) return false;
  return /no (conversation|session)|not found|invalid session|unknown session|does not exist/.test(
    text,
  );
}

/**
 * codex's own dead-conversation wording. It says THREAD, not session, so the
 * generic detector above never sees it: `exec resume <unknown-id>` exits 1 with
 * `thread/resume failed: no rollout found for thread id …` and no JSONL at all
 * (verified against codex-cli 0.153.3). The generic detector is kept as the
 * conservative fallback for wording that changes under us.
 */
function codexResumeBroken(run: FinishedRun): boolean {
  const text = `${run.stdout}\n${run.stderr}`.toLowerCase();
  if (/thread\/resume|no rollout found|unknown thread|no such thread/.test(text)) return true;
  return resumeLooksBroken(run.stdout, run.stderr);
}

/**
 * `--sandbox <mode>`: valid for codex, meaningless anywhere else. Returns the
 * error rather than throwing, so the command surface owns the CLI's error type.
 */
export function resolveSandbox(
  kind: RunnerKind,
  raw: string | undefined,
): { value?: string; error?: string } {
  if (raw === undefined) return {};
  if (!runnerAdapter(kind).sandbox) {
    return {
      error:
        `--sandbox is a codex flag; the ${kind} runner has no sandbox. Use --codex, or ` +
        (kind === 'claude' ? '--permission-mode for claude.' : 'drop --sandbox.'),
    };
  }
  if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
    return { error: `Unknown --sandbox mode "${raw}". Pick one of: ${SANDBOX_MODES.join(', ')}.` };
  }
  return { value: raw };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Wall time of the run (ms). */
  ms: number;
  text: string;
  sessionId?: string;
  /**
   * Did this run FAIL? Usually `code !== 0`, but not always: `codex exec`
   * documents no exit-code contract and can report a `turn.failed` on its
   * event stream while exiting 0 (see {@link classifyRunFailure}).
   */
  failed: boolean;
  /** The runner's own words for a failure (codex's `turn.failed`). */
  error?: string;
  /** True when the failure names a session that is gone — worth one fresh retry. */
  resumeBroken: boolean;
}

export interface RunRunnerOptions {
  /** Abort (SIGINT/SIGTERM) — kills the process group and resolves as a failure. */
  signal?: AbortSignal;
  /** Called with each stderr chunk (`-v` streams them). */
  onStderr?: (chunk: string) => void;
  /** Injected for tests. */
  now?: () => number;
}

/** Kill a child and everything it spawned; falls back to the child alone. */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Spawn one runner and resolve when it exits, is killed, or times out. */
export async function runRunner(
  cmd: RunnerCommand,
  cfg: RunnerConfig,
  opts: RunRunnerOptions = {},
): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(cmd.file, cmd.args, {
      cwd: cmd.cwd,
      shell: cmd.shell,
      // Its own process group, so a timeout kill takes the agent's children too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    type RawExit = Pick<RunResult, 'code' | 'signal' | 'stdout' | 'stderr' | 'timedOut'>;
    const finish = (result: RawExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      let lastMessage: string | undefined;
      if (cmd.lastMessageFile) {
        try {
          lastMessage = fs.readFileSync(cmd.lastMessageFile, 'utf8');
        } catch {
          /* the runner never wrote one */
        }
        try {
          fs.rmSync(cmd.lastMessageFile, { force: true });
        } catch {
          /* best-effort */
        }
      }
      const adapter = runnerAdapter(cfg.kind);
      const parsed = adapter.parseOutput(result.stdout, lastMessage);
      // A timed-out run is a failure by definition — it was killed mid-thought,
      // so whatever its stream said before the axe fell does not get a vote.
      const failure = timedOut
        ? { failed: true, resumeBroken: false }
        : adapter.classifyFailure(result);
      resolve({
        ...result,
        ms: now() - started,
        text: parsed.text,
        sessionId: parsed.sessionId,
        failed: failure.failed,
        error: failure.message,
        resumeBroken: failure.resumeBroken,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGKILL');
    }, cfg.runTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const onAbort = (): void => killTree(child.pid, 'SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr += c;
      opts.onStderr?.(c);
    });
    child.on('error', (err) => {
      finish({ code: 127, signal: null, stdout, stderr: `${stderr}${(err as Error).message}\n`, timedOut });
    });
    child.on('close', (code, signal) => {
      finish({ code: timedOut ? (code ?? 124) : code, signal, stdout, stderr, timedOut });
    });
    child.stdin?.on('error', () => {
      /* a runner that never reads stdin is fine */
    });
    child.stdin?.end(cmd.stdin);
  });
}
