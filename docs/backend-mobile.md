# Backend and Mobile Push Integration

## Runtime and persistence

Run the backend with `npm start` (or `npm run dev` locally) on Node.js 26.x
(validated with Node.js v26.0.0). The service uses the built-in `node:sqlite`
module and stores its database under
`.data/orr_pulse.db` by default. Set `DATA_DIR` to a persistent writable
directory before starting the service. Keep the directory on durable local
storage; do not share a SQLite database over a network filesystem.

SQLite uses WAL journaling and full synchronous writes. Back up the database
using a SQLite-aware backup procedure or while the service is stopped, and
retain the associated WAL files if copying the live database files directly.
The service fails startup on an unreadable database or invalid existing legacy
store rather than silently replacing operator data.

## Legacy JSON migration and recovery

On first startup, if `.data/orr_pulse_store.json` exists in the configured data
directory and has not already been imported, its users, sessions, alerts,
journeys, quota, and compatible auth tokens are validated and imported in one
SQLite transaction. After a successful import, the original is preserved as
`orr_pulse_store.json.migrated-<timestamp>`. Keep that preserved file and a
pre-migration backup until the migrated service has been checked.

Malformed JSON or invalid required fields stop startup and leave the source
file untouched. For an import error, stop the process, preserve a copy of both
the JSON and SQLite files, inspect the reported `CORRUPT_JSON_STORE` or
`MIGRATION_FAILED` error, then correct the source or restore a known-good backup
before retrying. Do not delete or replace the database as a routine recovery
step; doing so may discard valid migrated or post-migration data.

Writes to the user/session working set are transactional. A failed write is
returned as an error, rolled back in SQLite, and restored in memory; callers
should retry only after resolving the underlying storage problem.

## Mobile device API

All routes below require the authenticated bearer token. The native client can
register or refresh a device with:

```http
POST /api/me/devices
Authorization: Bearer <session-token>
Content-Type: application/json
```

```json
{
  "expoPushToken": "ExpoPushToken[device-token-value]",
  "platform": "ios",
  "installationId": "stable-installation-id"
}
```

`platform` is `ios` or `android`. Both `ExpoPushToken[...]` and the legacy
`ExponentPushToken[...]` format are accepted. Keep `installationId` stable for
that app installation. Registration is scoped to the authenticated user and
returns sanitized device metadata; it never echoes the push token. A token or
installation already owned by another user/installation is rejected rather
than transferred. The per-user device limit is ten.

Remove the current user's device with
`DELETE /api/me/devices/:installationId`. `GET /api/me/devices` lists only that
user's active sanitized devices. These endpoint shapes are suitable for the
mobile integration; never log or persist the raw Expo token outside the
backend's device table and the mobile platform's secure storage.

Monitoring actions have terminal outcomes: `IVE_LEFT` → `LEFT`, `SKIP_TODAY` →
`SKIPPED`, and `STOP_MONITORING` → `STOPPED`. Repeating the matching terminal
action is idempotent; a conflicting action (including snoozing a terminal
session) returns `409 INVALID_SESSION_TRANSITION` with the durable status.
Leaving preserves its original departure snapshot and journey, including when
telemetry consent means no journey was recorded.

`GET /api/me/push-status` returns only the caller's counts and no token values:

```json
{
  "nativePushEnabled": false,
  "registeredDevices": 1,
  "outbox": {
    "transportEnabled": false,
    "pending": 0,
    "sent": 0,
    "failed": 0,
    "skipped": 0,
    "receiptPending": 0,
    "receiptOk": 0,
    "receiptError": 0
  },
  "deliveryDisclaimer": "SENT means accepted by the Expo push service, not delivered to the device. receiptOk indicates the platform push service accepted the message."
}
```

The exact disclaimer text may evolve; clients should render it as informational
text, not use it as a state machine. `SENT` means Expo accepted a ticket, while
`receiptOk` means the platform push service accepted it. Neither confirms that
the device displayed a notification. `PENDING`, `FAILED`, and `SKIPPED` are
outbox states; `receiptPending`, `receiptOk`, and `receiptError` are separate
ticket receipt counts.

## Push enablement and safety

Native push is disabled unless `ENABLE_NATIVE_PUSH=true` is explicitly present
at backend startup. Optional `EXPO_ACCESS_TOKEN` configures Expo push security
and is sent as a bearer credential only when push is enabled. Keep it in the
host's secret manager/environment, never in the app bundle or source control.
Disabling the flag prevents network dispatch and receipt polling; queued rows
remain pending. The backend rechecks consent, device ownership/enabled state,
and session status immediately before dispatch. Alerts use generic lock-screen
copy and do not put commute addresses in push payloads.

The outbox uses SQLite claims and bounded batches to avoid concurrent workers
sending the same row during a live claim. Transport requests have a ten-second
timeout. Transient errors use exponential retry backoff with a bounded attempt
count. A process crash after Expo accepts a request but before the ticket is
recorded can still result in at-least-once delivery after a claim expires; the
system does not promise exactly-once device delivery.

## Pilot authentication and deployment limits

Seeded pilot credentials/tokens exist for pilot compatibility and are
predictable. They are not production authentication. Before a real deployment,
replace or disable seeded access, use a production identity/authentication
system, protect the API with TLS, configure secrets outside source control, and
review rate limits, backups, retention, and operational alerts.

`GET /api/me/state` returns today's sessions newest-started first, with session
ID as a deterministic tie-breaker. A terminal session (`LEFT`, `STOPPED`,
`SKIPPED`, or `EXPIRED`) cannot be restarted for the same user, date, and
direction; the start endpoint returns `409 MONITORING_SESSION_TERMINAL`. This
preserves terminal and `LEFT` journey evidence. A later commute window/date
creates its own session.

The scheduler is an in-process timer. It only performs monitoring refreshes,
push dispatch, and receipt polling while this backend process is alive. A
single always-running backend/API instance is the supported pilot topology;
sleeping serverless instances, scale-to-zero hosting, multiple API processes,
or ephemeral filesystems are not supported. SQLite session leases protect
concurrent scheduler claims. Durable terminal session records are immutable to
stale full-store writes; the writing process reads them inside its persist
transaction and reconciles them into its working set only after a successful
commit, so a terminal-record read failure rolls the entire persist back
instead of failing after the user/profile writes already committed.
User/profile writes still use a per-process working-set snapshot. This
terminal guard does not make multiple API processes a supported topology. For
horizontal or multi-host scale, move persistence and scheduling to
infrastructure designed for distributed workers rather than sharing SQLite
over a network filesystem.

## Checks

Run `npm run test:backend` for persistence, migration, scheduler, device, outbox,
Expo wire-shape, and privacy regressions. Run `npm test`, `npm run lint`, and
`npm run build` for the existing application checks.
