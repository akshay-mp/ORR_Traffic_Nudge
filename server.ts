import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BMTC_TIMETABLE_LIMITATION_NOTE,
  buildDepartureRecommendations,
  computeDemoSlotPrediction,
  computeJourneyMetrics,
  computePilotMetricsReport,
  correctJourneyActualTimes,
  createImmutableSnapshot,
  evaluateMonitoringUpdate,
  generateCandidateDepartureTimes,
  getNowIstParts,
  hhmmToMinutes,
  isoToIstHhmm,
  isoToIstWithSec,
  istDateAndHhmmToIso,
  PRESTIGE_TECH_PARK_DEFAULT,
  resolveEffectiveSchedule,
  SlotPredictionInput,
} from './src/lib/commuteEngine';
import {
  INITIAL_DEMO_JOURNEYS,
  INITIAL_PILOT_EMPLOYEES,
  PilotUserSeed,
} from './src/lib/pilotSeed';
import {
  ApiQuotaStatus,
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DayOverride,
  DirectionSchedule,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
  TransitStepDetail,
  TransportMode,
  UserProfile,
} from './src/types/commute';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '.data');
const STORE_PATH = path.join(DATA_DIR, 'orr_pulse_store.json');

interface PersistentStore {
  users: PilotUserSeed[];
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  quota: ApiQuotaStatus;
  tokens: Record<string, string>; // token -> userId
}

function getGoogleMapsApiKey(): string {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.MAPS_API_KEY ||
    ''
  ).trim();
}

function loadOrInitStore(): PersistentStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const { dateIst } = getNowIstParts();
  const defaultLimit = parseInt(process.env.DAILY_API_QUOTA_LIMIT || '500', 10) || 500;

  if (fs.existsSync(STORE_PATH)) {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as PersistentStore;
      if (parsed.quota.dateIst !== dateIst) {
        parsed.quota.dateIst = dateIst;
        parsed.quota.requestsUsedToday = 0;
        parsed.quota.routesRequests = 0;
        parsed.quota.placesRequests = 0;
        parsed.quota.geocodingRequests = 0;
      }
      parsed.quota.liveApiConfigured = Boolean(getGoogleMapsApiKey());
      return parsed;
    } catch (err) {
      console.error('Failed to parse store, re-initializing:', err);
    }
  }

  const initialTokens: Record<string, string> = {};
  for (const emp of INITIAL_PILOT_EMPLOYEES) {
    initialTokens[`token_${emp.id}_pilot`] = emp.id;
  }

  const initialStore: PersistentStore = {
    users: structuredClone(INITIAL_PILOT_EMPLOYEES),
    sessions: [],
    alerts: [],
    journeys: structuredClone(INITIAL_DEMO_JOURNEYS),
    quota: {
      dateIst,
      dailyLimit: defaultLimit,
      requestsUsedToday: 0,
      routesRequests: 0,
      placesRequests: 0,
      geocodingRequests: 0,
      lastProviderStatus: getGoogleMapsApiKey() ? 'OK' : 'UNCONFIGURED',
      lastErrorMessage: null,
      liveApiConfigured: Boolean(getGoogleMapsApiKey()),
    },
    tokens: initialTokens,
  };

  saveStore(initialStore);
  return initialStore;
}

function saveStore(store: PersistentStore): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving persistent store:', err);
  }
}

const store = loadOrInitStore();

function sanitizeUserProfile(u: PilotUserSeed): UserProfile {
  const { pin: _pin, ...profile } = u;
  return profile;
}

interface AuthedRequest extends Request {
  user?: PilotUserSeed;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (!token || !store.tokens[token]) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Valid employee session token required.',
    });
    return;
  }

  const userId = store.tokens[token];
  const user = store.users.find((u) => u.id === userId);
  if (!user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Pilot employee profile not found.',
    });
    return;
  }

  req.user = user;
  next();
}

