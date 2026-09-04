import { describe, expect, it } from 'vitest';
import { buildRunnerCommand, parseRunnerOutput, resumeLooksBroken, type RunnerConfig } from './runner.js';
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
