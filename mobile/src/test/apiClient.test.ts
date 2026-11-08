import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PilotApiError, pilotApi } from '../services/pilotApi';

const BASE = 'http://10.0.2.2:3000';

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('network failure maps to NETWORK with actionable emulator/LAN guidance', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('Network request failed');
  }) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.fetchRoster(BASE),
    (err: unknown) => {
      assert.ok(err instanceof PilotApiError);
      assert.equal(err.code, 'NETWORK');
      assert.match(err.message, /10\.0\.2\.2/);
      assert.match(err.message, /192\.168/);
      assert.match(err.message, new RegExp(BASE.replace(/[.]/g, '\\.')));
      return true;
    }
  );
});

test('request aborts after the bounded timeout and reports it distinctly', async () => {
  globalThis.fetch = (async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.fetchState(BASE, 'token_x'),
    (err: unknown) => {
      assert.ok(err instanceof PilotApiError);
      assert.equal(err.code, 'NETWORK');
      assert.match(err.message, /did not respond within \d+ seconds/);
      return true;
    }
  );
});

test('201 headers do not stop the timeout while the response body is stalled', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('body read aborted')), { once: true });
      },
    });
    return new Response(body as never, { status: 201 });
  }) as unknown as FetchMock;
  const pending = pilotApi.registerDevice(BASE, 'token', {
    expoPushToken: 'ExpoPushToken[x]', platform: 'ios', installationId: 'install-a',
  });
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(15_000);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof PilotApiError);
    assert.equal(error.code, 'NETWORK');
    assert.match(error.message, /outcome is unconfirmed/i);
    return true;
  });
  assert.equal(signal?.aborted, true);
});

test('response body read failures map to NETWORK', async () => {
  globalThis.fetch = (async () => {
    const response = jsonResponse(200, {});
    response.text = async () => { throw new Error('stream failed'); };
    return response;
  }) as unknown as FetchMock;
  await assert.rejects(pilotApi.fetchRoster(BASE), (error: unknown) => {
    assert.ok(error instanceof PilotApiError);
    assert.equal(error.code, 'NETWORK');
    return true;
  });
});

test('401 maps to UNAUTHORIZED with a re-login message', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(401, { error: 'UNAUTHORIZED', message: 'Valid employee session token required.' });
  }) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.fetchState(BASE, 'token_stale'),
    (err: unknown) => {
      assert.ok(err instanceof PilotApiError);
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.match(err.message, /log in again/i);
      assert.equal((err as PilotApiError).status, 401);
      return true;
    }
  );
  assert.equal(calls[0].init?.headers ? (calls[0].init?.headers as Record<string, string>)['Authorization'] : undefined, 'Bearer token_stale');
});

test('429 and quotaExceeded flag map to QUOTA_EXCEEDED', async () => {
  globalThis.fetch = (async () =>
    jsonResponse(429, { quotaExceeded: true, error: 'RESOURCE_EXCEEDED', message: 'Pilot daily API budget safeguard reached (500 requests/day).' })
  ) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.startOrRefreshMonitoring(BASE, 't', {
      direction: 'HOME_TO_WORK',
      environment: 'LIVE',
    }),
    (err: unknown) => {
      assert.ok(err instanceof PilotApiError);
      assert.equal(err.code, 'QUOTA_EXCEEDED');
      return true;
    }
  );
});

test('403 invalid pin maps to INVALID_PIN; 502 provider error keeps its message', async () => {
  globalThis.fetch = (async () => jsonResponse(403, { error: 'INVALID_PIN', message: 'Invalid 4-digit employee PIN.' })) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.login(BASE, 'emp_01', '0000'),
    (err: unknown) => {
      assert.equal((err as PilotApiError).code, 'INVALID_PIN');
      return true;
    }
  );

  globalThis.fetch = (async () =>
    jsonResponse(502, { error: 'PROVIDER_ERROR', message: 'Google Maps Platform API key is not configured on the server.' })
  ) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.searchPlaces(BASE, 't', 'q', 'LIVE'),
    (err: unknown) => {
      assert.equal((err as PilotApiError).code, 'PROVIDER_ERROR');
      assert.match((err as PilotApiError).message, /API key is not configured/);
      return true;
    }
  );
});

