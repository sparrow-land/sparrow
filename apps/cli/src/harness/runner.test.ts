import { describe, expect, it } from 'vitest';
import {
  RUNNERS,
  buildRunnerCommand,
  classifyRunFailure,
  parseRunnerOutput,
  resolveSandbox,
  resumeLooksBroken,
  runnerAdapter,
  type RunnerConfig,
  type RunnerKind,
} from './runner.js';
import { buildPrompt } from './prompt.js';

const prompt = buildPrompt({
  agent: { name: 'vm8-sparrow', orgName: 'Acme Inc' },
  group: { kind: 'chat', label: '#Product', roomKind: 'project' },
  transcript: [],
  messages: [{ from: 'Jake', at: '2026-09-03T10:00:00.000Z', subject: null, body: 'hi' }],
});

function cfg(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    kind: 'claude',
    cwd: '/proj',
    permissionMode: 'acceptEdits',
    yolo: false,
    runTimeoutMs: 600_000,
    ...over,
  };
}

describe('runner command construction', () => {
  it('claude: -p json, permission mode, framing on --append-system-prompt, body on stdin', () => {
    const cmd = buildRunnerCommand(cfg(), prompt, {});
    expect(cmd.file).toBe('claude');
    expect(cmd.shell).toBe(false);
    expect(cmd.args).toContain('-p');
    expect(cmd.args.join(' ')).toContain('--output-format json');
    expect(cmd.args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(cmd.args[cmd.args.indexOf('--append-system-prompt') + 1]).toBe(prompt.system);
    expect(cmd.stdin).toBe(prompt.user);
    expect(cmd.cwd).toBe('/proj');
  });

  it('claude: --model passes through', () => {
    const cmd = buildRunnerCommand(cfg({ model: 'fable' }), prompt, {});
    expect(cmd.args[cmd.args.indexOf('--model') + 1]).toBe('fable');
  });

  it('claude: --yolo becomes bypassPermissions', () => {
    const cmd = buildRunnerCommand(cfg({ yolo: true, permissionMode: 'acceptEdits' }), prompt, {});
    expect(cmd.args[cmd.args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('claude: a fresh session uses --session-id, a continued one --resume', () => {
    const fresh = buildRunnerCommand(cfg(), prompt, { sessionId: 'aaaa-bbbb', resume: false });
    expect(fresh.args[fresh.args.indexOf('--session-id') + 1]).toBe('aaaa-bbbb');
    expect(fresh.args).not.toContain('--resume');

    const cont = buildRunnerCommand(cfg(), prompt, { sessionId: 'aaaa-bbbb', resume: true });
    expect(cont.args[cont.args.indexOf('--resume') + 1]).toBe('aaaa-bbbb');
    expect(cont.args).not.toContain('--session-id');
  });

  it('codex: exec reading stdin, model via -m, final message via -o, yolo bypass', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'codex', model: 'gpt-5', yolo: true }), prompt, {});
    expect(cmd.file).toBe('codex');
    expect(cmd.args[0]).toBe('exec');
    expect(cmd.args[cmd.args.indexOf('-m') + 1]).toBe('gpt-5');
    expect(cmd.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd.args).toContain('-');
    expect(cmd.lastMessageFile).toBeDefined();
    expect(cmd.args[cmd.args.indexOf('-o') + 1]).toBe(cmd.lastMessageFile);
    expect(cmd.stdin).toBe(prompt.combined);
    expect(cmd.args).not.toContain('--session-id');
  });

  it('gemini: model via -m, yolo via -y, the whole prompt via --prompt', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'gemini', model: 'gemini-3-pro', yolo: true }), prompt, {});
    expect(cmd.file).toBe('gemini');
    expect(cmd.args[cmd.args.indexOf('-m') + 1]).toBe('gemini-3-pro');
    expect(cmd.args).toContain('-y');
    expect(cmd.args[cmd.args.indexOf('--prompt') + 1]).toBe(prompt.combined);
    expect(cmd.stdin).toBe('');
  });

  it('exec: runs the command through a shell with the whole prompt on stdin', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'exec', command: 'my-agent --go' }), prompt, {});
    expect(cmd.file).toBe('my-agent --go');
    expect(cmd.shell).toBe(true);
    expect(cmd.args).toEqual([]);
    expect(cmd.stdin).toBe(prompt.combined);
  });

  it('non-claude runners never carry a session or a permission mode', () => {
    for (const kind of ['codex', 'gemini', 'exec'] as const) {
      const cmd = buildRunnerCommand(
        cfg({ kind, command: 'x' }),
        prompt,
        { sessionId: 'aaaa', resume: true },
      );
      expect(cmd.args).not.toContain('--resume');
      expect(cmd.args).not.toContain('--permission-mode');
    }
  });

  it('labels itself for the timeline', () => {
    expect(buildRunnerCommand(cfg({ model: 'fable' }), prompt, {}).label).toBe('claude fable');
    expect(buildRunnerCommand(cfg({ kind: 'exec', command: 'echo hi' }), prompt, {}).label).toBe('echo hi');
  });
});

