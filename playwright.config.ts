import { defineConfig, devices } from '@playwright/test';

/**
 * `npm run e2e`: browser tests in e2e/. Starts its own signaling server and
 * Vite dev server on ports of its own (not the usual 8787 and 5173), so it
 * never reuses or collides with a dev session, and stops both when done.
 */
const SIGNAL_PORT = 8797;
const VITE_PORT = 5197;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `https://localhost:${VITE_PORT}`,
    ignoreHTTPSErrors: true, // the dev server's self-signed certificate
    launchOptions: {
      // Two pages in one headless browser: share real host candidates instead of mDNS names.
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  webServer: [
    {
      command: 'node server/signal.ts',
      env: { PORT: String(SIGNAL_PORT) },
      url: `http://localhost:${SIGNAL_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${VITE_PORT} --strictPort`,
      env: { SIGNAL_PORT: String(SIGNAL_PORT) },
      url: `https://localhost:${VITE_PORT}/pairing.html`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
    },
  ],
});
