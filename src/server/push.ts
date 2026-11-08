import { DatabaseSync } from 'node:sqlite';

import { CommuteAlert } from '../types/commute';
import { PilotUserSeed } from '../lib/pilotSeed';
import { withTransaction } from './db';

// ---------------------------------------------------------------------------
// Transport abstraction (mock in tests; real adapter gated by env)
// ---------------------------------------------------------------------------

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: string;
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; detailsError?: string };

export interface ExpoSendOutcome {
  httpOk: boolean;
  retryable: boolean;
  /** Tickets per message when HTTP 200; null on request-level failure. */
  tickets: ExpoTicket[] | null;
  errorMessage?: string;
}

export interface ExpoReceipt {
  status: 'ok' | 'error';
  message?: string;
  detailsError?: string;
}

export interface ExpoReceiptsOutcome {
  httpOk: boolean;
  retryable: boolean;
  /** Map of ticket id -> receipt when HTTP 200; null on request-level failure. */
  receipts: Record<string, ExpoReceipt> | null;
  errorMessage?: string;
}

export interface PushTransport {
  readonly enabled: boolean;
  send(messages: ExpoPushMessage[]): Promise<ExpoSendOutcome>;
  getReceipts(ids: string[]): Promise<ExpoReceiptsOutcome>;
}

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Bounded request timeout so one stuck fetch can never stall scheduler ticks. */
export const EXPO_REQUEST_TIMEOUT_MS = 10_000;

// Real Expo wire shapes (docs.expo.dev/push-notifications/sending-notifications):
// tickets/receipts nest the machine-readable error under `details.error`.
interface RawExpoTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface RawExpoReceipt {
  status?: string;
  message?: string;
  details?: { error?: string };
}

function mapRawTicket(raw: RawExpoTicket): ExpoTicket {
  if (raw.status === 'ok') {
    return { status: 'ok', id: String(raw.id ?? '') };
  }
  return {
    status: 'error',
    message: raw.message ?? 'Expo ticket error',
    detailsError: raw.details?.error,
  };
}

function mapRawReceipt(raw: RawExpoReceipt): ExpoReceipt {
  if (raw.status === 'ok') return { status: 'ok' };
  return {
    status: 'error',
    message: raw.message ?? 'receipt error',
    detailsError: raw.details?.error,
  };
}

/**
 * Real Expo Push Service HTTP/2 adapter. Network dispatch only happens for a
 * transport created with enabled=true, which requires ENABLE_NATIVE_PUSH=true
 * at boot. EXPO_ACCESS_TOKEN is optional (used when Expo push security is on).
 * Responses are mapped from the raw wire shape (`details.error`) into the
 * internal DTO; every request is bounded by an AbortSignal timeout.
 */
