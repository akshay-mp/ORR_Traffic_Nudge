import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  CommuteAlert,
  DepartureOption,
  DirectionSchedule,
  MonitoringSession,
} from '../types/commute';
import {
  getNowIstParts,
  hhmmToMinutes,
  isoToIstWithSec,
  resolveEffectiveSchedule,
  evaluateMonitoringUpdate,
} from '../lib/commuteEngine';
import { PilotUserSeed } from '../lib/pilotSeed';
import { insertAlertRows, PersistentStore } from './store';
import { withTransaction } from './db';
import {
  enqueueAlertsForPushInTransaction,
  pollReceipts,
  processOutbox,
  PushTransport,
} from './push';

/** Default tick cadence. A process must be running for jobs to execute. */
export const TICK_INTERVAL_MS = 60 * 1000;
/** Upper bound on sessions processed per tick (fair, bounded batches). */
export const MAX_SESSIONS_PER_TICK = 5;
/** Exponential backoff for provider failures: 1m, 2m, 4m, ... capped at 30m. */
export function providerBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}
/** Lease duration; a crashed/stalled worker's lease can be reclaimed after this. */
export const LEASE_DURATION_MS = 5 * 60 * 1000;
export const PROVIDER_COMPUTE_TIMEOUT_MS = 10_000;

export interface ComputeOptionsResult {
  options: DepartureOption[];
  effectiveSchedule: DirectionSchedule & { skippedToday: boolean };
  unsupportedReason?: string;
  quotaExceeded?: boolean;
  providerError?: string;
}

export interface SchedulerDeps {
  db: DatabaseSync;
  store: PersistentStore;
  computeOptions(params: {
    user: PilotUserSeed;
    direction: MonitoringSession['direction'];
    environment: MonitoringSession['dataEnvironment'];
    signal?: AbortSignal;
  }): Promise<ComputeOptionsResult>;
  transport: PushTransport;
}

interface SessionRow {
  id: string;
  user_id: string;
  status: string;
  attempt_count: number;
  revision: number;
  data: string;
}

export interface TickSummary {
  skippedOverlap: boolean;
  expired: number;
  scheduledActivated: number;
  scheduledSkipped: number;
  claimed: number;
  refreshed: number;
  providerFailures: number;
  discardedStaleWrites: number;
  push: Awaited<ReturnType<typeof processOutbox>>;
  receipts: Awaited<ReturnType<typeof pollReceipts>>;
}

const TERMINAL_STATUSES = ['LEFT', 'SKIPPED', 'STOPPED', 'EXPIRED'];

function sessionFromRow(row: SessionRow): MonitoringSession {
  return JSON.parse(row.data) as MonitoringSession;
}

function isoToMsOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Durable in-process scheduler. All state lives in SQLite and survives
 * restarts; due work is claimed atomically via leases so concurrent ticks or
 * processes cannot double-process, and stale in-flight writes are discarded
 * when a session reached a terminal state (never resurrecting stopped,
 * skipped, or left sessions). Honest limitation: ticks only run while this
 * process is alive.
 */
