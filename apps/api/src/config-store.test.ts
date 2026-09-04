import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './db/index.js';
import { ConfigStore, SECRET_MASK } from './config-store.js';

/**
 * Config resolution order (db → envVar → default) with a focus on the boolean
 * env-seeding path the managed image relies on: `BOOTSTRAP_FIRST_ORG=false`
 * seeds `auth.bootstrapFirstOrg` at boot with no cloud code involved.
 */
describe('ConfigStore env seeding', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('auth.bootstrapFirstOrg defaults to true with no env', () => {
    const store = new ConfigStore(handle.db);
    const { value, source } = store.resolve('auth.bootstrapFirstOrg');
    expect(value).toBe(true);
    expect(source).toBe('default');
  });

  it('BOOTSTRAP_FIRST_ORG=false seeds the flag from env (source: env)', () => {
    const store = new ConfigStore(handle.db, { BOOTSTRAP_FIRST_ORG: 'false' });
    const { value, source } = store.resolve('auth.bootstrapFirstOrg');
    expect(value).toBe(false);
    expect(source).toBe('env');
    expect(store.getBoolean('auth.bootstrapFirstOrg')).toBe(false);
  });

  it('any non-"false" env value keeps the flag on', () => {
    const store = new ConfigStore(handle.db, { BOOTSTRAP_FIRST_ORG: 'true' });
    expect(store.getBoolean('auth.bootstrapFirstOrg')).toBe(true);
  });

  it('a db value wins over the env seed', () => {
    const store = new ConfigStore(handle.db, { BOOTSTRAP_FIRST_ORG: 'false' });
    store.put({ 'auth.bootstrapFirstOrg': true });
    const { value, source } = store.resolve('auth.bootstrapFirstOrg');
    expect(value).toBe(true);
    expect(source).toBe('db');
  });
});

/**
 * The workspace-switcher config keys (cloud extension point): absent by default,
 * seeded from `WORKSPACE_DIRECTORY_URL` / `WORKSPACE_CREATE_URL` when set. Same
 * db → env → default resolution as every other key.
 */
describe('ConfigStore workspace switcher keys', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-ws-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('workspace.directoryUrl / workspace.createUrl default to empty with no env', () => {
    const store = new ConfigStore(handle.db);
    const dir = store.resolve('workspace.directoryUrl');
    const create = store.resolve('workspace.createUrl');
    expect(dir.value).toBe('');
    expect(dir.source).toBe('default');
    expect(create.value).toBe('');
    expect(create.source).toBe('default');
  });

  it('seeds both URLs from env (source: env)', () => {
    const store = new ConfigStore(handle.db, {
      WORKSPACE_DIRECTORY_URL: 'https://dir.example.com/api/v1/me/workspaces',
      WORKSPACE_CREATE_URL: 'https://dir.example.com/new',
    });
    expect(store.resolve('workspace.directoryUrl')).toEqual({
      value: 'https://dir.example.com/api/v1/me/workspaces',
      source: 'env',
    });
    expect(store.resolve('workspace.createUrl')).toEqual({
      value: 'https://dir.example.com/new',
      source: 'env',
    });
  });

  it('a db value wins over the env seed', () => {
    const store = new ConfigStore(handle.db, {
      WORKSPACE_DIRECTORY_URL: 'https://env.example.com',
    });
    store.put({ 'workspace.directoryUrl': 'https://db.example.com' });
    expect(store.resolve('workspace.directoryUrl')).toEqual({
      value: 'https://db.example.com',
      source: 'db',
    });
  });
});

/**
 * The outbound-email webhook keys (generic mail seam): both absent by default,
 * seeded from `EMAIL_WEBHOOK_URL` / `EMAIL_WEBHOOK_TOKEN` when set. The token is
 * a secret (masked on the `GET /config` wire); same db → env → default order.
 */
