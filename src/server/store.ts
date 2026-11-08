import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import {
  getNowIstParts,
} from '../lib/commuteEngine';
import {
  INITIAL_DEMO_JOURNEYS,
  INITIAL_PILOT_EMPLOYEES,
  PilotUserSeed,
} from '../lib/pilotSeed';
import {
  ApiQuotaStatus,
  CommuteAlert,
  JourneyRecord,
  MonitoringSession,
} from '../types/commute';
import { getMeta, setMeta, withTransaction } from './db';
import { SEEDED_TOKEN_RE, sha256Hex } from './auth';

export interface PersistentStore {
  users: PilotUserSeed[];
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  quota: ApiQuotaStatus;
}

export const LEGACY_JSON_STORE_FILENAME = 'orr_pulse_store.json';

export interface StoreOptions {
  defaultQuotaLimit: number;
  liveApiConfigured: boolean;
}

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CORRUPT_JSON_STORE'
      | 'PERSIST_FAILED'
      | 'MIGRATION_FAILED',
    public readonly causeError?: unknown
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Loads the working set from SQLite, seeding a fresh database or importing the
 * legacy JSON store exactly once. A present-but-corrupt JSON file or database
 * fails loudly (throws) and is never silently re-seeded.
 */
export function createStore(
  db: DatabaseSync,
  dataDir: string,
  opts: StoreOptions
): {
  store: PersistentStore;
  migrationNote: string | null;
} {
  const legacyJsonPath = path.join(dataDir, LEGACY_JSON_STORE_FILENAME);
  const alreadyMigrated = getMeta(db, 'migrated_from') !== null;
  let migrationNote: string | null = null;

  if (!alreadyMigrated && fs.existsSync(legacyJsonPath)) {
    migrationNote = importLegacyJsonStore(db, legacyJsonPath, opts);
  }

  const userCount = (
    db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  ).c;

  let store: PersistentStore;
  if (userCount === 0) {
    store = buildSeedStore(opts);
    persistStore(db, store);
  } else {
    store = loadStore(db, opts);
  }
  return { store, migrationNote };
}

function buildSeedStore(opts: StoreOptions): PersistentStore {
  const { dateIst } = getNowIstParts();
  return {
    users: structuredClone(INITIAL_PILOT_EMPLOYEES),
    sessions: [],
    alerts: [],
    journeys: structuredClone(INITIAL_DEMO_JOURNEYS),
    quota: {
      dateIst,
      dailyLimit: opts.defaultQuotaLimit,
      requestsUsedToday: 0,
      routesRequests: 0,
      placesRequests: 0,
      geocodingRequests: 0,
      lastProviderStatus: opts.liveApiConfigured ? 'OK' : 'UNCONFIGURED',
      lastErrorMessage: null,
      liveApiConfigured: opts.liveApiConfigured,
    },
  };
}

function loadStore(db: DatabaseSync, opts: StoreOptions): PersistentStore {
  const users = (
    db.prepare('SELECT data FROM users ORDER BY id').all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as PilotUserSeed);

  const sessions = (
    db.prepare('SELECT data FROM sessions ORDER BY id').all() as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data) as MonitoringSession);

  const alerts = (
    db
      .prepare('SELECT data FROM alerts ORDER BY created_at_ms DESC, id DESC')
      .all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as CommuteAlert);

  const journeys = (
    db
      .prepare('SELECT data FROM journeys ORDER BY departure_ms DESC, id DESC')
      .all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as JourneyRecord);

  const quota = loadOrInitQuota(db, opts);
  return { users, sessions, alerts, journeys, quota };
}