describe('runner output parsing', () => {
  it('claude: takes result and session_id out of the JSON envelope', () => {
    const out = JSON.stringify({ type: 'result', result: 'on it', session_id: 'sess-1' });
    expect(parseRunnerOutput('claude', out)).toEqual({ text: 'on it', sessionId: 'sess-1' });
  });

  it('claude: falls back to raw stdout when the envelope is not JSON', () => {
    expect(parseRunnerOutput('claude', 'plain text\n').text).toBe('plain text');
  });

  it('codex: prefers the --output-last-message file over noisy stdout', () => {
    expect(parseRunnerOutput('codex', 'lots of event noise', 'the answer\n').text).toBe('the answer');
    expect(parseRunnerOutput('codex', 'fallback\n', '').text).toBe('fallback');
  });

  it('gemini/exec: stdout trimmed is the reply', () => {
    expect(parseRunnerOutput('gemini', '  hello \n').text).toBe('hello');
    expect(parseRunnerOutput('exec', 'hello\n').text).toBe('hello');
  });
});

describe('resume failure detection', () => {
  it('recognises a dead session id in the runner output', () => {
    expect(resumeLooksBroken('', 'No conversation found with session ID: abc')).toBe(true);
    expect(resumeLooksBroken('Error: session abc not found', '')).toBe(true);
    expect(resumeLooksBroken('', 'connection reset')).toBe(false);
  });
});

/* ====================================================================== *
 * The adapter record — one entry per runner, no switch statements.
 * ====================================================================== */

