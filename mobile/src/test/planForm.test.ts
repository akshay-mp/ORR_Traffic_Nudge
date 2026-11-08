import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DirectionSchedule, UserProfile } from '../types/shared';
import {
  PlanFormSnapshot,
  formIdentity,
  profileToFormSnapshot,
  syncFormToIdentity,
} from '../state/planForm';

function schedule(dir: 'HOME_TO_WORK' | 'WORK_TO_HOME', windowStart: string, mode: 'CAR' | 'BIKE' | 'BMTC' = 'CAR'): DirectionSchedule {
  return {
    direction: dir,
    enabled: true,
    mode,
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    windowStart,
    windowEnd: dir === 'HOME_TO_WORK' ? '09:15' : '19:00',
    arrivalDeadline: dir === 'HOME_TO_WORK' ? '09:45' : null,
    preferredDeparture: dir === 'HOME_TO_WORK' ? '08:30' : '18:00',
    safetyBufferMinutes: 10,
    leadTimeMinutes: 15,
    alertThresholdMinutes: 5,
  };
}

function profile(id: string, windowStart = '08:00', mode: 'CAR' | 'BIKE' | 'BMTC' = 'CAR'): UserProfile {
  return {
    id,
    employeeCode: id === 'demo_local_user' ? 'DEMO-LOCAL' : 'PTP-01',
    name: 'Test',
    role: 'Test',
    corridorTag: 'tag',
    onboardingComplete: true,
    telemetryConsent: true,
    pushOptIn: false,
    homeLocation: { label: 'Home', address: 'a', lat: 12.9, lng: 77.6, confirmedAt: '2026-11-01T00:00:00.000Z' },
    workLocation: { label: 'Work', address: 'b', lat: 12.94, lng: 77.69, confirmedAt: '2026-11-01T00:00:00.000Z' },
    schedules: {
      HOME_TO_WORK: schedule('HOME_TO_WORK', windowStart, mode),
      WORK_TO_HOME: schedule('WORK_TO_HOME', '17:30'),
    },
    dayOverrides: [],
  };
}

const fallbackSchedules = { HOME_TO_WORK: schedule('HOME_TO_WORK', '08:00'), WORK_TO_HOME: schedule('WORK_TO_HOME', '17:30') };

test('formIdentity is stable across routine refreshes and sensitive to owner changes', () => {
  const demoId = formIdentity('DEMO', 'http://10.0.2.2:3000', profile('demo_local_user'));
  assert.equal(demoId, formIdentity('DEMO', 'http://10.0.2.2:3000', profile('demo_local_user')), 'same values -> same identity');
  assert.equal(
    formIdentity('DEMO', 'http://10.0.2.2:3000/', profile('demo_local_user')),
    demoId,
    'trailing slash normalized'
  );
  assert.notEqual(demoId, formIdentity('CONNECTED', 'http://10.0.2.2:3000', profile('demo_local_user')), 'mode change');
  assert.notEqual(demoId, formIdentity('DEMO', 'http://192.168.1.20:3000', profile('demo_local_user')), 'origin change');
  assert.notEqual(demoId, formIdentity('DEMO', 'http://10.0.2.2:3000', profile('emp_01')), 'account change');
  assert.notEqual(demoId, formIdentity('DEMO', 'http://10.0.2.2:3000', null), 'profile hydration');
});

