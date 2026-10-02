# AminFinance — Android app

A React Native (Expo) app that runs the AminFinance web frontend, unchanged,
with the same look and features as the website. It talks to the deployed
backend at `https://aminfinance-backend.onrender.com`.

## How it works

- `client/` is not modified. `npm run build:web` builds it with
  `web/vite.config.ts` and the environment in `web/.env`, into `web-dist/`.
- The Android build copies `web-dist/` into the APK (`assets/www`), and the
  WebView serves those files at `http://localhost:5173` through a small native
  hook in `patches/react-native-webview+*.patch` (re-applied on every
  `npm install`). There is no server and nothing to download: the app opens
  offline, and only market data, AI and sync need the internet.
- `http://localhost:5173` is deliberate: it is a secure context (so sign-in,
  storage and `crypto.randomUUID` work) and it is already in the backend's
  CORS list.
- `App.tsx` adds what a browser would provide: the back button, external
  links in the phone's browser, and exports (Excel, PDF, CSV) via Android's
  share sheet.
- `plugins/withAminFinance.js` wires the above into the generated Android
  project on every `expo prebuild`. `android/` is generated — do not edit it.

## Setup (once)

1. Install the repository's dependencies from the root: `npm install`
   (the web build uses `client/`'s packages).
2. In `mobile/`: `npm install`.
3. Copy `web/.env.example` to `web/.env` and fill in the API key and the
   Supabase values (the same as `client/.env`).
4. A JDK 17 and the Android SDK. `scripts/setup-android-toolchain.sh` installs
   both into your home folder without admin rights (run it from Git Bash);
   or set `JAVA_HOME` and `ANDROID_HOME` to existing installs.

## Build the APK

```bash
cd mobile
npm run build:apk
```

The APK lands in `mobile/dist/AminFinance-<version>.apk`. Install it by
copying it to the phone and opening it (allow "install unknown apps" for the
file manager or browser you open it from).

For a new version, raise `version` and `android.versionCode` in `app.json`.

## Keep safe

`mobile/keystore/` holds the release signing key and its password. It is
created on the first build and is gitignored. Back it up: Android installs an
update over the existing app only when both are signed with the same key.
Without it, the app has to be uninstalled first — which deletes the data
stored on the phone that is not synced to the cloud.

## Data on the phone

Each install keeps its own local data, like each browser does. Sign in with
the same account as on the web to pull your cloud-synced portfolio and
expense entries.
