/**
 * `pairing.html` (dev only): the laptop's side of pairing, for trying it on
 * the LAN dev build and for `e2e/pairing.spec.ts`. The game's own wiring
 * comes later (#39). Shows the QR code, room code and status, plus control
 * messages both ways.
 */
import { devSignalUrl, openLaptopLink } from './link.ts';
import { mountPairing } from './pairing.ts';
import type { ControlMessage } from './types.ts';

const link = openLaptopLink({ signalUrl: devSignalUrl(location) });
mountPairing(document.body, link);

const tools = document.createElement('div');
tools.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px';
tools.innerHTML = `<button type="button" style="font-size:18px;padding:8px 16px">Send ping</button>
  <div data-testid="received">No control messages yet</div>`;
document.body.append(tools);
const received = tools.querySelector<HTMLElement>('[data-testid="received"]')!;
let count = 0;
link.onControl((m: ControlMessage) => {
  count++;
  received.textContent = `Received ${count} control message${count === 1 ? '' : 's'}, last: ${m.type}`;
});
tools.querySelector('button')!.onclick = () => link.sendControl({ type: 'ping', t0: performance.now() });

if (import.meta.env.DEV) Object.assign(window, { __phoneLink: link });
