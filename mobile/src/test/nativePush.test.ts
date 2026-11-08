import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativePushCoordinator } from '../services/nativePush';
import {
  INSTALLATION_ID_STORAGE_KEY,
  OWNER_STORAGE_KEY,
  PENDING_CLEANUP_STORAGE_KEY,
  type NativePushAccount,
  type NativePushPorts,
} from '../services/nativePushContract';

const userA: NativePushAccount = { accountId: 'a', bearerToken: 'bearer-a', apiOrigin: 'https://pilot.test' };
const userB: NativePushAccount = { accountId: 'b', bearerToken: 'bearer-b', apiOrigin: 'https://pilot.test' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<NativePushPorts> = {}) {
  const values = new Map<string, string>();
  const calls: Array<{ kind: string; account?: NativePushAccount; value?: unknown }> = [];
  let token = 'ExpoPushToken[token-first-123456]';
  let permission: 'granted' | 'denied' | 'undetermined' = 'undetermined';
  let deleteStatus: 200 | 404 = 200;
  const ports: NativePushPorts = {
    runtime: { platform: 'ios', isExpoGo: false, isSimulator: false, simulatorPushSupported: false, projectId: 'eas-project' },
    notifications: {
      setAndroidChannel: async () => { calls.push({ kind: 'channel' }); },
      getPermissionStatus: async () => permission,
      requestPermission: async () => { calls.push({ kind: 'permission' }); permission = 'granted'; return permission; },
      getExpoPushToken: async () => { calls.push({ kind: 'token' }); return token; },
    },
    secureStorage: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); },
      remove: async (key) => { values.delete(key); },
    },
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    api: {
      registerDevice: async (account, body) => { calls.push({ kind: 'register', account, value: body }); return { status: 201 }; },
      deleteDevice: async (account, installationId) => { calls.push({ kind: 'delete', account, value: installationId }); return { status: deleteStatus }; },
      getDevices: async () => [],
      getPushStatus: async () => ({ nativePushEnabled: false, registeredDevices: 0,
        outbox: { transportEnabled: false, pending: 0, sent: 0, failed: 0, skipped: 0, receiptPending: 0, receiptOk: 0, receiptError: 0 },
        deliveryDisclaimer: 'Not delivery confirmation.' }),
    },
    ...overrides,
  };
  return {
    coordinator: new NativePushCoordinator(ports), ports, values, calls,
    setPermission(value: typeof permission) { permission = value; },
    setToken(value: string) { token = value; },
    setDeleteStatus(value: typeof deleteStatus) { deleteStatus = value; },
  };
}

test('requires explicit consent and reports unsupported or missing EAS configuration honestly', async () => {
  const consent = fixture();
  assert.equal((await consent.coordinator.enable(userA, { consent: false })).state, 'consent-required');
  assert.equal(consent.calls.length, 0);

  const expoGo = fixture();
  expoGo.ports.runtime.isExpoGo = true;
  assert.equal((await expoGo.coordinator.enable(userA, { consent: true })).state, 'expo-go-unsupported');
  assert.equal(expoGo.calls.length, 0);

  const simulator = fixture();
  simulator.ports.runtime.isSimulator = true;
  assert.equal((await simulator.coordinator.enable(userA, { consent: true })).state, 'simulator-unsupported');

  const supportedSimulator = fixture();
  supportedSimulator.ports.runtime.isSimulator = true;
  supportedSimulator.ports.runtime.simulatorPushSupported = true;
  assert.equal((await supportedSimulator.coordinator.enable(userA, { consent: true })).state, 'registered');

  const noProject = fixture();
  noProject.ports.runtime.projectId = null;
  assert.equal((await noProject.coordinator.enable(userA, { consent: true })).state, 'missing-project-id');
});

test('configures Android channel before permission and token; 201 registration and token rotation succeed', async () => {
  const testFixture = fixture();
  testFixture.ports.runtime.platform = 'android';
  const first = await testFixture.coordinator.enable(userA, { consent: true });
  assert.equal(first.state, 'registered');
  assert.deepEqual(testFixture.calls.map((call) => call.kind), ['channel', 'permission', 'token', 'register']);
  const body = testFixture.calls[3].value as { installationId: string; expoPushToken: string };
  assert.match(body.installationId, /^install-[a-f0-9]{32}$/);
  assert.equal(body.expoPushToken, 'ExpoPushToken[token-first-123456]');
  assert.equal(testFixture.values.has(INSTALLATION_ID_STORAGE_KEY), true);
  assert.equal([...testFixture.values.values()].some((value) => value.includes('ExpoPushToken')), false);

  testFixture.setToken('ExpoPushToken[token-rotated-12345]');
  const second = await testFixture.coordinator.enable(userA, { consent: true });
  assert.equal(second.state, 'registered');
  assert.equal(testFixture.calls.filter((call) => call.kind === 'register').length, 2);
  assert.equal((testFixture.calls.at(-1)?.value as { installationId: string }).installationId, body.installationId);
});

