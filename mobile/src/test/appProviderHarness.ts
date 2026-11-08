/**
 * Controlled-execution harness for the REAL AppProvider in
 * src/state/appStore.tsx, run under node:test without React Native.
 *
 * What is mocked (platform boundaries only):
 * - React itself: a minimal hook-cell implementation (no reconciler).
 * - react-native: AppState only.
 * - services/storage: in-memory map (AsyncStorage + SecureStore keys).
 * - services/pilotApi: in-memory pilot backend (login/fetchState/roster/
 *   updateProfile), never the network.
 * - services/nativePushExpo: createExpoNativePushCoordinator returns the REAL
 *   NativePushCoordinator over fake ports (notifications/secureStorage/api)
 *   with per-call deferred gates; subscribeToExpoPushEvents is a no-op.
 *
 * What runs as production code: every AppProvider callback (login, logout,
 * setBaseUrl, enableNativePush, disableNativePush, refreshNativePushStatus,
 * refreshLiveState effects), the appReducer, ConnectionGeneration
 * serialization, the real NativePushCoordinator, and demo rehydration.
 *
 * Known limits (also documented in docs/mobile-implementation.md): renders and
 * effect flushes are synchronous; there is no concurrent rendering, StrictMode
 * double invocation, or layout/passive effect split. setState/dispatch after
 * unmount are dropped like real React. The module mocks are installed by
 * patching the CommonJS loader and match only requires whose parent module is
 * appStore.tsx; node:test runs each test file in its own process, so other
 * test files are unaffected.
 */
import { createRequire } from 'node:module';
import { NativePushCoordinator } from '../services/nativePush';
import {
  INSTALLATION_ID_STORAGE_KEY,
  OWNER_STORAGE_KEY,
  type NativePushAccount,
  type NativePushPorts,
  type NativePushServerStatus,
} from '../services/nativePushContract';
import type { ServerClock } from '../services/pilotApi';
import type { ApiQuotaStatus, UserProfile } from '../types/shared';
import type { AppApi } from '../state/appStore';

const nodeRequire = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makeProfile(employeeCode: string, pushOptIn = true): UserProfile {
  return {
    id: `user-${employeeCode}`,
    employeeCode,
    name: `Pilot ${employeeCode}`,
    role: 'PILOT',
    corridorTag: 'ORR',
    onboardingComplete: true,
    telemetryConsent: true,
    pushOptIn,
    homeLocation: null,
    workLocation: {
      label: 'Work',
      address: 'Pilot work address',
      lat: 12.9,
      lng: 77.6,
      confirmedAt: '2026-11-08T00:00:00.000Z',
    },
    schedules: {
      HOME_TO_WORK: {
        direction: 'HOME_TO_WORK',
        enabled: true,
        mode: 'BIKE',
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        windowStart: '08:00',
        windowEnd: '10:00',
        arrivalDeadline: '09:30',
        preferredDeparture: '08:15',
        safetyBufferMinutes: 10,
        leadTimeMinutes: 10,
        alertThresholdMinutes: 5,
      },
      WORK_TO_HOME: {
        direction: 'WORK_TO_HOME',
        enabled: true,
        mode: 'BIKE',
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        windowStart: '17:30',
        windowEnd: '20:00',
        arrivalDeadline: null,
        preferredDeparture: '18:00',
        safetyBufferMinutes: 10,
        leadTimeMinutes: 10,
        alertThresholdMinutes: 5,
      },
    },
    dayOverrides: [],
  };
}

const CLOCK: ServerClock = {
  dateIst: '2026-11-08',
  timeIst: '09:00',
  timeWithSecIst: '09:00:00',
  dayOfWeek: 'Sun',
  iso: '2026-11-08T03:30:00.000Z',
};

const QUOTA: ApiQuotaStatus = {
  dateIst: '2026-11-08',
  dailyLimit: 1000,
  requestsUsedToday: 0,
  routesRequests: 0,
  placesRequests: 0,
  geocodingRequests: 0,
  lastProviderStatus: 'OK',
  lastErrorMessage: null,
  liveApiConfigured: true,
};

