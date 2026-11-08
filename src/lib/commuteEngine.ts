import {
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DayOfWeek,
  DayOverride,
  DepartureOption,
  DirectionSchedule,
  EstimateBasis,
  ImmutableEstimateSnapshot,
  JourneyMetrics,
  JourneyRecord,
  LocationPoint,
  ModePilotSummary,
  MonitoringSession,
  PilotMetricsReport,
  RecommendationRole,
  TransitStepDetail,
  TransportMode,
} from '../types/commute';

export const PRESTIGE_TECH_PARK_DEFAULT: LocationPoint = {
  label: 'Prestige Tech Park (Kadubeesanahalli, ORR)',
  address: 'Prestige Tech Park, Kadubeesanahalli, Outer Ring Rd, Bengaluru, Karnataka 560103',
  lat: 12.9438,
  lng: 77.6939,
  placeId: 'ChIJL2fQ8tsTrjsR_PrestigeTechParkORR',
  confirmedAt: '2026-11-01T03:30:00.000Z',
};

export const TWO_WHEELER_BETA_WARNING =
  'Two-wheeler routing is in beta and may occasionally be missing clear road restrictions, lane guidance, or service-road access along Outer Ring Road.';

export const BMTC_TIMETABLE_LIMITATION_NOTE =
  'Timetable-based estimate from scheduled BMTC GTFS stops. Live GPS bus arrival feeds are not provided; actual wait times at ORR bus stops may vary with corridor congestion.';

const DAY_MAP: Record<string, DayOfWeek> = {
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
};

export function getNowIstParts(date: Date = new Date()): {
  dateIst: string;
  timeIst: string;
  timeWithSecIst: string;
  dayOfWeek: DayOfWeek;
  minutesFromMidnight: number;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const year = partMap.year || '2026';
  const month = partMap.month || '11';
  const day = partMap.day || '08';
  const hour = partMap.hour === '24' ? '00' : (partMap.hour || '08');
  const minute = partMap.minute || '00';
  const second = partMap.second || '00';
  const weekdayShort = partMap.weekday || 'Mon';

  const dateIst = `${year}-${month}-${day}`;
  const timeIst = `${hour}:${minute}`;
  const timeWithSecIst = `${hour}:${minute}:${second} IST`;
  const dayOfWeek = DAY_MAP[weekdayShort] || 'MON';
  const minutesFromMidnight = parseInt(hour, 10) * 60 + parseInt(minute, 10);

  return {
    dateIst,
    timeIst,
    timeWithSecIst,
    dayOfWeek,
    minutesFromMidnight,
  };
}

export function hhmmToMinutes(hhmm: string): number {
  const clean = hhmm.trim();
  const [hStr, mStr] = clean.split(':');
  const h = parseInt(hStr || '0', 10);
  const m = parseInt(mStr || '0', 10);
  return h * 60 + m;
}

export function minutesToHhmm(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function istDateAndHhmmToIso(dateIst: string, hhmm: string): string {
  const cleanHhmm = hhmm.trim().slice(0, 5);
  const d = new Date(`${dateIst}T${cleanHhmm}:00+05:30`);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString();
  }
  return d.toISOString();
}

export function isoToIstHhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00:00';
  return getNowIstParts(d).timeIst;
}

export function isoToIstWithSec(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00:00:00 IST';
  return getNowIstParts(d).timeWithSecIst;
}

export function resolveEffectiveSchedule(
  baseSchedule: DirectionSchedule,
  overrides: DayOverride[],
  dateIst: string
): DirectionSchedule & { skippedToday: boolean } {
  const match = overrides.find(
    (o) => o.dateIst === dateIst && o.direction === baseSchedule.direction
  );
  if (!match) {
    return { ...baseSchedule, skippedToday: false };
  }
  return {
    ...baseSchedule,
    skippedToday: match.skipped,
    mode: match.overrideMode ?? baseSchedule.mode,
    windowStart: match.overrideWindowStart ?? baseSchedule.windowStart,
    windowEnd: match.overrideWindowEnd ?? baseSchedule.windowEnd,
    arrivalDeadline:
      match.overrideArrivalDeadline !== undefined
        ? match.overrideArrivalDeadline
        : baseSchedule.arrivalDeadline,
    preferredDeparture:
      match.overridePreferredDeparture ?? baseSchedule.preferredDeparture,
  };
}

export interface SlotPredictionInput {
  departureTimeIst: string; // "HH:mm"
  departureIso: string;
  isNowSlot: boolean;
  predictedDurationMin: number;
  staticDurationMin?: number;
  durationRangeMin?: [number, number];
  estimateBasis: EstimateBasis;
  dataSource: string;
  environment: DataEnvironment;
  distanceKm: number;
  corridorSummary: string;
  transitDetails?: DepartureOption['transitDetails'];
}