function loadOrInitQuota(
  db: DatabaseSync,
  opts: StoreOptions
): ApiQuotaStatus {
  const { dateIst } = getNowIstParts();
  const row = db
    .prepare('SELECT data FROM quota WHERE date_ist = ?')
    .get(dateIst) as { data: string } | undefined;

  let quota: ApiQuotaStatus;
  if (row) {
    quota = JSON.parse(row.data) as ApiQuotaStatus;
    if (quota.dateIst !== dateIst) {
      quota.requestsUsedToday = 0;
      quota.routesRequests = 0;
      quota.placesRequests = 0;
      quota.geocodingRequests = 0;
    }
  } else {
    quota = {
      dateIst,
      dailyLimit: opts.defaultQuotaLimit,
      requestsUsedToday: 0,
      routesRequests: 0,
      placesRequests: 0,
      geocodingRequests: 0,
      lastProviderStatus: opts.liveApiConfigured ? 'OK' : 'UNCONFIGURED',
      lastErrorMessage: null,
      liveApiConfigured: opts.liveApiConfigured,
    };
  }
  quota.dateIst = dateIst;
  quota.liveApiConfigured = opts.liveApiConfigured;
  db.prepare(
    `INSERT INTO quota (date_ist, data) VALUES (?, ?)
     ON CONFLICT(date_ist) DO UPDATE SET data = excluded.data`
  ).run(dateIst, JSON.stringify(quota));
  return quota;
}

/**
 * Atomic full-state persist. Everything in the working set is written in one
 * transaction; on any failure nothing is committed and the error is rethrown
 * so API routes can fail loudly instead of acknowledging lost writes.
 *
 * Durable terminal records are read and parsed INSIDE that transaction, so a
 * reconciliation failure rolls the whole persist back instead of surfacing
 * after the user/profile writes already committed. The prepared
 * reconciliation is applied to memory only after the transaction commits.
 *
 * Session lease/scheduler columns are deliberately preserved on conflict so a
 * concurrent API save cannot clobber an in-flight scheduler lease or
 * resurrect a terminal session from a stale working set.
 */
