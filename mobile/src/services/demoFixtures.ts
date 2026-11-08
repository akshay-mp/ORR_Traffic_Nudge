/**
 * Fixture data for the self-contained local DEMO mode.
 *
 * Everything is explicitly labeled DEMO and anchored to the CURRENT Asia/Kolkata
 * date at creation time so the Today screen always has a plausible "today".
 * No pilot PINs or real credentials are included anywhere in this module.
 */
import type {
  CommuteAlert,
  DirectionSchedule,
  ImmutableEstimateSnapshot,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
  UserProfile,
} from '../types/shared';
import type { DayCode } from './demoEngine';
import {
  addDaysToIstDate,
  computeJourneyMetrics,
  getNowIstParts,
  istDateAndHhmmToIso,
  PRESTIGE_TECH_PARK_DEFAULT,
} from './demoEngine';

export const DEMO_USER_ID = 'demo_local_user';

/** Curated Bengaluru neighborhoods used by DEMO address search (mirrors server preset list). */
export const DEMO_PLACES: LocationPoint[] = [
  PRESTIGE_TECH_PARK_DEFAULT,
  {
    label: '100 Feet Rd, HAL 2nd Stage, Indiranagar',
    address: '100 Feet Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038',
    lat: 12.9719,
    lng: 77.6412,
    placeId: 'ChIJ_Indiranagar_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: '27th Main Rd, Sector 2, HSR Layout',
    address: '27th Main Rd, Sector 2, HSR Layout, Bengaluru, Karnataka 560102',
    lat: 12.9116,
    lng: 77.6474,
    placeId: 'ChIJ_HSRLayout_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: '80 Feet Rd, 4th Block, Koramangala',
    address: '80 Feet Rd, 4th Block, Koramangala, Bengaluru, Karnataka 560034',
    lat: 12.9345,
    lng: 77.6266,
    placeId: 'ChIJ_Koramangala_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'ITPL Main Rd, Hoodi, Whitefield',
    address: 'ITPL Main Rd, Hoodi, Whitefield, Bengaluru, Karnataka 560048',
    lat: 12.9915,
    lng: 77.7158,
    placeId: 'ChIJ_Whitefield_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'Sarjapur Main Rd, Kaikondrahalli',
    address: 'Sarjapur Main Rd, Kaikondrahalli, Bengaluru, Karnataka 560035',
    lat: 12.9141,
    lng: 77.6776,
    placeId: 'ChIJ_Sarjapur_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'Green Glen Layout, Bellandur',
    address: 'Green Glen Layout, Bellandur, Outer Ring Rd, Bengaluru, Karnataka 560103',
    lat: 12.926,
    lng: 77.6712,
    placeId: 'ChIJ_Bellandur_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: '16th Main Rd, BTM 2nd Stage',
    address: '16th Main Rd, BTM Layout 2nd Stage, Bengaluru, Karnataka 560076',
    lat: 12.9166,
    lng: 77.6101,
    placeId: 'ChIJ_BTM_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'Old Madras Rd, Tin Factory, KR Puram',
    address: 'Old Madras Rd, Bennigana Halli, KR Puram, Bengaluru, Karnataka 560016',
    lat: 12.9968,
    lng: 77.6682,
    placeId: 'ChIJ_KRPuram_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: '11th Main Rd, 4th Block, Jayanagar',
    address: '11th Main Rd, 4th Block, Jayanagar, Bengaluru, Karnataka 560011',
    lat: 12.9279,
    lng: 77.5831,
    placeId: 'ChIJ_Jayanagar_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'Bellary Rd, Hebbal Kempapura',
    address: 'Bellary Rd, Hebbal Kempapura, Bengaluru, Karnataka 560024',
    lat: 13.0358,
    lng: 77.597,
    placeId: 'ChIJ_Hebbal_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
  {
    label: 'Marathahalli Bridge Service Rd, Munnekollal',
    address: 'Marathahalli Bridge Service Rd, Munnekollal, Bengaluru, Karnataka 560037',
    lat: 12.9562,
    lng: 77.7019,
    placeId: 'ChIJ_Marathahalli_Bengaluru',
    confirmedAt: '2026-11-01T04:00:00.000Z',
  },
];

export function searchDemoPlaces(query: string): LocationPoint[] {
  const q = query.trim().toLowerCase();
  if (!q) return DEMO_PLACES.slice(0, 6);
  const matches = DEMO_PLACES.filter(
    (p) => p.label.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)
  );
  return matches.length > 0 ? matches : DEMO_PLACES.slice(0, 5);
}

