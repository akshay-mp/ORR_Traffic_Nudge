import { Platform } from 'react-native';
import { NativePushCoordinator } from './nativePush';
import type { NativePushAccount, NativePushPorts } from './nativePushContract';
import { pilotApi } from './pilotApi';

export async function createExpoNativePushCoordinator(): Promise<NativePushCoordinator> {
  const [{ default: Constants }, Device, Crypto] = await Promise.all([
    import('expo-constants'),
    import('expo-device'),
    import('expo-crypto'),
  ]);
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : Platform.OS === 'web' ? 'web' : 'other';
  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() ||
    Constants.easConfig?.projectId ||
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ||
    null;
  const ports: NativePushPorts = {
    runtime: {
      platform,
      isExpoGo: Constants.appOwnership === 'expo' || !!Constants.expoGoConfig,
      isSimulator: (platform === 'ios' || platform === 'android') && !Device.isDevice,
      simulatorPushSupported: false,
      projectId,
    },
    notifications: {
      async setAndroidChannel() {
        const Notifications = await import('expo-notifications');
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Commute updates',
          importance: Notifications.AndroidImportance.DEFAULT,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#2563EB',
        });
      },
      async getPermissionStatus() {
        const Notifications = await import('expo-notifications');
        const permission = await Notifications.getPermissionsAsync();
        return permission.granted ? 'granted' : permission.status === 'denied' ? 'denied' : 'undetermined';
      },
      async requestPermission() {
        const Notifications = await import('expo-notifications');
        const permission = await Notifications.requestPermissionsAsync();
        return permission.granted ? 'granted' : permission.status === 'denied' ? 'denied' : 'undetermined';
      },
      async getExpoPushToken(easProjectId) {
        const Notifications = await import('expo-notifications');
        return (await Notifications.getExpoPushTokenAsync({ projectId: easProjectId })).data;
      },
    },
    secureStorage: {
      async get(key) {
        const SecureStore = await import('expo-secure-store');
        return SecureStore.getItemAsync(key);
      },
      async set(key, value) {
        const SecureStore = await import('expo-secure-store');
        await SecureStore.setItemAsync(key, value);
      },
      async remove(key) {
        const SecureStore = await import('expo-secure-store');
        await SecureStore.deleteItemAsync(key);
      },
    },
    randomBytes: (length) => Crypto.getRandomBytes(length),
    api: {
      registerDevice: async (account: NativePushAccount, body) =>
        pilotApi.registerDevice(account.apiOrigin, account.bearerToken, body),
      deleteDevice: async (account, installationId) =>
        pilotApi.deleteDevice(account.apiOrigin, account.bearerToken, installationId),
      getDevices: async (account) => pilotApi.getDevices(account.apiOrigin, account.bearerToken),
      getPushStatus: async (account) => pilotApi.getPushStatus(account.apiOrigin, account.bearerToken),
    },
  };
  return new NativePushCoordinator(ports);
}

export async function subscribeToExpoPushEvents(
  onNotification: () => void,
  onTokenRotation: () => void
): Promise<() => void> {
  const [{ default: Constants }, Device] = await Promise.all([
    import('expo-constants'),
    import('expo-device'),
  ]);
  const isExpoGo = Constants.appOwnership === 'expo' || !!Constants.expoGoConfig;
  const supportedPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || Constants.easConfig?.projectId ||
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  if (isExpoGo || !supportedPlatform || !Device.isDevice || !projectId) return () => undefined;

  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  const received = Notifications.addNotificationReceivedListener(() => onNotification());
  const response = Notifications.addNotificationResponseReceivedListener(() => onNotification());
  const token = Notifications.addPushTokenListener(() => onTokenRotation());
  return () => {
    received.remove();
    response.remove();
    token.remove();
  };
}
