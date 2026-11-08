/**
 * Global app store: React context wrapping two data sources.
 *
 * - mode DEMO: fully local state via demoReducer (works offline, clearly labeled).
 * - mode CONNECTED: the existing pilot backend via pilotApi. LIVE data requests
 *   are only allowed when the backend reports quota.liveApiConfigured === true
 *   AND the user explicitly selected LIVE data; otherwise the connected mode
 *   runs the backend's labeled DEMO environment. Failures surface as errors —
 *   the store never substitutes synthetic data for a failed LIVE call.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AppState as NativeAppState } from 'react-native';
import type {
  ApiQuotaStatus,
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DayOverride,
  JourneyRecord,
  MonitoringSession,
  UserProfile,
} from '../types/shared';
import {
  LoginResponse,
  MeStateResponse,
  PilotApiError,
  PilotRosterResponse,
  ServerClock,
  pilotApi,
} from '../services/pilotApi';
import {
  clearLiveCache,
  loadBaseUrl,
  loadDemoState,
  loadLiveCache,
  loadMode,
  loadToken,
  saveBaseUrl,
  saveDemoState,
  saveLiveCache,
  saveMode,
  saveToken,
  loadOwnerId,
  saveOwnerId,
} from '../services/storage';
import { createDemoReducer, demoReducer, DemoAction, DemoState, rehydrateDemoState } from './demoReducer';
import { getNowIstParts } from '../services/demoEngine';
import { clearAccountBinding, ConnectionGeneration, matchesLiveCacheOwner, persistAccountBinding, shouldRefreshAfterHydration, shouldRefreshOnResume } from './connectionGeneration';
import { validateBaseUrl } from '../validation/validate';
import { createExpoNativePushCoordinator, subscribeToExpoPushEvents } from '../services/nativePushExpo';
import type { NativePushAccount, NativePushResult } from '../services/nativePushContract';

const normalizeOrigin = (raw: string): string => raw.trim().replace(/\/+$/, '');

interface ConnectionState {
  baseUrl: string;
  token: string | null;
  loggedIn: boolean;
  roster: PilotRosterResponse | null;
  liveApiConfigured: boolean | null;
}

interface LiveState {
  serverClock: ServerClock | null;
  profile: UserProfile | null;
  sessions: MonitoringSession[];
  alerts: CommuteAlert[];
  journeys: JourneyRecord[];
  quota: ApiQuotaStatus | null;
}

interface AppState {
  mode: 'DEMO' | 'CONNECTED';
  hydrated: boolean;
  demo: DemoState;
  connection: ConnectionState;
  live: LiveState;
  liveLoading: boolean;
  liveError: string | null;
  /** Data environment used for connected monitoring requests. */
  liveDataEnvironment: DataEnvironment;
  liveCacheUpdatedAt: number | null;
}

type AppAction =
  | {
      type: 'HYDRATED';
      mode: 'DEMO' | 'CONNECTED';
      baseUrl: string;
      token: string | null;
      demo: DemoState;
      live: LiveState;
      cacheUpdatedAt: number | null;
    }
  | { type: 'SET_MODE'; mode: 'DEMO' | 'CONNECTED' }
  | { type: 'SET_BASE_URL'; baseUrl: string }
  | { type: 'ROSTER_LOADED'; roster: PilotRosterResponse }
  | { type: 'LOGIN'; baseUrl: string; token: string; state: MeStateResponse }
  | { type: 'LOGOUT' }
  | { type: 'LIVE_FULL_STATE'; state: MeStateResponse }
  | { type: 'LIVE_PATCH'; patch: Partial<LiveState> }
  | { type: 'LIVE_SESSION'; session: MonitoringSession; newAlerts?: CommuteAlert[] }
  | { type: 'LIVE_ERROR'; message: string | null }
  | { type: 'LIVE_LOADING'; loading: boolean }
  | { type: 'LIVE_DATA_ENVIRONMENT'; environment: DataEnvironment }
  | { type: 'DEMO_ACTION'; action: DemoAction };

function emptyLive(): LiveState {
  return {
    serverClock: null,
    profile: null,
    sessions: [],
    alerts: [],
    journeys: [],
    quota: null,
  };
}