export function generateCandidateDepartureTimes(
  windowStartHhmm: string,
  windowEndHhmm: string,
  preferredDepartureHhmm: string,
  nowHhmm: string
): Array<{ hhmm: string; isNow: boolean }> {
  const startMin = hhmmToMinutes(windowStartHhmm);
  const endMin = Math.max(startMin, hhmmToMinutes(windowEndHhmm));
  const prefMin = hhmmToMinutes(preferredDepartureHhmm);
  const nowMin = hhmmToMinutes(nowHhmm);

  const slotMap = new Map<number, boolean>();

  // If current time is inside [windowStart, windowEnd], include Leave Now
  if (nowMin >= startMin && nowMin <= endMin) {
    slotMap.set(nowMin, true);
  }

  // Generate 15-minute intervals across [startMin, endMin]
  for (let m = startMin; m <= endMin; m += 15) {
    if (m >= nowMin || nowMin < startMin) {
      if (!slotMap.has(m)) {
        slotMap.set(m, m === nowMin);
      }
    }
  }

  // Always include windowEnd if not passed
  if (endMin >= nowMin || nowMin < startMin) {
    if (!slotMap.has(endMin)) {
      slotMap.set(endMin, endMin === nowMin);
    }
  }

  // Include preferred departure if within window and not in the past
  if (prefMin >= startMin && prefMin <= endMin && (prefMin >= nowMin || nowMin < startMin)) {
    if (!slotMap.has(prefMin)) {
      slotMap.set(prefMin, prefMin === nowMin);
    }
  }

  // If all slots in window are in the past compared to nowMin, still include windowStart, pref, windowEnd for inspection before expiry
  if (slotMap.size === 0) {
    slotMap.set(startMin, false);
    if (prefMin >= startMin && prefMin <= endMin) slotMap.set(prefMin, false);
    slotMap.set(endMin, false);
  }

  const sorted = Array.from(slotMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([mins, isNow]) => ({
      hhmm: minutesToHhmm(mins),
      isNow,
    }));

  // Collapse slots within 3 minutes of "now" to avoid redundant near-duplicate API calls
  const filtered: Array<{ hhmm: string; isNow: boolean }> = [];
  for (const item of sorted) {
    const itemMin = hhmmToMinutes(item.hhmm);
    const conflict = filtered.find(
      (f) => Math.abs(hhmmToMinutes(f.hhmm) - itemMin) <= 3
    );
    if (!conflict) {
      filtered.push(item);
    } else if (item.isNow) {
      conflict.hhmm = item.hhmm;
      conflict.isNow = true;
    }
  }

  return filtered.slice(0, 6);
}

