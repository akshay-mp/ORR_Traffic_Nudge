# ORR Pulse — Release Readiness

This checklist distinguishes implemented pilot behavior from release evidence.
It is not a release approval. **Present** means supported by the current mobile
implementation notes and the parent task's reported checks; it does not imply
production readiness. **Unverified** means evidence is incomplete. **Missing**
means the capability or release artifact is not available in the cited scope.
Backend and mobile repairs are active as of November 8, 2026. The backend
repair `2df` for the `c27` findings has been independently re-reviewed
(`3f210`, no material findings), the mobile `19f` runtime repairs for the
three `637` P2 findings have been independently re-reviewed at runtime
(`772b`, no material findings), and the `31a8` provider lifecycle regression
coverage has since been implemented and reviewed (`73e83`, no material test
findings, including an independent 8/8 lifecycle suite run; parent-rerun
82/82 mobile tests with typecheck passing). Checkpoints below are dated and
superseded results are kept only as history. The provisional build manifests
have been compared against the reviewed source and both candidate artifacts
verified (sizes and SHA-256 hashes matching provenance), so no runtime
rebuild is needed; a rebuild is required only if runtime files later differ.
What remains outstanding is not provider suite/review: native device tooling
(stopped after failures) and physical push setup/credentials, plus the open
native acceptance items below.

## Present

- [x] **Core app surface:** Today, Plan, Trips, and Settings tabs; weekly
  schedules, home/work places, today-only skip/mode overrides, manual trip
  recording controls, history, and correction flows are described in
  `docs/mobile-implementation.md` and `mobile/README.md`.
- [ ] **Estimate integrity and provenance — runtime repair re-reviewed:** Local offline mode is labeled
  DEMO; connected mode only claims LIVE when explicitly selected and the server
  reports live API configuration. Connected errors are surfaced, not silently
  replaced with demo data. Corrections preserve original estimate snapshots.
  Evidence: `docs/mobile-implementation.md`, `mobile/README.md`; the related
  `637` deadline repair was runtime re-reviewed (`772b`, no material findings).
- [ ] **Consent and account-scoped cache — runtime repair re-reviewed:** Trip recording is opt-in;
  cache is scoped by backend origin and account and cleared on logout/origin
  change. Non-secret cache and SecureStore token responsibilities are
  documented in `docs/mobile-implementation.md` and `mobile/README.md`. The
  stale-logout race found in review was repaired in `19f` and runtime
  re-reviewed (`772b`, no material findings); the repeatable regression
  coverage (`31a8`) has since landed and passed review (`73e83`, no material
  test findings; parent-rerun 82/82 tests/typecheck, independent 8/8
  lifecycle suite run). On-device cache-isolation checks remain part of the
  open acceptance matrix below.
- [ ] **Mobile test/build checkpoints (dated):** Historical: an earlier source
  checkpoint reported 48 tests, TypeScript typecheck, iOS/Android Expo exports,
  and Expo Doctor 21/21, and an interim parent `npm test` stalled in
  `nativePush.test.ts` and was stopped — both superseded; neither is a current
  result. On November 8, 2026, a native-integration handoff independently
  reported 72 tests and typecheck passing (`docs/mobile-implementation.md`);
  that 72-test result is also superseded and is not the latest. The mobile
  repair `19f` handoff checkpoint — 74 tests, TypeScript typecheck, and both
  iOS and Android exports; the parent independently reran the full 74 tests
  and typecheck, the 11 API-client tests including the stalled-201-body
  deadline case, and `npx --yes expo-doctor` passed 21/21 on the current
  mobile source — is likewise superseded and kept only as history. Latest
  checkpoint: the `31a8` provider lifecycle regression coverage is
  implemented (two provider lifecycle test files added over the unchanged
  captured runtime files); the parent independently ran the full mobile
  suite at 82/82 tests with TypeScript typecheck passing, and the Astra
  review `73e83` found no material test findings and independently reran the
  provider lifecycle suite at 8/8 passing. These are worker/parent
  checkpoints only, not acceptance: the `19f` runtime repairs are
  independently re-reviewed (`772b`, no material findings) and the `31a8`
  coverage is reviewed (`73e83`).
- [x] **Reported iOS pilot smoke:** Parent reports Expo Go onboarding,
  location, login, and correction checks on iOS. This is Expo Go validation,
  not a native installable build or store-signing proof. Device UI work on
  both platforms was later stopped after tooling failures, and no new device
  UI testing has been authorized or run since.

## Unverified — pilot acceptance gates

