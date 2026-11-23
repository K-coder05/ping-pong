/**
 * Pairing on the laptop (docs/specs/p3.md, P3-a): once the link's room is
 * created, draw a QR code for the Phone's page with the room in its URL, the
 * room code in large text for typing by hand, and the link's status.
 * `mountPairing` is a thin DOM wrapper; the URL and wording are pure.
 */
import QRCode from 'qrcode';
import { statusLabel, type SignalingLink } from './link.ts';
import type { LinkStatus } from './types.ts';

/** The Phone's page next to the current page: `<origin><base>phone.html?room=<code>`. */
export function phonePageUrl(pageHref: string, room: string): string {
  const url = new URL('phone.html', pageHref);
  url.search = new URLSearchParams({ room }).toString();
  return url.href;
}

/** A page opened as localhost puts localhost in the QR code, which the Phone can't reach. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || hostname.startsWith('127.');
}

const STYLE = `
.pairing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px; text-align: center; }
.pairing canvas { background: #fff; border-radius: 8px; padding: 8px; width: 240px; height: 240px; }
.pairing .room { font: 700 64px/1 ui-monospace, monospace; letter-spacing: 0.15em; }
.pairing .url { font-size: 13px; color: #9aa3b2; word-break: break-all; }
.pairing .status { font-size: 22px; font-weight: 600; }
.pairing .status[data-state="connected"] { color: #5fd38d; }
.pairing .status[data-state="disconnected"] { color: #ff7a7a; }
.pairing .warn { max-width: 420px; font-size: 14px; color: #ffcf66; }
`;

/**
 * Show pairing for `link` inside `parent`. `pageHref` is the page the QR code
 * is relative to (default: this page). Returns a function that removes it;
 * the link stays open.
 */
export function mountPairing(parent: HTMLElement, link: SignalingLink, pageHref = location.href): () => void {
  const root = document.createElement('div');
  root.className = 'pairing';
  root.innerHTML = `
    <style>${STYLE}</style>
    <canvas class="qr" width="240" height="240" aria-label="QR code to open the Phone's page"></canvas>
    <div class="room" data-testid="room-code">·····</div>
    <a class="url" data-testid="phone-url" target="_blank" rel="noopener"></a>
    <div class="status" data-testid="status"></div>
    <p class="warn" hidden>This page is open as localhost, so the Phone can't reach the QR code's address.
      Open it from the laptop's Network address instead (Vite prints it).</p>`;
  parent.append(root);
  const canvas = root.querySelector('canvas')!;
  const roomEl = root.querySelector<HTMLElement>('.room')!;
  const urlEl = root.querySelector('a')!;
  const statusEl = root.querySelector<HTMLElement>('.status')!;
  root.querySelector<HTMLElement>('.warn')!.hidden = !isLoopbackHost(new URL(pageHref).hostname);

  const showStatus = (s: LinkStatus) => {
    statusEl.textContent = statusLabel(s);
    statusEl.dataset.state = s;
  };
  showStatus(link.status());
  const offStatus = link.onStatus(showStatus);
  const offError = link.onError((e) => {
    statusEl.textContent = `Pairing failed (${e})`;
  });

  let removed = false;
  link.room.then(
    (room) => {
      if (removed) return;
      const url = phonePageUrl(pageHref, room);
      roomEl.textContent = room;
      urlEl.textContent = url;
      urlEl.href = url;
      void QRCode.toCanvas(canvas, url, { width: 240, margin: 0 });
    },
    () => {},
  );

  return () => {
    removed = true;
    offStatus();
    offError();
    root.remove();
  };
}
