import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoReducer, demoReducer, rehydrateDemoState } from '../state/demoReducer';
import type { DemoState } from '../state/demoReducer';

const T0 = '2026-11-09T03:00:00.000Z'; // 08:30 IST Mon
const T1 = '2026-11-09T03:05:00.000Z'; // 08:35 IST
const T_LATER = '2026-11-09T05:00:00.000Z'; // 10:30 IST same day

function skipMorning(): DemoState {
  let s = createDemoReducer(T0);
  s = demoReducer(s, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T0,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  const session = s.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  return demoReducer(s, { type: 'MONITORING_ACTION', nowIso: T1, sessionId: session.id, action: 'SKIP_TODAY' });
}

/** JSON round-trip stands in for AsyncStorage persistence. */
const persist = (s: DemoState): unknown => JSON.parse(JSON.stringify(s));

test('skip survives persistence + rehydration on the same IST day', () => {
  const s = skipMorning();
  const restored = rehydrateDemoState(persist(s), T_LATER);

  const session = restored.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  assert.equal(session.status, 'SKIPPED', 'session still skipped after rehydrate');
  assert.ok(
    restored.profile.dayOverrides.some(
      (o) => o.dateIst === '2026-11-09' && o.direction === 'HOME_TO_WORK' && o.skipped
    ),
    'day override persisted'
  );

  // Refresh must not resurrect the skipped session (no auto restart).
  const refreshed = demoReducer(restored, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T_LATER });
  assert.equal(refreshed.sessions.find((x) => x.direction === 'HOME_TO_WORK')!.status, 'SKIPPED');
});

test('resume clears the override but never restarts monitoring by itself', () => {
  const restored = rehydrateDemoState(persist(skipMorning()), T_LATER);
  const resumed = demoReducer(restored, { type: 'CLEAR_DAY_OVERRIDE', direction: 'HOME_TO_WORK' });

  assert.ok(
    !resumed.profile.dayOverrides.some(
      (o) => o.dateIst === '2026-11-09' && o.direction === 'HOME_TO_WORK'
    ),
    'override removed'
  );
  const session = resumed.sessions.find((x) => x.direction === 'HOME_TO_WORK')!;
  assert.equal(session.status, 'SKIPPED', 'session untouched — restart is always explicit');

  // Even a later state refresh leaves it skipped; only explicit START restarts.
  const afterRefresh = demoReducer(resumed, { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: T_LATER });
  assert.equal(afterRefresh.sessions.find((x) => x.direction === 'HOME_TO_WORK')!.status, 'SKIPPED');

  const afterStart = demoReducer(afterRefresh, {
    type: 'START_OR_REFRESH_SESSION',
    nowIso: T_LATER,
    direction: 'HOME_TO_WORK',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  assert.equal(afterStart.sessions.find((x) => x.direction === 'HOME_TO_WORK')!.status, 'EXPIRED', 'past-window restart expires on evaluation, never pretends to be live');
});

test('skip without a session persists as a day override alone', () => {
  let s = createDemoReducer(T0);
  s = demoReducer(s, {
    type: 'SET_DAY_OVERRIDE',
    override: { dateIst: '2026-11-09', direction: 'WORK_TO_HOME', skipped: true },
  });
  const restored = rehydrateDemoState(persist(s), T1);
  assert.ok(
    restored.profile.dayOverrides.some(
      (o) => o.dateIst === '2026-11-09' && o.direction === 'WORK_TO_HOME' && o.skipped
    )
  );
  assert.equal(restored.sessions.length, 0);
});

test('corrupted persisted state falls back to fresh fixtures (never crashes)', () => {
  const fromGarbage = rehydrateDemoState({ hello: 'world' }, T0);
  assert.equal(fromGarbage.anchoredDateIst, '2026-11-09');
  assert.ok(fromGarbage.journeys.length > 0);
  const fromNull = rehydrateDemoState(null, T0);
  assert.ok(fromNull.profile.homeLocation !== null);
});

test('onboarding acknowledgement persists across rehydration', () => {
  let s = createDemoReducer(T0);
  s = demoReducer(s, { type: 'ONBOARDING_ACKNOWLEDGED' });
  const restored = rehydrateDemoState(persist(s), T1);
  assert.equal(restored.onboardingAcknowledged, true);
});