export function buildDepartureRecommendations(params: {
  dateIst: string;
  nowIso: string;
  schedule: DirectionSchedule;
  slotPredictions: SlotPredictionInput[];
}): DepartureOption[] {
  const { dateIst, nowIso, schedule, slotPredictions } = params;
  if (slotPredictions.length === 0) return [];

  const sortedSlots = [...slotPredictions].sort(
    (a, b) => hhmmToMinutes(a.departureTimeIst) - hhmmToMinutes(b.departureTimeIst)
  );

  const deadlineMin = schedule.arrivalDeadline
    ? hhmmToMinutes(schedule.arrivalDeadline)
    : null;

  // 1. Identify "LEAVE_NOW" slot (only when a slot is marked isNowSlot within the window)
  const leaveNowSlot = sortedSlots.find((s) => s.isNowSlot) || null;

  // 2. Identify "SHORTEST_PREDICTED" slot within the window
  // Important rule: Never imply waiting will save time without supporting predictions.
  // If leaveNowSlot exists and no future slot is strictly shorter by at least 2 minutes,
  // leaveNowSlot itself is the shortest predicted journey.
  let shortestSlot = sortedSlots[0];
  for (const slot of sortedSlots) {
    if (slot.predictedDurationMin < shortestSlot.predictedDurationMin) {
      shortestSlot = slot;
    }
  }
  if (
    leaveNowSlot &&
    shortestSlot.departureTimeIst !== leaveNowSlot.departureTimeIst &&
    leaveNowSlot.predictedDurationMin - shortestSlot.predictedDurationMin < 2
  ) {
    shortestSlot = leaveNowSlot;
  }

  // 3. Identify "LATEST_FOR_DEADLINE" slot when arrivalDeadline is supplied
  let latestForDeadlineSlot: SlotPredictionInput | null = null;
  if (deadlineMin !== null) {
    const meetingSlots = sortedSlots.filter((s) => {
      const arrMin = hhmmToMinutes(s.departureTimeIst) + s.predictedDurationMin;
      return arrMin <= deadlineMin;
    });
    if (meetingSlots.length > 0) {
      latestForDeadlineSlot = meetingSlots[meetingSlots.length - 1];
    } else {
      // No slot in window meets deadline: choose the one that arrives earliest to minimize lateness
      latestForDeadlineSlot = sortedSlots.reduce((best, curr) => {
        const bestArr = hhmmToMinutes(best.departureTimeIst) + best.predictedDurationMin;
        const currArr = hhmmToMinutes(curr.departureTimeIst) + curr.predictedDurationMin;
        return currArr < bestArr ? curr : best;
      }, sortedSlots[0]);
    }
  }

  // Group roles by slot departureTimeIst to combine duplicates!
  // "Combine duplicate options. Do not invent three choices when only one is supported."
  const roleMap = new Map<string, { slot: SlotPredictionInput; roles: RecommendationRole[] }>();

  const assignRole = (slot: SlotPredictionInput | null, role: RecommendationRole) => {
    if (!slot) return;
    const key = slot.departureTimeIst;
    const existing = roleMap.get(key);
    if (existing) {
      if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    } else {
      roleMap.set(key, { slot, roles: [role] });
    }
  };

  assignRole(leaveNowSlot, 'LEAVE_NOW');
  assignRole(shortestSlot, 'SHORTEST_PREDICTED');
  assignRole(latestForDeadlineSlot, 'LATEST_FOR_DEADLINE');

  const nowDuration = leaveNowSlot ? leaveNowSlot.predictedDurationMin : null;

  const options: DepartureOption[] = [];
  for (const [, { slot, roles }] of roleMap.entries()) {
    const depMin = hhmmToMinutes(slot.departureTimeIst);
    const rawArrMin = depMin + slot.predictedDurationMin;
    const bufferedArrMin = rawArrMin + schedule.safetyBufferMinutes;

    const predictedArrivalTimeIst = minutesToHhmm(rawArrMin);
    const bufferedArrivalTimeIst = minutesToHhmm(bufferedArrMin);
    const predictedArrivalIso = new Date(
      new Date(slot.departureIso).getTime() + slot.predictedDurationMin * 60000
    ).toISOString();

    let deadlineRelation: DepartureOption['deadlineRelation'];
    if (deadlineMin !== null && schedule.arrivalDeadline) {
      const deltaMinutes = rawArrMin - deadlineMin; // negative = early, positive = late
      const meetsRaw = deltaMinutes <= 0;
      const meetsWithBuffer = bufferedArrMin <= deadlineMin;
      let summaryText = '';
      if (deltaMinutes < 0) {
        summaryText = `Arrives ${Math.abs(deltaMinutes)} min before ${schedule.arrivalDeadline} deadline`;
        if (schedule.safetyBufferMinutes > 0) {
          const bufDelta = bufferedArrMin - deadlineMin;
          summaryText +=
            bufDelta <= 0
              ? ` (${Math.abs(bufDelta)} min margin with +${schedule.safetyBufferMinutes}m buffer)`
              : ` (+${schedule.safetyBufferMinutes}m buffer exceeds deadline by ${bufDelta} min)`;
        }
      } else if (deltaMinutes === 0) {
        summaryText = `Arrives exactly at ${schedule.arrivalDeadline} deadline`;
      } else {
        summaryText = `Misses ${schedule.arrivalDeadline} deadline by ${deltaMinutes} min`;
      }
      deadlineRelation = {
        hasDeadline: true,
        deadlineTimeIst: schedule.arrivalDeadline,
        deltaMinutes,
        meetsRaw,
        meetsWithBuffer,
        summaryText,
      };
    } else {
      deadlineRelation = {
        hasDeadline: false,
        deadlineTimeIst: null,
        deltaMinutes: null,
        meetsRaw: true,
        meetsWithBuffer: true,
        summaryText: `Window ${schedule.windowStart}–${schedule.windowEnd} (No arrival deadline set)`,
      };
    }

    const titleParts: string[] = [];
    if (roles.includes('LEAVE_NOW')) titleParts.push('Leave Now');
    if (roles.includes('SHORTEST_PREDICTED')) titleParts.push('Shortest Predicted Journey');
    if (roles.includes('LATEST_FOR_DEADLINE')) {
      titleParts.push(
        deadlineRelation.meetsRaw
          ? `Latest Departure for ${schedule.arrivalDeadline}`
          : `Earliest Arrival vs ${schedule.arrivalDeadline} Deadline`
      );
    }

    const reasonParts: string[] = [];
    if (roles.includes('LEAVE_NOW')) {
      reasonParts.push(
        `Immediate departure within your ${schedule.windowStart}–${schedule.windowEnd} window.`
      );
    }
    if (roles.includes('SHORTEST_PREDICTED')) {
      if (
        !roles.includes('LEAVE_NOW') &&
        nowDuration !== null &&
        nowDuration > slot.predictedDurationMin
      ) {
        const saved = nowDuration - slot.predictedDurationMin;
        reasonParts.push(
          `Forecast predicts ${saved} min shorter travel time (${slot.predictedDurationMin} min vs ${nowDuration} min right now).`
        );
      } else {
        reasonParts.push(
          `Lowest predicted travel duration (${slot.predictedDurationMin} min) across your permitted window.`
        );
      }
    }
    if (roles.includes('LATEST_FOR_DEADLINE') && schedule.arrivalDeadline) {
      if (deadlineRelation.meetsRaw) {
        reasonParts.push(
          `Latest window slot predicted to reach destination before ${schedule.arrivalDeadline}.`
        );
      } else {
        reasonParts.push(
          `Current corridor conditions prevent meeting ${schedule.arrivalDeadline} within window; this slot minimizes delay.`
        );
      }
    }

    options.push({
      id: `opt_${dateIst}_${schedule.direction}_${slot.departureTimeIst.replace(':', '')}`,
      roles,
      title: titleParts.join(' · '),
      whyRecommended: reasonParts.join(' '),
      departureTimeIst: slot.departureTimeIst,
      departureIso: slot.departureIso,
      predictedDurationMin: slot.predictedDurationMin,
      staticDurationMin: slot.staticDurationMin,
      durationRangeMin: slot.durationRangeMin,
      userSafetyBufferMin: schedule.safetyBufferMinutes,
      predictedArrivalTimeIst,
      predictedArrivalIso,
      bufferedArrivalTimeIst,
      deadlineRelation,
      transportMode: schedule.mode,
      dataSource: slot.dataSource,
      environment: slot.environment,
      lastUpdatedIso: nowIso,
      lastUpdatedIst: isoToIstWithSec(nowIso),
      estimateBasis: slot.estimateBasis,
      betaNotice: schedule.mode === 'BIKE' ? TWO_WHEELER_BETA_WARNING : undefined,
      transitDetails: slot.transitDetails,
      distanceKm: slot.distanceKm,
      corridorSummary: slot.corridorSummary,
    });
  }

  return options.sort(
    (a, b) => hhmmToMinutes(a.departureTimeIst) - hhmmToMinutes(b.departureTimeIst)
  );
}