test('denial and notification exceptions never report registration', async () => {
  const denied = fixture();
  denied.ports.notifications.requestPermission = async () => 'denied';
  const result = await denied.coordinator.enable(userA, { consent: true });
  assert.equal(result.state, 'permission-denied');
  assert.equal(result.registered, false);
  assert.equal(denied.calls.some((call) => call.kind === 'register'), false);

  const failed = fixture();
  failed.ports.notifications.getExpoPushToken = async () => { throw new Error('native failure'); };
  const failedResult = await failed.coordinator.enable(userA, { consent: true });
  assert.equal(failedResult.state, 'error');
  assert.equal(failedResult.registered, false);
});

test('logout during delayed permission invalidates the pending registration', async () => {
  const permissionGate = deferred<'granted'>();
  const testFixture = fixture();
  testFixture.ports.notifications.requestPermission = () => permissionGate.promise;
  const enabling = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  await testFixture.coordinator.disable(userA);
  permissionGate.resolve('granted');
  const result = await enabling;
  assert.equal(result.state, 'error');
  assert.equal(testFixture.calls.some((call) => call.kind === 'token' || call.kind === 'register'), false);
});

test('logout during delayed token acquisition prevents API registration', async () => {
  const tokenGate = deferred<string>();
  const testFixture = fixture();
  testFixture.setPermission('granted');
  testFixture.ports.notifications.getExpoPushToken = () => tokenGate.promise;
  const enabling = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  testFixture.coordinator.invalidateInFlight();
  tokenGate.resolve('ExpoPushToken[late-token-123456]');
  const result = await enabling;
  assert.equal(result.state, 'error');
  assert.equal(testFixture.calls.some((call) => call.kind === 'register'), false);
});

test('stale delayed registration is revoked; failed revoke blocks account transfer', async () => {
  const registrationGate = deferred<{ status: 201 }>();
  const testFixture = fixture();
  testFixture.ports.api.registerDevice = async () => registrationGate.promise;
  const enabling = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  const disablingStale = testFixture.coordinator.disable(userA);
  registrationGate.resolve({ status: 201 });
  assert.equal((await enabling).state, 'error');
  assert.equal((await disablingStale).state, 'consent-required');
  assert.equal(testFixture.calls.some((call) => call.kind === 'delete'), true);

  await testFixture.values.set(OWNER_STORAGE_KEY, JSON.stringify({ accountId: 'a', apiOrigin: userA.apiOrigin }));
  testFixture.setDeleteStatus(404);
  const disabled = await testFixture.coordinator.disable(userA);
  assert.equal(disabled.state, 'consent-required');
  assert.equal(testFixture.values.has(PENDING_CLEANUP_STORAGE_KEY), false);

  await testFixture.values.set(OWNER_STORAGE_KEY, JSON.stringify({ accountId: 'a', apiOrigin: userA.apiOrigin }));
  testFixture.setDeleteStatus(200);
  testFixture.ports.api.deleteDevice = async () => { throw new Error('offline'); };
  const blocked = await testFixture.coordinator.enable(userB, { consent: true });
  assert.equal(blocked.state, 'pending-cleanup');
  assert.equal(blocked.pendingCleanup, true);
  assert.equal(testFixture.calls.some((call) => call.kind === 'register' && call.account?.accountId === 'b'), false);
});

test('backend disabled remains separate from local registration and delivery', async () => {
  const testFixture = fixture();
  const status = await testFixture.coordinator.refreshStatus(userA);
  assert.equal(status.state, 'server-disabled');
  assert.equal(status.nativePushEnabled, false);
  assert.equal(status.registered, false);
  assert.equal(status.permission, 'undetermined');
});

test('status reads do not cancel an in-flight explicit registration', async () => {
  const registrationGate = deferred<{ status: 201 }>();
  const testFixture = fixture();
  testFixture.setPermission('granted');
  testFixture.ports.api.registerDevice = async () => registrationGate.promise;
  const enabling = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  const status = testFixture.coordinator.refreshStatus(userA);
  registrationGate.resolve({ status: 201 });
  assert.equal((await enabling).state, 'registered');
  assert.equal((await status).state, 'server-disabled');
  assert.equal(testFixture.calls.some((call) => call.kind === 'delete'), false);
});