- [ ] **Complete approved flows on both platforms:** On installable native
  builds, test all four tabs; schedule create/edit; skip and one-day mode
  override; manual start/leave/arrive; correction and history; DEMO/LIVE state
  and failure labels; consent prompts; account switching; offline and recovery.
  Record OS/device, build ID, steps, result, and evidence. Both device
  platforms stopped after tooling failures: Android screenshot tooling failed
  twice and iOS interaction was stopped per the device-tool retry rule during
  account-switch PIN entry. No new UI testing was authorized after that, so the
  Android matrix and completed native account-switch validation remain open
  gaps. Next: restore supported device screenshot/control tooling, then run
  and record the matrix on both platforms.
- [ ] **Manual recording and estimate preservation:** Exercise a full recorded
  trip and edits on device; verify recording is off until consent, chronology
  is enforced, original selected/departure estimates remain unchanged, and
  only observed trip metrics/correction history change. Unit tests alone do
  not establish the complete on-device flow.
- [ ] **Provenance and isolation under failure:** On device, switch DEMO ↔ LIVE,
  force unavailable/partial/error responses, switch accounts and server
  origins, then go offline and reconnect. Confirm no stale/cross-account cache
  is shown as current LIVE data and no failure silently falls back to synthetic
  data. Automated tests are useful evidence but not this end-to-end check.
- [ ] **Durable server state and background work:** On November 8, 2026,
  after backend repair `2df` and its independent re-review `3f210`, the parent
  independently reran the backend suite: 32/32 suites and 385 assertions
  passing, with root lint and build passing (a pre-existing Vite `__dirname`
  warning remains). The original baseline was 6/6 suites and 33 checks. These
  supersede the dated 29/29-suite/313-assertion checkpoint, which is kept only
  as history. The parent also reran the coordinator roundtrip harness
  (`/tmp/orr-coordinator-roundtrip.ts`) against the repaired backend: the
  actual mobile `NativePushCoordinator` — with only native notification and
  secure-storage ports mocked — through the actual `pilotApi` against an
  isolated backend passed registration, honest server-disabled push status,
  and revocation, and the actual client showed schedule, consent, feedback,
  and device persistence after service close/reopen with immutable estimate
  snapshots, account scope, token-reuse rejection with `409`, and
  invalid-token `401`. None of this is release acceptance or proof of native
  push delivery; see `docs/native-validation.md`. It does not prove native UI
  account isolation, device restart recovery, or delivery/receipt.
- [ ] **Latest backend Astra review findings — repaired and re-reviewed:** The
  `c27` P2 findings — the terminal reconciliation path performing its
  SELECT/parse after commit, and `suite25a` missing the true stale-ACTIVE and
  same-status evidence cases — were repaired in `2df` and independently
  re-reviewed by `3f210` with no material findings. Reviewed evidence:
  `persistStore` now reads and parses the durable terminal session records
  (SELECT and `JSON.parse`) inside the persist transaction and applies the
  prepared reconciliation to memory only after a successful commit; suite `28`
  injects an unparseable terminal record and confirms the whole persist rolls
  back — the API write is rejected with `500 PERSISTENCE_FAILED`, a direct
  store call throws `StoreError` `PERSIST_FAILED`, the profile write is rolled
  back, memory is restored to the pre-mutation value, and a repaired record
  restores writes end to end; suites `25b` and `25c` exercise a real
  stale-ACTIVE cross-handle conflict and a stale same-status LEFT copy with
  altered departure evidence, confirming durable LEFT records, journeys, and
  departure snapshots are preserved while valid nonterminal writes still
  commit. The earlier `c06b9b48` findings — terminal-action interleavings,
  push-receipt generation reset on re-register, and expiry during provider
  computation — were reviewed as repaired earlier, and the alternate endpoint
  is guarded. This clears the backend repair blockers only; passing suites
  and HTTP harnesses are still not release acceptance.
- [ ] **Latest mobile Astra review findings — runtime repair and coverage
  re-reviewed:** The mobile findings review `637` found three P2 issues:
  a stale logout that completes after an await can clear a newer login; a cancellation can leave
  push status stuck busy; and the request deadline stopped at
  response headers rather than covering the body. Mobile repair `19f` reports
  these fixed (74 tests/typecheck/exports, parent-rerun API-client tests), and
  the Astra runtime re-review `772b` found no material findings for the
  repairs. Reviewed runtime evidence: with mocked hooks/coordinator/storage,
  actual app provider-callback checks preserved the other account's
  UI/status/credentials after stale logout and origin cleanup, handled
  success/rejection and stale-login cleanup, and confirmed the busy-state
  reset and the stale `finally` path are correct; the 11 API-client tests
  independently pass, including the deadline case where `fetch`/body ignores
  abort. The parent also independently ran the full 74 tests and typecheck.
  Both runtime files are unchanged and match `provenance.json`. The
  persistent provider regression coverage `31a8` has since landed: two
  provider lifecycle test files were added over the unchanged captured
  runtime files, the parent independently ran the full mobile suite at
  82/82 tests with typecheck passing, and the follow-up Astra review
  `73e83` found no material test findings and independently reran the
  provider lifecycle suite at 8/8 passing. This gate stays open only for
  the remaining acceptance evidence (on-device checks), not for provider
  suite or review.
