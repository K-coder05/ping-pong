/**
 * `phone.html` (docs/specs/p3.md, P3-b): the page the Phone opens from the QR
 * code. It joins the laptop's room from `?room=` or a typed code, asks for
 * motion access from a "Tap to start" tap, then streams one motion packet per
 * `devicemotion` event over the lossy channel. It keeps the screen awake, is
 * one full-screen tap area that never scrolls or zooms, and shows the status,
 * the live sample rate and a reminder to grip firmly. A thin DOM wrapper over
 * `sensors.ts` and `link.ts`.
 */
import './phonePage.css';
import { signalUrl } from './signalUrl.ts';
import { openPhoneLink, statusLabel, type LinkError, type SignalingLink } from './link.ts';
import { createSensorSource } from './sensors.ts';
import { isRoomCode, normalizeRoomCode } from './signalProtocol.ts';

const ERROR_TEXT: Record<LinkError, string> = {
  'bad-room': 'Room codes are 5 letters and digits.',
  'no-room': 'No room with that code. Check the code on the laptop.',
  'room-full': 'That room already has a Phone.',
  'already-in-room': 'Already in a room.',
  'no-peer': 'The laptop has left.',
  'bad-message': 'Pairing failed.',
  'socket-closed': "Can't reach the pairing server.",
};

/** How long a started sensor may stay silent before the page says so. */
const NO_MOTION_HINT_MS = 3000;

const root = document.createElement('main');
root.className = 'phone';
root.innerHTML = `
  <h1>Phone</h1>
  <form hidden>
    <input name="room" aria-label="Room code" placeholder="Room code" maxlength="7" autocomplete="off"
      autocapitalize="characters" spellcheck="false" />
    <button type="submit">Join</button>
  </form>
  <div class="room" data-testid="room-code"></div>
  <div class="status" data-testid="status"></div>
  <div class="error" data-testid="error"></div>
  <button type="button" class="start" data-testid="start">Tap to start</button>
  <div class="denied" data-testid="denied" role="alert" hidden>
    <p><strong>Motion access is blocked.</strong> The game needs it to see your Swings.</p>
    <p><strong>iPhone (Safari):</strong> quit Safari fully, open the link again and tap Allow. If it is still blocked,
      remove this site in Settings › Safari › Advanced › Website Data (Settings › Apps › Safari on iOS 18 and later).</p>
    <p><strong>Android (Chrome):</strong> tap the icon left of the address, then Permissions (or Site settings) ›
      Motion sensors › Allow, and reload.</p>
  </div>
  <div class="rate" data-testid="rate" hidden></div>
  <div class="hint" data-testid="hint"></div>
  <p class="grip">Grip your Phone firmly, like the handle of a bat. Use a wrist strap if you have one.</p>
  <button type="button" class="zero" data-testid="zero" hidden>Zero</button>
  <div class="received" data-testid="received"></div>`;
document.body.append(root);

const form = root.querySelector('form')!;
const input = form.querySelector('input')!;
const roomEl = root.querySelector<HTMLElement>('[data-testid="room-code"]')!;
const statusEl = root.querySelector<HTMLElement>('[data-testid="status"]')!;
const errorEl = root.querySelector<HTMLElement>('[data-testid="error"]')!;
const startBtn = root.querySelector<HTMLButtonElement>('[data-testid="start"]')!;
const deniedEl = root.querySelector<HTMLElement>('[data-testid="denied"]')!;
const rateEl = root.querySelector<HTMLElement>('[data-testid="rate"]')!;
const hintEl = root.querySelector<HTMLElement>('[data-testid="hint"]')!;
const zeroBtn = root.querySelector<HTMLButtonElement>('[data-testid="zero"]')!;
const receivedEl = root.querySelector<HTMLElement>('[data-testid="received"]')!;

const now = () => performance.now();
let link: SignalingLink | null = null;

// One packet per motion event, straight onto the link. The link drops it if the channel isn't open.
const sensors = createSensorSource(window, now);
sensors.onPacket((p) => link?.sendPacket(p));
if (import.meta.env.DEV) Object.assign(window, { __sensors: sensors });

blockScrollAndZoom();

function join(code: string) {
  link?.close();
  errorEl.textContent = '';
  form.hidden = true;
  roomEl.textContent = code;
  const l = openPhoneLink(code, { signalUrl: signalUrl(), now });
  link = l;
  if (import.meta.env.DEV) Object.assign(window, { __phoneLink: l });
  const show = () => {
    statusEl.textContent = statusLabel(l.status());
    statusEl.dataset.state = l.status();
    zeroBtn.hidden = l.status() !== 'connected';
  };
  show();
  l.onStatus(show);
  l.onError((e) => {
    errorEl.textContent = ERROR_TEXT[e];
    form.hidden = false;
    input.value = code;
  });
  let count = 0;
  l.onControl((m) => {
    count++;
    receivedEl.textContent = `Received ${count} control message${count === 1 ? '' : 's'}, last: ${m.type}`;
  });
}

let startedAt: number | null = null;
startBtn.onclick = async () => {
  // Both run inside the tap: iOS only asks for motion access from a user gesture.
  const asked = sensors.start();
  keepScreenAwake();
  const answer = await asked;
  if (answer === 'denied') {
    deniedEl.hidden = false;
    startBtn.textContent = 'Try again';
    return;
  }
  deniedEl.hidden = true;
  startBtn.hidden = true;
  rateEl.hidden = false;
  startedAt ??= now();
  showRate();
};

/** The rate is for reading, so a few times a second is plenty; packets never wait for this. */
function showRate() {
  if (startedAt === null) return;
  const hz = Math.round(sensors.rateHz());
  rateEl.innerHTML = `${hz} Hz<small>motion samples per second</small>`;
  hintEl.textContent =
    hz === 0 && now() - startedAt > NO_MOTION_HINT_MS
      ? 'No motion readings yet. Open this page on a Phone with motion sensors.'
      : '';
}
setInterval(showRate, 250);

zeroBtn.onclick = () => link?.sendControl({ type: 'zero' });

form.onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeRoomCode(input.value);
  if (!isRoomCode(code)) {
    errorEl.textContent = ERROR_TEXT['bad-room'];
    return;
  }
  input.blur();
  join(code);
};

const fromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
if (isRoomCode(fromUrl)) join(fromUrl);
else {
  form.hidden = false;
  statusEl.textContent = 'Type the room code shown on the laptop';
  input.focus();
}

/** Keep the screen on while streaming, where the browser has a wake lock; it is released whenever the page is hidden, so take it again on return. */
let awakeStarted = false;
function keepScreenAwake() {
  if (awakeStarted || !('wakeLock' in navigator)) return;
  awakeStarted = true;
  let lock: WakeLockSentinel | null = null;
  const acquire = async () => {
    if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
    } catch {
      // Low battery mode or a policy refused it; the screen may sleep.
    }
  };
  void acquire();
  document.addEventListener('visibilitychange', () => void acquire());
}

/** CSS `touch-action: none` covers most browsers; iOS Safari also needs the gestures cancelled. */
function blockScrollAndZoom() {
  const cancel = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener('touchmove', cancel, { passive: false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, cancel);
}