export class Scheduler {
  readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTickAtMs: number | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.workerId = `wrk_${randomBytes(6).toString('hex')}`;
  }

  start(intervalMs: number = TICK_INTERVAL_MS): void {
    this.stop();
    const timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error('[scheduler] tick failed:', err);
      });
    }, intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isLoopActive(): boolean {
    return this.timer !== null;
  }

  getLastTickAtMs(): number | null {
    return this.lastTickAtMs;
  }

  async tick(nowMs: number = Date.now()): Promise<TickSummary> {
    const summary: TickSummary = {
      skippedOverlap: false,
      expired: 0,
      scheduledActivated: 0,
      scheduledSkipped: 0,
      claimed: 0,
      refreshed: 0,
      providerFailures: 0,
      discardedStaleWrites: 0,
      push: {
        transportEnabled: false,
        claimed: 0,
        attempted: 0,
        sent: 0,
        failed: 0,
        retryScheduled: 0,
        skipped: 0,
      },
      receipts: {
        polled: 0,
        ok: 0,
        errored: 0,
        stillPending: 0,
        devicesDisabled: 0,
        transportEnabled: false,
      },
    };

    if (this.running) {
      summary.skippedOverlap = true;
      return summary;
    }
    this.running = true;
    try {
      this.lastTickAtMs = nowMs;
      summary.expired = this.expireSessions(nowMs);
      const activation = this.activateScheduledSessions(nowMs);
      summary.scheduledActivated = activation.activated;
      summary.scheduledSkipped = activation.skipped;
      const processing = await this.claimAndProcess(nowMs);
      summary.claimed = processing.claimed;
      summary.refreshed = processing.refreshed;
      summary.providerFailures = processing.providerFailures;
      summary.discardedStaleWrites = processing.discardedStaleWrites;

      summary.expired += this.expireSessions(Date.now());

      summary.push = await processOutbox(
        this.deps.db,
        this.deps.transport,
        {
          workerId: this.workerId,
          getUsers: () => this.deps.store.users,
          getSessionStatus: (sessionId) =>
            this.deps.store.sessions.find((s) => s.id === sessionId)?.status ??
            this.readSessionStatus(sessionId),
        },
        nowMs
      );
      summary.receipts = await pollReceipts(this.deps.db, this.deps.transport, nowMs);
      return summary;
    } finally {
      this.running = false;
    }
  }

  private readSessionStatus(sessionId: string): string | null {
    const row = this.deps.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string } | undefined;
    return row ? row.status : null;
  }

  private syncMemorySession(session: MonitoringSession): void {
    const idx = this.deps.store.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      this.deps.store.sessions[idx] = session;
    } else {
      this.deps.store.sessions.push(session);
    }
  }

  private enqueueAlertsInTransaction(alerts: CommuteAlert[]): void {
    if (alerts.length === 0) return;
    enqueueAlertsForPushInTransaction(this.deps.db, alerts, {
      getUsers: () => this.deps.store.users,
      getSessionDirection: (sessionId) => {
        const row = this.deps.db
          .prepare('SELECT data FROM sessions WHERE id = ?')
          .get(sessionId) as { data: string } | undefined;
        return row
          ? (JSON.parse(row.data) as MonitoringSession).direction
          : null;
      },
    });
  }

  private syncAlerts(alerts: CommuteAlert[]): void {
    if (alerts.length === 0) return;
    for (const alert of [...alerts].reverse()) {
      this.deps.store.alerts.unshift(alert);
    }
  }

  /**
   * Transitions non-terminal sessions whose window ended (or whose date
   * rolled over to a new Asia/Kolkata day) to EXPIRED with a
   * terminal-state-guarded write.
   */
  private expireSessions(nowMs: number): number {
    const { dateIst } = getNowIstParts(new Date(nowMs));
    const rows = this.deps.db
      .prepare(
        `SELECT id, data, revision FROM sessions
         WHERE status IN ('ACTIVE','SNOOZED','SCHEDULED') AND date_ist <= ?`
      )
      .all(dateIst) as { id: string; data: string; revision: number }[];

    let expired = 0;
    const nowIso = new Date(nowMs).toISOString();
    for (const row of rows) {
      const session = JSON.parse(row.data) as MonitoringSession;
      const expiresMs = new Date(session.expiresAtIso).getTime();
      const staleDate = session.dateIst < dateIst;
      if (!staleDate && !(nowMs > expiresMs)) continue;

      const user = this.deps.store.users.find((u) => u.id === session.userId);
      const effSchedule = user
        ? resolveEffectiveSchedule(
            user.schedules[session.direction],
            user.dayOverrides,
            session.dateIst
          )
        : null;
      const windowNote = effSchedule
        ? `your ${effSchedule.windowStart}–${effSchedule.windowEnd} departure window`
        : 'your departure window';
      const updated: MonitoringSession = {
        ...session,
        status: 'EXPIRED',
        nextRefreshDueIso: null,
      };
      const alert: CommuteAlert = {
        id: `alert_exp_${session.id}_${nowMs}`,
        userId: session.userId,
        sessionId: session.id,
        createdAtIso: nowIso,
        createdAtIst: isoToIstWithSec(nowIso),
        type: 'SESSION_EXPIRED',
        severity: 'INFO',
        title: 'Commute Window Ended',
        message: `Monitoring expired at the end of ${windowNote}.`,
        deliveredChannels: ['IN_APP'],
        acknowledged: false,
      };

      const changes = withTransaction(this.deps.db, () => {
        const res = this.deps.db
          .prepare(
            `UPDATE sessions
             SET data = ?, status = 'EXPIRED', next_refresh_due_ms = NULL,
                 lease_owner = NULL, lease_until_ms = NULL,
                 updated_at_ms = ?, revision = revision + 1
             WHERE id = ? AND status = ? AND revision = ?`
          )
          .run(JSON.stringify(updated), nowMs, session.id, session.status, row.revision);
        if (res.changes === 1) {
          insertAlertRows(this.deps.db, [alert]);
          this.enqueueAlertsInTransaction([alert]);
        }
        return res.changes;
      });

      if (changes === 1) {
        expired += 1;
        this.syncMemorySession(updated);
        this.syncAlerts([alert]);
      }
    }
    return expired;
  }

  /**
   * Activates SCHEDULED sessions once the lead-time window arrives (Asia/Kolkata
   * dates), or marks them SKIPPED when the effective schedule is disabled, the
   * weekday is not selected, or the day was skipped.
   */
  private activateScheduledSessions(
    nowMs: number
  ): { activated: number; skipped: number } {
    const parts = getNowIstParts(new Date(nowMs));
    const rows = this.deps.db
      .prepare(
        `SELECT id, data, revision FROM sessions WHERE status = 'SCHEDULED' AND date_ist = ?`
      )
      .all(parts.dateIst) as { id: string; data: string; revision: number }[];

    let activated = 0;
    let skipped = 0;
    const nowIso = new Date(nowMs).toISOString();
    for (const row of rows) {
      const session = JSON.parse(row.data) as MonitoringSession;
      const user = this.deps.store.users.find((u) => u.id === session.userId);
      if (!user) continue;
      const eff = resolveEffectiveSchedule(
        user.schedules[session.direction],
        user.dayOverrides,
        parts.dateIst
      );

      if (!eff.enabled || !eff.days.includes(parts.dayOfWeek) || eff.skippedToday) {
        const updated: MonitoringSession = {
          ...session,
          status: 'SKIPPED',
          nextRefreshDueIso: null,
        };
        const res = this.deps.db
          .prepare(
            `UPDATE sessions
             SET data = ?, status = 'SKIPPED', next_refresh_due_ms = NULL,
                 lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ?,
                 revision = revision + 1
             WHERE id = ? AND status = 'SCHEDULED' AND revision = ?`
          )
          .run(JSON.stringify(updated), nowMs, session.id, row.revision);
        if (res.changes === 1) {
          skipped += 1;
          this.syncMemorySession(updated);
        }
        continue;
      }

      const startLeadMin =
        hhmmToMinutes(eff.preferredDeparture) - eff.leadTimeMinutes;
      if (parts.minutesFromMidnight >= startLeadMin) {
        const updated: MonitoringSession = {
          ...session,
          status: 'ACTIVE',
          nextRefreshDueIso: nowIso,
        };
        const res = this.deps.db
          .prepare(
            `UPDATE sessions
             SET data = ?, status = 'ACTIVE', next_refresh_due_ms = ?,
                 updated_at_ms = ?, revision = revision + 1
             WHERE id = ? AND status = 'SCHEDULED' AND revision = ?`
          )
          .run(JSON.stringify(updated), nowMs, nowMs, session.id, row.revision);
        if (res.changes === 1) {
          activated += 1;
          this.syncMemorySession(updated);
        }
      }
    }
    return { activated, skipped };
  }

  private async claimAndProcess(nowMs: number): Promise<{
    claimed: number;
    refreshed: number;
    providerFailures: number;
    discardedStaleWrites: number;
  }> {
    const { dateIst, dayOfWeek } = getNowIstParts(new Date(nowMs));
    const leaseUntil = nowMs + LEASE_DURATION_MS;

    const claimed = this.deps.db
      .prepare(
        `UPDATE sessions
         SET lease_owner = ?, lease_until_ms = ?, updated_at_ms = ?
         WHERE id IN (
           SELECT id FROM sessions
           WHERE date_ist = ?
             AND status IN ('ACTIVE','SNOOZED')
             AND next_refresh_due_ms IS NOT NULL AND next_refresh_due_ms <= ?
             AND (lease_until_ms IS NULL OR lease_until_ms < ?)
             AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
           ORDER BY next_refresh_due_ms
           LIMIT ?
         )
         AND status IN ('ACTIVE','SNOOZED')
         RETURNING id, user_id, status, attempt_count, revision, data`
      )
      .all(
        this.workerId,
        leaseUntil,
        nowMs,
        dateIst,
        nowMs,
        nowMs,
        nowMs,
        MAX_SESSIONS_PER_TICK
      ) as unknown as SessionRow[];

    const result = {
      claimed: claimed.length,
      refreshed: 0,
      providerFailures: 0,
      discardedStaleWrites: 0,
    };

    for (const row of claimed) {
      const session = sessionFromRow(row);
      const userRow = this.deps.db
        .prepare('SELECT data FROM users WHERE id = ?')
        .get(session.userId) as { data: string } | undefined;
      const user = userRow ? (JSON.parse(userRow.data) as PilotUserSeed) : undefined;
      if (!user) {
        this.releaseLease(row.id);
        continue;
      }
      const memoryUserIndex = this.deps.store.users.findIndex((u) => u.id === user.id);
      if (memoryUserIndex >= 0) this.deps.store.users[memoryUserIndex] = user;

      const effSchedule = resolveEffectiveSchedule(
        user.schedules[session.direction],
        user.dayOverrides,
        session.dateIst
      );

      // Honor disabled schedules, unselected weekdays, and skipped days even
      // for an already-ACTIVE session (terminal transition, never resurrected).
      if (
        !effSchedule.enabled ||
        !effSchedule.days.includes(dayOfWeek) ||
        effSchedule.skippedToday
      ) {
        const updated: MonitoringSession = {
          ...session,
          status: 'SKIPPED',
          nextRefreshDueIso: null,
        };
        const res = this.deps.db
          .prepare(
            `UPDATE sessions
             SET data = ?, status = 'SKIPPED', next_refresh_due_ms = NULL,
                 lease_owner = NULL, lease_until_ms = NULL,
                 attempt_count = 0, next_attempt_at_ms = NULL, updated_at_ms = ?,
                 revision = revision + 1
             WHERE id = ? AND lease_owner = ? AND status IN ('ACTIVE','SNOOZED')
               AND revision = ?`
          )
          .run(JSON.stringify(updated), nowMs, row.id, this.workerId, row.revision);
        if (res.changes === 1) this.syncMemorySession(updated);
        continue;
      }

      const providerController = new AbortController();
      let providerTimer: ReturnType<typeof setTimeout> | undefined;
      const compute = await Promise.race([
        this.deps.computeOptions({
          user,
          direction: session.direction,
          environment: session.dataEnvironment,
          signal: providerController.signal,
        }),
        new Promise<ComputeOptionsResult>((_, reject) => {
          providerTimer = setTimeout(() => {
            providerController.abort();
            reject(new Error(`Provider computation exceeded ${PROVIDER_COMPUTE_TIMEOUT_MS}ms`));
          }, PROVIDER_COMPUTE_TIMEOUT_MS);
        }),
      ])
        .catch((error: unknown): ComputeOptionsResult => ({
          options: [],
          effectiveSchedule: effSchedule,
          providerError: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          if (providerTimer) clearTimeout(providerTimer);
        });

      if (Date.now() >= new Date(session.expiresAtIso).getTime()) {
        this.releaseLease(row.id, this.workerId);
        continue;
      }

      if (compute.quotaExceeded || compute.providerError) {
        result.providerFailures += 1;
        const attempts = row.attempt_count + 1;
        const failedUpdate = this.deps.db
          .prepare(
            `UPDATE sessions
             SET attempt_count = ?, next_attempt_at_ms = ?, last_provider_error = ?,
                 lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ?,
                 revision = revision + 1
             WHERE id = ? AND lease_owner = ? AND status IN ('ACTIVE','SNOOZED')
               AND revision = ?`
          )
          .run(
            attempts,
            nowMs + providerBackoffMs(attempts),
            compute.providerError ?? 'Quota exceeded',
            nowMs,
            row.id,
            this.workerId,
            row.revision
          );
        if (failedUpdate.changes === 0) {
          this.releaseLease(row.id, this.workerId);
        }
        continue;
      }

      const nowIso = new Date(nowMs).toISOString();
      const outcome = evaluateMonitoringUpdate({
        session,
        schedule: effSchedule,
        newOptions: compute.options,
        nowIso,
      });

      let committed = false;
      try {
        withTransaction(this.deps.db, () => {
          const res = this.deps.db
            .prepare(
              `UPDATE sessions
               SET data = ?, status = ?, next_refresh_due_ms = ?,
                   lease_owner = NULL, lease_until_ms = NULL,
                   attempt_count = 0, next_attempt_at_ms = NULL,
                   last_provider_error = NULL, updated_at_ms = ?,
                   revision = revision + 1
               WHERE id = ? AND lease_owner = ? AND status IN ('ACTIVE','SNOOZED')
                 AND revision = ?`
            )
            .run(
              JSON.stringify(outcome.updatedSession),
              outcome.updatedSession.status,
              isoToMsOrNull(outcome.updatedSession.nextRefreshDueIso),
              nowMs,
              row.id,
              this.workerId,
              row.revision
            );
          if (res.changes === 1) {
            insertAlertRows(this.deps.db, outcome.generatedAlerts);
            this.enqueueAlertsInTransaction(outcome.generatedAlerts);
          } else {
            // Session reached a terminal state (stop/skip/leave) while we were
            // computing: roll back — never resurrect it.
            throw new StaleSessionWrite();
          }
        });
        committed = true;
      } catch (err) {
        if (!(err instanceof StaleSessionWrite)) throw err;
      }

      if (committed) {
        result.refreshed += 1;
        this.syncMemorySession(outcome.updatedSession);
        this.syncAlerts(outcome.generatedAlerts);
      } else {
        result.discardedStaleWrites += 1;
        this.releaseLease(row.id, this.workerId);
      }
    }
    return result;
  }

  private releaseLease(sessionId: string, workerId?: string): void {
    this.deps.db
      .prepare(
        `UPDATE sessions SET lease_owner = NULL, lease_until_ms = NULL
         WHERE id = ? AND (? IS NULL OR lease_owner = ?)`
      )
      .run(sessionId, workerId ?? null, workerId ?? null);
  }
}

class StaleSessionWrite extends Error {
  constructor() {
    super('Session reached a terminal state while processing; write discarded');
    this.name = 'StaleSessionWrite';
  }
}

export { TERMINAL_STATUSES };
