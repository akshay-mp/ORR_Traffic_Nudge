export type NativePushPlatform = 'ios' | 'android';

export interface NativePushAccount {
  accountId: string;
  bearerToken: string;
  apiOrigin: string;
}

export interface NativePushRuntime {
  platform: 'ios' | 'android' | 'web' | 'other';
  isExpoGo: boolean;
  isSimulator: boolean;
  simulatorPushSupported: boolean;
  projectId: string | null;
}

export interface NativePushPorts {
  runtime: NativePushRuntime;
  notifications: {
    setAndroidChannel(): Promise<void>;
    getPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined'>;
    requestPermission(): Promise<'granted' | 'denied' | 'undetermined'>;
    getExpoPushToken(projectId: string): Promise<string>;
  };
  secureStorage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  randomBytes(length: number): Uint8Array;
  api: {
    registerDevice(
      account: NativePushAccount,
      body: { expoPushToken: string; platform: NativePushPlatform; installationId: string }
    ): Promise<{ status: 201 }>;
    deleteDevice(account: NativePushAccount, installationId: string): Promise<{ status: 200 | 404 }>;
    getDevices(account: NativePushAccount): Promise<Array<{ installationId: string }>>;
    getPushStatus(account: NativePushAccount): Promise<NativePushServerStatus>;
  };
}

export interface NativePushServerStatus {
  nativePushEnabled: boolean;
  registeredDevices: number;
  outbox: {
    transportEnabled: boolean;
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    receiptPending: number;
    receiptOk: number;
    receiptError: number;
  };
  deliveryDisclaimer: string;
}

export type NativePushState =
  | 'unsupported-platform'
  | 'expo-go-unsupported'
  | 'simulator-unsupported'
  | 'missing-project-id'
  | 'consent-required'
  | 'permission-denied'
  | 'permission-undetermined'
  | 'registered'
  | 'server-disabled'
  | 'pending-cleanup'
  | 'error';

export interface NativePushResult {
  state: NativePushState;
  installationId: string | null;
  permission: 'granted' | 'denied' | 'undetermined' | 'not-requested';
  registered: boolean;
  nativePushEnabled: boolean | null;
  pendingCleanup: boolean;
  errorCode?: 'permission' | 'configuration' | 'storage' | 'api' | 'cleanup';
}

export const INSTALLATION_ID_STORAGE_KEY = 'native-push.installation-id';
export const OWNER_STORAGE_KEY = 'native-push.owner';
export const PENDING_CLEANUP_STORAGE_KEY = 'native-push.pending-cleanup';