function checkBudgetAndIncrement(
  type: 'ROUTES' | 'PLACES' | 'GEOCODING'
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
    store.quota.lastProviderStatus = 'QUOTA_EXCEEDED';
    store.quota.lastErrorMessage = `Pilot daily API budget safeguard reached (${store.quota.dailyLimit} requests/day).`;
    saveStore(store);
    return {
      allowed: false,
      reason: store.quota.lastErrorMessage,
    };
  }

  store.quota.requestsUsedToday += 1;
  if (type === 'ROUTES') store.quota.routesRequests += 1;
  if (type === 'PLACES') store.quota.placesRequests += 1;
  if (type === 'GEOCODING') store.quota.geocodingRequests += 1;
  saveStore(store);
  return { allowed: true };
}

/**
 * Calls Google Maps Platform Routes API v2 (`directions/v2:computeRoutes`) on the server.
 * Enforces mode separation:
 * - CAR -> DRIVE + TRAFFIC_AWARE_OPTIMAL
 * - BIKE -> TWO_WHEELER + TRAFFIC_AWARE_OPTIMAL (never BICYCLE, never CAR)
 * - BMTC -> TRANSIT + BUS (never invents live BMTC GPS feeds; labels timetable vs live)
 */
async function computeLiveSlotPrediction(params: {
  origin: LocationPoint;
  destination: LocationPoint;
  mode: TransportMode;
  departureTimeIst: string;
  departureIso: string;
  isNowSlot: boolean;
}): Promise<{
  supported: boolean;
  unsupportedReason?: string;
  quotaExceeded?: boolean;
  providerError?: string;
  prediction?: SlotPredictionInput;
}> {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    store.quota.liveApiConfigured = false;
    store.quota.lastProviderStatus = 'UNCONFIGURED';
    return {
      supported: false,
      providerError:
        'Google Maps Platform API key is not configured on the server. Switch to Labeled Demo Mode or configure GOOGLE_MAPS_API_KEY.',
    };
  }

  const budgetCheck = checkBudgetAndIncrement('ROUTES');
  if (!budgetCheck.allowed) {
    return {
      supported: false,
      quotaExceeded: true,
      providerError: budgetCheck.reason,
    };
  }

  const { origin, destination, mode, departureTimeIst, departureIso, isNowSlot } = params;
  const endpoint = 'https://routes.googleapis.com/directions/v2:computeRoutes';

  const originWaypoint = {
    location: {
      latLng: {
        latitude: origin.lat,
        longitude: origin.lng,
      },
    },
  };
  const destinationWaypoint = {
    location: {
      latLng: {
        latitude: destination.lat,
        longitude: destination.lng,
      },
    },
  };

  // Ensure departureTime is strictly in the future if sent to Routes API
  const depEpochMs = new Date(departureIso).getTime();
  const nowEpochMs = Date.now();
  const isFutureDeparture = depEpochMs > nowEpochMs + 90 * 1000;
  const safeFutureIso = isFutureDeparture
    ? new Date(depEpochMs).toISOString()
    : new Date(nowEpochMs + 120 * 1000).toISOString();

  let requestBody: Record<string, unknown>;
  let fieldMask: string;

  if (mode === 'CAR') {
    requestBody = {
      origin: originWaypoint,
      destination: destinationWaypoint,
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      languageCode: 'en-IN',
      regionCode: 'IN',
      units: 'METRIC',
      ...(isFutureDeparture ? { departureTime: safeFutureIso } : {}),
    };
    fieldMask =
      'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description';
  } else if (mode === 'BIKE') {
    // Motorized Two-Wheeler mode (distinct from human-powered BICYCLE and CAR)
    requestBody = {
      origin: originWaypoint,
      destination: destinationWaypoint,
      travelMode: 'TWO_WHEELER',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      languageCode: 'en-IN',
      regionCode: 'IN',
      units: 'METRIC',
      ...(isFutureDeparture ? { departureTime: safeFutureIso } : {}),
    };
    fieldMask =
      'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description';
  } else {
    // BMTC Bus -> TRANSIT mode with BUS filter
    // Note: TRANSIT does not support top-level routingPreference
    requestBody = {
      origin: originWaypoint,
      destination: destinationWaypoint,
      travelMode: 'TRANSIT',
      transitPreferences: {
        allowedTravelModes: ['BUS'],
        routingPreference: 'FEWER_TRANSFERS',
      },
      departureTime: safeFutureIso,
      languageCode: 'en-IN',
      regionCode: 'IN',
      units: 'METRIC',
    };
    fieldMask =
      'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails,routes.legs.steps.navigationInstruction';
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
        'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 429) {
      store.quota.lastProviderStatus = 'QUOTA_EXCEEDED';
      store.quota.lastErrorMessage = 'Google Maps Platform Routes API quota exceeded (HTTP 429).';
      saveStore(store);
      return {
        supported: false,
        quotaExceeded: true,
        providerError: store.quota.lastErrorMessage,
      };
    }

    const payload = (await response.json()) as any;

    if (!response.ok) {
      const errStatus = payload?.error?.status || '';
      const errMsg = payload?.error?.message || `HTTP ${response.status}`;
      if (errStatus === 'RESOURCE_EXHAUSTED' || errMsg.includes('Quota')) {
        store.quota.lastProviderStatus = 'QUOTA_EXCEEDED';
        store.quota.lastErrorMessage = errMsg;
        saveStore(store);
        return {
          supported: false,
          quotaExceeded: true,
          providerError: errMsg,
        };
      }
      store.quota.lastProviderStatus = 'PROVIDER_ERROR';
      store.quota.lastErrorMessage = errMsg;
      saveStore(store);
      return {
        supported: false,
        providerError: `Routes API Error (${errStatus || response.status}): ${errMsg}`,
      };
    }

    store.quota.lastProviderStatus = 'OK';
    store.quota.lastErrorMessage = null;
    saveStore(store);

    const route = payload?.routes?.[0];
    if (!route) {
      if (mode === 'BMTC') {
        return {
          supported: false,
          unsupportedReason:
            'Google Maps Routes API returned no scheduled BMTC bus route between these locations for the requested departure time.',
        };
      }
      if (mode === 'BIKE') {
        return {
          supported: false,
          unsupportedReason:
            'Google Maps Routes API returned no motorized two-wheeler (TWO_WHEELER) route for this origin–destination pair.',
        };
      }
      return {
        supported: false,
        unsupportedReason:
          'No drivable route found between the selected origin and destination.',
      };
    }

    const parseSec = (durStr?: string): number => {
      if (!durStr) return 0;
      return parseInt(String(durStr).replace('s', ''), 10) || 0;
    };

    const durationSec = parseSec(route.duration);
    const staticDurationSec = parseSec(route.staticDuration) || durationSec;
    const predictedDurationMin = Math.max(1, Math.round(durationSec / 60));
    const staticDurationMin = Math.max(1, Math.round(staticDurationSec / 60));
    const distanceKm = Number(((route.distanceMeters || 5000) / 1000).toFixed(1));
    const corridorSummary =
      route.description ||
      (mode === 'BMTC' ? 'BMTC Bus Corridor' : 'Outer Ring Road Corridor');

    if (mode === 'BMTC') {
      const rawSteps: any[] = route.legs?.[0]?.steps || [];
      let walkingSec = 0;
      let inVehicleSec = 0;
      const busLines: string[] = [];
      const steps: TransitStepDetail[] = [];

      for (const st of rawSteps) {
        const stDurMin = Math.max(1, Math.round(parseSec(st.staticDuration) / 60));
        if (st.travelMode === 'WALK') {
          walkingSec += parseSec(st.staticDuration);
          steps.push({
            stepType: 'WALK',
            durationMin: stDurMin,
            instruction:
              st.navigationInstruction?.instructions || 'Walk to transit stop',
          });
        } else if (st.travelMode === 'TRANSIT' || st.transitDetails) {
          inVehicleSec += parseSec(st.staticDuration);
          const td = st.transitDetails || {};
          const lineName =
            td.transitLine?.nameShort ||
            td.transitLine?.name ||
            'BMTC Bus';
          if (lineName && !busLines.includes(lineName)) {
            busLines.push(lineName);
          }
          steps.push({
            stepType: 'BUS',
            durationMin: stDurMin,
            instruction: `Take ${lineName} towards ${td.headsign || 'destination'}`,
            busRouteNumber: lineName,
            departureStop: td.stopDetails?.departureStop?.name,
            arrivalStop: td.stopDetails?.arrivalStop?.name,
            numStops: td.stopCount,
          });
        }
      }

      const walkingMin = Math.max(1, Math.round(walkingSec / 60));
      const inVehicleMin = Math.max(1, Math.round(inVehicleSec / 60));
      const waitingMin = Math.max(0, predictedDurationMin - walkingMin - inVehicleMin);
      const transfersCount = Math.max(0, busLines.length - 1);

      return {
        supported: true,
        prediction: {
          departureTimeIst,
          departureIso,
          isNowSlot,
          predictedDurationMin,
          staticDurationMin,
          estimateBasis: 'TIMETABLE',
          dataSource: 'Google Maps Routes API v2 (BMTC GTFS Timetable)',
          environment: 'LIVE',
          distanceKm,
          corridorSummary:
            busLines.length > 0
              ? `BMTC ${busLines.join(' → ')} (${corridorSummary})`
              : corridorSummary,
          transitDetails: {
            isLiveFeed: false,
            walkingMin,
            waitingMin,
            inVehicleMin,
            transfersCount,
            busLines: busLines.length > 0 ? busLines : ['BMTC Transit'],
            steps,
            limitationNote: BMTC_TIMETABLE_LIMITATION_NOTE,
          },
        },
      };
    }

    const minBound = Math.min(staticDurationMin, predictedDurationMin);
    const maxBound = Math.max(staticDurationMin, predictedDurationMin);

    return {
      supported: true,
      prediction: {
        departureTimeIst,
        departureIso,
        isNowSlot,
        predictedDurationMin,
        staticDurationMin,
        durationRangeMin:
          maxBound > minBound ? [minBound, maxBound + 3] : undefined,
        estimateBasis: isNowSlot ? 'CURRENT_TRAFFIC' : 'FUTURE_FORECAST',
        dataSource: `Google Maps Routes API v2 (${mode === 'BIKE' ? 'TWO_WHEELER' : 'DRIVE'})`,
        environment: 'LIVE',
        distanceKm,
        corridorSummary,
      },
    };
  } catch (err: any) {
    store.quota.lastProviderStatus = 'PROVIDER_ERROR';
    store.quota.lastErrorMessage = err?.message || 'Network failure calling Routes API';
    saveStore(store);
    return {
      supported: false,
      providerError: store.quota.lastErrorMessage || 'Network failure calling Routes API',
    };
  }
}

