/**
 * The Phone Input (docs/specs/p3.md, P3-c): motion packets from a paired
 * Phone become the same `SwingEvent`s the Camera gives, carrying a
 * `faceAngle`, plus a live hand position for the Paddle, so the game can't
 * tell the Inputs apart except through `faceAngle`.
 *
 * - Zeroing: on a `zero` control message, the next packet's orientation
 *   becomes neutral. No Swings before the first Zeroing.
 * - Time: each packet's `tPhone` goes onto the laptop's clock through a
 *   `ClockOffset`: `naiveOffset()` until P3-d's `ClockSync` replaces it.
 * - Paddle: the Phone gives no position, so `latest` is a fixed hitting
 *   point shifted sideways by how far the Phone has turned since Zero.
 *
 * `createPhoneInputCore` is the pure part (also what replays a Phone log in
 * tests); `createPhoneInput` only wires it to a `PhoneLink`.
 */
import type { PhoneLogEntry } from '../phone/phoneLog.ts';
import type { MotionPacket, PhoneLink } from '../phone/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import type { HandPosition, HandPositionSource } from './handPosition.ts';
import { DEFAULT_PHONE_SWING_PARAMS, PhoneSwingDetector, type PhoneSwingParams } from './phoneSwing.ts';
import { createSwingEmitter } from './swingEmitter.ts';
import type { SwingEvent, SwingSource } from './types.ts';

/** Puts Phone timestamps on the laptop's clock. P3-d provides the accurate one. */
export interface ClockOffset {
  toLocal(tPhone: number): number;
}

/** How far back `naiveOffset` looks, ms. */
const NAIVE_WINDOW_MS = 2000;

/**
 * The naive clock offset: the smallest (tRecv − tPhone) over the last 2 s,
 * i.e. treating the fastest recent packet as if it took no time to arrive.
 * Feed it every packet with `observe`; before the first, it adds nothing.
 */
export function naiveOffset(): ClockOffset & { observe(tPhone: number, tRecv: number): void } {
  /** Increasing in both tRecv and offset: the front is the minimum in the window. */
  const window: { tRecv: number; offset: number }[] = [];
  return {
    observe(tPhone, tRecv) {
      const offset = tRecv - tPhone;
      while (window.length > 0 && window[window.length - 1]!.offset >= offset) window.pop();
      window.push({ tRecv, offset });
      while (window[0]!.tRecv < tRecv - NAIVE_WINDOW_MS) window.shift();
    },
    toLocal(tPhone) {
      return tPhone + (window[0]?.offset ?? 0);
    },
  };
}

/**
 * Where `latest` puts the hand (starting guesses): a fixed hitting point,
 * `u` shoulder widths toward the hitting side and `py` at shoulder height,
 * shifted sideways by the Phone's turn from Zero, one shoulder width per 45°,
 * at most one either way.
 */
export const PHONE_HAND_POSITION = { u: 1, py: 0, swPerRad: 1 / (Math.PI / 4), maxShiftSw: 1 } as const;

/** With no packet for this long, ms, `latest` is null: the Phone has gone quiet. */
export const PHONE_STALE_MS = 500;

export interface PhoneInputCoreOptions {
  offset: ClockOffset;
  /** The hitting hand, read on every packet. */
  hand: () => Hand;
  params?: PhoneSwingParams;
}

/** The Phone Input's pure part: Zeroing, the clock offset and the Swing detector. */
export interface PhoneInputCore {
  /** A Zeroing arrived: the next packet becomes neutral. */
  zero(): void;
  /** One received packet (`tRecv`: laptop clock, ms). Returns the Swing whose Onset it is, if any. */
  packet(p: MotionPacket, tRecv: number): SwingEvent | null;
  /** The hand position from the latest packet, or null before the first Zeroing. `faceAngle` is the Forehand face's. */
  readonly position: HandPosition | null;
  /** Whether a Zeroing has been applied (to the packet after it). */
  readonly zeroed: boolean;
}

export function createPhoneInputCore(options: PhoneInputCoreOptions): PhoneInputCore {
  const params = options.params ?? DEFAULT_PHONE_SWING_PARAMS;
  const offset = options.offset as ClockOffset & { observe?: (tPhone: number, tRecv: number) => void };
  let detector = new PhoneSwingDetector(params, options.hand());
  let neutral: MotionPacket | null = null;
  let zeroPending = false;
  let position: HandPosition | null = null;

  return {
    zero() {
      zeroPending = true;
    },
    packet(p, tRecv) {
      offset.observe?.(p.tPhone, tRecv);
      // Never later than it arrived, whatever the offset says.
      const tLocal = Math.min(offset.toLocal(p.tPhone), tRecv);
      const hand = options.hand();
      if (hand !== detector.hand) {
        // A new hand: a fresh detector with the same Zero.
        detector = new PhoneSwingDetector(params, hand);
        if (neutral) detector.zero(neutral);
      }
      if (zeroPending) {
        zeroPending = false;
        neutral = p;
        detector.zero(p);
      }
      const swing = detector.push(p, tLocal);
      const attitude = detector.attitude(p);
      if (attitude) {
        const { u, py, swPerRad, maxShiftSw } = PHONE_HAND_POSITION;
        const shift = Math.max(-maxShiftSw, Math.min(maxShiftSw, attitude.turnToHitting * swPerRad));
        position = { t: tLocal, u: u + shift, py, faceAngle: attitude.forehandFaceAngle };
      }
      return swing;
    },
    get position() {
      return position;
    },
    get zeroed() {
      return neutral !== null;
    },
  };
}

/** Replay a Phone log as the Phone Input would have heard it, with the naive clock offset. Returns its Swings. */
export function replayPhoneLog(entries: readonly PhoneLogEntry[], hand: Hand, params?: PhoneSwingParams): SwingEvent[] {
  const core = createPhoneInputCore({ offset: naiveOffset(), hand: () => hand, params });
  const swings: SwingEvent[] = [];
  for (const entry of entries) {
    if (entry.type === 'zero') core.zero();
    else {
      const swing = core.packet(entry, entry.tRecv);
      if (swing) swings.push(swing);
    }
  }
  return swings;
}

export interface PhoneInput extends SwingSource, HandPositionSource {
  /** Whether the Phone has been Zeroed: a Zeroing arrived and the packet after it became neutral. */
  readonly zeroed: boolean;
}

/**
 * The Phone Input on a paired link. `offset` puts Phone time on the laptop's
 * clock; one with an `observe(tPhone, tRecv)` method (`naiveOffset()`) is fed
 * every packet. `latest` is null before the first Zeroing and while no
 * packet has arrived for `PHONE_STALE_MS`.
 */
export function createPhoneInput(link: PhoneLink, now: () => number, offset: ClockOffset, hand: () => Hand): PhoneInput {
  const core = createPhoneInputCore({ offset, hand });
  const swings = createSwingEmitter();
  let lastRecv = -Infinity;
  link.onControl((m) => {
    if (m.type === 'zero') core.zero();
  });
  link.onPacket((p, tRecv) => {
    lastRecv = tRecv;
    const swing = core.packet(p, tRecv);
    if (swing) swings.emit(swing);
  });
  return {
    subscribe: swings.subscribe,
    get latest() {
      return now() - lastRecv > PHONE_STALE_MS ? null : core.position;
    },
    get zeroed() {
      return core.zeroed;
    },
  };
}