describe('ConfigStore email webhook keys', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-email-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('email.webhookUrl / email.webhookToken default to empty with no env', () => {
    const store = new ConfigStore(handle.db);
    const url = store.resolve('email.webhookUrl');
    const token = store.resolve('email.webhookToken');
    expect(url.value).toBe('');
    expect(url.source).toBe('default');
    expect(token.value).toBe('');
    expect(token.source).toBe('default');
  });

  it('seeds both from env (source: env)', () => {
    const store = new ConfigStore(handle.db, {
      EMAIL_WEBHOOK_URL: 'https://relay.example.com/send',
      EMAIL_WEBHOOK_TOKEN: 'sk_live_123',
    });
    expect(store.resolve('email.webhookUrl')).toEqual({
      value: 'https://relay.example.com/send',
      source: 'env',
    });
    expect(store.resolve('email.webhookToken')).toEqual({
      value: 'sk_live_123',
      source: 'env',
    });
  });

  it('the token is marked secret and masked on the wire (but readable server-side)', () => {
    const store = new ConfigStore(handle.db, {
      EMAIL_WEBHOOK_TOKEN: 'sk_live_123',
    });
    const entry = store.entries().find((e) => e.descriptor.key === 'email.webhookToken');
    expect(entry?.descriptor.secret).toBe(true);
    expect(entry?.value).toBe(SECRET_MASK);
    // Server-side reads are unmasked.
    expect(store.get('email.webhookToken')).toBe('sk_live_123');
  });
});

/**
 * Signup lockdown from env alone (issue #26). A stock compose instance ships
 * open signup; the only off-switch used to be `ADMIN_TOKEN` + `PUT /config`.
 * `AUTH_ALLOW_SIGNUP` / `AUTH_ALLOWED_EMAIL_PATTERNS` are env fallbacks for the
 * two descriptors that govern it, so an operator can lock the instance down
 * declaratively in `compose.yaml` before it ever boots. Defaults are unchanged
 * (open), and the empty-string-is-unset rule applies here like everywhere else.
 */
describe('ConfigStore signup lockdown env fallbacks', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-signup-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults stay open with no env (signup on, no pattern allowlist)', () => {
    const store = new ConfigStore(handle.db);
    expect(store.resolve('auth.allowSignup')).toEqual({ value: true, source: 'default' });
    expect(store.resolve('auth.allowedEmailPatterns')).toEqual({ value: [], source: 'default' });
  });

  it('AUTH_ALLOW_SIGNUP=false closes signup from env (source: env)', () => {
    const store = new ConfigStore(handle.db, { AUTH_ALLOW_SIGNUP: 'false' });
    expect(store.resolve('auth.allowSignup')).toEqual({ value: false, source: 'env' });
    expect(store.getBoolean('auth.allowSignup')).toBe(false);
  });

  it('AUTH_ALLOWED_EMAIL_PATTERNS is a comma-separated list (trimmed, blanks dropped)', () => {
    const store = new ConfigStore(handle.db, {
      AUTH_ALLOWED_EMAIL_PATTERNS: '*@acme.com, *@sub.acme.com ,,',
    });
    expect(store.resolve('auth.allowedEmailPatterns')).toEqual({
      value: ['*@acme.com', '*@sub.acme.com'],
      source: 'env',
    });
    expect(store.getStringArray('auth.allowedEmailPatterns')).toEqual([
      '*@acme.com',
      '*@sub.acme.com',
    ]);
  });

  it('empty compose passthrough (`${VAR:-}`) reads as unset — the instance stays open', () => {
    const store = new ConfigStore(handle.db, {
      AUTH_ALLOW_SIGNUP: '',
      AUTH_ALLOWED_EMAIL_PATTERNS: '',
    });
    expect(store.resolve('auth.allowSignup')).toEqual({ value: true, source: 'default' });
    expect(store.resolve('auth.allowedEmailPatterns')).toEqual({ value: [], source: 'default' });
  });

  it('a db value wins over the env fallback (the config page can re-open signup)', () => {
    const store = new ConfigStore(handle.db, { AUTH_ALLOW_SIGNUP: 'false' });
    store.put({ 'auth.allowSignup': true });
    expect(store.resolve('auth.allowSignup')).toEqual({ value: true, source: 'db' });
  });
});

