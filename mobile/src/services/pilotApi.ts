/**
 * HTTP client for the EXISTING ORR Pulse pilot backend (server.ts).
 *
 * Contract notes (verified against server.ts):
 * - Auth: `Authorization: Bearer <token>`; token comes from POST /api/auth/login.
 * - The server is pilot-only: a JSON-file seeded 10-employee roster with 4-digit
 *   PINs. It is NOT production authentication; the UI labels it accordingly.
 * - All responses are JSON. Monitoring/journey state mirrors the shared types.
 *
 * Error strategy: every failure surfaces as a PilotApiError with a stable code
 * and an actionable message. Callers must NEVER fall back to synthetic demo
 * data when a connected LIVE request fails.
 */
import type {
  ApiQuotaStatus,
  CommuteAlert,
  DataEnvironment,
  DayOverride,
  DirectionSchedule,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
  UserProfile,
} from '../types/shared';
import type { NativePushServerStatus } from './nativePushContract';

export type PilotErrorCode =
  | 'NETWORK'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'INVALID_PIN'
  | 'INVALID_INPUT'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export class PilotApiError extends Error {
  code: PilotErrorCode;
  status: number | null;

  constructor(code: PilotErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'PilotApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ServerClock {
  dateIst: string;
  timeIst: string;
  timeWithSecIst: string;
  dayOfWeek: string;
  iso: string;
}

export interface PilotRosterEntry {
  id: string;
  employeeCode: string;
  name: string;
  role: string;
  corridorTag: string;
  defaultPinHint: string;
}

export interface PilotRosterResponse {
  roster: PilotRosterEntry[];
  serverTimeIst: string;
  dateIst: string;
  liveApiConfigured: boolean;
}

export interface LoginResponse {
  token: string;
  profile: UserProfile;
}

export interface MeStateResponse {
  serverClock: ServerClock;
  profile: UserProfile;
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  quota: ApiQuotaStatus;
}

export interface StartOrRefreshResponse {
  session: MonitoringSession;
  newAlerts: CommuteAlert[];
  effectiveSchedule: DirectionSchedule & { skippedToday: boolean };
  quota: ApiQuotaStatus;
}

export interface SelectOptionResponse {
  session: MonitoringSession;
}

export interface MonitoringActionResponse {
  session: MonitoringSession;
  journey?: JourneyRecord | null;
  profile?: UserProfile;
  alert?: CommuteAlert;
}

export interface UpdateJourneyResponse {
  journey: JourneyRecord;
}

export interface PlacesSearchResponse {
  places: LocationPoint[];
  source: string;
}

export interface ProfileUpdateResponse {
  profile: UserProfile;
}

export interface DeleteResponse {
  message: string;
  profile?: UserProfile;
  journeys?: JourneyRecord[];
  alerts?: CommuteAlert[];
}

export type MonitoringActionName = 'IVE_LEFT' | 'SNOOZE_10M' | 'SKIP_TODAY' | 'STOP_MONITORING';

export type StartMode = 'IMMEDIATE' | 'SCHEDULED_LEAD';

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Bounded timeout so an unreachable/half-open host can never leave the UI pending forever. */
const REQUEST_TIMEOUT_MS = 15_000;

class RequestTimeoutError extends Error {
  constructor() {
    super('Pilot backend request timed out.');
    this.name = 'RequestTimeoutError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout!: (error: RequestTimeoutError) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new RequestTimeoutError());
  }, REQUEST_TIMEOUT_MS);
  const readResponse = async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  };
  try {
    const responsePromise = readResponse();
    void responsePromise.catch(() => undefined);
    return await Promise.race([responsePromise, timeout]);
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function networkHint(baseUrl: string): string {
  return (
    `Could not reach the pilot backend at ${baseUrl}. ` +
    'Check the server is running and the URL is reachable from this device. ' +
    'Android emulator: use http://10.0.2.2:3000 for a server on your computer. ' +
    'Physical device: use your computer Wi-Fi/LAN address, e.g. http://192.168.1.20:3000, and the same network.'
  );
}

async function request<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    token?: string | null;
    body?: unknown;
    acceptedStatuses?: number[];
    expectedStatus?: number;
  } = {}
): Promise<T> {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    throw new PilotApiError('INVALID_INPUT', 'No pilot backend URL configured.');
  }
  const url = `${base}${path}`;
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchWithTimeout(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }));
  } catch (err) {
    const timedOut = err instanceof RequestTimeoutError || (err instanceof Error && err.name === 'AbortError');
    const mutation = options.method !== undefined && options.method !== 'GET';
    throw new PilotApiError(
      'NETWORK',
      timedOut
        ? `The pilot backend at ${base} did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. ` +
            `${mutation ? 'The mutation outcome is unconfirmed. ' : ''}Check the server is running and reachable from this device (Android emulator: http://10.0.2.2:3000; physical device: your computer LAN address).`
        : networkHint(base)
    );
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
    const errObj = (payload ?? {}) as { error?: string; message?: string; quotaExceeded?: boolean };
    let message =
      errObj.message ||
      (response.status === 401
        ? 'Session token rejected by the pilot backend.'
        : `Pilot backend returned HTTP ${response.status} for ${path}.`);
    if (response.status === 401 && !/log in again/i.test(message)) {
      message = `${message} Please log in again from Settings.`;
    }
    let code: PilotErrorCode;
    if (response.status === 401) code = 'UNAUTHORIZED';
    else if (response.status === 403) code = 'INVALID_PIN';
    else if (response.status === 404) code = 'NOT_FOUND';
    else if (response.status === 429 || errObj.quotaExceeded) code = 'QUOTA_EXCEEDED';
    else if (response.status === 502 || errObj.error === 'PROVIDER_ERROR') code = 'PROVIDER_ERROR';
    else if (response.status === 400) code = 'INVALID_INPUT';
    else if (response.status >= 500) code = 'SERVER_ERROR';
    else code = 'UNKNOWN';
    throw new PilotApiError(code, message, response.status);
  }

  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    throw new PilotApiError(
      'SERVER_ERROR',
      `Pilot backend returned HTTP ${response.status}; expected HTTP ${options.expectedStatus} for ${path}.`,
      response.status
    );
  }

  if (payload === null) {
    throw new PilotApiError('SERVER_ERROR', `Pilot backend returned a non-JSON response for ${path}.`, response.status);
  }

  return payload as T;
}

