# ORR Pulse Mobile Builds

Expo SDK 58 (`expo 58.0.23`, `react 19.3.0`, `react-native 0.88.1`) — upgraded
from SDK 57 with the official `npx expo install expo@^58.0.0 --fix` procedure;
verification evidence is in `docs/mobile-implementation.md`. The current Expo Go
supports only SDK 58, so physical-device testing over Expo Go requires this SDK
version. Native SDK57 builds/artifacts are stale after the upgrade and must be
rebuilt (`npx expo run:ios` / `run:android` or EAS) before any native acceptance
claim.

Native push registration requires an iOS or Android development/preview build
on a physical device. Expo Go and simulators are intentionally reported as
unsupported for registration. In-app demo alerts remain independent.

Set `EXPO_PUBLIC_EAS_PROJECT_ID` only to the actual EAS project ID assigned to
this app; the app does not contain a placeholder project ID or push
credentials. Then install/build locally or with the configured EAS account:

```sh
npm install
npx expo start
npx expo run:ios
npx expo run:android
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
npx eas build --profile preview --platform all
```

The development profile includes `expo-dev-client`. A native build is required
after changing notification plugins or native dependencies. Do not treat a
successful build, registration response, Expo ticket, or backend status as
proof of device delivery. FCM/APNs credentials, EAS project provisioning, and
physical-device delivery validation are not included here.