- [ ] **Native consent and push-token lifecycle:** Verify native permission
  request only after clear consent, token registration bound to the correct
  account/device, refresh/rotation, logout/revocation, reinstall, denied and
  revoked permissions, and backend delivery/receipt behavior. App settings
  currently describe in-app alerts and no remote push (`mobile/README.md`);
  registration plus delivery is not established by bundle exports.
- [ ] **Build and install proof:** `mobile/app.json` defines iOS bundle ID and
  Android package `com.orrpulse.pilot`; this is configuration, not proof of
  installable native artifacts. Existing release-candidate artifacts are
  recorded in `/Users/akshaymp/Projects/ORR_Pulse_Builds/repair-20261108/provenance.json`: an Android
  Release APK with embedded JavaScript but a debug certificate, and an iOS
  Release simulator build with embedded JavaScript, ad-hoc linker signing,
  and no provisioning profile. These provisional builds include the `19f`
  runtime repairs, which are
  runtime re-reviewed (`772b`, no material findings) with both runtime files
  unchanged and matching `provenance.json`; the `31a8` provider lifecycle
  regression coverage is implemented and reviewed (`73e83`). Their full
  source manifest has been compared with the reviewed source: all 52
  captured mobile files unchanged, only the two provider lifecycle test
  files added, and both artifact sizes and SHA-256 hashes match
  `provenance.json` — candidate source/artifact verification is complete,
  no runtime rebuild is needed, and a rebuild is required only if runtime
  files later differ. Build signed or appropriately installable Android and iOS
  binaries from a clean checkout, install each on target devices, launch,
  exercise core flows, and retain artifact/build provenance. `expo export`
  produces JS bundles and does not satisfy this gate.
- [ ] **Mobile integration and review — runtime and coverage reviewed:**
  The prior mobile checkpoint was the `19f` repair handoff (74 tests,
  typecheck, both exports; parent-rerun full 74 tests and typecheck, 11
  API-client tests; Expo Doctor 21/21), and the Astra runtime re-review `772b`
  found no material findings for the three `637` repairs, with both runtime
  files unchanged and matching `provenance.json`. The latest checkpoint is
  the `31a8` provider lifecycle coverage: parent-rerun 82/82 mobile tests
  and typecheck passing, and the Astra review `73e83` found no material
  test findings with an independent 8/8 lifecycle suite run. With the
  backend repaired, re-reviewed (`3f210`), and parent-rerun clear (32/32
  suites, 385 assertions), a reviewed combined mobile/service source
  checkpoint exists. Acceptance remains open on the native/device gates
  (native install, Android UI, native account switching, physical push
  delivery), not on provider suite or review.
- [ ] **Local host availability:** Validate client connectivity, process restart,
  database recovery, and actionable offline errors for the local pilot.
  A production HTTPS deployment remains a separate limitation. The pilot uses a
  user-entered origin; a local Mac-hosted service only runs while that host and
  process are available. The Mac must remain awake for local execution;
  keep-awake prevents idle sleep but does not run code while the Mac is actually
  asleep. Point in time: an isolated local pilot API is currently running at
  `127.0.0.1:3011` on the reviewed backend with existing temporary test data
  (scheduler and push disabled); see `docs/native-validation.md`. That is a
  local service state, not an availability guarantee.

## Production limitations — separate authorization required

The following items do not redefine the requested local pilot acceptance scope.
Deployment, store submission, and production account rollout require separate
authorization. They remain limitations to disclose when demonstrating the pilot.

- [ ] **Production authentication and account lifecycle:** The documented
  roster/PIN login is explicitly pilot-grade, not production authentication
  (`mobile/README.md`). Provide and validate production identity/authentication,
  secure session lifecycle, account recovery, and required export/deletion
  controls before a production release. Pilot demonstrations must retain the
  documented roster/PIN limitations.
- [ ] **Production provider credentials and live-data readiness:** No evidence
  here establishes production provider credentials, quota/billing ownership,
  provider terms, monitored live-feed quality, or operational fallback. Verify
  these server-side; a LIVE toggle or configured flag is not provider
  readiness.
