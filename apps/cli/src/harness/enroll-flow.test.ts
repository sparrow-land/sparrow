import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type SparrowClient } from '@sparrow/client';
import type { PollEnrollmentResponse } from '@sparrow/common-types';
import { saveProfile } from '../credentials.js';
import {
  findAgentProfileForServer,
  pollEnrollmentUntilResolved,
  readOrgName,
  rememberOrgName,
} from './enroll-flow.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-enrollflow-'));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('findAgentProfileForServer', () => {
  it('matches an agent profile on the same server, ignoring a trailing slash and case', () => {
    saveProfile(env, 'bot', { server: 'https://Sparrow.Example.com', token: 'agk_1', kind: 'agent' });
    expect(findAgentProfileForServer(env, 'https://sparrow.example.com/')?.name).toBe('bot');
  });

  it('never matches a human profile or a different server', () => {
    saveProfile(env, 'me', { server: 'https://s', token: 'ses_1', kind: 'human' });
    saveProfile(env, 'elsewhere', { server: 'https://other', token: 'agk_2', kind: 'agent' });
    expect(findAgentProfileForServer(env, 'https://s')).toBeUndefined();
  });

  it('an explicit --profile is authoritative: it matches only if IT points at the server', () => {
    saveProfile(env, 'a', { server: 'https://s', token: 'agk_1', kind: 'agent' });
    saveProfile(env, 'b', { server: 'https://other', token: 'agk_2', kind: 'agent' });
    expect(findAgentProfileForServer(env, 'https://s', 'a')?.name).toBe('a');
    expect(findAgentProfileForServer(env, 'https://s', 'b')).toBeUndefined();
  });

  it('prefers the default profile when several agents share a server', () => {
    saveProfile(env, 'first', { server: 'https://s', token: 'agk_1', kind: 'agent' });
    saveProfile(env, 'second', { server: 'https://s', token: 'agk_2', kind: 'agent' }, { setDefault: true });
    expect(findAgentProfileForServer(env, 'https://s')?.name).toBe('second');
  });
});

/* ------------------------------------------------------------------ *
 * pollEnrollmentUntilResolved — a waiting enroll must survive a server
 * RESTART. `TypeError: fetch failed` (ECONNREFUSED while the server comes
 * back up) is routine during dev and self-host; it must not kill a wait
 * that was otherwise working.
 * ------------------------------------------------------------------ */

const REF = { inviteToken: 'ivk_1', enrollmentId: 'enl_1', enrollmentToken: 'enr_1' };

/** A client whose only method is `pollEnrollment`, driven by `next`. */
function fakePollClient(next: () => Promise<PollEnrollmentResponse>): {
  client: SparrowClient;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    pollEnrollment: async () => {
      calls++;
      return next();
    },
  } as unknown as SparrowClient;
  return { client, calls: () => calls };
}

const APPROVED = {
  status: 'approved',
  agent: { id: 'agt_1', name: 'bot' },
  key: 'agk_1',
  org: { id: 'org_1', name: 'Acme' },
  dmRoomId: 'room_dm',
} as unknown as PollEnrollmentResponse;

describe('pollEnrollmentUntilResolved — transport resilience', () => {
  const fast = { SPARROW_POLL_INTERVAL_MS: '1' };

  it('retries a transient transport failure and still resolves (server restart)', async () => {
    let n = 0;
    const { client, calls } = fakePollClient(async () => {
      if (++n <= 2) throw new TypeError('fetch failed');
      return APPROVED;
    });
    const poll = await pollEnrollmentUntilResolved(client, REF, 5000, fast);
    expect(poll.status).toBe('approved');
    expect(calls()).toBe(3);
  });

  it('retries a transient ApiError (503) too', async () => {
    let n = 0;
    const { client } = fakePollClient(async () => {
      if (++n === 1) throw new ApiError({ code: 'unavailable', status: 503, message: 'down' });
      return APPROVED;
    });
    const poll = await pollEnrollmentUntilResolved(client, REF, 5000, fast);
    expect(poll.status).toBe('approved');
  });

  it('returns an UNREACHABLE timeout (never throws) when the deadline passes offline', async () => {
    const { client } = fakePollClient(async () => {
      throw new TypeError('fetch failed');
    });
    const poll = await pollEnrollmentUntilResolved(client, REF, 30, fast);
    expect(poll.status).toBe('timeout');
    expect(poll).toMatchObject({ unreachable: true });
    expect((poll as { lastError?: string }).lastError).toMatch(/fetch failed/i);
  });

  it('a plain timeout (server answering "pending") is NOT flagged unreachable', async () => {
    const { client } = fakePollClient(async () => ({ status: 'pending', retryAfterSeconds: 1 }));
    const poll = await pollEnrollmentUntilResolved(client, REF, 0, fast);
    expect(poll.status).toBe('timeout');
    expect((poll as { unreachable?: true }).unreachable).toBeUndefined();
  });

  it('propagates a NON-transient ApiError immediately (404: the enrollment is gone)', async () => {
    let calls = 0;
    const { client } = fakePollClient(async () => {
      calls++;
      throw new ApiError({ code: 'not_found', status: 404, message: 'gone' });
    });
    await expect(pollEnrollmentUntilResolved(client, REF, 5000, fast)).rejects.toThrow(/gone/);
    expect(calls).toBe(1);
  });
});

describe('org name memory', () => {
  it('round-trips the org display name per profile', () => {
    rememberOrgName(env, 'bot', 'Acme Inc');
    expect(readOrgName(env, 'bot')).toBe('Acme Inc');
    expect(readOrgName(env, 'other')).toBeUndefined();
  });

  it('ignores an empty name and never throws on a missing store', () => {
    rememberOrgName(env, 'bot', '');
    expect(readOrgName(env, 'bot')).toBeUndefined();
    expect(readOrgName(env, 'nobody')).toBeUndefined();
  });
});