describe('runner adapters', () => {
  it('covers every kind, and only claude and codex can continue a conversation', () => {
    const kinds: RunnerKind[] = ['claude', 'codex', 'gemini', 'exec'];
    for (const kind of kinds) expect(runnerAdapter(kind).kind).toBe(kind);
    expect(Object.keys(RUNNERS).sort()).toEqual([...kinds].sort());
    expect(RUNNERS.claude.resume).toBeDefined();
    expect(RUNNERS.codex.resume).toBeDefined();
    expect(RUNNERS.gemini.resume).toBeUndefined();
    expect(RUNNERS.exec.resume).toBeUndefined();
  });

  it('declares where the system framing goes: claude has a channel, nobody else does', () => {
    expect(RUNNERS.claude.systemPromptChannel).toBe('separate');
    for (const kind of ['codex', 'gemini', 'exec'] as const) {
      expect(RUNNERS[kind].systemPromptChannel).toBe('combined');
    }
  });

  it('claude mints its own session id; codex is told one by the runner', () => {
    expect(RUNNERS.claude.resume!.newSessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(RUNNERS.codex.resume!.newSessionId()).toBeUndefined();
  });
});

/* ====================================================================== *
 * codex: session continuity, sandbox posture, JSONL.
 * ====================================================================== */

describe('codex command construction', () => {
  it('first run: --json, the workspace-write default, -o, and the WHOLE framing on stdin', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'codex' }), prompt, {});
    expect(cmd.args.slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
    expect(cmd.args).toContain('--json');
    expect(cmd.args[cmd.args.indexOf('-s') + 1]).toBe('workspace-write');
    expect(cmd.args).not.toContain('resume');
    expect(cmd.stdin).toBe(prompt.combined);
  });

  it('resume: `exec resume <thread>`, and only the USER prompt (the framing is already in the thread)', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'codex' }), prompt, {
      sessionId: 'thr-1',
      resume: true,
    });
    expect(cmd.args.slice(0, 3)).toEqual(['exec', 'resume', 'thr-1']);
    expect(cmd.args).toContain('--json');
    expect(cmd.args[cmd.args.indexOf('-o') + 1]).toBe(cmd.lastMessageFile);
    expect(cmd.stdin).toBe(prompt.user);
    expect(cmd.stdin).not.toContain(prompt.system);
  });

  it('resume carries the sandbox as a -c override: `exec resume` has no -s flag', () => {
    const cmd = buildRunnerCommand(cfg({ kind: 'codex', sandbox: 'read-only' }), prompt, {
      sessionId: 'thr-1',
      resume: true,
    });
    expect(cmd.args).not.toContain('-s');
    expect(cmd.args[cmd.args.indexOf('-c') + 1]).toBe('sandbox_mode=read-only');
  });

  it('--sandbox overrides the default; --yolo replaces the sandbox entirely', () => {
    const fresh = buildRunnerCommand(cfg({ kind: 'codex', sandbox: 'danger-full-access' }), prompt, {});
    expect(fresh.args[fresh.args.indexOf('-s') + 1]).toBe('danger-full-access');

    const yolo = buildRunnerCommand(cfg({ kind: 'codex', yolo: true, sandbox: 'read-only' }), prompt, {
      sessionId: 'thr-1',
      resume: true,
    });
    expect(yolo.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(yolo.args).not.toContain('-s');
    expect(yolo.args).not.toContain('-c');
  });
});

/** A codex `--json` stream, shaped exactly as codex-cli 0.153.3 emits it. */
function jsonl(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}
const THREAD_STARTED = '{"type":"thread.started","thread_id":"01a06e9f-945a-7e93-be99-9b7d7638a37b"}';
const TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}';

describe('codex output parsing', () => {
  it('takes the thread id out of thread.started and the reply out of -o', () => {
    const out = parseRunnerOutput(
      'codex',
      jsonl(THREAD_STARTED, '{"type":"turn.started"}', TURN_COMPLETED),
      'the answer\n',
    );
    expect(out).toEqual({ text: 'the answer', sessionId: '01a06e9f-945a-7e93-be99-9b7d7638a37b' });
  });

  it('non-JSON lines in the stream never crash the parse', () => {
    const out = parseRunnerOutput(
      'codex',
      jsonl('Reading prompt from stdin...', THREAD_STARTED, '{"type":"turn.', TURN_COMPLETED),
      'ok\n',
    );
    expect(out.sessionId).toBe('01a06e9f-945a-7e93-be99-9b7d7638a37b');
    expect(out.text).toBe('ok');
  });

  it('never posts the raw JSONL as a reply when -o wrote nothing', () => {
    const out = parseRunnerOutput('codex', jsonl(THREAD_STARTED, TURN_COMPLETED), '');
    expect(out.text).toBe('');
    expect(out.sessionId).toBe('01a06e9f-945a-7e93-be99-9b7d7638a37b');
  });

  it('falls back to a JSONL agent message when -o wrote nothing but the stream carried one', () => {
    const out = parseRunnerOutput(
      'codex',
      jsonl(
        THREAD_STARTED,
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"from the stream"}}',
        TURN_COMPLETED,
      ),
      '',
    );
    expect(out.text).toBe('from the stream');
  });
});

