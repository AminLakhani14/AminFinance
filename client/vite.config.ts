import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Linked workspace package ships TS source, not a build. Excluding it from
    // pre-bundling lets Vite transpile it through the normal pipeline, so
    // editing a shared DTO hot-reloads instead of needing a rebuild.
    exclude: ['@aminfinance/shared'],
  },
  server: {
    port: 5173,
    // Proxy /api and /ws to the Fastify server so the browser sees one origin
    // in dev — no CORS preflight, and cookies/headers behave as in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
      '/health': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
  build: {
    // Budget from PROJECT_PLAN.md §8: initial JS under 250kb.
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        // Function form, not the string-array form: entries like 'react-dom'
        // only match that exact specifier, so `react-dom/client` (what we
        // actually import) silently lands in the app chunk instead. Matching
        // on resolved paths keeps vendor code in stable, cacheable chunks that
        // don't churn every time app code changes.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          if (id.includes('react-router')) return 'router';
          if (/@reduxjs|react-redux|[\\/]redux[\\/]|immer/.test(id)) return 'redux';
          if (/framer-motion|motion-dom|motion-utils/.test(id)) return 'motion';
          return undefined;
        },
      },
    },
  },
});