/**
 * An env var that is DEFINED BUT EMPTY is not configuration. `compose.yaml`'s
 * `${VAR:-}` passthrough always defines every key it forwards, so an operator who
 * set nothing still ships `OPENAI_API_KEY=""` into the container. Treating that as
 * `source: 'env'` made `GET /config` claim a secret was configured (masked!) for a
 * key nobody had ever set. `''` reads as unset: fall through to the default.
 */
describe('ConfigStore empty-string env vars are unset', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-empty-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an empty string env var resolves to the descriptor default, not source: env', () => {
    const store = new ConfigStore(handle.db, {
      EMAIL_WEBHOOK_URL: '',
      EMAIL_WEBHOOK_TOKEN: '',
      WORKSPACE_DIRECTORY_URL: '',
      BOOTSTRAP_FIRST_ORG: '',
      GRAVATAR_AVATARS: '',
    });
    for (const key of [
      'email.webhookUrl',
      'email.webhookToken',
      'workspace.directoryUrl',
    ]) {
      expect(store.resolve(key)).toEqual({ value: '', source: 'default' });
    }
    // Booleans too: `BOOTSTRAP_FIRST_ORG=` must not read as the truthy
    // "any non-'false' value" branch — it is simply not set.
    expect(store.resolve('auth.bootstrapFirstOrg')).toEqual({ value: true, source: 'default' });
    expect(store.resolve('avatars.gravatar')).toEqual({ value: false, source: 'default' });
  });

  it('whitespace-only is still a value (only truly empty is unset)', () => {
    const store = new ConfigStore(handle.db, { WORKSPACE_DIRECTORY_URL: ' ' });
    expect(store.resolve('workspace.directoryUrl')).toEqual({ value: ' ', source: 'env' });
  });

  it('an empty db value still wins over the default (an explicit clear)', () => {
    const store = new ConfigStore(handle.db, { WORKSPACE_DIRECTORY_URL: 'https://dir.example' });
    store.put({ 'workspace.directoryUrl': '' });
    expect(store.resolve('workspace.directoryUrl')).toEqual({ value: '', source: 'db' });
  });

  it('GET /config does not mask an EMPTY secret — no phantom "a key is set here"', () => {
    const store = new ConfigStore(handle.db, { OPENAI_API_KEY: '' });
    const entry = store.entries().find((e) => e.descriptor.key === 'llm.openAiApiKey');
    expect(entry?.descriptor.secret).toBe(true);
    expect(entry?.value).toBe('');
    expect(entry?.source).toBe('default');
    // A real secret is still masked.
    const set = new ConfigStore(handle.db, { OPENAI_API_KEY: 'sk-real' });
    expect(set.entries().find((e) => e.descriptor.key === 'llm.openAiApiKey')?.value).toBe(
      SECRET_MASK,
    );
  });
});

/**
 * The realtime STT model is its own descriptor, not a reuse of `voice.sttModelId`:
 * the one-shot and realtime endpoints take different model families
 * (`scribe_v2` vs `scribe_v2_realtime`) and an operator must be able to move
 * either without the other.
 */
describe('voice.sttRealtimeModelId', () => {
  let handle: DbHandle;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-config-store-'));
    handle = openDb(dataDir);
  });
  afterEach(() => {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults to scribe_v2_realtime, independent of the one-shot model', () => {
    const store = new ConfigStore(handle.db);
    const { value, source } = store.resolve('voice.sttRealtimeModelId');
    expect(value).toBe('scribe_v2_realtime');
    expect(source).toBe('default');
    expect(store.get('voice.sttModelId')).toBe('scribe_v2');
  });

  it('is a plain (non-secret) string descriptor a db value can override', () => {
    const store = new ConfigStore(handle.db);
    const descriptor = store.descriptor('voice.sttRealtimeModelId');
    expect(descriptor).toBeDefined();
    expect(descriptor!.type).toBe('string');
    expect(descriptor!.secret).toBeUndefined();
    store.put({ 'voice.sttRealtimeModelId': 'scribe_v3_realtime' });
    expect(store.resolve('voice.sttRealtimeModelId')).toEqual({
      value: 'scribe_v3_realtime',
      source: 'db',
    });
  });
});