function initialState(): AppState {
  return {
    mode: 'DEMO',
    hydrated: false,
    demo: createDemoReducer(new Date().toISOString()),
    connection: { baseUrl: '', token: null, loggedIn: false, roster: null, liveApiConfigured: null },
    live: emptyLive(),
    liveLoading: false,
    liveError: null,
    liveDataEnvironment: 'DEMO',
    liveCacheUpdatedAt: null,
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'HYDRATED':
      return {
        ...state,
        hydrated: true,
        mode: action.mode,
        connection: {
          ...state.connection,
          baseUrl: action.baseUrl,
          token: action.token,
          loggedIn: action.token !== null,
        },
        demo: action.demo,
        live: action.live,
        liveCacheUpdatedAt: action.cacheUpdatedAt,
      };
    case 'SET_MODE':
      return { ...state, mode: action.mode, liveError: null };
    case 'SET_BASE_URL':
      return { ...state, connection: { ...state.connection, baseUrl: action.baseUrl } };
    case 'ROSTER_LOADED':
      return {
        ...state,
        connection: {
          ...state.connection,
          roster: action.roster,
          liveApiConfigured: action.roster.liveApiConfigured,
        },
      };
    case 'LOGIN':
      return {
        ...state,
        mode: 'CONNECTED',
        connection: { ...state.connection, baseUrl: action.baseUrl, token: action.token, loggedIn: true },
        live: {
          serverClock: action.state.serverClock,
          profile: action.state.profile,
          sessions: action.state.sessions,
          alerts: action.state.alerts,
          journeys: action.state.journeys,
          quota: action.state.quota,
        },
        liveError: null,
        liveLoading: false,
        liveCacheUpdatedAt: Date.now(),
      };
    case 'LOGOUT':
      return {
        ...state,
        connection: { ...state.connection, token: null, loggedIn: false, roster: null },
        live: emptyLive(),
        liveError: null,
        liveLoading: false,
        liveDataEnvironment: 'DEMO',
        liveCacheUpdatedAt: null,
      };
    case 'LIVE_FULL_STATE':
      return {
        ...state,
        live: {
          serverClock: action.state.serverClock,
          profile: action.state.profile,
          sessions: action.state.sessions,
          alerts: action.state.alerts,
          journeys: action.state.journeys,
          quota: action.state.quota,
        },
        liveError: null,
        liveCacheUpdatedAt: Date.now(),
      };
    case 'LIVE_PATCH':
      return { ...state, live: { ...state.live, ...action.patch }, liveError: null, liveCacheUpdatedAt: Date.now() };
    case 'LIVE_SESSION': {
      const exists = state.live.sessions.some((s) => s.id === action.session.id);
      return {
        ...state,
        live: {
          ...state.live,
          sessions: exists
            ? state.live.sessions.map((s) => (s.id === action.session.id ? action.session : s))
            : [...state.live.sessions, action.session],
          alerts: action.newAlerts?.length
            ? [...action.newAlerts, ...state.live.alerts].slice(0, 60)
            : state.live.alerts,
        },
        liveError: null,
        liveCacheUpdatedAt: Date.now(),
      };
    }
    case 'LIVE_ERROR':
      return { ...state, liveError: action.message };
    case 'LIVE_LOADING':
      return { ...state, liveLoading: action.loading };
    case 'LIVE_DATA_ENVIRONMENT':
      return { ...state, liveDataEnvironment: action.environment };
    case 'DEMO_ACTION':
      return { ...state, demo: demoReducer(state.demo, action.action) };
    default:
      return state;
  }
}

export interface AppApi {
  state: AppState;
  setMode: (mode: 'DEMO' | 'CONNECTED') => void;
  setBaseUrl: (url: string) => void;
  fetchRoster: (baseUrlOverride?: string) => Promise<PilotRosterResponse>;
  login: (userId: string, pin: string, baseUrlOverride?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshLiveState: () => Promise<void>;
  setLiveDataEnvironment: (env: DataEnvironment) => void;
  startLiveMonitoring: (params: {
    direction: CommuteDirection;
    startMode: 'IMMEDIATE' | 'SCHEDULED_LEAD';
    watchMode: 'ALL_OPTIONS' | 'SELECTED_OPTION';
    selectedOptionId?: string | null;
  }) => Promise<void>;
  liveSelectOption: (sessionId: string, optionId: string) => Promise<void>;
  liveMonitoringAction: (
    sessionId: string,
    action: 'IVE_LEFT' | 'SNOOZE_10M' | 'SKIP_TODAY' | 'STOP_MONITORING'
  ) => Promise<void>;
  liveUpdateProfile: (patch: Parameters<typeof pilotApi.updateProfile>[2]) => Promise<void>;
  liveDayOverride: (override: DayOverride) => Promise<void>;
  liveCorrectJourney: (
    journeyId: string,
    patch: Parameters<typeof pilotApi.updateJourney>[3]
  ) => Promise<void>;
  liveDeleteLocations: () => Promise<void>;
  liveDeleteJourneys: () => Promise<void>;
  nativePushStatus: NativePushResult | null;
  nativePushBusy: boolean;
  enableNativePush: () => Promise<NativePushResult>;
  disableNativePush: () => Promise<NativePushResult>;
  refreshNativePushStatus: () => Promise<NativePushResult | null>;
  retryNativePushCleanup: () => Promise<NativePushResult>;
  demoDispatch: (action: DemoAction) => void;
}

const AppContext = createContext<AppApi | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const connectionGeneration = useRef(new ConnectionGeneration()).current;
  const nativePushCoordinator = useRef<Promise<import('../services/nativePush').NativePushCoordinator> | null>(null);
  const nativePushCoordinatorInstance = useRef<import('../services/nativePush').NativePushCoordinator | null>(null);
  const nativePushOperationGeneration = useRef(0);
  const [nativePushStatus, setNativePushStatus] = useState<NativePushResult | null>(null);
  const [nativePushBusy, setNativePushBusy] = useState(false);

