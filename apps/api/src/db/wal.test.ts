import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './index.js';

/**
 * The database runs in WAL mode, so recent writes live in `sparrow.db-wal`
 * until a checkpoint folds them back. SQLite only auto-checkpoints when the
 * LAST connection closes — so a copied `sparrow.db` can be an empty database.
 * `close()` checkpoints explicitly (TRUNCATE) before closing.
 */
describe('DbHandle.close', () => {
  let dir: string;
  let copyDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-wal-'));
    copyDir = mkdtempSync(path.join(tmpdir(), 'sparrow-wal-copy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(copyDir, { recursive: true, force: true });
  });

  it('checkpoints the WAL so `sparrow.db` alone is a complete database', () => {
    const handle = openDb(dir);
    handle.sqlite.exec('CREATE TABLE wal_probe (id TEXT PRIMARY KEY)');
    handle.sqlite.exec("INSERT INTO wal_probe (id) VALUES ('written')");

    const dbFile = path.join(dir, 'sparrow.db');
    const walFile = `${dbFile}-wal`;
    expect(statSync(walFile).size).toBeGreaterThan(0);

    // A second live connection suppresses SQLite's close-time auto-checkpoint —
    // exactly the shape of a running server with a backup tool attached.
    const observer = new Database(dbFile);
    observer.prepare('SELECT 1').get();

    handle.close();

    const walSize = existsSync(walFile) ? statSync(walFile).size : 0;
    expect(walSize).toBe(0);

    const copy = path.join(copyDir, 'sparrow.db');
    copyFileSync(dbFile, copy);
    observer.close();

    const reopened = new Database(copy, { readonly: true });
    const row = reopened.prepare('SELECT count(*) AS n FROM wal_probe').get() as { n: number };
    expect(row.n).toBe(1);
    reopened.close();
  });

  it('is safe to call twice (shutdown paths can race)', () => {
    const handle = openDb(dir);
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });
});
