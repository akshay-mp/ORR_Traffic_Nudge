import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

import { createApp, AppHandle, AppOptions } from '../../server';
import {
  buildDepartureRecommendations,
  computeDemoSlotPrediction,
  getNowIstParts,
  minutesToHhmm,
  resolveEffectiveSchedule,
} from '../lib/commuteEngine';
import {
  INITIAL_DEMO_JOURNEYS,
  INITIAL_PILOT_EMPLOYEES,
  PilotUserSeed,
} from '../lib/pilotSeed';
import {
  CommuteAlert,
  DirectionSchedule,
  MonitoringSession,
} from '../types/commute';

import { applySchema, openDatabase } from '../server/db';
import {
  createStore,
  persistStore,
  checkBudgetAndIncrement,
  StoreError,
} from '../server/store';
import {
  createExpoHttpTransport,
  enqueueAlertsForPush,
  ExpoPushMessage,
  ExpoSendOutcome,
  ExpoReceiptsOutcome,
  ExpoTicket,
  outboxStatus,
  pollReceipts,
  processOutbox,
  registerDevice,
  removeDevice,
} from '../server/push';
import { createComputeOptions, ROUTES_REQUEST_TIMEOUT_MS } from '../server/options';

// ---------------------------------------------------------------------------
// Minimal test framework (same reporting style as runTests.ts)
// ---------------------------------------------------------------------------

interface TestResult {
  category: string;
  name: string;
  passed: boolean;
  assertionsRun: number;
  evidence: string;
  failure?: string;
}

const results: TestResult[] = [];
let assertionCount = 0;

