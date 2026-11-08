import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoReducer, demoReducer } from '../state/demoReducer';
import type { DemoState } from '../state/demoReducer';

const T0 = '2026-11-09T03:00:00.000Z'; // 08:30 IST Mon
const T1 = '2026-11-09T03:02:00.000Z'; // 08:32 IST

function leftOnAJourney(): { state: DemoState; sessionId: string; journeyId: string } {
  let s = createDemoReducer(T0);
  // Explicit opt-in for trip recording (fixture default is consent OFF).
  s = demoReducer(s, { type: 'UPDATE_PROFILE', patch: { telemetryConsent: true } });
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  const option = session.latestOptions.find((o) => o.roles.includes('LEAVE_NOW')) ?? session.latestOptions[0];
  s = demoReducer(s, { type: 'SELECT_OPTION', nowIso: T0, sessionId: session.id, optionId: option.id });
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'IVE_LEFT' });
  const updated = s.sessions.find((x) => x.id === session.id)!;
  const journey = s.journeys.find((j) => j.direction === 'HOME_TO_WORK' && j.dateIst === '2026-11-09')!;
  return { state: s, sessionId: updated.id, journeyId: journey.id };
}

test('demo trip recording is opt-in: I’ve left without consent creates no journey', () => {
  let s = createDemoReducer(T0);
  assert.equal(s.profile.telemetryConsent, false, 'fixtures default to consent OFF');
  const journeysBefore = s.journeys.length;
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  s = demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'IVE_LEFT' });
  const after = s.sessions.find((x) => x.id === session.id)!;
  assert.equal(after.status, 'LEFT');
  assert.equal(after.departureEstimateSnapshot, null, 'no snapshot captured without consent');
  assert.equal(s.journeys.length, journeysBefore, 'no journey created without consent');
});

test('I’ve left creates an open journey carrying frozen SELECTED and AT_DEPARTURE snapshots', () => {
  const { state } = leftOnAJourney();
  const journey = state.journeys.find((j) => j.id !== undefined && j.dateIst === '2026-11-09' && j.direction === 'HOME_TO_WORK')!;
  assert.equal(journey.metrics.isCompleted, false);
  assert.ok(Object.isFrozen(journey.selectedEstimate), 'selected snapshot frozen');
  assert.ok(Object.isFrozen(journey.departureEstimate), 'departure snapshot frozen');
  assert.equal(journey.selectedEstimate!.snapshotType, 'SELECTED_OPTION');
  assert.equal(journey.departureEstimate.snapshotType, 'AT_DEPARTURE');
  assert.equal(journey.environment, 'DEMO');
});

test('recording an arrival completes metrics without touching either snapshot', () => {
  const { state, journeyId } = leftOnAJourney();
  const before = state.journeys.find((j) => j.id === journeyId)!;
  const selectedFrozen = JSON.stringify(before.selectedEstimate);
  const depFrozen = JSON.stringify(before.departureEstimate);

  const after = demoReducer(state, {
    type: 'RECORD_ARRIVAL',
    nowIso: '2026-11-09T03:40:00.000Z',
    journeyId,
    arrivalHhmm: '09:10',
  });
  const journey = after.journeys.find((j) => j.id === journeyId)!;
  assert.equal(journey.metrics.isCompleted, true);
  assert.ok(journey.metrics.actualDurationMin! > 0);
  assert.equal(JSON.stringify(journey.selectedEstimate), selectedFrozen, 'selected snapshot unchanged');
  assert.equal(JSON.stringify(journey.departureEstimate), depFrozen, 'departure snapshot unchanged');
  assert.equal(journey.actualArrivalTimeIst, '09:10');
});