  const invalidateNativePushOperation = useCallback(() => {
    ++nativePushOperationGeneration.current;
    setNativePushBusy(false);
    setNativePushStatus(null);
    return nativePushOperationGeneration.current;
  }, []);

  const getNativePushCoordinator = useCallback(() => {
    if (!nativePushCoordinator.current) {
      nativePushCoordinator.current = createExpoNativePushCoordinator().then((coordinator) => {
        nativePushCoordinatorInstance.current = coordinator;
        return coordinator;
      });
    }
    return nativePushCoordinator.current;
  }, []);

  const accountFor = useCallback((connection: ConnectionState, profile: UserProfile | null): NativePushAccount | null => {
    if (!connection.token || !connection.baseUrl || !profile?.employeeCode) return null;
    return { accountId: profile.employeeCode, bearerToken: connection.token, apiOrigin: normalizeOrigin(connection.baseUrl) };
  }, []);

  const persistCurrentCache = useCallback((snapshot: AppState, generation: number) => {
    const profile = snapshot.live.profile;
    if (!profile || !snapshot.connection.token || !connectionGeneration.isCurrent(generation)) return;
    const cache = {
      baseUrl: snapshot.connection.baseUrl,
      ownerId: profile.employeeCode,
      profile,
      serverClock: snapshot.live.serverClock,
      sessions: snapshot.live.sessions,
      alerts: snapshot.live.alerts,
      journeys: snapshot.live.journeys,
      quota: snapshot.live.quota,
      savedAt: Date.now(),
    };
    void connectionGeneration.enqueueWrites(generation, [
      () => saveOwnerId(profile.employeeCode),
      () => saveLiveCache(cache),
    ]);
  }, [connectionGeneration]);

  // ---- Hydration ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const nowIso = new Date().toISOString();
      const [baseUrl, token, ownerId, mode, demoPersisted, liveCache] = await Promise.all([
        loadBaseUrl(),
        loadToken(),
        loadOwnerId(),
        loadMode(),
        loadDemoState(),
        loadLiveCache(),
      ]);
      if (cancelled) return;
      const demo = rehydrateDemoState(demoPersisted, nowIso);
      const initialBaseUrl =
        baseUrl ||
        (typeof process.env.EXPO_PUBLIC_API_BASE_URL === 'string'
          ? process.env.EXPO_PUBLIC_API_BASE_URL
          : '');
      // Cached live rows are scoped to one origin + account: only reuse them
      // when the cached origin matches the configured base URL.
      const cacheMatches = token && matchesLiveCacheOwner(liveCache, initialBaseUrl, ownerId, normalizeOrigin);
      const live: LiveState =
        cacheMatches && liveCache
          ? {
              serverClock: (liveCache.serverClock as ServerClock) ?? null,
              profile: (liveCache.profile as UserProfile) ?? null,
              sessions: (liveCache.sessions as MonitoringSession[]) ?? [],
              alerts: (liveCache.alerts as CommuteAlert[]) ?? [],
              journeys: (liveCache.journeys as JourneyRecord[]) ?? [],
              quota: (liveCache.quota as ApiQuotaStatus) ?? null,
            }
          : emptyLive();
      dispatch({
        type: 'HYDRATED',
        mode: mode === 'CONNECTED' && token ? 'CONNECTED' : 'DEMO',
        baseUrl: initialBaseUrl,
        token,
        demo,
        live,
        cacheUpdatedAt: cacheMatches ? (liveCache?.savedAt ?? null) : null,
      });
      if (token && ownerId && !cacheMatches) void clearLiveCache();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Demo persistence + IST-day rollover while the app is open ----
  useEffect(() => {
    if (!state.hydrated) return;
    saveDemoState(state.demo);
  }, [state.demo, state.hydrated]);

  useEffect(() => {
    if (!state.hydrated) return;
    saveMode(state.mode);
  }, [state.mode, state.hydrated]);

