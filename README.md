# ORR Traffic Nudge

ORR Traffic Nudge is a commute-planning pilot for Bengaluru's Outer Ring Road.
The repository includes a web/backend project and the ORR Pulse Expo mobile app.

## Run the web/backend project

From the repository root:

```bash
npm install
npm run dev
```

The development server runs locally. Keep the host awake and the process
running while using services hosted on that machine. A keep-awake setting can
prevent idle sleep, but code does not execute while the computer is actually
asleep.

## ORR Pulse mobile app

See the [mobile setup and architecture guide](mobile/README.md). The app can be
run independently in local demo mode, or optionally connected to the pilot
backend started above:

```bash
cd mobile
npm ci
npm run typecheck
npm test
npm start
```

Open the Expo development server with a compatible Expo Go client. In local
DEMO mode, the app works offline with labeled synthetic estimates and
on-device trip data; it does not represent live traffic. Connected pilot mode
uses the configured server and only labels provider data LIVE when the server
reports live API availability. The seeded roster/PIN login is pilot-grade, not
production authentication.

For a physical phone, configure a reachable LAN address for a local server
(same network, with firewall access) or an HTTPS service origin; `localhost`
on the phone refers to the phone itself, not your development computer. Keep a
locally hosted server's computer awake and its process running during use.

Expo platform exports produce JavaScript bundles, not installable native app
binaries. Native builds and installation/device validation are separate tasks.
Remote push is not yet integrated and verified end-to-end in the mobile app;
do not treat in-app alerts as remote delivery.

## Project notes

- [Mobile implementation notes](docs/mobile-implementation.md)
- [Backend/mobile integration notes](docs/backend-mobile.md)
- [Release readiness checklist](docs/release-readiness.md)
