/**
 * The Phone for the measuring pages (docs/specs/p3.md, P3-d): the flash test
 * (`latency.html?flash&input=phone`) and the Detection test
 * (`detection.html?input=phone`). The same Phone Input the game uses with
 * `?input=phone`: pairing by QR code, clock sync while the Phone is
 * connected, and the link overlay (hidden; `L` shows it).
 *
 * A thin DOM and WebRTC wrapper; the wording is in `phoneStep`.
 */
import { createPhoneInput, type PhoneInput } from '../input/phoneInput.ts';
import { ClockSync } from '../phone/clock.ts';
import { mountLatencyOverlay } from '../phone/latencyOverlay.ts';
import { openLaptopLink, type SignalingLink } from '../phone/link.ts';
import { mountPairing } from '../phone/pairing.ts';
import { signalUrl } from '../phone/signalUrl.ts';
import type { LinkStatus } from '../phone/types.ts';
import type { Hand } from '../sensing/landmarks.ts';

export interface ToolPhone {
  readonly input: PhoneInput;
  readonly link: SignalingLink;
  readonly sync: ClockSync;
  /** What the player must do next. */
  step(): PhoneStep;
  /** Called whenever the step may have changed (link status, Zeroing, packets starting or stopping). Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
}

/** Pair the Phone, then Zero it; Swings come only once it is Zeroed and sending. */
export type PhoneStep = 'pair' | 'zero' | 'ready';

export function phoneStep(status: LinkStatus, sending: boolean): PhoneStep {
  if (status !== 'connected' && status !== 'relay') return 'pair';
  return sending ? 'ready' : 'zero';
}

export const PHONE_STEP_TEXT: Record<PhoneStep, string> = {
  pair: 'Scan the code with your Phone and tap “Tap to start” on it.',
  zero: 'Hold the Phone like the handle of a bat, point it at the screen and tap Zero on it.',
  ready: 'Phone Zeroed.',
};

/** How often the step is re-checked for the Phone going quiet, ms. */
const STEP_POLL_MS = 250;

/**
 * Open a link and show pairing in `pairingParent`, hidden once the Phone is
 * connected. Clock sync runs while the Phone is connected, and the Phone
 * Input puts Swings on the laptop's clock with it (the provisional estimate
 * before the first full round included, as in the game).
 */
export function installToolPhone(options: { pairingParent: HTMLElement; now: () => number; hand: () => Hand }): ToolPhone {
  const { pairingParent, now, hand } = options;
  const link = openLaptopLink({ signalUrl: signalUrl(), now });
  mountPairing(pairingParent, link);

  const sync = new ClockSync(link, now);
  const followLink = (s: LinkStatus) => (s === 'connected' || s === 'relay' ? sync.start() : sync.stop());
  link.onStatus(followLink);
  followLink(link.status());
  mountLatencyOverlay(document.body, link, sync, now);

  const input = createPhoneInput(link, now, sync, hand);
  const step = () => phoneStep(link.status(), input.latest !== null);

  const listeners = new Set<() => void>();
  let last: PhoneStep | null = null;
  const check = () => {
    const s = step();
    pairingParent.style.display = s === 'pair' ? '' : 'none';
    if (s === last) return;
    last = s;
    listeners.forEach((cb) => cb());
  };
  link.onStatus(check);
  link.onControl(check);
  setInterval(check, STEP_POLL_MS);
  check();

  return {
    input,
    link,
    sync,
    step,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