export function createExpoHttpTransport(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch
): PushTransport {
  const enabled = env.ENABLE_NATIVE_PUSH === 'true';
  const accessToken = (env.EXPO_ACCESS_TOKEN || '').trim();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (enabled && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const notEnabled = (): ExpoSendOutcome & ExpoReceiptsOutcome => ({
    httpOk: false,
    retryable: false,
    tickets: null,
    receipts: null,
    errorMessage: 'Native push transport is disabled (ENABLE_NATIVE_PUSH !== true).',
  });

  return {
    enabled,
    async send(messages) {
      if (!enabled) return notEnabled();
      try {
        const resp = await fetchImpl(EXPO_SEND_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(EXPO_REQUEST_TIMEOUT_MS),
        });
        if (resp.status === 200) {
          const payload = (await resp.json()) as { data?: RawExpoTicket[] };
          return {
            httpOk: true,
            retryable: false,
            tickets: (payload.data ?? []).map(mapRawTicket),
          };
        }
        return {
          httpOk: false,
          retryable: resp.status === 429 || resp.status >= 500,
          tickets: null,
          errorMessage: `Expo push send failed with HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          httpOk: false,
          retryable: true,
          tickets: null,
          errorMessage: `Network error calling Expo push: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
    async getReceipts(ids) {
      if (!enabled) return notEnabled();
      if (ids.length === 0) {
        return { httpOk: true, retryable: false, receipts: {} };
      }
      try {
        const resp = await fetchImpl(EXPO_RECEIPTS_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(EXPO_REQUEST_TIMEOUT_MS),
        });
        if (resp.status === 200) {
          const payload = (await resp.json()) as {
            data?: Record<string, RawExpoReceipt>;
          };
          const receipts: Record<string, ExpoReceipt> = {};
          for (const [id, raw] of Object.entries(payload.data ?? {})) {
            receipts[id] = mapRawReceipt(raw);
          }
          return { httpOk: true, retryable: false, receipts };
        }
        return {
          httpOk: false,
          retryable: resp.status === 429 || resp.status >= 500,
          receipts: null,
          errorMessage: `Expo receipts failed with HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          httpOk: false,
          retryable: true,
          receipts: null,
          errorMessage: `Network error fetching Expo receipts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Accepts both legacy `ExponentPushToken[...]` and newer `ExpoPushToken[...]` forms. */
export const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{16,64}\]$/;
export const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
export const MAX_DEVICES_PER_USER = 10;

export type DeviceValidationError =
  | { field: string; code: string; message: string };

export function validateDeviceRegistration(body: {
  expoPushToken?: unknown;
  platform?: unknown;
  installationId?: unknown;
}): DeviceValidationError | null {
  const { expoPushToken, platform, installationId } = body || {};
  if (
    typeof expoPushToken !== 'string' ||
    !EXPO_TOKEN_RE.test(expoPushToken)
  ) {
    return {
      field: 'expoPushToken',
      code: 'INVALID_EXPO_PUSH_TOKEN',
      message:
        'expoPushToken must match ExpoPushToken[...] or ExponentPushToken[...] with 16-64 inner characters.',
    };
  }
  if (platform !== 'ios' && platform !== 'android') {
    return {
      field: 'platform',
      code: 'INVALID_PLATFORM',
      message: "platform must be 'ios' or 'android'.",
    };
  }
  if (
    typeof installationId !== 'string' ||
    !INSTALLATION_ID_RE.test(installationId)
  ) {
    return {
      field: 'installationId',
      code: 'INVALID_INSTALLATION_ID',
      message:
        "installationId must be 8-64 characters of letters, digits, '.', '_' or '-', starting alphanumeric.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device registration (per-user scoped; tokens never returned)
// ---------------------------------------------------------------------------

export interface SanitizedDevice {
  installationId: string;
  platform: 'ios' | 'android';
  disabled: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

interface DeviceRow {
  installation_id: string;
  user_id: string;
  expo_push_token: string;
  platform: string;
  disabled: number;
  created_at_ms: number;
  updated_at_ms: number;
  generation: number;
}

export type RegisterDeviceResult =
  | { ok: true; device: SanitizedDevice }
  | { ok: false; status: number; code: string; message: string };

export function registerDevice(
  db: DatabaseSync,
  params: {
    userId: string;
    expoPushToken: string;
    platform: 'ios' | 'android';
    installationId: string;
  },
  nowMs: number = Date.now()
): RegisterDeviceResult {
  const existingById = db
    .prepare('SELECT * FROM devices WHERE installation_id = ?')
    .get(params.installationId) as DeviceRow | undefined;

  if (existingById && existingById.user_id !== params.userId) {
    return {
      ok: false,
      status: 409,
      code: 'INSTALLATION_OWNED_BY_OTHER_USER',
      message:
        'This installationId is already registered to another pilot employee.',
    };
  }

  const tokenOwner = db
    .prepare('SELECT * FROM devices WHERE expo_push_token = ?')
    .get(params.expoPushToken) as DeviceRow | undefined;
  if (tokenOwner && tokenOwner.installation_id !== params.installationId) {
    return {
      ok: false,
      status: 409,
      code: 'TOKEN_BOUND_TO_OTHER_INSTALLATION',
      message:
        'This Expo push token is already registered to another installation.',
    };
  }

  const count = (
    db
      .prepare('SELECT COUNT(*) AS c FROM devices WHERE user_id = ?')
      .get(params.userId) as { c: number }
  ).c;
  if (!existingById && count >= MAX_DEVICES_PER_USER) {
    return {
      ok: false,
      status: 400,
      code: 'TOO_MANY_DEVICES',
      message: `At most ${MAX_DEVICES_PER_USER} registered devices per pilot employee.`,
    };
  }

  const history = db
    .prepare('SELECT generation FROM device_generations WHERE installation_id = ?')
    .get(params.installationId) as { generation: number } | undefined;
  const outboxHistory = db
    .prepare('SELECT MAX(device_generation) AS generation FROM push_outbox WHERE installation_id = ?')
    .get(params.installationId) as { generation: number | null };
  const highWater = Math.max(
    existingById?.generation ?? 0,
    history?.generation ?? 0,
    outboxHistory.generation ?? 0
  );
  const generation = existingById && existingById.disabled === 0 &&
    existingById.expo_push_token === params.expoPushToken
    ? existingById.generation
    : highWater + 1;
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO device_generations (installation_id, generation) VALUES (?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET generation = MAX(generation, excluded.generation)`
    ).run(params.installationId, generation);
    db.prepare(
    `INSERT INTO devices
       (installation_id, user_id, expo_push_token, platform, disabled,
        created_at_ms, updated_at_ms, generation)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       expo_push_token = excluded.expo_push_token,
       platform = excluded.platform,
       disabled = 0,
       updated_at_ms = excluded.updated_at_ms,
       generation = excluded.generation`
    ).run(
    params.installationId,
    params.userId,
    params.expoPushToken,
    params.platform,
    nowMs,
    nowMs,
    generation
    );
  });

  return {
    ok: true,
    device: {
      installationId: params.installationId,
      platform: params.platform,
      disabled: false,
      createdAtIso: new Date(existingById?.created_at_ms ?? nowMs).toISOString(),
      updatedAtIso: new Date(nowMs).toISOString(),
    },
  };
}

export function removeDevice(
  db: DatabaseSync,
  userId: string,
  installationId: string,
  nowMs: number = Date.now()
): boolean {
  const existing = db
    .prepare('SELECT * FROM devices WHERE installation_id = ?')
    .get(installationId) as DeviceRow | undefined;
  if (!existing || existing.user_id !== userId) return false;

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO device_generations (installation_id, generation) VALUES (?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET generation = MAX(generation, excluded.generation)`
    ).run(installationId, existing.generation);
    db.prepare('DELETE FROM devices WHERE installation_id = ?').run(
      installationId
    );
    db.prepare(
      `UPDATE push_outbox SET status = 'SKIPPED', updated_at_ms = ?
       WHERE installation_id = ? AND status = 'PENDING'`
    ).run(nowMs, installationId);
  });
  return true;
}

export function listDevices(
  db: DatabaseSync,
  userId: string
): SanitizedDevice[] {
  const rows = db
    .prepare(
      'SELECT * FROM devices WHERE user_id = ? AND disabled = 0 ORDER BY created_at_ms'
    )
    .all(userId) as unknown as DeviceRow[];
  return rows.map((r) => ({
    installationId: r.installation_id,
    platform: r.platform as 'ios' | 'android',
    disabled: r.disabled === 1,
    createdAtIso: new Date(r.created_at_ms).toISOString(),
    updatedAtIso: new Date(r.updated_at_ms).toISOString(),
  }));
}

export function disableDevice(
  db: DatabaseSync,
  installationId: string,
  generation: number,
  nowMs: number = Date.now()
): void {
  db.prepare(
    'UPDATE devices SET disabled = 1, updated_at_ms = ? WHERE installation_id = ? AND generation = ? AND disabled = 0'
  ).run(nowMs, installationId, generation);
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export const MAX_SEND_ATTEMPTS = 5;
export const SEND_BATCH_SIZE = 10;
export const RECEIPT_BATCH_LIMIT = 50;
/** Durable outbox claim window shared across scheduler processes via SQLite. */
export const OUTBOX_CLAIM_MS = 2 * 60 * 1000;
/** Expo recommends checking receipts ~15 minutes after send; poll later ones sooner but honestly keep PENDING. */
export const RECEIPT_MIN_AGE_MS = 5 * 60 * 1000;

export type CommuteAlertTypeForPush = CommuteAlert['type'];

/** Generic lock-screen copy. Never includes home/work addresses or route detail. */
export function genericPushCopyFor(
  type: CommuteAlertTypeForPush,
  direction: 'HOME_TO_WORK' | 'WORK_TO_HOME'
): { title: string; body: string } {
  const leg = direction === 'HOME_TO_WORK' ? 'morning' : 'evening';
  switch (type) {
    case 'DEPARTURE_REMINDER':
      return {
        title: 'ORR Pulse commute plan ready',
        body: `Your recommended ${leg} departure plan is ready. Open the app for details.`,
      };
    case 'ARRIVAL_DETERIORATION':
      return {
        title: 'ORR Pulse ETA updated',
        body: `Your predicted arrival time for your ${leg} commute changed. Open the app for details.`,
      };
    case 'DEADLINE_THREAT':
      return {
        title: 'ORR Pulse deadline alert',
        body: `Your ${leg} commute may miss your arrival deadline. Open the app for details.`,
      };
    case 'SESSION_EXPIRED':
      return {
        title: 'ORR Pulse window ended',
        body: `Your ${leg} commute monitoring window has ended.`,
      };
    default:
      return {
        title: 'ORR Pulse update',
        body: 'You have a new commute update. Open the app for details.',
      };
  }
}

export interface EnqueueDeps {
  getUsers(): PilotUserSeed[];
  /** Direction of the session an alert belongs to (for generic copy). */
  getSessionDirection(sessionId: string): 'HOME_TO_WORK' | 'WORK_TO_HOME' | null;
}

/**
 * Durably records outbound push work for commute alerts. Only non-SYSTEM_NOTICE
 * alerts for users with pushOptIn who have an active registered device are
 * enqueued. Rows are keyed `${alertId}::${installationId}` so restarts and
 * repeated ticks never duplicate a send.
 */
export function enqueueAlertsForPush(
  db: DatabaseSync,
  alerts: CommuteAlert[],
  deps: EnqueueDeps,
  nowMs: number = Date.now()
): number {
  if (alerts.length === 0) return 0;
  let count = 0;
  withTransaction(db, () => {
    count = enqueueAlertsForPushInTransaction(db, alerts, deps, nowMs);
  });
  return count;
}

export function enqueueAlertsForPushInTransaction(
  db: DatabaseSync,
  alerts: CommuteAlert[],
  deps: EnqueueDeps,
  nowMs: number = Date.now()
): number {
  if (alerts.length === 0) return 0;
  const users = deps.getUsers();
  let enqueued = 0;

  const stmt = db.prepare(
    `INSERT INTO push_outbox
       (id, user_id, installation_id, device_generation, alert_id, kind, payload,
        status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  for (const alert of alerts) {
    if (alert.type === 'SYSTEM_NOTICE') continue;
    const user = users.find((u) => u.id === alert.userId);
    if (!user || !user.pushOptIn) continue;

    const direction = deps.getSessionDirection(alert.sessionId);
    if (!direction) continue;

    const devices = db
      .prepare(
        'SELECT installation_id, generation FROM devices WHERE user_id = ? AND disabled = 0'
      )
      .all(alert.userId) as { installation_id: string; generation: number }[];

    const copy = genericPushCopyFor(alert.type, direction);
    const payload = JSON.stringify({
      to: undefined,
      title: copy.title,
      body: copy.body,
      data: {
        alertId: alert.id,
        sessionId: alert.sessionId,
        type: alert.type,
      },
    });

    for (const device of devices) {
      const res = stmt.run(
        `${alert.id}::${device.installation_id}`,
        alert.userId,
        device.installation_id,
        device.generation,
        alert.id,
        alert.type,
        payload,
        nowMs,
        nowMs,
        nowMs
      );
      if (res.changes > 0) enqueued += 1;
    }
  }
  return enqueued;
}

export interface ProcessOutboxDeps {
  workerId: string;
  getUsers(): PilotUserSeed[];
  /** Latest session status; null when unknown. Stops push for terminal sessions. */
  getSessionStatus(sessionId: string): string | null;
}

export interface OutboxProcessSummary {
  transportEnabled: boolean;
  claimed: number;
  attempted: number;
  sent: number;
  failed: number;
  retryScheduled: number;
  skipped: number;
}

interface OutboxRow {
  id: string;
  user_id: string;
  installation_id: string;
  alert_id: string;
  kind: string;
  payload: string;
  attempts: number;
  device_generation: number;
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

/** Claim a row durably (SQLite-serialized) so two schedulers sharing the database never dispatch the same row twice within a claim window. */
function claimDueOutboxRows(
  db: DatabaseSync,
  workerId: string,
  nowMs: number,
  limit: number
): OutboxRow[] {
  return db
    .prepare(
      `UPDATE push_outbox
       SET claim_owner = ?, claim_until_ms = ?, updated_at_ms = ?
       WHERE id IN (
         SELECT id FROM push_outbox
         WHERE status = 'PENDING'
           AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
           AND (claim_until_ms IS NULL OR claim_until_ms < ?)
         ORDER BY created_at_ms
         LIMIT ?
       )
       RETURNING id, user_id, installation_id, device_generation, alert_id, kind, payload, attempts`
    )
    .all(
      workerId,
      nowMs + OUTBOX_CLAIM_MS,
      nowMs,
      nowMs,
      nowMs,
      limit
    ) as unknown as OutboxRow[];
}

/** All durable outcome writes are owner-guarded; an expired/stolen claim discards the write. */
function guardedUpdate(
  db: DatabaseSync,
  rowId: string,
  workerId: string,
  setSql: string,
  params: Array<string | number | null>
): boolean {
  const res = db
    .prepare(
      `UPDATE push_outbox SET ${setSql}
       WHERE id = ? AND claim_owner = ? AND status = 'PENDING'`
    )
    .run(...params, rowId, workerId);
  return res.changes === 1;
}

/**
 * Sends due PENDING outbox rows in one bounded batch. Rows are claimed
 * durably (SQLite lease) BEFORE any network dispatch, so multiple scheduler
 * processes sharing the database do not duplicate sends within a claim
 * window; a crash mid-send may re-deliver after claim expiry (at-least-once).
 * Rows whose device was deleted/disabled, user opted out, or session reached
 * a terminal state are marked SKIPPED at send time (never sent). Failures
 * back off exponentially up to MAX_SEND_ATTEMPTS, then are marked FAILED. No
 * network call happens when the transport is disabled — rows stay PENDING.
 */
export async function processOutbox(
  db: DatabaseSync,
  transport: PushTransport,
  deps: ProcessOutboxDeps,
  nowMs: number = Date.now()
): Promise<OutboxProcessSummary> {
  const summary: OutboxProcessSummary = {
    transportEnabled: transport.enabled,
    claimed: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    retryScheduled: 0,
    skipped: 0,
  };
  if (!transport.enabled) return summary;

  const rows = claimDueOutboxRows(db, deps.workerId, nowMs, SEND_BATCH_SIZE);
  summary.claimed = rows.length;
  if (rows.length === 0) return summary;

  const users = deps.getUsers();
  const messages: ExpoPushMessage[] = [];
  const sendable: OutboxRow[] = [];

  for (const row of rows) {
    summary.attempted += 1;
    const userRow = db
      .prepare('SELECT data FROM users WHERE id = ?')
      .get(row.user_id) as { data: string } | undefined;
    const user = userRow ? (JSON.parse(userRow.data) as PilotUserSeed) : undefined;
    const userIndex = users.findIndex((candidate) => candidate.id === row.user_id);
    if (user && userIndex >= 0) users[userIndex] = user;
    const payload = JSON.parse(row.payload) as {
      title: string;
      body: string;
      data: Record<string, string>;
    };
    const sessionRow = db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(payload.data.sessionId) as { status: string } | undefined;
    const sessionStatus = sessionRow?.status ?? null;

    const stale =
      !user ||
      !user.pushOptIn ||
      sessionStatus === null ||
      ['LEFT', 'SKIPPED', 'STOPPED', 'EXPIRED'].includes(sessionStatus);

    if (stale) {
      const changed = guardedUpdate(
        db,
        row.id,
        deps.workerId,
        `status = 'SKIPPED', claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
        [nowMs]
      );
      if (changed) summary.skipped += 1;
      continue;
    }

    const device = db
      .prepare(
        'SELECT expo_push_token FROM devices WHERE installation_id = ? AND user_id = ? AND generation = ? AND disabled = 0'
      )
      .get(row.installation_id, row.user_id, row.device_generation) as
      | { expo_push_token: string }
      | undefined;
    if (!device) {
      const changed = guardedUpdate(
        db,
        row.id,
        deps.workerId,
        `status = 'SKIPPED', claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
        [nowMs]
      );
      if (changed) summary.skipped += 1;
      continue;
    }

    sendable.push(row);
    messages.push({
      to: device.expo_push_token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: 'default',
    });
  }

  if (sendable.length === 0) return summary;

  const outcome = await transport.send(messages);

  if (!outcome.httpOk) {
    for (const row of sendable) {
      const attempts = row.attempts + 1;
      if (outcome.retryable && attempts < MAX_SEND_ATTEMPTS) {
        const changed = guardedUpdate(
          db,
          row.id,
          deps.workerId,
          `attempts = ?, next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?`,
          [attempts, nowMs + backoffMs(attempts), outcome.errorMessage ?? 'send failed', nowMs]
        );
        if (changed) summary.retryScheduled += 1;
      } else {
        const changed = guardedUpdate(
          db,
          row.id,
          deps.workerId,
          `status = 'FAILED', attempts = ?, last_error = ?, claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
          [attempts, outcome.errorMessage ?? 'send failed', nowMs]
        );
        if (changed) summary.failed += 1;
      }
    }
    return summary;
  }

  const tickets = outcome.tickets ?? [];
  sendable.forEach((row, i) => {
    const ticket = tickets[i];
    if (ticket && ticket.status === 'ok') {
      // Accepted by Expo — NOT device delivery. Receipt stays PENDING until polled.
      const changed = guardedUpdate(
        db,
        row.id,
        deps.workerId,
        `status = 'SENT', attempts = ?, ticket_id = ?, receipt_status = 'PENDING',
         claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
        [row.attempts + 1, ticket.id, nowMs]
      );
      if (changed) summary.sent += 1;
      return;
    }

    const errTicket = ticket as
      | { status: 'error'; message: string; detailsError?: string }
      | undefined;
    const errorCode = errTicket?.detailsError ?? '';
    const message = errTicket?.message ?? 'Expo ticket error';
    const attempts = row.attempts + 1;

    if (errorCode === 'DeviceNotRegistered') {
      const changed = guardedUpdate(
        db,
        row.id,
        deps.workerId,
        `status = 'FAILED', attempts = ?, last_error = ?, claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
        [attempts, message, nowMs]
      );
      if (changed) {
        summary.failed += 1;
        disableDevice(db, row.installation_id, row.device_generation, nowMs);
      }
      return;
    }

    if (
      (errorCode === 'MessageRateExceeded' || errorCode === 'MessageTooBig') &&
      attempts < MAX_SEND_ATTEMPTS
    ) {
      const changed = guardedUpdate(
        db,
        row.id,
        deps.workerId,
        `attempts = ?, next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?`,
        [attempts, nowMs + backoffMs(attempts), message, nowMs]
      );
      if (changed) summary.retryScheduled += 1;
      return;
    }

    const changed = guardedUpdate(
      db,
      row.id,
      deps.workerId,
      `status = 'FAILED', attempts = ?, last_error = ?, claim_owner = NULL, claim_until_ms = NULL, updated_at_ms = ?`,
      [attempts, message, nowMs]
    );
    if (changed) summary.failed += 1;
  });

  return summary;
}

export interface ReceiptPollSummary {
  polled: number;
  ok: number;
  errored: number;
  stillPending: number;
  devicesDisabled: number;
  transportEnabled: boolean;
}

/**
 * Bounded receipt polling for SENT rows with PENDING receipts older than
 * RECEIPT_MIN_AGE_MS. Receipt 'ok' means FCM/APNs accepted the message —
 * never claimed as delivered to the device. Missing receipts stay PENDING.
 */
export async function pollReceipts(
  db: DatabaseSync,
  transport: PushTransport,
  nowMs: number = Date.now()
): Promise<ReceiptPollSummary> {
  const summary: ReceiptPollSummary = {
    polled: 0,
    ok: 0,
    errored: 0,
    stillPending: 0,
    devicesDisabled: 0,
    transportEnabled: transport.enabled,
  };
  if (!transport.enabled) return summary;

  const rows = db
    .prepare(
      `SELECT id, ticket_id, installation_id, device_generation, updated_at_ms FROM push_outbox
       WHERE status = 'SENT' AND receipt_status = 'PENDING' AND ticket_id IS NOT NULL
         AND updated_at_ms <= ?
       ORDER BY updated_at_ms
       LIMIT ?`
    )
    .all(nowMs - RECEIPT_MIN_AGE_MS, RECEIPT_BATCH_LIMIT) as {
    id: string;
    ticket_id: string;
    installation_id: string;
    device_generation: number;
    updated_at_ms: number;
  }[];
  if (rows.length === 0) return summary;

  summary.polled = rows.length;
  const outcome = await transport.getReceipts(rows.map((r) => r.ticket_id));
  if (!outcome.httpOk || !outcome.receipts) {
    summary.stillPending = rows.length;
    return summary;
  }

  for (const row of rows) {
    const receipt = outcome.receipts[row.ticket_id];
    if (!receipt) {
      summary.stillPending += 1;
      continue;
    }
    if (receipt.status === 'ok') {
      db.prepare(
        `UPDATE push_outbox SET receipt_status = 'OK', updated_at_ms = ? WHERE id = ?`
      ).run(nowMs, row.id);
      summary.ok += 1;
      continue;
    }
    db.prepare(
      `UPDATE push_outbox
       SET receipt_status = 'ERROR', last_error = ?, updated_at_ms = ?
       WHERE id = ?`
    ).run(receipt.message ?? receipt.detailsError ?? 'receipt error', nowMs, row.id);
    summary.errored += 1;
    if (receipt.detailsError === 'DeviceNotRegistered') {
      const currentDevice = db
        .prepare('SELECT generation, disabled FROM devices WHERE installation_id = ?')
        .get(row.installation_id) as { generation: number; disabled: number } | undefined;
      disableDevice(db, row.installation_id, row.device_generation, nowMs);
      if (currentDevice?.generation === row.device_generation && currentDevice.disabled === 0) {
        summary.devicesDisabled += 1;
      }
    }
  }
  return summary;
}

export interface OutboxStatusSummary {
  transportEnabled: boolean;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  receiptPending: number;
  receiptOk: number;
  receiptError: number;
}

export function outboxStatus(
  db: DatabaseSync,
  transportEnabled: boolean,
  userId?: string
): OutboxStatusSummary {
  const count = (where: string): number =>
    (
      userId
        ? (db
            .prepare(`SELECT COUNT(*) AS c FROM push_outbox WHERE user_id = ? AND ${where}`)
            .get(userId) as { c: number })
        : (db.prepare(`SELECT COUNT(*) AS c FROM push_outbox WHERE ${where}`).get() as {
            c: number;
          })
    ).c;
  return {
    transportEnabled,
    pending: count(`status = 'PENDING'`),
    sent: count(`status = 'SENT'`),
    failed: count(`status = 'FAILED'`),
    skipped: count(`status = 'SKIPPED'`),
    receiptPending: count(`receipt_status = 'PENDING'`),
    receiptOk: count(`receipt_status = 'OK'`),
    receiptError: count(`receipt_status = 'ERROR'`),
  };
}