test('non-JSON 200 maps to SERVER_ERROR; empty base URL is INVALID_INPUT', async () => {
  globalThis.fetch = (async () => new Response('<html>gateway</html>', { status: 200 })) as unknown as FetchMock;
  await assert.rejects(
    pilotApi.fetchRoster(BASE),
    (err: unknown) => {
      assert.equal((err as PilotApiError).code, 'SERVER_ERROR');
      return true;
    }
  );
  await assert.rejects(
    pilotApi.fetchRoster('   '),
    (err: unknown) => {
      assert.equal((err as PilotApiError).code, 'INVALID_INPUT');
      return true;
    }
  );
});

test('push API requires HTTP 201, treats device deletion 404 as idempotent, and unwraps scoped status', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let registrationCount = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/me/devices/install-a')) return jsonResponse(404, { error: 'DEVICE_NOT_FOUND' });
    if (String(url).endsWith('/api/me/devices') && init?.method !== 'POST') return jsonResponse(200, { devices: [{ installationId: 'install-a' }] });
    if (String(url).endsWith('/api/me/devices') && init?.method === 'POST') {
      registrationCount += 1;
      return registrationCount === 1
        ? jsonResponse(201, { device: { installationId: 'install-a', platform: 'ios', createdAt: '2026-11-08T10:00:00.000Z' } })
        : registrationCount === 2
          ? jsonResponse(200, { device: { installationId: 'install-a' } })
          : jsonResponse(401, { error: 'UNAUTHORIZED', message: 'Session token rejected.' });
    }
    if (String(url).endsWith('/api/me/push-status')) return jsonResponse(200, {
      nativePushEnabled: false,
      registeredDevices: 1,
      outbox: { transportEnabled: false, pending: 0, sent: 0, failed: 0, skipped: 0, receiptPending: 0, receiptOk: 0, receiptError: 0 },
      deliveryDisclaimer: 'Accepted is not delivered.',
    });
    return jsonResponse(500, { error: 'UNEXPECTED_REQUEST' });
  }) as unknown as FetchMock;
  assert.deepEqual(
    await pilotApi.registerDevice(BASE, 'owner-token', { expoPushToken: 'ExpoPushToken[x]', platform: 'ios', installationId: 'install-a' }),
    { status: 201 },
    'backend { device: ... } body is normalized after the actual HTTP status is checked'
  );
  await assert.rejects(
    pilotApi.registerDevice(BASE, 'owner-token', { expoPushToken: 'ExpoPushToken[x]', platform: 'ios', installationId: 'install-a' }),
    (error: unknown) => (error as PilotApiError).status === 200
  );
  await assert.rejects(
    pilotApi.registerDevice(BASE, 'owner-token', { expoPushToken: 'ExpoPushToken[x]', platform: 'ios', installationId: 'install-a' }),
    (error: unknown) => (error as PilotApiError).code === 'UNAUTHORIZED'
  );
  assert.deepEqual(await pilotApi.deleteDevice(BASE, 'owner-token', 'install-a'), { status: 404 });
  assert.deepEqual(await pilotApi.getDevices(BASE, 'owner-token'), [{ installationId: 'install-a' }]);
  assert.equal((await pilotApi.getPushStatus(BASE, 'owner-token')).nativePushEnabled, false);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer owner-token');
});

