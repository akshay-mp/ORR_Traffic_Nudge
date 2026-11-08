# Local iOS build toolchain proof

## Result

On November 8, 2026, the app generated a Debug iOS Simulator `.app` from an external snapshot of `mobile/`. `expo prebuild`, CocoaPods installation, and `xcodebuild` all completed successfully. This proves that this snapshot can pass through the local native toolchain; it is not acceptance of the final/repaired source, a physical iPhone build, or runtime functionality.

## Snapshot and provenance

- Source: `/Users/akshaymp/Projects/ORR_Traffic_Nudge/mobile/`.
- Snapshot: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/mobile-snapshot/`.
- Snapshot copy began at `2026-11-08T07:52:00Z` and finished at `2026-11-08T07:52:00Z`; source was changing during this work, so this represents the captured copy, not an asserted clean Git revision.
- Copied 41 regular files, excluding `node_modules/`, `.expo/`, and `dist/`; the snapshot's `node_modules` symlink points to the already-installed original `mobile/node_modules`.
- Per-file SHA-256 manifest: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/source.sha256`.
- SHA-256 of that manifest: `4ac945febabd806e0ac8064b32af138997f45f9cf4c50e2ed7dc180f26783728`.
- Expo prebuild temporarily changed only the snapshot's `ios`/`android` package scripts; after the native build, the captured `package.json` was restored in the snapshot and all 41 initial file hashes verified successfully.
- Relevant declared versions in the captured package manifest: Expo `57.0.32`, React Native `0.86.3`. `npx expo --version` resolved to `57.0.33` from the installed dependency tree.

## Environment

Successful environment: Apple Silicon (`arm64`), macOS `27.0.1` (build `26A434`), Xcode `27.2` (build `27B52`), iOS and iOS Simulator SDK `27.2`, CocoaPods `1.16.2`, Node `v26.0.0`, and npm `11.12.1`. The simulator build produced both `arm64` and `x86_64` simulator slices.

## Reproduction

Run from a macOS machine with Xcode command-line tools, Ruby/CocoaPods, Node/npm, the mobile dependencies installed, and network access for React Native artifacts and pods. Substitute the repository path as needed. The two-job limit bounds concurrent compiler work; no simulator boot is required.

```sh
set -euo pipefail
source_mobile=/Users/akshaymp/Projects/ORR_Traffic_Nudge/mobile
runroot=$(mktemp -d "${TMPDIR:-/tmp}/orr-ios-toolchain.XXXXXX")
snapshot="$runroot/mobile-snapshot"
mkdir -p "$snapshot"
rsync -a --exclude=node_modules --exclude=.expo --exclude=dist "$source_mobile/" "$snapshot/"
ln -s "$source_mobile/node_modules" "$snapshot/node_modules"
cd "$snapshot"
CI=1 npx expo prebuild --platform ios --no-install
cd "$snapshot/ios"
pod install
xcodebuild \
  -workspace ORRPulse.xcworkspace \
  -scheme ORRPulse \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$runroot/DerivedData" \
  -jobs 2 \
  CODE_SIGNING_ALLOWED=NO \
  build
```

If reusing the source `node_modules` is undesirable or those dependencies are absent, install dependencies in the temporary copy using its lockfile (`npm ci`) instead of creating the symlink. Keep all generated native files, Pods, and derived data under the temporary snapshot/run root.

## Captured proof

- Prebuild log: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/expo-prebuild.log` (`✔ Finished prebuild`).
- Pod install log: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/pod-install.log` (`Pod installation complete!`, 92 Podfile dependencies and 91 installed pods).
- Xcode log: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/xcodebuild.log` (`** BUILD SUCCEEDED **`).
- Artifact: `/tmp/orr-ios-toolchain-20261108T075200Z.X6Y23V/DerivedData/Build/Products/Debug-iphonesimulator/ORRPulse.app`.
- Artifact bundle identifier: `com.orrpulse.pilot`; executable: `ORRPulse`; executable SHA-256: `0ab27a726f69d2a0b0984f7b96d7368df5272d97ce877fa279220a3aa09d6b31`.
- Xcode reported upstream warnings (including nullability/deprecation and build-script output warnings), but no build errors; the terminal result was success.

## Scope and gaps

All prebuild output, Pods, logs, and derived data were kept under the external temporary run root; the existing installed dependency tree was reused by symlink. CocoaPods/React Native also populated the standard shared cache at `/Users/akshaymp/Library/Caches/ReactNative`. No original `mobile/` files, root configuration, or other documentation were intentionally edited for this proof. No signing/provisioning configuration or credentials were used. No simulator/device UI, app install, app launch, `simctl`, or Android device tooling was used. The `.app` has no developer/provisioning signing (`CODE_SIGNING_ALLOWED=NO`); its executable and debug dylib contain linker-generated ad-hoc signatures only, without a TeamIdentifier or sealed resources. It is simulator-only and cannot be installed on a physical iPhone. The build log reports `SKIP_BUNDLING enabled; skipping.` Runtime testing therefore requires Metro serving the corresponding snapshot source; this is not a standalone offline app. This says nothing about distribution readiness. No claim is made about physical iPhone compatibility, runtime behavior, network services, permissions, push notifications, release builds, or acceptance of later source changes.

For final reproducible builds, install dependencies with `npm ci` in an isolated
source snapshot rather than symlinking an actively shared dependency tree.
