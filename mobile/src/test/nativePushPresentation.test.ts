import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativePushExplanation } from '../services/nativePushPresentation';
import type { NativePushResult } from '../services/nativePushContract';

function result(state: NativePushResult['state']): NativePushResult {
  return {
    state,
    installationId: null,
    permission: 'not-requested',
    registered: false,
    nativePushEnabled: null,
    pendingCleanup: state === 'pending-cleanup',
  };
}

test('push settings copy distinguishes unsupported setup, denied permission, pending cleanup, and errors', () => {
  assert.match(nativePushExplanation(result('expo-go-unsupported')), /development build/i);
  assert.match(nativePushExplanation(result('missing-project-id')), /real EAS project ID/i);
  assert.match(nativePushExplanation(result('permission-denied')), /device Settings/i);
  assert.match(nativePushExplanation(result('pending-cleanup')), /not be transferred/i);
  assert.match(nativePushExplanation(result('error')), /Unable to confirm/i);
  assert.doesNotMatch(nativePushExplanation(result('registered')), /delivered|delivery guaranteed/i);
});
