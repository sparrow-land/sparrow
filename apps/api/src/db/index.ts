import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { migrate } from './migrate.js';

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface DbHandle {
  db: DB;
  sqlite: Database.Database;
  attachmentsDir: string;
  /** Cache dir for synthesized TTS audio (`$DATA_DIR/tts/{messageId}`). */
  ttsDir: string;
  /** Uploaded human avatars (`$DATA_DIR/avatars/{humanId}`). */
  avatarsDir: string;
  close(): void;
}

/** The v3 database filename. */
const DB_FILE = 'sparrow.db';

/**
 * Open (or create) the SQLite database under `dataDir`, create the fresh v3
 * schema, and return a drizzle handle plus the raw better-sqlite3 connection
 * (used for synchronous transactions). v3 boots fresh databases only — there is
 * no migration chain.
 */
export function openDb(dataDir: string): DbHandle {
  mkdirSync(dataDir, { recursive: true });
  const attachmentsDir = path.join(dataDir, 'attachments');
  mkdirSync(attachmentsDir, { recursive: true });
  const ttsDir = path.join(dataDir, 'tts');
  mkdirSync(ttsDir, { recursive: true });
  const avatarsDir = path.join(dataDir, 'avatars');
  mkdirSync(avatarsDir, { recursive: true });

  const sqlite = new Database(path.join(dataDir, DB_FILE));
  migrate(sqlite);
  const db = drizzle(sqlite, { schema }) as DB;

  return {
    db,
    sqlite,
    attachmentsDir,
    ttsDir,
    avatarsDir,
    close: () => {
      // WAL mode keeps recent writes in `sparrow.db-wal`. SQLite auto-checkpoints
      // only when the LAST connection closes, so with any other connection open
      // (a backup tool, a second process) a copied `sparrow.db` would be missing
      // writes — an EMPTY database in the worst case. Fold the WAL back
      // explicitly, then close. Best-effort: a checkpoint can be blocked by a
      // live reader, and closing is still the more important half.
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // already closed, or a reader held the WAL — fall through to close()
      }
      try {
        sqlite.close();
      } catch {
        // already closed
      }
    },
  };
}
