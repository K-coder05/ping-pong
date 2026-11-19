/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012; https://gery.casiez.net/1euro/):
 * an adaptive low-pass filter for one noisy coordinate.
 */

export interface OneEuroParams {
  /** Cutoff frequency at rest, Hz. Lower removes more jitter when still. */
  minCutoff: number;
  /** How fast the cutoff rises with speed. Higher lags less during fast moves. */
  beta: number;
}

export interface OneEuroFilter {
  /** Smooth one sample taken at `timestampMs` (milliseconds, increasing). */
  filter(value: number, timestampMs: number): number;
  /** Forget all history; the next sample passes through unchanged. */
  reset(): void;
}

/** Cutoff for the speed estimate itself, Hz (the paper's recommended 1 Hz). */
const DERIVATIVE_CUTOFF = 1;

/** Smoothing factor of an exponential low-pass with this cutoff and step. */
function alpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/**
 * `getParams` is called on every sample, so pass a function that reads live
 * knob values and panel changes take effect on the next frame.
 */
export function createOneEuroFilter(getParams: () => OneEuroParams): OneEuroFilter {
  let previous: { t: number; value: number; speed: number } | null = null;

  return {
    filter(value, timestampMs) {
      if (!previous) {
        previous = { t: timestampMs, value, speed: 0 };
        return value;
      }
      const dt = (timestampMs - previous.t) / 1000;
      if (!(dt > 0)) return previous.value;
      const { minCutoff, beta } = getParams();
      const rawSpeed = (value - previous.value) / dt;
      const a = alpha(DERIVATIVE_CUTOFF, dt);
      const speed = previous.speed + a * (rawSpeed - previous.speed);
      const cutoff = minCutoff + beta * Math.abs(speed);
      const smoothed = previous.value + alpha(cutoff, dt) * (value - previous.value);
      previous = { t: timestampMs, value: smoothed, speed };
      return smoothed;
    },
    reset() {
      previous = null;
    },
  };
}
