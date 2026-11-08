/**
 * Pure reducer for the self-contained local DEMO mode.
 *
 * Every action carries an explicit `nowIso` so tests are fully deterministic
 * (no wall-clock reads inside the reducer). Time-of-day logic uses IST via the
 * ported demoEngine helpers.
 *
 * Key invariants (covered by tests):
 * - SKIPPED/STOPPED/EXPIRED/LEFT sessions are never auto-restarted by refresh.
 * - Estimate snapshots (SELECTED_OPTION / AT_DEPARTURE) are frozen and never
 *   mutated by later corrections; corrections only touch actual times + metrics.
 * - Skip-today persists via dayOverrides and survives rehydration; resume
 *   removes the override but does NOT silently restart a session.
 * - Rollover at the IST date boundary drops stale sessions, keeps journey
 *   history and profile, and never applies another day's overrides today.
 */
import type {
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DayOverride,
  DepartureOption,
  ImmutableEstimateSnapshot,
  JourneyRecord,
  MonitoringSession,
  UserProfile,
} from '../types/shared';
import {
  computeDemoOptionsForDirection,
  computeJourneyMetrics,
  correctJourneyActualTimes,
  createImmutableSnapshot,
  evaluateMonitoringUpdate,
  getNowIstParts,
  hhmmToMinutes,
  istDateAndHhmmToIso,
  resolveEffectiveSchedule,
} from '../services/demoEngine';
import { DEMO_USER_ID, DemoState, makeFreshDemoState } from '../services/demoFixtures';

export type { DemoState };

export type DemoAction =
  | { type: 'ROLLOVER_IF_NEW_DAY'; nowIso: string }
  | {
      type: 'START_OR_REFRESH_SESSION';
      nowIso: string;
      direction: CommuteDirection;
      startMode: 'IMMEDIATE' | 'SCHEDULED_LEAD';
      watchMode: 'ALL_OPTIONS' | 'SELECTED_OPTION';
      selectedOptionId?: string | null;
    }
  | { type: 'REFRESH_ACTIVE_SESSIONS'; nowIso: string }
  | { type: 'SELECT_OPTION'; nowIso: string; sessionId: string; optionId: string }
  | {
      type: 'MONITORING_ACTION';
      nowIso: string;
      sessionId: string;
      action: 'IVE_LEFT' | 'SNOOZE_10M' | 'SKIP_TODAY' | 'STOP_MONITORING';
    }
  | { type: 'SET_DAY_OVERRIDE'; override: DayOverride }
  | { type: 'CLEAR_DAY_OVERRIDE'; direction: CommuteDirection }
  | { type: 'UPDATE_PROFILE'; patch: UserProfilePatch }
  | { type: 'RECORD_ARRIVAL'; nowIso: string; journeyId: string; arrivalHhmm: string }
  | {
      type: 'CORRECT_JOURNEY';
      nowIso: string;
      journeyId: string;
      actualDepartureHhmm?: string;
      actualArrivalHhmm?: string;
      changedPlanOrRoute?: boolean;
      usefulRating?: 'YES' | 'SOMEWHAT' | 'NO' | null;
      feedbackNote?: string;
    }
  | { type: 'ACK_ALERT'; alertId: string }
  | { type: 'ACK_ALL_ALERTS' }
  | { type: 'ONBOARDING_ACKNOWLEDGED' }
  | { type: 'RESET_DEMO'; nowIso: string };

export type UserProfilePatch = Partial<
  Pick<
    UserProfile,
    | 'homeLocation'
    | 'workLocation'
    | 'schedules'
    | 'telemetryConsent'
    | 'onboardingComplete'
  >
>;

function istDateOf(nowIso: string): string {
  return getNowIstParts(new Date(nowIso)).dateIst;
}

function makeAlertBase(session: MonitoringSession, nowIso: string) {
  return {
    userId: session.userId,
    sessionId: session.id,
    createdAtIso: nowIso,
    createdAtIst: `${getNowIstParts(new Date(nowIso)).timeWithSecIst}`,
  };
}

