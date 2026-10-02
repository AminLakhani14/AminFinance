/**
 * Builds the web frontend in ../../client into the Android app — unchanged.
 *
 * The app shows the same React frontend the browser does, so it looks and
 * behaves the same. Nothing in client/ is edited: this config points Vite at
 * client/ as its root and only changes what differs on a phone —
 *
 *  - environment: read from mobile/web/.env, so the app talks to the deployed
 *    backend (VITE_API_URL) whatever client/.env says for local development;
 *  - output: written to mobile/web-dist, which the Android build copies into
 *    the APK's assets/www, where the native WebView serves it from
 *    http://localhost:5173 (see patches/react-native-webview+*.patch).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const clientDir = fileURLToPath(new URL('../../client', import.meta.url));

export default defineConfig({
  root: clientDir,
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../../client/src', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('../web-dist', import.meta.url)),
    emptyOutDir: true,
    // Served from the APK, not over a network: one large chunk costs nothing
    // to download, so the size warning tuned for the web build is noise here.
    chunkSizeWarningLimit: 5000,
  },
});