  useEffect(() => {
    if (!state.hydrated || state.mode !== 'CONNECTED' || !state.connection.token || !state.live.profile) return;
    persistCurrentCache(state, connectionGeneration.capture());
  }, [state.hydrated, state.mode, state.connection.token, state.connection.baseUrl, state.live, persistCurrentCache, connectionGeneration]);

  useEffect(() => {
    if (!state.hydrated) return;
    const tick = () => {
      const { dateIst } = getNowIstParts(new Date());
      if (dateIst !== stateRef.current.demo.anchoredDateIst) {
        dispatch({
          type: 'DEMO_ACTION',
          action: { type: 'ROLLOVER_IF_NEW_DAY', nowIso: new Date().toISOString() },
        });
      }
      dispatch({ type: 'DEMO_ACTION', action: { type: 'REFRESH_ACTIVE_SESSIONS', nowIso: new Date().toISOString() } });
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [state.hydrated]);

  const setMode = useCallback((mode: 'DEMO' | 'CONNECTED') => {
    dispatch({ type: 'SET_MODE', mode });
  }, []);

  const setBaseUrl = useCallback(
    (url: string) => {
      const prev = stateRef.current.connection.baseUrl;
      if (normalizeOrigin(prev) === normalizeOrigin(url)) {
        dispatch({ type: 'SET_BASE_URL', baseUrl: url });
        void connectionGeneration.enqueueWrites(connectionGeneration.capture(), [() => saveBaseUrl(url)]);
        return;
      }
      const previousAccount = accountFor(stateRef.current.connection, stateRef.current.live.profile);
      const operation = invalidateNativePushOperation();
      nativePushCoordinatorInstance.current?.invalidateInFlight();
      const generation = connectionGeneration.advance();
      if (previousAccount) {
        void getNativePushCoordinator()
          .then((coordinator) => coordinator.disable(previousAccount))
          .then((status) => {
            if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(generation)) {
              setNativePushStatus(status);
            }
          })
          .catch(() => undefined);
      }
      // Different origin: the stored token and every cached live row belong to
      // the old server. Log out and drop the cache instead of reusing them.
      dispatch({ type: 'LOGOUT' });
      dispatch({ type: 'SET_BASE_URL', baseUrl: url });
      void clearAccountBinding(connectionGeneration, generation, { saveBaseUrl, saveToken, saveOwnerId, clearLiveCache }, url);
    },
    [connectionGeneration, accountFor, getNativePushCoordinator, invalidateNativePushOperation]
  );

  const runLive = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    const generation = connectionGeneration.capture();
    if (!stateRef.current.connection.token) return null;
    dispatch({ type: 'LIVE_LOADING', loading: true });
    dispatch({ type: 'LIVE_ERROR', message: null });
    try {
      const result = await connectionGeneration.resolve(generation, fn());
      if (result === null) return null;
      connectionGeneration.commit(generation, () => dispatch({ type: 'LIVE_LOADING', loading: false }));
      return result;
    } catch (err) {
      if (!connectionGeneration.isCurrent(generation)) return null;
      const message =
        err instanceof PilotApiError ? err.message : 'Unexpected error talking to the pilot backend.';
      connectionGeneration.commit(generation, () => {
        dispatch({ type: 'LIVE_LOADING', loading: false });
        dispatch({ type: 'LIVE_ERROR', message });
      });
      throw err instanceof Error ? err : new Error(message);
    }
  }, [connectionGeneration]);

  const refreshLiveState = useCallback(async () => {
    const generation = connectionGeneration.capture();
    const s = stateRef.current;
    if (!s.connection.token || !s.connection.baseUrl) return;
    // A state refresh must never restart stopped/skipped sessions; GET /api/me/state is read-only.
    const result = await runLive(() =>
      pilotApi.fetchState(s.connection.baseUrl, s.connection.token!)
    );
    if (result) {
      connectionGeneration.commit(generation, () => dispatch({ type: 'LIVE_FULL_STATE', state: result }));
    }
  }, [runLive, connectionGeneration]);

  const initialStateRefreshGeneration = useRef<number | null>(null);
  useEffect(() => {
    const generation = connectionGeneration.capture();
    if (!shouldRefreshAfterHydration({
      hydrated: state.hydrated,
      mode: state.mode,
      token: state.connection.token,
      generation,
      attemptedGeneration: initialStateRefreshGeneration.current,
    })) return;
    initialStateRefreshGeneration.current = generation;
    void refreshLiveState().catch(() => undefined);
  }, [
    state.hydrated,
    state.mode,
    state.connection.token,
    refreshLiveState,
    connectionGeneration,
  ]);

  useEffect(() => {
    if (!state.hydrated) return;
    // AppState.currentState is nullable under the SDK 58 strict types before the
    // first state event; a null/unknown prior state must count as "not active".
    let previous = NativeAppState.currentState ?? 'unknown';
    let lastRefreshAt = 0;
    const reconcile = () => {
      const nowIso = new Date().toISOString();
      if (stateRef.current.mode === 'DEMO') {
        dispatch({ type: 'DEMO_ACTION', action: { type: 'ROLLOVER_IF_NEW_DAY', nowIso } });
        dispatch({ type: 'DEMO_ACTION', action: { type: 'REFRESH_ACTIVE_SESSIONS', nowIso } });
      } else if (Date.now() - lastRefreshAt >= 5 * 60_000) {
        lastRefreshAt = Date.now();
        void refreshLiveState().catch(() => undefined);
      }
    };
    const subscription = NativeAppState.addEventListener('change', (next) => {
      if (shouldRefreshOnResume(previous, next)) reconcile();
      previous = next;
    });
    const timer = setInterval(() => {
      if (NativeAppState.currentState === 'active') reconcile();
    }, 60_000);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [state.hydrated, refreshLiveState]);

  const fetchRoster = useCallback(async (baseUrlOverride?: string) => {
    const generation = connectionGeneration.capture();
    const baseUrl = baseUrlOverride ?? stateRef.current.connection.baseUrl;
    const roster = await pilotApi.fetchRoster(baseUrl);
    connectionGeneration.commit(generation, () => dispatch({ type: 'ROSTER_LOADED', roster }));
    return roster;
  }, [connectionGeneration]);

  const login = useCallback(async (userId: string, pin: string, baseUrlOverride?: string) => {
    const baseUrl = normalizeOrigin(baseUrlOverride ?? stateRef.current.connection.baseUrl);
    const validationError = validateBaseUrl(baseUrl);
    if (validationError) throw new Error(validationError);
    const previousConnection = stateRef.current.connection;
    const previousProfile = stateRef.current.live.profile;
    const previousAccount = accountFor(previousConnection, previousProfile);
    invalidateNativePushOperation();
    nativePushCoordinatorInstance.current?.invalidateInFlight();
    const generation = connectionGeneration.advance();
    const loginResp: LoginResponse = await pilotApi.login(baseUrl, userId, pin);
    if (!connectionGeneration.isCurrent(generation)) return;
    const meState = await pilotApi.fetchState(baseUrl, loginResp.token);
    if (!connectionGeneration.isCurrent(generation)) return;
    const accountChanged = previousAccount && (
      previousAccount.apiOrigin !== baseUrl || previousAccount.accountId !== meState.profile.employeeCode
    );
    if (accountChanged) {
      try {
        const coordinator = await getNativePushCoordinator();
        const cleanup = await coordinator.disable(previousAccount);
        if (!connectionGeneration.commit(generation, () => setNativePushStatus(cleanup))) return;
      } catch {
        if (!connectionGeneration.commit(generation, () => setNativePushStatus({
          state: 'pending-cleanup', installationId: null, permission: 'not-requested',
          registered: false, nativePushEnabled: null, pendingCleanup: true, errorCode: 'cleanup',
        }))) return;
      }
      if (!connectionGeneration.isCurrent(generation)) return;
    }
    if (!connectionGeneration.commit(generation, () => dispatch({ type: 'LOGIN', baseUrl, token: loginResp.token, state: meState }))) return;
    initialStateRefreshGeneration.current = generation;
    await persistAccountBinding(
      connectionGeneration,
      generation,
      { baseUrl, token: loginResp.token, ownerId: meState.profile.employeeCode },
      { saveBaseUrl, saveToken, saveOwnerId, clearLiveCache },
      () => saveLiveCache({ baseUrl, ownerId: meState.profile.employeeCode, savedAt: Date.now(), profile: meState.profile, serverClock: meState.serverClock, sessions: meState.sessions, alerts: meState.alerts, journeys: meState.journeys, quota: meState.quota })
    );
  }, [connectionGeneration, accountFor, getNativePushCoordinator, invalidateNativePushOperation]);

  const logout = useCallback(async () => {
    const previousAccount = accountFor(stateRef.current.connection, stateRef.current.live.profile);
    invalidateNativePushOperation();
    nativePushCoordinatorInstance.current?.invalidateInFlight();
    const generation = connectionGeneration.advance();
    if (previousAccount) {
      try {
        const coordinator = await getNativePushCoordinator();
        const cleanup = await coordinator.disable(previousAccount);
        if (!connectionGeneration.commit(generation, () => setNativePushStatus(cleanup))) return;
      } catch {
        if (!connectionGeneration.commit(generation, () => setNativePushStatus({
          state: 'pending-cleanup', installationId: null, permission: 'not-requested',
          registered: false, nativePushEnabled: null, pendingCleanup: true, errorCode: 'cleanup',
        }))) return;
      }
    }
    if (!connectionGeneration.isCurrent(generation)) return;
    dispatch({ type: 'LOGOUT' });
    dispatch({ type: 'SET_MODE', mode: 'DEMO' });
    await clearAccountBinding(connectionGeneration, generation, { saveBaseUrl, saveToken, saveOwnerId, clearLiveCache });
  }, [connectionGeneration, accountFor, getNativePushCoordinator, invalidateNativePushOperation]);

  const setLiveDataEnvironment = useCallback((env: DataEnvironment) => {
    if (env === 'LIVE') {
      const s = stateRef.current;
      const configured = s.connection.liveApiConfigured ?? s.live.quota?.liveApiConfigured ?? null;
      if (configured === false) {
        dispatch({
          type: 'LIVE_ERROR',
          message:
            'LIVE data is not configured on this pilot backend (no provider API key). Staying on labeled DEMO data.',
        });
        dispatch({ type: 'LIVE_DATA_ENVIRONMENT', environment: 'DEMO' });
        return;
      }
    }
    dispatch({ type: 'LIVE_DATA_ENVIRONMENT', environment: env });
  }, []);

  const startLiveMonitoring = useCallback(
    async (params: {
      direction: CommuteDirection;
      startMode: 'IMMEDIATE' | 'SCHEDULED_LEAD';
      watchMode: 'ALL_OPTIONS' | 'SELECTED_OPTION';
      selectedOptionId?: string | null;
    }) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) return;
      // LIVE only when explicitly chosen AND the backend provider is configured.
      let environment: DataEnvironment = s.liveDataEnvironment;
      const configured = s.connection.liveApiConfigured ?? s.live.quota?.liveApiConfigured ?? null;
      if (environment === 'LIVE' && configured === false) {
        environment = 'DEMO';
      }
      const result = await runLive(() =>
        pilotApi.startOrRefreshMonitoring(s.connection.baseUrl, s.connection.token!, {
          direction: params.direction,
          environment,
          startMode: params.startMode,
          watchMode: params.watchMode,
          selectedOptionId: params.selectedOptionId ?? null,
        })
      );
      if (result) {
        connectionGeneration.commit(generation, () => {
          dispatch({ type: 'LIVE_SESSION', session: result.session, newAlerts: result.newAlerts });
          if (result.quota) dispatch({ type: 'LIVE_PATCH', patch: { quota: result.quota } });
        });
      }
    },
    [runLive, connectionGeneration]
  );

  const liveSelectOption = useCallback(
    async (sessionId: string, optionId: string) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) return;
      const result = await runLive(() =>
        pilotApi.selectOption(s.connection.baseUrl, s.connection.token!, sessionId, optionId)
      );
      if (result) {
        connectionGeneration.commit(generation, () => dispatch({ type: 'LIVE_SESSION', session: result.session }));
      }
    },
    [runLive, connectionGeneration]
  );

  const liveMonitoringAction = useCallback(
    async (
      sessionId: string,
      action: 'IVE_LEFT' | 'SNOOZE_10M' | 'SKIP_TODAY' | 'STOP_MONITORING'
    ) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) return;
      const result = await runLive(() =>
        pilotApi.monitoringAction(s.connection.baseUrl, s.connection.token!, sessionId, action)
      );
      if (result) {
        connectionGeneration.commit(generation, () => {
          dispatch({ type: 'LIVE_SESSION', session: result.session });
          if (result.profile) dispatch({ type: 'LIVE_PATCH', patch: { profile: result.profile } });
        });
        if (action === 'IVE_LEFT') {
          await refreshLiveState();
        }
      }
    },
    [runLive, refreshLiveState, connectionGeneration]
  );

  const liveUpdateProfile = useCallback(
    async (patch: Parameters<typeof pilotApi.updateProfile>[2]) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) throw new Error('Connect and log in before saving profile changes.');
      const result = await runLive(() =>
        pilotApi.updateProfile(s.connection.baseUrl, s.connection.token!, patch)
      );
      if (!result) throw new Error('Connection changed before the profile update was applied.');
      connectionGeneration.commit(generation, () => dispatch({ type: 'LIVE_PATCH', patch: { profile: result.profile } }));
    },
    [runLive, connectionGeneration]
  );

  const liveDayOverride = useCallback(
    async (override: DayOverride) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) throw new Error('Connect and log in before saving today’s plan.');
      const result = await runLive(() =>
        pilotApi.setDayOverride(s.connection.baseUrl, s.connection.token!, override)
      );
      if (!result) throw new Error('Connection changed before today’s plan was applied.');
      connectionGeneration.commit(generation, () => dispatch({
          type: 'LIVE_PATCH',
          patch: { profile: result.profile, sessions: result.sessions },
        }));
    },
    [runLive, connectionGeneration]
  );

  const liveCorrectJourney = useCallback(
    async (journeyId: string, patch: Parameters<typeof pilotApi.updateJourney>[3]) => {
      const generation = connectionGeneration.capture();
      const s = stateRef.current;
      if (!s.connection.token || !s.connection.baseUrl) throw new Error('Connect and log in before saving trip corrections.');
      const result = await runLive(() =>
        pilotApi.updateJourney(s.connection.baseUrl, s.connection.token!, journeyId, patch)
      );
      if (!result) throw new Error('Connection changed before the trip correction was applied.');
      connectionGeneration.commit(generation, () => dispatch({
          type: 'LIVE_PATCH',
          patch: {
            journeys: s.live.journeys.map((j) => (j.id === journeyId ? result.journey : j)),
          },
        }));
    },
    [runLive, connectionGeneration]
  );

  const liveDeleteLocations = useCallback(async () => {
    const generation = connectionGeneration.capture();
    const s = stateRef.current;
    if (!s.connection.token || !s.connection.baseUrl) return;
    const result = await runLive(() =>
      pilotApi.deleteLocations(s.connection.baseUrl, s.connection.token!)
    );
    if (result && connectionGeneration.isCurrent(generation)) {
      await refreshLiveState();
    }
  }, [runLive, refreshLiveState, connectionGeneration]);

  const liveDeleteJourneys = useCallback(async () => {
    const generation = connectionGeneration.capture();
    const s = stateRef.current;
    if (!s.connection.token || !s.connection.baseUrl) return;
    const result = await runLive(() =>
      pilotApi.deleteJourneys(s.connection.baseUrl, s.connection.token!)
    );
    if (result && connectionGeneration.isCurrent(generation)) {
      await refreshLiveState();
    }
  }, [runLive, refreshLiveState, connectionGeneration]);

  const refreshNativePushStatus = useCallback(async () => {
    const snapshot = stateRef.current;
    const account = accountFor(snapshot.connection, snapshot.live.profile);
    if (!account || snapshot.mode !== 'CONNECTED') return null;
    const connection = connectionGeneration.capture();
    const operation = nativePushOperationGeneration.current;
    try {
      const coordinator = await getNativePushCoordinator();
      const result = await coordinator.refreshStatus(account);
      const currentAccount = accountFor(stateRef.current.connection, stateRef.current.live.profile);
      if (connectionGeneration.isCurrent(connection) && operation === nativePushOperationGeneration.current &&
        currentAccount?.accountId === account.accountId && currentAccount.apiOrigin === account.apiOrigin) {
        setNativePushStatus(result);
      }
      return result;
    } catch {
      const result: NativePushResult = {
        state: 'error', installationId: null, permission: 'not-requested', registered: false,
        nativePushEnabled: null, pendingCleanup: false, errorCode: 'storage',
      };
      if (connectionGeneration.isCurrent(connection) && operation === nativePushOperationGeneration.current) {
        setNativePushStatus(result);
      }
      return result;
    }
  }, [accountFor, connectionGeneration, getNativePushCoordinator]);

  const enableNativePush = useCallback(async () => {
    const snapshot = stateRef.current;
    const account = accountFor(snapshot.connection, snapshot.live.profile);
    if (!account || snapshot.mode !== 'CONNECTED') throw new Error('Log in to the connected pilot backend before enabling native push.');
    const connection = connectionGeneration.capture();
    const operation = ++nativePushOperationGeneration.current;
    setNativePushBusy(true);
    try {
      await liveUpdateProfile({ pushOptIn: true });
      if (!connectionGeneration.isCurrent(connection)) throw new Error('Account changed before push consent was acknowledged.');
      const coordinator = await getNativePushCoordinator();
      const result = await coordinator.enable(account, { consent: true });
      const currentAccount = accountFor(stateRef.current.connection, stateRef.current.live.profile);
      if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(connection) &&
        currentAccount?.accountId === account.accountId && currentAccount.apiOrigin === account.apiOrigin) {
        setNativePushStatus(result);
      }
      return result;
    } catch (error) {
      if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(connection)) {
        setNativePushStatus({
          state: 'error', installationId: null, permission: 'not-requested', registered: false,
          nativePushEnabled: null, pendingCleanup: false, errorCode: 'api',
        });
      }
      throw error;
    } finally {
      if (operation === nativePushOperationGeneration.current) setNativePushBusy(false);
    }
  }, [accountFor, connectionGeneration, getNativePushCoordinator, liveUpdateProfile]);

  const disableNativePush = useCallback(async () => {
    const snapshot = stateRef.current;
    const account = accountFor(snapshot.connection, snapshot.live.profile);
    if (!account) throw new Error('Log in as the account that owns this device registration to disable it.');
    const connection = connectionGeneration.capture();
    const operation = ++nativePushOperationGeneration.current;
    setNativePushBusy(true);
    let profileError: unknown;
    try {
      await liveUpdateProfile({ pushOptIn: false });
    } catch (error) {
      profileError = error;
    }
    try {
      const coordinator = await getNativePushCoordinator();
      const result = await coordinator.disable(account);
      if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(connection)) {
        setNativePushStatus(result);
      }
      if (profileError) throw profileError;
      return result;
    } finally {
      if (operation === nativePushOperationGeneration.current) setNativePushBusy(false);
    }
  }, [accountFor, connectionGeneration, getNativePushCoordinator, liveUpdateProfile]);

  const retryNativePushCleanup = useCallback(async () => {
    const snapshot = stateRef.current;
    const account = accountFor(snapshot.connection, snapshot.live.profile);
    if (!account) throw new Error('Log in as the account that owns the pending device cleanup to retry it.');
    const connection = connectionGeneration.capture();
    const operation = ++nativePushOperationGeneration.current;
    setNativePushBusy(true);
    try {
      const coordinator = await getNativePushCoordinator();
      const result = await coordinator.disable(account);
      if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(connection)) {
        setNativePushStatus(result);
      }
      return result;
    } finally {
      if (operation === nativePushOperationGeneration.current) setNativePushBusy(false);
    }
  }, [accountFor, connectionGeneration, getNativePushCoordinator]);

  const refreshNativePushRegistration = useCallback(async () => {
    const snapshot = stateRef.current;
    const account = accountFor(snapshot.connection, snapshot.live.profile);
    if (!account || snapshot.mode !== 'CONNECTED' || !snapshot.live.profile?.pushOptIn) return;
    const connection = connectionGeneration.capture();
    const operation = nativePushOperationGeneration.current;
    const coordinator = await getNativePushCoordinator();
    const result = await coordinator.enable(account, { consent: true, requestPermission: false });
    if (operation === nativePushOperationGeneration.current && connectionGeneration.isCurrent(connection)) {
      setNativePushStatus(result);
    }
  }, [accountFor, connectionGeneration, getNativePushCoordinator]);

  useEffect(() => {
    if (!state.hydrated || state.mode !== 'CONNECTED' || !state.connection.token || !state.live.profile) return;
    void refreshNativePushStatus();
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeToExpoPushEvents(
      () => { void refreshLiveState().catch(() => undefined); },
      () => { void refreshNativePushRegistration().catch(() => undefined); }
    ).then((dispose) => {
      if (cancelled) dispose();
      else unsubscribe = dispose;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [
    state.hydrated,
    state.mode,
    state.connection.token,
    state.connection.baseUrl,
    state.live.profile?.employeeCode,
    refreshNativePushStatus,
    refreshNativePushRegistration,
    refreshLiveState,
  ]);

  const demoDispatch = useCallback((action: DemoAction) => {
    dispatch({ type: 'DEMO_ACTION', action });
  }, []);

  const api = useMemo<AppApi>(
    () => ({
      state,
      setMode,
      setBaseUrl,
      fetchRoster,
      login,
      logout,
      refreshLiveState,
      setLiveDataEnvironment,
      startLiveMonitoring,
      liveSelectOption,
      liveMonitoringAction,
      liveUpdateProfile,
      liveDayOverride,
      liveCorrectJourney,
      liveDeleteLocations,
      liveDeleteJourneys,
      nativePushStatus,
      nativePushBusy,
      enableNativePush,
      disableNativePush,
      refreshNativePushStatus,
      retryNativePushCleanup,
      demoDispatch,
    }),
    [
      state,
      setMode,
      setBaseUrl,
      fetchRoster,
      login,
      logout,
      refreshLiveState,
      setLiveDataEnvironment,
      startLiveMonitoring,
      liveSelectOption,
      liveMonitoringAction,
      liveUpdateProfile,
      liveDayOverride,
      liveCorrectJourney,
      liveDeleteLocations,
      liveDeleteJourneys,
      nativePushStatus,
      nativePushBusy,
      enableNativePush,
      disableNativePush,
      refreshNativePushStatus,
      retryNativePushCleanup,
      demoDispatch,
    ]
  );

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
