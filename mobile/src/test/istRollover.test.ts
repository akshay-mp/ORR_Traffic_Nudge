import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysToIstDate,
  getNowIstParts,
  hhmmToMinutes,
  istDateAndHhmmToIso,
  isoToIstHhmm,
} from '../services/demoEngine';
import { createDemoReducer, demoReducer, rehydrateDemoState } from '../state/demoReducer';
import { makeDemoJourneys } from '../services/demoFixtures';

test('getNowIstParts converts UTC instants to Asia/Kolkata clock parts', () => {
  // 2026-11-09T03:00:00Z -> 08:30 IST same calendar day
  const parts = getNowIstParts(new Date('2026-11-09T03:00:00.000Z'));
  assert.equal(parts.dateIst, '2026-11-09');
  assert.equal(parts.timeIst, '08:30');
  assert.equal(parts.dayOfWeek, 'MON');
  assert.equal(parts.minutesFromMidnight, 8 * 60 + 30);

  // Midnight rollover: 2026-11-09T20:30:00Z -> 2026-11-10 02:00 IST
  const rolled = getNowIstParts(new Date('2026-11-09T20:30:00.000Z'));
  assert.equal(rolled.dateIst, '2026-11-10');
  assert.equal(rolled.timeIst, '02:00');
  assert.equal(rolled.dayOfWeek, 'TUE');
});

test('addDaysToIstDate crosses months and leap-agnostic boundaries', () => {
  assert.equal(addDaysToIstDate('2026-11-09', -1), '2026-11-08');
  assert.equal(addDaysToIstDate('2026-11-01', -1), '2026-10-31');
  assert.equal(addDaysToIstDate('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToIstDate('2026-11-09', 0), '2026-11-09');
});

test('istDateAndHhmmToIso round-trips through isoToIstHhmm on the IST clock', () => {
  const iso = istDateAndHhmmToIso('2026-11-09', '08:30');
  assert.equal(iso, '2026-11-09T03:00:00.000Z');
  assert.equal(isoToIstHhmm(iso), '08:30');
  assert.equal(hhmmToMinutes('23:59'), 1439);
});

test('ROLLOVER_IF_NEW_DAY drops stale sessions, keeps journeys and profile', () => {
  let s = createDemoReducer('2026-11-09T03:00:00.000Z');
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: '2026-11-09T03:00:00.000Z',
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  assert.equal(s.sessions.length, 1);

  // 23:59:59 IST on Nov 9 is still the same IST day -> no state churn.
  const sameDay = demoReducer(s, { type: 'ROLLOVER_IF_NEW_DAY', nowIso: '2026-11-09T18:29:59.000Z' });
  assert.strictEqual(sameDay, s, 'no state churn inside the same IST day');

  // One second later (00:00:01 IST Nov 10) the IST day rolls over.
  const nextDay = demoReducer(s, { type: 'ROLLOVER_IF_NEW_DAY', nowIso: '2026-11-09T18:30:01.000Z' });
  assert.equal(nextDay.anchoredDateIst, '2026-11-10');
  assert.equal(nextDay.sessions.length, 0, "yesterday's sessions dropped");
  assert.equal(nextDay.journeys.length, s.journeys.length, 'journey history preserved');
  assert.equal(nextDay.profile.id, s.profile.id, 'profile preserved');
});

test('yesterday’s skip override never applies to today after rollover', () => {
  let s = createDemoReducer('2026-11-09T03:00:00.000Z');
  s = demoReducer(s, {
    type: 'SET_DAY_OVERRIDE',
    override: { dateIst: '2026-11-09', direction: 'HOME_TO_WORK', skipped: true },
  });

  const nextDay = rehydrateDemoState(s, '2026-11-10T03:00:00.000Z');
  const todaysOverride = nextDay.profile.dayOverrides.find(
    (o) => o.dateIst === '2026-11-10' && o.direction === 'HOME_TO_WORK'
  );
  assert.equal(todaysOverride, undefined, 'no override leaked into the new day');
  assert.ok(
    nextDay.profile.dayOverrides.some((o) => o.dateIst === '2026-11-09'),
    'historical override kept as history'
  );
  // And monitoring can start fresh on the new day.
  const started = demoReducer(nextDay, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: '2026-11-10T03:00:00.000Z',
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  assert.equal(started.sessions.filter((x) => x.dateIst === '2026-11-10').length, 1);
});

test('demo fixtures anchor trip history to the current IST date', () => {
  const journeys = makeDemoJourneys('2026-11-09');
  assert.ok(journeys.length >= 4);
  for (const j of journeys) {
    assert.ok(j.dateIst <= '2026-11-09', 'no fixture dated in the future');
    assert.match(j.dateIst, /^2026-1[01]-\d{2}$/, 'dates near the anchor');
  }
  const hasOpenJourney = journeys.some((j) => !j.actualArrivalIso);
  assert.ok(hasOpenJourney, 'one journey is open (arrival missing) for the correction flow');
  assert.ok(journeys.every((j) => j.environment === 'DEMO'));
  assert.ok(journeys.every((j) => Object.isFrozen(j.departureEstimate)));
});