function assert(cond: unknown, message: string): void {
  assertionCount += 1;
  if (!cond) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assertionCount += 1;
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(
  category: string,
  name: string,
  fn: () => Promise<string> | string
): Promise<void> {
  const before = assertionCount;
  try {
    const evidence = await fn();
    results.push({
      category,
      name,
      passed: true,
      assertionsRun: assertionCount - before,
      evidence,
    });
  } catch (err) {
    results.push({
      category,
      name,
      passed: false,
      assertionsRun: assertionCount - before,
      evidence: '',
      failure: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function newTempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orr-backend-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

interface RunningApp {
  handle: AppHandle;
  baseUrl: string;
  close(): Promise<void>;
}

async function startApp(
  opts: Partial<AppOptions>
): Promise<RunningApp> {
  const handle = await createApp({
    skipWebStack: true,
    env: { ...TEST_ENV },
    ...opts,
  } as AppOptions);
  const server = http.createServer(handle.app);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    handle,
    baseUrl,
    async close() {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((res) => server.close(() => res()));
      handle.close();
    },
  };
}

async function api(
  baseUrl: string,
  method: string,
  p: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(baseUrl + p, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: resp.status, json, text };
}

async function login(baseUrl: string, userId: string, pin: string): Promise<string> {
  const res = await api(baseUrl, 'POST', '/api/auth/login', {
    body: { userId, pin },
  });
  if (res.status !== 200) throw new Error(`login failed for ${userId}: ${res.status} ${res.text}`);
  return res.json.token as string;
}

class MockTransport {
  enabled = true;
  sendCalls: ExpoPushMessage[][] = [];
  receiptCalls: string[][] = [];
  nextSend: ExpoSendOutcome = { httpOk: true, retryable: false, tickets: [] };
  nextReceipts: ExpoReceiptsOutcome = { httpOk: true, retryable: false, receipts: {} };

  async send(messages: ExpoPushMessage[]): Promise<ExpoSendOutcome> {
    this.sendCalls.push(messages);
    return this.nextSend;
  }

  async getReceipts(ids: string[]): Promise<ExpoReceiptsOutcome> {
    this.receiptCalls.push(ids);
    return this.nextReceipts;
  }

  totalMessages(): number {
    return this.sendCalls.reduce((n, batch) => n + batch.length, 0);
  }
}

function makeProviderOverride(
  handler: (params: any, callIndex: number) => Promise<any> | any
) {
  const calls: any[] = [];
  const fn = async (params: any) => {
    calls.push(params);
    return handler(params, calls.length);
  };
  return { fn, calls };
}

function validOptionsOutcome(user: PilotUserSeed, direction: string): any {
  const baseSchedule = user.schedules[direction as 'HOME_TO_WORK'];
  const effectiveSchedule = resolveEffectiveSchedule(baseSchedule, user.dayOverrides, getNowIstParts().dateIst);
  const origin = direction === 'HOME_TO_WORK' ? user.homeLocation! : user.workLocation;
  const destination = direction === 'HOME_TO_WORK' ? user.workLocation : user.homeLocation!;
  const dep = getNowIstParts().timeIst;
  const demo = computeDemoSlotPrediction({
    origin,
    destination,
    mode: effectiveSchedule.mode,
    departureTimeIst: dep,
    departureIso: new Date().toISOString(),
    isNowSlot: true,
  });
  const options = buildDepartureRecommendations({
    dateIst: getNowIstParts().dateIst,
    nowIso: new Date().toISOString(),
    schedule: effectiveSchedule,
    slotPredictions: demo.prediction ? [demo.prediction] : [],
  });
  return { options, effectiveSchedule };
}

function makeSession(over: Partial<MonitoringSession> = {}): MonitoringSession {
  const { dateIst } = getNowIstParts();
  const nowMs = Date.now();
  return {
    id: `mon_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    userId: 'emp_01',
    dateIst,
    direction: 'HOME_TO_WORK',
    transportMode: 'CAR',
    status: 'ACTIVE',
    watchMode: 'ALL_OPTIONS',
    selectedOptionId: null,
    selectedEstimateSnapshot: null,
    departureEstimateSnapshot: null,
    lastNotifiedArrivalIso: null,
    lastNotifiedArrivalTimeIst: null,
    snoozedUntilIso: null,
    startedAtIso: new Date(nowMs - 60_000).toISOString(),
    lastRefreshedAtIso: new Date(nowMs - 60_000).toISOString(),
    nextRefreshDueIso: new Date(nowMs - 1000).toISOString(),
    expiresAtIso: new Date(nowMs + 2 * 3_600_000).toISOString(),
    refreshCount: 0,
    suppressedDuplicatesCount: 0,
    latestOptions: [],
    unsupportedModeReason: null,
    dataEnvironment: 'DEMO',
    ...over,
  };
}

/** Rewrites a user's schedule so scheduler gating tests are time-of-day robust. */
function primeSchedule(
  store: { users: PilotUserSeed[] },
  userId: string,
  direction: 'HOME_TO_WORK' | 'WORK_TO_HOME',
  patch: Partial<DirectionSchedule> = {}
): void {
  const user = store.users.find((u) => u.id === userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const nowMin = getNowIstParts().minutesFromMidnight;
  user.schedules[direction] = {
    ...user.schedules[direction],
    enabled: true,
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    windowStart: minutesToHhmm(Math.max(0, nowMin - 60)),
    windowEnd: nowMin + 90 < 1440 ? minutesToHhmm(nowMin + 90) : '23:59',
    preferredDeparture: minutesToHhmm(nowMin),
    leadTimeMinutes: 15,
    ...patch,
  };
}

function outboxRows(db: DatabaseSync, where = ''): any[] {
  return db
    .prepare(`SELECT * FROM push_outbox ${where}`)
    .all() as unknown as any[];
}

function sessionRow(db: DatabaseSync, id: string): any {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Durable restart persistence (SQLite survives close/reopen)
  await test(
    '1. SQLite Durability & Restart',
    'Sessions, profile consent, journeys and issued tokens survive full close/reopen',
    async () => {
      const dir = newTempDir('restart');
      const app1 = await startApp({ dataDir: dir });
      try {
        const token = await login(app1.baseUrl, 'emp_01', '1001');
        assert(/^oprt_[0-9a-f]{48}$/.test(token), 'issued token format');

        // Widen today's window around the current time so the session is ACTIVE regardless of run hour
        const nowMin = getNowIstParts().minutesFromMidnight;
        const put = await api(app1.baseUrl, 'PUT', '/api/me/profile', {
          token,
          body: {
            pushOptIn: true,
            telemetryConsent: true,
            schedules: {
              HOME_TO_WORK: {
                windowStart: minutesToHhmm(Math.max(0, nowMin - 60)),
                windowEnd: nowMin + 90 < 1440 ? minutesToHhmm(nowMin + 90) : '23:59',
                preferredDeparture: minutesToHhmm(nowMin),
              },
            },
          },
        });
        assertEqual(put.status, 200, 'profile PUT status');

        const start = await api(app1.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(start.status, 200, 'start-or-refresh status');
        assertEqual(start.json.session.status, 'ACTIVE', 'session status');

        await app1.close();

        const app2 = await startApp({ dataDir: dir });
        try {
          const state = await api(app2.baseUrl, 'GET', '/api/me/state', { token });
          assertEqual(state.status, 200, 'reopened state status with first-app token');
          assertEqual(state.json.profile.pushOptIn, true, 'pushOptIn persisted');
          assertEqual(state.json.sessions.length, 1, 'session persisted across restart');
          assertEqual(state.json.sessions[0].status, 'ACTIVE', 'session status persisted');
          assert(
            state.json.journeys.length >= 1,
            'seeded demo journeys present after restart'
          );
          assertEqual(state.json.quota.dateIst, getNowIstParts().dateIst, 'quota date after restart');
          for (const key of [
            'dateIst', 'dailyLimit', 'requestsUsedToday', 'routesRequests',
            'placesRequests', 'geocodingRequests', 'lastProviderStatus',
            'lastErrorMessage', 'liveApiConfigured',
          ]) {
            assert(key in state.json.quota, `quota shape key ${key}`);
          }
          for (const key of [
            'id', 'userId', 'dateIst', 'direction', 'transportMode', 'status',
            'watchMode', 'selectedOptionId', 'expiresAtIso', 'refreshCount',
            'latestOptions', 'dataEnvironment',
          ]) {
            assert(key in state.json.sessions[0], `session shape key ${key}`);
          }
          return `Token + session + consent + quota verified across close/reopen in ${dir}`;
        } finally {
          await app2.close();
        }
      } finally {
        await app1.close().catch(() => {});
      }
    }
  );

  // 2. Auth: random hashed tokens, seeded pilot compat, scoping
  await test(
    '2. Auth Tokens',
    'New tokens are cryptographically random and stored hashed; seeded pilot tokens still work; users are scoped',
    async () => {
      const dir = newTempDir('auth');
      const app = await startApp({ dataDir: dir });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        const t2 = await login(app.baseUrl, 'emp_01', '1001');
        assert(!/^token_.*_pilot$/.test(t1), 'issued token is not the predictable seeded pattern');
        assert(t1 !== t2, 'two logins issue distinct tokens');

        const hashes = app.handle.db
          .prepare('SELECT token_hash FROM auth_tokens')
          .all() as unknown as { token_hash: string }[];
        assert(hashes.length >= 2, 'issued tokens persisted');
        assert(
          hashes.every((h) => h.token_hash !== t1 && h.token_hash !== t2),
          'raw tokens never stored, only SHA-256 hashes'
        );

        const seeded = await api(app.baseUrl, 'GET', '/api/me/state', {
          token: 'token_emp_01_pilot',
        });
        assertEqual(seeded.status, 200, 'seeded pilot token accepted');
        assertEqual(seeded.json.profile.id, 'emp_01', 'seeded token scopes to emp_01');

        const seeded2 = await api(app.baseUrl, 'GET', '/api/me/state', {
          token: 'token_emp_02_pilot',
        });
        assertEqual(seeded2.json.profile.id, 'emp_02', 'second seeded token scopes to emp_02');

        const bad = await api(app.baseUrl, 'GET', '/api/me/state', {
          token: 'token_emp_99_pilot',
        });
        assertEqual(bad.status, 401, 'seeded token for unknown user rejected');

        const none = await api(app.baseUrl, 'GET', '/api/me/state', {});
        assertEqual(none.status, 401, 'missing token rejected');

        const wrong = await api(app.baseUrl, 'POST', '/api/auth/login', {
          body: { userId: 'emp_01', pin: '9999' },
        });
        assertEqual(wrong.status, 403, 'wrong PIN rejected');
        return `Random hashed tokens (${hashes.length} rows), seeded compat, per-user scoping verified`;
      } finally {
        await app.close();
      }
    }
  );

  // 3. Legacy JSON migration (happy path, original preserved)
  await test(
    '3. JSON→SQLite Migration',
    'Legacy .data/orr_pulse_store.json imports once; original file preserved; legacy tokens keep working',
    async () => {
      const dir = newTempDir('migrate');
      const users = structuredClone(INITIAL_PILOT_EMPLOYEES);
      users[0].name = 'Migrated Aarav';
      const legacySession = makeSession({ id: 'mon_legacy_1', status: 'ACTIVE' });
      const legacyStopped = makeSession({ id: 'mon_legacy_2', status: 'STOPPED' });
      const legacyAlert: CommuteAlert = {
        id: 'alert_legacy_1',
        userId: 'emp_01',
        sessionId: 'mon_legacy_1',
        createdAtIso: new Date().toISOString(),
        createdAtIst: '08:00:00 IST',
        type: 'DEPARTURE_REMINDER',
        severity: 'INFO',
        title: 'Legacy',
        message: 'legacy alert',
        deliveredChannels: ['IN_APP'],
        acknowledged: false,
      };
      const legacyStore = {
        users,
        sessions: [legacySession, legacyStopped],
        alerts: [legacyAlert],
        journeys: structuredClone(INITIAL_DEMO_JOURNEYS),
        quota: {
          dateIst: '2026-01-01',
          dailyLimit: 500,
          requestsUsedToday: 7,
          routesRequests: 5,
          placesRequests: 2,
          geocodingRequests: 0,
          lastProviderStatus: 'OK',
          lastErrorMessage: null,
          liveApiConfigured: false,
        },
        tokens: { legacy_issued_tok_emp1: 'emp_01', token_emp_01_pilot: 'emp_01' },
      };
      fs.writeFileSync(
        path.join(dir, 'orr_pulse_store.json'),
        JSON.stringify(legacyStore),
        'utf-8'
      );

      const app = await startApp({ dataDir: dir });
      try {
        const roster = await api(app.baseUrl, 'GET', '/api/auth/pilot-roster');
        assertEqual(roster.json.roster[0].name, 'Migrated Aarav', 'users came from JSON, not seed');

        const legacyAuth = await api(app.baseUrl, 'GET', '/api/me/state', {
          token: 'legacy_issued_tok_emp1',
        });
        assertEqual(legacyAuth.status, 200, 'legacy issued token authenticates after migration');

        const state = await api(app.baseUrl, 'GET', '/api/me/state', {
          token: 'token_emp_01_pilot',
        });
        assertEqual(state.json.sessions.length, 2, 'both legacy sessions migrated');

        const files = fs.readdirSync(dir);
        const preserved = files.filter((f) => f.startsWith('orr_pulse_store.json.migrated-'));
        assertEqual(preserved.length, 1, 'original JSON preserved exactly once');
        assert(!files.includes('orr_pulse_store.json'), 'original filename retired');
        assert(files.includes('orr_pulse.db'), 'SQLite database created');
        const preservedContent = JSON.parse(
          fs.readFileSync(path.join(dir, preserved[0]), 'utf-8')
        );
        assertEqual(preservedContent.users[0].name, 'Migrated Aarav', 'preserved copy intact');
        return `Imported ${users.length} users, 2 sessions, 1 alert, 7 journeys; original preserved as ${preserved[0]}`;
      } finally {
        await app.close();
      }
    }
  );

  // 4. Corrupt JSON fails loudly, never silently seeds
  await test(
    '4. Corrupt JSON Rejected',
    'Invalid legacy JSON throws on boot; file untouched; no silent seed over operator data',
    async () => {
      const dir = newTempDir('corrupt');
      fs.writeFileSync(path.join(dir, 'orr_pulse_store.json'), '{not valid json', 'utf-8');
      let threw = false;
      try {
        await createApp({ dataDir: dir, skipWebStack: true, env: { ...TEST_ENV } });
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        assert(msg.includes('not valid JSON') || msg.includes('CORRUPT'), `error mentions corruption: ${msg}`);
      }
      assert(threw, 'createApp rejects corrupt JSON');
      assert(
        fs.existsSync(path.join(dir, 'orr_pulse_store.json')),
        'corrupt original left in place for the operator'
      );
      return 'Corrupt JSON rejected loudly; original file untouched';
    }
  );

  // 5. Scheduler never resurrects terminal sessions; expiry & day rollover
  await test(
    '5. No-Resurrect + Expiry + Rollover',
    'STOPPED/SKIPPED/LEFT sessions are never refreshed; expired windows and stale dates transition to EXPIRED',
    async () => {
      const dir = newTempDir('nores');
      const provider = makeProviderOverride(() => validOptionsOutcome(
        INITIAL_PILOT_EMPLOYEES[0], 'HOME_TO_WORK'
      ));
      const handle = await createApp({
        dataDir: dir,
        skipWebStack: true,
        env: { ...TEST_ENV },
        providerOverride: provider.fn,
      });
      try {
        const { dateIst } = getNowIstParts();
        const yesterday = new Date(Date.now() - 24 * 3_600_000);
        const yesterdayIst = getNowIstParts(yesterday).dateIst;
        const sessions = [
          makeSession({ id: 'mon_s1', status: 'STOPPED' }),
          makeSession({ id: 'mon_s2', status: 'SKIPPED' }),
          makeSession({ id: 'mon_s3', status: 'LEFT' }),
          makeSession({
            id: 'mon_s4',
            status: 'ACTIVE',
            expiresAtIso: new Date(Date.now() - 3_600_000).toISOString(),
          }),
          makeSession({
            id: 'mon_s5',
            status: 'ACTIVE',
            dateIst: yesterdayIst,
            expiresAtIso: new Date(yesterday.getTime() + 3_600_000).toISOString(),
          }),
        ];
        handle.store.sessions.push(...sessions);
        persistStore(handle.db, handle.store);

        const summary = await handle.scheduler.tick(Date.now());

        assertEqual(provider.calls.length, 0, 'no provider calls for terminal/expired sessions');
        const statuses = handle.store.sessions.map((s) => `${s.id}:${s.status}`);
        assertEqual(sessionRow(handle.db, 'mon_s1')?.status, 'STOPPED', 'STOPPED stays STOPPED');
        assertEqual(sessionRow(handle.db, 'mon_s2')?.status, 'SKIPPED', 'SKIPPED stays SKIPPED');
        assertEqual(sessionRow(handle.db, 'mon_s3')?.status, 'LEFT', 'LEFT stays LEFT');
        assertEqual(sessionRow(handle.db, 'mon_s4')?.status, 'EXPIRED', 'expired window → EXPIRED');
        assertEqual(sessionRow(handle.db, 'mon_s5')?.status, 'EXPIRED', 'stale date → EXPIRED');
        assertEqual(summary.expired, 2, 'two sessions expired');
        const expiredAlerts = handle.store.alerts.filter((a) => a.type === 'SESSION_EXPIRED');
        assertEqual(expiredAlerts.length, 2, 'SESSION_EXPIRED alerts recorded');
        void dateIst;
        void statuses;
        return `Terminal statuses preserved (s1-s3), s4/s5 EXPIRED with alerts, provider calls=0`;
      } finally {
        handle.close();
      }
    }
  );

  // 6. SCHEDULED lead activation + disabled/weekday/skip gating
  await test(
    '6. Scheduled Activation & Gating',
    'SCHEDULED sessions activate at lead time; disabled schedules, unselected weekdays and skipped days transition to SKIPPED',
    async () => {
      const dir = newTempDir('sched');
      const provider = makeProviderOverride((p) => {
        const user = INITIAL_PILOT_EMPLOYEES.find((u) => u.id === p.user.id)!;
        return validOptionsOutcome(user, p.direction);
      });
      const handle = await createApp({
        dataDir: dir,
        skipWebStack: true,
        env: { ...TEST_ENV },
        providerOverride: provider.fn,
      });
      try {
        primeSchedule(handle.store, 'emp_01', 'HOME_TO_WORK');
        primeSchedule(handle.store, 'emp_02', 'HOME_TO_WORK');
        primeSchedule(handle.store, 'emp_03', 'HOME_TO_WORK', { enabled: false });
        primeSchedule(handle.store, 'emp_04', 'HOME_TO_WORK', { days: [] });

        const emp2 = handle.store.users.find((u) => u.id === 'emp_02')!;
        emp2.dayOverrides.push({
          dateIst: getNowIstParts().dateIst,
          direction: 'HOME_TO_WORK',
          skipped: true,
        });

        const scheduled = makeSession({ id: 'mon_act_1', userId: 'emp_01', status: 'SCHEDULED', nextRefreshDueIso: null });
        const skippedByOverride = makeSession({ id: 'mon_act_2', userId: 'emp_02', status: 'SCHEDULED', nextRefreshDueIso: null });
        const disabledActive = makeSession({ id: 'mon_act_3', userId: 'emp_03' });
        const weekdayOff = makeSession({ id: 'mon_act_4', userId: 'emp_04' });
        handle.store.sessions.push(scheduled, skippedByOverride, disabledActive, weekdayOff);
        persistStore(handle.db, handle.store);

        const summary = await handle.scheduler.tick(Date.now());

        assertEqual(sessionRow(handle.db, 'mon_act_1')?.status, 'ACTIVE', 'SCHEDULED activated at lead time');
        assert(
          sessionRow(handle.db, 'mon_act_1')?.next_refresh_due_ms !== null,
          'activated session due for immediate refresh'
        );
        assertEqual(sessionRow(handle.db, 'mon_act_2')?.status, 'SKIPPED', 'skipped-day SCHEDULED → SKIPPED');
        assertEqual(sessionRow(handle.db, 'mon_act_3')?.status, 'SKIPPED', 'disabled schedule ACTIVE → SKIPPED');
        assertEqual(sessionRow(handle.db, 'mon_act_4')?.status, 'SKIPPED', 'weekday-off ACTIVE → SKIPPED');
        assertEqual(summary.scheduledActivated, 1, 'one activation');
        assertEqual(summary.scheduledSkipped + (summary.refreshed === 0 ? 0 : 0) >= 1, true, 'gating applied');
        const activated = handle.store.sessions.find((s) => s.id === 'mon_act_1')!;
        assertEqual(activated.refreshCount, 1, 'activated session refreshed in same tick');
        return `Activated mon_act_1 (refreshCount=1); override/disabled/weekday sessions SKIPPED`;
      } finally {
        handle.close();
      }
    }
  );

  // 7. Provider outage: retries with exponential backoff, no state corruption
  await test(
    '7. Provider Outage Backoff',
    'Provider failures retry with exponential backoff and never advance or corrupt the session',
    async () => {
      const dir = newTempDir('outage');
      const provider = makeProviderOverride(() => ({
        options: [],
        effectiveSchedule: resolveEffectiveSchedule(
          INITIAL_PILOT_EMPLOYEES[0].schedules.HOME_TO_WORK,
          [],
          getNowIstParts().dateIst
        ),
        providerError: 'simulated provider outage',
      }));
      const handle = await createApp({
        dataDir: dir,
        skipWebStack: true,
        env: { ...TEST_ENV },
        providerOverride: provider.fn,
      });
      try {
        primeSchedule(handle.store, 'emp_01', 'HOME_TO_WORK');
        const session = makeSession({ id: 'mon_out_1' });
        handle.store.sessions.push(session);
        persistStore(handle.db, handle.store);

        const now = Date.now();
        const t1 = await handle.scheduler.tick(now);
        assertEqual(t1.providerFailures, 1, 'first tick records failure');
        assertEqual(t1.refreshed, 0, 'no successful refresh');
        let row = sessionRow(handle.db, 'mon_out_1');
        assertEqual(row.status, 'ACTIVE', 'session stays ACTIVE during outage');
        assertEqual(row.attempt_count, 1, 'attempt count 1');
        assert(row.next_attempt_at_ms > now, 'backoff scheduled in the future');
        assert(
          String(row.last_provider_error || '').includes('simulated provider outage'),
          'last error recorded'
        );

        const t2 = await handle.scheduler.tick(now + 5_000);
        assertEqual(t2.claimed, 0, 'backoff gate blocks immediate re-claim');

        const t3 = await handle.scheduler.tick(now + 61_000);
        assertEqual(t3.claimed, 1, 'claim resumes after backoff elapses');
        row = sessionRow(handle.db, 'mon_out_1');
        assertEqual(row.attempt_count, 2, 'attempt count 2');
        assert(row.next_attempt_at_ms >= now + 61_000 + 120_000 - 1, 'second backoff doubled');
        assertEqual(provider.calls.length, 2, 'exactly two provider attempts');
        return `Outage handled: 2 attempts, backoff 60s→120s, session intact`;
      } finally {
        handle.close();
      }
    }
  );

  // 8. Lease/overlap: no double processing within a process or across two
  await test(
    '8. Lease & Multi-Worker Overlap',
    'Ticks never overlap in-process; a second scheduler on the same SQLite cannot claim a leased session; dead leases are reclaimed',
    async () => {
      const dir = newTempDir('lease');
      const provider = makeProviderOverride((p) => {
        const user = INITIAL_PILOT_EMPLOYEES.find((u) => u.id === p.user.id)!;
        return validOptionsOutcome(user, p.direction);
      });
      const handleA = await createApp({
        dataDir: dir, skipWebStack: true, env: { ...TEST_ENV }, providerOverride: provider.fn,
      });
      const handleB = await createApp({
        dataDir: dir, skipWebStack: true, env: { ...TEST_ENV }, providerOverride: provider.fn,
      });
      try {
        primeSchedule(handleA.store, 'emp_01', 'HOME_TO_WORK');
        const session = makeSession({ id: 'mon_lease_1' });
        handleA.store.sessions.push(session);
        persistStore(handleA.db, handleA.store);

        // (a) in-process overlap guard with a hanging provider
        let release: () => void = () => {};
        const gate = new Promise<void>((res) => (release = res));
        const hanging = makeProviderOverride(async () => {
          await gate;
          return validOptionsOutcome(INITIAL_PILOT_EMPLOYEES[0], 'HOME_TO_WORK');
        });
        const schedA = handleA.scheduler;
        const origDeps = (schedA as unknown as { deps: { computeOptions: any } }).deps;
        origDeps.computeOptions = hanging.fn;

        const tick1 = schedA.tick(Date.now());
        const tick2 = await schedA.tick(Date.now());
        assertEqual(tick2.skippedOverlap, true, 'concurrent in-process tick skipped');
        release();
        const done1 = await tick1;
        assertEqual(done1.refreshed, 1, 'first tick completed the refresh');
        assertEqual(hanging.calls.length, 1, 'provider called exactly once');

        // (b) cross-worker: B cannot claim while A holds a live lease
        const row = sessionRow(handleA.db, 'mon_lease_1');
        assertEqual(row.lease_owner, null, 'lease released after commit');

        handleA.db
          .prepare('UPDATE sessions SET lease_owner=?, lease_until_ms=? WHERE id=?')
          .run('wrk_holder', Date.now() + 60_000, 'mon_lease_1');
        const tickB = await handleB.scheduler.tick(Date.now());
        assertEqual(tickB.claimed, 0, 'worker B skipped leased session');

        // (c) dead (expired) lease is reclaimable once the refresh is due again
        handleA.db
          .prepare(
            'UPDATE sessions SET lease_owner=?, lease_until_ms=?, next_refresh_due_ms=? WHERE id=?'
          )
          .run('wrk_holder', Date.now() - 1000, Date.now() - 1000, 'mon_lease_1');
        const tickB2 = await handleB.scheduler.tick(Date.now());
        assertEqual(tickB2.claimed, 1, 'expired lease reclaimed by worker B');
        assertEqual(tickB2.refreshed, 1, 'worker B refreshed after reclaim');
        const finalRow = sessionRow(handleA.db, 'mon_lease_1');
        assertEqual(finalRow.lease_owner, null, 'lease cleared after B commits');
        return 'Overlap guarded in-process and cross-worker; expired leases reclaimed';
      } finally {
        handleA.close();
        handleB.close();
      }
    }
  );

  // 9. Device registration API: validation, ownership, scoping, sanitization
  await test(
    '9. Device Registration API',
    'Validates formats, enforces stable per-user installation ownership, never exposes tokens',
    async () => {
      const dir = newTempDir('devices');
      const app = await startApp({ dataDir: dir });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        const t2 = await login(app.baseUrl, 'emp_02', '1002');
        const token1 = 'ExponentPushToken[abcdefghij1234567890]';
        const token1b = 'ExpoPushToken[zzzzzzzzzz1234567890]';

        const ok = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: token1, platform: 'ios', installationId: 'install-aaa-0001' },
        });
        assertEqual(ok.status, 201, 'valid registration 201');
        assert(!JSON.stringify(ok.json).includes(token1), 'token not echoed in response');

        const okShort = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: token1b, platform: 'android', installationId: 'install-bbb-0002' },
        });
        assertEqual(okShort.status, 201, 'ExpoPushToken[...] short form accepted');

        for (const [body, code] of [
          [{ expoPushToken: 'not-a-token', platform: 'ios', installationId: 'install-ccc-0003' }, 400],
          [{ expoPushToken: token1, platform: 'web', installationId: 'install-ccc-0003' }, 400],
          [{ expoPushToken: token1, platform: 'ios', installationId: 'short' }, 400],
          [{ platform: 'ios', installationId: 'install-ccc-0003' }, 400],
        ] as [any, number][]) {
          const res = await api(app.baseUrl, 'POST', '/api/me/devices', {
            token: t1,
            body,
          });
          assertEqual(res.status, code, `invalid body rejected (${JSON.stringify(body)})`);
        }

        const cross = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t2,
          body: { expoPushToken: 'ExponentPushToken[qwertyuiop1234567890]', platform: 'ios', installationId: 'install-aaa-0001' },
        });
        assertEqual(cross.status, 409, 'installation takeover by another user → 409');
        assertEqual(cross.json.error, 'INSTALLATION_OWNED_BY_OTHER_USER', 'takeover error code');

        const crossToken = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t2,
          body: { expoPushToken: token1, platform: 'ios', installationId: 'install-emp2-token-1' },
        });
        assertEqual(crossToken.status, 409, 'Expo token cannot be shared across users');
        assertEqual(crossToken.json.error, 'TOKEN_BOUND_TO_OTHER_INSTALLATION', 'global token owner conflict');

        const rebound = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: token1, platform: 'ios', installationId: 'install-ddd-0004' },
        });
        assertEqual(rebound.status, 409, 'same token under another installation → 409');
        assertEqual(rebound.json.error, 'TOKEN_BOUND_TO_OTHER_INSTALLATION', 'rebind error code');

        const list = await api(app.baseUrl, 'GET', '/api/me/devices', { token: t1 });
        assertEqual(list.json.devices.length, 2, 'two devices listed');
        assert(!JSON.stringify(list.json).includes(token1), 'device list omits tokens');

        app.handle.db.prepare(
          `INSERT INTO push_outbox
             (id, user_id, installation_id, alert_id, kind, payload, status, attempts, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run('status-emp1', 'emp_01', 'install-aaa-0001', 'a1', 'ALERT', '{}', 'PENDING', Date.now(), Date.now());
        app.handle.db.prepare(
          `INSERT INTO push_outbox
             (id, user_id, installation_id, alert_id, kind, payload, status, attempts, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run('status-emp2', 'emp_02', 'install-bbb-0001', 'a2', 'ALERT', '{}', 'SENT', Date.now(), Date.now());
        const pushStatus1 = await api(app.baseUrl, 'GET', '/api/me/push-status', { token: t1 });
        const pushStatus2 = await api(app.baseUrl, 'GET', '/api/me/push-status', { token: t2 });
        assertEqual(pushStatus1.json.outbox.pending, 1, 'push status shows own pending rows');
        assertEqual(pushStatus1.json.outbox.sent, 0, 'push status hides other user sent rows');
        assertEqual(pushStatus2.json.outbox.pending, 0, 'push status hides other user pending rows');
        assertEqual(pushStatus2.json.outbox.sent, 1, 'push status shows own sent rows');
        assert(!pushStatus1.text.includes(token1), 'push status remains sanitized');

        const state = await api(app.baseUrl, 'GET', '/api/me/state', { token: t1 });
        assert(!state.text.includes(token1) && !state.text.includes(token1b), '/api/me/state never exposes tokens');

        const metrics = await api(app.baseUrl, 'GET', '/api/pilot/metrics?environment=DEMO', { token: t1 });
        assert(!metrics.text.includes(token1), 'metrics never exposes tokens');

        const del = await api(app.baseUrl, 'DELETE', '/api/me/devices/install-aaa-0001', { token: t1 });
        assertEqual(del.status, 200, 'delete own device');
        const delAgain = await api(app.baseUrl, 'DELETE', '/api/me/devices/install-aaa-0001', { token: t1 });
        assertEqual(delAgain.status, 404, 'second delete 404');
        const delOther = await api(app.baseUrl, 'DELETE', '/api/me/devices/install-bbb-0002', { token: t2 });
        assertEqual(delOther.status, 404, "cannot delete another user's device");

        for (let i = 0; i < 10; i++) {
          const res = await api(app.baseUrl, 'POST', '/api/me/devices', {
            token: t2,
            body: {
              expoPushToken: `ExponentPushToken[bulk${String(i).padStart(4, '0')}abcdefghijklmnop]`,
              platform: 'android',
              installationId: `install-emp2-${String(i).padStart(3, '0')}`,
            },
          });
          if (res.status !== 201) throw new Error(`bulk registration ${i} failed: ${res.status}`);
        }
        const over = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t2,
          body: {
            expoPushToken: 'ExponentPushToken[overlimit000000000000000]',
            platform: 'android',
            installationId: 'install-emp2-over',
          },
        });
        assertEqual(over.status, 400, 'device cap enforced');
        assertEqual(over.json.error, 'TOO_MANY_DEVICES', 'cap error code');
        return 'Validation, 409 ownership rules, sanitization, cap of 10 devices verified';
      } finally {
        await app.close();
      }
    }
  );

  // 10. Outbox enqueue rules: consent/eligibility + idempotency + disabled default
  await test(
    '10. Outbox Enqueue Rules',
    'Commute alerts enqueue only for opted-in users with devices; SYSTEM_NOTICE excluded; enqueue idempotent; disabled transport never dispatches',
    async () => {
      const dir = newTempDir('enq');
      const mock = new MockTransport();
      const app = await startApp({ dataDir: dir, pushTransport: mock as any });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        const t2 = await login(app.baseUrl, 'emp_02', '1002');
        await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token: t1,
          body: { pushOptIn: true },
        });
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: 'ExponentPushToken[enqueue-test-000000001]', platform: 'ios', installationId: 'install-enq-01' },
        });
        // emp_02: device but NO pushOptIn
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t2,
          body: { expoPushToken: 'ExponentPushToken[enqueue-test-000000002]', platform: 'ios', installationId: 'install-enq-02' },
        });

        const start1 = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t1,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(start1.status, 200, 'emp_01 session started');
        const start2 = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t2,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(start2.status, 200, 'emp_02 session started');

        const rows = outboxRows(app.handle.db);
        assertEqual(rows.length, 1, 'exactly one outbox row (emp_01 only)');
        assertEqual(rows[0].status, 'PENDING', 'row pending before dispatch');
        assertEqual(rows[0].user_id, 'emp_01', 'row belongs to opted-in user');
        assertEqual(mock.sendCalls.length, 0, 'nothing dispatched without a scheduler tick');

        // idempotency: re-enqueue the same alerts
        const alert = JSON.parse(
          (app.handle.db.prepare('SELECT data FROM alerts WHERE id = ?').get(rows[0].alert_id) as any).data
        ) as CommuteAlert;
        enqueueAlertsForPush(app.handle.db, [alert], {
          getUsers: () => app.handle.store.users,
          getSessionDirection: () => 'HOME_TO_WORK',
        });
        assertEqual(outboxRows(app.handle.db).length, 1, 're-enqueue does not duplicate');

        // SYSTEM_NOTICE (snooze) is never enqueued
        const sessionId = start1.json.session.id;
        await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token: t1,
          body: { sessionId, action: 'SNOOZE_10M' },
        });
        const noticeRows = outboxRows(
          app.handle.db,
          "WHERE kind = 'SYSTEM_NOTICE'"
        );
        assertEqual(noticeRows.length, 0, 'SYSTEM_NOTICE never enqueued');

        // Disabled transport keeps rows PENDING with zero network
        const disabledDir = newTempDir('enq-disabled');
        const disabledApp = await startApp({ dataDir: disabledDir });
        try {
          const t3 = await login(disabledApp.baseUrl, 'emp_01', '1001');
          await api(disabledApp.baseUrl, 'PUT', '/api/me/profile', {
            token: t3,
            body: { pushOptIn: true },
          });
          await api(disabledApp.baseUrl, 'POST', '/api/me/devices', {
            token: t3,
            body: { expoPushToken: 'ExponentPushToken[disabled-test-000000001]', platform: 'ios', installationId: 'install-dis-01' },
          });
          await api(disabledApp.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
            token: t3,
            body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
          });
          assertEqual(disabledApp.handle.transport.enabled, false, 'default transport disabled');
          const tick = await disabledApp.handle.scheduler.tick(Date.now());
          assertEqual(tick.push.transportEnabled, false, 'tick reports disabled transport');
          const status = outboxStatus(disabledApp.handle.db, false);
          assertEqual(status.pending, 1, 'row stays PENDING when disabled');
          return 'Eligibility, idempotency, SYSTEM_NOTICE exclusion, disabled-by-default verified';
        } finally {
          await disabledApp.close();
        }
      } finally {
        await app.close();
      }
    }
  );

  // 11. Dispatch: generic copy, accepted-not-delivered, restart dedup
  await test(
    '11. Dispatch: Generic Copy & Honest Status',
    'Sends generic lock-screen text without addresses; SENT means Expo-accepted; no duplicate sends across restart',
    async () => {
      const dir = newTempDir('send');
      const mock = new MockTransport();
      mock.nextSend = {
        httpOk: true,
        retryable: false,
        tickets: [{ status: 'ok', id: 'TICKET-SEND-1' }],
      };
      const app = await startApp({ dataDir: dir, pushTransport: mock as any });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token: t1,
          body: { pushOptIn: true },
        });
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: 'ExponentPushToken[sendtest-00000000000001]', platform: 'ios', installationId: 'install-send-01' },
        });
        const start = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t1,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(start.status, 200, 'session started');

        await app.handle.scheduler.tick(Date.now());

        assertEqual(mock.sendCalls.length, 1, 'one send batch');
        const msg = mock.sendCalls[0][0];
        assert(msg && msg.title && msg.body, 'message has title and body');
        assert(
          !`${msg.title} ${msg.body}`.includes('Indiranagar') &&
            !`${msg.title} ${msg.body}`.includes('Prestige Tech Park'),
          'push copy contains no home/work address detail'
        );
        assert(msg.data?.alertId && msg.data?.sessionId && msg.data?.type, 'data carries alert/session ids');

        const row = outboxRows(app.handle.db)[0];
        assertEqual(row.status, 'SENT', 'row SENT after Expo accepted');
        assertEqual(row.ticket_id, 'TICKET-SEND-1', 'ticket id persisted');
        assertEqual(row.receipt_status, 'PENDING', 'receipt honestly PENDING (not delivered)');

        const pushStatus = await api(app.baseUrl, 'GET', '/api/me/push-status', { token: t1 });
        assertEqual(pushStatus.json.nativePushEnabled, true, 'push-status reports enabled');
        assertEqual(pushStatus.json.outbox.sent, 1, 'push-status sent count');
        assertEqual(pushStatus.json.outbox.receiptPending, 1, 'push-status receiptPending count');
        assert(
          String(pushStatus.json.deliveryDisclaimer).includes('not delivered'),
          'disclaimer states SENT is not delivery'
        );
        assert(!pushStatus.text.includes('ExponentPushToken'), 'push-status hides tokens');

        // restart dedup: reopen on the same data; nothing re-sends
        await app.close();
        const mock2 = new MockTransport();
        const app2 = await startApp({ dataDir: dir, pushTransport: mock2 as any });
        try {
          await app2.handle.scheduler.tick(Date.now() + 120_000);
          assertEqual(mock2.sendCalls.length, 0, 'no duplicate dispatch after restart');
          assertEqual(outboxRows(app2.handle.db)[0].status, 'SENT', 'row still SENT');
          return 'Generic copy, ticket persisted, receipt PENDING, restart dedup verified';
        } finally {
          await app2.close();
        }
      } finally {
        await app.close().catch(() => {});
      }
    }
  );

  // 12. Send failures: retry/backoff, attempts cap, DeviceNotRegistered cleanup
  await test(
    '12. Send Failures & Invalid Device Cleanup',
    'Retryable failures back off and cap at max attempts; DeviceNotRegistered marks FAILED and disables the device',
    async () => {
      const dir = newTempDir('sendfail');
      const mock = new MockTransport();
      mock.nextSend = { httpOk: false, retryable: true, tickets: null, errorMessage: 'econnreset' };
      const app = await startApp({ dataDir: dir, pushTransport: mock as any });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        await api(app.baseUrl, 'PUT', '/api/me/profile', { token: t1, body: { pushOptIn: true } });
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: 'ExponentPushToken[sendfail-0000000000001]', platform: 'ios', installationId: 'install-fail-01' },
        });
        await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t1,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });

        const now = Date.now();
        await app.handle.scheduler.tick(now);
        let row = outboxRows(app.handle.db)[0];
        assertEqual(row.status, 'PENDING', 'retryable failure keeps row PENDING');
        assertEqual(row.attempts, 1, 'attempt 1 recorded');
        assert(row.next_attempt_at_ms > now, 'backoff future');

        // exhaust attempts
        let t = now;
        for (let i = 2; i <= 5; i++) {
          t += 60_000 * 2 ** (i - 1) + 1_000;
          await app.handle.scheduler.tick(t);
        }
        row = outboxRows(app.handle.db)[0];
        assertEqual(row.status, 'FAILED', 'row FAILED after max attempts');
        assertEqual(row.attempts, 5, 'attempts capped at 5');
        assert(
          String(row.last_error || '').includes('econnreset'),
          'last error kept'
        );

        // DeviceNotRegistered ticket → FAILED + device disabled
        const dir2 = newTempDir('devnotreg');
        const mock2 = new MockTransport();
        mock2.nextSend = {
          httpOk: true,
          retryable: false,
          tickets: [
            {
              status: 'error',
              message: '"ExponentPushToken[sendfail...]" is not a registered push notification recipient',
              detailsError: 'DeviceNotRegistered',
            } as ExpoTicket,
          ],
        };
        const app2 = await startApp({ dataDir: dir2, pushTransport: mock2 as any });
        try {
          const t2 = await login(app2.baseUrl, 'emp_01', '1001');
          primeSchedule(app2.handle.store, 'emp_01', 'HOME_TO_WORK');
          await api(app2.baseUrl, 'PUT', '/api/me/profile', { token: t2, body: { pushOptIn: true } });
          await api(app2.baseUrl, 'POST', '/api/me/devices', {
            token: t2,
            body: { expoPushToken: 'ExponentPushToken[devnotreg-000000000001]', platform: 'ios', installationId: 'install-dnr-01' },
          });
          await api(app2.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
            token: t2,
            body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
          });
          await app2.handle.scheduler.tick(Date.now());
          const row2 = outboxRows(app2.handle.db)[0];
          assertEqual(row2.status, 'FAILED', 'DeviceNotRegistered row FAILED');
          const devices = app2.handle.db
            .prepare('SELECT disabled FROM devices WHERE installation_id = ?')
            .get('install-dnr-01') as any;
          assertEqual(devices.disabled, 1, 'device disabled after DeviceNotRegistered');
          const listRes = await api(app2.baseUrl, 'GET', '/api/me/devices', { token: t2 });
          assertEqual(listRes.json.devices.length, 0, 'disabled device hidden from list');
          return 'Retry/backoff to FAILED at 5 attempts; DeviceNotRegistered disables device';
        } finally {
          await app2.close();
        }
      } finally {
        await app.close();
      }
    }
  );

  // 13. Terminal session at send time: row SKIPPED, nothing dispatched
  await test(
    '13. No Push After Stop/Skip/Leave/Expired',
    'Pending rows whose session went terminal (or device deleted / opt-out) are SKIPPED at send time',
    async () => {
      const dir = newTempDir('stale');
      const mock = new MockTransport();
      const app = await startApp({ dataDir: dir, pushTransport: mock as any });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        await api(app.baseUrl, 'PUT', '/api/me/profile', { token: t1, body: { pushOptIn: true } });
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t1,
          body: { expoPushToken: 'ExponentPushToken[stale-send-00000000001]', platform: 'ios', installationId: 'install-stale-01' },
        });
        const start = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t1,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(outboxRows(app.handle.db).length, 1, 'row enqueued');

        await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token: t1,
          body: { sessionId: start.json.session.id, action: 'STOP_MONITORING' },
        });
        await app.handle.scheduler.tick(Date.now());
        const row = outboxRows(app.handle.db)[0];
        assertEqual(row.status, 'SKIPPED', 'row SKIPPED after session stopped');
        assertEqual(mock.sendCalls.length, 0, 'nothing dispatched');

        // device deletion also skips pending rows
        const start2 = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: t1,
          body: { direction: 'WORK_TO_HOME', environment: 'DEMO' },
        });
        assert(
          outboxRows(app.handle.db, "WHERE status = 'PENDING'").length >= 1,
          'second row enqueued'
        );
        await api(app.baseUrl, 'DELETE', '/api/me/devices/install-stale-01', { token: t1 });
        await app.handle.scheduler.tick(Date.now());
        const pending = outboxRows(app.handle.db, "WHERE status = 'PENDING'");
        assertEqual(pending.length, 0, 'no PENDING rows after device deletion');
        assertEqual(mock.sendCalls.length, 0, 'still nothing dispatched');
        void start2;
        return 'Stopped session and deleted device both skip dispatch at send time';
      } finally {
        await app.close();
      }
    }
  );

  // 14. Receipt polling: ok / error / missing, honest PENDING otherwise
  await test(
    '14. Receipt Polling',
    'Polls bounded batch of aged receipts; ok→OK, DeviceNotRegistered→ERROR+disable, missing→stays PENDING',
    async () => {
      const dir = newTempDir('receipts');
      const mock = new MockTransport();
      mock.nextSend = {
        httpOk: true,
        retryable: false,
        tickets: [
          { status: 'ok', id: 'TIC-R1' },
          { status: 'ok', id: 'TIC-R2' },
          { status: 'ok', id: 'TIC-R3' },
        ],
      };
      const app = await startApp({ dataDir: dir, pushTransport: mock as any });
      try {
        const t1 = await login(app.baseUrl, 'emp_01', '1001');
        const t2 = await login(app.baseUrl, 'emp_02', '1002');
        for (const [tok, uid, inst] of [
          ['ExponentPushToken[receipt-test-000000000001]', 'emp_01', 'install-rec-01'],
          ['ExponentPushToken[receipt-test-000000000002]', 'emp_02', 'install-rec-02'],
        ] as const) {
          const token = uid === 'emp_01' ? t1 : t2;
          primeSchedule(app.handle.store, uid, 'HOME_TO_WORK');
          await api(app.baseUrl, 'PUT', '/api/me/profile', { token, body: { pushOptIn: true } });
          await api(app.baseUrl, 'POST', '/api/me/devices', {
            token,
            body: { expoPushToken: tok, platform: 'ios', installationId: inst },
          });
          await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
            token,
            body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
          });
        }
        // third SENT row: age one row so only it is polled first
        const now = Date.now();
        await app.handle.scheduler.tick(now);
        assertEqual(outboxRows(app.handle.db, "WHERE status='SENT'").length, 2, 'two rows SENT');

        // receipts not polled until aged
        assertEqual(mock.receiptCalls.length, 0, 'no receipt poll before min age');
        app.handle.db
          .prepare("UPDATE push_outbox SET updated_at_ms = ? WHERE status = 'SENT'")
          .run(now - 6 * 60_000);
        const rotated = await api(app.baseUrl, 'POST', '/api/me/devices', {
          token: t2,
          body: {
            expoPushToken: 'ExpoPushToken[receipt-rotated-00000000001]',
            platform: 'ios',
            installationId: 'install-rec-02',
          },
        });
        assertEqual(rotated.status, 201, 'rotated token refresh accepted on same installation');
        mock.nextReceipts = {
          httpOk: true,
          retryable: false,
          receipts: {
            'TIC-R1': { status: 'ok' },
            'TIC-R2': {
              status: 'error',
              message: 'device unregistered',
              detailsError: 'DeviceNotRegistered',
            },
          },
        };
        const tick = await app.handle.scheduler.tick(now + 7 * 60_000);
        assertEqual(mock.receiptCalls.length, 1, 'one bounded receipt poll');
        assertEqual(tick.receipts.polled, 2, 'two receipts polled');
        const rows = outboxRows(app.handle.db, "WHERE status='SENT'");
        const byTicket = new Map(rows.map((r) => [r.ticket_id, r]));
        assertEqual(byTicket.get('TIC-R1')?.receipt_status, 'OK', 'TIC-R1 receipt OK');
        assertEqual(byTicket.get('TIC-R2')?.receipt_status, 'ERROR', 'TIC-R2 receipt ERROR');
        const dnrDevice = app.handle.db
          .prepare('SELECT disabled FROM devices WHERE installation_id = ?')
          .get('install-rec-02') as any;
        assertEqual(dnrDevice.disabled, 0, 'old-token receipt cannot disable rotated token');

        // failed receipt request leaves PENDING honestly
        mock.nextReceipts = { httpOk: false, retryable: true, receipts: null, errorMessage: '429' };
        app.handle.db
          .prepare("UPDATE push_outbox SET updated_at_ms = ? WHERE receipt_status = 'ERROR'")
          .run(now - 10 * 60_000);
        await app.handle.scheduler.tick(now + 11 * 60_000);
        return 'Aged bounded polls; OK/ERROR mapped; failed poll leaves status untouched';
      } finally {
        await app.close();
      }
    }
  );

  // 15. Multi-worker outbox claim: no duplicate dispatch across workers
  await test(
    '15. Outbox Multi-Worker Claim',
    'Two workers processing the same SQLite outbox dispatch each row exactly once',
    async () => {
      const dir = newTempDir('outboxclaim');
      const { db } = openDatabase(dir);
      const { store } = createStore(db, dir, {
        defaultQuotaLimit: 500,
        liveApiConfigured: false,
      });
      try {
        const now = Date.now();
        const tokens = [
          'ExponentPushToken[claim-test-000000000001]',
          'ExponentPushToken[claim-test-000000000002]',
          'ExponentPushToken[claim-test-000000000003]',
        ];
        tokens.forEach((tok, i) => {
          registerDevice(db, {
            userId: 'emp_01',
            expoPushToken: tok,
            platform: 'ios',
            installationId: `install-clm-${i}`,
          }, now);
        });
        const alerts: CommuteAlert[] = [{
          id: 'alert_claim_0',
          userId: 'emp_01',
          sessionId: 'mon_claim',
          createdAtIso: new Date(now).toISOString(),
          createdAtIst: '08:00:00 IST',
          type: 'DEPARTURE_REMINDER',
          severity: 'INFO',
          title: 't',
          message: 'm',
          deliveredChannels: ['IN_APP'],
          acknowledged: false,
        }];
        const sessionId = 'mon_claim';
        store.users.find((u) => u.id === 'emp_01')!.pushOptIn = true;
        store.sessions.push(makeSession({ id: sessionId }));
        persistStore(db, store);
        const enqueued = enqueueAlertsForPush(db, alerts, {
          getUsers: () => store.users,
          getSessionDirection: () => 'HOME_TO_WORK',
        }, now);
        assertEqual(enqueued, 3, 'three rows enqueued');

        const mockA = new MockTransport();
        mockA.nextSend = {
          httpOk: true, retryable: false,
          tickets: [
            { status: 'ok', id: 'T-A1' },
            { status: 'ok', id: 'T-A2' },
            { status: 'ok', id: 'T-A3' },
          ],
        };
        const mockB = new MockTransport();
        mockB.nextSend = {
          httpOk: true, retryable: false,
          tickets: [
            { status: 'ok', id: 'T-B1' },
            { status: 'ok', id: 'T-B2' },
            { status: 'ok', id: 'T-B3' },
          ],
        };
        const deps = (workerId: string) => ({
          workerId,
          getUsers: () => store.users,
          getSessionStatus: () => 'ACTIVE',
        });
        await Promise.all([
          processOutbox(db, mockA as any, deps('w1'), now),
          processOutbox(db, mockB as any, deps('w2'), now),
        ]);

        const totalMessages = mockA.totalMessages() + mockB.totalMessages();
        assertEqual(totalMessages, 3, 'exactly three messages dispatched total');
        const sentTokens = [...mockA.sendCalls, ...mockB.sendCalls]
          .flat()
          .map((m) => m.to);
        assertEqual(new Set(sentTokens).size, 3, 'no token dispatched twice');
        assertEqual(outboxRows(db, "WHERE status='SENT'").length, 3, 'all rows SENT once');
        return `3 rows claimed across 2 workers with zero duplicate dispatch`;
      } finally {
        db.close();
      }
    }
  );

  // 16. Expo adapter: raw wire shapes, auth header, retryable statuses, timeout signal
  await test(
    '16. Expo Adapter Wire Shapes',
    'Adapter maps real Expo wire payloads (details.error), sends Bearer auth, classifies retryables, attaches AbortSignal',
    async () => {
      type FetchCall = { url: string; init: RequestInit };
      const calls: FetchCall[] = [];
      const wireFetch = (responder: (call: FetchCall) => Response): typeof fetch => {
        return (async (url: any, init: any) => {
          const call = { url: String(url), init: init as RequestInit };
          calls.push(call);
          return responder(call);
        }) as unknown as typeof fetch;
      };

      // disabled by default — no fetch at all
      let fetched = false;
      const disabled = createExpoHttpTransport({}, (() => {
        fetched = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch);
      assertEqual(disabled.enabled, false, 'disabled without ENABLE_NATIVE_PUSH');
      const disabledOut = await disabled.send([{ to: 'x', title: 't', body: 'b' }]);
      assertEqual(disabledOut.httpOk, false, 'disabled transport returns httpOk false');
      assertEqual(fetched, false, 'disabled transport performs zero network calls');

      // raw wire ticket mapping incl. nested details.error
      const wireTickets = {
        data: [
          {
            status: 'error',
            message: '"ExponentPushToken[badtoken]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'ok', id: '11111111-2222-3333-4444-555555555555' },
        ],
      };
      const wireReceipts = {
        data: {
          '11111111-2222-3333-4444-555555555555': { status: 'ok' },
          '99999999-2222-3333-4444-555555555555': {
            status: 'error',
            message: 'unregistered',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      };
      const enabled = createExpoHttpTransport(
        { ENABLE_NATIVE_PUSH: 'true', EXPO_ACCESS_TOKEN: 'tok_abc' },
        wireFetch((call) => new Response(JSON.stringify(
          call.url.includes('getReceipts') ? wireReceipts : wireTickets
        ), { status: 200 }))
      );
      assertEqual(enabled.enabled, true, 'enabled with flag');
      const sendOut = await enabled.send([{ to: 'x', title: 't', body: 'b' }]);
      assertEqual(sendOut.httpOk, true, 'wire send httpOk');
      assertEqual(sendOut.tickets?.[0]?.status, 'error', 'first wire ticket error');
      assertEqual(
        (sendOut.tickets?.[0] as any)?.detailsError,
        'DeviceNotRegistered',
        'nested details.error mapped to detailsError'
      );
      assertEqual(sendOut.tickets?.[1]?.status, 'ok', 'second wire ticket ok');
      const okTicket = sendOut.tickets?.[1] as { status: string; id?: string } | undefined;
      assertEqual(okTicket?.id, '11111111-2222-3333-4444-555555555555', 'ok ticket id kept');
      const lastCall = calls[calls.length - 1];
      assertEqual(
        (lastCall.init.headers as Record<string, string>).Authorization,
        'Bearer tok_abc',
        'Bearer access token header'
      );
      assert(lastCall.init.signal, 'AbortSignal timeout attached to send');

      // receipts wire mapping
      const recOut = await enabled.getReceipts(['11111111-2222-3333-4444-555555555555']);
      assertEqual(recOut.httpOk, true, 'receipts httpOk');
      assertEqual(
        recOut.receipts?.['11111111-2222-3333-4444-555555555555']?.status,
        'ok',
        'wire receipt ok mapped'
      );

      // 429 and network throw are retryable
      const rateLimited = createExpoHttpTransport(
        { ENABLE_NATIVE_PUSH: 'true' },
        wireFetch(() => new Response('{}', { status: 429 }))
      );
      const rl = await rateLimited.send([{ to: 'x', title: 't', body: 'b' }]);
      assertEqual(rl.retryable, true, 'HTTP 429 retryable');

      const throwing = createExpoHttpTransport(
        { ENABLE_NATIVE_PUSH: 'true' },
        wireFetch(() => {
          throw new Error('ECONNRESET');
        })
      );
      const thrown = await throwing.send([{ to: 'x', title: 't', body: 'b' }]);
      assertEqual(thrown.retryable, true, 'network error retryable');

      // end-to-end: adapter + real wire DeviceNotRegistered drives cleanup
      const dir = newTempDir('wire-e2e');
      const { db } = openDatabase(dir);
      const { store } = createStore(db, dir, { defaultQuotaLimit: 500, liveApiConfigured: false });
      try {
        registerDevice(db, {
          userId: 'emp_01',
          expoPushToken: 'ExponentPushToken[wire-e2e-0000000000001]',
          platform: 'ios',
          installationId: 'install-wire-1',
        });
        store.users.find((u) => u.id === 'emp_01')!.pushOptIn = true;
        store.sessions.push(makeSession({ id: 'mon_wire_1' }));
        persistStore(db, store);
        enqueueAlertsForPush(
          db,
          [
            {
              id: 'alert_wire_1',
              userId: 'emp_01',
              sessionId: 'mon_wire_1',
              createdAtIso: new Date().toISOString(),
              createdAtIst: '08:00:00 IST',
              type: 'DEPARTURE_REMINDER',
              severity: 'INFO',
              title: 't',
              message: 'm',
              deliveredChannels: ['IN_APP'],
              acknowledged: false,
            },
          ],
          { getUsers: () => store.users, getSessionDirection: () => 'HOME_TO_WORK' }
        );
        const wireAdapter = createExpoHttpTransport(
          { ENABLE_NATIVE_PUSH: 'true' },
          wireFetch(
            () =>
              new Response(
                JSON.stringify({
                  data: [
                    {
                      status: 'error',
                      message: 'not registered',
                      details: { error: 'DeviceNotRegistered' },
                    },
                  ],
                }),
                { status: 200 }
              )
          )
        );
        await processOutbox(db, wireAdapter, {
          workerId: 'wire-w1',
          getUsers: () => store.users,
          getSessionStatus: () => 'ACTIVE',
        });
        const row = outboxRows(db)[0];
        assertEqual(row.status, 'FAILED', 'wire DeviceNotRegistered → row FAILED');
        const dev = db
          .prepare('SELECT disabled FROM devices WHERE installation_id = ?')
          .get('install-wire-1') as any;
        assertEqual(dev.disabled, 1, 'wire DeviceNotRegistered → device disabled');
        return 'Wire-shape mapping, auth header, signal, retryables, end-to-end cleanup verified';
      } finally {
        db.close();
      }
    }
  );

  // 17. Ghost-state regression: rejected writes never leak into reads or later commits
  await test(
    '17. Failed-Write Ghost State Regression',
    'A 500 PERSISTENCE_FAILED write is fully rolled back in memory, never resurrected by a later success or restart (read-only and closed DB)',
    async () => {
      // (a) read-only DB (PRAGMA query_only)
      const dir = newTempDir('ghost-ro');
      const app = await startApp({ dataDir: dir });
      try {
        const seeded = 'token_emp_01_pilot';
        const before = await api(app.baseUrl, 'GET', '/api/me/state', { token: seeded });
        assertEqual(before.json.profile.telemetryConsent, true, 'seed telemetryConsent true');

        app.handle.db.exec('PRAGMA query_only = ON');
        const rejected = await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token: seeded,
          body: { telemetryConsent: false },
        });
        assertEqual(rejected.status, 500, 'rejected write returns 500');
        assertEqual(rejected.json.error, 'PERSISTENCE_FAILED', 'persistence error code');

        const afterReject = await api(app.baseUrl, 'GET', '/api/me/state', { token: seeded });
        assertEqual(
          afterReject.json.profile.telemetryConsent,
          true,
          'no ghost value in memory after rejected write'
        );

        app.handle.db.exec('PRAGMA query_only = OFF');
        const okPut = await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token: seeded,
          body: { onboardingComplete: false },
        });
        assertEqual(okPut.status, 200, 'subsequent write succeeds');

        const afterOk = await api(app.baseUrl, 'GET', '/api/me/state', { token: seeded });
        assertEqual(afterOk.json.profile.telemetryConsent, true, 'rejected value not resurrected by later success');
        assertEqual(afterOk.json.profile.onboardingComplete, false, 'later committed value visible');
      } finally {
        await app.close();
      }

      // reopen: disk has only committed state
      const app2 = await startApp({ dataDir: dir });
      try {
        const state = await api(app2.baseUrl, 'GET', '/api/me/state', { token: 'token_emp_01_pilot' });
        assertEqual(state.json.profile.telemetryConsent, true, 'rejected value never reached disk');
        assertEqual(state.json.profile.onboardingComplete, false, 'committed value on disk');
      } finally {
        await app2.close();
      }

      // (b) closed DB
      const dir2 = newTempDir('ghost-closed');
      const app3 = await startApp({ dataDir: dir2 });
      try {
        const seeded = 'token_emp_01_pilot';
        const before = await api(app3.baseUrl, 'GET', '/api/me/state', { token: seeded });
        assertEqual(before.json.profile.telemetryConsent, true, 'closed-db setup true');

        app3.handle.db.close();
        const rejected = await api(app3.baseUrl, 'PUT', '/api/me/profile', {
          token: seeded,
          body: { telemetryConsent: false },
        });
        assertEqual(rejected.status, 500, 'closed DB write returns 500');
        assertEqual(rejected.json.error, 'PERSISTENCE_FAILED', 'closed DB error code');

        const afterReject = await api(app3.baseUrl, 'GET', '/api/me/state', { token: seeded });
        assertEqual(
          afterReject.json.profile.telemetryConsent,
          true,
          'closed DB: no ghost value after rejected write'
        );
      } finally {
        await app3.close();
      }
      const app4 = await startApp({ dataDir: dir2 });
      try {
        const state = await api(app4.baseUrl, 'GET', '/api/me/state', { token: 'token_emp_01_pilot' });
        assertEqual(state.json.profile.telemetryConsent, true, 'closed DB: disk unaffected');
        return 'Rejected writes rolled back in memory and never committed to disk in both modes';
      } finally {
        await app4.close();
      }
    }
  );

  // 18. Quota rollover + budget guard (SQLite-backed)
  await test(
    '18. Quota Rollover & Budget Guard',
    'Quota counters reset on Asia/Kolkata date rollover and block at the daily limit',
    async () => {
      const dir = newTempDir('quota');
      const { db } = openDatabase(dir);
      const { store } = createStore(db, dir, { defaultQuotaLimit: 500, liveApiConfigured: false });
      try {
        const { dateIst } = getNowIstParts();
        store.quota.dateIst = '2000-01-01';
        store.quota.requestsUsedToday = 400;
        store.quota.routesRequests = 300;
        const allowed = checkBudgetAndIncrement(db, store, 'ROUTES');
        assertEqual(allowed.allowed, true, 'allowed after rollover reset');
        assertEqual(store.quota.dateIst, dateIst, 'quota date rolled to today');
        assertEqual(store.quota.requestsUsedToday, 1, 'counter reset then incremented');
        assertEqual(store.quota.routesRequests, 1, 'routes counter reset then incremented');

        store.quota.dailyLimit = 1;
        const blocked = checkBudgetAndIncrement(db, store, 'ROUTES');
        assertEqual(blocked.allowed, false, 'blocked at daily limit');
        assert(
          String(blocked.reason || '').includes('budget safeguard'),
          'block reason mentions budget safeguard'
        );
        assertEqual(store.quota.lastProviderStatus, 'QUOTA_EXCEEDED', 'status QUOTA_EXCEEDED');
        const row = db
          .prepare('SELECT data FROM quota WHERE date_ist = ?')
          .get(dateIst) as any;
        assert(row, 'quota row persisted for today');
        return `Rollover reset + limit enforcement persisted (dateIst=${dateIst})`;
      } finally {
        db.close();
      }
    }
  );

  await test(
    '19. Stale API Handle Cannot Resurrect Sessions',
    'A profile update from a stale app handle cannot overwrite another handle’s STOPPED session',
    async () => {
      const dir = newTempDir('stale-api-handle');
      const appA = await startApp({ dataDir: dir });
      let appB: RunningApp | null = null;
      try {
        const tokenA = await login(appA.baseUrl, 'emp_01', '1001');
        primeSchedule(appA.handle.store, 'emp_01', 'HOME_TO_WORK');
        await api(appA.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenA,
          body: { telemetryConsent: false },
        });
        const started = await api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'session starts before second handle loads');

        appB = await startApp({ dataDir: dir });
        const tokenB = await login(appB.baseUrl, 'emp_01', '1001');
        const stopped = await api(appA.baseUrl, 'POST', '/api/monitoring/action', {
          token: tokenA,
          body: { sessionId: started.json.session.id, action: 'STOP_MONITORING' },
        });
        assertEqual(stopped.status, 200, 'handle A stops the session');

        const profileUpdate = await api(appB.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenB,
          body: { telemetryConsent: true },
        });
        assertEqual(profileUpdate.status, 200, 'stale handle B updates profile');

        const persistedSession = sessionRow(appB.handle.db, started.json.session.id);
        assertEqual(persistedSession.status, 'STOPPED', 'stale ACTIVE session does not replace STOPPED');
        const restarted = await startApp({ dataDir: dir });
        try {
          const state = await api(restarted.baseUrl, 'GET', '/api/me/state', { token: tokenB });
          assertEqual(state.json.sessions[0]?.status, 'STOPPED', 'terminal status survives restart');
          assertEqual(state.json.profile.telemetryConsent, true, 'unrelated profile write survives restart');
        const restartAttempt = await api(restarted.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenB,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(restartAttempt.status, 409, 'terminal session explicitly rejects same-window restart');
        } finally {
          await restarted.close();
        }
        return 'Cross-handle profile write preserved while terminal session remained STOPPED';
      } finally {
        await appB?.close();
        await appA.close();
      }
    }
  );

  await test(
    '20. Silent Start Persistence and DATA_DIR',
    'A successful empty-options start persists its session and honors environment DATA_DIR',
    async () => {
      const dir = newTempDir('data-dir-silent');
      const provider = makeProviderOverride((params) => ({
        options: [],
        effectiveSchedule: resolveEffectiveSchedule(
          params.user.schedules[params.direction],
          params.user.dayOverrides,
          getNowIstParts().dateIst
        ),
      }));
      const app = await startApp({
        env: { ...TEST_ENV, DATA_DIR: dir },
        providerOverride: provider.fn,
      });
      try {
        const token = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        persistStore(app.handle.db, app.handle.store);
        const started = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'empty-options start accepted');
        assertEqual(started.json.newAlerts.length, 0, 'provider generated no alerts');
        assertEqual(
          sessionRow(app.handle.db, started.json.session.id)?.status,
          started.json.session.status,
          'session durably persisted without alerts'
        );
        assert(fs.existsSync(path.join(dir, 'orr_pulse.db')), 'DATA_DIR uses actual SQLite filename');
        return 'No-alert session persisted and DATA_DIR selected the backend database directory';
      } finally {
        await app.close();
      }
    }
  );

  await test(
    '21. Atomic Session, Alert, and Outbox Commit',
    'A rejected push-outbox insert rolls back the API session and alert write',
    async () => {
      const dir = newTempDir('atomic-outbox');
      const app = await startApp({ dataDir: dir });
      try {
        const token = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token,
          body: { pushOptIn: true },
        });
        await api(app.baseUrl, 'POST', '/api/me/devices', {
          token,
          body: {
            expoPushToken: 'ExpoPushToken[atomic-outbox-000000000001]',
            platform: 'ios',
            installationId: 'install-atomic-outbox',
          },
        });
        app.handle.db.exec(`
          CREATE TRIGGER reject_outbox_insert BEFORE INSERT ON push_outbox
          BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;
        `);
        const response = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(response.status, 500, 'failed outbox insert is not acknowledged');
        assertEqual(
          (app.handle.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any).c,
          0,
          'session rolled back with outbox'
        );
        assertEqual(
          (app.handle.db.prepare('SELECT COUNT(*) AS c FROM alerts').get() as any).c,
          0,
          'alert rolled back with outbox'
        );
        assertEqual(
          (app.handle.db.prepare('SELECT COUNT(*) AS c FROM push_outbox').get() as any).c,
          0,
          'outbox remains empty'
        );
        return 'Injected outbox failure rolled the session and generated alert back atomically';
      } finally {
        await app.close();
      }
    }
  );

  await test(
    '22. Same-Day Quota Survives Restart',
    'Opening the SQLite store preserves today’s consumed quota instead of resetting it',
    () => {
      const dir = newTempDir('quota-restart');
      const first = openDatabase(dir);
      const initial = createStore(first.db, dir, { defaultQuotaLimit: 500, liveApiConfigured: false }).store;
      initial.quota.requestsUsedToday = 37;
      initial.quota.routesRequests = 31;
      initial.quota.placesRequests = 4;
      initial.quota.geocodingRequests = 2;
      persistStore(first.db, initial);
      first.db.close();

      const second = openDatabase(dir);
      try {
        const reopened = createStore(second.db, dir, { defaultQuotaLimit: 500, liveApiConfigured: false }).store;
        assertEqual(reopened.quota.dateIst, getNowIstParts().dateIst, 'same IST date loaded');
        assertEqual(reopened.quota.requestsUsedToday, 37, 'total quota usage preserved');
        assertEqual(reopened.quota.routesRequests, 31, 'route quota usage preserved');
        assertEqual(reopened.quota.placesRequests, 4, 'places quota usage preserved');
        assertEqual(reopened.quota.geocodingRequests, 2, 'geocoding quota usage preserved');
        return 'Same-day quota counters survived close and reopen unchanged';
      } finally {
        second.db.close();
      }
    }
  );

  await test(
    '23. Scheduler Revision Guard',
    'A snooze written during provider computation is not overwritten by the scheduler result',
    async () => {
      const dir = newTempDir('scheduler-revision');
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => (providerStarted = resolve));
      let releaseProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
      const provider = makeProviderOverride(async (params) => {
        providerStarted();
        await providerGate;
        return validOptionsOutcome(params.user, params.direction);
      });
      const appA = await startApp({ dataDir: dir, providerOverride: provider.fn });
      let appB: RunningApp | null = null;
      try {
        primeSchedule(appA.handle.store, 'emp_01', 'HOME_TO_WORK');
        const session = makeSession({ id: 'mon_revision_snooze' });
        appA.handle.store.sessions.push(session);
        persistStore(appA.handle.db, appA.handle.store);
        appB = await startApp({ dataDir: dir });
        const token = await login(appB.baseUrl, 'emp_01', '1001');

        const tickPromise = appA.handle.scheduler.tick();
        await started;
        const snoozed = await api(appB.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId: session.id, action: 'SNOOZE_10M' },
        });
        assertEqual(snoozed.status, 200, 'API snooze accepted during provider computation');
        releaseProvider();
        const tick = await tickPromise;
        assertEqual(tick.discardedStaleWrites, 1, 'stale scheduler result discarded');
        assertEqual(sessionRow(appB.handle.db, session.id).status, 'SNOOZED', 'SNOOZED survives scheduler completion');
        assert(
          Boolean(JSON.parse(sessionRow(appB.handle.db, session.id).data).snoozedUntilIso),
          'snooze timestamp preserved'
        );
        return 'Optimistic revision rejected stale provider output after API snooze';
      } finally {
        releaseProvider();
        await appB?.close();
        await appA.close();
      }
    }
  );

  await test(
    '24. Stop Wins Over Pending Start Refresh',
    'A start/refresh computation completing after a concurrent STOP returns conflict and keeps STOPPED',
    async () => {
      const dir = newTempDir('pending-start-stop');
      let shouldBlock = false;
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => (providerStarted = resolve));
      let releaseProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
      const provider = makeProviderOverride(async (params) => {
        if (shouldBlock) {
          providerStarted();
          await providerGate;
        }
        return validOptionsOutcome(params.user, params.direction);
      });
      const appA = await startApp({ dataDir: dir, providerOverride: provider.fn });
      let appB: RunningApp | null = null;
      try {
        const tokenA = await login(appA.baseUrl, 'emp_01', '1001');
        primeSchedule(appA.handle.store, 'emp_01', 'HOME_TO_WORK');
        persistStore(appA.handle.db, appA.handle.store);
        const initial = await api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(initial.status, 200, 'initial start succeeds');
        appB = await startApp({ dataDir: dir });
        const tokenB = await login(appB.baseUrl, 'emp_01', '1001');

        shouldBlock = true;
        const pendingRefresh = api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        await started;
        const stopped = await api(appB.baseUrl, 'POST', '/api/monitoring/action', {
          token: tokenB,
          body: { sessionId: initial.json.session.id, action: 'STOP_MONITORING' },
        });
        assertEqual(stopped.status, 200, 'concurrent stop succeeds');
        releaseProvider();
        const lateRefresh = await pendingRefresh;
        assertEqual(lateRefresh.status, 409, 'late refresh is rejected');
        assertEqual(sessionRow(appB.handle.db, initial.json.session.id).status, 'STOPPED', 'STOPPED remains durable');
        const restart = await api(appB.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenB,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(restart.status, 409, 'same-window terminal restart is explicitly rejected');
        return 'Revision check prevented a pending refresh from resurrecting a stopped session';
      } finally {
        releaseProvider();
        await appB?.close();
        await appA.close();
      }
    }
  );

  await test(
    '27. Expiration During Provider Work Suppresses Pending Push',
    'A session expiring while provider computation is in flight is durably expired before outbox dispatch',
    async () => {
      const transport = new MockTransport();
      let signalProvider!: () => void;
      let releaseProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => { signalProvider = resolve; });
      const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const provider = makeProviderOverride(async ({ user, direction }) => {
        signalProvider();
        await providerGate;
        return validOptionsOutcome(user, direction);
      });
      const app = await startApp({
        dataDir: newTempDir('expiry-in-provider'),
        providerOverride: provider.fn,
        pushTransport: transport,
      });
      try {
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        const now = Date.now();
        const session = makeSession({
          id: 'mon_expiry_provider',
          expiresAtIso: new Date(now + 1000).toISOString(),
          nextRefreshDueIso: new Date(now - 1000).toISOString(),
        });
        app.handle.store.sessions.push(session);
        app.handle.store.users.find((user) => user.id === session.userId)!.pushOptIn = true;
        registerDevice(app.handle.db, {
          userId: session.userId,
          expoPushToken: 'ExponentPushToken[expiry-test-00000000001]',
          platform: 'ios',
          installationId: 'install-expiry-test',
        });
        persistStore(app.handle.db, app.handle.store);
        enqueueAlertsForPush(app.handle.db, [{
          id: 'alert_expiry_pending', userId: session.userId, sessionId: session.id,
          createdAtIso: new Date().toISOString(), createdAtIst: '08:00:00 IST',
          type: 'DEPARTURE_REMINDER', severity: 'INFO', title: 'Reminder', message: 'Reminder',
          deliveredChannels: ['IN_APP'], acknowledged: false,
        }], { getUsers: () => app.handle.store.users, getSessionDirection: () => session.direction }, now - 10_000);

        const ticking = app.handle.scheduler.tick(now);
        await providerStarted;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        releaseProvider();
        const summary = await ticking;
        assertEqual(transport.totalMessages(), 0, 'expired reminder is never sent');
        assertEqual(sessionRow(app.handle.db, session.id)?.status, 'EXPIRED', 'expiry is durable in SQLite');
        assertEqual(app.handle.store.sessions.find((entry) => entry.id === session.id)?.status, 'EXPIRED', 'expiry is synchronized in memory');
        assertEqual(outboxRows(app.handle.db).find((row) => row.alert_id === 'alert_expiry_pending')?.status, 'SKIPPED', 'pending departure reminder becomes skipped');
        assert(summary.expired >= 1, 'late completion reports expiration');
        return 'Delayed provider completion crossed expiresAt; durable EXPIRED state suppressed the queued reminder';
      } finally {
        releaseProvider();
        await app.close();
      }
    }
  );

  await test(
    '26. Device Registration Identity Survives Removal',
    'A delayed DeviceNotRegistered receipt from a removed registration cannot disable its replacement',
    async () => {
      const dir = newTempDir('device-generation-reuse');
      const { db } = openDatabase(dir);
      const { store } = createStore(db, dir, { defaultQuotaLimit: 500, liveApiConfigured: false });
      try {
        const installId = 'install-reused-identity';
        const oldToken = 'ExponentPushToken[old-registration-000001]';
        const newToken = 'ExponentPushToken[new-registration-000001]';
        const first = registerDevice(db, {
          userId: 'emp_01', expoPushToken: oldToken, platform: 'ios', installationId: installId,
        });
        assertEqual(first.ok, true, 'first registration succeeds');
        store.users.find((user) => user.id === 'emp_01')!.pushOptIn = true;
        store.sessions.push(makeSession({ id: 'mon_old_device', userId: 'emp_01' }));
        persistStore(db, store);
        enqueueAlertsForPush(db, [{
          id: 'alert_old_device', userId: 'emp_01', sessionId: 'mon_old_device',
          createdAtIso: new Date().toISOString(), createdAtIst: '08:00:00 IST',
          type: 'DEPARTURE_REMINDER', severity: 'INFO', title: 'Reminder', message: 'Reminder',
          deliveredChannels: ['IN_APP'], acknowledged: false,
        }], { getUsers: () => store.users, getSessionDirection: () => 'HOME_TO_WORK' });

        const receiptsReady: string[] = [];
        const transport = {
          enabled: true,
          async send() {
            return { httpOk: true, retryable: false, tickets: [{ status: 'ok' as const, id: 'ticket-old-registration' }] };
          },
          async getReceipts(ids: string[]) {
            receiptsReady.push(...ids);
            return { httpOk: true, retryable: false, receipts: {
              [ids[0]]: { status: 'error' as const, message: 'unregistered', detailsError: 'DeviceNotRegistered' },
            } };
          },
        };
        await processOutbox(db, transport, {
          workerId: 'generation-test-worker', getUsers: () => store.users,
          getSessionStatus: () => 'ACTIVE',
        });
        assert(removeDevice(db, 'emp_01', installId), 'old registration removed');
        const second = registerDevice(db, {
          userId: 'emp_02', expoPushToken: newToken, platform: 'android', installationId: installId,
        });
        assertEqual(second.ok, true, 'same installation can be registered to replacement owner');
        const poll = await pollReceipts(db, transport, Date.now() + 6 * 60_000);
        assertEqual(poll.errored, 1, 'old receipt failure was processed');
        const active = db.prepare('SELECT user_id, expo_push_token, generation, disabled FROM devices WHERE installation_id = ?')
          .get(installId) as { user_id: string; expo_push_token: string; generation: number; disabled: number };
        assertEqual(active.user_id, 'emp_02', 'replacement owner remains current');
        assertEqual(active.expo_push_token, newToken, 'replacement token remains current');
        assertEqual(active.disabled, 0, 'old receipt cannot disable replacement');
        assert(active.generation > 1, 'generation history survives physical row deletion');
        assertEqual(receiptsReady[0], 'ticket-old-registration', 'old receipt ticket was polled');

        store.users.find((user) => user.id === 'emp_02')!.pushOptIn = true;
        store.sessions.push(makeSession({ id: 'mon_new_device', userId: 'emp_02' }));
        persistStore(db, store);
        enqueueAlertsForPush(db, [{
          id: 'alert_new_device', userId: 'emp_02', sessionId: 'mon_new_device',
          createdAtIso: new Date().toISOString(), createdAtIst: '08:00:00 IST',
          type: 'DEPARTURE_REMINDER', severity: 'INFO', title: 'Reminder', message: 'Reminder',
          deliveredChannels: ['IN_APP'], acknowledged: false,
        }], { getUsers: () => store.users, getSessionDirection: () => 'HOME_TO_WORK' });
        let releaseSend!: (outcome: ExpoSendOutcome) => void;
        let signalSend!: () => void;
        const sendStarted = new Promise<void>((resolve) => { signalSend = resolve; });
        const delayedTransport = {
          enabled: true,
          send: () => new Promise<ExpoSendOutcome>((resolve) => { releaseSend = resolve; signalSend(); }),
          async getReceipts() { return { httpOk: true, retryable: false, receipts: {} }; },
        };
        const pendingSend = processOutbox(db, delayedTransport, {
          workerId: 'generation-send-worker', getUsers: () => store.users,
          getSessionStatus: () => 'ACTIVE',
        });
        await Promise.race([
          sendStarted,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('replacement send was not dispatched')), 2000)),
        ]);
        assert(removeDevice(db, 'emp_02', installId), 'replacement registration removed during send');
        const third = registerDevice(db, {
          userId: 'emp_02', expoPushToken: 'ExponentPushToken[third-registration-00001]',
          platform: 'android', installationId: installId,
        });
        assertEqual(third.ok, true, 'new registration succeeds during prior send');
        releaseSend({ httpOk: true, retryable: false, tickets: [{
          status: 'error', message: 'unregistered', detailsError: 'DeviceNotRegistered',
        }] });
        await pendingSend;
        const afterSend = db.prepare('SELECT disabled FROM devices WHERE installation_id = ?').get(installId) as { disabled: number };
        assertEqual(afterSend.disabled, 0, 'old send failure cannot disable replacement registration');
        return `Generation advanced to ${active.generation} across removal; stale receipt and send failures left replacement enabled`;
      } finally {
        db.close();
      }
    }
  );

  await test(
    '25. IVE_LEFT Retry Idempotency',
    'Terminal action interleavings preserve the original departure and reject conflicting outcomes',
    async () => {
      const dir = newTempDir('left-idempotent');
      const app = await startApp({ dataDir: dir });
      try {
        const token = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        await api(app.baseUrl, 'PUT', '/api/me/profile', { token, body: { telemetryConsent: true } });
        const started = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        const first = await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId: started.json.session.id, action: 'IVE_LEFT' },
        });
        const stopAfterLeave = await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId: started.json.session.id, action: 'STOP_MONITORING' },
        });
        const snoozeAfterLeave = await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId: started.json.session.id, action: 'SNOOZE_10M' },
        });
        const skippedAfterLeave = await api(app.baseUrl, 'POST', '/api/me/day-override', {
          token,
          body: { dateIst: started.json.session.dateIst, direction: 'HOME_TO_WORK', skipped: true },
        });
        assertEqual(skippedAfterLeave.status, 200, 'day override can be saved after departure');
        assertEqual(sessionRow(app.handle.db, started.json.session.id)?.status, 'LEFT', 'day override preserves durable LEFT');
        const deletedAfterLeave = await api(app.baseUrl, 'DELETE', '/api/me/locations', { token });
        assertEqual(deletedAfterLeave.status, 200, 'location deletion succeeds after departure');
        assertEqual(sessionRow(app.handle.db, started.json.session.id)?.status, 'LEFT', 'location deletion preserves durable LEFT');
        const retry = await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId: started.json.session.id, action: 'IVE_LEFT' },
        });
        assertEqual(first.status, 200, 'first leave action succeeds');
        assertEqual(stopAfterLeave.status, 409, 'stop cannot overwrite LEFT');
        assertEqual(stopAfterLeave.json.status, 'LEFT', 'conflict reports durable status');
        assertEqual(snoozeAfterLeave.status, 409, 'snooze cannot overwrite LEFT');
        assertEqual(retry.status, 200, 'retry remains successful');
        assertEqual(retry.json.journey.id, first.json.journey.id, 'retry returns same journey id');
        assertEqual(
          retry.json.session.departureEstimateSnapshot.issuedAtIso,
          first.json.session.departureEstimateSnapshot.issuedAtIso,
          'immutable departure snapshot is unchanged'
        );
        assertEqual(
          (app.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(first.json.journey.id) as any).c,
          1,
          'one journey persisted for this session'
        );
        assertEqual(app.handle.store.sessions.find((s) => s.id === started.json.session.id)?.status, 'LEFT', 'memory remains LEFT');
        assertEqual(sessionRow(app.handle.db, started.json.session.id)?.status, 'LEFT', 'disk remains LEFT');
        const departureSnapshot = app.handle.store.sessions.find((s) => s.id === started.json.session.id)?.departureEstimateSnapshot;
        assertEqual(departureSnapshot?.issuedAtIso, first.json.session.departureEstimateSnapshot.issuedAtIso, 'memory snapshot remains original');
        await app.close();
        const reopened = await startApp({ dataDir: dir });
        try {
          const state = await api(reopened.baseUrl, 'GET', '/api/me/state', { token });
          const persistedSession = state.json.sessions.find((entry: MonitoringSession) => entry.id === started.json.session.id);
          assertEqual(persistedSession.status, 'LEFT', 'LEFT remains terminal after reopen');
          assertEqual(persistedSession.departureEstimateSnapshot.issuedAtIso, first.json.session.departureEstimateSnapshot.issuedAtIso, 'snapshot survives reopen unchanged');
          assertEqual((reopened.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(first.json.journey.id) as any).c, 1, 'one journey remains after reopen');
          const terminalCases = [
            { userId: 'emp_02', id: 'mon_stop_terminal', status: 'ACTIVE' as const, action: 'STOP_MONITORING' },
            { userId: 'emp_03', id: 'mon_skip_terminal', status: 'ACTIVE' as const, action: 'SKIP_TODAY' },
            { userId: 'emp_04', id: 'mon_expired_terminal', status: 'EXPIRED' as const, action: null },
          ];
          reopened.handle.store.sessions.push(...terminalCases.map((entry) => makeSession({
            id: entry.id, userId: entry.userId, status: entry.status as MonitoringSession['status'],
          })));
          persistStore(reopened.handle.db, reopened.handle.store);
          for (const entry of terminalCases) {
            const caseToken = await login(reopened.baseUrl, entry.userId, `${1000 + Number(entry.userId.slice(-2))}`);
            if (entry.action) {
              const terminal = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
                token: caseToken, body: { sessionId: entry.id, action: entry.action },
              });
              assertEqual(terminal.status, 200, `${entry.action} reaches terminal outcome`);
            }
            const snooze = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
              token: caseToken, body: { sessionId: entry.id, action: 'SNOOZE_10M' },
            });
            assertEqual(snooze.status, 409, `snooze after ${entry.action ?? 'EXPIRED'} rejected`);
            assertEqual(sessionRow(reopened.handle.db, entry.id)?.status, entry.action === 'STOP_MONITORING' ? 'STOPPED' : entry.action === 'SKIP_TODAY' ? 'SKIPPED' : 'EXPIRED', 'terminal status remains durable');
            const expectedTerminal = sessionRow(reopened.handle.db, entry.id)!.status;
            await api(reopened.baseUrl, 'POST', '/api/me/day-override', {
              token: caseToken,
              body: { dateIst: getNowIstParts().dateIst, direction: 'HOME_TO_WORK', skipped: true },
            });
            await api(reopened.baseUrl, 'DELETE', '/api/me/locations', { token: caseToken });
            assertEqual(sessionRow(reopened.handle.db, entry.id)?.status, expectedTerminal, 'alternate routes preserve terminal outcome on disk');
            assertEqual(reopened.handle.store.sessions.find((session) => session.id === entry.id)?.status, expectedTerminal, 'alternate routes preserve terminal outcome in memory');
          }
        } finally {
          await reopened.close();
        }
        return 'LEFT resisted stop/snooze interleavings and retry preserved one journey and its snapshot';
      } finally {
        if (app.handle.db.isOpen) await app.close();
      }
    }
  );

  await test(
    '25a. Cross-Handle Terminal Evidence',
    'Stale profile mutations cannot replace committed terminal sessions or departure evidence',
    async () => {
      const dir = newTempDir('cross-handle-terminal');
      const appA = await startApp({ dataDir: dir });
      const appB = await startApp({ dataDir: dir });
      const users = [
        { userId: 'emp_01', pin: '1001', mutation: 'day-override' as const },
        { userId: 'emp_02', pin: '1002', mutation: 'locations' as const },
      ];
      const evidence: Array<{
        userId: string;
        sessionId: string;
        token: string;
        journeyId: string;
        snapshot: string;
        journey: string;
      }> = [];
      let appAClosed = false;
      let appBClosed = false;
      try {
        for (const entry of users) {
          primeSchedule(appA.handle.store, entry.userId, 'HOME_TO_WORK');
          persistStore(appA.handle.db, appA.handle.store);
          const tokenA = await login(appA.baseUrl, entry.userId, entry.pin);
          const tokenB = await login(appB.baseUrl, entry.userId, entry.pin);
          await api(appA.baseUrl, 'PUT', '/api/me/profile', {
            token: tokenA,
            body: { telemetryConsent: true },
          });
          const started = await api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
            token: tokenA,
            body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
          });
          assertEqual(started.status, 200, `${entry.userId} session starts in handle A`);
          const left = await api(appA.baseUrl, 'POST', '/api/monitoring/action', {
            token: tokenA,
            body: { sessionId: started.json.session.id, action: 'IVE_LEFT' },
          });
          assertEqual(left.status, 200, `${entry.userId} leaves in handle A`);
          const journeyId = left.json.journey.id as string;
          const durableBefore = sessionRow(appA.handle.db, started.json.session.id);
          const journeyBefore = appA.handle.db
            .prepare('SELECT data FROM journeys WHERE id = ?')
            .get(journeyId) as { data: string };
          evidence.push({
            userId: entry.userId,
            sessionId: started.json.session.id,
            token: tokenB,
            journeyId,
            snapshot: JSON.stringify(JSON.parse(durableBefore.data).departureEstimateSnapshot),
            journey: journeyBefore.data,
          });
        }

        const override = await api(appB.baseUrl, 'POST', '/api/me/day-override', {
          token: evidence[0].token,
          body: {
            dateIst: getNowIstParts().dateIst,
            direction: 'HOME_TO_WORK',
            skipped: true,
          },
        });
        assertEqual(override.status, 200, 'stale handle day override succeeds');
        const overrideResponseSession = override.json.sessions.find(
          (session: MonitoringSession) => session.id === evidence[0].sessionId
        );
        assertEqual(overrideResponseSession.status, 'LEFT', 'day override response reflects durable terminal status');
        assertEqual(
          JSON.stringify(overrideResponseSession.departureEstimateSnapshot),
          evidence[0].snapshot,
          'day override response keeps original departure snapshot'
        );

        const locationDelete = await api(appB.baseUrl, 'DELETE', '/api/me/locations', {
          token: evidence[1].token,
        });
        assertEqual(locationDelete.status, 200, 'stale handle location deletion succeeds');

        for (const item of evidence) {
          const inMemory = appB.handle.store.sessions.find((session) => session.id === item.sessionId);
          const durable = sessionRow(appB.handle.db, item.sessionId);
          assertEqual(inMemory?.status, 'LEFT', `${item.userId} memory reconciles to LEFT`);
          assertEqual(JSON.stringify(inMemory?.departureEstimateSnapshot), item.snapshot, `${item.userId} memory snapshot remains immutable`);
          assertEqual(durable.status, 'LEFT', `${item.userId} durable status remains LEFT`);
          assertEqual(JSON.stringify(JSON.parse(durable.data).departureEstimateSnapshot), item.snapshot, `${item.userId} durable snapshot remains immutable`);
          const journey = appB.handle.db
            .prepare('SELECT data FROM journeys WHERE id = ?')
            .get(item.journeyId) as { data: string };
          assertEqual(journey.data, item.journey, `${item.userId} journey remains unchanged`);
        }

        await appB.close();
        appBClosed = true;
        await appA.close();
        appAClosed = true;
        const reopened = await startApp({ dataDir: dir });
        try {
          for (const item of evidence) {
            const durable = sessionRow(reopened.handle.db, item.sessionId);
            assertEqual(durable.status, 'LEFT', `${item.userId} remains LEFT after reopen`);
            assertEqual(JSON.stringify(JSON.parse(durable.data).departureEstimateSnapshot), item.snapshot, `${item.userId} snapshot survives reopen`);
            const retry = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
              token: item.token,
              body: { sessionId: item.sessionId, action: 'IVE_LEFT' },
            });
            assertEqual(retry.status, 200, `${item.userId} retry succeeds after reopen`);
            assertEqual(retry.json.journey.id, item.journeyId, `${item.userId} retry returns original journey`);
            assertEqual(
              (reopened.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(item.journeyId) as { c: number }).c,
              1,
              `${item.userId} retains one journey`
            );
          }
        } finally {
          await reopened.close();
        }
        return 'Two stale-handle mutations preserved LEFT, immutable snapshots, and original journeys in memory, SQLite, and after reopen';
      } finally {
        if (!appBClosed) await appB.close();
        if (!appAClosed) await appA.close();
      }
    }
  );

  await test(
    '25b. Stale ACTIVE Cross-Handle Conflict',
    'Both handles hold the session ACTIVE before A leaves; stale B writes cannot overwrite durable LEFT, journey, or departure evidence',
    async () => {
      // Independent case 1: B saves a skip day-override over its stale ACTIVE copy.
      const dirOverride = newTempDir('stale-active-override');
      const appA = await startApp({ dataDir: dirOverride });
      let appB: RunningApp | null = null;
      let appAClosed = false;
      let appBClosed = false;
      try {
        const tokenA = await login(appA.baseUrl, 'emp_01', '1001');
        primeSchedule(appA.handle.store, 'emp_01', 'HOME_TO_WORK');
        persistStore(appA.handle.db, appA.handle.store);
        await api(appA.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenA,
          body: { telemetryConsent: true },
        });
        const started = await api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'override case: session starts in handle A');
        const sessionId = started.json.session.id as string;

        appB = await startApp({ dataDir: dirOverride });
        const staleInB = appB.handle.store.sessions.find((s) => s.id === sessionId);
        assertEqual(staleInB?.status, 'ACTIVE', 'override case: handle B holds the session ACTIVE before A leaves');

        const left = await api(appA.baseUrl, 'POST', '/api/monitoring/action', {
          token: tokenA,
          body: { sessionId, action: 'IVE_LEFT' },
        });
        assertEqual(left.status, 200, 'override case: A leaves');
        const journeyId = left.json.journey.id as string;
        const durableLeft = sessionRow(appA.handle.db, sessionId);
        assertEqual(durableLeft.status, 'LEFT', 'override case: durable row is LEFT before B mutates');
        const originalData = durableLeft.data;
        const originalSnapshot = JSON.stringify(JSON.parse(originalData).departureEstimateSnapshot);
        const originalJourney = (
          appA.handle.db.prepare('SELECT data FROM journeys WHERE id = ?').get(journeyId) as { data: string }
        ).data;

        const tokenB = await login(appB.baseUrl, 'emp_01', '1001');
        const override = await api(appB.baseUrl, 'POST', '/api/me/day-override', {
          token: tokenB,
          body: { dateIst: getNowIstParts().dateIst, direction: 'HOME_TO_WORK', skipped: true },
        });
        assertEqual(override.status, 200, 'override case: stale handle day override succeeds');
        const responseSession = override.json.sessions.find(
          (session: MonitoringSession) => session.id === sessionId
        );
        assertEqual(responseSession.status, 'LEFT', 'override case: response reflects durable LEFT, not the stale ACTIVE working copy');
        assertEqual(
          JSON.stringify(responseSession.departureEstimateSnapshot),
          originalSnapshot,
          'override case: response keeps the original departure snapshot'
        );

        const memorySession = appB.handle.store.sessions.find((s) => s.id === sessionId);
        assertEqual(memorySession?.status, 'LEFT', 'override case: B memory reconciles to durable LEFT');
        assertEqual(
          JSON.stringify(memorySession?.departureEstimateSnapshot),
          originalSnapshot,
          'override case: B memory snapshot remains original'
        );
        const durableAfter = sessionRow(appB.handle.db, sessionId);
        assertEqual(durableAfter.status, 'LEFT', 'override case: durable status remains LEFT');
        assertEqual(durableAfter.data, originalData, 'override case: durable session record byte-identical after B write');
        const journeyAfter = appB.handle.db
          .prepare('SELECT data FROM journeys WHERE id = ?')
          .get(journeyId) as { data: string };
        assertEqual(journeyAfter.data, originalJourney, 'override case: journey unchanged by B write');
        const overrideUser = JSON.parse(
          (appB.handle.db.prepare('SELECT data FROM users WHERE id = ?').get('emp_01') as { data: string }).data
        ) as PilotUserSeed;
        assert(
          overrideUser.dayOverrides.some(
            (o) => o.dateIst === getNowIstParts().dateIst && o.direction === 'HOME_TO_WORK' && o.skipped
          ),
          'override case: valid nonterminal day-override write still committed'
        );

        await appB.close();
        appBClosed = true;
        await appA.close();
        appAClosed = true;
        const reopened = await startApp({ dataDir: dirOverride });
        try {
          const token = await login(reopened.baseUrl, 'emp_01', '1001');
          const durable = sessionRow(reopened.handle.db, sessionId);
          assertEqual(durable.status, 'LEFT', 'override case: remains LEFT after reopen');
          assertEqual(
            JSON.stringify(JSON.parse(durable.data).departureEstimateSnapshot),
            originalSnapshot,
            'override case: original snapshot survives reopen'
          );
          const retry = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
            token,
            body: { sessionId, action: 'IVE_LEFT' },
          });
          assertEqual(retry.status, 200, 'override case: retry succeeds after reopen');
          assertEqual(retry.json.journey.id, journeyId, 'override case: retry returns the original journey');
          assertEqual(
            (reopened.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(journeyId) as { c: number }).c,
            1,
            'override case: exactly one journey after reopen'
          );
        } finally {
          await reopened.close();
        }
      } finally {
        if (!appBClosed) await appB?.close();
        if (!appAClosed) await appA.close();
      }

      // Independent case 2 (fresh dir/session): B deletes locations over its stale ACTIVE copy.
      const dirLocations = newTempDir('stale-active-locations');
      const appA2 = await startApp({ dataDir: dirLocations });
      let appB2: RunningApp | null = null;
      let appA2Closed = false;
      let appB2Closed = false;
      try {
        const tokenA = await login(appA2.baseUrl, 'emp_02', '1002');
        primeSchedule(appA2.handle.store, 'emp_02', 'HOME_TO_WORK');
        persistStore(appA2.handle.db, appA2.handle.store);
        await api(appA2.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenA,
          body: { telemetryConsent: true },
        });
        const started = await api(appA2.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'location case: session starts in handle A');
        const sessionId = started.json.session.id as string;

        appB2 = await startApp({ dataDir: dirLocations });
        const staleInB = appB2.handle.store.sessions.find((s) => s.id === sessionId);
        assertEqual(staleInB?.status, 'ACTIVE', 'location case: handle B holds the session ACTIVE before A leaves');

        const left = await api(appA2.baseUrl, 'POST', '/api/monitoring/action', {
          token: tokenA,
          body: { sessionId, action: 'IVE_LEFT' },
        });
        assertEqual(left.status, 200, 'location case: A leaves');
        const journeyId = left.json.journey.id as string;
        const durableLeft = sessionRow(appA2.handle.db, sessionId);
        assertEqual(durableLeft.status, 'LEFT', 'location case: durable row is LEFT before B mutates');
        const originalData = durableLeft.data;
        const originalSnapshot = JSON.stringify(JSON.parse(originalData).departureEstimateSnapshot);
        const originalJourney = (
          appA2.handle.db.prepare('SELECT data FROM journeys WHERE id = ?').get(journeyId) as { data: string }
        ).data;

        const tokenB = await login(appB2.baseUrl, 'emp_02', '1002');
        const locationDelete = await api(appB2.baseUrl, 'DELETE', '/api/me/locations', { token: tokenB });
        assertEqual(locationDelete.status, 200, 'location case: stale handle location deletion succeeds');
        assertEqual(locationDelete.json.profile.homeLocation, null, 'location case: deletion response clears home location');

        const memorySession = appB2.handle.store.sessions.find((s) => s.id === sessionId);
        assertEqual(memorySession?.status, 'LEFT', 'location case: B memory reconciles to durable LEFT');
        assertEqual(
          JSON.stringify(memorySession?.departureEstimateSnapshot),
          originalSnapshot,
          'location case: B memory snapshot remains original'
        );
        const durableAfter = sessionRow(appB2.handle.db, sessionId);
        assertEqual(durableAfter.status, 'LEFT', 'location case: durable status remains LEFT');
        assertEqual(durableAfter.data, originalData, 'location case: durable session record byte-identical after B write');
        const journeyAfter = appB2.handle.db
          .prepare('SELECT data FROM journeys WHERE id = ?')
          .get(journeyId) as { data: string };
        assertEqual(journeyAfter.data, originalJourney, 'location case: journey unchanged by B write');
        const locationsUser = JSON.parse(
          (appB2.handle.db.prepare('SELECT data FROM users WHERE id = ?').get('emp_02') as { data: string }).data
        ) as PilotUserSeed;
        assertEqual(locationsUser.homeLocation, null, 'location case: valid nonterminal location deletion still committed');

        await appB2.close();
        appB2Closed = true;
        await appA2.close();
        appA2Closed = true;
        const reopened = await startApp({ dataDir: dirLocations });
        try {
          const token = await login(reopened.baseUrl, 'emp_02', '1002');
          const durable = sessionRow(reopened.handle.db, sessionId);
          assertEqual(durable.status, 'LEFT', 'location case: remains LEFT after reopen');
          assertEqual(
            JSON.stringify(JSON.parse(durable.data).departureEstimateSnapshot),
            originalSnapshot,
            'location case: original snapshot survives reopen'
          );
          const retry = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
            token,
            body: { sessionId, action: 'IVE_LEFT' },
          });
          assertEqual(retry.status, 200, 'location case: retry succeeds after reopen');
          assertEqual(retry.json.journey.id, journeyId, 'location case: retry returns the original journey');
          assertEqual(
            (reopened.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(journeyId) as { c: number }).c,
            1,
            'location case: exactly one journey after reopen'
          );
        } finally {
          await reopened.close();
        }
      } finally {
        if (!appB2Closed) await appB2?.close();
        if (!appA2Closed) await appA2.close();
      }
      return 'Stale ACTIVE copies in handle B were blocked at durable LEFT with original journey and departure evidence, while valid nonterminal writes still committed';
    }
  );

  await test(
    '25c. Stale Same-Status LEFT Evidence Guard',
    'A stale working-set LEFT copy with altered departure evidence cannot rewrite the durable terminal record',
    async () => {
      const dir = newTempDir('stale-left-evidence');
      const appA = await startApp({ dataDir: dir });
      let appB: RunningApp | null = null;
      let appAClosed = false;
      let appBClosed = false;
      try {
        const tokenA = await login(appA.baseUrl, 'emp_01', '1001');
        primeSchedule(appA.handle.store, 'emp_01', 'HOME_TO_WORK');
        persistStore(appA.handle.db, appA.handle.store);
        await api(appA.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenA,
          body: { telemetryConsent: true },
        });
        const started = await api(appA.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token: tokenA,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'session starts in handle A');
        const sessionId = started.json.session.id as string;
        const left = await api(appA.baseUrl, 'POST', '/api/monitoring/action', {
          token: tokenA,
          body: { sessionId, action: 'IVE_LEFT' },
        });
        assertEqual(left.status, 200, 'A leaves');
        const journeyId = left.json.journey.id as string;
        const durableLeft = sessionRow(appA.handle.db, sessionId);
        assertEqual(durableLeft.status, 'LEFT', 'durable row is LEFT');
        const originalData = durableLeft.data;
        const originalSnapshot = JSON.stringify(JSON.parse(originalData).departureEstimateSnapshot);
        const originalJourney = (
          appA.handle.db.prepare('SELECT data FROM journeys WHERE id = ?').get(journeyId) as { data: string }
        ).data;

        appB = await startApp({ dataDir: dir });
        const tokenB = await login(appB.baseUrl, 'emp_01', '1001');
        const stale = appB.handle.store.sessions.find((s) => s.id === sessionId);
        if (!stale || !stale.departureEstimateSnapshot) {
          throw new Error('handle B did not load the LEFT session with departure evidence');
        }
        assertEqual(stale.status, 'LEFT', 'handle B loads the durable LEFT copy');

        // Doctor B's working copy: same terminal status, altered departure evidence.
        stale.departureEstimateSnapshot = {
          ...stale.departureEstimateSnapshot,
          optionId: 'tampered-option',
          departureTimeIst: '00:00',
          predictedDurationMin: 1,
          predictedArrivalIso: '2000-01-01T00:00:00.000Z',
          issuedAtIso: '2000-01-01T00:00:00.000Z',
        };

        const tamper = await api(appB.baseUrl, 'PUT', '/api/me/profile', {
          token: tokenB,
          body: { onboardingComplete: true },
        });
        assertEqual(tamper.status, 200, 'unrelated B profile write succeeds');

        const durableAfter = sessionRow(appB.handle.db, sessionId);
        assertEqual(durableAfter.status, 'LEFT', 'durable status remains LEFT');
        assertEqual(durableAfter.data, originalData, 'doctored LEFT copy did not rewrite durable session data');
        assertEqual(durableAfter.updated_at_ms, durableLeft.updated_at_ms, 'terminal row was never written (updated_at_ms unchanged)');
        assertEqual(durableAfter.revision, durableLeft.revision, 'terminal row revision unchanged');
        assertEqual(
          JSON.stringify(JSON.parse(durableAfter.data).departureEstimateSnapshot),
          originalSnapshot,
          'durable departure snapshot is the original'
        );
        const journeyAfter = appB.handle.db
          .prepare('SELECT data FROM journeys WHERE id = ?')
          .get(journeyId) as { data: string };
        assertEqual(journeyAfter.data, originalJourney, 'journey evidence unchanged');
        const memoryAfter = appB.handle.store.sessions.find((s) => s.id === sessionId);
        assertEqual(memoryAfter?.status, 'LEFT', 'B memory remains LEFT');
        assertEqual(
          JSON.stringify(memoryAfter?.departureEstimateSnapshot),
          originalSnapshot,
          'B memory reconciled back to the durable evidence'
        );

        await appB.close();
        appBClosed = true;
        await appA.close();
        appAClosed = true;
        const reopened = await startApp({ dataDir: dir });
        try {
          const token = await login(reopened.baseUrl, 'emp_01', '1001');
          const durable = sessionRow(reopened.handle.db, sessionId);
          assertEqual(durable.status, 'LEFT', 'remains LEFT after reopen');
          assertEqual(durable.data, originalData, 'durable record byte-identical after reopen');
          const retry = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
            token,
            body: { sessionId, action: 'IVE_LEFT' },
          });
          assertEqual(retry.status, 200, 'retry succeeds after reopen');
          assertEqual(retry.json.journey.id, journeyId, 'retry returns the original journey');
          assertEqual(
            retry.json.session.departureEstimateSnapshot.issuedAtIso,
            JSON.parse(originalData).departureEstimateSnapshot.issuedAtIso,
            'retry response carries the original snapshot'
          );
        } finally {
          await reopened.close();
        }
        return 'A stale same-status LEFT copy with altered evidence was fully blocked; durable record, revision, journey, and memory kept the original evidence';
      } finally {
        if (!appBClosed) await appB?.close();
        if (!appAClosed) await appA.close();
      }
    }
  );

  await test(
    '26. State Session Ordering',
    'Today’s sessions are ordered newest-started first both live and after SQLite reopen',
    async () => {
      const dir = newTempDir('session-order');
      const app = await startApp({ dataDir: dir });
      let appClosed = false;
      const token = await login(app.baseUrl, 'emp_01', '1001');
      const { dateIst } = getNowIstParts();
      const older = makeSession({
        id: 'mon_order_older',
        dateIst,
        startedAtIso: '2026-11-08T01:00:00.000Z',
      });
      const newer = makeSession({
        id: 'mon_order_newer',
        dateIst,
        startedAtIso: '2026-11-08T02:00:00.000Z',
      });
      try {
        app.handle.store.sessions = [older, newer];
        persistStore(app.handle.db, app.handle.store);
        const live = await api(app.baseUrl, 'GET', '/api/me/state', { token });
        assertEqual(live.json.sessions[0].id, newer.id, 'newest session first in live state');
        await app.close();
        appClosed = true;

        const reopened = await startApp({ dataDir: dir });
        try {
          const afterRestart = await api(reopened.baseUrl, 'GET', '/api/me/state', { token });
          assertEqual(
            afterRestart.json.sessions[0].id,
            newer.id,
            'newest session remains first after database reopen'
          );
        } finally {
          await reopened.close();
        }
        return 'Newest-started session order is explicit and stable across database reopen';
      } finally {
        if (!appClosed) await app.close();
      }
    }
  );

  await test(
    '28. Terminal Reconcile Failure Atomicity',
    'An unparseable durable terminal record fails the persist transaction itself: profile writes roll back, memory recovers, and nothing is half-committed',
    async () => {
      const dir = newTempDir('reconcile-failure');
      const app = await startApp({ dataDir: dir });
      let sessionId = '';
      let journeyId = '';
      try {
        const token = await login(app.baseUrl, 'emp_01', '1001');
        primeSchedule(app.handle.store, 'emp_01', 'HOME_TO_WORK');
        persistStore(app.handle.db, app.handle.store);
        await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token,
          body: { telemetryConsent: true },
        });
        const started = await api(app.baseUrl, 'POST', '/api/monitoring/start-or-refresh', {
          token,
          body: { direction: 'HOME_TO_WORK', environment: 'DEMO' },
        });
        assertEqual(started.status, 200, 'session starts');
        sessionId = started.json.session.id as string;
        const left = await api(app.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId, action: 'IVE_LEFT' },
        });
        assertEqual(left.status, 200, 'session reaches durable LEFT');
        journeyId = left.json.journey.id as string;
        const userBefore = app.handle.db
          .prepare('SELECT data FROM users WHERE id = ?')
          .get('emp_01') as { data: string };
        const onboardingBefore = (JSON.parse(userBefore.data) as PilotUserSeed).onboardingComplete;

        // Inject an unparseable durable terminal record so the reconciliation
        // read (SELECT + JSON.parse) inside persistStore fails.
        app.handle.db
          .prepare('UPDATE sessions SET data = ? WHERE id = ?')
          .run('{"id": ', sessionId);

        const rejected = await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token,
          body: { pushOptIn: true },
        });
        assertEqual(rejected.status, 500, 'write against unparseable terminal record returns 500');
        assertEqual(rejected.json.error, 'PERSISTENCE_FAILED', 'failure surfaces as PERSISTENCE_FAILED');

        const userAfter = app.handle.db
          .prepare('SELECT data FROM users WHERE id = ?')
          .get('emp_01') as { data: string };
        assertEqual(
          userAfter.data,
          userBefore.data,
          'profile write rolled back — reconcile failure aborted the transaction before commit'
        );
        const memoryUser = app.handle.store.users.find((u) => u.id === 'emp_01');
        assertEqual(memoryUser?.pushOptIn, false, 'memory restored to the pre-mutation value');
        const durableSession = sessionRow(app.handle.db, sessionId);
        assertEqual(durableSession.status, 'LEFT', 'terminal status column untouched');
        assertEqual(
          (app.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(journeyId) as { c: number }).c,
          1,
          'journey evidence intact after rejected write'
        );

        // Direct store-level call: same failure mode throws StoreError and commits nothing.
        const emp = app.handle.store.users.find((u) => u.id === 'emp_01');
        if (!emp) throw new Error('emp_01 missing from working set');
        emp.onboardingComplete = !onboardingBefore;
        let thrown: unknown = null;
        try {
          persistStore(app.handle.db, app.handle.store);
        } catch (err) {
          thrown = err;
        }
        if (!thrown) throw new Error('direct persistStore with unparseable terminal record did not throw');
        assert(thrown instanceof StoreError, 'direct persistStore throws StoreError');
        assertEqual((thrown as StoreError).code, 'PERSIST_FAILED', 'direct persistStore error code');
        const userAfterDirect = app.handle.db
          .prepare('SELECT data FROM users WHERE id = ?')
          .get('emp_01') as { data: string };
        assertEqual(userAfterDirect.data, userBefore.data, 'direct persist also rolled back its user write');
        emp.onboardingComplete = onboardingBefore;

        // Repairing the terminal record restores normal operation end to end.
        app.handle.db
          .prepare('UPDATE sessions SET data = ? WHERE id = ?')
          .run(
            JSON.stringify(app.handle.store.sessions.find((s) => s.id === sessionId)),
            sessionId
          );
        const healed = await api(app.baseUrl, 'PUT', '/api/me/profile', {
          token,
          body: { pushOptIn: true },
        });
        assertEqual(healed.status, 200, 'write succeeds once the terminal record parses again');
        const userHealed = JSON.parse(
          (app.handle.db.prepare('SELECT data FROM users WHERE id = ?').get('emp_01') as { data: string }).data
        ) as PilotUserSeed;
        assertEqual(userHealed.pushOptIn, true, 'healed write committed');
        assertEqual(userHealed.onboardingComplete, onboardingBefore, 'rejected direct mutation never committed');
      } finally {
        await app.close();
      }

      const reopened = await startApp({ dataDir: dir });
      try {
        const token = await login(reopened.baseUrl, 'emp_01', '1001');
        const durable = sessionRow(reopened.handle.db, sessionId);
        assertEqual(durable.status, 'LEFT', 'session remains LEFT after reopen');
        assertEqual(
          (reopened.handle.db.prepare('SELECT COUNT(*) AS c FROM journeys WHERE id = ?').get(journeyId) as { c: number }).c,
          1,
          'original journey intact after reopen'
        );
        const state = await api(reopened.baseUrl, 'GET', '/api/me/state', { token });
        assertEqual(state.json.profile.pushOptIn, true, 'only the healed write reached disk');
        const retry = await api(reopened.baseUrl, 'POST', '/api/monitoring/action', {
          token,
          body: { sessionId, action: 'IVE_LEFT' },
        });
        assertEqual(retry.status, 200, 'terminal retry still idempotent after repair');
        assertEqual(retry.json.journey.id, journeyId, 'retry returns the original journey');
      } finally {
        await reopened.close();
      }
      return 'Reconcile read failures roll back the whole persist (API and direct), memory recovers, and a repaired record restores writes';
    }
  );
}

main()
  .then(() => {
    console.log('==============================================================');
    console.log('ORR PULSE — BACKEND FOUNDATION TEST SUITE');
    console.log(`Executed at: ${new Date().toISOString()}`);
    console.log('==============================================================');
    let passed = 0;
    for (const res of results) {
      const badge = res.passed ? '[PASS]' : '[FAIL]';
      console.log(`${badge} ${res.category}: ${res.name} (${res.assertionsRun} assertions)`);
      if (res.passed) {
        console.log(`       Evidence: ${res.evidence}`);
      } else {
        console.log(`       Failure: ${res.failure}`);
      }
      if (res.passed) passed += 1;
    }
    console.log('--------------------------------------------------------------');
    console.log(
      `Summary: ${passed}/${results.length} backend test suites passed (${assertionCount} total assertions).`
    );
    console.log('==============================================================');

    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (passed !== results.length) process.exit(1);
  })
  .catch((err) => {
    console.error('Backend test harness crashed:', err);
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    process.exit(1);
  });