export interface MeStateFixture {
  serverClock: ServerClock;
  profile: UserProfile;
  sessions: [];
  alerts: [];
  journeys: [];
  quota: ApiQuotaStatus;
}

export function makeMeState(profile: UserProfile): MeStateFixture {
  return { serverClock: CLOCK, profile, sessions: [], alerts: [], journeys: [], quota: QUOTA };
}

// ---------------------------------------------------------------------------
// Deferred boundaries
// ---------------------------------------------------------------------------

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Minimal React (hook cells + element objects)
// ---------------------------------------------------------------------------

interface HookCell {
  kind: 'state' | 'reducer' | 'ref' | 'callback' | 'memo' | 'effect';
  value?: unknown;
  reducer?: (state: unknown, action: unknown) => unknown;
  ref?: { current: unknown };
  fn?: unknown;
  deps?: readonly unknown[];
  prevDeps?: readonly unknown[];
  effect?: () => unknown;
  cleanup?: (() => void) | null;
  hasRun?: boolean;
}

let activeHost: HookHost | null = null;

function cellAt(kind: HookCell['kind']): HookCell {
  const host = activeHost;
  if (!host) throw new Error('React hook called outside a controlled render');
  return host.cellFor(kind);
}

function depsEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function recordStateSet(value: unknown): void {
  if (activeEnv) {
    activeEnv.stateSets.push({ kind: typeof value === 'boolean' ? 'busy' : 'status', value });
  }
}

function recordDispatch(action: unknown): void {
  if (!activeEnv || typeof action !== 'object' || action === null || !('type' in action)) return;
  const typed = action as { type: string; action?: { type?: string } };
  const label =
    typed.type === 'DEMO_ACTION' && typed.action && typeof typed.action.type === 'string'
      ? `DEMO_ACTION:${typed.action.type}`
      : typed.type;
  activeEnv.dispatches.push(label);
}

function useState<S>(initial: S | (() => S)): [S, (update: S | ((prev: S) => S)) => void] {
  const host = activeHost;
  if (!host) throw new Error('useState called outside a controlled render');
  const cell = cellAt('state');
  if (!cell.hasRun) {
    cell.value = typeof initial === 'function' ? (initial as () => S)() : initial;
    cell.hasRun = true;
  }
  const setValue = (update: S | ((prev: S) => S)) => {
    if (!host.mounted) return;
    const prev = cell.value as S;
    const next = typeof update === 'function' ? (update as (prev: S) => S)(prev) : update;
    recordStateSet(next);
    if (Object.is(next, prev)) return;
    cell.value = next;
    host.scheduleRender();
  };
  return [cell.value as S, setValue];
}

function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S
): [S, (action: A) => void] {
  const host = activeHost;
  if (!host) throw new Error('useReducer called outside a controlled render');
  const cell = cellAt('reducer');
  if (!cell.hasRun) {
    cell.value = init ? init(initialArg) : initialArg;
    cell.hasRun = true;
  }
  cell.reducer = reducer as unknown as (state: unknown, action: unknown) => unknown;
  const dispatch = (action: A) => {
    if (!host.mounted) return;
    recordDispatch(action);
    const next = (cell.reducer as (state: unknown, action: unknown) => unknown)(cell.value, action);
    if (Object.is(next, cell.value)) return;
    cell.value = next;
    host.scheduleRender();
  };
  return [cell.value as S, dispatch];
}

function useRef<T>(initial: T): { current: T } {
  const cell = cellAt('ref');
  if (!cell.hasRun) {
    cell.ref = { current: initial };
    cell.hasRun = true;
  }
  return cell.ref as { current: T };
}

function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T {
  const cell = cellAt('callback');
  if (!cell.hasRun || !depsEqual(cell.deps, deps)) {
    cell.fn = fn;
    cell.deps = deps;
    cell.hasRun = true;
  }
  return cell.fn as T;
}

function useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
  const cell = cellAt('memo');
  if (!cell.hasRun || !depsEqual(cell.deps, deps)) {
    cell.value = factory();
    cell.deps = deps;
    cell.hasRun = true;
  }
  return cell.value as T;
}

function useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
  const cell = cellAt('effect');
  cell.effect = effect;
  cell.deps = deps;
}

function createContext<T>(): { Provider: symbol; _currentValue: T | null } {
  return { Provider: Symbol('HarnessContext.Provider'), _currentValue: null };
}

const reactMock = {
  createContext,
  useContext: <T,>(ctx: { _currentValue: T | null }): T | null => ctx._currentValue,
  useState,
  useEffect,
  useReducer,
  useRef,
  useCallback,
  useMemo,
};
(reactMock as { default?: unknown }).default = reactMock;

const jsxRuntimeMock = {
  Fragment: Symbol('Fragment'),
  jsx: (type: unknown, props: Record<string, unknown>): { type: unknown; props: Record<string, unknown> } => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>): { type: unknown; props: Record<string, unknown> } => ({ type, props }),
  jsxDEV: (type: unknown, props: Record<string, unknown>): { type: unknown; props: Record<string, unknown> } => ({ type, props }),
};

class HookHost {
  private readonly cells: HookCell[] = [];
  private cursor = 0;
  private rendering = false;
  private rerunRequested = false;
  private isMounted = true;
  element: { type: unknown; props: Record<string, unknown> } | null = null;
  renderCount = 0;

  constructor(
    private readonly component: (props: { children?: unknown }) => unknown
  ) {}

  get mounted(): boolean {
    return this.isMounted;
  }

  cellFor(kind: HookCell['kind']): HookCell {
    const index = this.cursor;
    this.cursor += 1;
    if (index >= this.cells.length) this.cells.push({ kind });
    const cell = this.cells[index];
    if (cell.kind !== kind) {
      throw new Error(`Hook order violation: expected ${kind}, found ${cell.kind}`);
    }
    return cell;
  }