test('same identity + refreshed profile object keeps unsaved edits (no clobber)', () => {
  const demoProfile = profile('demo_local_user');
  let form = { identity: 'DEMO|http://10.0.2.2:3000|demo_local_user', snapshot: profileToFormSnapshot(demoProfile, fallbackSchedules) };

  // User edits a draft and does not save.
  const edited: PlanFormSnapshot = {
    ...form.snapshot,
    drafts: { ...form.snapshot.drafts, HOME_TO_WORK: { ...form.snapshot.drafts.HOME_TO_WORK, windowStart: '07:30' } },
  };
  form = { ...form, snapshot: edited };

  // Routine refresh delivers a NEW profile object with the SAME server values.
  const refreshedProfile = profile('demo_local_user');
  assert.notEqual(refreshedProfile, demoProfile, 'new object identity');
  const result = syncFormToIdentity(form, formIdentity('DEMO', 'http://10.0.2.2:3000', refreshedProfile), refreshedProfile, fallbackSchedules);
  assert.equal(result, form, 'state object untouched');
  assert.equal(result.snapshot.drafts.HOME_TO_WORK.windowStart, '07:30', 'unsaved edit preserved');
});

test('switching DEMO -> CONNECTED (different user) resets drafts from the new profile', () => {
  const demoProfile = profile('demo_local_user', '08:00');
  const demoIdentity = formIdentity('DEMO', 'http://10.0.2.2:3000', demoProfile);
  let form = { identity: demoIdentity, snapshot: profileToFormSnapshot(demoProfile, fallbackSchedules) };

  // Unsaved demo edit that must NOT leak into the pilot user's plan.
  form = {
    ...form,
    snapshot: {
      ...form.snapshot,
      drafts: { ...form.snapshot.drafts, HOME_TO_WORK: { ...form.snapshot.drafts.HOME_TO_WORK, windowStart: '06:15', days: ['SUN'] } },
      modes: { ...form.snapshot.modes, HOME_TO_WORK: 'BMTC' },
    },
  };

  const empProfile = profile('emp_01', '08:45', 'BIKE');
  const connectedIdentity = formIdentity('CONNECTED', 'http://10.0.2.2:3000', empProfile);
  const result = syncFormToIdentity(form, connectedIdentity, empProfile, fallbackSchedules);

  assert.notEqual(result, form, 'form reset on identity change');
  assert.equal(result.identity, connectedIdentity);
  assert.equal(result.snapshot.drafts.HOME_TO_WORK.windowStart, '08:45', 'draft from the connected user profile');
  assert.deepEqual(result.snapshot.drafts.HOME_TO_WORK.days, ['MON', 'TUE', 'WED', 'THU', 'FRI'], 'demo days discarded');
  assert.equal(result.snapshot.modes.HOME_TO_WORK, 'BIKE', 'demo mode discarded');
});

test('logging in as another employee on the same backend resets drafts', () => {
  const emp1 = profile('emp_01', '08:10');
  const emp2 = profile('emp_02', '08:50');
  const base = 'http://10.0.2.2:3000';
  const form = { identity: formIdentity('CONNECTED', base, emp1), snapshot: profileToFormSnapshot(emp1, fallbackSchedules) };
  const result = syncFormToIdentity(form, formIdentity('CONNECTED', base, emp2), emp2, fallbackSchedules);
  assert.equal(result.snapshot.drafts.HOME_TO_WORK.windowStart, '08:50', 'reset to emp_02 values');
});

test('changing the backend origin resets drafts even for the same user', () => {
  const emp = profile('emp_01', '08:20');
  let form = { identity: formIdentity('CONNECTED', 'http://10.0.2.2:3000', emp), snapshot: profileToFormSnapshot(emp, fallbackSchedules) };
  const result = syncFormToIdentity(
    form,
    formIdentity('CONNECTED', 'http://192.168.1.20:3000', emp),
    emp,
    fallbackSchedules
  );
  assert.notEqual(result, form, 'origin change forces re-sync');
  assert.equal(result.snapshot.drafts.HOME_TO_WORK.windowStart, '08:20');
});

test('null profile hydrates from fallback schedules (setup-before-login shape)', () => {
  const snapshot = profileToFormSnapshot(null, fallbackSchedules);
  assert.equal(snapshot.drafts.HOME_TO_WORK.windowStart, '08:00');
  assert.equal(snapshot.enabled.WORK_TO_HOME, true);
  assert.equal(snapshot.modes.HOME_TO_WORK, 'CAR');
});
