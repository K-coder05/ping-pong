/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { configDefaults, defineConfig } from 'vitest/config';

/** Where `npm run signal` listens (its PORT); the e2e run uses its own. */
const SIGNAL_PORT = process.env.SIGNAL_PORT ?? '8787';

// Relative base: assets resolve from wherever the page is served, so the
// project-pages path (/ping-pong/) works and extra HTML pages added later
// resolve correctly. `npm run dev` still serves at `/`.
export default defineConfig({
  base: './',
  // HTTPS on the LAN (self-signed): the Phone only exposes motion sensors on secure pages.
  plugins: [basicSsl()],
  server: {
    host: true,
    // The signaling server behind the same HTTPS origin: a secure page can't open a plain ws:// socket.
    proxy: { '/signal': { target: `http://localhost:${SIGNAL_PORT}`, ws: true } },
  },
  build: {
    rollupOptions: {
      // The game plus the tool pages (dist/latency.html, dist/detection.html, dist/physics.html, dist/phone.html; not linked from the game).
      input: { main: resolve(import.meta.dirname, 'index.html'), latency: resolve(import.meta.dirname, 'latency.html'), detection: resolve(import.meta.dirname, 'detection.html'), physics: resolve(import.meta.dirname, 'physics.html'), phone: resolve(import.meta.dirname, 'phone.html') },
    },
  },
  test: {
    // Agent worktrees live under .claude/; never pick up their tests.
    // Playwright runs e2e/ (`npm run e2e`).
    exclude: [...configDefaults.exclude, '.claude/**', 'e2e/**'],
  },
});
