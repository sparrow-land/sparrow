import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configDir,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  saveProfile,
  savePending,
  loadPending,
  resolveProfile,
  type Profile,
} from './credentials.js';
import { statePath } from './state.js';

/**
 * WHERE the credential store lives (issue #52). `SPARROW_STATE_DIR` scopes loop
 * state but never scoped credentials, so a sandboxed `sparrow enroll` wrote into
 * the operator's shared `~/.config/sparrow/credentials.json`. `SPARROW_CONFIG_DIR`
 * is the credential-store equivalent: it names the directory outright, so one
 * variable isolates a whole agent's identity without commandeering `XDG_CONFIG_HOME`
 * (which moves every other program's config too).
 *
 * Resolution order — read AND write, everywhere credentials are touched:
 *   SPARROW_CONFIG_DIR  >  $XDG_CONFIG_HOME/sparrow  >  ~/.config/sparrow
 */
describe('credential store directory resolution', () => {
  let sparrowDir: string;
  let xdgDir: string;

  beforeEach(() => {
    sparrowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-cfgdir-'));
    xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-xdg-'));
  });
  afterEach(() => {
    fs.rmSync(sparrowDir, { recursive: true, force: true });
    fs.rmSync(xdgDir, { recursive: true, force: true });
  });

  const profile = (over: Partial<Profile> = {}): Profile => ({
    server: 'http://x.example',
    token: 'agk_x',
    kind: 'agent',
    ...over,
  });

  it('SPARROW_CONFIG_DIR names the directory verbatim (no `sparrow` suffix)', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: sparrowDir })).toBe(sparrowDir);
    expect(credentialsPath({ SPARROW_CONFIG_DIR: sparrowDir })).toBe(
      path.join(sparrowDir, 'credentials.json'),
    );
  });

  it('SPARROW_CONFIG_DIR wins over XDG_CONFIG_HOME', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: sparrowDir, XDG_CONFIG_HOME: xdgDir })).toBe(sparrowDir);
  });

  it('falls back to $XDG_CONFIG_HOME/sparrow, then ~/.config/sparrow', () => {
    expect(configDir({ XDG_CONFIG_HOME: xdgDir })).toBe(path.join(xdgDir, 'sparrow'));
    expect(configDir({})).toBe(path.join(os.homedir(), '.config', 'sparrow'));
  });

  it('an empty or whitespace-only SPARROW_CONFIG_DIR reads as unset', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: '', XDG_CONFIG_HOME: xdgDir })).toBe(
      path.join(xdgDir, 'sparrow'),
    );
    expect(configDir({ SPARROW_CONFIG_DIR: '   ', XDG_CONFIG_HOME: xdgDir })).toBe(
      path.join(xdgDir, 'sparrow'),
    );
  });

  it('WRITES land in SPARROW_CONFIG_DIR and never in the XDG store', () => {
    const env = { SPARROW_CONFIG_DIR: path.join(sparrowDir, 'nested'), XDG_CONFIG_HOME: xdgDir };
    saveProfile(env, 'acme', profile(), {});
    expect(
      JSON.parse(fs.readFileSync(path.join(sparrowDir, 'nested', 'credentials.json'), 'utf8')),
    ).toMatchObject({ profiles: { acme: { token: 'agk_x' } }, defaultProfile: 'acme' });
    // The operator's shared store is untouched.
    expect(fs.existsSync(path.join(xdgDir, 'sparrow', 'credentials.json'))).toBe(false);
  });

  it('READS come back from SPARROW_CONFIG_DIR, isolated from the XDG store', () => {
    const shared = { XDG_CONFIG_HOME: xdgDir };
    const sandboxed = { SPARROW_CONFIG_DIR: sparrowDir, XDG_CONFIG_HOME: xdgDir };
    saveCredentials(shared, { profiles: { operator: profile({ token: 'ses_op' }) }, defaultProfile: 'operator' });
    saveProfile(sandboxed, 'sandbox', profile({ token: 'agk_sandbox' }), {});

    expect(resolveProfile(sandboxed)?.name).toBe('sandbox');
    expect(resolveProfile(shared)?.name).toBe('operator');
    expect(loadCredentials(sandboxed).profiles.operator).toBeUndefined();
    expect(loadCredentials(shared).profiles.sandbox).toBeUndefined();
  });

  it('the pending enrollment record is scoped too (Ctrl-C-safe enroll stays sandboxed)', () => {
    const env = { SPARROW_CONFIG_DIR: sparrowDir, XDG_CONFIG_HOME: xdgDir };
    savePending(env, {
      server: 'http://x.example',
      inviteToken: 'ivk_1',
      enrollmentId: 'enl_1',
      enrollmentToken: 'enr_1',
      name: 'demo',
      profileName: 'demo',
    });
    expect(loadPending(env)?.enrollmentId).toBe('enl_1');
    expect(loadPending({ XDG_CONFIG_HOME: xdgDir })).toBeUndefined();
  });

  it('the sibling state file follows the credential store', () => {
    expect(statePath({ SPARROW_CONFIG_DIR: sparrowDir })).toBe(
      path.join(sparrowDir, 'state.json'),
    );
  });
});
