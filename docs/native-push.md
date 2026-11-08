# Native push integration

The mobile app now has an explicit-consent native push path for Expo SDK 57.
It registers this installation with the pilot backend; it does not provision
credentials, enable server transport, or prove that a notification was
delivered to a device.

## Runtime and build setup

`mobile/package.json` uses Expo SDK57-compatible modules installed with
`npx expo install`: `expo-notifications` `~57.0.25`, `expo-device`,
`expo-constants`, `expo-crypto`, `expo-secure-store`, and `expo-dev-client`.
The notifications config plugin is enabled in `mobile/app.json`. Native
notification modules are dynamically imported only after runtime capability
checks; Expo Go and unsupported platforms do not import `expo-notifications`.

Set `EXPO_PUBLIC_EAS_PROJECT_ID` only to the actual EAS project ID. The app
does not include a placeholder project ID or credentials. Without a configured
project ID, registration reports a setup state and does not request permission
or ask for a token. Expo Go and simulators are reported as unsupported by this
adapter; use a development/preview build on a physical device. Build commands
and profiles are in `mobile/README.md` and `mobile/eas.json`.

Android creates the `default` notification channel before checking/requesting
permission. The Expo adapter uses SecureStore for the stable random
installation ID and owner/cleanup metadata, and Expo Crypto for random bytes.
Raw Expo push tokens exist only in the registration request and are never
stored in app state, cache, or ownership metadata.

## Consent and registration

Settings is the only entry point for enabling push. The deliberate action first
updates `/api/me/profile` with `pushOptIn: true` and waits for the returned
profile before requesting OS permission. It then obtains the Expo token and
registers this installation with `POST /api/me/devices`; only HTTP `201` is a
successful registration. Permission grant alone is not reported as enabled.
If profile consent cannot be acknowledged, token registration does not start.

The Settings status separates:

- OS permission state (read-only status checks do not prompt).
- This installation's backend registration state.
- Backend native-push transport availability from `GET /api/me/push-status`.

`GET /api/me/devices` is used to confirm this installation specifically.
`DELETE /api/me/devices/:installationId` treats `200` and `404` as successful
idempotent revocation. All requests carry the active owner's bearer token and
API origin through the same bounded HTTP client used elsewhere in the app.
The status UI and notification copy never claim “delivered”; Expo ticket and
receipt states are not device-delivery evidence.

Turning consent off first acknowledges `pushOptIn: false`, then revokes the
installation. If profile update fails, device revocation is still attempted
and the profile error remains visible. In-app/demo alerts remain independent
of OS permission and native push.

## Account and lifecycle safety

`NativePushCoordinator` serializes enable/disable mutations and their secure
storage writes. Installation ID creation is inside that serialized boundary,
so simultaneous enables cannot create different installation IDs. Status
reads use a separate read generation and wait for current mutations; they
cannot cancel an explicit registration. Permission/token waits are cancellable
on logout/account transition so a delayed permission prompt cannot block
cleanup. A pending POST is not abandoned: its bounded response is reconciled,
and a stale successful registration is revoked before another mutation runs.

Logout and origin/account changes invalidate pending registration work and
attempt DELETE with the old account credentials before those credentials are
discarded. A failed or ambiguous request persists owner-scoped pending cleanup
metadata without the bearer token or Expo token. It is never transferred to a
different account. The UI exposes cleanup retry while signed in as the owner;
if the old owner's credentials are no longer available, sign in to that same
account/origin to retry cleanup before enabling another account. The backend
also rejects cross-user installation ownership.

Expo token-rotation callbacks re-register only when the currently connected
profile has acknowledged push consent, and they do not prompt for permission.
Foreground notification receipt and notification taps refresh the currently
connected account's `/api/me/state`; notification payload identity is ignored.
The client does not display payload content in its own UI. The current backend
notification copy is generic and omits route, ETA, and location values.

## Validation and limits

Coordinator tests use delayed permission, token, registration, status, and
revocation responses to cover cancellation, stale cleanup, storage ownership,
stable installation identity, status-read isolation, account transitions,
and honest error/setup UI copy. API tests exercise the backend's actual
`{ device: ... }` response body and normalize a checked HTTP `201` to the
coordinator contract, while preserving authentication failures and idempotent
`404` deletion. A separate fresh-database HTTP round-trip also confirms that
real client registration succeeds and remains account-scoped after a server
restart. These checks do not validate native module linking,
permission dialogs, physical-device token acquisition, EAS project
provisioning, FCM/APNs credentials, deployed server transport, or push
delivery. No distribution build or live notification delivery was performed
as part of this integration.
