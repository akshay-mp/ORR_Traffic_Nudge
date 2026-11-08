# ORR Pulse — Native Runtime Validation

**Observation date:** November 8, 2026

This record captures parent-observed iOS simulator behavior and separate
isolated HTTP-client integration checks against the current backend, which is
repaired (`2df` for the `c27` findings) and independently re-reviewed
(`3f210`, no material findings) as of November 8, 2026; the mobile `19f`
runtime repairs are also re-reviewed (`772b`, no material findings). It is
not a release
approval. The
Android and iOS toolchain notes linked below are compilation proofs for
temporary source snapshots; they are not evidence of installation or runtime
acceptance. No Android UI result or physical-device result is claimed here.

## iOS simulator session

- **Environment:** iPhone 17 Pro simulator, iOS 26.4, Expo Go 57; Metro on
  port 8091; app connected to an isolated test API at `127.0.0.1:3011` backed
  by temporary SQLite. The test API had no live-provider keys, push delivery,
  or scheduler enabled.
- **Local onboarding and connected login:** Local onboarding with Koramangala
  as home was completed and persisted. Logging into connected pilot account
  `PTP01` reset the home to Indiranagar.
- **Today/schedule display:** On Sunday, November 8, Today showed no commute
  today and the next scheduled commute on Monday, 08:00–09:15.
- **Rendering and text size:** Dark rendering was inspected in
  `/tmp/orr-ios-dark-interim.png`; a safe-area issue was fixed during the
  session. At Accessibility Medium, Today content and buttons wrapped within
  a scrollable view and the tabs remained available. This was not a full
  accessibility audit. Text size was restored to Large and appearance to
  Light afterward.
- **Connected trip correction:** A November 6 trip showed departure 08:45,
  original selected arrival 09:25, and original departure ETA 09:28. Actual
  arrival was entered as 09:37, corrected to 09:38, and saved through the UI.
  The displayed trip metric changed from 52 to 53 minutes while the original
  estimate snapshots remained unchanged. After app relaunch, Trips still
  showed 09:38.
- **Weekly plan save:** Connected weekly preferred departure was changed from
  08:30 to 08:35 and the UI acknowledged the save. Today then showed Monday at
  08:35.
- **Timed-out outbound-mode save (ambiguous result):** The test API was paused
  with `SIGSTOP` during a connected CAR-to-BIKE save. After timeout, the UI
  removed the success indication and showed that it could not save. On
  `SIGCONT`, the queued write actually committed. Therefore the timeout did
  **not** establish rejection or an unchanged server value. The parent restored
  server outbound mode to CAR through the API. A timeout must be treated as
  **unknown/unconfirmed**, and the UI's error is not proof the server rolled
  back.

## Separate HTTP-client integration check

On November 8, 2026, `/tmp/orr-current-integration.ts` exercised the actual
mobile `pilotApi` against `createApp` using a fresh temporary SQLite directory,
`NODE_ENV=test`, `skipWebStack`, and a random localhost port. It verified the
10-person roster, `emp_01`/`emp_02` login and account-scoped state, invalid-token
`401`, inbound preferred departure at 08:35, telemetry-consent and trip-feedback
mutations, and the original departure/selected estimate snapshots remaining
unchanged. It registered a device for one account, confirmed it was not visible
to the other, rejected reuse of the same Expo token by the other account with
`409`, and confirmed registration persisted. The native push status remained
disabled. After closing and reopening the service against the same temporary
database, the test confirmed the issued tokens, profile/schedule, device
registration, consent, trip feedback, account scope, and estimate snapshots
persisted. The harness removed its temporary database in `finally`.

This is HTTP-client/backend proof only: it does not establish native UI account
isolation, app/device restart recovery, push delivery or receipt, live-provider
readiness, or production service readiness. It is distinct from the earlier
simulator API session above. The isolated service had no live-provider keys,
push delivery, or scheduler enabled.

## Coordinator roundtrip re-run after the backend repair

