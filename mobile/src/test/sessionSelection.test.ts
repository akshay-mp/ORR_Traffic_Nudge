import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MonitoringSession } from '../types/shared';
import { createDemoReducer } from '../state/demoReducer';
import { selectCurrentSession } from '../services/sessionSelection';

const DATE_IST = '2026-11-09';

function session(id: string, startedAtIso: string, status: MonitoringSession['status']): MonitoringSession {
  const base = createDemoReducer('2026-11-09T03:00:00.000Z').sessions[0];
  return {
    ...base,
    id,
    dateIst: DATE_IST,
    direction: 'HOME_TO_WORK',
    startedAtIso,
    status,
  };
}

test('Today selects newer ACTIVE run across shuffled terminal history', () => {
  const oldLeft = session('old-left', '2026-11-09T02:40:00.000Z', 'LEFT');
  const oldStopped = session('old-stopped', '2026-11-09T02:45:00.000Z', 'STOPPED');
  const current = session('new-active', '2026-11-09T03:00:00.000Z', 'ACTIVE');

  for (const order of [
    [oldLeft, oldStopped, current],
    [current, oldStopped, oldLeft],
    [oldStopped, current, oldLeft],
  ]) {
    assert.equal(selectCurrentSession(order, 'HOME_TO_WORK', DATE_IST)?.id, 'new-active');
  }
});

test('Today does not resurrect older ACTIVE run when a newer run is STOPPED', () => {
  const oldActive = session('old-active', '2026-11-09T02:40:00.000Z', 'ACTIVE');
  const currentStopped = session('new-stopped', '2026-11-09T03:00:00.000Z', 'STOPPED');

  for (const order of [[oldActive, currentStopped], [currentStopped, oldActive]]) {
    assert.equal(selectCurrentSession(order, 'HOME_TO_WORK', DATE_IST)?.id, 'new-stopped');
  }
});

test('Today breaks equal timestamps deterministically by session ID', () => {
  const first = session('run-a', '2026-11-09T03:00:00.000Z', 'ACTIVE');
  const second = session('run-z', '2026-11-09T03:00:00.000Z', 'STOPPED');

  assert.equal(selectCurrentSession([first, second], 'HOME_TO_WORK', DATE_IST)?.id, 'run-z');
  assert.equal(selectCurrentSession([second, first], 'HOME_TO_WORK', DATE_IST)?.id, 'run-z');
});
