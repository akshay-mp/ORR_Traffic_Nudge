import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

import {
  buildDepartureRecommendations,
  computeJourneyMetrics,
  computePilotMetricsReport,
  correctJourneyActualTimes,
  createImmutableSnapshot,
  evaluateMonitoringUpdate,
  getNowIstParts,
  isoToIstHhmm,
  isoToIstWithSec,
  istDateAndHhmmToIso,
  PRESTIGE_TECH_PARK_DEFAULT,
} from './src/lib/commuteEngine';
import {
  INITIAL_PILOT_EMPLOYEES,
  PilotUserSeed,
} from './src/lib/pilotSeed';
import {
  ApiQuotaStatus,
  CommuteAlert,
  DataEnvironment,
  DayOverride,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
} from './src/types/commute';

import { openDatabase } from './src/server/db';
import {
  checkBudgetAndIncrement as checkBudgetAndIncrementInDb,
  createStore,
  deleteUserJourneysAndAlerts,
  mutateQuotaPersistSafe,
  PersistentStore,
  persistStore,
  reloadWorkingSet,
  restoreStore,
  snapshotStore,
  StoreError,
} from './src/server/store';
import { issueToken, resolveTokenUser } from './src/server/auth';
import {
  createComputeOptions,
  getGoogleMapsApiKey,
  OptionsProviderOverride,
  ROUTES_REQUEST_TIMEOUT_MS,
} from './src/server/options';
import { Scheduler } from './src/server/scheduler';
import {
  createExpoHttpTransport,
  enqueueAlertsForPushInTransaction,
  listDevices,
  outboxStatus,
  PushTransport,
  registerDevice,
  removeDevice,
  validateDeviceRegistration,
} from './src/server/push';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppOptions {
  /** Data directory for the SQLite database (defaults to ./.data). */
  dataDir?: string;
  /** Environment snapshot (tests inject one; CLI uses process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test seam replacing all provider computation (never touches network). */
  providerOverride?: OptionsProviderOverride;
  /** Push transport (tests inject a mock; default is the env-gated Expo adapter). */
  pushTransport?: PushTransport;
  /** Skip the Vite/static web stack (used by tests). */
  skipWebStack?: boolean;
}

class SessionWriteConflict extends Error {
  constructor() {
    super('Monitoring session changed during request');
    this.name = 'SessionWriteConflict';
  }
}

export interface AppHandle {
  app: express.Express;
  store: PersistentStore;
  db: DatabaseSync;
  scheduler: Scheduler;
  transport: PushTransport;
  migrationNote: string | null;
  close(): void;
}

function sanitizeUserProfile(u: PilotUserSeed) {
  const { pin: _pin, ...profile } = u;
  return profile;
}

interface AuthedRequest extends Request {
  user?: PilotUserSeed;
}