export function evaluateMonitoringUpdate(params: {
  session: MonitoringSession;
  schedule: DirectionSchedule;
  newOptions: DepartureOption[];
  nowIso: string;
}): {
  updatedSession: MonitoringSession;
  generatedAlerts: CommuteAlert[];
} {
  const { session, schedule, newOptions, nowIso } = params;
  const generatedAlerts: CommuteAlert[] = [];

  // Terminal states never generate new departure alerts
  if (
    session.status === 'LEFT' ||
    session.status === 'SKIPPED' ||
    session.status === 'STOPPED' ||
    session.status === 'EXPIRED'
  ) {
    return { updatedSession: session, generatedAlerts: [] };
  }

  const nowMs = new Date(nowIso).getTime();
  const expiresMs = new Date(session.expiresAtIso).getTime();

  // Check if monitoring window has expired
  if (nowMs > expiresMs) {
    const expiredAlert: CommuteAlert = {
      id: `alert_exp_${session.id}_${nowMs}`,
      userId: session.userId,
      sessionId: session.id,
      createdAtIso: nowIso,
      createdAtIst: isoToIstWithSec(nowIso),
      type: 'SESSION_EXPIRED',
      severity: 'INFO',
      title: 'Commute Window Ended',
      message: `Monitoring expired at the end of your ${schedule.windowStart}–${schedule.windowEnd} departure window.`,
      deliveredChannels: ['IN_APP'],
      acknowledged: false,
    };
    return {
      updatedSession: {
        ...session,
        status: 'EXPIRED',
        nextRefreshDueIso: null,
        latestOptions: newOptions,
      },
      generatedAlerts: [expiredAlert],
    };
  }

  // Check if snooze has elapsed
  let activeStatus = session.status;
  if (
    activeStatus === 'SNOOZED' &&
    session.snoozedUntilIso &&
    nowMs >= new Date(session.snoozedUntilIso).getTime()
  ) {
    activeStatus = 'ACTIVE';
  }

  // Determine the option currently tracked for alerts
  let trackedOption: DepartureOption | undefined;
  if (session.selectedOptionId) {
    trackedOption = newOptions.find((o) => o.id === session.selectedOptionId);
  }
  if (!trackedOption && newOptions.length > 0) {
    trackedOption =
      newOptions.find((o) => o.roles.includes('LATEST_FOR_DEADLINE')) ||
      newOptions.find((o) => o.roles.includes('LEAVE_NOW')) ||
      newOptions[0];
  }

  let lastNotifiedArrivalIso = session.lastNotifiedArrivalIso;
  let lastNotifiedArrivalTimeIst = session.lastNotifiedArrivalTimeIst;
  let suppressedDuplicatesCount = session.suppressedDuplicatesCount;

  if (trackedOption) {
    const newArrIso = trackedOption.predictedArrivalIso;
    const newArrIst = trackedOption.predictedArrivalTimeIst;

    if (!lastNotifiedArrivalIso || !lastNotifiedArrivalTimeIst) {
      // First baseline notification: send Departure Reminder if not snoozed
      lastNotifiedArrivalIso = newArrIso;
      lastNotifiedArrivalTimeIst = newArrIst;

      if (activeStatus !== 'SNOOZED') {
        const deadlineSuffix = schedule.arrivalDeadline
          ? ` Your arrival deadline is ${schedule.arrivalDeadline}.`
          : '';
        generatedAlerts.push({
          id: `alert_rem_${session.id}_${nowMs}`,
          userId: session.userId,
          sessionId: session.id,
          createdAtIso: nowIso,
          createdAtIst: isoToIstWithSec(nowIso),
          type: 'DEPARTURE_REMINDER',
          severity: 'INFO',
          title: `Departure Plan: Leave at ${trackedOption.departureTimeIst}`,
          message: `Recommended departure at ${trackedOption.departureTimeIst} (${trackedOption.predictedDurationMin} min via ${trackedOption.transportMode}) for estimated arrival at ${newArrIst}.${deadlineSuffix}`,
          newEtaIst: newArrIst,
          deadlineIst: schedule.arrivalDeadline,
          deliveredChannels: ['IN_APP'],
          acknowledged: false,
        });
      }
    } else {
      // Compare against last notified estimate
      const prevMin = hhmmToMinutes(lastNotifiedArrivalTimeIst);
      const currMin = hhmmToMinutes(newArrIst);
      const deteriorationMin = currMin - prevMin;

      const deadlineMin = schedule.arrivalDeadline
        ? hhmmToMinutes(schedule.arrivalDeadline)
        : null;
      const threatensDeadline =
        deadlineMin !== null && currMin > deadlineMin && prevMin <= deadlineMin;
      const exceedsThreshold = deteriorationMin >= schedule.alertThresholdMinutes;

      if ((exceedsThreshold || threatensDeadline) && activeStatus !== 'SNOOZED') {
        const deadlineClause = schedule.arrivalDeadline
          ? ` Your arrival deadline is ${schedule.arrivalDeadline}.`
          : ` That is a +${deteriorationMin} min deterioration from the last notified estimate.`;

        const exactMessage = `Your estimated arrival moved from ${lastNotifiedArrivalTimeIst} to ${newArrIst}.${deadlineClause}`;

        generatedAlerts.push({
          id: `alert_det_${session.id}_${nowMs}`,
          userId: session.userId,
          sessionId: session.id,
          createdAtIso: nowIso,
          createdAtIst: isoToIstWithSec(nowIso),
          type: threatensDeadline ? 'DEADLINE_THREAT' : 'ARRIVAL_DETERIORATION',
          severity: threatensDeadline ? 'CRITICAL' : 'WARNING',
          title: threatensDeadline
            ? `Arrival Deadline Threatened (${schedule.arrivalDeadline})`
            : `ETA Deteriorated by ${deteriorationMin} min`,
          message: exactMessage,
          previousEtaIst: lastNotifiedArrivalTimeIst,
          newEtaIst: newArrIst,
          deadlineIst: schedule.arrivalDeadline,
          deteriorationMinutes: deteriorationMin,
          deliveredChannels: ['IN_APP'],
          acknowledged: false,
        });

        lastNotifiedArrivalIso = newArrIso;
        lastNotifiedArrivalTimeIst = newArrIst;
      } else if (deteriorationMin > 0 && deteriorationMin < schedule.alertThresholdMinutes) {
        // Suppress minor change duplicate alert
        suppressedDuplicatesCount += 1;
      } else if (deteriorationMin === 0 && session.refreshCount > 0) {
        // Unchanged ETA duplicate suppressed
        suppressedDuplicatesCount += 1;
      }
    }
  }

  const nextRefreshDueIso = new Date(nowMs + 5 * 60 * 1000).toISOString();

  const updatedSession: MonitoringSession = {
    ...session,
    status: activeStatus,
    lastNotifiedArrivalIso,
    lastNotifiedArrivalTimeIst,
    lastRefreshedAtIso: nowIso,
    nextRefreshDueIso,
    refreshCount: session.refreshCount + 1,
    suppressedDuplicatesCount,
    latestOptions: newOptions,
  };

  return { updatedSession, generatedAlerts };
}

