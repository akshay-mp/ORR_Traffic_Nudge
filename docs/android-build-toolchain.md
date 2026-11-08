# Local Android build toolchain proof

## Result

A local debug APK was built from a temporary snapshot of `mobile/` on 2026-11-08. This proves that the captured source snapshot can be prebuilt and compiled with the local Android toolchain; it is not final app acceptance, a device/UI test, or evidence that the current working tree still matches the snapshot.

- Build root: `/tmp/orr-pulse-android-toolchain.VSpYpk`
- Source snapshot: `/tmp/orr-pulse-android-toolchain.VSpYpk/mobile`
- Snapshot interval: `2026-11-08T07:51:35Z` to `2026-11-08T07:51:35Z` (UTC; copy occurred within the timestamp resolution)
- Snapshot manifest SHA-256: `2f0060346592cbe981c2e709b4bae82fbb1fca658088bc2f43a5301cfd90ea1d`
- APK: `/tmp/orr-pulse-android-toolchain.VSpYpk/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (156 MiB)
- APK SHA-256: `e69add8688a9325de8cbd5f46b48f975112b6ab3c8a33b4a03942b4a7022bfe4`
- Package/version: `com.orrpulse.pilot`, `1.0.0` (version code 1)
- APK signature: verified with Android Debug certificate (v2); debug-only, not a release signature
- Gradle: `BUILD SUCCESSFUL` in 7m 4s

The repository was already actively changing when the snapshot was made. Only the snapshot was built. The copy excludes `node_modules/`, `.expo/`, and `dist/`; its dependencies were installed from the captured `package-lock.json` using `npm ci`. The per-file hashes are in `/tmp/orr-pulse-android-toolchain.VSpYpk/snapshot-files.sha256`.

## Toolchain used

- macOS arm64; Java `17.0.20.1` at `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
- Android SDK root: `/opt/homebrew/share/android-commandlinetools`
- Android platform `android-36`, build-tools `36.0.0`, NDK `27.1.12297006`
- Expo `57.0.32`, React Native `0.86.3`
- Gradle wrapper downloaded by the generated project: Gradle `9.3.1`

Gradle explicitly required Android Build-Tools `35.0.0`; it installed that SDK component under the configured SDK root during the build. No unrelated SDK components were installed intentionally. The build emitted a command-line tools SDK XML v4 compatibility warning, several dependency deprecation warnings, and an Expo warning that `expo-system-ui` is absent for `userInterfaceStyle`; none prevented APK generation.

## Reproduction

Run from a checkout containing `mobile/`. Use a fresh temporary directory; do not prebuild in the working tree.

```sh
set -euo pipefail
BUILD_ROOT="$(mktemp -d /tmp/orr-pulse-android-toolchain.XXXXXX)"
mkdir -p "$BUILD_ROOT/mobile" "$BUILD_ROOT/logs"
rsync -a --exclude=node_modules --exclude=.expo --exclude=dist \
  ./mobile/ "$BUILD_ROOT/mobile/"
cd "$BUILD_ROOT/mobile"
npm ci --no-audit --no-fund

export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

npx expo prebuild --platform android --no-install
cd android
./gradlew --no-daemon assembleDebug
```

The produced debug APK is `android/app/build/outputs/apk/debug/app-debug.apk` within `BUILD_ROOT/mobile`. The `--no-install` flag prevents Expo prebuild from running package-manager or CocoaPods installation; it does not skip the preceding `npm ci` for the source snapshot.

The Debug APK contains no embedded JavaScript bundle. Runtime testing requires
Metro serving the corresponding snapshot source; it is not a standalone offline
build. A final standalone pilot artifact must embed its JavaScript.

## Scope and limits

- This is a toolchain proof for one captured source snapshot, not a review or acceptance of concurrently changing source or fixes.
- APK signature and package metadata were checked locally with `apksigner` and `aapt`. No emulator/device was installed, launched, or used; no adb/simctl UI action was performed.
- The build used only the generated Android debug keystore. No EAS/cloud credentials, release signing, deployment, or notification-delivery validation was involved.
- A successful compile does not establish runtime correctness, backend connectivity, notification behavior, or production readiness.

## Logs and evidence

- `/tmp/orr-pulse-android-toolchain.VSpYpk/logs/npm-ci.log`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/logs/expo-prebuild.log`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/logs/gradle-assembleDebug.log`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/logs/apksigner-verify.log`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/logs/aapt-badging.txt`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/snapshot-metadata.txt`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/snapshot-manifest.sha256`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/snapshot-files.sha256`
- `/tmp/orr-pulse-android-toolchain.VSpYpk/apk.sha256`
