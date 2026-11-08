import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAccountBinding,
  ConnectionGeneration,
  matchesLiveCacheOwner,
  persistAccountBinding,
  shouldRefreshAfterHydration,
  shouldRefreshOnResume,
} from '../state/connectionGeneration';

const normalize = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();

test('late account response is discarded after connection generation changes', async () => {
  const generation = new ConnectionGeneration();
  const requestGeneration = generation.capture();
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const guarded = generation.resolve(requestGeneration, pending);

  generation.advance();
  finish('previous account state');
  assert.equal(await guarded, null, 'stale result cannot update the new account');
});

test('cached state hydrates only for the same origin and account owner', () => {
  const cache = { baseUrl: 'https://pilot.example/', ownerId: 'EMP-01' };
  assert.equal(matchesLiveCacheOwner(cache, 'https://pilot.example', 'EMP-01', normalize), true);
  assert.equal(matchesLiveCacheOwner(cache, 'https://pilot.example', 'EMP-02', normalize), false);
  assert.equal(matchesLiveCacheOwner(cache, 'https://other.example', 'EMP-01', normalize), false);
  assert.equal(matchesLiveCacheOwner(cache, 'https://pilot.example', null, normalize), false);
});

test('foreground reconciliation runs only when returning to active', () => {
  assert.equal(shouldRefreshOnResume('background', 'active'), true);
  assert.equal(shouldRefreshOnResume('inactive', 'active'), true);
  assert.equal(shouldRefreshOnResume('active', 'active'), false);
  assert.equal(shouldRefreshOnResume('background', 'inactive'), false);
});

test('connected hydration refreshes cached or missing state once per connection', () => {
  const base = { hydrated: true, mode: 'CONNECTED' as const, token: 'session-token', generation: 4 };
  assert.equal(shouldRefreshAfterHydration({ ...base, attemptedGeneration: null }), true);
  assert.equal(shouldRefreshAfterHydration({ ...base, attemptedGeneration: 4 }), false);
  assert.equal(shouldRefreshAfterHydration({ ...base, hydrated: false, attemptedGeneration: null }), false);
  assert.equal(shouldRefreshAfterHydration({ ...base, token: null, attemptedGeneration: null }), false);
});

test('in-flight login storage cannot resurrect credentials after serialized logout', async () => {
  const coordinator = new ConnectionGeneration();
  const persisted = { baseUrl: '', token: null as string | null, ownerId: null as string | null, cacheOwner: null as string | null };
  let releaseTokenWrite!: () => void;
  const tokenWriteBlocked = new Promise<void>((resolve) => { releaseTokenWrite = resolve; });
  let firstTokenWrite = true;
  const writers = {
    saveBaseUrl: async (value: string) => { persisted.baseUrl = value; },
    saveToken: async (value: string | null) => {
      if (value && firstTokenWrite) {
        firstTokenWrite = false;
        await tokenWriteBlocked;
      }
      persisted.token = value;
    },
    saveOwnerId: async (value: string | null) => { persisted.ownerId = value; },
    clearLiveCache: async () => { persisted.cacheOwner = null; },
  };

  const loginGeneration = coordinator.advance();
  const pendingLogin = persistAccountBinding(
    coordinator,
    loginGeneration,
    { baseUrl: 'https://old.example', token: 'old-token', ownerId: 'EMP-OLD' },
    writers,
    async () => { persisted.cacheOwner = 'EMP-OLD'; }
  );
  await Promise.resolve();
  const logoutGeneration = coordinator.advance();
  const pendingLogout = clearAccountBinding(coordinator, logoutGeneration, writers);
  releaseTokenWrite();
  await Promise.all([pendingLogin, pendingLogout]);

  assert.equal(persisted.token, null);
  assert.equal(persisted.ownerId, null);
  assert.equal(persisted.cacheOwner, null);
});

test('account transition between response and commit blocks the prior state dispatch', async () => {
  const coordinator = new ConnectionGeneration();
  const requestGeneration = coordinator.advance();
  const response = await coordinator.resolve(requestGeneration, Promise.resolve('account A payload'));
  coordinator.advance();
  let committed = false;
  const accepted = coordinator.commit(requestGeneration, () => { committed = true; });
  assert.equal(response, 'account A payload');
  assert.equal(accepted, false);
  assert.equal(committed, false);
});
