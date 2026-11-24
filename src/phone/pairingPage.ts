/**
 * `pairing.html` (dev only): the laptop's side of pairing, for trying it on
 * the LAN dev build and for `e2e/pairing.spec.ts`. The game's own wiring
 * comes later (#39). Shows the QR code, room code and status, control
 * messages both ways, and the motion packets received with their live rate.
 */
import { devSignalUrl, openLaptopLink } from './link.ts';
import { mountPairing } from './pairing.ts';
import { createRateMeter } from './sensors.ts';
import type { ControlMessage } from './types.ts';

const now = () => performance.now();
const link = openLaptopLink({ signalUrl: devSignalUrl(location), now });
mountPairing(document.body, link);

const tools = document.createElement('div');
tools.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px';
tools.innerHTML = `<div data-testid="packets" style="font:600 20px ui-monospace,monospace">No motion packets yet</div>
  <button type="button" style="font-size:18px;padding:8px 16px">Send ping</button>
  <div data-testid="received">No control messages yet</div>`;
document.body.append(tools);

const packetsEl = tools.querySelector<HTMLElement>('[data-testid="packets"]')!;
const rate = createRateMeter(now);
let packets = 0;
link.onPacket((_, tRecv) => {
  packets++;
  rate.mark(tRecv);
});
// For reading only: a few times a second is plenty.
setInterval(() => {
  if (packets > 0) packetsEl.textContent = `${Math.round(rate.rateHz())} Hz · ${packets} motion packets`;
}, 250);

const received = tools.querySelector<HTMLElement>('[data-testid="received"]')!;
let count = 0;
link.onControl((m: ControlMessage) => {
  count++;
  received.textContent = `Received ${count} control message${count === 1 ? '' : 's'}, last: ${m.type}`;
});
tools.querySelector('button')!.onclick = () => link.sendControl({ type: 'ping', t0: performance.now() });

if (import.meta.env.DEV) Object.assign(window, { __phoneLink: link });
