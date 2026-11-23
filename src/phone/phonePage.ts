/**
 * `phone.html`, minimal for now (#37): join the laptop's room from `?room=`
 * or a typed code, and show the connection status. #38 replaces this page
 * with the real one (motion permission, streaming, Zeroing).
 */
import { devSignalUrl, openPhoneLink, statusLabel, type LinkError, type SignalingLink } from './link.ts';
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

const root = document.createElement('main');
root.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 16px;text-align:center';
root.innerHTML = `
  <h1 style="margin:0;font-size:24px">Phone</h1>
  <form hidden>
    <input name="room" aria-label="Room code" placeholder="Room code" maxlength="7" autocomplete="off"
      autocapitalize="characters" spellcheck="false"
      style="font:600 28px ui-monospace,monospace;width:7.5em;padding:8px;text-transform:uppercase" />
    <button type="submit" style="font-size:20px;padding:8px 16px">Join</button>
  </form>
  <div data-testid="room-code" style="font:700 40px ui-monospace,monospace;letter-spacing:0.15em"></div>
  <div data-testid="status" style="font-size:24px;font-weight:600"></div>
  <div data-testid="error" style="color:#ff7a7a"></div>
  <button type="button" data-testid="zero" hidden style="font-size:20px;padding:12px 24px">Zero</button>
  <div data-testid="received"></div>`;
document.body.append(root);

const form = root.querySelector('form')!;
const input = form.querySelector('input')!;
const roomEl = root.querySelector<HTMLElement>('[data-testid="room-code"]')!;
const statusEl = root.querySelector<HTMLElement>('[data-testid="status"]')!;
const errorEl = root.querySelector<HTMLElement>('[data-testid="error"]')!;
const zeroBtn = root.querySelector<HTMLButtonElement>('[data-testid="zero"]')!;
const receivedEl = root.querySelector<HTMLElement>('[data-testid="received"]')!;

let link: SignalingLink | null = null;

function join(code: string) {
  link?.close();
  errorEl.textContent = '';
  form.hidden = true;
  roomEl.textContent = code;
  const l = openPhoneLink(code, { signalUrl: devSignalUrl(location) });
  link = l;
  if (import.meta.env.DEV) Object.assign(window, { __phoneLink: l });
  const show = () => {
    statusEl.textContent = statusLabel(l.status());
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

form.onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeRoomCode(input.value);
  if (!isRoomCode(code)) {
    errorEl.textContent = ERROR_TEXT['bad-room'];
    return;
  }
  join(code);
};
zeroBtn.onclick = () => link?.sendControl({ type: 'zero' });

const fromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
if (isRoomCode(fromUrl)) join(fromUrl);
else {
  form.hidden = false;
  statusEl.textContent = 'Type the room code shown on the laptop';
  input.focus();
}
