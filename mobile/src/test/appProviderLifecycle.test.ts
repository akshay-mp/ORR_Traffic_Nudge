/**
 * Provider lifecycle race tests.
 *
 * These run the REAL AppProvider from src/state/appStore.tsx through the
 * controlled harness in ./appProviderHarness.ts: actual login/logout/
 * setBaseUrl/enableNativePush/disableNativePush callbacks, the appReducer,
 * ConnectionGeneration write serialization, and the real NativePushCoordinator
 * over fake ports. Only platform boundaries are mocked (React hooks, RN
 * AppState, services/storage, services/pilotApi, services/nativePushExpo
 * adapter factory). Deferred gates reproduce the delayed DELETE / permission /
 * token boundaries; harness env logs (dispatches, stateSets, storageOps, port
 * calls) assert preconditions and deferred boundaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTALLATION_ID_STORAGE_KEY,
  OWNER_STORAGE_KEY,
  type NativePushResult,
} from '../services/nativePushContract';
import {
  deferred,
  makeProfile,
  mountAppProvider,
  STORAGE_KEYS,
  type MountSeed,
  type ProviderHarness,
} from './appProviderHarness';

const ORIGIN_A = 'https://old.example';
const ORIGIN_B = 'https://new.example';

function connectedSeedA(withSecureOwner = true): MountSeed {
  return {
    kv: {
      [STORAGE_KEYS.BASE_URL]: ORIGIN_A,
      [STORAGE_KEYS.TOKEN]: 'token-emp-a',
      [STORAGE_KEYS.OWNER]: 'emp-a',
      [STORAGE_KEYS.MODE]: 'CONNECTED',
      [STORAGE_KEYS.LIVE_CACHE]: JSON.stringify({
        baseUrl: ORIGIN_A,
        ownerId: 'emp-a',
        savedAt: 1_762_000_000_000,
        profile: makeProfile('emp-a'),
        serverClock: null,
        sessions: [],
        alerts: [],
        journeys: [],
        quota: null,
      }),
    },
    secure: withSecureOwner
      ? {
          [INSTALLATION_ID_STORAGE_KEY]: 'install-a-1',
          [OWNER_STORAGE_KEY]: JSON.stringify({ accountId: 'emp-a', apiOrigin: ORIGIN_A }),
        }
      : {},
  };
}

function statusValues(h: ProviderHarness): Array<NativePushResult | null> {
  return h.env.stateSets
    .filter((entry) => entry.kind === 'status')
    .map((entry) => entry.value as NativePushResult | null);
}

function storageOps(h: ProviderHarness, op: string): unknown[] {
  return h.env.storageOps.filter((entry) => entry.op === op).map((entry) => entry.value);
}

async function assertHydratedAsA(h: ProviderHarness): Promise<void> {
  await h.settle();
  const { state } = h.api;
  assert.equal(state.hydrated, true, 'precondition: provider hydrated from seeded storage');
  assert.equal(state.connection.loggedIn, true, 'precondition: seeded account A is logged in');
  assert.equal(state.connection.token, 'token-emp-a');
  assert.equal(state.live.profile?.employeeCode, 'emp-a');
  assert.ok(h.env.dispatches.includes('HYDRATED'));
}

test('delayed DELETE logout cannot unseat a newer origin+login: account B survives in memory and storage', async (t) => {
  const h = mountAppProvider(connectedSeedA());
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  // Boundary: account A device revocation is suspended at the DELETE port.
  h.env.gates.delete = deferred<{ status: 200 | 404 }>();
  const loggingOut = h.api.logout();
  await h.settle();
  const deleteCalls = h.env.calls.filter((call) => call.kind === 'delete');
  assert.equal(deleteCalls.length, 1, 'precondition: logout is blocked on A device DELETE');
  assert.equal(deleteCalls[0].account?.bearerToken, 'token-emp-a');
  assert.equal(deleteCalls[0].value, 'install-a-1');
  assert.equal(h.api.state.connection.loggedIn, true, 'logout must not dispatch LOGOUT yet');

  // Origin change while the DELETE is in flight.
  await h.api.setBaseUrl(ORIGIN_B);
  await h.settle();
  assert.equal(h.api.state.connection.baseUrl, ORIGIN_B);
  assert.equal(h.api.state.connection.loggedIn, false, 'origin change logs the old origin out');

  // Login as B on the new origin while A cleanup is still pending.
  await h.api.login('emp-b', '2222', ORIGIN_B);
  await h.settle(16);
  assert.equal(h.api.state.connection.loggedIn, true);
  assert.equal(h.api.state.connection.token, 'token-emp-b');
  assert.equal(h.api.state.live.profile?.employeeCode, 'emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.OWNER), 'emp-b');
  const cachedB = JSON.parse(h.env.kv.get(STORAGE_KEYS.LIVE_CACHE) ?? '{}');
  assert.equal(cachedB.ownerId, 'emp-b');
  assert.equal(cachedB.baseUrl, ORIGIN_B);

  // Resolve the stale A cleanup.
  h.env.gates.delete.resolve({ status: 200 });
  await h.settle(24);
  await loggingOut;

  // In-memory state still belongs to B.
  assert.equal(h.api.state.connection.loggedIn, true, 'stale logout cleanup cannot dispatch LOGOUT');
  assert.equal(h.api.state.connection.token, 'token-emp-b');
  assert.equal(h.api.state.live.profile?.employeeCode, 'emp-b');
  assert.equal(h.api.state.mode, 'CONNECTED');
  // Storage still belongs to B (no late clearAccountBinding, no token erase).
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.OWNER), 'emp-b');
  assert.deepEqual(storageOps(h, 'saveToken').at(-1), 'token-emp-b');
  assert.deepEqual(storageOps(h, 'saveOwnerId').at(-1), 'emp-b');
  assert.equal(storageOps(h, 'clearLiveCache').length, 1, 'only the origin change cleared the cache');
  assert.equal(
    JSON.parse(h.env.kv.get(STORAGE_KEYS.LIVE_CACHE) ?? '{}').ownerId,
    'emp-b',
    'live cache still holds B snapshot'
  );
  // Exactly one LOGOUT (from the origin change) and one LOGIN (B).
  assert.equal(h.env.dispatches.filter((d) => d === 'LOGOUT').length, 1);
  assert.equal(h.env.dispatches.filter((d) => d === 'LOGIN').length, 1);
  // Status after the queue drains belongs to B's refresh, not A's cleanup
  // (A's stale cleanup result would carry permission 'not-requested').
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'granted');
  assert.equal(status?.pendingCleanup, false);
  assert.equal(status?.errorCode, undefined);
});

test('rejected delayed DELETE cleanup also preserves account B and reports pending cleanup only for the current account', async (t) => {
  const h = mountAppProvider(connectedSeedA());
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  h.env.gates.delete = deferred<{ status: 200 | 404 }>();
  const loggingOut = h.api.logout();
  await h.settle();
  assert.equal(h.env.calls.filter((call) => call.kind === 'delete').length, 1);

  await h.api.setBaseUrl(ORIGIN_B);
  await h.settle();
  await h.api.login('emp-b', '2222', ORIGIN_B);
  await h.settle(16);
  assert.equal(h.api.state.connection.token, 'token-emp-b');

  // The stale A cleanup fails (device DELETE rejects -> removeOwnedDevice fails).
  h.env.gates.delete.reject(new Error('offline'));
  await h.settle(24);
  await loggingOut.catch(() => undefined);

  assert.equal(h.api.state.connection.loggedIn, true, 'failed stale cleanup must not dispatch LOGOUT');
  assert.equal(h.api.state.connection.token, 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.OWNER), 'emp-b');
  assert.deepEqual(storageOps(h, 'saveToken').at(-1), 'token-emp-b');
  assert.equal(storageOps(h, 'clearLiveCache').length, 1);
  // A's genuinely pending cleanup is reported through B's own refresh guard.
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'granted');
  assert.ok(['pending-cleanup', 'consent-required'].includes(status?.state ?? ''), `unexpected status ${status?.state}`);
  assert.equal(h.env.dispatches.filter((d) => d === 'LOGIN').length, 1);
});

test('logout during a permission-gated enable resets nativePushBusy without waiting for the prompt', async (t) => {
  const h = mountAppProvider(connectedSeedA(false));
  t.after(() => h.unmount());
  await assertHydratedAsA(h);

  h.env.gates.permission = deferred<'granted' | 'denied' | 'undetermined'>();
  const enabling = h.api.enableNativePush();
  await h.settle();
  assert.equal(h.api.nativePushBusy, true, 'precondition: enable marked busy');
  assert.equal(h.env.calls.filter((call) => call.kind === 'permission').length, 1);
  assert.ok(
    h.env.pilotCalls.some((call) => call.method === 'updateProfile' && (call.arg as { pushOptIn?: boolean })?.pushOptIn === true),
    'precondition: push consent acknowledged through the profile before the native flow'
  );

  const loggingOut = h.api.logout();
  assert.equal(h.api.nativePushBusy, false, 'invalidation resets busy synchronously at logout start');
  await loggingOut;
  await h.settle();

  assert.equal(h.api.state.connection.loggedIn, false);
  assert.equal(h.api.state.mode, 'DEMO');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), undefined, 'logout cleared the stored token');

  // The cancelled enable settles late and must not touch busy or status.
  h.env.gates.permission.resolve('granted');
  const lateEnable = await enabling;
  assert.equal(lateEnable.state, 'error');
  assert.equal(h.api.nativePushBusy, false);
  assert.equal(h.env.calls.filter((call) => call.kind === 'token').length, 0, 'cancelled enable never reaches token acquisition');
  assert.equal(h.env.calls.filter((call) => call.kind === 'register').length, 0, 'cancelled enable never registers');
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'not-requested', 'status is the logout cleanup result, not the enable outcome');
  assert.equal(status?.errorCode, undefined);
});

test('origin change during a token-gated enable resets nativePushBusy and shows cleanup status, never the stale enable result', async (t) => {
  const h = mountAppProvider(connectedSeedA(false));
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  h.env.gates.token = deferred<string>();
  const enabling = h.api.enableNativePush();
  await h.settle();
  assert.equal(h.api.nativePushBusy, true, 'precondition: enable busy at the token boundary');
  assert.equal(h.env.calls.filter((call) => call.kind === 'token').length, 1);

  h.api.setBaseUrl(ORIGIN_B);
  assert.equal(h.api.nativePushBusy, false, 'origin-change invalidation resets busy synchronously');
  await h.settle();

  assert.equal(h.api.state.connection.loggedIn, false, 'origin change logged the old origin out');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), undefined);
  assert.equal(h.env.kv.has(STORAGE_KEYS.LIVE_CACHE), false, 'origin-scoped cache cleared');

  h.env.gates.token.resolve('ExpoPushToken[late-token]');
  const lateEnable = await enabling;
  assert.equal(lateEnable.state, 'error', 'cancelled enable reports error');
  assert.equal(h.api.nativePushBusy, false);
  const status = h.api.nativePushStatus;
  assert.equal(status?.state, 'consent-required', 'status is the current cleanup result');
  assert.equal(status?.permission, 'not-requested');
  assert.equal(status?.errorCode, undefined, 'stale enable never overwrote the status');
  assert.equal(h.env.calls.filter((call) => call.kind === 'register').length, 0);
});

test('login during a permission-gated enable resets nativePushBusy; the stale enable stays inert after login B', async (t) => {
  const h = mountAppProvider(connectedSeedA(false));
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);
  h.env.permissionStatus = 'undetermined';

  h.env.gates.permission = deferred<'granted' | 'denied' | 'undetermined'>();
  const enabling = h.api.enableNativePush();
  await h.settle();
  assert.equal(h.api.nativePushBusy, true, 'precondition: enable busy at the permission boundary');
  // Later permission reads (account B refresh) report granted.
  h.env.permissionStatus = 'granted';

  const loggingIn = h.api.login('emp-b', '2222');
  assert.equal(h.api.nativePushBusy, false, 'login invalidation resets busy synchronously');
  await loggingIn;
  await h.settle();

  assert.equal(h.api.state.connection.loggedIn, true);
  assert.equal(h.api.state.connection.token, 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-b');

  h.env.gates.permission.resolve('granted');
  const lateEnable = await enabling;
  assert.equal(lateEnable.state, 'error');
  assert.equal(h.api.nativePushBusy, false);
  assert.equal(h.env.calls.filter((call) => call.kind === 'register').length, 0);
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'granted', 'final status comes from account B refresh');
  assert.equal(status?.errorCode, undefined);
});

test('a stale enable finally cannot clear a newer disable operation busy flag', async (t) => {
  const h = mountAppProvider(connectedSeedA());
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  // Enable #1 suspends at the token boundary.
  h.env.gates.token = deferred<string>();
  const enabling = h.api.enableNativePush();
  await h.settle();
  assert.equal(h.api.nativePushBusy, true, 'precondition: enable #1 busy');

  // Disable #2 supersedes it and suspends at the device DELETE boundary.
  h.env.gates.delete = deferred<{ status: 200 | 404 }>();
  const disabling = h.api.disableNativePush();
  await h.settle();

  const staleEnable = await enabling;
  assert.equal(staleEnable.state, 'error', 'superseded enable is cancelled');
  assert.equal(
    h.api.nativePushBusy,
    true,
    'stale enable finally must not clear the newer disable busy flag'
  );
  const deleteCalls = h.env.calls.filter((call) => call.kind === 'delete');
  assert.equal(deleteCalls.length, 1, 'disable #2 is blocked at the DELETE boundary');
  assert.equal(deleteCalls[0].account?.bearerToken, 'token-emp-a');
  assert.equal(deleteCalls[0].value, 'install-a-1');
  assert.equal(
    h.env.stateSets.filter((entry) => entry.kind === 'busy' && entry.value === false).length,
    0,
    'no busy=false setter call happened after the newer operation started'
  );

  h.env.gates.delete.resolve({ status: 200 });
  const disableResult = await disabling;
  assert.equal(disableResult.state, 'consent-required', 'cleanup completed for the current operation');
  assert.equal(h.api.nativePushBusy, false, 'current operation finally clears busy');
  const status = h.api.nativePushStatus;
  assert.equal(status?.installationId, 'install-a-1');
  assert.equal(status?.permission, 'not-requested');
  assert.equal(
    h.env.secure.has(OWNER_STORAGE_KEY),
    false,
    'successful cleanup removed the stored native-push owner'
  );
});

test('stale origin-change cleanup cannot overwrite the current account push status', async (t) => {
  const h = mountAppProvider(connectedSeedA());
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  // Origin change fires the old account cleanup; suspend it at DELETE.
  h.env.gates.delete = deferred<{ status: 200 | 404 }>();
  h.api.setBaseUrl(ORIGIN_B);
  await h.settle();
  assert.equal(h.api.state.connection.loggedIn, false);
  const clearedStatus: NativePushResult | null = h.api.nativePushStatus;
  assert.equal(clearedStatus, null, 'invalidation cleared the status');
  assert.equal(h.env.calls.filter((call) => call.kind === 'delete').length, 1, 'cleanup suspended at DELETE');

  // Login B on the new origin completes and persists while cleanup is pending.
  await h.api.login('emp-b', '2222', ORIGIN_B);
  await h.settle(16);
  assert.equal(h.api.state.connection.token, 'token-emp-b');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-b');

  const marker = statusValues(h).length;
  h.env.gates.delete.resolve({ status: 200 });
  await h.settle(24);

  const after = statusValues(h).slice(marker);
  assert.ok(after.length >= 1, 'B refresh status landed after the queue drained');
  for (const value of after) {
    assert.equal(
      value?.permission,
      'granted',
      `every post-cleanup status write belongs to account B (got ${value?.state}/${value?.permission})`
    );
  }
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'granted');
  assert.equal(status?.pendingCleanup, false);
  assert.equal(h.env.dispatches.filter((d) => d === 'LOGIN').length, 1);
});

test('stale login cleanup cannot overwrite a newer login: only the newest account lands', async (t) => {
  const h = mountAppProvider(connectedSeedA());
  t.after(() => h.unmount());
  h.env.permissionStatus = 'granted';
  await assertHydratedAsA(h);

  // Login B starts an account-change cleanup of A, suspended at DELETE.
  h.env.gates.delete = deferred<{ status: 200 | 404 }>();
  const loginB = h.api.login('emp-b', '2222');
  await h.settle();
  assert.equal(h.env.calls.filter((call) => call.kind === 'delete').length, 1, 'login B blocked on A cleanup');
  assert.equal(h.api.state.connection.token, 'token-emp-a', 'login B must not dispatch LOGIN before cleanup commits');

  // A newer login C supersedes login B while its cleanup is pending.
  const loginC = h.api.login('emp-c', '3333');
  await h.settle();

  const marker = statusValues(h).length;
  h.env.gates.delete.resolve({ status: 200 });
  await loginB;
  await loginC;
  await h.settle(24);

  assert.equal(h.api.state.connection.token, 'token-emp-c', 'newest login owns the connection');
  assert.equal(h.api.state.live.profile?.employeeCode, 'emp-c');
  assert.equal(h.env.kv.get(STORAGE_KEYS.TOKEN), 'token-emp-c');
  assert.equal(h.env.kv.get(STORAGE_KEYS.OWNER), 'emp-c');
  assert.equal(JSON.parse(h.env.kv.get(STORAGE_KEYS.LIVE_CACHE) ?? '{}').ownerId, 'emp-c');
  assert.equal(h.env.dispatches.filter((d) => d === 'LOGIN').length, 1, 'stale login B never dispatched LOGIN');
  assert.equal(h.env.pilotCalls.filter((call) => call.method === 'login').length, 2);

  // Exactly one 'not-requested' cleanup status write after the boundary —
  // login C's own (current) cleanup. A stale write from login B would make two.
  const notRequestedAfter = statusValues(h)
    .slice(marker)
    .filter((value) => value?.permission === 'not-requested');
  assert.equal(notRequestedAfter.length, 1, 'only the current login cleanup wrote a cleanup status');
  const status = h.api.nativePushStatus;
  assert.equal(status?.permission, 'granted', 'final status is account C refresh');
  assert.equal(status?.errorCode, undefined);
});
