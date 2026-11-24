import { devSignalUrl } from './link.ts';

type Loc = { protocol: string; host: string };

/** http(s) -> ws(s); ws(s) URLs pass through. */
function toWs(url: string): string {
  return url.replace(/^http/i, 'ws');
}

/** The signaling server's WebSocket URL: the build-time `VITE_SIGNAL_URL`, else the dev proxy on the page's own host. */
export function signalUrlFor(envUrl: string | undefined, loc: Loc): string {
  const configured = envUrl?.trim();
  return configured ? toWs(configured) : devSignalUrl(loc);
}

/** The health check to wake the server with: `/health` on the configured server, or `/signal/health` through the dev proxy. */
export function healthUrlFor(envUrl: string | undefined, loc: Loc): string {
  const configured = envUrl?.trim();
  if (!configured) return `${loc.protocol}//${loc.host}/signal/health`;
  const u = new URL(configured.replace(/^ws/i, 'http'));
  return `${u.origin}/health`;
}

export function signalUrl(): string {
  return signalUrlFor(import.meta.env.VITE_SIGNAL_URL, location);
}

/**
 * Fire-and-forget GET to the signaling server's health check, so a sleeping free-tier host starts waking
 * before anyone pairs. Never throws or rejects. Only sends when a URL is configured or in dev.
 */
export function wakeSignalServer(
  fetchFn: typeof fetch = fetch,
  envUrl: string | undefined = import.meta.env.VITE_SIGNAL_URL,
  dev: boolean = import.meta.env.DEV,
  loc: Loc = location,
): void {
  try {
    if (!envUrl?.trim() && !dev) return;
    void Promise.resolve(fetchFn(healthUrlFor(envUrl, loc), { mode: 'no-cors', cache: 'no-store' })).catch(() => {});
  } catch {
    // A wake-up failure must never affect the page.
  }
}
