import {
  BMTC_TIMETABLE_LIMITATION_NOTE,
  buildDepartureRecommendations,
  computeDemoSlotPrediction,
  generateCandidateDepartureTimes,
  getNowIstParts,
  istDateAndHhmmToIso,
  PRESTIGE_TECH_PARK_DEFAULT,
  resolveEffectiveSchedule,
  SlotPredictionInput,
} from '../lib/commuteEngine';
import { PilotUserSeed } from '../lib/pilotSeed';
import {
  CommuteDirection,
  DataEnvironment,
  LocationPoint,
  TransitStepDetail,
  TransportMode,
} from '../types/commute';
import { DatabaseSync } from 'node:sqlite';
import {
  checkBudgetAndIncrement,
  mutateQuotaPersistSafe,
  PersistentStore,
} from './store';

export type EnvGetter = () => NodeJS.ProcessEnv;
export const ROUTES_REQUEST_TIMEOUT_MS = 10_000;

export function getGoogleMapsApiKey(env: NodeJS.ProcessEnv): string {
  return (
    env.GOOGLE_MAPS_API_KEY ||
    env.VITE_GOOGLE_MAPS_API_KEY ||
    env.MAPS_API_KEY ||
    ''
  ).trim();
}

export interface ComputeOptionsOutcome {
  options: ReturnType<typeof buildDepartureRecommendations>;
  effectiveSchedule: ReturnType<typeof resolveEffectiveSchedule>;
  unsupportedReason?: string;
  quotaExceeded?: boolean;
  providerError?: string;
}

export type OptionsProviderOverride = (params: {
  user: PilotUserSeed;
  direction: CommuteDirection;
  environment: DataEnvironment;
  signal?: AbortSignal;
}) => Promise<ComputeOptionsOutcome>;

async function computeLiveSlotPrediction(
  env: NodeJS.ProcessEnv,
  db: DatabaseSync,
  store: PersistentStore,
  params: {
    origin: LocationPoint;
    destination: LocationPoint;
    mode: TransportMode;
    departureTimeIst: string;
    departureIso: string;
    isNowSlot: boolean;
    signal?: AbortSignal;
  }
): Promise<{
  supported: boolean;
  unsupportedReason?: string;
  quotaExceeded?: boolean;
  providerError?: string;
  prediction?: SlotPredictionInput;
}> {
  const apiKey = getGoogleMapsApiKey(env);
  if (!apiKey) {
    store.quota.liveApiConfigured = false;
    store.quota.lastProviderStatus = 'UNCONFIGURED';
    return {
      supported: false,
      providerError:
        'Google Maps Platform API key is not configured on the server. Switch to Labeled Demo Mode or configure GOOGLE_MAPS_API_KEY.',
    };
  }

  const budgetCheck = checkBudgetAndIncrement(db, store, 'ROUTES');
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
      signal: params.signal ?? AbortSignal.timeout(ROUTES_REQUEST_TIMEOUT_MS),
    });

    if (response.status === 429) {
      mutateQuotaPersistSafe(db, store, (q) => {
        q.lastProviderStatus = 'QUOTA_EXCEEDED';
        q.lastErrorMessage =
          'Google Maps Platform Routes API quota exceeded (HTTP 429).';
      });
      return {
        supported: false,
        quotaExceeded: true,
        providerError:
          'Google Maps Platform Routes API quota exceeded (HTTP 429).',
      };
    }

    const payload = (await response.json()) as any;

    if (!response.ok) {
      const errStatus = payload?.error?.status || '';
      const errMsg = payload?.error?.message || `HTTP ${response.status}`;
      if (errStatus === 'RESOURCE_EXHAUSTED' || errMsg.includes('Quota')) {
        mutateQuotaPersistSafe(db, store, (q) => {
          q.lastProviderStatus = 'QUOTA_EXCEEDED';
          q.lastErrorMessage = errMsg;
        });
        return {
          supported: false,
          quotaExceeded: true,
          providerError: errMsg,
        };
      }
      mutateQuotaPersistSafe(db, store, (q) => {
        q.lastProviderStatus = 'PROVIDER_ERROR';
        q.lastErrorMessage = errMsg;
      });
      return {
        supported: false,
        providerError: `Routes API Error (${errStatus || response.status}): ${errMsg}`,
      };
    }

    mutateQuotaPersistSafe(db, store, (q) => {
      q.lastProviderStatus = 'OK';
      q.lastErrorMessage = null;
    });

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
    const message = err?.message || 'Network failure calling Routes API';
    mutateQuotaPersistSafe(db, store, (q) => {
      q.lastProviderStatus = 'PROVIDER_ERROR';
      q.lastErrorMessage = message;
    });
    return {
      supported: false,
      providerError: message,
    };
  }
}

export interface ComputeOptionsDeps {
  db: DatabaseSync;
  store: PersistentStore;
  env: EnvGetter;
  /** Test seam: replaces all provider computation (no network). */
  providerOverride?: OptionsProviderOverride;
}

export function createComputeOptions(deps: ComputeOptionsDeps) {
  return async function computeOptionsForUserDirection(params: {
    user: PilotUserSeed;
    direction: CommuteDirection;
    environment: DataEnvironment;
    simulateTrafficSpikeMin?: number;
    signal?: AbortSignal;
  }): Promise<ComputeOptionsOutcome> {
    if (deps.providerOverride) {
      return deps.providerOverride(params);
    }

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
        const liveRes = await computeLiveSlotPrediction(
          deps.env(),
          deps.db,
          deps.store,
          {
            origin,
            destination,
            mode: effectiveSchedule.mode,
            departureTimeIst: slot.hhmm,
            departureIso: depIso,
            isNowSlot: slot.isNow,
            signal: params.signal,
          }
        );

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
  };
}

export { PRESTIGE_TECH_PARK_DEFAULT };