On November 8, 2026, after backend repair `2df` and its independent re-review
`3f210`, the parent reran `/tmp/orr-coordinator-roundtrip.ts` against the
repaired source and it passed. The harness booted the actual backend
(`createApp`, fresh temporary SQLite, `NODE_ENV=test`, `skipWebStack`, random
localhost port) and drove the actual mobile `NativePushCoordinator` — with
only the native notification and secure-storage ports mocked — through the
actual `pilotApi` HTTP client. It verified the 10-person roster, registration
completing as `registered`, an honest server-disabled push status while the
device stayed registered, and revocation; account-scoped device visibility;
reuse of the same push token by the other account rejected with `409`; invalid
token `401`; weekly-schedule, telemetry-consent, and journey-feedback
mutations; and, after closing and reopening the service against the same
temporary database, persistence of schedule, consent, feedback, device
registration, and account scope with the original departure/selected estimate
snapshots unchanged. Push was disabled throughout, and the harness removed its
temporary database afterward.

This is coordinator/HTTP/backend proof with mocked native ports only. It does
not establish native UI behavior, account switching in the app, native push
delivery or receipt, live-provider readiness, or production service readiness.

## Mobile runtime re-review after the `19f` repair

On November 8, 2026, the Astra runtime re-review `772b` completed with no
material findings for the three `637` P2 repairs in mobile repair `19f`.
Reviewed runtime evidence: with mocked hooks/coordinator/storage, actual app
provider-callback checks preserved the other account's UI, status, and
credentials after a stale logout and origin cleanup; success and rejection
paths plus stale-login cleanup behaved correctly; the busy-state reset and
the stale `finally` path are correct; and the 11 API-client tests
independently pass, including the deadline case where `fetch`/body ignores
abort. The parent also independently ran the full 74 tests and typecheck.
Both runtime files are unchanged and match
`/Users/akshaymp/Projects/ORR_Pulse_Builds/repair-20261108/provenance.json`.

This clears the runtime repairs as run; it is distinct from repeatable test
coverage, which has since landed: the `31a8` provider lifecycle regression
coverage is implemented (two provider lifecycle test files added over the
52 captured runtime files, which are unchanged), the parent independently
ran the full mobile suite at 82/82 tests with typecheck passing, and the
Astra review `73e83` found no material test findings and independently
reran the provider lifecycle suite at 8/8 passing. None of this proves
native UI account isolation, native push delivery, or device acceptance.

## Isolated local pilot API state

The existing isolated local pilot API was restarted on the reviewed backend
and is listening at `127.0.0.1:3011`, backed by its existing temporary SQLite
data directory at
`/private/var/folders/52/jyyj7h7n149dtcc0j3xl0_xh0000gp/T/orr-native-pilot-Yzoehl`
(a temporary test database only; no real service data directory is in use).
The scheduler and push delivery are disabled, and the parent confirmed the
roster endpoint returning `200` with 10 entries. This is a point-in-time
local service state kept available for future native validation, not an
acceptance result, and it holds only while the host process stays up.

## Incomplete or unavailable runtime evidence

- **Account switch:** Native UI logout succeeded, then login for `PTP02` was
  attempted. PIN entry failed with “no text input found at the provided
  coordinates to clear.” A retry with `--debug` ended with an expired-reference
  error. iOS interaction was stopped per the device-tool retry rule; the app
  was left signed out. Account-switch completion and cross-account state
  isolation remain unverified in this native flow.
- **Android UI:** Screenshot tooling failed twice, including after reopening
  and listing the device. Android UI testing stopped; no adb fallback was
  used. There is no Android runtime acceptance result in this record.
- **Native install/build acceptance:** The iOS observations above ran in Expo
  Go, not a separately built native install. Snapshot compilation is described
  in [iOS build toolchain proof](ios-build-toolchain.md) and
  [Android build toolchain proof](android-build-toolchain.md). Those proofs do
  not establish that the current final source was built, installed, or
  accepted on either platform.
- **Service and operations:** The isolated API is test-only. No live-provider
  credentials, production authentication, hosted service, scheduler operation,
  or remote-push delivery was tested. Native push integration/delivery remains
  unverified; in-app behavior is not evidence of remote delivery.
- **Host availability:** The test API was resumed after the paused-write
  exercise; `caffeinate` was still active at the last check. These are
  point-in-time observations, not a guarantee the local service remains
  available. Local execution requires the Mac and server process to remain
  running; keep-awake does not execute code while the Mac is actually asleep.