export function createImmutableSnapshot(
  option: DepartureOption,
  snapshotType: 'SELECTED_OPTION' | 'AT_DEPARTURE',
  issuedAtIso: string
): ImmutableEstimateSnapshot {
  return Object.freeze({
    snapshotType,
    optionId: option.id,
    departureTimeIst: option.departureTimeIst,
    predictedDurationMin: option.predictedDurationMin,
    predictedArrivalIso: option.predictedArrivalIso,
    predictedArrivalTimeIst: option.predictedArrivalTimeIst,
    issuedAtIso,
    issuedAtIst: isoToIstWithSec(issuedAtIso),
    estimateBasis: option.estimateBasis,
    dataSource: option.dataSource,
    environment: option.environment,
    userSafetyBufferMin: option.userSafetyBufferMin,
  });
}

export function computeJourneyMetrics(
  selectedEstimate: ImmutableEstimateSnapshot | null,
  departureEstimate: ImmutableEstimateSnapshot,
  actualDepartureIso: string,
  actualArrivalIso: string | null
): JourneyMetrics {
  if (!actualArrivalIso) {
    return {
      isCompleted: false,
      actualDurationMin: null,
      errorVsDepartureMin: null,
      absErrorVsDepartureMin: null,
      lateOver5MinVsDeparture: null,
      errorVsSelectedMin: null,
      absErrorVsSelectedMin: null,
      lateOver5MinVsSelected: null,
    };
  }

  const depMs = new Date(actualDepartureIso).getTime();
  const arrMs = new Date(actualArrivalIso).getTime();
  const actualDurationMin = Math.max(1, Math.round((arrMs - depMs) / 60000));

  // Compare actual arrival time against communicated ETA in minutes (IST clock or epoch)
  const actualArrMinIst = hhmmToMinutes(isoToIstHhmm(actualArrivalIso));
  const depPredArrMinIst = hhmmToMinutes(departureEstimate.predictedArrivalTimeIst);
  const errorVsDepartureMin = actualArrMinIst - depPredArrMinIst;
  const absErrorVsDepartureMin = Math.abs(errorVsDepartureMin);
  // Key requirement: Arriving more than five minutes later than the communicated ETA counts as a trust failure.
  const lateOver5MinVsDeparture = errorVsDepartureMin > 5;

  let errorVsSelectedMin: number | null = null;
  let absErrorVsSelectedMin: number | null = null;
  let lateOver5MinVsSelected: boolean | null = null;

  if (selectedEstimate) {
    const selPredArrMinIst = hhmmToMinutes(selectedEstimate.predictedArrivalTimeIst);
    errorVsSelectedMin = actualArrMinIst - selPredArrMinIst;
    absErrorVsSelectedMin = Math.abs(errorVsSelectedMin);
    lateOver5MinVsSelected = errorVsSelectedMin > 5;
  }

  return {
    isCompleted: true,
    actualDurationMin,
    errorVsDepartureMin,
    absErrorVsDepartureMin,
    lateOver5MinVsDeparture,
    errorVsSelectedMin,
    absErrorVsSelectedMin,
    lateOver5MinVsSelected,
  };
}