- [ ] **Remote push service:** Push credentials, platform entitlements,
  delivery service, and end-to-end delivery validation are not evidenced;
  alerts remain in-app until the full native/server lifecycle is implemented
  and verified.
- [ ] **Store release setup:** Store signing/provisioning, production build
  profiles, privacy disclosures, support/contact and release metadata, and
  store-submission checks are not evidenced. `mobile/app.json` contains app
  identifiers but no proof these release requirements are complete.

## Prioritized integration order

1. The backend `c27` repair `2df`, the mobile `19f` runtime repairs, and the
   `31a8` persistent provider regression coverage are complete and
   independently reviewed (`3f210`, `772b`, and `73e83`, no material
   findings; parent-rerun backend 32/32 suites/385 assertions and mobile
   82/82 tests/typecheck with an independent 8/8 lifecycle suite run), so no
   provider suite/review blocker remains. The overall goal is currently
   blocked by stopped native device tooling and missing physical push
   setup/credentials: restore supported device tooling and push credentials
   before acceptance testing.
2. Verify durable SQLite behavior, jobs/leases, and push outbox with restart,
   retry, and idempotency scenarios; keep remote delivery marked unavailable
   until credentials and end-to-end receipt are proven.
3. The provisional Android/iOS build manifests have been compared against
   the independently reviewed source (all 52 captured mobile files
   unchanged, only two provider lifecycle test files added; both artifact
   sizes and SHA-256 hashes match provenance), so the candidates are
   verified with no runtime rebuild needed — rebuild only if runtime files
   later differ. Next: complete Android device validation and repeat the
   approved critical-flow matrix on both platforms.
4. Run the repaired mobile and backend revisions together and record login,
   account/origin isolation, schedule and trip edits, and correction persistence
   across app relaunch and server restart. Verify native permission and device
   registration through outbox processing; when credentials permit, record an
   actual device receipt. Otherwise keep remote delivery explicitly blocked.
5. Report production auth, provider credentials/live-data operations, hosting,
   and store setup as separate release limitations. Do not deploy or submit to
   stores without separate authorization.

**Pilot decision:** Acceptance remains open on current evidence.
The backend `c27` findings are repaired (`2df`) and independently re-reviewed
(`3f210`, no material findings), the mobile `637` findings are repaired in
`19f` and runtime re-reviewed (`772b`, no material findings, runtime files
matching provenance), and the `31a8` provider lifecycle regression coverage
is implemented and reviewed (`73e83`, no material test findings; parent-rerun
82/82 mobile tests/typecheck; independent 8/8 lifecycle suite run). The
November 8, 2026 checkpoints pass — backend 32/32 suites/385 assertions with
root lint/build, the coordinator roundtrip through the actual `pilotApi`,
and the parent-rerun mobile 82/82 tests/typecheck — and candidate
source/artifact verification is complete (all 52 captured mobile files
unchanged, only two provider lifecycle test files added; artifact sizes and
SHA-256 hashes matching provenance), so no runtime rebuild is needed;
rebuild only if runtime files later differ. The overall goal is blocked by
stopped native device tooling and missing physical push setup/credentials —
not by provider suite/review results. Native install checks, Android UI
verification, completed native account switching, and physical push delivery
remain open. Production release and operations are separate, unapproved
work.

## Native toolchain checkpoint

Two kinds of native build evidence exist; neither satisfies final acceptance.
Historical (superseded): isolated snapshot builds from earlier Debug
toolchain proofs — an Android debug-signed APK and an iOS Simulator Debug app
— both Metro-dependent with no embedded JavaScript; see
`docs/android-build-toolchain.md` and `docs/ios-build-toolchain.md` for
artifacts, hashes, logs, and reviewed limits. Current release candidates:
per `/Users/akshaymp/Projects/ORR_Pulse_Builds/repair-20261108/provenance.json`, an Android Release APK
with embedded JavaScript signed with a debug certificate and an iOS Release
simulator build with embedded JavaScript, ad-hoc linker signing, and no
provisioning profile. Both provisional builds include the `19f` runtime
repairs, runtime re-reviewed
by `772b` with no material findings; both runtime files are unchanged and
match `provenance.json`. The `31a8` provider lifecycle regression coverage
is implemented and reviewed (`73e83`), and the full source-manifest
comparison is complete: all 52 captured mobile files unchanged, only the
two provider lifecycle test files added, and both artifact sizes and
SHA-256 hashes match provenance — the candidates are verified, no runtime
rebuild is needed, and a rebuild is required only if runtime files later
differ. Neither set
of artifacts proves physical-device installation, store signing, or push
delivery. Final builds must use the reviewed, repaired source and an isolated
lockfile installation with embedded JavaScript where standalone behavior is
required.