  scheduleRender(): void {
    if (!this.isMounted) return;
    if (this.rendering) {
      this.rerunRequested = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.rerunRequested = false;
        this.renderOnce();
        this.flushEffects();
      } while (this.rerunRequested);
    } finally {
      this.rendering = false;
    }
  }

  unmount(): void {
    if (!this.isMounted) return;
    this.isMounted = false;
    for (const cell of [...this.cells].reverse()) {
      if (cell.kind === 'effect' && cell.cleanup) {
        const cleanup = cell.cleanup;
        cell.cleanup = null;
        cleanup();
      }
    }
  }

  private renderOnce(): void {
    const previousHost = activeHost;
    activeHost = this;
    this.cursor = 0;
    try {
      this.element = this.component({ children: null }) as {
        type: unknown;
        props: Record<string, unknown>;
      };
      this.renderCount += 1;
    } finally {
      activeHost = previousHost;
    }
  }

  private flushEffects(): void {
    for (const cell of this.cells) {
      if (cell.kind !== 'effect' || !cell.effect) continue;
      if (cell.hasRun && cell.deps && depsEqual(cell.deps, cell.prevDeps)) continue;
      if (cell.cleanup) {
        const cleanup = cell.cleanup;
        cell.cleanup = null;
        cleanup();
      }
      const returned = cell.effect();
      cell.cleanup = typeof returned === 'function' ? (returned as () => void) : null;
      cell.prevDeps = cell.deps ? [...cell.deps] : undefined;
      cell.hasRun = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Environment: storage / pilot API / AppState / coordinator ports
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  TOKEN: 'orr.session.token',
  OWNER: 'orr.session.owner',
  BASE_URL: 'orr.pilot.baseUrl',
  DEMO_STATE: 'orr.demo.state.v1',
  LIVE_CACHE: 'orr.live.cache.v1',
  MODE: 'orr.app.mode',
} as const;

export interface PortCall {
  kind: 'channel' | 'permission' | 'permission-status' | 'token' | 'register' | 'delete' | 'devices' | 'push-status';
  account?: NativePushAccount;
  value?: unknown;
}

export interface PilotCall {
  method: 'login' | 'fetchState' | 'fetchRoster' | 'updateProfile';
  baseUrl?: string;
  token?: string | null;
  arg?: unknown;
}

export interface StorageOp {
  op: string;
  value: unknown;
}

export interface StateSet {
  kind: 'busy' | 'status';
  value: unknown;
}

export interface PushGates {
  permission?: Deferred<'granted' | 'denied' | 'undetermined'>;
  token?: Deferred<string>;
  delete?: Deferred<{ status: 200 | 404 }>;
  register?: Deferred<{ status: 201 }>;
  'push-status'?: Deferred<NativePushServerStatus>;
}

export interface HarnessEnv {
  kv: Map<string, string>;
  secure: Map<string, string>;
  calls: PortCall[];
  pilotCalls: PilotCall[];
  storageOps: StorageOp[];
  dispatches: string[];
  stateSets: StateSet[];
  gates: PushGates;
  permissionStatus: 'granted' | 'denied' | 'undetermined';
  appState: {
    currentState: string;
    addEventListener(type: string, handler: (next: string) => void): { remove(): void };
  };
  profileOverrides: Map<string, UserProfile>;
  ports: NativePushPorts;
}

const DEFAULT_PUSH_STATUS: NativePushServerStatus = {
  nativePushEnabled: true,
  registeredDevices: 1,
  outbox: {
    transportEnabled: false,
    pending: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    receiptPending: 0,
    receiptOk: 0,
    receiptError: 0,
  },
  deliveryDisclaimer: 'Harness: not delivery confirmation.',
};

let activeEnv: HarnessEnv | null = null;

function env(): HarnessEnv {
  if (!activeEnv) throw new Error('Harness environment accessed after unmount');
  return activeEnv;
}

function profileForToken(token: string): UserProfile {
  const overridden = env().profileOverrides.get(token);
  if (overridden) return overridden;
  const employeeCode = token.startsWith('token-') ? token.slice('token-'.length) : token;
  return makeProfile(employeeCode || 'emp-unknown');
}

function gatePromise<T>(gate: Deferred<T> | undefined): Promise<T> | null {
  return gate ? gate.promise : null;
}

function createEnv(seed: MountSeed): HarnessEnv {
  const kv = new Map(Object.entries(seed.kv ?? {}));
  const secure = new Map(Object.entries(seed.secure ?? {}));
  const e: HarnessEnv = {
    kv,
    secure,
    calls: [],
    pilotCalls: [],
    storageOps: [],
    dispatches: [],
    stateSets: [],
    gates: {},
    permissionStatus: 'undetermined',
    appState: {
      currentState: 'active',
      addEventListener(type: string, handler: (next: string) => void) {
        return { remove: () => undefined, type, handler };
      },
    },
    profileOverrides: new Map(),
    ports: null as unknown as NativePushPorts,
  };
  e.ports = {
    runtime: {
      platform: 'ios',
      isExpoGo: false,
      isSimulator: false,
      simulatorPushSupported: false,
      projectId: 'eas-project',
    },
    notifications: {
      async setAndroidChannel() {
        env().calls.push({ kind: 'channel' });
      },
      async getPermissionStatus() {
        env().calls.push({ kind: 'permission-status' });
        return env().permissionStatus;
      },
      async requestPermission() {
        env().calls.push({ kind: 'permission' });
        const gated = gatePromise(env().gates.permission);
        return gated ?? 'granted';
      },
      async getExpoPushToken() {
        env().calls.push({ kind: 'token' });
        const gated = gatePromise(env().gates.token);
        return gated ?? 'ExpoPushToken[harness-stable-token]';
      },
    },
    secureStorage: {
      async get(key) {
        return env().secure.get(key) ?? null;
      },
      async set(key, value) {
        env().secure.set(key, value);
      },
      async remove(key) {
        env().secure.delete(key);
      },
    },
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => (index + 1) & 0xff),
    api: {
      async registerDevice(account, body) {
        env().calls.push({ kind: 'register', account, value: body });
        const gated = gatePromise(env().gates.register);
        return gated ?? { status: 201 };
      },
      async deleteDevice(account, installationId) {
        env().calls.push({ kind: 'delete', account, value: installationId });
        const gated = gatePromise(env().gates.delete);
        return gated ?? { status: 200 };
      },
      async getDevices(account) {
        env().calls.push({ kind: 'devices', account });
        return [];
      },
      async getPushStatus(account) {
        env().calls.push({ kind: 'push-status', account });
        const gated = gatePromise(env().gates['push-status']);
        return gated ?? DEFAULT_PUSH_STATUS;
      },
    },
  };
  return e;
}

