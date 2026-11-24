import type { KeyValueStorage } from './handedness.ts';
import type { Input } from './onboarding.ts';

/**
 * The player's measured Timing Offset, one per Input (GLOSSARY "Timing
 * Offset"), saved in `localStorage` so returning players skip calibration
 * (SPEC "Timing calibration"). Storage can throw (private mode, blocked site
 * data), so every access is guarded and a measurement still holds for the
 * current page when it can't be saved.
 *
 * Keys: the Camera's Timing Offset stays under the key the game has always
 * used (`returnDrill.timingOffsetMs`), so a value saved before there was a
 * Phone is kept as the Camera's with nothing to copy; the Phone's has its own
 * key (`returnDrill.timingOffsetMs.phone`).
 *
 * This holds what calibration measured. The resolver reads the live
 * `TIMING_OFFSET_MS` knob, which the game sets from here (see `main.ts`).
 */
export interface TimingOffsetStore {
  /** The Camera's saved Timing Offset in ms, or null (what the Detection test reads). */
  readonly offsetMs: number | null;
  /** The saved Timing Offset in ms for `input`, or null if the player hasn't calibrated with it. */
  offsetMsFor(input: Input): number | null;
  /** Remember a new Timing Offset (ms) for `input`. */
  save(input: Input, offsetMs: number): void;
}

/** Where each Input's Timing Offset is saved. The Camera's is the original key, from before there was a Phone. */
export const TIMING_OFFSET_KEYS: Readonly<Record<Input, string>> = Object.freeze({
  camera: 'returnDrill.timingOffsetMs',
  phone: 'returnDrill.timingOffsetMs.phone',
});

/** `storage` is a getter because merely reading `window.localStorage` can throw. */
export function createTimingOffsetStore(storage: () => KeyValueStorage | null): TimingOffsetStore {
  const offsets: Record<Input, number | null> = { camera: load('camera'), phone: load('phone') };

  function load(input: Input): number | null {
    try {
      const saved = storage()?.getItem(TIMING_OFFSET_KEYS[input])?.trim();
      if (!saved) return null;
      const value = Number(saved);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  return {
    get offsetMs() {
      return offsets.camera;
    },
    offsetMsFor(input) {
      return offsets[input];
    },
    save(input, next) {
      offsets[input] = next;
      try {
        storage()?.setItem(TIMING_OFFSET_KEYS[input], String(next));
      } catch {
        // Not saved; it still applies until the page reloads.
      }
    },
  };
}

/** The page's saved Timing Offsets, in `localStorage`. */
export const timingOffsetStore: TimingOffsetStore = createTimingOffsetStore(() =>
  typeof window === 'undefined' ? null : window.localStorage,
);