function computeOptionsFor(state: DemoState, direction: CommuteDirection, nowIso: string) {
  return computeDemoOptionsForDirection({
    profile: {
      homeLocation: state.profile.homeLocation,
      workLocation: state.profile.workLocation,
      schedules: state.profile.schedules,
      dayOverrides: state.profile.dayOverrides,
    },
    direction,
    nowIso,
  });
}

function startOrRefreshSession(
  state: DemoState,
  action: Extract<DemoAction, { type: 'START_OR_REFRESH_SESSION' }>
): DemoState {
  const { nowIso, direction, startMode, watchMode, selectedOptionId } = action;
  const dateIst = istDateOf(nowIso);
  const result = computeOptionsFor(state, direction, nowIso);
  const effectiveSchedule = resolveEffectiveSchedule(
    state.profile.schedules[direction],
    state.profile.dayOverrides,
    dateIst
  );

  if (!state.profile.homeLocation) {
    // Mirror the server: no home location -> no monitoring session at all.
    return state;
  }

  const expiresAtIso = istDateAndHhmmToIso(dateIst, effectiveSchedule.windowEnd);

  const existingIdx = state.sessions.findIndex(
    (s) => s.userId === DEMO_USER_ID && s.dateIst === dateIst && s.direction === direction
  );
  const existing = existingIdx >= 0 ? state.sessions[existingIdx] : null;

  let session: MonitoringSession;
  if (!existing) {
    session = {
      id: `mon_demo_${dateIst}_${direction}`,
      userId: DEMO_USER_ID,
      dateIst,
      direction,
      transportMode: effectiveSchedule.mode,
      status: startMode === 'SCHEDULED_LEAD' ? 'SCHEDULED' : 'ACTIVE',
      watchMode,
      selectedOptionId: selectedOptionId ?? null,
      selectedEstimateSnapshot: null,
      departureEstimateSnapshot: null,
      lastNotifiedArrivalIso: null,
      lastNotifiedArrivalTimeIst: null,
      snoozedUntilIso: null,
      startedAtIso: nowIso,
      lastRefreshedAtIso: nowIso,
      nextRefreshDueIso: new Date(new Date(nowIso).getTime() + 5 * 60 * 1000).toISOString(),
      expiresAtIso,
      refreshCount: 0,
      suppressedDuplicatesCount: 0,
      latestOptions: result.options,
      unsupportedModeReason: result.unsupportedReason ?? null,
      dataEnvironment: 'DEMO' as DataEnvironment,
    };
  } else {
    session = {
      ...existing,
      transportMode: effectiveSchedule.mode,
      dataEnvironment: 'DEMO',
      expiresAtIso,
      unsupportedModeReason: result.unsupportedReason ?? null,
      // Explicit user action may restart a terminal session (mirrors server).
      ...(existing.status === 'STOPPED' ||
      existing.status === 'SKIPPED' ||
      existing.status === 'EXPIRED' ||
      existing.status === 'LEFT'
        ? {
            status: (startMode === 'SCHEDULED_LEAD' ? 'SCHEDULED' : 'ACTIVE') as MonitoringSession['status'],
            lastNotifiedArrivalIso: null,
            lastNotifiedArrivalTimeIst: null,
          }
        : {}),
      selectedOptionId: selectedOptionId ?? existing.selectedOptionId,
      watchMode: watchMode ?? existing.watchMode,
    };
  }

  if (session.selectedOptionId) {
    const chosen = result.options.find((o) => o.id === session.selectedOptionId);
    if (
      chosen &&
      (!session.selectedEstimateSnapshot ||
        session.selectedEstimateSnapshot.optionId !== chosen.id)
    ) {
      session = {
        ...session,
        selectedEstimateSnapshot: createImmutableSnapshot(chosen, 'SELECTED_OPTION', nowIso),
      };
    }
  }

  const outcome = evaluateMonitoringUpdate({
    session,
    schedule: effectiveSchedule,
    newOptions: result.options,
    nowIso,
  });

  const sessions = [...state.sessions];
  if (existingIdx >= 0) {
    sessions[existingIdx] = outcome.updatedSession;
  } else {
    sessions.push(outcome.updatedSession);
  }

  return {
    ...state,
    sessions,
    alerts: [...outcome.generatedAlerts, ...state.alerts].slice(0, 60),
  };
}