// Curated Bengaluru neighborhoods for instant confirmation in Labeled Demo Mode or manual search
const BENGALURU_PILOT_PLACES: LocationPoint[] = [
  PRESTIGE_TECH_PARK_DEFAULT,
  {
    label: '100 Feet Rd, HAL 2nd Stage, Indiranagar',
    address: '100 Feet Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038',
    lat: 12.9719,
    lng: 77.6412,
    placeId: 'ChIJ_Indiranagar_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: '27th Main Rd, Sector 2, HSR Layout',
    address: '27th Main Rd, Sector 2, HSR Layout, Bengaluru, Karnataka 560102',
    lat: 12.9116,
    lng: 77.6474,
    placeId: 'ChIJ_HSRLayout_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: '80 Feet Rd, 4th Block, Koramangala',
    address: '80 Feet Rd, 4th Block, Koramangala, Bengaluru, Karnataka 560034',
    lat: 12.9345,
    lng: 77.6266,
    placeId: 'ChIJ_Koramangala_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'ITPL Main Rd, Hoodi, Whitefield',
    address: 'ITPL Main Rd, Hoodi, Whitefield, Bengaluru, Karnataka 560048',
    lat: 12.9915,
    lng: 77.7158,
    placeId: 'ChIJ_Whitefield_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'Sarjapur Main Rd, Kaikondrahalli',
    address: 'Sarjapur Main Rd, Kaikondrahalli, Bengaluru, Karnataka 560035',
    lat: 12.9141,
    lng: 77.6776,
    placeId: 'ChIJ_Sarjapur_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'Green Glen Layout, Bellandur',
    address: 'Green Glen Layout, Bellandur, Outer Ring Rd, Bengaluru, Karnataka 560103',
    lat: 12.926,
    lng: 77.6712,
    placeId: 'ChIJ_Bellandur_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: '16th Main Rd, BTM 2nd Stage',
    address: '16th Main Rd, BTM Layout 2nd Stage, Bengaluru, Karnataka 560076',
    lat: 12.9166,
    lng: 77.6101,
    placeId: 'ChIJ_BTM_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'Old Madras Rd, Tin Factory, KR Puram',
    address: 'Old Madras Rd, Bennigana Halli, KR Puram, Bengaluru, Karnataka 560016',
    lat: 12.9968,
    lng: 77.6682,
    placeId: 'ChIJ_KRPuram_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: '11th Main Rd, 4th Block, Jayanagar',
    address: '11th Main Rd, 4th Block, Jayanagar, Bengaluru, Karnataka 560011',
    lat: 12.9279,
    lng: 77.5831,
    placeId: 'ChIJ_Jayanagar_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'Bellary Rd, Hebbal Kempapura',
    address: 'Bellary Rd, Hebbal Kempapura, Bengaluru, Karnataka 560024',
    lat: 13.0358,
    lng: 77.597,
    placeId: 'ChIJ_Hebbal_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
  {
    label: 'Marathahalli Bridge Service Rd, Munnekollal',
    address: 'Marathahalli Bridge Service Rd, Munnekollal, Bengaluru, Karnataka 560037',
    lat: 12.9562,
    lng: 77.7019,
    placeId: 'ChIJ_Marathahalli_Bengaluru',
    confirmedAt: new Date().toISOString(),
  },
];

export async function createApp(options: AppOptions = {}): Promise<AppHandle> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env.DATA_DIR ?? path.join(__dirname, '.data');
  const defaultLimit =
    parseInt(env.DAILY_API_QUOTA_LIMIT || '500', 10) || 500;
  const liveApiConfigured = Boolean(getGoogleMapsApiKey(env));

  const { db } = openDatabase(dataDir);
  const { store, migrationNote } = createStore(db, dataDir, {
    defaultQuotaLimit: defaultLimit,
    liveApiConfigured,
  });
  if (migrationNote) {
    console.log(`[store] ${migrationNote}`);
  }

  const transport =
    options.pushTransport ?? createExpoHttpTransport(env);
  const computeOptions = createComputeOptions({
    db,
    store,
    env: () => env,
    providerOverride: options.providerOverride,
  });
  const scheduler = new Scheduler({ db, store, computeOptions, transport });

  /**
   * Runs a mutating request body with a pre-mutation working-set snapshot.
   * Any failure (notably a failed persistence transaction) restores memory
   * from the snapshot and re-reads the last committed SQLite state when
   * readable, then rethrows so the route fails loudly. A rejected write can
   * never surface in later reads nor be committed by a later success.
   */
  async function runMutating<T>(fn: () => T | Promise<T>): Promise<T> {
    const snapshot = snapshotStore(store);
    try {
      return await fn();
    } catch (err) {
      restoreStore(store, snapshot);
      try {
        reloadWorkingSet(db, store);
      } catch {
        /* DB unreadable (e.g. closed); snapshot restore already applied */
      }
      throw err;
    }
  }

  /**
   * Atomic full-state persist; throws StoreError on any failure so routes
   * fail loudly with 500 PERSISTENCE_FAILED (runMutating has already
   * restored the working set by then).
   */
  function persistAll(
    persistRelatedRows?: () => void,
    beforePersist?: () => void
  ): void {
    persistStore(db, store, persistRelatedRows, beforePersist);
  }

  /**
   * Records generated alerts atomically: memory first (reverted by
   * persistAll's snapshot on failure), one transactional persist including
   * the alerts, and durable push-outbox enqueue only after a successful
   * commit.
   */
  function recordGeneratedAlerts(
    alerts: CommuteAlert[],
    beforePersist?: () => void
  ): void {
    if (alerts.length > 0) store.alerts.unshift(...alerts);
    persistAll(() =>
      enqueueAlertsForPushInTransaction(db, alerts, {
        getUsers: () => store.users,
        getSessionDirection: (sessionId) =>
          store.sessions.find((s) => s.id === sessionId)?.direction ?? null,
      }),
      beforePersist
    );
  }

  function checkBudgetAndIncrement(
    type: 'ROUTES' | 'PLACES' | 'GEOCODING'
  ): { allowed: boolean; reason?: string } {
    return checkBudgetAndIncrementInDb(db, store, type);
  }

  const app = express();
  app.use(express.json());

  function requireAuth(
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ): void {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';

    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Valid employee session token required.',
      });
      return;
    }

    const user = resolveTokenUser(db, store.users, token);
    if (!user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Valid employee session token required.',
      });
      return;
    }

    req.user = user;
    next();
  }

  // 1. Public list of the 10 pilot employee slots (only id, code, name, role, corridorTag — never home address or trips!)
  app.get('/api/auth/pilot-roster', (_req, res) => {
    const roster = store.users.map((u) => ({
      id: u.id,
      employeeCode: u.employeeCode,
      name: u.name,
      role: u.role,
      corridorTag: u.corridorTag,
      defaultPinHint: u.pin,
    }));
    res.json({
      roster,
      serverTimeIst: getNowIstParts().timeWithSecIst,
      dateIst: getNowIstParts().dateIst,
      liveApiConfigured: Boolean(getGoogleMapsApiKey(env)),
    });
  });

  // 2. Authenticate as a pilot employee.
  // Newly issued tokens are cryptographically random and stored only as
  // SHA-256 hashes. The seeded `token_<id>_pilot` tokens remain accepted for
  // pilot compatibility (pilot-only limitation, see docs/backend-mobile.md).
  app.post('/api/auth/login', (req, res) => {
    const { userId, pin } = req.body || {};
    const user = store.users.find((u) => u.id === userId || u.employeeCode === userId);
    if (!user) {
      res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Employee not found in 10-user pilot roster.' });
      return;
    }
    if (pin && String(pin).trim() !== user.pin) {
      res.status(403).json({ error: 'INVALID_PIN', message: 'Invalid 4-digit employee PIN.' });
      return;
    }
    const token = issueToken(db, user.id);

    res.json({
      token,
      profile: sanitizeUserProfile(user),
    });
  });

  // 3. Get authenticated user's profile, active sessions, alerts, and personal journeys
  app.get('/api/me/state', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { dateIst, timeIst, timeWithSecIst, dayOfWeek } = getNowIstParts();

    const userSessions = store.sessions
      .filter((s) => s.userId === user.id && s.dateIst === dateIst)
      .sort((a, b) => {
        const startedDifference =
          new Date(b.startedAtIso).getTime() - new Date(a.startedAtIso).getTime();
        return startedDifference || b.id.localeCompare(a.id);
      });
    const userAlerts = store.alerts
      .filter((a) => a.userId === user.id)
      .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
    const userJourneys = store.journeys
      .filter((j) => j.userId === user.id)
      .sort((a, b) => new Date(b.actualDepartureIso).getTime() - new Date(a.actualDepartureIso).getTime());

    store.quota.liveApiConfigured = Boolean(getGoogleMapsApiKey(env));

    res.json({
      serverClock: {
        dateIst,
        timeIst,
        timeWithSecIst,
        dayOfWeek,
        iso: new Date().toISOString(),
      },
      profile: sanitizeUserProfile(user),
      sessions: userSessions,
      alerts: userAlerts,
      journeys: userJourneys,
      quota: store.quota,
    });
  });

  // 4. Update commute setup / schedule / locations / consent
  app.put('/api/me/profile', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
      const body = req.body || {};

      if (body.homeLocation !== undefined) {
        user.homeLocation = body.homeLocation;
      }
      if (body.workLocation !== undefined && body.workLocation !== null) {
        user.workLocation = body.workLocation;
      }
      if (body.schedules) {
        if (body.schedules.HOME_TO_WORK) {
          user.schedules.HOME_TO_WORK = {
            ...user.schedules.HOME_TO_WORK,
            ...body.schedules.HOME_TO_WORK,
          };
        }
        if (body.schedules.WORK_TO_HOME) {
          user.schedules.WORK_TO_HOME = {
            ...user.schedules.WORK_TO_HOME,
            ...body.schedules.WORK_TO_HOME,
          };
        }
      }
      if (typeof body.telemetryConsent === 'boolean') {
        user.telemetryConsent = body.telemetryConsent;
      }
      if (typeof body.pushOptIn === 'boolean') {
        user.pushOptIn = body.pushOptIn;
      }
      if (typeof body.onboardingComplete === 'boolean') {
        user.onboardingComplete = body.onboardingComplete;
      }
      if (Array.isArray(body.dayOverrides)) {
        user.dayOverrides = body.dayOverrides;
      }

      persistAll();
      res.json({ profile: sanitizeUserProfile(user) });
    }).catch(next);
  });

  // 5. Set or clear a DayOverride (Skip Today or Change Today's Commute Mode/Window/Deadline)
  app.post('/api/me/day-override', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
    const {
      dateIst = getNowIstParts().dateIst,
      direction,
      skipped,
      overrideMode,
      overrideWindowStart,
      overrideWindowEnd,
      overrideArrivalDeadline,
      overridePreferredDeparture,
    } = req.body as DayOverride;

    user.dayOverrides = user.dayOverrides.filter(
      (o) => !(o.dateIst === dateIst && o.direction === direction)
    );

    const newOverride: DayOverride = {
      dateIst,
      direction,
      skipped: Boolean(skipped),
      overrideMode,
      overrideWindowStart,
      overrideWindowEnd,
      overrideArrivalDeadline,
      overridePreferredDeparture,
    };
    user.dayOverrides.push(newOverride);

    // If skipped today, mark any active session for today/direction as SKIPPED and stop alerts
    if (skipped) {
      for (const s of store.sessions) {
        if (s.userId === user.id && s.dateIst === dateIst && s.direction === direction &&
            !['LEFT', 'SKIPPED', 'STOPPED', 'EXPIRED'].includes(s.status)) {
          s.status = 'SKIPPED';
          s.nextRefreshDueIso = null;
        }
      }
    }

    persistAll();
      res.json({
        profile: sanitizeUserProfile(user),
        sessions: store.sessions.filter((s) => s.userId === user.id && s.dateIst === dateIst),
      });
    }).catch(next);
  });
  // 6. Privacy Controls: Delete saved locations or delete personal journey history
  app.delete('/api/me/locations', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
      user.homeLocation = null;
      user.workLocation = { ...PRESTIGE_TECH_PARK_DEFAULT };
      // Stop active sessions since home location was removed
      for (const s of store.sessions) {
        if (s.userId === user.id && !['LEFT', 'SKIPPED', 'STOPPED', 'EXPIRED'].includes(s.status)) {
          s.status = 'STOPPED';
          s.nextRefreshDueIso = null;
        }
      }
      persistAll();
      res.json({
        message: 'Saved home location deleted from server storage.',
        profile: sanitizeUserProfile(user),
      });
    }).catch(next);
  });

  app.delete('/api/me/journeys', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
      deleteUserJourneysAndAlerts(db, user.id);
      store.journeys = store.journeys.filter((j) => j.userId !== user.id);
      store.alerts = store.alerts.filter((a) => a.userId !== user.id);
      res.json({
        message: 'All personal journey records and alert history deleted.',
        journeys: [],
        alerts: [],
      });
    }).catch(next);
  });

  // 7. Address Search & Confirmation (Google Places API New in LIVE mode, or Curated Bengaluru Places in DEMO mode)
  app.post('/api/places/search', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const { query, environment = 'LIVE' } = req.body || {};
      const q = String(query || '').trim();
      if (!q) {
        res.json({ places: BENGALURU_PILOT_PLACES.slice(0, 6), source: 'PRESETS' });
        return;
      }

      if (environment === 'DEMO') {
        const lower = q.toLowerCase();
        const matches = BENGALURU_PILOT_PLACES.filter(
          (p) =>
            p.label.toLowerCase().includes(lower) ||
            p.address.toLowerCase().includes(lower)
        );
        res.json({
          places: matches.length > 0 ? matches : BENGALURU_PILOT_PLACES.slice(0, 5),
          source: 'DEMO_PRESETS',
        });
        return;
      }

      const apiKey = getGoogleMapsApiKey(env);
      if (!apiKey) {
        res.status(503).json({
          error: 'LIVE_API_KEY_UNAVAILABLE',
          message:
            'Google Maps Platform API key is not configured for Live Places Search. Use manual coordinate/address entry or switch to Labeled Demo Mode.',
        });
        return;
      }

      const budget = checkBudgetAndIncrement('PLACES');
      if (!budget.allowed) {
        res.status(429).json({
          quotaExceeded: true,
          error: 'RESOURCE_EXHAUSTED',
          message: budget.reason,
        });
        return;
      }

      try {
        const placesResp = await fetch(
          'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask':
                'places.id,places.displayName,places.formattedAddress,places.location',
              'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
            },
            body: JSON.stringify({
              textQuery: q.toLowerCase().includes('bengaluru') || q.toLowerCase().includes('bangalore')
                ? q
                : `${q}, Bengaluru, Karnataka`,
              regionCode: 'IN',
              languageCode: 'en',
              locationBias: {
                circle: {
                  center: { latitude: 12.9438, longitude: 77.6939 },
                  radius: 35000.0,
                },
              },
            }),
          }
        );

        if (placesResp.status === 429) {
          mutateQuotaPersistSafe(db, store, (q) => {
            q.lastProviderStatus = 'QUOTA_EXCEEDED';
          });
          res.status(429).json({
            quotaExceeded: true,
            error: 'RESOURCE_EXHAUSTED',
            message: 'Google Maps Places API quota exceeded.',
          });
          return;
        }

        const data = (await placesResp.json()) as any;
        if (!placesResp.ok) {
          const statusStr = data?.error?.status || '';
          if (statusStr === 'RESOURCE_EXHAUSTED') {
            res.status(429).json({
              quotaExceeded: true,
              error: 'RESOURCE_EXHAUSTED',
              message: data?.error?.message || 'Quota exceeded',
            });
            return;
          }
          res.status(502).json({
            error: 'PROVIDER_ERROR',
            message: data?.error?.message || 'Places API search error',
          });
          return;
        }

        const nowIso = new Date().toISOString();
        const places: LocationPoint[] = (data.places || []).slice(0, 6).map((p: any) => ({
          label: p.displayName?.text || p.formattedAddress || q,
          address: p.formattedAddress || p.displayName?.text || q,
          lat: p.location?.latitude ?? 12.9438,
          lng: p.location?.longitude ?? 77.6939,
          placeId: p.id,
          confirmedAt: nowIso,
        }));

        res.json({
          places,
          source: 'GOOGLE_PLACES_API_NEW',
        });
      } catch (err: any) {
        res.status(502).json({
          error: 'PROVIDER_ERROR',
          message: err?.message || 'Network error calling Places API (New)',
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // 8. Compute Departure Recommendations & Start/Refresh Monitoring Session
  app.post('/api/monitoring/start-or-refresh', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(async () => {
      const user = req.user!;
      const {
        direction = 'HOME_TO_WORK',
        environment = 'LIVE',
        watchMode = 'ALL_OPTIONS',
        selectedOptionId = null,
        startMode = 'IMMEDIATE', // 'IMMEDIATE' | 'SCHEDULED_LEAD'
        simulateTrafficSpikeMin = 0,
      } = req.body || {};

      const { dateIst } = getNowIstParts();
      const nowIso = new Date().toISOString();
      const sessionId = `mon_${user.id}_${dateIst}_${direction}`;
      const storedSession = db
        .prepare('SELECT data, status, revision FROM sessions WHERE id = ? AND user_id = ?')
        .get(sessionId, user.id) as
        | { data: string; status: string; revision: number }
        | undefined;
      const expectedRevision = storedSession?.revision ?? null;
      const terminalStatuses = ['STOPPED', 'SKIPPED', 'EXPIRED', 'LEFT'];
      if (storedSession && terminalStatuses.includes(storedSession.status)) {
        res.status(409).json({
          error: 'MONITORING_SESSION_TERMINAL',
          message: 'This monitoring session has ended and cannot be restarted for the same commute window.',
        });
        return;
      }
      let currentSession = storedSession
        ? (JSON.parse(storedSession.data) as MonitoringSession)
        : undefined;
      if (currentSession) {
        const memoryIndex = store.sessions.findIndex((entry) => entry.id === sessionId);
        if (memoryIndex >= 0) store.sessions[memoryIndex] = currentSession;
        else store.sessions.push(currentSession);
      }

      const result = await computeOptions({
        user,
        direction,
        environment,
        simulateTrafficSpikeMin,
        signal: AbortSignal.timeout(ROUTES_REQUEST_TIMEOUT_MS),
      });

      if (result.quotaExceeded) {
        res.status(429).json({
          quotaExceeded: true,
          error: 'RESOURCE_EXHAUSTED',
          message: result.providerError || 'API quota reached.',
          quota: store.quota,
        });
        return;
      }

      if (result.providerError) {
        res.status(502).json({
          error: 'PROVIDER_ERROR',
          message: result.providerError,
          quota: store.quota,
        });
        return;
      }

      const effectiveSchedule = result.effectiveSchedule;
      const expiresAtIso = istDateAndHhmmToIso(dateIst, effectiveSchedule.windowEnd);

      let session = currentSession;

      if (!session) {
        session = {
          id: sessionId,
          userId: user.id,
          dateIst,
          direction,
          transportMode: effectiveSchedule.mode,
          status: startMode === 'SCHEDULED_LEAD' ? 'SCHEDULED' : 'ACTIVE',
          watchMode,
          selectedOptionId,
          selectedEstimateSnapshot: null,
          departureEstimateSnapshot: null,
          lastNotifiedArrivalIso: null,
          lastNotifiedArrivalTimeIst: null,
          snoozedUntilIso: null,
          startedAtIso: nowIso,
          lastRefreshedAtIso: nowIso,
          nextRefreshDueIso: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          expiresAtIso,
          refreshCount: 0,
          suppressedDuplicatesCount: 0,
          latestOptions: result.options,
          unsupportedModeReason: result.unsupportedReason || null,
          dataEnvironment: environment,
        };
        store.sessions.push(session);
      } else {
        session.transportMode = effectiveSchedule.mode;
        session.dataEnvironment = environment;
        session.expiresAtIso = expiresAtIso;
        session.unsupportedModeReason = result.unsupportedReason || null;
        if (selectedOptionId !== undefined && selectedOptionId !== null) {
          session.selectedOptionId = selectedOptionId;
        }
        if (watchMode) {
          session.watchMode = watchMode;
        }
      }

      // If user selected a specific option and no immutable selectedEstimateSnapshot exists for it yet, record it
      if (session.selectedOptionId) {
        const chosen = result.options.find((o) => o.id === session!.selectedOptionId);
        if (
          chosen &&
          (!session.selectedEstimateSnapshot ||
            session.selectedEstimateSnapshot.optionId !== chosen.id)
        ) {
          session.selectedEstimateSnapshot = createImmutableSnapshot(
            chosen,
            'SELECTED_OPTION',
            nowIso
          );
        }
      }

      const evalOutcome = evaluateMonitoringUpdate({
        session,
        schedule: effectiveSchedule,
        newOptions: result.options,
        nowIso,
      });

      const idx = store.sessions.findIndex((s) => s.id === session!.id);
      if (idx !== -1) {
        store.sessions[idx] = evalOutcome.updatedSession;
      }

      const requireUnchangedSession = () => {
        const latest = db
          .prepare('SELECT status, revision FROM sessions WHERE id = ? AND user_id = ?')
          .get(sessionId, user.id) as { status: string; revision: number } | undefined;
        if (
          (expectedRevision === null && latest) ||
          (expectedRevision !== null &&
            (!latest || latest.revision !== expectedRevision || terminalStatuses.includes(latest.status)))
        ) {
          throw new SessionWriteConflict();
        }
      };
      try {
        recordGeneratedAlerts(evalOutcome.generatedAlerts, requireUnchangedSession);
      } catch (err) {
        if (!(err instanceof SessionWriteConflict)) throw err;
        reloadWorkingSet(db, store);
        res.status(409).json({
          error: 'MONITORING_SESSION_CHANGED',
          message: 'The session changed while this request was calculating; reload and retry.',
        });
        return;
      }

      res.json({
        session: evalOutcome.updatedSession,
        newAlerts: evalOutcome.generatedAlerts,
        effectiveSchedule,
        quota: store.quota,
      });
    }).catch(next);
  });

  // 9. Select a specific Departure Option to track (records immutable SELECTED_OPTION snapshot)
  app.post('/api/monitoring/select-option', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
    const { sessionId, optionId, watchMode = 'SELECTED_OPTION' } = req.body || {};

    const workingSession = store.sessions.find(
      (s) => s.id === sessionId && s.userId === user.id
    );
    const durableSessionRow = db
      .prepare('SELECT data FROM sessions WHERE id = ? AND user_id = ?')
      .get(sessionId, user.id) as { data: string } | undefined;
    const session = durableSessionRow
      ? (JSON.parse(durableSessionRow.data) as MonitoringSession)
      : workingSession;
    if (!session) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Monitoring session not found.' });
      return;
    }
    const memoryIndex = store.sessions.findIndex((entry) => entry.id === session.id);
    if (memoryIndex >= 0) store.sessions[memoryIndex] = session;
    else store.sessions.push(session);

    session.watchMode = watchMode;
    session.selectedOptionId = optionId;

    const chosen = session.latestOptions.find((o) => o.id === optionId);
    if (chosen) {
      const nowIso = new Date().toISOString();
      session.selectedEstimateSnapshot = createImmutableSnapshot(
        chosen,
        'SELECTED_OPTION',
        nowIso
      );
      session.lastNotifiedArrivalIso = chosen.predictedArrivalIso;
      session.lastNotifiedArrivalTimeIst = chosen.predictedArrivalTimeIst;
    }

    persistAll();
    res.json({ session });
    }).catch(next);
  });

  // 10. Monitoring Actions: "I've left", "Snooze 10 minutes", "Skip today", "Stop monitoring"
  app.post('/api/monitoring/action', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
    const { sessionId, action } = req.body || {};

    const session = store.sessions.find(
      (s) => s.id === sessionId && s.userId === user.id
    );
    if (!session) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Monitoring session not found.' });
      return;
    }

    const terminalAction: Record<string, string> = {
      IVE_LEFT: 'LEFT',
      SKIP_TODAY: 'SKIPPED',
      STOP_MONITORING: 'STOPPED',
    };
    const terminalStatuses = ['LEFT', 'SKIPPED', 'STOPPED', 'EXPIRED'];
    if (terminalStatuses.includes(session.status)) {
      if (terminalAction[action] === session.status) {
      const existingJourney = store.journeys.find((journey) => journey.id === `jrn_${session.id}`) ?? null;
        if (action === 'IVE_LEFT') {
          res.json({ session, journey: existingJourney });
        } else if (action === 'SKIP_TODAY') {
          res.json({ session, profile: sanitizeUserProfile(user) });
        } else {
          res.json({ session });
        }
        return;
      }
      res.status(409).json({
        error: 'INVALID_SESSION_TRANSITION',
        message: `Action ${String(action)} is not valid for terminal session status ${session.status}.`,
        status: session.status,
      });
      return;
    }

    const nowIso = new Date().toISOString();

    if (action === 'SNOOZE_10M') {
      session.status = 'SNOOZED';
      session.snoozedUntilIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const snoozeAlert: CommuteAlert = {
        id: `alert_snz_${session.id}_${Date.now()}`,
        userId: user.id,
        sessionId: session.id,
        createdAtIso: nowIso,
        createdAtIst: isoToIstWithSec(nowIso),
        type: 'SYSTEM_NOTICE',
        severity: 'INFO',
        title: 'Alerts Snoozed for 10 Minutes',
        message: `Departure reminders paused until ${isoToIstHhmm(session.snoozedUntilIso)} IST while route monitoring continues.`,
        deliveredChannels: ['IN_APP'],
        acknowledged: true,
      };
      recordGeneratedAlerts([snoozeAlert]);
      res.json({ session, alert: snoozeAlert });
      return;
    }

    if (action === 'SKIP_TODAY') {
      session.status = 'SKIPPED';
      session.nextRefreshDueIso = null;
      user.dayOverrides = user.dayOverrides.filter(
        (o) => !(o.dateIst === session.dateIst && o.direction === session.direction)
      );
      user.dayOverrides.push({
        dateIst: session.dateIst,
        direction: session.direction,
        skipped: true,
      });
      persistAll();
      res.json({ session, profile: sanitizeUserProfile(user) });
      return;
    }

    if (action === 'STOP_MONITORING') {
      session.status = 'STOPPED';
      session.nextRefreshDueIso = null;
      persistAll();
      res.json({ session });
      return;
    }

    if (action === 'IVE_LEFT') {
      // Stop departure alerts immediately and capture the immutable AT_DEPARTURE estimate snapshot
      session.status = 'LEFT';
      session.nextRefreshDueIso = null;

      const activeOption =
        session.latestOptions.find((o) => o.id === session.selectedOptionId) ||
        session.latestOptions.find((o) => o.roles.includes('LEAVE_NOW')) ||
        session.latestOptions[0];

      let createdJourney: JourneyRecord | null = null;

      if (activeOption && user.telemetryConsent) {
        const depSnapshot = createImmutableSnapshot(
          activeOption,
          'AT_DEPARTURE',
          nowIso
        );
        session.departureEstimateSnapshot = depSnapshot;

        const originLabel =
          session.direction === 'HOME_TO_WORK'
            ? user.homeLocation?.label || 'Home'
            : user.workLocation.label;
        const destinationLabel =
          session.direction === 'HOME_TO_WORK'
            ? user.workLocation.label
            : user.homeLocation?.label || 'Home';

        createdJourney = {
          id: `jrn_${session.id}`,
          userId: user.id,
          dateIst: session.dateIst,
          direction: session.direction,
          transportMode: session.transportMode,
          environment: session.dataEnvironment,
          originLabel,
          destinationLabel,
          selectedEstimate: session.selectedEstimateSnapshot || depSnapshot,
          departureEstimate: depSnapshot,
          actualDepartureIso: nowIso,
          actualDepartureTimeIst: isoToIstHhmm(nowIso),
          actualArrivalIso: null,
          actualArrivalTimeIst: null,
          changedPlanOrRoute: false,
          usefulRating: null,
          correctedAtIso: null,
          correctionHistoryCount: 0,
          metrics: computeJourneyMetrics(
            session.selectedEstimateSnapshot || depSnapshot,
            depSnapshot,
            nowIso,
            null
          ),
        };
        store.journeys.unshift(createdJourney);
      }

      persistAll();
      res.json({ session, journey: createdJourney });
      return;
    }

    res.status(400).json({ error: 'INVALID_ACTION', message: 'Unsupported monitoring action.' });
    }).catch(next);
  });

  // 11. Complete a Journey or Correct Manually Entered Journey Times (Keeping Original Estimates Immutable!)
  app.put('/api/journeys/:id', requireAuth, (req: AuthedRequest, res, next) => {
    void runMutating(() => {
      const user = req.user!;
    const journeyId = req.params.id;
    const journeyIdx = store.journeys.findIndex(
      (j) => j.id === journeyId && j.userId === user.id
    );

    if (journeyIdx === -1) {
      res.status(404).json({
        error: 'JOURNEY_NOT_FOUND',
        message: 'Journey record not found or belongs to another employee.',
      });
      return;
    }

    const existing = store.journeys[journeyIdx];
    const {
      actualDepartureHhmm,
      actualArrivalHhmm,
      changedPlanOrRoute,
      usefulRating,
      feedbackNote,
    } = req.body || {};

    const newDepIso = actualDepartureHhmm
      ? istDateAndHhmmToIso(existing.dateIst, actualDepartureHhmm)
      : existing.actualDepartureIso;

    const newArrIso = actualArrivalHhmm
      ? istDateAndHhmmToIso(existing.dateIst, actualArrivalHhmm)
      : existing.actualArrivalIso || new Date().toISOString();

    const nowIso = new Date().toISOString();
    const updated = correctJourneyActualTimes(
      existing,
      newDepIso,
      newArrIso,
      nowIso
    );

    if (typeof changedPlanOrRoute === 'boolean') {
      updated.changedPlanOrRoute = changedPlanOrRoute;
    }
    if (usefulRating !== undefined) {
      updated.usefulRating = usefulRating;
    }
    if (feedbackNote !== undefined) {
      updated.feedbackNote = feedbackNote;
    }

    store.journeys[journeyIdx] = updated;
    persistAll();
    res.json({ journey: updated });
    }).catch(next);
  });

  // 12. Restricted Pilot Metrics Endpoint (Aggregate results ONLY — no personal addresses or individual user logs)
  app.get('/api/pilot/metrics', requireAuth, (req: AuthedRequest, res) => {
    const envParam = String(req.query.environment || 'LIVE').toUpperCase();
    const environment: DataEnvironment = envParam === 'DEMO' ? 'DEMO' : 'LIVE';

    const report = computePilotMetricsReport(
      store.journeys,
      environment,
      new Date().toISOString()
    );

    res.json({
      report,
      quota: store.quota,
      schedulerStatus: {
        inProcessLoopActive: scheduler.isLoopActive(),
        pollIntervalSeconds: 60,
        durableStateBackend: 'SQLite (state survives restart; execution requires a running server process)',
        workerId: scheduler.workerId,
        lastTickAtIso: scheduler.getLastTickAtMs()
          ? new Date(scheduler.getLastTickAtMs()!).toISOString()
          : null,
        pushNativeEnabled: transport.enabled,
        pushOutbox: outboxStatus(db, transport.enabled),
        webPushConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      },
    });
  });

  // 13. Update daily API quota limit safeguard
  app.put('/api/pilot/quota-limit', requireAuth, (req: AuthedRequest, res, next) => {
    const { dailyLimit } = req.body || {};
    const parsed = parseInt(String(dailyLimit), 10);
    if (!Number.isNaN(parsed) && parsed >= 10 && parsed <= 10000) {
      try {
        mutateQuotaPersistSafe(db, store, (q) => {
          q.dailyLimit = parsed;
          if (
            q.requestsUsedToday < q.dailyLimit &&
            q.lastProviderStatus === 'QUOTA_EXCEEDED'
          ) {
            q.lastProviderStatus = getGoogleMapsApiKey(env) ? 'OK' : 'UNCONFIGURED';
          }
        });
      } catch (err) {
        next(err);
        return;
      }
    }
    res.json({ quota: store.quota });
  });

  // 14. Push device registration (authenticated; per-user scoped).
  // Expo push tokens are accepted here, stored per user, and never returned in
  // any other response or log line.
  app.post('/api/me/devices', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const validationError = validateDeviceRegistration(req.body || {});
    if (validationError) {
      res.status(400).json({
        error: validationError.code,
        message: validationError.message,
        field: validationError.field,
      });
      return;
    }
    const { expoPushToken, platform, installationId } = req.body;
    const result = registerDevice(db, {
      userId: user.id,
      expoPushToken,
      platform,
      installationId,
    });
    if (!result.ok) {
      res.status(result.status).json({
        error: result.code,
        message: result.message,
      });
      return;
    }
    res.status(201).json({ device: result.device });
  });

  app.get('/api/me/devices', requireAuth, (req: AuthedRequest, res) => {
    res.json({ devices: listDevices(db, req.user!.id) });
  });

  app.delete('/api/me/devices/:installationId', requireAuth, (req: AuthedRequest, res) => {
    const removed = removeDevice(db, req.user!.id, req.params.installationId);
    if (!removed) {
      res.status(404).json({
        error: 'DEVICE_NOT_FOUND',
        message: 'Device not registered for this employee.',
      });
      return;
    }
    res.json({ deleted: true, installationId: req.params.installationId });
  });

  // Honest per-user push/outbox status. Ticket 'SENT' means accepted by Expo,
  // never delivered to the device; receiptPending/receiptOk describe FCM/APNs
  // handoff only.
  app.get('/api/me/push-status', requireAuth, (req: AuthedRequest, res) => {
    const devices = listDevices(db, req.user!.id);
    const summary = outboxStatus(db, transport.enabled, req.user!.id);
    res.json({
      nativePushEnabled: transport.enabled,
      registeredDevices: devices.length,
      outbox: summary,
      deliveryDisclaimer:
        'SENT means accepted by the Expo push service, not delivered to the device. receiptOk indicates the platform push service accepted the message.',
    });
  });

  // Fail loudly: persistence or unexpected errors never produce a success response.
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof StoreError && err.causeError instanceof SessionWriteConflict) {
      res.status(409).json({
        error: 'MONITORING_SESSION_CHANGED',
        message: 'The session changed while this request was calculating; reload and retry.',
      });
      return;
    }
    if (err instanceof StoreError) {
      console.error('[store] persistence failed:', err.message);
      res.status(500).json({
        error: 'PERSISTENCE_FAILED',
        message:
          'The server could not durably persist the change; it was not acknowledged. Retry shortly.',
      });
      return;
    }
    if (err instanceof SessionWriteConflict) {
      res.status(409).json({
        error: 'MONITORING_SESSION_CHANGED',
        message: 'The session changed while this request was calculating; reload and retry.',
      });
      return;
    }
    console.error('[server] unhandled error:', err);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unexpected server error.',
    });
  });

  // Serve Vite in development or static dist in production
  if (!options.skipWebStack) {
    if (env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
      app.use(express.static(path.join(__dirname, 'dist')));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return {
    app,
    store,
    db,
    scheduler,
    transport,
    migrationNote,
    close() {
      scheduler.stop();
      try {
        db.close();
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'ERR_INVALID_STATE')) {
          console.error('[db] close failed:', err);
        }
      }
    },
  };
}

// Direct-entry boot: `npm run dev` / `npm start` (tsx server.ts). Importing
// createApp (e.g. from tests) has no server side effects.
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const PORT = Number(process.env.PORT) || 3000;
  createApp()
    .then((handle) => {
      handle.scheduler.start();
      handle.app.listen(PORT, '0.0.0.0', () => {
        console.log(`ORR Pulse full-stack server running on http://0.0.0.0:${PORT}`);
        if (!handle.transport.enabled) {
          console.log(
            '[push] Native Expo push dispatch is DISABLED (set ENABLE_NATIVE_PUSH=true and optionally EXPO_ACCESS_TOKEN to enable).'
          );
        }
      });
    })
    .catch((err) => {
      console.error('Failed to start ORR Pulse server:', err);
      process.exit(1);
    });
}
