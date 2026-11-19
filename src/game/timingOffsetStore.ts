import type { KeyValueStorage } from './handedness.ts';

/**
 * The player's measured Timing Offset, saved in `localStorage` so returning
 * players skip calibration (SPEC "Timing calibration"). Storage can throw
 * (private mode, blocked site data), so every access is guarded and a
 * measurement still holds for the current page when it can't be saved.
 *
 * This holds what calibration measured. The resolver reads the live
 * `TIMING_OFFSET_MS` knob, which the game sets from here (see `main.ts`).
 */
export interface TimingOffsetStore {
  /** The saved Timing Offset in ms, or null if the player hasn't calibrated. */
  readonly offsetMs: number | null;
  /** Remember a new Timing Offset (ms). */
  save(offsetMs: number): void;
}

const STORAGE_KEY = 'returnDrill.timingOffsetMs';

/** `storage` is a getter because merely reading `window.localStorage` can throw. */
export function createTimingOffsetStore(storage: () => KeyValueStorage | null): TimingOffsetStore {
  let offsetMs = load();

  function load(): number | null {
    try {
      const saved = storage()?.getItem(STORAGE_KEY)?.trim();
      if (!saved) return null;
      const value = Number(saved);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  return {
    get offsetMs() {
      return offsetMs;
    },
    save(next) {
      offsetMs = next;
      try {
        storage()?.setItem(STORAGE_KEY, String(next));
      } catch {
        // Not saved; it still applies until the page reloads.
      }
    },
  };
}

/** The page's saved Timing Offset, in `localStorage`. */
export const timingOffsetStore: TimingOffsetStore = createTimingOffsetStore(() =>
  typeof window === 'undefined' ? null : window.localStorage,
);
