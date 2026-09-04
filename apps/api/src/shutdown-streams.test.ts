import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeTestServer,
  listen,
  openSse,
  signup,
  firstOrgId,
  createRoom,
  type TestServer,
} from './test-helpers.js';

/**
 * Issue #55: `docker stop` hung for the full 10 s grace and ended in SIGKILL
 * whenever ANY SSE stream was open — one `sparrow watch`, one browser tab, i.e.
 * always in practice. `app.close()` waits for in-flight requests, and a hijacked
 * event stream never finishes on its own, so the `onClose` chain (which closes
 * AND checkpoints the database) never ran: a `sparrow.db` copied after the stop
 * was missing everything since the last checkpoint.
 *
 * The contract these tests pin: closing ENDS open streams first, so close
 * completes in well under the 10 s docker grace and the WAL is folded back.
 */
const CLOSE_BUDGET_MS = 2000;

/** Size of the `-wal` sidecar (0 when checkpointed away or never created). */
function walBytes(dataDir: string): number {
  const wal = path.join(dataDir, 'sparrow.db-wal');
  return existsSync(wal) ? statSync(wal).size : 0;
}

async function timedClose(ts: TestServer): Promise<number> {
  const started = Date.now();
  await ts.app.close();
  return Date.now() - started;
}

describe('shutdown with open SSE streams', () => {
  it('ends an open /me/events stream so close() finishes fast and checkpoints the WAL', async () => {
    const ts = await makeTestServer();
    try {
      const base = await listen(ts);
      const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
      const stream = await openSse(base, '/api/v1/me/events', owner.token);

      expect(walBytes(ts.dataDir)).toBeGreaterThan(0); // signup wrote through the WAL

      const elapsed = await timedClose(ts);
      expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS);
      // The client must see a clean end, not a hung socket.
      await stream.closed;
      expect(walBytes(ts.dataDir)).toBe(0);
    } finally {
      rmSync(ts.dataDir, { recursive: true, force: true });
    }
  });

  it('ends an open room stream too', async () => {
    const ts = await makeTestServer();
    try {
      const base = await listen(ts);
      const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
      const orgId = await firstOrgId(ts.app, owner.token);
      const roomId = await createRoom(ts.app, owner.token, orgId, 'general');
      const stream = await openSse(base, `/api/v1/rooms/${roomId}/events`, owner.token);

      const elapsed = await timedClose(ts);
      expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS);
      await stream.closed;
      expect(walBytes(ts.dataDir)).toBe(0);
    } finally {
      rmSync(ts.dataDir, { recursive: true, force: true });
    }
  });

  it('several concurrent streams (a watcher plus browser tabs) all end', async () => {
    const ts = await makeTestServer();
    try {
      const base = await listen(ts);
      const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Owner' });
      const streams = await Promise.all([
        openSse(base, '/api/v1/me/events', owner.token),
        openSse(base, '/api/v1/me/events', owner.token),
        openSse(base, '/api/v1/me/events', owner.token),
      ]);

      const elapsed = await timedClose(ts);
      expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS);
      await Promise.all(streams.map((s) => s.closed));
      expect(walBytes(ts.dataDir)).toBe(0);
    } finally {
      rmSync(ts.dataDir, { recursive: true, force: true });
    }
  });
});
