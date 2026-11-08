/**
 * Device persistence.
 *
 * - Session token -> expo-secure-store (encrypted at rest by the OS).
 * - Non-secret cached state (demo state, base URL, cached live snapshot) ->
 *   @react-native-async-storage/async-storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const KEY_TOKEN = 'orr.session.token';
const KEY_OWNER = 'orr.session.owner';
const KEY_BASE_URL = 'orr.pilot.baseUrl';
const KEY_DEMO_STATE = 'orr.demo.state.v1';
const KEY_LIVE_CACHE = 'orr.live.cache.v1';
const KEY_MODE = 'orr.app.mode';

export async function saveToken(token: string | null): Promise<void> {
  if (token === null) {
    await SecureStore.deleteItemAsync(KEY_TOKEN).catch(() => undefined);
    return;
  }
  await SecureStore.setItemAsync(KEY_TOKEN, token);
}

export async function loadToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_TOKEN);
  } catch {
    return null;
  }
}

export async function saveOwnerId(ownerId: string | null): Promise<void> {
  if (ownerId === null) {
    await SecureStore.deleteItemAsync(KEY_OWNER).catch(() => undefined);
    return;
  }
  await SecureStore.setItemAsync(KEY_OWNER, ownerId);
}

export async function loadOwnerId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_OWNER);
  } catch {
    return null;
  }
}

export async function saveBaseUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(KEY_BASE_URL, url);
}

export async function loadBaseUrl(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY_BASE_URL);
  } catch {
    return null;
  }
}

export async function saveMode(mode: 'DEMO' | 'CONNECTED'): Promise<void> {
  await AsyncStorage.setItem(KEY_MODE, mode);
}

export async function loadMode(): Promise<'DEMO' | 'CONNECTED'> {
  try {
    const v = await AsyncStorage.getItem(KEY_MODE);
    return v === 'CONNECTED' ? 'CONNECTED' : 'DEMO';
  } catch {
    return 'DEMO';
  }
}

export async function saveDemoState(state: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_DEMO_STATE, JSON.stringify(state));
  } catch {
    // Non-fatal: demo state is a cache; worst case we rebuild fixtures.
  }
}

export async function loadDemoState(): Promise<unknown | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_DEMO_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export interface LiveCache {
  baseUrl: string;
  ownerId: string;
  savedAt: number;
  profile: unknown;
  serverClock: unknown;
  sessions: unknown[];
  alerts: unknown[];
  journeys: unknown[];
  quota: unknown;
}

export async function saveLiveCache(cache: LiveCache): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_LIVE_CACHE, JSON.stringify(cache));
  } catch {
    // Non-fatal cache write.
  }
}

export async function loadLiveCache(): Promise<LiveCache | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_LIVE_CACHE);
    const cache = raw ? (JSON.parse(raw) as LiveCache) : null;
    return cache && typeof cache.ownerId === 'string' && Number.isFinite(cache.savedAt) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * Live cache is user data scoped to one backend origin. Callers must clear it
 * whenever the base URL or account changes so another server/user never sees
 * cached rows from a different scope.
 */
export async function clearLiveCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_LIVE_CACHE);
  } catch {
    // Non-fatal.
  }
}

export async function clearAppStorage(): Promise<void> {
  await AsyncStorage.multiRemove([KEY_BASE_URL, KEY_DEMO_STATE, KEY_LIVE_CACHE, KEY_MODE]);
  await saveToken(null);
  await saveOwnerId(null);
}
