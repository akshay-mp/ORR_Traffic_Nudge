import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoReducer, demoReducer } from '../state/demoReducer';
import type { DemoState } from '../state/demoReducer';

// Mon 09 Nov 2026, 08:30 IST (03:00 UTC) — inside the demo morning window 08:00–09:15.
const T0 = '2026-11-09T03:00:00.000Z';
const T1 = '2026-11-09T03:05:00.000Z'; // 08:35 IST
const T_LATE = '2026-11-09T03:50:00.000Z'; // 09:20 IST — past window end 09:15

function freshState(): DemoState {
  return createDemoReducer(T0);
}

function startMorning(s: DemoState, at = T0): DemoState {
  return demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: at,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
}

test('START_OR_REFRESH creates an ACTIVE session with labeled DEMO options and a departure reminder', () => {
  const s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK');
  assert.ok(session, 'session exists');
  assert.equal(session?.status, 'ACTIVE');
  assert.equal(session?.dataEnvironment, 'DEMO');
  assert.equal(session?.dateIst, '2026-11-09');
  assert.ok(session && session.latestOptions.length > 0, 'options computed');
  for (const opt of session?.latestOptions ?? []) {
    assert.equal(opt.environment, 'DEMO');
    assert.match(opt.dataSource, /Demo/i);
  }
  assert.ok(s.alerts.some((a) => a.type === 'DEPARTURE_REMINDER'));
});

test('SELECT_OPTION records a frozen SELECTED_OPTION snapshot and tracks that option', () => {
  let s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  const option = session.latestOptions[0];
  s = demoReducer(s, { type: 'SELECT_OPTION', nowIso: T1, sessionId: session.id, optionId: option.id });
  const updated = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(updated.watchMode, 'SELECTED_OPTION');
  assert.equal(updated.selectedOptionId, option.id);
  assert.ok(Object.isFrozen(updated.selectedEstimateSnapshot), 'snapshot frozen');
  assert.equal(updated.selectedEstimateSnapshot?.snapshotType, 'SELECTED_OPTION');
  assert.equal(updated.selectedEstimateSnapshot?.optionId, option.id);
});

test('SNOOZE_10M snoozes; refresh during snooze emits no reminder but keeps monitoring', () => {
  let s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'SNOOZE_10M' });
  let updated = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(updated.status, 'SNOOZED');
  assert.ok(updated.snoozedUntilIso);
  const alertsBefore = s.alerts.filter((a) => a.type === 'ARRIVAL_DETERIORATION').length;
  s = demoReducer(s, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T1 });
  updated = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(updated.status, 'SNOOZED');
  assert.equal(
    s.alerts.filter((a) => a.type === 'ARRIVAL_DETERIORATION').length,
    alertsBefore,
    'no deterioration alerts while snoozed'
  );
});

test('STOP_MONITORING and SKIP_TODAY are terminal; REFRESH_ACTIVE_SESSIONS never restarts them', () => {
  // stopped
  let s = startMorning(freshState());
  let session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'STOP_MONITORING' });
  s = demoReducer(s, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T1 });
  session = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(session.status, 'STOPPED', 'stopped stays stopped across refresh');

  // skipped
  s = startMorning(freshState());
  session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'SKIP_TODAY' });
  s = demoReducer(s, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T1 });
  session = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(session.status, 'SKIPPED', 'skipped stays skipped across refresh');
  assert.ok(
    s.profile.dayOverrides.some((o) => o.dateIst === '2026-11-09' && o.direction === 'HOME_TO_WORK' && o.skipped),
    'skip persists as day override'
  );
});

test('session expires once the window passes; EXPIRED is terminal too', () => {
  let s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T_LATE });
  const updated = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(updated.status, 'EXPIRED');
  assert.ok(s.alerts.some((a) => a.type === 'SESSION_EXPIRED'));
  const afterAgain = demoReducer(s, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T_LATE });
  assert.equal(
    afterAgain.sessions.find((x) => x.id === session.id)!.status,
    'EXPIRED',
    'expired not restarted'
  );
});