function refreshActiveSessions(
  state: DemoState,
  nowIso: string
): DemoState {
  const dateIst = istDateOf(nowIso);
  let alerts: CommuteAlert[] = [];
  const sessions: MonitoringSession[] = [];

  for (const session of state.sessions) {
    if (session.dateIst !== dateIst) continue; // stale from a previous day

    // Terminal states are never auto-restarted or refreshed.
    if (
      session.status === 'LEFT' ||
      session.status === 'SKIPPED' ||
      session.status === 'STOPPED' ||
      session.status === 'EXPIRED'
    ) {
      sessions.push(session);
      continue;
    }

    const schedule = resolveEffectiveSchedule(
      state.profile.schedules[session.direction],
      state.profile.dayOverrides,
      dateIst
    );

    let newOptions: DepartureOption[] = session.latestOptions;
    if (state.profile.homeLocation) {
      const result = computeOptionsFor(state, session.direction, nowIso);
      if (!result.unsupportedReason) {
        newOptions = result.options;
      }
    }

    const outcome = evaluateMonitoringUpdate({
      session,
      schedule,
      newOptions,
      nowIso,
    });
    sessions.push(outcome.updatedSession);
    alerts = alerts.concat(outcome.generatedAlerts);
  }

  return {
    ...state,
    sessions,
    alerts: [...alerts, ...state.alerts].slice(0, 60),
  };
}

function selectOption(
  state: DemoState,
  action: Extract<DemoAction, { type: 'SELECT_OPTION' }>
): DemoState {
  const { nowIso, sessionId, optionId } = action;
  const idx = state.sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return state;
  const session = state.sessions[idx];
  const chosen = session.latestOptions.find((o) => o.id === optionId);
  if (!chosen) return state;

  const updated: MonitoringSession = {
    ...session,
    watchMode: 'SELECTED_OPTION',
    selectedOptionId: optionId,
    selectedEstimateSnapshot: createImmutableSnapshot(chosen, 'SELECTED_OPTION', nowIso),
    lastNotifiedArrivalIso: chosen.predictedArrivalIso,
    lastNotifiedArrivalTimeIst: chosen.predictedArrivalTimeIst,
  };

  const sessions = [...state.sessions];
  sessions[idx] = updated;
  return { ...state, sessions };
}