const storageMock = {
  async saveToken(token: string | null): Promise<void> {
    const e = env();
    e.storageOps.push({ op: 'saveToken', value: token });
    if (token === null) e.kv.delete(STORAGE_KEYS.TOKEN);
    else e.kv.set(STORAGE_KEYS.TOKEN, token);
  },
  async loadToken(): Promise<string | null> {
    return env().kv.get(STORAGE_KEYS.TOKEN) ?? null;
  },
  async saveOwnerId(ownerId: string | null): Promise<void> {
    const e = env();
    e.storageOps.push({ op: 'saveOwnerId', value: ownerId });
    if (ownerId === null) e.kv.delete(STORAGE_KEYS.OWNER);
    else e.kv.set(STORAGE_KEYS.OWNER, ownerId);
  },
  async loadOwnerId(): Promise<string | null> {
    return env().kv.get(STORAGE_KEYS.OWNER) ?? null;
  },
  async saveBaseUrl(url: string): Promise<void> {
    const e = env();
    e.storageOps.push({ op: 'saveBaseUrl', value: url });
    e.kv.set(STORAGE_KEYS.BASE_URL, url);
  },
  async loadBaseUrl(): Promise<string | null> {
    return env().kv.get(STORAGE_KEYS.BASE_URL) ?? null;
  },
  async saveMode(mode: 'DEMO' | 'CONNECTED'): Promise<void> {
    env().kv.set(STORAGE_KEYS.MODE, mode);
  },
  async loadMode(): Promise<'DEMO' | 'CONNECTED'> {
    return env().kv.get(STORAGE_KEYS.MODE) === 'CONNECTED' ? 'CONNECTED' : 'DEMO';
  },
  async saveDemoState(state: unknown): Promise<void> {
    env().kv.set(STORAGE_KEYS.DEMO_STATE, JSON.stringify(state));
  },
  async loadDemoState(): Promise<unknown | null> {
    const raw = env().kv.get(STORAGE_KEYS.DEMO_STATE);
    return raw ? JSON.parse(raw) : null;
  },
  async saveLiveCache(cache: unknown): Promise<void> {
    const e = env();
    e.storageOps.push({ op: 'saveLiveCache', value: cache });
    e.kv.set(STORAGE_KEYS.LIVE_CACHE, JSON.stringify(cache));
  },
  async loadLiveCache(): Promise<
    { baseUrl: string; ownerId: string; savedAt: number; [key: string]: unknown } | null
  > {
    const raw = env().kv.get(STORAGE_KEYS.LIVE_CACHE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { ownerId?: unknown; savedAt?: unknown };
      if (typeof parsed.ownerId === 'string' && Number.isFinite(parsed.savedAt)) return parsed as never;
      return null;
    } catch {
      return null;
    }
  },
  async clearLiveCache(): Promise<void> {
    const e = env();
    e.storageOps.push({ op: 'clearLiveCache', value: null });
    e.kv.delete(STORAGE_KEYS.LIVE_CACHE);
  },
};

class MockPilotApiError extends Error {
  code: string;
  status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'PilotApiError';
    this.code = code;
    this.status = status;
  }
}

