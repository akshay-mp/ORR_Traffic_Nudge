# Mobile Implementation — Milestone 1 (Foundation + Flows + Pilot API)

Status: **implemented and validated** (automated checks below; automated
re-verification after the SDK 58 upgrade is recorded under "SDK 58 upgrade
evidence"). Native device validation is owned by the parent task (Expo Go 58
on iOS + Android); native SDK57 artifacts are stale after the upgrade and a
rebuild is required for SDK 58 native acceptance.

## Scope summary

A genuinely runnable React Native + Expo (SDK 58) app under `mobile/` with:

- Four bottom tabs — **Today** (decision-first: next-departure timeline and
  actions above all schedule/override detail; non-workdays show "No commute
  today" plus the next scheduled day), **Plan** (places + weekly schedules),
  **Trips** (history + corrections), **Settings**.
- A bell on Today opening the **in-app alerts** list; unacknowledged badge.
- Two clear modes:
  - **Local demo** — offline, labeled DEMO everywhere, fixtures anchored to the
    current IST date, real local edits (skip/resume today, today-only mode
    override, leave/arrive, corrections). Trip recording is an explicit opt-in
    (default OFF). No fake live labels.
  - **Pilot backend** — user-entered origin-only base URL (visible/editable),
    roster + PIN login (labeled pilot-only auth), token in SecureStore. LIVE
    data only when explicitly selected and `quota.liveApiConfigured` is true;
    connected-mode errors are surfaced, never silently replaced with synthetic
    data. GET `/api/me/state` refresh never restarts stopped/skipped sessions.
- Domain contract reused via **type-only imports** from `src/types/commute.ts`
  (erased at build → nothing outside `mobile/` is bundled; no seed PINs in the
  app). Runtime domain logic is ported into `mobile/src/services/demoEngine.ts`
  (documented adapter decision; mirrors `src/lib/commuteEngine.ts`).

## Checklist — built

- [x] Expo SDK 58 project, pinned SDK-matched deps, lockfile committed
      (`expo 58.0.23`, `react 19.3.0`, `react-native 0.88.1`,
      `expo-status-bar 58.0.4`, `expo-secure-store 58.0.2`,
      `expo-splash-screen 58.0.13`,
      `@react-native-async-storage/async-storage`,
      `react-native-safe-area-context 5.11.1`,
      `react-native-screens 4.30.1`,
      `@react-navigation/native+bottom-tabs`,
      `@expo/vector-icons 15.0.2`, `babel-preset-expo 58.0.24` as devDep —
      resolves the Metro "Cannot find module 'babel-preset-expo'" failure).
- [x] TypeScript strict; modular screens/components/services/state (no monolith).
- [x] UX: white/daylight base, navy ink, blue actions, amber timing risk;
      vertical departure→travel→arrival timeline with deadline relation;
      safe areas; dynamic type respected (no fixed font scaling off); all
      touch targets ≥ 48 units; `accessibilityRole`/`Label`/`Hint`/`State`
      throughout; dark mode follows system preference.
- [x] Demo fixtures anchored to current IST date incl. one open journey for
      the correction flow; IST-day rollover while the app is open (60s check)
      and on rehydration.
- [x] Session state machine mirrors the server: SCHEDULED/ACTIVE/SNOOZED/LEFT/
      SKIPPED/STOPPED/EXPIRED; terminal states never auto-restart on refresh;
      explicit restart re-establishes a fresh notification baseline and emits a
      new DEPARTURE_REMINDER (matches server behavior; test asserts it).
- [x] Immutable `SELECTED_OPTION` / `AT_DEPARTURE` snapshots (`Object.freeze`);
      corrections recompute metrics only.
- [x] Leaving stops departure prompts; arrival recording only when a journey
      exists (telemetry consent) and is chronologically after departure —
      invalid arrivals are rejected, never clamped.
- [x] Plan: home/work via search (demo presets / backend places) or manual
      confirmed coordinates with label (nothing geocoded from a label);
      weekly schedules with workdays, mode, window, preferred departure,
      optional deadline, separate safety buffer; validation (HH:mm, window
      order, preferred-inside-window, nonnegative bounded buffer, coordinate
      bounds, non-empty days); save updates local state or backend.
- [x] Today-only overrides (skip + one-day mode) separate from weekly plan.
- [x] Onboarding: brief welcome, sample-commute framing, explicit local trip
      recording opt-in; recommendations gated until home is set.
- [x] Telemetry opt-in controlled separately from connection and notifications.
- [x] Settings: mode, origin-only base URL (loopback/private-LAN http rule,
      no credentials/query/hash/path), roster login/logout, quota + server
      clock + liveApiConfigured status, trip recording, explicit native-push
      consent, permission/registration/server status, cleanup retry,
      demo reset with confirmation, server deletions (locations, journeys) with
      confirmation; no account-deletion/export controls (no endpoints).
- [x] API client hardening: 15s AbortController deadline spanning response
      headers and body, distinct timeout/mutation-outcome messaging, error code
      mapping (NETWORK/UNAUTHORIZED/INVALID_PIN/QUOTA_/
      PROVIDER_ERROR/SERVER_ERROR/INVALID_INPUT), actionable emulator/LAN hints.
- [x] Cache scoping: live cache keyed to origin + authenticated employee owner;
      owner metadata stays in SecureStore, and cache hydration requires both to
      match. Credential/cache writes serialize across login, logout, and origin
      changes so delayed writes cannot restore a previous account snapshot.
- [x] Plan-form isolation: drafts keyed to (mode, origin, profile id); resets
      on any owner change, preserves unsaved edits across routine refreshes.
- [x] `.env.example` for optional `EXPO_PUBLIC_API_BASE_URL` (non-secret default).
- [x] app.json/app.config content: name ORR Pulse, version 1.0.0, proposed dev
      ids `com.orrpulse.pilot` (iOS+Android), dark-mode automatic, splash via
      expo-splash-screen plugin, generated icon assets (no invented credentials).
- [x] Tests: see current evidence below; connection lifecycle and open-trip
      regressions include delayed async/storage behavior.
- [x] `.gitignore` entries for mobile artifacts (`.expo/`, `dist/`, `web-build/`,
      `ios/`, `android/`, `*.hbc`); root `tsconfig.json` excludes `mobile`
      (root still typechecks).

## Checklist — deferred (with owners/notes)

- [ ] Durable DB / server jobs / scheduler hardening — server-side, out of
      scope here (backend agent).
- [x] Native push registration — SDK58 Expo adapter, explicit acknowledged
      consent, owner-scoped registration/cleanup, token rotation and safe
      foreground/tap refresh. Delivery remains unverified and backend transport
      configuration is reported separately.
- [ ] Production authentication — explicitly out of scope; pilot PIN auth only,
      labeled as such.
- [ ] Physical-device validation (parent owns; Expo Go 58 required on both
      platforms — the current Expo Go supports only SDK 58; Metro refresh and
      first UX pass on SDK 58 to be re-done by parent after the upgrade;
      historical SDK57 native acceptance is stale and must not be claimed for
      SDK 58).
- [ ] Real BMTC live feeds, GPS tracking, guaranteed ETAs — product-level
      limitations surfaced in UI copy.
- [x] Development/preview EAS profiles and local dev-client commands documented;
      no project ID, credentials, cloud build, or distribution provisioning is
      invented or performed.

## Test evidence (all run in `mobile/`)

- `npm run typecheck` → clean (strict, includes app + tests + shared contract).
- `npm test` → **82 pass / 0 fail** in the current mobile tree (74 after native
  integration and request-body timeout regressions, +8 provider lifecycle race
  tests):
  - `connectionLifecycle` — delayed old-account response suppression, owner and
    origin cache isolation, one refresh after connected hydration, foreground
    transition detection, serialized login/logout storage races, and
    commit-boundary account changes.
  - `demoTransitions` — session lifecycle, skip/stop terminal across refresh,
    explicit restart semantics, snooze suppression, expiry, onboarding gate
    (no home → no session), today-only BMTC override, consent gating,
    chronology rejection, reset.
  - `immutableEstimates` — frozen snapshots; arrival + corrections never mutate
    originals; metrics recomputed; correction history counted; re-select keeps
    first snapshot intact; editing an open trip never invents an arrival.
  - `istRollover` — UTC→IST conversions, exact 23:59:59→00:00:01 IST rollover,
    same-day no-churn, stale session drop w/ history preserved, yesterday's
    override never leaks into today, fixture anchoring.
  - `skipPersistence` — JSON round-trip rehydration keeps skip + session
    SKIPPED; resume clears override without restarting; explicit-only restart;
    corrupted-cache fallback; onboarding acknowledgement persists.
  - `apiClient` — fetch-mocked: network, stalled post-201 response body timeout
    with abort and unconfirmed-mutation messaging, body-read failure to NETWORK,
    401 (with re-login
    hint), 429/quota, 403 pin, 502 provider, non-JSON, empty URL; happy-path
    contract parse (login + start-or-refresh shapes); URL normalization;
    actual `{ device: ... }` HTTP 201 registration normalization, rejection
    of unexpected success statuses, preserved 401 mapping, and idempotent
    revocation.
  - `nativePush` — delayed permission/token/registration/status/revocation;
      mutation serialization, persistent installation ID, stale owner cleanup,
      account/logout invalidation, and status reads that do not cancel consent.
  - `nativePushPresentation` — denial, Expo Go, missing project, cleanup, and
      error copy remain honest and never claim delivery.
  - `validation` — HH:mm, window order, preferred-in-window, optional deadline,
    bounded buffers, days, coordinate bounds, manual-location label, journey
    chronology (reject ≤ departure), PIN, base-URL origin rules incl. public
    IPv4 http rejection.
  - `planForm` — identity stability vs. mode/origin/account changes; unsaved
    edits preserved on routine refresh; reset on demo→connected switch, on
    other-employee login, and on origin change; null-profile fallback.
  - `appProviderLifecycle` — executes the actual AppProvider callbacks from
    `src/state/appStore.tsx` (see harness notes below): a delayed device DELETE
    from logout — both success and rejection — cannot unseat a newer
    origin-change + login B (in-memory connection/profile, serialized
    token/owner/live-cache writes, and push status all remain B's; exactly one
    LOGOUT and one LOGIN dispatch land); cancel-time invalidation resets
    `nativePushBusy` for logout, origin change, and login without waiting for
    the suspended permission/token boundary, and the late enable settles
    without touching busy, status, or registration; a stale enable's `finally`
    cannot clear a newer operation's busy flag; stale origin-change and stale
    login cleanups cannot overwrite the current account's push status; a stale
    login (superseded mid-cleanup) never dispatches LOGIN or persists, so only
    the newest account lands. The generation guards are mutation-checked:
    removing the stale-generation guards in `appStore.tsx` makes the
    corresponding tests fail.
- Expo SDK58 native packages were aligned with `npx expo install expo@^58.0.0
  --fix` (official SDK 58 upgrade procedure); exact resolved versions are in
  `mobile/package.json` and `mobile/package-lock.json`.
- Provider lifecycle harness (`mobile/src/test/appProviderHarness.ts`): the
  `appProviderLifecycle` tests run the real `AppProvider` — not mirrored
  logic — by transpiling the TSX through the installed tsx/esbuild toolchain
  and intercepting only platform boundary modules (`react` +
  `react/jsx-runtime`, `react-native` AppState, `services/storage`,
  `services/pilotApi`, `services/nativePushExpo` adapter factory) at the
  CommonJS loader level. The Expo adapter mock returns the real
  `NativePushCoordinator` over fake ports with per-call deferred gates
  (permission, token, device DELETE, registration, server status), so the
  provider callbacks, appReducer, ConnectionGeneration write serialization,
  and coordinator behavior all execute as production code. Deferred boundaries
  are asserted through recorded port calls, dispatch history, status/busy
  setter history, and storage operations. Honest limits: React is a minimal
  hook-cell implementation — renders and effect flushes are synchronous, with
  no concurrent features, StrictMode double-invocation, or layout/passive
  effect split; SecureStore/AsyncStorage are an in-memory map; the pilot
  backend is an in-memory fake; AppState has no real OS transitions; UI
  screens and navigation are not rendered. Real React reconciliation and
  on-device push delivery remain parent-owned validation.
- Native integration verification (2026-11-08, **SDK 57 — historical; superseded
  by the SDK 58 upgrade evidence below**): 72 tests pass; TypeScript
  typecheck passes; `npx expo install --check` reports dependencies up to date;
  iOS and Android exports both complete; Expo Doctor passes 21/21 checks.
- A fresh isolated backend round-trip using the actual `pilotApi` passes
  registration over HTTP 201 with the backend's `{ device: ... }` response,
  cross-account device isolation, profile/journey edits, and persisted state
  after closing and reopening the test server. It uses a temporary database
  and proves the HTTP client/backend contract only—not native delivery.
- Public Expo config resolves SDK 58 with no EAS project ID configured; the
  notifications plugin is present. No cloud/distribution build or device push
  validation was performed.
- Root `npm run lint` (tsc) still passes with `mobile` excluded.

## SDK 58 upgrade evidence (2026-11-08)

Upgrade from SDK 57 (`expo 57.0.32`, `react 19.2.3`, `react-native 0.86.3`) to
SDK 58 so physical-device testing works with the current Expo Go, which
supports only SDK 58. Procedure followed the official Expo guidance
(expo.dev/blog "How to upgrade to SDK 58") rather than a manual
`npm install` bump: the official command is a single
`npx expo install expo@^58.0.0 --fix` (upgrades `expo` and aligns every
SDK-managed dependency), followed by `npx expo-doctor@latest`. No
`--force`, `--legacy-peer-deps`, or version overrides were used; the upgrade
and all checks ran from `mobile/` only.

Actual resolved versions after the upgrade (`mobile/package-lock.json`):

- `expo 58.0.23`, `react 19.3.0`, `react-native 0.88.1` (RN 0.86 → 0.88
  includes 0.87 + 0.88 changes), `@types/react 19.3.0`,
  `babel-preset-expo 58.0.24`, `typescript 6.0.3` (unchanged),
  `expo-constants 58.0.15`, `expo-crypto 58.0.7`, `expo-dev-client 58.0.18`,
  `expo-device 58.0.5`, `expo-font 58.0.11`, `expo-notifications 58.1.8`,
  `expo-secure-store 58.0.2`, `expo-splash-screen 58.0.13`,
  `expo-status-bar 58.0.4`, `expo-system-ui 58.0.7`,
  `react-native-safe-area-context 5.11.1`, `react-native-screens 4.30.1`.
- SDK-mapped and unchanged: `@expo/vector-icons 15.0.2` and
  `@react-native-async-storage/async-storage 2.2.0` match the SDK 58 mapping.
- React Navigation remains unchanged: `@react-navigation/native 7.5.1` /
  `bottom-tabs 7.21.0` (caret ranges; no SDK 58 incompatibility reported by
  `expo install --check` or expo-doctor).

Breaking-change review against the official SDK 58 changelog/blog:

- Removed RN APIs (`InteractionManager`, `Touchable` root export, `Modal`
  `animated` prop, deprecated `StatusBar` props) and `ImageBackground`: none
  used (verified by grep over `mobile/src`, `App.tsx`, `index.ts`; the app
  uses `animationType`, not the removed `animated`).
- Strict TypeScript API default (RN 0.88): no deep
  `react-native/Libraries/*` imports exist. One real incompatibility surfaced:
  `AppState.currentState` is now `string | null | undefined`, which failed
  typecheck at the `shouldRefreshOnResume(previous, next)` call. Fixed
  minimally in `mobile/src/state/appStore.tsx` by coalescing the initial
  state (`NativeAppState.currentState ?? 'unknown'`); the pure helper's
  `string` contract and its tests are unchanged. A null/unknown prior state
  still counts as "not active", preserving resume-refresh semantics.
- Expo Router / native tabs / web `server` output: not applicable (React
  Navigation directly, no web target beyond export validation).
- iOS scene lifecycle / `expo-build-properties` `ios.enableSceneSupport`:
  not applicable (CNG project, no `ios/` directory committed, no
  build-properties plugin).
- Config plugins in `app.json` (`expo-status-bar`, `expo-secure-store`,
  `expo-font`, `expo-splash-screen`, `expo-notifications`) all remain valid
  plugin names on SDK 58 (expo-doctor validates the config).
- macOS: SDK 58 does not support it; not a target here.

Checks (all from `mobile/`, after the upgrade):

- Baseline before upgrading: `npm test` 82/82 pass, `npm run typecheck` clean
  on SDK 57.
- `npm test` → **82 pass / 0 fail** on SDK 58 (same suite; explicit consent,
  account-generation guards, full-body request deadlines, and Expo Go
  unsupported-push capability checks all still asserted and passing).
- `npm run typecheck` → clean after the one `AppState` adaptation above.
- `npx expo install --check` → "Dependencies are up to date".
- `npx --yes expo-doctor` → 20/20 checks passed (SDK 58 doctor runs 20
  checks; the earlier 21/21 was the SDK 57 doctor).
- `npm run export:ios` and `npm run export:android` → both complete and emit
  fresh Hermes bundles under `mobile/dist/` (gitignored).

Limitations:

- Historical SDK57 native artifacts (prior dev-client/native builds,
  `dist/` bundles, and any prior native validation evidence) are stale after
  the dependency upgrade; a native rebuild for SDK 58 (`npx expo run:ios` /
  `run:android` or EAS) is required before any SDK 58 native acceptance can
  be claimed. None is claimed here.
- The Metro session on port 8092 is parent-owned and was not restarted or
  killed; the parent must refresh the QR (restart Expo on their side) since
  SDK 57 Metro state predates the upgrade.
- No commits, pushes, devices, simulators, or cloud builds were performed.

## Parent-review fixes incorporated

1. AbortController deadline spans response headers and body (15s), with
   distinct timeout and unconfirmed-mutation messaging.
2. Base URL validated as a bare origin (no credentials/query/hash/path);
   plain http limited to loopback + RFC1918 private LAN.
3. Live cache scoped to origin+account; cleared on logout/URL change.
4. Plan-form drafts keyed to data-owner identity (no cross-account leaks,
   no refresh clobber).
5. Journey chronology: arrival ≤ departure rejected in UI and reducer.
6. babel-preset-expo added as explicit devDependency (Metro transformer fix).
7. Today redesigned decision-first (hero timeline/actions; details and
   today-only controls moved into collapsible "Change today's plan";
   non-workday "No commute today" + next scheduled day).
8. Onboarding copy made user-facing and brief; demo trip recording opt-in
   default OFF (fixtures + tests updated).
9. Trip detail derives the record from the store by id, so a saved correction
   immediately replaces the "(still missing)" arrival label while the
   immutable original estimate display is retained.
10. 401 responses keep the backend message and append an explicit
    "Please log in again from Settings." hint (test asserts it).
11. Login validates the draft origin and binds that origin, token, employee
    owner, profile, and cache in one guarded account transition; every live
    response checks its captured generation at the state-commit boundary.
12. Restored live cache is owner-scoped and writes are serialized across
    account transitions. Connected edits persist through the same cache path.
13. Connected state refreshes after every hydration (including valid cache
    restores) and at bounded foreground intervals; a missing profile shows
    loading, retry, or the backend error
    rather than an empty decision area. Session provenance reflects the
    returned session, and changing the selector is labeled as next-request-only.
14. Today uses the current IST date instead of a cached server-clock date;
    demo monitoring advances while foregrounded, while terminal sessions stay
    terminal. Open-trip edits preserve a missing arrival.
15. Successful-edit feedback waits for API success and displays request errors;
    Today no longer applies a second top safe-area inset. Settings copy avoids
    storage implementation claims and duplicate IST suffixes.

## Known issues / notes

- `expo export` writes Hermes bytecode (`*.hbc`) artifacts under `dist/` —
  gitignored; produced only for validation.
- The Android emulator hostname guidance (10.0.2.2) is embedded in Settings
  hints and network error messages.
- In connected mode, acknowledging server alerts is not offered (no server
  endpoint); demo acknowledgement is local.
- Startup cache migration from pre-owner-scoped snapshots may discard the old
  cache and reload `/api/me/state`; if that request fails, Today now presents a
  retryable error instead of silently omitting the profile and schedule.