function makeSchedule(
  direction: 'HOME_TO_WORK' | 'WORK_TO_HOME',
  mode: 'BIKE' | 'CAR' | 'BMTC',
  days: DayCode[],
  windowStart: string,
  windowEnd: string,
  preferredDeparture: string,
  arrivalDeadline: string | null,
  safetyBufferMinutes: number
): DirectionSchedule {
  return {
    direction,
    enabled: true,
    mode,
    days,
    windowStart,
    windowEnd,
    arrivalDeadline,
    preferredDeparture,
    safetyBufferMinutes,
    leadTimeMinutes: 15,
    alertThresholdMinutes: 5,
  };
}

export function makeDemoProfile(todayIst: string): UserProfile {
  const demoHome = DEMO_PLACES.find((p) => p.label.includes('HSR Layout'))!;
  return {
    id: DEMO_USER_ID,
    employeeCode: 'DEMO-LOCAL',
    name: 'Demo Rider (Local)',
    role: 'Demo profile on this device',
    corridorTag: 'HSR Layout → Agara → Bellandur → Prestige Tech Park',
    onboardingComplete: true,
    // Explicit opt-in: demo trip recording starts OFF; the onboarding welcome
    // and Settings both offer it, and tests assert the default.
    telemetryConsent: false,
    pushOptIn: false,
    homeLocation: { ...demoHome, confirmedAt: `${todayIst}T00:00:00.000Z` },
    workLocation: { ...PRESTIGE_TECH_PARK_DEFAULT },
    schedules: {
      HOME_TO_WORK: makeSchedule(
        'HOME_TO_WORK',
        'CAR',
        ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        '08:00',
        '09:15',
        '08:30',
        '09:45',
        10
      ),
      WORK_TO_HOME: makeSchedule(
        'WORK_TO_HOME',
        'CAR',
        ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        '17:30',
        '19:00',
        '18:00',
        '19:45',
        10
      ),
    },
    dayOverrides: [],
  };
}

interface DemoJourneySpec {
  id: string;
  daysAgo: number;
  direction: 'HOME_TO_WORK' | 'WORK_TO_HOME';
  transportMode: 'BIKE' | 'CAR' | 'BMTC';
  originLabel: string;
  destinationLabel: string;
  depHhmm: string;
  selPredDurMin: number;
  depPredDurMin: number;
  actualArrHhmm: string | null;
  changedPlanOrRoute: boolean;
  usefulRating: 'YES' | 'SOMEWHAT' | 'NO' | null;
  feedbackNote?: string;
}

const DEMO_JOURNEY_SPECS: DemoJourneySpec[] = [
  {
    id: 'demo_j_01',
    daysAgo: 1,
    direction: 'HOME_TO_WORK',
    transportMode: 'CAR',
    originLabel: '27th Main Rd, HSR Layout',
    destinationLabel: 'Prestige Tech Park (ORR)',
    depHhmm: '08:30',
    selPredDurMin: 31,
    depPredDurMin: 33,
    actualArrHhmm: '09:06',
    changedPlanOrRoute: false,
    usefulRating: 'YES',
    feedbackNote: 'Left before the Agara junction bottleneck built up.',
  },
  {
    id: 'demo_j_02',
    daysAgo: 2,
    direction: 'HOME_TO_WORK',
    transportMode: 'BMTC',
    originLabel: '27th Main Rd, HSR Layout',
    destinationLabel: 'Prestige Tech Park (ORR)',
    depHhmm: '08:10',
    selPredDurMin: 48,
    depPredDurMin: 52,
    actualArrHhmm: '09:15',
    changedPlanOrRoute: false,
    usefulRating: 'SOMEWHAT',
    feedbackNote: 'Bus waited long at Iblur signal.',
  },
  {
    id: 'demo_j_03',
    daysAgo: 1,
    direction: 'WORK_TO_HOME',
    transportMode: 'CAR',
    originLabel: 'Prestige Tech Park (ORR)',
    destinationLabel: '27th Main Rd, HSR Layout',
    depHhmm: '18:05',
    selPredDurMin: 36,
    depPredDurMin: 41,
    actualArrHhmm: '18:58',
    changedPlanOrRoute: true,
    usefulRating: 'NO',
    feedbackNote: 'Took the Sarjapur Road shortcut instead of ORR.',
  },
  {
    id: 'demo_j_04',
    daysAgo: 0,
    direction: 'HOME_TO_WORK',
    transportMode: 'CAR',
    originLabel: '27th Main Rd, HSR Layout',
    destinationLabel: 'Prestige Tech Park (ORR)',
    depHhmm: '08:32',
    selPredDurMin: 32,
    depPredDurMin: 34,
    actualArrHhmm: null,
    changedPlanOrRoute: false,
    usefulRating: null,
  },
];

function hhmmPlusMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  const total = (h * 60 + m + minutes + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function makeDemoJourneys(todayIst: string): JourneyRecord[] {
  return DEMO_JOURNEY_SPECS.map((spec) => {
    const dateIst = addDaysToIstDate(todayIst, -spec.daysAgo);
    const selArrHhmm = hhmmPlusMinutes(spec.depHhmm, spec.selPredDurMin);
    const depArrHhmm = hhmmPlusMinutes(spec.depHhmm, spec.depPredDurMin);
    const issuedAtIso = istDateAndHhmmToIso(dateIst, spec.depHhmm);

    const selectedEstimate: ImmutableEstimateSnapshot = Object.freeze({
      snapshotType: 'SELECTED_OPTION',
      optionId: `opt_demo_${spec.id}`,
      departureTimeIst: spec.depHhmm,
      predictedDurationMin: spec.selPredDurMin,
      predictedArrivalIso: istDateAndHhmmToIso(dateIst, selArrHhmm),
      predictedArrivalTimeIst: selArrHhmm,
      issuedAtIso,
      issuedAtIst: `${spec.depHhmm}:00 IST`,
      estimateBasis: spec.transportMode === 'BMTC' ? 'TIMETABLE' : 'FUTURE_FORECAST',
      dataSource: 'ORR Pulse Synthetic Demo Engine (Labeled Demo)',
      environment: 'DEMO',
      userSafetyBufferMin: 10,
    });

    const departureEstimate: ImmutableEstimateSnapshot = Object.freeze({
      ...selectedEstimate,
      snapshotType: 'AT_DEPARTURE',
      predictedDurationMin: spec.depPredDurMin,
      predictedArrivalIso: istDateAndHhmmToIso(dateIst, depArrHhmm),
      predictedArrivalTimeIst: depArrHhmm,
    });

    const actualDepartureIso = istDateAndHhmmToIso(dateIst, spec.depHhmm);
    const actualArrivalIso = spec.actualArrHhmm
      ? istDateAndHhmmToIso(dateIst, spec.actualArrHhmm)
      : null;

    return {
      id: spec.id,
      userId: DEMO_USER_ID,
      dateIst,
      direction: spec.direction,
      transportMode: spec.transportMode,
      environment: 'DEMO',
      originLabel: spec.originLabel,
      destinationLabel: spec.destinationLabel,
      selectedEstimate,
      departureEstimate,
      actualDepartureIso,
      actualDepartureTimeIst: spec.depHhmm,
      actualArrivalIso,
      actualArrivalTimeIst: spec.actualArrHhmm,
      changedPlanOrRoute: spec.changedPlanOrRoute,
      usefulRating: spec.usefulRating,
      feedbackNote: spec.feedbackNote,
      correctedAtIso: null,
      correctionHistoryCount: 0,
      metrics: computeJourneyMetrics(
        selectedEstimate,
        departureEstimate,
        actualDepartureIso,
        actualArrivalIso
      ),
    } satisfies JourneyRecord;
  });
}

export interface DemoState {
  schemaVersion: 1;
  /** IST date (YYYY-MM-DD) this state was last rolled over for. */
  anchoredDateIst: string;
  profile: UserProfile;
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  onboardingAcknowledged: boolean;
}

export function makeFreshDemoState(nowIso: string): DemoState {
  const { dateIst } = getNowIstParts(new Date(nowIso));
  return {
    schemaVersion: 1,
    anchoredDateIst: dateIst,
    profile: makeDemoProfile(dateIst),
    sessions: [],
    alerts: [],
    journeys: makeDemoJourneys(dateIst),
    onboardingAcknowledged: false,
  };
}