export const pilotApi = {
  normalizeBaseUrl,

  fetchRoster(baseUrl: string): Promise<PilotRosterResponse> {
    return request<PilotRosterResponse>(baseUrl, '/api/auth/pilot-roster');
  },

  login(baseUrl: string, userId: string, pin: string): Promise<LoginResponse> {
    return request<LoginResponse>(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { userId, pin },
    });
  },

  fetchState(baseUrl: string, token: string): Promise<MeStateResponse> {
    return request<MeStateResponse>(baseUrl, '/api/me/state', { token });
  },

  registerDevice(
    baseUrl: string,
    token: string,
    body: { expoPushToken: string; platform: 'ios' | 'android'; installationId: string }
  ): Promise<{ status: 201 }> {
    return request<{ device: unknown }>(baseUrl, '/api/me/devices', {
      method: 'POST',
      token,
      body,
      expectedStatus: 201,
    }).then(() => ({ status: 201 }));
  },

  async getDevices(baseUrl: string, token: string): Promise<Array<{ installationId: string }>> {
    const response = await request<{ devices: Array<{ installationId: string }> }>(baseUrl, '/api/me/devices', { token });
    return response.devices;
  },

  async deleteDevice(baseUrl: string, token: string, installationId: string): Promise<{ status: 200 | 404 }> {
    const response = await request<{ deleted?: boolean; installationId?: string }>(
      baseUrl,
      `/api/me/devices/${encodeURIComponent(installationId)}`,
      { method: 'DELETE', token, acceptedStatuses: [404] }
    );
    return { status: response.deleted ? 200 : 404 };
  },

  getPushStatus(baseUrl: string, token: string): Promise<NativePushServerStatus> {
    return request<NativePushServerStatus>(baseUrl, '/api/me/push-status', { token });
  },

  updateProfile(
    baseUrl: string,
    token: string,
    patch: Partial<
      Pick<
        UserProfile,
        | 'homeLocation'
        | 'workLocation'
        | 'schedules'
        | 'telemetryConsent'
        | 'pushOptIn'
        | 'onboardingComplete'
        | 'dayOverrides'
      >
    >
  ): Promise<ProfileUpdateResponse> {
    return request<ProfileUpdateResponse>(baseUrl, '/api/me/profile', {
      method: 'PUT',
      token,
      body: patch,
    });
  },

  setDayOverride(
    baseUrl: string,
    token: string,
    override: DayOverride
  ): Promise<{ profile: UserProfile; sessions: MonitoringSession[] }> {
    return request(baseUrl, '/api/me/day-override', { method: 'POST', token, body: override });
  },

  searchPlaces(
    baseUrl: string,
    token: string,
    query: string,
    environment: DataEnvironment
  ): Promise<PlacesSearchResponse> {
    return request<PlacesSearchResponse>(baseUrl, '/api/places/search', {
      method: 'POST',
      token,
      body: { query, environment },
    });
  },

  startOrRefreshMonitoring(
    baseUrl: string,
    token: string,
    params: {
      direction: 'HOME_TO_WORK' | 'WORK_TO_HOME';
      environment: DataEnvironment;
      startMode?: StartMode;
      watchMode?: 'ALL_OPTIONS' | 'SELECTED_OPTION';
      selectedOptionId?: string | null;
    }
  ): Promise<StartOrRefreshResponse> {
    return request<StartOrRefreshResponse>(baseUrl, '/api/monitoring/start-or-refresh', {
      method: 'POST',
      token,
      body: params,
    });
  },

  selectOption(
    baseUrl: string,
    token: string,
    sessionId: string,
    optionId: string,
    watchMode: 'ALL_OPTIONS' | 'SELECTED_OPTION' = 'SELECTED_OPTION'
  ): Promise<SelectOptionResponse> {
    return request<SelectOptionResponse>(baseUrl, '/api/monitoring/select-option', {
      method: 'POST',
      token,
      body: { sessionId, optionId, watchMode },
    });
  },

  monitoringAction(
    baseUrl: string,
    token: string,
    sessionId: string,
    action: MonitoringActionName
  ): Promise<MonitoringActionResponse> {
    return request<MonitoringActionResponse>(baseUrl, '/api/monitoring/action', {
      method: 'POST',
      token,
      body: { sessionId, action },
    });
  },

  updateJourney(
    baseUrl: string,
    token: string,
    journeyId: string,
    patch: {
      actualDepartureHhmm?: string;
      actualArrivalHhmm?: string;
      changedPlanOrRoute?: boolean;
      usefulRating?: 'YES' | 'SOMEWHAT' | 'NO' | null;
      feedbackNote?: string;
    }
  ): Promise<UpdateJourneyResponse> {
    return request<UpdateJourneyResponse>(baseUrl, `/api/journeys/${journeyId}`, {
      method: 'PUT',
      token,
      body: patch,
    });
  },

  deleteLocations(baseUrl: string, token: string): Promise<DeleteResponse> {
    return request<DeleteResponse>(baseUrl, '/api/me/locations', { method: 'DELETE', token });
  },

  deleteJourneys(baseUrl: string, token: string): Promise<DeleteResponse> {
    return request<DeleteResponse>(baseUrl, '/api/me/journeys', { method: 'DELETE', token });
  },
};