test('serialized concurrent enable calls share one stable installation ID', async () => {
  const testFixture = fixture();
  testFixture.setPermission('granted');
  const tokenGate = deferred<string>();
  testFixture.ports.notifications.getExpoPushToken = () => tokenGate.promise;
  let randomCalls = 0;
  testFixture.ports.randomBytes = (length) => {
    randomCalls += 1;
    return Uint8Array.from({ length }, (_, index) => index + 1);
  };
  const firstRequest = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  const secondRequest = testFixture.coordinator.enable(userA, { consent: true });
  tokenGate.resolve('ExpoPushToken[stable-test-token]');
  const [first, second] = await Promise.all([firstRequest, secondRequest]);
  assert.equal(randomCalls, 1);
  assert.equal(first.installationId, second.installationId);
  assert.equal(first.state, 'error', 'superseded registration is cancelled before the server write');
  assert.equal(second.state, 'registered');
  const registrations = testFixture.calls.filter((call) => call.kind === 'register');
  assert.equal(registrations.length, 1);
  assert.equal((registrations[0].value as { installationId: string }).installationId, first.installationId);
});

test('account transfer waits for old-owner revocation before writing new ownership', async () => {
  const deleteGate = deferred<{ status: 200 | 404 }>();
  const testFixture = fixture();
  await testFixture.values.set(INSTALLATION_ID_STORAGE_KEY, 'install-stable');
  await testFixture.values.set(OWNER_STORAGE_KEY, JSON.stringify({ accountId: userA.accountId, apiOrigin: userA.apiOrigin }));
  testFixture.ports.api.deleteDevice = async (account, installationId) => {
    testFixture.calls.push({ kind: 'delete', account, value: installationId });
    return deleteGate.promise;
  };
  const enabling = testFixture.coordinator.enable(userB, { consent: true, previousOwnerAccount: userA });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testFixture.values.get(OWNER_STORAGE_KEY), JSON.stringify({ accountId: userA.accountId, apiOrigin: userA.apiOrigin }));
  assert.equal(testFixture.values.has(PENDING_CLEANUP_STORAGE_KEY), true);
  assert.equal(testFixture.calls.some((call) => call.kind === 'register'), false);
  deleteGate.resolve({ status: 404 });
  assert.equal((await enabling).state, 'registered');
  assert.equal(JSON.parse(testFixture.values.get(OWNER_STORAGE_KEY)!).accountId, userB.accountId);
  assert.equal(testFixture.values.has(PENDING_CLEANUP_STORAGE_KEY), false);
  assert.equal(testFixture.calls.find((call) => call.kind === 'delete')?.account?.bearerToken, userA.bearerToken);
});

test('logout can complete while permission prompt is unresolved, then late grant is ignored', async () => {
  const permissionGate = deferred<'granted'>();
  const testFixture = fixture();
  testFixture.ports.notifications.requestPermission = () => permissionGate.promise;
  const enabling = testFixture.coordinator.enable(userA, { consent: true });
  await new Promise((resolve) => setImmediate(resolve));
  const disabling = testFixture.coordinator.disable(userA);
  assert.equal((await disabling).state, 'consent-required');
  assert.equal((await enabling).state, 'error');
  permissionGate.resolve('granted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testFixture.calls.some((call) => call.kind === 'token' || call.kind === 'register'), false);
});

test('stale revocation cannot erase a newer owner written while delete is delayed', async () => {
  const deleteGate = deferred<{ status: 200 | 404 }>();
  const testFixture = fixture();
  await testFixture.values.set(INSTALLATION_ID_STORAGE_KEY, 'install-stable');
  await testFixture.values.set(OWNER_STORAGE_KEY, JSON.stringify({ accountId: userA.accountId, apiOrigin: userA.apiOrigin }));
  testFixture.ports.api.deleteDevice = async () => deleteGate.promise;
  const disabling = testFixture.coordinator.disable(userA);
  await new Promise((resolve) => setImmediate(resolve));
  const newerOwner = { accountId: userB.accountId, apiOrigin: userB.apiOrigin };
  await testFixture.values.set(OWNER_STORAGE_KEY, JSON.stringify(newerOwner));
  await testFixture.values.set(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify({ installationId: 'install-stable', owner: newerOwner }));
  deleteGate.resolve({ status: 200 });
  assert.equal((await disabling).state, 'consent-required');
  assert.equal(testFixture.values.get(OWNER_STORAGE_KEY), JSON.stringify(newerOwner));
  assert.equal(JSON.parse(testFixture.values.get(PENDING_CLEANUP_STORAGE_KEY)!).owner.accountId, userB.accountId);
});