export function correctJourneyActualTimes(
  journey: JourneyRecord,
  newActualDepartureIso: string,
  newActualArrivalIso: string,
  nowIso: string
): JourneyRecord {
  // Original estimates (selectedEstimate and departureEstimate) are strictly preserved!
  const updatedMetrics = computeJourneyMetrics(
    journey.selectedEstimate,
    journey.departureEstimate,
    newActualDepartureIso,
    newActualArrivalIso
  );

  return {
    ...journey,
    // Keep original snapshots untouched
    selectedEstimate: journey.selectedEstimate ? { ...journey.selectedEstimate } : null,
    departureEstimate: { ...journey.departureEstimate },
    actualDepartureIso: newActualDepartureIso,
    actualDepartureTimeIst: isoToIstHhmm(newActualDepartureIso),
    actualArrivalIso: newActualArrivalIso,
    actualArrivalTimeIst: isoToIstHhmm(newActualArrivalIso),
    correctedAtIso: nowIso,
    correctionHistoryCount: (journey.correctionHistoryCount || 0) + 1,
    metrics: updatedMetrics,
  };
}

export function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1));
  }
  return Number(sorted[mid].toFixed(1));
}

export function computePilotMetricsReport(
  allJourneys: JourneyRecord[],
  environment: DataEnvironment,
  nowIso: string = new Date().toISOString()
): PilotMetricsReport {
  // Strictly separate LIVE pilot records from DEMO synthetic records
  const envJourneys = allJourneys.filter((j) => j.environment === environment);

  const modes: TransportMode[] = ['BIKE', 'CAR', 'BMTC'];
  const byMode = {} as Record<TransportMode, ModePilotSummary>;

  for (const mode of modes) {
    const modeJourneys = envJourneys.filter((j) => j.transportMode === mode);
    const completed = modeJourneys.filter((j) => j.metrics.isCompleted);
    const missing = modeJourneys.filter((j) => !j.metrics.isCompleted);

    const absErrorsDep = completed
      .map((j) => j.metrics.absErrorVsDepartureMin)
      .filter((v): v is number => v !== null);
    const absErrorsSel = completed
      .map((j) => j.metrics.absErrorVsSelectedMin)
      .filter((v): v is number => v !== null);

    const lateDepCount = completed.filter(
      (j) => j.metrics.lateOver5MinVsDeparture === true
    ).length;
    const lateSelList = completed.filter(
      (j) => j.metrics.lateOver5MinVsSelected !== null
    );
    const lateSelCount = lateSelList.filter(
      (j) => j.metrics.lateOver5MinVsSelected === true
    ).length;

    const usefulAnswered = completed.filter(
      (j) => j.usefulRating !== null && j.usefulRating !== undefined
    );
    const usefulYes = usefulAnswered.filter((j) => j.usefulRating === 'YES').length;

    byMode[mode] = {
      mode,
      completedCount: completed.length,
      missingMeasurementsCount: missing.length,
      changedPlanCount: modeJourneys.filter((j) => j.changedPlanOrRoute).length,
      sampleStatus: completed.length > 0 ? 'MEASURED' : 'UNMEASURED',
      medianAbsErrorVsSelectedMin: computeMedian(absErrorsSel),
      medianAbsErrorVsDepartureMin: computeMedian(absErrorsDep),
      lateOver5MinVsSelectedPct:
        lateSelList.length > 0
          ? Number(((lateSelCount / lateSelList.length) * 100).toFixed(1))
          : null,
      lateOver5MinVsDeparturePct:
        completed.length > 0
          ? Number(((lateDepCount / completed.length) * 100).toFixed(1))
          : null,
      lateOver5MinVsDepartureCount: lateDepCount,
      usefulYesCount: usefulYes,
      usefulTotalCount: usefulAnswered.length,
    };
  }

  const allCompleted = envJourneys.filter((j) => j.metrics.isCompleted);
  const allMissing = envJourneys.filter((j) => !j.metrics.isCompleted);

  const allAbsDep = allCompleted
    .map((j) => j.metrics.absErrorVsDepartureMin)
    .filter((v): v is number => v !== null);
  const allAbsSel = allCompleted
    .map((j) => j.metrics.absErrorVsSelectedMin)
    .filter((v): v is number => v !== null);

  const allLateDep = allCompleted.filter(
    (j) => j.metrics.lateOver5MinVsDeparture === true
  ).length;
  const allSelValid = allCompleted.filter(
    (j) => j.metrics.lateOver5MinVsSelected !== null
  );
  const allLateSel = allSelValid.filter(
    (j) => j.metrics.lateOver5MinVsSelected === true
  ).length;

  let meetsFiveMinuteTargetStatus =
    'Unmeasured — Awaiting real employee pilot journey completions to establish 5-minute ETA reliability.';
  if (environment === 'DEMO') {
    meetsFiveMinuteTargetStatus =
      'Labeled Demo Dataset — Synthetic journeys are for workflow verification only and do not establish real-world pilot ETA reliability.';
  } else if (allCompleted.length > 0 && allCompleted.length < 10) {
    const rate = Number(((allLateDep / allCompleted.length) * 100).toFixed(1));
    meetsFiveMinuteTargetStatus = `Preliminary Live Sample (n=${allCompleted.length} journeys): ${rate}% arrived >5 min late vs departure ETA. More completed trips required before claiming pilot target readiness.`;
  } else if (allCompleted.length >= 10) {
    const rate = Number(((allLateDep / allCompleted.length) * 100).toFixed(1));
    meetsFiveMinuteTargetStatus = `Measured Live Sample (n=${allCompleted.length} journeys): ${rate}% arrived >5 min late vs departure ETA (Median Abs Error: ${computeMedian(allAbsDep)} min).`;
  }

  return {
    environment,
    generatedAtIst: isoToIstWithSec(nowIso),
    totalCompletedJourneys: allCompleted.length,
    totalMissingMeasurements: allMissing.length,
    overallSampleStatus: allCompleted.length > 0 ? 'MEASURED' : 'UNMEASURED',
    overallMedianAbsErrorVsSelectedMin: computeMedian(allAbsSel),
    overallMedianAbsErrorVsDepartureMin: computeMedian(allAbsDep),
    overallLateOver5MinVsSelectedPct:
      allSelValid.length > 0
        ? Number(((allLateSel / allSelValid.length) * 100).toFixed(1))
        : null,
    overallLateOver5MinVsDeparturePct:
      allCompleted.length > 0
        ? Number(((allLateDep / allCompleted.length) * 100).toFixed(1))
        : null,
    meetsFiveMinuteTargetStatus,
    byMode,
  };
}

