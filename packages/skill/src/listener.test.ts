/**
 * The ONE prescription for "the listener command this agent must run".
 *
 * Everything that tells an agent to re-arm — the skill fragments, the three hook
 * nudges, the CLI's enroll banner and its Codex wake queue — renders through
 * {@link sparrowCommand}. These tests pin the rendering AND pin the shipped
 * fragments to it, so a change in one place cannot leave the others behind.
 */
import { describe, expect, it } from 'vitest';
import { awaitCommand, detectTurnBasedRuntime, shellQuote, sparrowCommand } from './listener.js';
import { fragment } from './skill-md.js';
import { PROVIDERS } from './skill-md.js';

describe('sparrowCommand — the prescribed listener command', () => {
  it('renders bare when no profile and no config dir are in play', () => {
    expect(sparrowCommand('await')).toBe('sparrow await');
    expect(sparrowCommand('pop')).toBe('sparrow pop');
    expect(awaitCommand()).toBe('sparrow await');
    expect(awaitCommand({})).toBe('sparrow await');
    // An explicitly empty/blank profile is the same as none — never `--profile ""`.
    expect(awaitCommand({ profile: '   ' })).toBe('sparrow await');
  });

  it('qualifies with --profile when a profile is named', () => {
    expect(awaitCommand({ profile: 'cubes-vm4-codex' })).toBe('sparrow await --profile cubes-vm4-codex');
    expect(sparrowCommand('pop', { profile: 'cubes-vm4-codex' })).toBe(
      'sparrow pop --profile cubes-vm4-codex',
    );
    expect(sparrowCommand('upgrade', { profile: 'cubes-vm4-codex' })).toBe(
      'sparrow upgrade --profile cubes-vm4-codex',
    );
  });

  it('prefixes SPARROW_CONFIG_DIR when a custom credential store is in effect', () => {
    expect(awaitCommand({ profile: 'vm4', configDir: '/srv/agents/vm4/config' })).toBe(
      'SPARROW_CONFIG_DIR=/srv/agents/vm4/config sparrow await --profile vm4',
    );
    // The dir alone is enough to need the prefix.
    expect(awaitCommand({ configDir: '/srv/agents/vm4/config' })).toBe(
      'SPARROW_CONFIG_DIR=/srv/agents/vm4/config sparrow await',
    );
  });

  it('shell-quotes anything that is not a plain word, escaping embedded quotes', () => {
    expect(shellQuote('plain-name_1.2')).toBe('plain-name_1.2');
    expect(shellQuote('/srv/a b/config')).toBe("'/srv/a b/config'");
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
    expect(awaitCommand({ profile: 'a b', configDir: '/srv/a b' })).toBe(
      "SPARROW_CONFIG_DIR='/srv/a b' sparrow await --profile 'a b'",
    );
  });
});

describe('detectTurnBasedRuntime', () => {
  it('reads Codex from CODEX_THREAD_ID and Claude Code from its own markers', () => {
    expect(detectTurnBasedRuntime({ CODEX_THREAD_ID: 'thr_1' })).toBe('codex');
    expect(detectTurnBasedRuntime({ CLAUDECODE: '1' })).toBe('claude');
    expect(detectTurnBasedRuntime({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude');
  });

  it('is undefined when nothing identifies a turn-based harness (blank reads as unset)', () => {
    expect(detectTurnBasedRuntime({})).toBeUndefined();
    expect(detectTurnBasedRuntime({ CODEX_THREAD_ID: '  ' })).toBeUndefined();
    expect(detectTurnBasedRuntime({ CLAUDECODE: '' })).toBeUndefined();
  });
});

describe('the shipped skill fragments render through the same prescription', () => {
  it('every provider names exactly `awaitCommand()`', () => {
    for (const provider of PROVIDERS) {
      for (const key of ['await-command', 'await-command-code', 'await-command-rearm']) {
        expect(fragment(provider, key)).toBe(awaitCommand());
      }
    }
  });
});