async function computeOptionsForUserDirection(params: {
  user: PilotUserSeed;
  direction: CommuteDirection;
  environment: DataEnvironment;
  simulateTrafficSpikeMin?: number;
}): Promise<{
  options: ReturnType<typeof buildDepartureRecommendations>;
  effectiveSchedule: ReturnType<typeof resolveEffectiveSchedule>;
  unsupportedReason?: string;
  quotaExceeded?: boolean;
  providerError?: string;
}> {
  const { user, direction, environment, simulateTrafficSpikeMin = 0 } = params;
  const { dateIst, timeIst } = getNowIstParts();
  const nowIso = new Date().toISOString();

  const baseSchedule = user.schedules[direction];
  const effectiveSchedule = resolveEffectiveSchedule(
    baseSchedule,
    user.dayOverrides,
    dateIst
  );

  if (!user.homeLocation) {
    return {
      options: [],
      effectiveSchedule,
      unsupportedReason:
        'Home location is not configured yet. Please enter and confirm your home address in Commute Setup.',
    };
  }

  const origin =
    direction === 'HOME_TO_WORK' ? user.homeLocation : user.workLocation;
  const destination =
    direction === 'HOME_TO_WORK' ? user.workLocation : user.homeLocation;

  const candidateSlots = generateCandidateDepartureTimes(
    effectiveSchedule.windowStart,
    effectiveSchedule.windowEnd,
    effectiveSchedule.preferredDeparture,
    timeIst
  );

  // Limit live slots to at most 3 key slots (e.g. Leave Now / Earliest, Preferred, Latest in window) to conserve API quota
  const selectedSlots =
    environment === 'LIVE' && candidateSlots.length > 3
      ? [
          candidateSlots[0],
          candidateSlots[Math.floor(candidateSlots.length / 2)],
          candidateSlots[candidateSlots.length - 1],
        ]
      : candidateSlots;

  const predictions: SlotPredictionInput[] = [];

  for (const slot of selectedSlots) {
    const depIso = istDateAndHhmmToIso(dateIst, slot.hhmm);

    if (environment === 'DEMO') {
      const demoRes = computeDemoSlotPrediction({
        origin,
        destination,
        mode: effectiveSchedule.mode,
        departureTimeIst: slot.hhmm,
        departureIso: depIso,
        isNowSlot: slot.isNow,
        simulateTrafficSpikeMin,
      });
      if (!demoRes.supported) {
        return {
          options: [],
          effectiveSchedule,
          unsupportedReason: demoRes.unsupportedReason,
        };
      }
      if (demoRes.prediction) {
        predictions.push(demoRes.prediction);
      }
    } else {
      // Strictly LIVE mode: never silently fall back to synthetic demo predictions!
      const liveRes = await computeLiveSlotPrediction({
        origin,
        destination,
        mode: effectiveSchedule.mode,
        departureTimeIst: slot.hhmm,
        departureIso: depIso,
        isNowSlot: slot.isNow,
      });

      if (liveRes.quotaExceeded || liveRes.providerError) {
        return {
          options: [],
          effectiveSchedule,
          quotaExceeded: liveRes.quotaExceeded,
          providerError: liveRes.providerError,
        };
      }
      if (!liveRes.supported) {
        return {
          options: [],
          effectiveSchedule,
          unsupportedReason: liveRes.unsupportedReason,
        };
      }
      if (liveRes.prediction) {
        predictions.push(liveRes.prediction);
      }
    }
  }

  const options = buildDepartureRecommendations({
    dateIst,
    nowIso,
    schedule: effectiveSchedule,
    slotPredictions: predictions,
  });

  return {
    options,
    effectiveSchedule,
  };
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

async function createApp() {
  const app = express();
  app.use(express.json());

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
      liveApiConfigured: Boolean(getGoogleMapsApiKey()),
    });
  });

  // 2. Authenticate as a pilot employee
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
    const token = `token_${user.id}_pilot`;
    store.tokens[token] = user.id;
    saveStore(store);

    res.json({
      token,
      profile: sanitizeUserProfile(user),
    });
  });

  // 3. Get authenticated user's profile, active sessions, alerts, and personal journeys
  app.get('/api/me/state', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { dateIst, timeIst, timeWithSecIst, dayOfWeek } = getNowIstParts();

    const userSessions = store.sessions.filter(
      (s) => s.userId === user.id && s.dateIst === dateIst
    );
    const userAlerts = store.alerts
      .filter((a) => a.userId === user.id)
      .sort((a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime());
    const userJourneys = store.journeys
      .filter((j) => j.userId === user.id)
      .sort((a, b) => new Date(b.actualDepartureIso).getTime() - new Date(a.actualDepartureIso).getTime());

    store.quota.liveApiConfigured = Boolean(getGoogleMapsApiKey());

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
  app.put('/api/me/profile', requireAuth, (req: AuthedRequest, res) => {
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

    saveStore(store);
    res.json({ profile: sanitizeUserProfile(user) });
  });

  // 5. Set or clear a DayOverride (Skip Today or Change Today's Commute Mode/Window/Deadline)
  app.post('/api/me/day-override', requireAuth, (req: AuthedRequest, res) => {
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
        if (s.userId === user.id && s.dateIst === dateIst && s.direction === direction) {
          s.status = 'SKIPPED';
          s.nextRefreshDueIso = null;
        }
      }
    }

    saveStore(store);
    res.json({
      profile: sanitizeUserProfile(user),
      sessions: store.sessions.filter((s) => s.userId === user.id && s.dateIst === dateIst),
    });
  });

  // 6. Privacy Controls: Delete saved locations or delete personal journey history
  app.delete('/api/me/locations', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    user.homeLocation = null;
    user.workLocation = { ...PRESTIGE_TECH_PARK_DEFAULT };
    // Stop active sessions since home location was removed
    for (const s of store.sessions) {
      if (s.userId === user.id) {
        s.status = 'STOPPED';
        s.nextRefreshDueIso = null;
      }
    }
    saveStore(store);
    res.json({
      message: 'Saved home location deleted from server storage.',
      profile: sanitizeUserProfile(user),
    });
  });

  app.delete('/api/me/journeys', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    store.journeys = store.journeys.filter((j) => j.userId !== user.id);
    store.alerts = store.alerts.filter((a) => a.userId !== user.id);
    saveStore(store);
    res.json({
      message: 'All personal journey records and alert history deleted.',
      journeys: [],
      alerts: [],
    });
  });

  // 7. Address Search & Confirmation (Google Places API New in LIVE mode, or Curated Bengaluru Places in DEMO mode)
  app.post('/api/places/search', requireAuth, async (req: AuthedRequest, res) => {
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

    const apiKey = getGoogleMapsApiKey();
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
        store.quota.lastProviderStatus = 'QUOTA_EXCEEDED';
        saveStore(store);
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
  });

  // 8. Compute Departure Recommendations & Start/Refresh Monitoring Session
  app.post('/api/monitoring/start-or-refresh', requireAuth, async (req: AuthedRequest, res) => {
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

    const result = await computeOptionsForUserDirection({
      user,
      direction,
      environment,
      simulateTrafficSpikeMin,
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

    let session = store.sessions.find(
      (s) => s.userId === user.id && s.dateIst === dateIst && s.direction === direction
    );

    if (!session) {
      session = {
        id: `mon_${user.id}_${dateIst}_${direction}`,
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
      if (
        session.status === 'STOPPED' ||
        session.status === 'SKIPPED' ||
        session.status === 'EXPIRED' ||
        session.status === 'LEFT'
      ) {
        session.status = startMode === 'SCHEDULED_LEAD' ? 'SCHEDULED' : 'ACTIVE';
        session.lastNotifiedArrivalIso = null;
        session.lastNotifiedArrivalTimeIst = null;
      }
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
    for (const alert of evalOutcome.generatedAlerts) {
      store.alerts.unshift(alert);
    }

    saveStore(store);

    res.json({
      session: evalOutcome.updatedSession,
      newAlerts: evalOutcome.generatedAlerts,
      effectiveSchedule,
      quota: store.quota,
    });
  });

  // 9. Select a specific Departure Option to track (records immutable SELECTED_OPTION snapshot)
  app.post('/api/monitoring/select-option', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { sessionId, optionId, watchMode = 'SELECTED_OPTION' } = req.body || {};

    const session = store.sessions.find(
      (s) => s.id === sessionId && s.userId === user.id
    );
    if (!session) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Monitoring session not found.' });
      return;
    }

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

    saveStore(store);
    res.json({ session });
  });

  // 10. Monitoring Actions: "I've left", "Snooze 10 minutes", "Skip today", "Stop monitoring"
  app.post('/api/monitoring/action', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { sessionId, action } = req.body || {};

    const session = store.sessions.find(
      (s) => s.id === sessionId && s.userId === user.id
    );
    if (!session) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Monitoring session not found.' });
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
      store.alerts.unshift(snoozeAlert);
      saveStore(store);
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
      saveStore(store);
      res.json({ session, profile: sanitizeUserProfile(user) });
      return;
    }

    if (action === 'STOP_MONITORING') {
      session.status = 'STOPPED';
      session.nextRefreshDueIso = null;
      saveStore(store);
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
          id: `jrn_${user.id}_${Date.now()}`,
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

      saveStore(store);
      res.json({ session, journey: createdJourney });
      return;
    }

    res.status(400).json({ error: 'INVALID_ACTION', message: 'Unsupported monitoring action.' });
  });

  // 11. Complete a Journey or Correct Manually Entered Journey Times (Keeping Original Estimates Immutable!)
  app.put('/api/journeys/:id', requireAuth, (req: AuthedRequest, res) => {
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
    saveStore(store);

    res.json({ journey: updated });
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
        durableInProcessLoopActive: true,
        pollIntervalMinutes: 5,
        webPushConfigured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      },
    });
  });

  // 13. Update daily API quota limit safeguard
  app.put('/api/pilot/quota-limit', requireAuth, (req: AuthedRequest, res) => {
    const { dailyLimit } = req.body || {};
    const parsed = parseInt(String(dailyLimit), 10);
    if (!Number.isNaN(parsed) && parsed >= 10 && parsed <= 10000) {
      store.quota.dailyLimit = parsed;
      if (store.quota.requestsUsedToday < store.quota.dailyLimit && store.quota.lastProviderStatus === 'QUOTA_EXCEEDED') {
        store.quota.lastProviderStatus = getGoogleMapsApiKey() ? 'OK' : 'UNCONFIGURED';
      }
      saveStore(store);
    }
    res.json({ quota: store.quota });
  });

  // Durable Server-Side Scheduler Loop: checks active commute monitoring sessions every 60s
  setInterval(async () => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { dateIst, timeIst } = getNowIstParts();

    for (let i = 0; i < store.sessions.length; i++) {
      const s = store.sessions[i];
      if (s.dateIst !== dateIst) continue;

      // Activate SCHEDULED sessions when leadTime window is reached
      if (s.status === 'SCHEDULED') {
        const user = store.users.find((u) => u.id === s.userId);
        if (!user) continue;
        const eff = resolveEffectiveSchedule(
          user.schedules[s.direction],
          user.dayOverrides,
          dateIst
        );
        const startLeadMin =
          hhmmToMinutes(eff.preferredDeparture) - eff.leadTimeMinutes;
        const currMin = hhmmToMinutes(timeIst);
        if (currMin >= startLeadMin) {
          s.status = 'ACTIVE';
        }
      }

      if (s.status !== 'ACTIVE' && s.status !== 'SNOOZED') continue;
      if (!s.nextRefreshDueIso) continue;

      const dueMs = new Date(s.nextRefreshDueIso).getTime();
      if (nowMs >= dueMs) {
        const user = store.users.find((u) => u.id === s.userId);
        if (!user) continue;

        const res = await computeOptionsForUserDirection({
          user,
          direction: s.direction,
          environment: s.dataEnvironment,
        });

        if (!res.providerError && !res.quotaExceeded) {
          const outcome = evaluateMonitoringUpdate({
            session: s,
            schedule: res.effectiveSchedule,
            newOptions: res.options,
            nowIso,
          });
          store.sessions[i] = outcome.updatedSession;
          for (const alert of outcome.generatedAlerts) {
            store.alerts.unshift(alert);
          }
          saveStore(store);
        }
      }
    }
  }, 60 * 1000);

  // Serve Vite in development or static dist in production
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
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

  return app;
}

const PORT = Number(process.env.PORT) || 3000;
createApp().then((app) => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ORR Pulse full-stack server running on http://0.0.0.0:${PORT}`);
  });
});