test('explicit START after a terminal state may restart (user-initiated only)', () => {
  let s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'STOP_MONITORING' });
  const remindersBefore = s.alerts.filter((a) => a.type === 'DEPARTURE_REMINDER').length;

  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T1,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const updated = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(updated.status, 'ACTIVE');
  // Mirrors the server: the notification baseline is cleared on restart, then
  // evaluateMonitoringUpdate immediately establishes a NEW baseline and emits a
  // fresh DEPARTURE_REMINDER — it must not stay null and must not stay stale.
  const remindersAfter = s.alerts.filter((a) => a.type === 'DEPARTURE_REMINDER').length;
  assert.ok(updated.lastNotifiedArrivalIso, 'new baseline established after restart');
  assert.equal(remindersAfter, remindersBefore + 1, 'fresh reminder emitted for restarted session');
  const tracked =
    updated.latestOptions.find((o) => o.id === updated.selectedOptionId) ??
    updated.latestOptions.find((o) => o.roles.includes('LATEST_FOR_DEADLINE')) ??
    updated.latestOptions.find((o) => o.roles.includes('LEAVE_NOW')) ??
    updated.latestOptions[0];
  assert.equal(updated.lastNotifiedArrivalTimeIst, tracked.predictedArrivalTimeIst);
});

test('no home location -> START does nothing (onboarding gate)', () => {
  let s = freshState();
  s = demoReducer(s, { type: 'UPDATE_PROFILE', patch: { homeLocation: null } });
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  assert.equal(s.sessions.length, 0, 'no session without home');
});

test('SET_DAY_OVERRIDE one-day mode changes only that day; weekly schedule untouched', () => {
  let s = freshState();
  s = demoReducer(s, {
    type: 'SET_DAY_OVERRIDE',
    override: { dateIst: '2026-11-09', direction: 'HOME_TO_WORK', skipped: false, overrideMode: 'BMTC' },
  });
  assert.equal(s.profile.schedules.HOME_TO_WORK.mode, 'CAR', 'weekly plan unchanged');
  const effective = s.profile.dayOverrides.find(
    (o) => o.dateIst === '2026-11-09' && o.direction === 'HOME_TO_WORK'
  );
  assert.equal(effective?.overrideMode, 'BMTC');
  // Starting monitoring now uses BMTC timetable predictions for today only.
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  assert.equal(session.transportMode, 'BMTC');
  const usesTimetable = session.latestOptions.every((o) => o.estimateBasis === 'TIMETABLE');
  assert.ok(usesTimetable, 'BMTC options are timetable-based');
});

test('RESET_DEMO restores fresh fixtures anchored to the reset time', () => {
  let s = startMorning(freshState());
  s = demoReducer(s, { type: 'RESET_DEMO', nowIso: T1 });
  assert.equal(s.sessions.length, 0);
  assert.ok(s.journeys.length > 0, 'fixture journeys restored');
  assert.equal(s.profile.homeLocation !== null, true);
});

test('invalid chronology (arrival at/before departure) is rejected, not clamped', () => {
  let s = startMorning(freshState());
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'IVE_LEFT' });
  const journey = s.journeys.find((j) => j.direction === 'HOME_TO_WORK' && j.dateIst === '2026-11-09')!;
  const dep = journey.actualDepartureTimeIst; // 08:32 IST

  for (const bad of ['07:30', dep]) {
    const after = demoReducer(s, {
      type: 'RECORD_ARRIVAL',
      nowIso: '2026-11-09T03:40:00.000Z',
      journeyId: journey.id,
      arrivalHhmm: bad,
    });
    const still = after.journeys.find((j) => j.id === journey.id)!;
    assert.equal(still.actualArrivalIso, null, `arrival ${bad} rejected`);
    assert.equal(still.metrics.isCompleted, false, 'no fake completed metrics');
    assert.equal(still.correctionHistoryCount, journey.correctionHistoryCount, 'no correction recorded');
  }
});