test('manual corrections recompute metrics, bump correction count, and keep originals immutable', () => {
  const { state, journeyId } = leftOnAJourney();
  const corrected = demoReducer(state, {
    type: 'RECORD_ARRIVAL',
    nowIso: '2026-11-09T03:40:00.000Z',
    journeyId,
    arrivalHhmm: '09:10',
  });
  const original = corrected.journeys.find((j) => j.id === journeyId)!;
  const depFrozen = JSON.stringify(original.departureEstimate);
  const selFrozen = JSON.stringify(original.selectedEstimate);
  const originalError = original.metrics.errorVsDepartureMin;

  const reCorrected = demoReducer(corrected, {
    type: 'CORRECT_JOURNEY',
    nowIso: '2026-11-09T06:00:00.000Z',
    journeyId,
    actualDepartureHhmm: '08:34',
    actualArrivalHhmm: '09:26',
    changedPlanOrRoute: true,
    usefulRating: 'SOMEWHAT',
    feedbackNote: 'Bottleneck at Iblur',
  });
  const journey = reCorrected.journeys.find((j) => j.id === journeyId)!;
  assert.equal(journey.correctionHistoryCount, original.correctionHistoryCount + 1);
  assert.equal(journey.actualDepartureTimeIst, '08:34');
  assert.equal(journey.actualArrivalTimeIst, '09:26');
  assert.equal(journey.changedPlanOrRoute, true);
  assert.equal(journey.usefulRating, 'SOMEWHAT');
  assert.equal(journey.feedbackNote, 'Bottleneck at Iblur');
  assert.notEqual(journey.metrics.errorVsDepartureMin, originalError, 'metrics recomputed');
  assert.equal(JSON.stringify(journey.departureEstimate), depFrozen, 'departure snapshot still immutable');
  assert.equal(JSON.stringify(journey.selectedEstimate), selFrozen, 'selected snapshot still immutable');
});

test('fixture journeys also keep immutable snapshots through corrections', () => {
  let s = createDemoReducer(T0);
  const openFixture = s.journeys.find((j) => !j.actualArrivalIso)!;
  const depFrozen = JSON.stringify(openFixture.departureEstimate);
  s = demoReducer(s, {
    type: 'RECORD_ARRIVAL',
    nowIso: T1,
    journeyId: openFixture.id,
    arrivalHhmm: '09:07',
  });
  const journey = s.journeys.find((j) => j.id === openFixture.id)!;
  assert.equal(journey.metrics.isCompleted, true);
  assert.equal(JSON.stringify(journey.departureEstimate), depFrozen);
  assert.ok(journey.correctionHistoryCount >= 1);
});

test('selecting a different option later does not mutate the first selected snapshot', () => {
  let s = createDemoReducer(T0);
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const session = s.sessions[0];
  const first = session.latestOptions[0];
  s = demoReducer(s, { type: 'SELECT_OPTION', nowIso: T0, sessionId: session.id, optionId: first.id });
  const snap1 = { ...s.sessions[0].selectedEstimateSnapshot! };

  const second = session.latestOptions[session.latestOptions.length - 1];
  if (second.id !== first.id) {
    s = demoReducer(s, { type: 'SELECT_OPTION', nowIso: T1, sessionId: session.id, optionId: second.id });
    const snap2 = s.sessions[0].selectedEstimateSnapshot!;
    assert.equal(snap2.optionId, second.id);
    assert.equal(snap1.optionId, first.id, 'first snapshot content preserved in history copies');
    assert.notEqual(snap2.optionId, snap1.optionId);
  }
});

test('editing an open trip without an arrival preserves the missing arrival', () => {
  const { state, journeyId } = leftOnAJourney();
  const corrected = demoReducer(state, {
    type: 'CORRECT_JOURNEY',
    nowIso: '2026-11-09T06:00:00.000Z',
    journeyId,
    actualDepartureHhmm: '08:34',
    changedPlanOrRoute: false,
  });
  const journey = corrected.journeys.find((item) => item.id === journeyId)!;
  assert.equal(journey.actualArrivalIso, null);
  assert.equal(journey.actualArrivalTimeIst, null);
  assert.equal(journey.metrics.isCompleted, false);
  assert.equal(journey.metrics.actualDurationMin, null);
});
