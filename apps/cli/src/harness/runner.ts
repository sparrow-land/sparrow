/**
 * Spawning an agent runner for `sparrow harness`.
 *
 * Four runners, one contract: hand it a prompt, get back one final text. The
 * differences are all flags and plumbing, so command CONSTRUCTION is pure and
 * unit-tested here, and {@link runRunner} is the thin impure half (spawn, feed
 * stdin, collect output, enforce the timeout).
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

export interface RunnerConfig {
  kind: RunnerKind;
  /** The shell command — `--exec` only. */
  command?: string;
  model?: string;
  /** Working directory the runner is spawned in: the project the agent works in. */
  cwd: string;
  /** claude's `--permission-mode` (ignored by the other runners). */
  permissionMode: string;
  /** `--yolo`: bypass permissions where the runner has such a switch. */
  yolo: boolean;
  runTimeoutMs: number;
}

/** Claude session continuity for one conversation (claude runner only). */
export interface SessionPlan {
  /** The uuid to use; absent means "no session continuity for this run". */
  sessionId?: string;
  /** True → `--resume <id>` (a session that already exists); false → `--session-id <id>`. */
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

/** claude's `-p` output envelope (only the two fields the harness reads). */
interface ClaudeResult {
  result?: unknown;
  session_id?: unknown;
}

/** Where a codex run parks its final message (deleted after the run). */
function tempLastMessageFile(): string {
  return path.join(os.tmpdir(), `sparrow-harness-${randomUUID()}.txt`);
}

/** The runner's timeline label — the CLI plus its model, or the raw exec command. */
function labelOf(cfg: RunnerConfig): string {
  if (cfg.kind === 'exec') return cfg.command ?? 'exec';
  return cfg.model ? `${cfg.kind} ${cfg.model}` : cfg.kind;
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
  const label = labelOf(cfg);
  switch (cfg.kind) {
    case 'claude': {
      const args = ['-p', '--output-format', 'json'];
      if (cfg.model) args.push('--model', cfg.model);
      args.push('--permission-mode', cfg.yolo ? 'bypassPermissions' : cfg.permissionMode);
      if (session.sessionId) {
        args.push(session.resume ? '--resume' : '--session-id', session.sessionId);
      }
      args.push('--append-system-prompt', prompt.system);
      return { file: 'claude', args, shell: false, cwd: cfg.cwd, stdin: prompt.user, label };
    }
    case 'codex': {
      const lastMessageFile = tempLastMessageFile();
      const args = ['exec', '--skip-git-repo-check'];
      if (cfg.model) args.push('-m', cfg.model);
      if (cfg.yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
      // `-o <file>` is the ONLY clean way to read codex's final message: its
      // stdout interleaves the whole run.
      args.push('-o', lastMessageFile, '-');
      return {
        file: 'codex',
        args,
        shell: false,
        cwd: cfg.cwd,
        stdin: prompt.combined,
        label,
        lastMessageFile,
      };
    }
    case 'gemini': {
      // `-p/--prompt` is gemini's documented headless trigger and an EMPTY one
      // is falsy (it would drop back to interactive), so the whole prompt rides
      // on argv here rather than stdin.
      const args: string[] = [];
      if (cfg.model) args.push('-m', cfg.model);
      if (cfg.yolo) args.push('-y');
      args.push('--output-format', 'text', '--prompt', prompt.combined);
      return { file: 'gemini', args, shell: false, cwd: cfg.cwd, stdin: '', label };
    }
    case 'exec':
    default:
      return {
        file: cfg.command ?? '',
        args: [],
        shell: true,
        cwd: cfg.cwd,
        stdin: prompt.combined,
        label,
      };
  }
}

/**
 * Extract the reply text (and, for claude, the session id) from what a runner
 * produced. Every runner degrades to "stdout is the reply", which is also the
 * `--exec` contract.
 */
export function parseRunnerOutput(
  kind: RunnerKind,
  stdout: string,
  lastMessage?: string,
): { text: string; sessionId?: string } {
  if (kind === 'claude') {
    try {
      const parsed = JSON.parse(stdout.trim()) as ClaudeResult;
      const text = typeof parsed.result === 'string' ? parsed.result : '';
      const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
      if (text || sessionId) return { text: text.trim(), sessionId };
    } catch {
      /* not the JSON envelope — fall through to raw stdout */
    }
    return { text: stdout.trim() };
  }
  if (kind === 'codex' && lastMessage !== undefined && lastMessage.trim() !== '') {
    return { text: lastMessage.trim() };
  }
  return { text: stdout.trim() };
}

/**
 * Does this failure look like a DEAD SESSION rather than a real error? A stored
 * `--resume` id can outlive the session it names (a cleared cache, a different
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

    const finish = (result: Omit<RunResult, 'ms' | 'text' | 'sessionId'>): void => {
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
      const parsed = parseRunnerOutput(cfg.kind, result.stdout, lastMessage);
      resolve({ ...result, ms: now() - started, text: parsed.text, sessionId: parsed.sessionId });
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
