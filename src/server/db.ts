import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

export const DB_FILENAME = 'orr_pulse.db';

export interface OpenDbResult {
  db: DatabaseSync;
  dbPath: string;
  /** True when the database file did not exist before this open (fresh create). */
  isNewFile: boolean;
}

export function openDatabase(dataDir: string): OpenDbResult {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, DB_FILENAME);
  const isNewFile = !fs.existsSync(dbPath);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { timeout: 5000 });
  } catch (err) {
    // A present-but-unopenable file (corruption, wrong format) must fail loudly,
    // never fall through to re-seeding over the operator's data.
    throw new Error(
      `Failed to open SQLite database at ${dbPath} (existing file may be corrupt): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    applySchema(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
    if (isNewFile) {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* best effort */
      }
    }
    throw new Error(
      `Failed to initialize SQLite schema at ${dbPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return { db, dbPath, isNewFile };
}

export function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      employee_code TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_ist TEXT NOT NULL,
      status TEXT NOT NULL,
      next_refresh_due_ms INTEGER,
      lease_owner TEXT,
      lease_until_ms INTEGER,
      revision INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER,
      last_provider_error TEXT,
      data TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sessions_due
      ON sessions(date_ist, status, next_refresh_due_ms);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_alerts_user
      ON alerts(user_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS journeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      departure_ms INTEGER NOT NULL,
      data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_journeys_user
      ON journeys(user_id, departure_ms);

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
      ON auth_tokens(user_id);

    CREATE TABLE IF NOT EXISTS quota (
      date_ist TEXT PRIMARY KEY,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS devices (
      installation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expo_push_token TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_devices_user
      ON devices(user_id);

    CREATE TABLE IF NOT EXISTS device_generations (
      installation_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS push_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      device_generation INTEGER NOT NULL DEFAULT 1,
      alert_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER,
      claim_owner TEXT,
      claim_until_ms INTEGER,
      ticket_id TEXT,
      receipt_status TEXT
        CHECK (receipt_status IN ('PENDING','OK','ERROR') OR receipt_status IS NULL),
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_outbox_sendable
      ON push_outbox(status, next_attempt_at_ms);
    CREATE INDEX IF NOT EXISTS idx_outbox_receipts
      ON push_outbox(receipt_status, updated_at_ms);
  `);

  ensureColumn(db, 'sessions', 'revision', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'generation', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'push_outbox', 'device_generation', 'INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    INSERT INTO device_generations (installation_id, generation)
    SELECT installation_id, MAX(generation) FROM devices GROUP BY installation_id
    ON CONFLICT(installation_id) DO UPDATE SET
      generation = MAX(device_generations.generation, excluded.generation);
    INSERT INTO device_generations (installation_id, generation)
    SELECT installation_id, MAX(device_generation) FROM push_outbox GROUP BY installation_id
    ON CONFLICT(installation_id) DO UPDATE SET
      generation = MAX(device_generations.generation, excluded.generation);
    UPDATE devices SET disabled = 1
    WHERE installation_id IN (
      SELECT installation_id FROM (
        SELECT installation_id,
               ROW_NUMBER() OVER (
                 PARTITION BY expo_push_token
                 ORDER BY created_at_ms, installation_id
               ) AS token_rank
        FROM devices
        WHERE disabled = 0
      ) WHERE token_rank > 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_active_token
      ON devices(expo_push_token) WHERE disabled = 0;
  `);
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  declaration: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

/**
 * Runs fn inside a single SQLite transaction. Any throw rolls back and rethrows.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* connection already rolled back / closed */
    }
    throw err;
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
