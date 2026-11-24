/**
 * The flash test's logic (docs/specs/p3.md, P3-d): the screen flashes white
 * the instant a Swing Onset is detected, for either Input. Filmed in slow
 * motion with the hand, the frames from the hand starting to move to the
 * flash are the whole delay the player feels.
 *
 * Pure: Swings and times in, whether the flash is on out. The page
 * (`latencyHarness.ts`, `?flash`) only paints it.
 */
import type { SwingEvent } from '../input/types.ts';

/** How long one flash stays on, ms: several frames even at 30 fps, short enough to tell Swings apart. */
export const FLASH_MS = 250;

export interface SwingFlash {
  /** A Swing Onset was detected at `now` (ms, the laptop's clock): the flash goes on now, whatever the Swing's own time. */
  onset(swing: SwingEvent, now: number): void;
  /** Whether the flash is on at `now`. */
  isOn(now: number): boolean;
  /** When the current flash goes off, ms, or null if no flash has started. */
  readonly offAt: number | null;
  /** Swings detected so far. */
  readonly swings: number;
  /**
   * The last Swing's detection time minus its Swing Onset time, ms: how long
   * the laptop took to recognise it after the Input stamped it (camera frame
   * to pose result, or the Phone's motion event to arrival). Null before the
   * first Swing.
   */
  readonly lastDetectMs: number | null;
}

export function createSwingFlash(flashMs = FLASH_MS): SwingFlash {
  let onAt: number | null = null;
  let offAt: number | null = null;
  let swings = 0;
  let lastDetectMs: number | null = null;
  return {
    onset(swing, now) {
      swings++;
      lastDetectMs = now - swing.t;
      // A Swing during a flash starts it over: the flash always lasts flashMs from the latest Onset.
      if (onAt === null || offAt === null || now >= offAt) onAt = now;
      offAt = now + flashMs;
    },
    isOn(now) {
      return onAt !== null && offAt !== null && now >= onAt && now < offAt;
    },
    get offAt() {
      return offAt;
    },
    get swings() {
      return swings;
    },
    get lastDetectMs() {
      return lastDetectMs;
    },
  };
}
