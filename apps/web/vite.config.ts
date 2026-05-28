import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Vite dev server proxies /api/* to the api container at request time.
      // The target is SERVER-SIDE (Vite resolves it from inside the web
      // container) so we use the Docker compose hostname `api:3000`.
      //
      // IMPORTANT: do NOT reuse VITE_API_BASE here — that one is BAKED INTO
      // the browser bundle (import.meta.env) and needs to be a hostname the
      // BROWSER can resolve (e.g. http://localhost:3000 or empty for
      // same-origin). Mixing the two would either break the proxy or break
      // browser requests. Override with VITE_DEV_API_PROXY when not using
      // docker compose.
      '/api': {
        target: process.env.VITE_DEV_API_PROXY ?? 'http://api:3000',
        changeOrigin: true,
      },
    },
  },
});