/**
 * Explicitly labeled Synthetic Demo Routing Engine for ORR Bengaluru corridors.
 * ONLY invoked when user explicitly selects "DEMO" mode or triggers Demo Sandbox.
 * Never silently used as a fallback for Live mode!
 */
export function computeDemoSlotPrediction(params: {
  origin: LocationPoint;
  destination: LocationPoint;
  mode: TransportMode;
  departureTimeIst: string;
  departureIso: string;
  isNowSlot: boolean;
  simulateTrafficSpikeMin?: number;
}): {
  supported: boolean;
  unsupportedReason?: string;
  prediction?: SlotPredictionInput;
} {
  const {
    origin,
    destination,
    mode,
    departureTimeIst,
    departureIso,
    isNowSlot,
    simulateTrafficSpikeMin = 0,
  } = params;

  // Compute Haversine straight-line distance and apply ORR road network factor (1.38x)
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(destination.lat - origin.lat);
  const dLng = toRad(destination.lng - origin.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(origin.lat)) *
      Math.cos(toRad(destination.lat)) *
      Math.sin(dLng / 2) ** 2;
  const straightKm = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = Number(Math.max(2.5, straightKm * 1.38).toFixed(1));

  // If distance > 35km for BMTC direct corridor, check if supported
  if (mode === 'BMTC' && distanceKm > 38) {
    return {
      supported: false,
      unsupportedReason:
        'No scheduled BMTC direct or single-transfer bus corridor covers this origin–destination pair within the commute window.',
    };
  }

  const depMin = hhmmToMinutes(departureTimeIst);
  // ORR Peak Traffic Curve (Morning peak around 08:45-09:30, Evening peak around 17:45-19:00)
  const morningPeakFactor = Math.exp(-Math.pow((depMin - 535) / 55, 2)); // Peak at 08:55 (535m)
  const eveningPeakFactor = Math.exp(-Math.pow((depMin - 1095) / 65, 2)); // Peak at 18:15 (1095m)
  const congestionIntensity = Math.max(morningPeakFactor, eveningPeakFactor);

  // Determine ORR corridor label based on origin
  let corridorSummary = 'via Outer Ring Rd (Silk Board – Bellandur – Kadubeesanahalli)';
  if (origin.lat > 12.99) {
    corridorSummary = 'via Outer Ring Rd North (KR Puram – Mahadevapura – Marathahalli)';
  } else if (origin.lng > 77.71) {
    corridorSummary = 'via Varthur Rd / HAL Old Airport Rd – Marathahalli Bridge';
  } else if (origin.lat > 12.955 && origin.lng < 77.67) {
    corridorSummary = 'via 100 Feet Rd Indiranagar – Domlur Flyover – Marathahalli';
  }

  if (mode === 'BIKE') {
    // Motorized Two-Wheeler (distinct from car and bicycle)
    const staticDurationMin = Math.max(10, Math.round(distanceKm * 2.35));
    const trafficPenalty = Math.round(distanceKm * 0.95 * congestionIntensity) + simulateTrafficSpikeMin;
    const predictedDurationMin = staticDurationMin + trafficPenalty;
    return {
      supported: true,
      prediction: {
        departureTimeIst,
        departureIso,
        isNowSlot,
        predictedDurationMin,
        staticDurationMin,
        durationRangeMin: [
          Math.max(staticDurationMin, predictedDurationMin - 3),
          predictedDurationMin + 5,
        ],
        estimateBasis: isNowSlot ? 'CURRENT_TRAFFIC' : 'FUTURE_FORECAST',
        dataSource: 'ORR Pulse Synthetic Demo Engine (Labeled Demo)',
        environment: 'DEMO',
        distanceKm,
        corridorSummary: `${corridorSummary} [Two-Wheeler Mode]`,
      },
    };
  }

  if (mode === 'CAR') {
    const staticDurationMin = Math.max(14, Math.round(distanceKm * 2.8));
    const trafficPenalty = Math.round(distanceKm * 2.15 * congestionIntensity) + simulateTrafficSpikeMin;
    const predictedDurationMin = staticDurationMin + trafficPenalty;
    return {
      supported: true,
      prediction: {
        departureTimeIst,
        departureIso,
        isNowSlot,
        predictedDurationMin,
        staticDurationMin,
        durationRangeMin: [
          Math.max(staticDurationMin, predictedDurationMin - 4),
          predictedDurationMin + 8,
        ],
        estimateBasis: isNowSlot ? 'CURRENT_TRAFFIC' : 'FUTURE_FORECAST',
        dataSource: 'ORR Pulse Synthetic Demo Engine (Labeled Demo)',
        environment: 'DEMO',
        distanceKm,
        corridorSummary,
      },
    };
  }

  // BMTC Bus (Timetable-based with walking, waiting, transfers, and in-vehicle time)
  const walkingMin = 8;
  const waitingMin = depMin % 15 === 0 ? 6 : 9;
  const inVehicleMin = Math.max(16, Math.round(distanceKm * 3.4) + Math.round(congestionIntensity * 10) + simulateTrafficSpikeMin);
  const predictedDurationMin = walkingMin + waitingMin + inVehicleMin;
  const busLines =
    origin.lat > 12.99
      ? ['500-CA', 'V-500D']
      : origin.lng > 77.71
      ? ['500-F', '335-E']
      : ['500-D', 'V-500K'];

  const steps: TransitStepDetail[] = [
    {
      stepType: 'WALK',
      durationMin: 5,
      instruction: `Walk 400m from ${origin.label.split(',')[0]} to nearest BMTC ORR Stop`,
    },
    {
      stepType: 'WAIT',
      durationMin: waitingMin,
      instruction: `Scheduled timetable wait for BMTC ${busLines.join(' / ')} Vajra AC / Ordinary service`,
      busRouteNumber: busLines[0],
      scheduledDepartureTime: minutesToHhmm(depMin + 5 + waitingMin),
    },
    {
      stepType: 'BUS',
      durationMin: inVehicleMin,
      instruction: `Board BMTC ${busLines[0]} along Outer Ring Road Bus Priority Lane to Kadubeesanahalli / Prestige Tech Park`,
      busRouteNumber: busLines[0],
      departureStop: `${origin.label.split(',')[0]} Bus Stop`,
      arrivalStop: 'Prestige Tech Park / Kadubeesanahalli Footbridge',
      numStops: Math.max(4, Math.round(distanceKm * 1.2)),
    },
    {
      stepType: 'WALK',
      durationMin: 3,
      instruction: 'Walk 250m via skywalk into Prestige Tech Park campus gate',
    },
  ];

  return {
    supported: true,
    prediction: {
      departureTimeIst,
      departureIso,
      isNowSlot,
      predictedDurationMin,
      staticDurationMin: predictedDurationMin,
      estimateBasis: 'TIMETABLE',
      dataSource: 'BMTC Scheduled GTFS Timetable (Labeled Demo)',
      environment: 'DEMO',
      distanceKm,
      corridorSummary: `BMTC Routes ${busLines.join(', ')} (${corridorSummary})`,
      transitDetails: {
        isLiveFeed: false,
        walkingMin,
        waitingMin,
        inVehicleMin,
        transfersCount: 0,
        busLines,
        steps,
        limitationNote: BMTC_TIMETABLE_LIMITATION_NOTE,
      },
    },
  };
}