export function persistStore(
  db: DatabaseSync,
  store: PersistentStore,
  persistRelatedRows?: () => void,
  beforePersist?: () => void
): void {
  const nowMs = Date.now();
  try {
    const terminalSessions = withTransaction(db, () => {
      beforePersist?.();
      const upsertUser = db.prepare(
        `INSERT INTO users (id, employee_code, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           employee_code = excluded.employee_code,
           data = excluded.data`
      );
      for (const u of store.users) {
        upsertUser.run(u.id, u.employeeCode, JSON.stringify(u));
      }

      const upsertSession = db.prepare(
        `INSERT INTO sessions
           (id, user_id, date_ist, status, next_refresh_due_ms, data, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_id = excluded.user_id,
           date_ist = excluded.date_ist,
           status = excluded.status,
           next_refresh_due_ms = excluded.next_refresh_due_ms,
           data = excluded.data,
           updated_at_ms = excluded.updated_at_ms,
           revision = sessions.revision + 1
         WHERE sessions.status NOT IN ('LEFT','SKIPPED','STOPPED','EXPIRED')`
      );
      for (const s of store.sessions) {
        upsertSession.run(
          s.id,
          s.userId,
          s.dateIst,
          s.status,
          isoToMs(s.nextRefreshDueIso),
          JSON.stringify(s),
          nowMs
        );
      }

      const upsertAlert = db.prepare(
        `INSERT INTO alerts (id, user_id, session_id, created_at_ms, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const a of store.alerts) {
        upsertAlert.run(
          a.id,
          a.userId,
          a.sessionId,
          new Date(a.createdAtIso).getTime() || nowMs,
          JSON.stringify(a)
        );
      }

      const upsertJourney = db.prepare(
        `INSERT INTO journeys (id, user_id, departure_ms, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const j of store.journeys) {
        upsertJourney.run(
          j.id,
          j.userId,
          new Date(j.actualDepartureIso).getTime() || nowMs,
          JSON.stringify(j)
        );
      }

      db.prepare(
        `INSERT INTO quota (date_ist, data) VALUES (?, ?)
         ON CONFLICT(date_ist) DO UPDATE SET data = excluded.data`
      ).run(store.quota.dateIst, JSON.stringify(store.quota));

      persistRelatedRows?.();

      return loadDurableTerminalSessions(db);
    });
    applyTerminalReconciliation(store, terminalSessions);
  } catch (err) {
    throw new StoreError(
      `Failed to persist store transactionally: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'PERSIST_FAILED',
      err
    );
  }
}

/** Reads and parses durable terminal session records (inside the persist transaction). */
function loadDurableTerminalSessions(db: DatabaseSync): MonitoringSession[] {
  return (
    db
      .prepare(
        `SELECT data FROM sessions
         WHERE status IN ('LEFT','SKIPPED','STOPPED','EXPIRED')`
      )
      .all() as { data: string }[]
  ).map((row) => JSON.parse(row.data) as MonitoringSession);
}

/**
 * Replaces working-set copies of durable terminal sessions with the committed
 * records and appends terminal sessions missing from the working set. Runs
 * only after a successful commit, so memory never adopts reconciliation data
 * from a rolled-back write.
 */
function applyTerminalReconciliation(
  store: PersistentStore,
  terminalSessions: MonitoringSession[]
): void {
  const terminalById = new Map(
    terminalSessions.map((session) => [session.id, session])
  );
  const includedIds = new Set<string>();

  store.sessions = store.sessions.map((session) => {
    const durableSession = terminalById.get(session.id);
    if (!durableSession) return session;
    includedIds.add(session.id);
    return durableSession;
  });
  for (const session of terminalSessions) {
    if (!includedIds.has(session.id)) store.sessions.push(session);
  }
}

export function persistQuota(db: DatabaseSync, quota: ApiQuotaStatus): void {
  db.prepare(
    `INSERT INTO quota (date_ist, data) VALUES (?, ?)
     ON CONFLICT(date_ist) DO UPDATE SET data = excluded.data`
  ).run(quota.dateIst, JSON.stringify(quota));
}

/**
 * Mutates the working quota and persists it. On persist failure the quota
 * object is restored in place (and refreshed from the DB when readable) so a
 * rejected write never leaves ghost state behind; the error is rethrown.
 */
export function mutateQuotaPersistSafe(
  db: DatabaseSync,
  store: PersistentStore,
  mutate: (quota: ApiQuotaStatus) => void
): void {
  const before = { ...store.quota };
  mutate(store.quota);
  try {
    persistQuota(db, store.quota);
  } catch (err) {
    Object.assign(store.quota, before);
    try {
      reloadWorkingSet(db, store);
    } catch {
      /* DB unreadable; snapshot restore already applied */
    }
    throw err;
  }
}

/**
 * Re-reads the last committed state from SQLite into the existing working-set
 * object (in place, so shared references stay valid). Used after a failed
 * persistence so memory never reflects a rejected mutation or misses
 * concurrent committed writes.
 */
export function reloadWorkingSet(
  db: DatabaseSync,
  store: PersistentStore
): void {
  store.users = (
    db.prepare('SELECT data FROM users ORDER BY id').all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as PilotUserSeed);

  store.sessions = (
    db.prepare('SELECT data FROM sessions ORDER BY id').all() as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data) as MonitoringSession);

  store.alerts = (
    db
      .prepare('SELECT data FROM alerts ORDER BY created_at_ms DESC, id DESC')
      .all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as CommuteAlert);

  store.journeys = (
    db
      .prepare('SELECT data FROM journeys ORDER BY departure_ms DESC, id DESC')
      .all() as { data: string }[]
  ).map((r) => JSON.parse(r.data) as JourneyRecord);

  const { dateIst } = getNowIstParts();
  const quotaRow = db
    .prepare('SELECT data FROM quota WHERE date_ist = ?')
    .get(dateIst) as { data: string } | undefined;
  if (quotaRow) {
    Object.assign(store.quota, JSON.parse(quotaRow.data) as ApiQuotaStatus);
    store.quota.dateIst = dateIst;
  }
}

export interface StoreSnapshot {
  users: PilotUserSeed[];
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  quota: ApiQuotaStatus;
}

export function snapshotStore(store: PersistentStore): StoreSnapshot {
  return {
    users: structuredClone(store.users),
    sessions: structuredClone(store.sessions),
    alerts: structuredClone(store.alerts),
    journeys: structuredClone(store.journeys),
    quota: { ...store.quota },
  };
}

/** Restores a snapshot into the working-set object in place. */
export function restoreStore(
  store: PersistentStore,
  snapshot: StoreSnapshot
): void {
  store.users = snapshot.users;
  store.sessions = snapshot.sessions;
  store.alerts = snapshot.alerts;
  store.journeys = snapshot.journeys;
  Object.assign(store.quota, snapshot.quota);
}

export function deleteUserJourneysAndAlerts(
  db: DatabaseSync,
  userId: string
): void {
  withTransaction(db, () => {
    db.prepare('DELETE FROM journeys WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM alerts WHERE user_id = ?').run(userId);
  });
}

export function recordNewAlerts(
  db: DatabaseSync,
  alerts: CommuteAlert[]
): void {
  if (alerts.length === 0) return;
  withTransaction(db, () => insertAlertRows(db, alerts));
}

/**
 * Raw alert insert WITHOUT opening a transaction — for use inside an existing
 * transaction (SQLite cannot nest BEGIN).
 */
export function insertAlertRows(db: DatabaseSync, alerts: CommuteAlert[]): void {
  if (alerts.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO alerts (id, user_id, session_id, created_at_ms, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  );
  for (const a of alerts) {
    stmt.run(
      a.id,
      a.userId,
      a.sessionId,
      new Date(a.createdAtIso).getTime() || Date.now(),
      JSON.stringify(a)
    );
  }
}

export type BudgetType = 'ROUTES' | 'PLACES' | 'GEOCODING';

export function checkBudgetAndIncrement(
  db: DatabaseSync,
  store: PersistentStore,
  type: BudgetType
): { allowed: boolean; reason?: string } {
  const { dateIst } = getNowIstParts();
  if (store.quota.dateIst !== dateIst) {
    store.quota.dateIst = dateIst;
    store.quota.requestsUsedToday = 0;
    store.quota.routesRequests = 0;
    store.quota.placesRequests = 0;
    store.quota.geocodingRequests = 0;
  }

  if (store.quota.requestsUsedToday >= store.quota.dailyLimit) {
    const reason = `Pilot daily API budget safeguard reached (${store.quota.dailyLimit} requests/day).`;
    mutateQuotaPersistSafe(db, store, (q) => {
      q.lastProviderStatus = 'QUOTA_EXCEEDED';
      q.lastErrorMessage = reason;
    });
    return { allowed: false, reason };
  }

  mutateQuotaPersistSafe(db, store, (q) => {
    q.requestsUsedToday += 1;
    if (type === 'ROUTES') q.routesRequests += 1;
    if (type === 'PLACES') q.placesRequests += 1;
    if (type === 'GEOCODING') q.geocodingRequests += 1;
  });
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Legacy JSON store migration
// ---------------------------------------------------------------------------

interface LegacyJsonStore {
  users: unknown;
  sessions: unknown;
  alerts: unknown;
  journeys: unknown;
  quota: unknown;
  tokens: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validates and imports the legacy JSON store into SQLite inside one
 * transaction, then renames the original file (preserving it) so the import
 * cannot run twice. Any validation failure throws StoreError with
 * CORRUPT_JSON_STORE and leaves the original file untouched.
 */
function importLegacyJsonStore(
  db: DatabaseSync,
  legacyJsonPath: string,
  opts: StoreOptions
): string {
  let parsed: LegacyJsonStore;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf-8'));
  } catch (err) {
    throw new StoreError(
      `Legacy store ${legacyJsonPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'CORRUPT_JSON_STORE'
    );
  }

  const users = validateLegacyArray(parsed.users, 'users');
  const sessions = validateLegacyArray(parsed.sessions, 'sessions');
  const alerts = validateLegacyArray(parsed.alerts, 'alerts');
  const journeys = validateLegacyArray(parsed.journeys, 'journeys');

  for (const u of users) {
    const rec = u as Record<string, unknown>;
    if (!isNonEmptyString(rec.id)) {
      throw new StoreError('Legacy users entry missing id', 'CORRUPT_JSON_STORE');
    }
    if (!isNonEmptyString(rec.employeeCode)) {
      throw new StoreError(
        `Legacy user ${String(rec.id)} missing employeeCode`,
        'CORRUPT_JSON_STORE'
      );
    }
  }
  for (const s of sessions) {
    const rec = s as Record<string, unknown>;
    if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.userId)) {
      throw new StoreError('Legacy sessions entry missing id/userId', 'CORRUPT_JSON_STORE');
    }
  }
  for (const a of alerts) {
    const rec = a as Record<string, unknown>;
    if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.userId)) {
      throw new StoreError('Legacy alerts entry missing id/userId', 'CORRUPT_JSON_STORE');
    }
  }
  for (const j of journeys) {
    const rec = j as Record<string, unknown>;
    if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.userId)) {
      throw new StoreError('Legacy journeys entry missing id/userId', 'CORRUPT_JSON_STORE');
    }
  }
  if (
    parsed.quota === null ||
    typeof parsed.quota !== 'object' ||
    !isNonEmptyString((parsed.quota as Record<string, unknown>).dateIst)
  ) {
    throw new StoreError(
      'Legacy quota missing or lacks dateIst',
      'CORRUPT_JSON_STORE'
    );
  }
  if (
    parsed.tokens !== null &&
    typeof parsed.tokens !== 'object' &&
    Array.isArray(parsed.tokens)
  ) {
    throw new StoreError('Legacy tokens must be an object', 'CORRUPT_JSON_STORE');
  }

  const nowMs = Date.now();
  try {
    withTransaction(db, () => {
      const upsertUser = db.prepare(
        `INSERT INTO users (id, employee_code, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const u of users) {
        const rec = u as PilotUserSeed;
        upsertUser.run(rec.id, rec.employeeCode, JSON.stringify(rec));
      }

      const upsertSession = db.prepare(
        `INSERT INTO sessions
           (id, user_id, date_ist, status, next_refresh_due_ms, data, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const s of sessions) {
        const rec = s as MonitoringSession;
        upsertSession.run(
          rec.id,
          rec.userId,
          String(rec.dateIst ?? ''),
          String(rec.status ?? 'ACTIVE'),
          isoToMs(rec.nextRefreshDueIso),
          JSON.stringify(rec),
          nowMs
        );
      }

      const upsertAlert = db.prepare(
        `INSERT INTO alerts (id, user_id, session_id, created_at_ms, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const a of alerts) {
        const rec = a as CommuteAlert;
        upsertAlert.run(
          rec.id,
          rec.userId,
          String(rec.sessionId ?? ''),
          new Date(rec.createdAtIso).getTime() || nowMs,
          JSON.stringify(rec)
        );
      }

      const upsertJourney = db.prepare(
        `INSERT INTO journeys (id, user_id, departure_ms, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      );
      for (const j of journeys) {
        const rec = j as JourneyRecord;
        upsertJourney.run(
          rec.id,
          rec.userId,
          new Date(rec.actualDepartureIso).getTime() || nowMs,
          JSON.stringify(rec)
        );
      }

      db.prepare(
        `INSERT INTO quota (date_ist, data) VALUES (?, ?)
         ON CONFLICT(date_ist) DO UPDATE SET data = excluded.data`
      ).run(
        (parsed.quota as ApiQuotaStatus).dateIst,
        JSON.stringify(parsed.quota)
      );

      // Preserve previously issued session tokens (hashed) so logins survive
      // migration. Seeded pilot tokens are derived from users and skipped.
      const upsertToken = db.prepare(
        `INSERT INTO auth_tokens (token_hash, user_id, token_hint, created_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO NOTHING`
      );
      const tokens =
        parsed.tokens && typeof parsed.tokens === 'object'
          ? Object.entries(parsed.tokens as Record<string, string>)
          : [];
      for (const [token, userId] of tokens) {
        if (
          !isNonEmptyString(token) ||
          !isNonEmptyString(userId) ||
          token.length > 200 ||
          SEEDED_TOKEN_RE.test(token)
        ) {
          continue;
        }
        upsertToken.run(
          sha256Hex(token),
          userId,
          token.slice(0, 10),
          nowMs
        );
      }

      setMeta(db, 'migrated_from', legacyJsonPath);
    });
  } catch (err) {
    throw new StoreError(
      `Legacy JSON store import failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'MIGRATION_FAILED'
    );
  }

  const preservedName = `${LEGACY_JSON_STORE_FILENAME}.migrated-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}`;
  const preservedPath = path.join(
    path.dirname(legacyJsonPath),
    preservedName
  );
  try {
    fs.copyFileSync(legacyJsonPath, preservedPath);
    fs.unlinkSync(legacyJsonPath);
  } catch (err) {
    throw new StoreError(
      `Import succeeded but preserving the original JSON file failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'MIGRATION_FAILED'
    );
  }

  return `Migrated legacy JSON store ${legacyJsonPath} into SQLite; original preserved at ${preservedPath}`;
}

function validateLegacyArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new StoreError(
      `Legacy store field "${field}" is missing or not an array`,
      'CORRUPT_JSON_STORE'
    );
  }
  return v;
}