describe('codex failure classification', () => {
  it('a turn.failed is a failure even on exit 0, and carries its message', () => {
    const stdout = jsonl(
      THREAD_STARTED,
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}',
    );
    expect(classifyRunFailure('codex', { code: 0, stdout, stderr: '' })).toMatchObject({
      failed: true,
      message: 'unexpected status 401 Unauthorized',
    });
  });

  it('transient error events BEFORE a completed turn are retries, not failures', () => {
    // Verified against the live binary: codex emits `error` for every
    // "Reconnecting… n/5" attempt, including ones it then recovers from.
    const stdout = jsonl(
      THREAD_STARTED,
      '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401)"}',
      TURN_COMPLETED,
    );
    expect(classifyRunFailure('codex', { code: 0, stdout, stderr: '' }).failed).toBe(false);
  });

  it('an error event with no completed turn IS a failure', () => {
    const stdout = jsonl(THREAD_STARTED, '{"type":"error","message":"stream closed"}');
    expect(classifyRunFailure('codex', { code: 0, stdout, stderr: '' })).toMatchObject({
      failed: true,
      message: 'stream closed',
    });
  });

  it('a clean stream on exit 0 is a success', () => {
    const stdout = jsonl(THREAD_STARTED, '{"type":"turn.started"}', TURN_COMPLETED);
    expect(classifyRunFailure('codex', { code: 0, stdout, stderr: '' })).toEqual({
      failed: false,
      resumeBroken: false,
    });
  });

  it('a dead thread id reads as a broken resume, not a real error', () => {
    // The live wording: `exec resume` on an unknown id exits 1 with no JSONL.
    const stderr =
      'Error: thread/resume: thread/resume failed: no rollout found for thread id ' +
      '11111111-2222-3333-4444-555555555555 (code -32600)';
    const failure = classifyRunFailure('codex', { code: 1, stdout: '', stderr });
    expect(failure.failed).toBe(true);
    expect(failure.resumeBroken).toBe(true);
    // And a plain crash is not mistaken for one.
    expect(classifyRunFailure('codex', { code: 1, stdout: '', stderr: 'segfault' }).resumeBroken).toBe(false);
  });

  it('claude keeps its exit-code contract and its own dead-session wording', () => {
    expect(classifyRunFailure('claude', { code: 0, stdout: 'x', stderr: '' }).failed).toBe(false);
    expect(
      classifyRunFailure('claude', { code: 1, stdout: '', stderr: 'No conversation found with session ID: a' }),
    ).toMatchObject({ failed: true, resumeBroken: true });
  });

  it('gemini and exec are exit-code only', () => {
    for (const kind of ['gemini', 'exec'] as const) {
      expect(classifyRunFailure(kind, { code: 0, stdout: '', stderr: 'noise' }).failed).toBe(false);
      expect(classifyRunFailure(kind, { code: 3, stdout: '', stderr: '' })).toEqual({
        failed: true,
        resumeBroken: false,
      });
    }
  });
});

describe('--sandbox resolution', () => {
  it('accepts codex sandbox modes and defaults to none (the adapter picks)', () => {
    expect(resolveSandbox('codex', 'workspace-write')).toEqual({ value: 'workspace-write' });
    expect(resolveSandbox('codex', 'read-only')).toEqual({ value: 'read-only' });
    expect(resolveSandbox('codex', 'danger-full-access')).toEqual({ value: 'danger-full-access' });
    expect(resolveSandbox('codex', undefined)).toEqual({});
  });

  it('rejects an unknown mode by name, listing the real ones', () => {
    const { error } = resolveSandbox('codex', 'yolo');
    expect(error).toContain('yolo');
    expect(error).toContain('workspace-write');
  });

  it('rejects --sandbox for runners that have no sandbox', () => {
    for (const kind of ['claude', 'gemini', 'exec'] as const) {
      expect(resolveSandbox(kind, 'read-only').error).toContain('--codex');
    }
  });
});
