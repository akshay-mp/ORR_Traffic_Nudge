import type { NativePushResult } from './nativePushContract';

export function nativePushExplanation(status: NativePushResult | null): string {
  switch (status?.state) {
    case 'unsupported-platform': return 'Native push registration is unavailable on this platform.';
    case 'expo-go-unsupported': return 'Expo Go cannot register native push. Use an iOS/Android development build.';
    case 'simulator-unsupported': return 'Push token registration requires a physical iOS or Android device.';
    case 'missing-project-id': return 'Set the real EAS project ID in EXPO_PUBLIC_EAS_PROJECT_ID, then rebuild the app.';
    case 'permission-denied': return 'Notification permission is denied. Enable it in device Settings, then retry.';
    case 'permission-undetermined': return 'Notification permission is not granted yet. Retry to request permission.';
    case 'registered': return 'This installation is registered. This does not confirm delivery.';
    case 'server-disabled': return 'The backend reports native push transport is disabled.';
    case 'pending-cleanup': return 'A previous device registration still needs revocation; it will not be transferred to another account.';
    case 'error': return 'Unable to confirm push registration. Refresh status before retrying.';
    case 'consent-required': return 'This installation is not registered. Enable it only if you want notifications.';
    default: return 'Native push is opt-in and requires a configured development build on a physical device.';
  }
}
