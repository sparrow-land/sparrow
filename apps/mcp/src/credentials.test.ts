import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configDir,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  upsertDefaultProfile,
  defaultProfileNote,
  dedupeProfileName,
  resolveProfile,
  type Profile,
} from './credentials.js';

describe('credential store', () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-mcp-creds-'));
    env = { XDG_CONFIG_HOME: dir };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const profile = (over: Partial<Profile> = {}): Profile => ({
    server: 'http://x.example',
    token: 'agk_x',
    kind: 'agent',
    ...over,
  });

  it('round-trips v3 profiles ({ server, token, kind })', () => {
    saveCredentials(env, { profiles: { acme: profile() }, defaultProfile: 'acme' });
    const creds = loadCredentials(env);
    expect(creds.profiles.acme).toEqual({ server: 'http://x.example', token: 'agk_x', kind: 'agent' });
    expect(creds.defaultProfile).toBe('acme');
  });

  it('writes the file at mode 0600', () => {
    saveCredentials(env, { profiles: { acme: profile() }, defaultProfile: 'acme' });
    const mode = fs.statSync(credentialsPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('upsertDefaultProfile writes + dedupes names, and the FIRST profile takes the default', () => {
    const first = upsertDefaultProfile(env, 'acme', profile());
    expect(first.name).toBe('acme');
    expect(first.previousDefault).toBeUndefined();
    expect(first.defaultProfile).toBe('acme');
    expect(first.changed).toBe(true);

    const second = upsertDefaultProfile(env, 'acme', profile({ token: 'agk_y' }));
    expect(second.name).toBe('acme-2');
    const creds = loadCredentials(env);
    expect(creds.profiles['acme']!.token).toBe('agk_x');
    expect(creds.profiles['acme-2']!.token).toBe('agk_y');
  });

  // One machine, several agents, ONE credentials.json: a new profile must not
  // silently re-point every other agent's bare commands at this workspace.
  it('keeps an existing default when another profile is stored', () => {
    upsertDefaultProfile(env, 'acme', profile());
    const r = upsertDefaultProfile(env, 'beta', profile({ token: 'agk_b' }));
    expect(r.name).toBe('beta');
    expect(r.previousDefault).toBe('acme');
    expect(r.defaultProfile).toBe('acme');
    expect(r.changed).toBe(false);
    expect(loadCredentials(env).defaultProfile).toBe('acme');
  });

  it('moves the default when the caller passes setDefault', () => {
    upsertDefaultProfile(env, 'acme', profile());
    const r = upsertDefaultProfile(env, 'beta', profile({ token: 'agk_b' }), { setDefault: true });
    expect(r.defaultProfile).toBe('beta');
    expect(r.previousDefault).toBe('acme');
    expect(r.changed).toBe(true);
    expect(loadCredentials(env).defaultProfile).toBe('beta');
  });

  it('takes over a DANGLING default (it names a profile that no longer exists)', () => {
    saveCredentials(env, { profiles: {}, defaultProfile: 'ghost' });
    const r = upsertDefaultProfile(env, 'beta', profile({ token: 'agk_b' }));
    expect(r.previousDefault).toBe('ghost');
    expect(r.defaultProfile).toBe('beta');
    expect(r.changed).toBe(true);
  });

  it('keeps the default when REWRITING the profile that is already the default', () => {
    saveCredentials(env, { profiles: { acme: profile() }, defaultProfile: 'acme' });
    // Rewriting `acme` dedupes to `acme-2`, which must NOT steal the default.
    const r = upsertDefaultProfile(env, 'acme', profile({ token: 'agk_z' }));
    expect(r.name).toBe('acme-2');
    expect(r.defaultProfile).toBe('acme');
    expect(r.changed).toBe(false);
  });

  it('defaultProfileNote reports in the same words the CLI prints', () => {
    expect(defaultProfileNote({ name: 'acme', defaultProfile: 'acme', changed: true })).toBe(
      'defaultProfile: "acme"',
    );
    expect(
      defaultProfileNote({
        name: 'beta',
        previousDefault: 'acme',
        defaultProfile: 'beta',
        changed: true,
      }),
    ).toBe('defaultProfile: "acme" \u2192 "beta"');
    expect(
      defaultProfileNote({
        name: 'beta',
        previousDefault: 'acme',
        defaultProfile: 'acme',
        changed: false,
      }),
    ).toBe(
      'defaultProfile stays "acme" \u2014 pass --profile beta (or SPARROW_PROFILE=beta) on ' +
        'commands for this workspace, or re-run with set_default.',
    );
  });

  it('dedupes profile names', () => {
    expect(dedupeProfileName('acme', {})).toBe('acme');
    expect(dedupeProfileName('acme', { acme: profile() })).toBe('acme-2');
  });

  it('resolveProfile honors an explicit selector and the default', () => {
    saveCredentials(env, {
      profiles: { a: profile(), b: profile({ token: 'agk_b', kind: 'human' }) },
      defaultProfile: 'a',
    });
    expect(resolveProfile(env)!.name).toBe('a');
    expect(resolveProfile(env, 'b')!.profile.token).toBe('agk_b');
    expect(resolveProfile(env, 'missing')).toBeNull();
  });

  it('returns an empty store when the file is absent', () => {
    expect(loadCredentials(env)).toEqual({ profiles: {} });
  });
});

/**
 * `SPARROW_CONFIG_DIR` (issue #52) — the MCP server shares the CLI's on-disk
 * credential store, so it must resolve the store's DIRECTORY identically:
 * SPARROW_CONFIG_DIR > $XDG_CONFIG_HOME/sparrow > ~/.config/sparrow. Without
 * this, an MCP-driven `enroll` inside a sandbox wrote through to the operator's
 * shared store even when the sandbox had scoped everything else.
 */
describe('credential store directory resolution', () => {
  let sparrowDir: string;
  let xdgDir: string;

  beforeEach(() => {
    sparrowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-mcp-cfgdir-'));
    xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-mcp-xdg-'));
  });
  afterEach(() => {
    fs.rmSync(sparrowDir, { recursive: true, force: true });
    fs.rmSync(xdgDir, { recursive: true, force: true });
  });

  it('SPARROW_CONFIG_DIR names the directory verbatim and wins over XDG', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: sparrowDir, XDG_CONFIG_HOME: xdgDir })).toBe(sparrowDir);
    expect(credentialsPath({ SPARROW_CONFIG_DIR: sparrowDir })).toBe(
      path.join(sparrowDir, 'credentials.json'),
    );
  });

  it('falls back to $XDG_CONFIG_HOME/sparrow, then ~/.config/sparrow; empty reads as unset', () => {
    expect(configDir({ XDG_CONFIG_HOME: xdgDir })).toBe(path.join(xdgDir, 'sparrow'));
    expect(configDir({})).toBe(path.join(os.homedir(), '.config', 'sparrow'));
    expect(configDir({ SPARROW_CONFIG_DIR: '  ', XDG_CONFIG_HOME: xdgDir })).toBe(
      path.join(xdgDir, 'sparrow'),
    );
  });

  it('reads and writes stay inside SPARROW_CONFIG_DIR', () => {
    const sandboxed = { SPARROW_CONFIG_DIR: sparrowDir, XDG_CONFIG_HOME: xdgDir };
    upsertDefaultProfile(
      sandboxed,
      'sandbox',
      { server: 'http://x.example', token: 'agk_sandbox', kind: 'agent' },
    );
    expect(resolveProfile(sandboxed)!.profile.token).toBe('agk_sandbox');
    expect(fs.existsSync(path.join(xdgDir, 'sparrow', 'credentials.json'))).toBe(false);
  });
});