const pilotApiMock = {
  PilotApiError: MockPilotApiError,
  pilotApi: {
    async login(baseUrl: string, userId: string, _pin: string) {
      env().pilotCalls.push({ method: 'login', baseUrl, arg: userId });
      const token = `token-${userId}`;
      return { token, profile: profileForToken(token) };
    },
    async fetchState(baseUrl: string, token: string) {
      env().pilotCalls.push({ method: 'fetchState', baseUrl, token });
      return makeMeState(profileForToken(token));
    },
    async fetchRoster(baseUrl: string) {
      env().pilotCalls.push({ method: 'fetchRoster', baseUrl });
      return { roster: [], serverTimeIst: '09:00', dateIst: '2026-11-08', liveApiConfigured: true };
    },
    async updateProfile(baseUrl: string, token: string, patch: Partial<UserProfile>) {
      env().pilotCalls.push({ method: 'updateProfile', baseUrl, token, arg: patch });
      const profile = { ...profileForToken(token), ...patch };
      env().profileOverrides.set(token, profile);
      return { profile };
    },
  },
};

const nativePushExpoMock = {
  async createExpoNativePushCoordinator(): Promise<NativePushCoordinator> {
    return new NativePushCoordinator(env().ports);
  },
  async subscribeToExpoPushEvents(): Promise<() => void> {
    return () => undefined;
  },
};

const reactNativeMock = {
  get AppState() {
    return env().appState;
  },
  Platform: { OS: 'ios' },
};

// ---------------------------------------------------------------------------
// Module interception + mount
// ---------------------------------------------------------------------------

type AppStoreModule = typeof import('../state/appStore');
let appStoreModule: AppStoreModule | null = null;
let loaderPatched = false;

const MOCKED_REQUESTS: Record<string, unknown> = {
  react: reactMock,
  'react/jsx-runtime': jsxRuntimeMock,
  'react/jsx-dev-runtime': jsxRuntimeMock,
  'react-native': reactNativeMock,
  '../services/pilotApi': pilotApiMock,
  '../services/storage': storageMock,
  '../services/nativePushExpo': nativePushExpoMock,
};

function installMocksAndLoadAppStore(): AppStoreModule {
  if (appStoreModule) return appStoreModule;
  const Module = nodeRequire('node:module') as unknown as {
    _load?: (
      this: unknown,
      request: string,
      parent?: { filename?: string } | null,
      isMain?: boolean
    ) => unknown;
  };
  const originalLoad = Module._load;
  if (typeof originalLoad !== 'function') {
    throw new Error('node:module._load is unavailable; cannot intercept appStore requires');
  }
  if (!loaderPatched) {
    Module._load = function patchedLoad(
      this: unknown,
      request: string,
      parent?: { filename?: string } | null,
      isMain?: boolean
    ) {
      const mocked =
        Object.prototype.hasOwnProperty.call(MOCKED_REQUESTS, request) &&
        typeof parent?.filename === 'string' &&
        parent.filename.endsWith('appStore.tsx')
          ? MOCKED_REQUESTS[request]
          : undefined;
      if (mocked !== undefined) return mocked;
      return originalLoad.call(this, request, parent, isMain);
    } as typeof originalLoad;
    loaderPatched = true;
  }
  appStoreModule = nodeRequire('../state/appStore') as AppStoreModule;
  return appStoreModule;
}

export interface MountSeed {
  kv?: Record<string, string>;
  secure?: Record<string, string>;
}

export interface ProviderHarness {
  api: AppApi;
  env: HarnessEnv;
  settle(ticks?: number): Promise<void>;
  unmount(): void;
  renderCount(): number;
}

export function mountAppProvider(seed: MountSeed = {}): ProviderHarness {
  const { AppProvider } = installMocksAndLoadAppStore();
  activeEnv = createEnv(seed);
  const host = new HookHost(AppProvider as unknown as (props: { children?: unknown }) => unknown);
  host.scheduleRender();
  return {
    get api(): AppApi {
      if (!host.element) throw new Error('AppProvider has not rendered yet');
      return host.element.props.value as AppApi;
    },
    env: activeEnv,
    async settle(ticks = 8): Promise<void> {
      for (let i = 0; i < ticks; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    unmount: () => {
      host.unmount();
      activeEnv = null;
    },
    renderCount: () => host.renderCount,
  };
}
