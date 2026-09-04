import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, ConfigError, type Env } from './config.js';
import { saveCredentials } from './credentials.js';

describe('resolveConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-mcp-cfg-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const withProfile = (extra: Env = {}): Env => {
    const env: Env = { XDG_CONFIG_HOME: dir, ...extra };
    saveCredentials(env, {
      profiles: {
        acme: { server: 'http://profile.example', token: 'agk_profile', kind: 'agent' },
      },
      defaultProfile: 'acme',
    });
    return env;
  };

  it('prefers env SPARROW_SERVER + SPARROW_TOKEN over a profile', () => {
    const env = withProfile({ SPARROW_SERVER: 'http://env.example', SPARROW_TOKEN: 'agk_env' });
    const cfg = resolveConfig(env);
    expect(cfg.server).toBe('http://env.example');
    expect(cfg.token).toBe('agk_env');
    expect(cfg.kind).toBe('agent');
    expect(cfg.source).toBe('env');
  });

  it('falls back to the default credential profile', () => {
    const env = withProfile();
    const cfg = resolveConfig(env);
    expect(cfg.server).toBe('http://profile.example');
    expect(cfg.token).toBe('agk_profile');
    expect(cfg.kind).toBe('agent');
    expect(cfg.profileName).toBe('acme');
    expect(cfg.source).toBe('profile');
  });

  it('carries SPARROW_ROOM and SPARROW_ORG as roomId/orgId', () => {
    const env = withProfile({ SPARROW_ROOM: 'room_abc', SPARROW_ORG: 'org_xyz' });
    const cfg = resolveConfig(env);
    expect(cfg.roomId).toBe('room_abc');
    expect(cfg.orgId).toBe('org_xyz');
  });

  it('infers kind human from a ses_ token', () => {
    const env: Env = { XDG_CONFIG_HOME: dir, SPARROW_SERVER: 'http://env.example', SPARROW_TOKEN: 'ses_abc' };
    const cfg = resolveConfig(env);
    expect(cfg.kind).toBe('human');
  });

  it('throws ConfigError when neither env nor profile resolves a server', () => {
    const env: Env = { XDG_CONFIG_HOME: dir };
    expect(() => resolveConfig(env)).toThrow(ConfigError);
  });

  it('resolves a server with no token (enroll still works)', () => {
    const env: Env = { XDG_CONFIG_HOME: dir, SPARROW_SERVER: 'http://env.example' };
    const cfg = resolveConfig(env);
    expect(cfg.server).toBe('http://env.example');
    expect(cfg.token).toBeUndefined();
    expect(cfg.kind).toBeUndefined();
  });

  it('selects a non-default profile via SPARROW_PROFILE', () => {
    const env: Env = { XDG_CONFIG_HOME: dir, SPARROW_PROFILE: 'other' };
    saveCredentials(env, {
      profiles: {
        acme: { server: 'http://a.example', token: 'agk_a', kind: 'agent' },
        other: { server: 'http://b.example', token: 'agk_b', kind: 'agent' },
      },
      defaultProfile: 'acme',
    });
    const cfg = resolveConfig(env);
    expect(cfg.server).toBe('http://b.example');
    expect(cfg.profileName).toBe('other');
  });
});
