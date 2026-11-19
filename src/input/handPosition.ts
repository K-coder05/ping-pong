/**
 * Where the hitting wrist is, for the Paddle to follow. Any input (the pose
 * Swing detector, the developer mouse) can provide it, in the same
 * body-relative units the Swing detector works in (SPEC "Swing detection"),
 * so the Paddle never knows which input drives it.
 */

import type { SwingReading } from './swingDetector.ts';

/** One sample of the hitting wrist's position. */
export interface HandPosition {
  /** Sample time, ms, `performance.now()` clock. */
  t: number;
  /** Position along the body axis, shoulder widths; > 0 on the hitting side (`u = p · a`). */
  u: number;
  /** Vertical position `p.y`, shoulder widths below the shoulder midpoint (image y grows downward). */
  py: number;
}

/** Anything that knows where the hitting wrist is. */
export interface HandPositionSource {
  /** The latest sample, or null while the wrist is unknown (not tracked yet, or lost). */
  readonly latest: HandPosition | null;
}

/** A `HandPositionSource` an input pushes samples into. */
export interface HandPositionStore extends HandPositionSource {
  set(position: HandPosition): void;
  clear(): void;
}

export function createHandPositionStore(): HandPositionStore {
  let latest: HandPosition | null = null;
  return {
    get latest() {
      return latest;
    },
    set(position) {
      latest = position;
    },
    clear() {
      latest = null;
    },
  };
}

/** The hand position a pose Swing detector reading measured. */
export function handPositionFromReading(reading: SwingReading): HandPosition {
  return { t: reading.t, u: reading.u, py: reading.p.y };
}