function monitoringAction(
  state: DemoState,
  action: Extract<DemoAction, { type: 'MONITORING_ACTION' }>
): DemoState {
  const { nowIso, sessionId, action: act } = action;
  const idx = state.sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return state;
  const session = state.sessions[idx];
  const sessions = [...state.sessions];

  if (act === 'SNOOZE_10M') {
    const snoozedUntilIso = new Date(new Date(nowIso).getTime() + 10 * 60 * 1000).toISOString();
    const snoozeAlert: CommuteAlert = {
      ...makeAlertBase(session, nowIso),
      id: `alert_snz_${session.id}_${new Date(nowIso).getTime()}`,
      type: 'SYSTEM_NOTICE',
      severity: 'INFO',
      title: 'Alerts Snoozed for 10 Minutes',
      message: `Departure reminders paused until ${getNowIstParts(new Date(snoozedUntilIso)).timeIst} IST while route monitoring continues.`,
      deliveredChannels: ['IN_APP'],
      acknowledged: true,
    };
    sessions[idx] = {
      ...session,
      status: 'SNOOZED',
      snoozedUntilIso,
    };
    return { ...state, sessions, alerts: [snoozeAlert, ...state.alerts].slice(0, 60) };
  }

  if (act === 'SKIP_TODAY') {
    sessions[idx] = { ...session, status: 'SKIPPED', nextRefreshDueIso: null };
    const dayOverrides = state.profile.dayOverrides.filter(
      (o) => !(o.dateIst === session.dateIst && o.direction === session.direction)
    );
    dayOverrides.push({
      dateIst: session.dateIst,
      direction: session.direction,
      skipped: true,
    });
    return {
      ...state,
      sessions,
      profile: { ...state.profile, dayOverrides },
    };
  }

  if (act === 'STOP_MONITORING') {
    sessions[idx] = { ...session, status: 'STOPPED', nextRefreshDueIso: null };
    return { ...state, sessions };
  }

  // IVE_LEFT
  const activeOption =
    session.latestOptions.find((o) => o.id === session.selectedOptionId) ||
    session.latestOptions.find((o) => o.roles.includes('LEAVE_NOW')) ||
    session.latestOptions[0];

  let updated: MonitoringSession = {
    ...session,
    status: 'LEFT',
    nextRefreshDueIso: null,
  };

  let journeys = state.journeys;
  let createdJourney: JourneyRecord | null = null;

  if (activeOption && state.profile.telemetryConsent) {
    const depSnapshot: ImmutableEstimateSnapshot = createImmutableSnapshot(
      activeOption,
      'AT_DEPARTURE',
      nowIso
    );
    updated = { ...updated, departureEstimateSnapshot: depSnapshot };

    const originLabel =
      session.direction === 'HOME_TO_WORK'
        ? state.profile.homeLocation?.label || 'Home'
        : state.profile.workLocation.label;
    const destinationLabel =
      session.direction === 'HOME_TO_WORK'
        ? state.profile.workLocation.label
        : state.profile.homeLocation?.label || 'Home';

    createdJourney = {
      id: `jrn_demo_${new Date(nowIso).getTime()}`,
      userId: DEMO_USER_ID,
      dateIst: session.dateIst,
      direction: session.direction,
      transportMode: session.transportMode,
      environment: 'DEMO',
      originLabel,
      destinationLabel,
      selectedEstimate: session.selectedEstimateSnapshot || depSnapshot,
      departureEstimate: depSnapshot,
      actualDepartureIso: nowIso,
      actualDepartureTimeIst: getNowIstParts(new Date(nowIso)).timeIst,
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
    journeys = [createdJourney, ...state.journeys];
  }

  sessions[idx] = updated;
  return { ...state, sessions, journeys };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'ROLLOVER_IF_NEW_DAY': {
      const todayIst = istDateOf(action.nowIso);
      if (state.anchoredDateIst === todayIst) return state;
      return {
        ...state,
        anchoredDateIst: todayIst,
        // Drop yesterday's monitoring sessions; journey history and alerts stay.
        sessions: state.sessions.filter((s) => s.dateIst === todayIst),
      };
    }
    case 'START_OR_REFRESH_SESSION':
      return startOrRefreshSession(state, action);
    case 'REFRESH_ACTIVE_SESSIONS':
      return refreshActiveSessions(state, action.nowIso);
    case 'SELECT_OPTION':
      return selectOption(state, action);
    case 'MONITORING_ACTION':
      return monitoringAction(state, action);
    case 'SET_DAY_OVERRIDE': {
      const { override } = action;
      const dayOverrides = state.profile.dayOverrides.filter(
        (o) => !(o.dateIst === override.dateIst && o.direction === override.direction)
      );
      dayOverrides.push(override);
      const sessions = state.sessions.map((s) =>
        s.dateIst === override.dateIst && s.direction === override.direction && override.skipped
          ? { ...s, status: 'SKIPPED' as const, nextRefreshDueIso: null }
          : s
      );
      return { ...state, profile: { ...state.profile, dayOverrides }, sessions };
    }
    case 'CLEAR_DAY_OVERRIDE': {
      const todayIst = state.anchoredDateIst;
      const dayOverrides = state.profile.dayOverrides.filter(
        (o) => !(o.dateIst === todayIst && o.direction === action.direction)
      );
      // Resume does NOT restart the session; the user explicitly presses
      // "Start monitoring" again if they want fresh options.
      return { ...state, profile: { ...state.profile, dayOverrides } };
    }
    case 'UPDATE_PROFILE':
      return { ...state, profile: { ...state.profile, ...action.patch } };
    case 'RECORD_ARRIVAL':
    case 'CORRECT_JOURNEY': {
      const jIdx = state.journeys.findIndex((j) => j.id === action.journeyId);
      if (jIdx === -1) return state;
      const journey = state.journeys[jIdx];
      const departureHhmm =
        'actualDepartureHhmm' in action && action.actualDepartureHhmm
          ? action.actualDepartureHhmm
          : journey.actualDepartureTimeIst;
      const arrivalHhmm =
        action.type === 'RECORD_ARRIVAL'
          ? action.arrivalHhmm
          : 'actualArrivalHhmm' in action && action.actualArrivalHhmm
          ? action.actualArrivalHhmm
          : journey.actualArrivalTimeIst ?? null;

      // Same-day chronology guard: reject arrival at/before departure rather
      // than clamping a negative travel time to a believable value.
      if (arrivalHhmm && hhmmToMinutes(arrivalHhmm) <= hhmmToMinutes(departureHhmm)) {
        return state;
      }

      const newDepIso = istDateAndHhmmToIso(journey.dateIst, departureHhmm);
      const newArrIso = arrivalHhmm ? istDateAndHhmmToIso(journey.dateIst, arrivalHhmm) : null;

      let updated = correctJourneyActualTimes(journey, newDepIso, newArrIso, action.nowIso);

      if (action.type === 'CORRECT_JOURNEY') {
        if (typeof action.changedPlanOrRoute === 'boolean') {
          updated = { ...updated, changedPlanOrRoute: action.changedPlanOrRoute };
        }
        if (action.usefulRating !== undefined) {
          updated = { ...updated, usefulRating: action.usefulRating };
        }
        if (action.feedbackNote !== undefined) {
          updated = { ...updated, feedbackNote: action.feedbackNote };
        }
      }

      const journeys = [...state.journeys];
      journeys[jIdx] = updated;
      return { ...state, journeys };
    }
    case 'ACK_ALERT':
      return {
        ...state,
        alerts: state.alerts.map((a) => (a.id === action.alertId ? { ...a, acknowledged: true } : a)),
      };
    case 'ACK_ALL_ALERTS':
      return { ...state, alerts: state.alerts.map((a) => ({ ...a, acknowledged: true })) };
    case 'ONBOARDING_ACKNOWLEDGED':
      return { ...state, onboardingAcknowledged: true };
    case 'RESET_DEMO':
      return makeFreshDemoState(action.nowIso);
    default:
      return state;
  }
}

export function createDemoReducer(nowIso: string): DemoState {
  return makeFreshDemoState(nowIso);
}

/** Helper for tests + persistence: rehydrate and roll to today in one step. */
export function rehydrateDemoState(persisted: unknown, nowIso: string): DemoState {
  const fallback = makeFreshDemoState(nowIso);
  if (!persisted || typeof persisted !== 'object') return fallback;
  const candidate = persisted as Partial<DemoState>;
  if (candidate.schemaVersion !== 1 || !candidate.profile || !Array.isArray(candidate.journeys)) {
    return fallback;
  }
  const rehydrated: DemoState = {
    schemaVersion: 1,
    anchoredDateIst: candidate.anchoredDateIst || fallback.anchoredDateIst,
    profile: candidate.profile,
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions : [],
    alerts: Array.isArray(candidate.alerts) ? candidate.alerts : [],
    journeys: candidate.journeys,
    onboardingAcknowledged: Boolean(candidate.onboardingAcknowledged),
  };
  return demoReducer(rehydrated, { type: 'ROLLOVER_IF_NEW_DAY', nowIso });
}