test('login and monitoring happy paths parse the exact server contract shapes', async () => {
  const profile = {
    id: 'emp_01',
    employeeCode: 'PTP-01',
    name: 'Aarav Rao',
    role: 'Staff Platform Engineer',
    corridorTag: 'tag',
    onboardingComplete: true,
    telemetryConsent: true,
    pushOptIn: false,
    homeLocation: null,
    workLocation: { label: 'PTP', address: 'a', lat: 12.94, lng: 77.69, confirmedAt: '2026-11-01T00:00:00.000Z' },
    schedules: {
      HOME_TO_WORK: { direction: 'HOME_TO_WORK', enabled: true, mode: 'CAR', days: ['MON'], windowStart: '08:00', windowEnd: '09:15', arrivalDeadline: '09:45', preferredDeparture: '08:30', safetyBufferMinutes: 10, leadTimeMinutes: 15, alertThresholdMinutes: 5 },
      WORK_TO_HOME: { direction: 'WORK_TO_HOME', enabled: true, mode: 'CAR', days: ['MON'], windowStart: '17:30', windowEnd: '19:00', arrivalDeadline: null, preferredDeparture: '18:00', safetyBufferMinutes: 10, leadTimeMinutes: 15, alertThresholdMinutes: 5 },
    },
    dayOverrides: [],
  };

  const session = {
    id: 'mon_emp_01_2026-11-09_HOME_TO_WORK',
    userId: 'emp_01',
    dateIst: '2026-11-09',
    direction: 'HOME_TO_WORK',
    transportMode: 'CAR',
    status: 'ACTIVE',
    watchMode: 'ALL_OPTIONS',
    selectedOptionId: null,
    selectedEstimateSnapshot: null,
    departureEstimateSnapshot: null,
    lastNotifiedArrivalIso: null,
    lastNotifiedArrivalTimeIst: null,
    snoozedUntilIso: null,
    startedAtIso: T_NOW,
    lastRefreshedAtIso: T_NOW,
    nextRefreshDueIso: T_NOW,
    expiresAtIso: T_NOW,
    refreshCount: 0,
    suppressedDuplicatesCount: 0,
    latestOptions: [],
    unsupportedModeReason: null,
    dataEnvironment: 'DEMO',
  };

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(_url).endsWith('/api/auth/login')) {
      assert.deepEqual(body, { userId: 'PTP-01', pin: '1001' });
      return jsonResponse(200, { token: 'token_emp_01_pilot', profile });
    }
    if (String(_url).endsWith('/api/monitoring/start-or-refresh')) {
      assert.equal(body.environment, 'DEMO');
      return jsonResponse(200, {
        session,
        newAlerts: [],
        effectiveSchedule: { ...profile.schedules.HOME_TO_WORK, skippedToday: false },
        quota: { dateIst: '2026-11-09', dailyLimit: 500, requestsUsedToday: 1, routesRequests: 1, placesRequests: 0, geocodingRequests: 0, lastProviderStatus: 'UNCONFIGURED', lastErrorMessage: null, liveApiConfigured: false },
      });
    }
    throw new Error(`unexpected url ${_url}`);
  }) as unknown as FetchMock;

  const login = await pilotApi.login(BASE, 'PTP-01', '1001');
  assert.equal(login.token, 'token_emp_01_pilot');
  assert.equal(login.profile.schedules.HOME_TO_WORK.windowStart, '08:00');

  const start = await pilotApi.startOrRefreshMonitoring(BASE, 'token_emp_01_pilot', {
    direction: 'HOME_TO_WORK',
    environment: 'DEMO',
    startMode: 'IMMEDIATE',
    watchMode: 'ALL_OPTIONS',
  });
  assert.equal(start.session.id, session.id);
  assert.equal(start.quota.liveApiConfigured, false);
  assert.equal(start.effectiveSchedule.skippedToday, false);
});

const T_NOW = '2026-11-09T03:00:00.000Z';

test('base URL normalization strips trailing slashes before joining paths', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return jsonResponse(200, { roster: [] });
  }) as unknown as FetchMock;
  await pilotApi.fetchRoster('http://10.0.2.2:3000///');
  assert.equal(seen[0], 'http://10.0.2.2:3000/api/auth/pilot-roster');
});
