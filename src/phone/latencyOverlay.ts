/**
 * Link overlay (docs/specs/p3.md, P3-d), toggled with `L`: how the Phone's
 * motion stream is arriving on the laptop. One-way delay p50 and p95, packet
 * loss from `seq` gaps and the Phone's sample rate over the last few seconds,
 * plus the clock sync's current offset and round trip, and whether packets
 * come peer to peer or by relay through the signaling server (P3-e §1).
 *
 * A thin DOM wrapper: the numbers come from `linkStats` (pure, tested in
 * `clock.test.ts`) and the wording from `overlayLines`.
 */
import { linkStats, type ClockSync, type LinkStats } from './clock.ts';
import { RELAY_MOTION_HZ } from './fallback.ts';
import { statusLabel } from './link.ts';
import type { LinkStatus, PhoneLink } from './types.ts';

export interface LatencyOverlayOptions {
  /** ms of packets the stats cover. Default 5,000. */
  windowMs?: number;
  /** Shown from the start. Default false: `L` shows it. */
  visible?: boolean;
}

/** Redraws per second: the overlay is for reading, and packets never wait for it. */
const REFRESH_MS = 250;

type SyncReadout = Pick<ClockSync, 'offsetMs' | 'rttMs' | 'toLocal'>;

/** The overlay's text, one line per figure. */
export function overlayLines(status: LinkStatus, stats: LinkStats, offsetMs: number, rttMs: number): string[] {
  return [
    `Phone      ${statusLabel(status)}`,
    `Path       ${pathLabel(status)}`,
    `Delay     p50 ${ms(stats.oneWayP50)} · p95 ${ms(stats.oneWayP95)}`,
    `Loss       ${stats.lossPct.toFixed(1)} %`,
    `Rate       ${Math.round(stats.rateHz)} Hz`,
    `Offset     ${ms(offsetMs)}`,
    `Round trip ${ms(rttMs)}`,
  ];
}

/** Which way packets travel: in relay they go through the signaling server, paced to `RELAY_MOTION_HZ` (P3-e §1). */
export function pathLabel(status: LinkStatus): string {
  if (status === 'connected') return 'peer to peer';
  if (status === 'relay') return `relay through the server (max ${RELAY_MOTION_HZ} Hz)`;
  return '–';
}

function ms(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)} ms` : '–';
}

/** Mount the overlay on `parent`; `L` toggles it. Returns a function that removes it and stops listening. */
export function mountLatencyOverlay(
  parent: HTMLElement,
  link: PhoneLink,
  sync: SyncReadout,
  now: () => number,
  opts: LatencyOverlayOptions = {},
): () => void {
  const windowMs = opts.windowMs ?? 5000;
  const el = document.createElement('pre');
  el.dataset.testid = 'link-overlay';
  el.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:1000;margin:0;padding:6px 8px;border-radius:4px;pointer-events:none;' +
    'background:rgba(0,0,0,0.7);color:#cfd6e4;font:12px/1.35 ui-monospace,Menlo,monospace';
  el.hidden = !opts.visible;
  parent.append(el);

  const recent: { tPhone: number; tRecv: number; seq: number }[] = [];
  const offPacket = link.onPacket((p, tRecv) => recent.push({ tPhone: p.tPhone, tRecv, seq: p.seq }));

  const draw = () => {
    const cutoff = now() - windowMs;
    while (recent.length > 0 && recent[0]!.tRecv < cutoff) recent.shift();
    if (el.hidden) return;
    el.textContent = overlayLines(link.status(), linkStats(recent, sync), sync.offsetMs(), sync.rttMs()).join('\n');
  };
  const timer = setInterval(draw, REFRESH_MS);
  draw();

  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== 'l' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    el.hidden = !el.hidden;
    draw();
  };
  window.addEventListener('keydown', onKey);

  return () => {
    window.removeEventListener('keydown', onKey);
    clearInterval(timer);
    offPacket();
    el.remove();
  };
}