## Next validation matrix

Run only after a stable, independently reviewed source checkpoint exists on
both sides: the backend is repaired and re-reviewed (`2df`/`3f210`, with the
parent rerun at 32/32 suites/385 assertions), the mobile `19f` runtime
repairs are re-reviewed (`772b`, no material findings), and the `31a8`
provider lifecycle coverage is implemented and reviewed (`73e83`, no
material test findings; parent-rerun 82/82 tests/typecheck; independent
8/8 lifecycle suite run). That source-review precondition is now met, but
execution is blocked by stopped native device tooling and missing physical
push setup/credentials. Record source revision or snapshot hashes, artifact
hashes, device and OS, app version, API configuration, steps, outcomes, and
supporting screenshots/logs. Keep credentials and private user data out of
captured evidence.

1. **Build provenance:** Compare the reviewed runtime source and locked
   dependencies with the manifest for the existing embedded-JavaScript Release
   candidates in `/Users/akshaymp/Projects/ORR_Pulse_Builds/repair-20261108/`.
   Verify artifact hashes and reuse these candidates when their runtime source
   matches; rebuild from an isolated locked-dependency copy only if runtime
   files differ. Record test-only changes separately. This comparison was
   completed on November 8, 2026: all 52 captured mobile files unchanged,
   only the two `31a8` provider lifecycle test files added, and both
   artifact sizes and SHA-256 hashes match provenance, so the candidates
   are verified with no runtime rebuild needed; rebuild only if runtime
   files later differ. Android uses a debug
   certificate; iOS is simulator-only with linker ad-hoc signatures and no
   developer provisioning. The older Debug toolchain notes remain historical
   compilation evidence. Build provenance does not establish installation or
   device acceptance.
2. **Install and launch:** Install each artifact using supported device
   tooling; cold launch, relaunch, and verify the running build/source identity.
   Test Android and iOS separately. Do not report compilation alone as install
   or runtime success.
3. **Core flows on each platform:** Check onboarding, all four tabs, local
   DEMO labeling/offline use, plan and today-only override saves, manual trip
   recording consent, trip correction with immutable original estimates,
   and persisted state after app relaunch.
4. **Connected behavior and isolation:** Against a dedicated test API, verify
   login/logout and account switching, origin changes, profile/token reopen,
   cache isolation, `401`, offline/reconnect, and LIVE/DEMO provenance. Read
   state from the API after each timeout or ambiguous response; never treat a
   timeout as proof a write failed. Include process-restart recovery as a
   distinct test from token reopening.
5. **Schedule/mode synchronization:** Save weekly schedule and mode changes,
   verify the UI acknowledgement and resulting server state, then verify Today
   reflects the saved schedule. Inject delay/timeout only on disposable test
   data and reconcile authoritative state before continuing.
6. **Accessibility and visual checks:** Recheck safe areas, dark/light
   appearance, scrolling, text wrapping, and controls at supported text sizes
   on both platforms. Treat this focused pass as separate from a complete
   accessibility audit.
7. **Native push, separately gated:** Only when configured for a test
   environment, validate consent, permission denial/revocation, token
   registration/rotation, account/device ownership, logout cleanup, delivery
   and receipt lifecycle on supported native builds. Never use this matrix to
   imply production push readiness without production credentials and
   operational evidence.

**Status:** Partial iOS Expo Go behavior was observed; the native UI acceptance
matrix is incomplete. On November 8, 2026, the parent verified all 52 captured
mobile files unchanged, with only two provider lifecycle test files added, and
verified both Release candidate artifact sizes and SHA-256 hashes. This source
comparison and artifact verification are complete; the matching embedded-JavaScript
candidates can be reused. Rebuild only if subsequent runtime files differ.
The `31a8` provider lifecycle coverage is implemented and reviewed (`73e83`,
no material test findings; parent-rerun 82/82 tests/typecheck; independent
8/8 lifecycle suite run), so the overall goal is blocked by stopped native
device tooling and missing physical push setup/credentials — not by provider
suite or review results. Android runtime validation, completed native account
switching, native install checks, production service validation, and
remote-push acceptance remain open; no acceptance or production claim is
made here.
