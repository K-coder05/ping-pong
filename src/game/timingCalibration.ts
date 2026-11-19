/**
 * Timing calibration (SPEC "Timing calibration"): the metronome ticks a few
 * times, the player swings on each tick, and the Timing Offset is the median
 * of (Swing Onset − tick time). The median ignores one wild Swing.
 *
 * No audio or DOM here: the caller presents the ticks (`onSchedule` /
 * `onTick`). Tick times and Swing Onsets share the `performance.now()` clock.
 */

import type { SwingSource } from '../input/types.ts';
import { createMetronome } from '../tools/metronome.ts';

export interface TimingOffsetMeasurement {
  /** Median of (Swing Onset − tick time), ms; positive = the game sees Swings late. */
  offsetMs: number;
  /** How many ticks had a Swing paired with them. */
  paired: number;
}

/**
 * Pair each tick with a Swing Onset and take the median of their differences.
 *
 * A tick owns the Onsets within half a tick interval of it (`intervalMs` is
 * the time between ticks), so a missed tick is skipped rather than borrowing
 * the next tick's Swing; if it owns several, the nearest counts and the rest
 * are ignored. Returns null when fewer than half the ticks got a Swing: too
 * little to trust, so the player should calibrate again.
 */
export function measureTimingOffset(
  tickTimes: readonly number[],
  onsets: readonly number[],
  intervalMs: number,
): TimingOffsetMeasurement | null {
  const half = intervalMs / 2;
  const differences: number[] = [];
  for (const tick of tickTimes) {
    let nearest: number | null = null;
    for (const onset of onsets) {
      const difference = onset - tick;
      if (difference < -half || difference >= half) continue;
      if (nearest === null || Math.abs(difference) < Math.abs(nearest)) nearest = difference;
    }
    if (nearest !== null) differences.push(nearest);
  }
  if (differences.length === 0 || differences.length * 2 < tickTimes.length) return null;
  return { offsetMs: median(differences), paired: differences.length };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Ticks in one calibration (SPEC: 5–8). */
export const CALIBRATION_TICKS = 6;
/** Time between ticks, ms: long enough to wind up and swing again. */
export const CALIBRATION_INTERVAL_MS = 1500;
/** From pressing Start to the first tick, ms. */
export const CALIBRATION_LEAD_IN_MS = 2500;

export interface TimingCalibrationOptions {
  /** Where the player's Swings come from (pose, or the developer mouse). */
  swings: SwingSource;
  count?: number;
  intervalMs?: number;
  leadInMs?: number;
  /** Clock, default `performance.now` (the Swing Onset clock). */
  now?: () => number;
  /** Tick `index` is due at `time`, shortly from now: schedule its click (see `metronomePresentation`). */
  onSchedule?(index: number, time: number): void;
  /** Tick `index` (due at `time`) is happening now. */
  onTick?(index: number, time: number): void;
  /** A Swing was seen during calibration; `count` so far. */
  onSwing?(count: number): void;
}

export interface TimingCalibrationRun {
  /** The measurement once the last tick's Swing has had time to arrive; null if too few Swings. */
  readonly result: Promise<TimingOffsetMeasurement | null>;
  /** Stop ticking and listening; `result` then never settles. */
  cancel(): void;
}

/**
 * Run one calibration: tick the metronome, collect every Swing Onset, and
 * after the last tick wait half an interval for its Swing before measuring.
 */
export function runTimingCalibration(options: TimingCalibrationOptions): TimingCalibrationRun {
  const {
    swings,
    count = CALIBRATION_TICKS,
    intervalMs = CALIBRATION_INTERVAL_MS,
    leadInMs = CALIBRATION_LEAD_IN_MS,
    now = () => performance.now(),
  } = options;
  const onsets: number[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (result: TimingOffsetMeasurement | null) => void = () => {};
  const result = new Promise<TimingOffsetMeasurement | null>((resolve) => (resolveResult = resolve));

  const unsubscribe = swings.subscribe((swing) => {
    onsets.push(swing.t);
    options.onSwing?.(onsets.length);
  });
  const metronome = createMetronome({
    count,
    intervalMs,
    leadInMs,
    now,
    onSchedule: options.onSchedule,
    onTick: options.onTick,
    onEnd() {
      settleTimer = setTimeout(() => {
        unsubscribe();
        resolveResult(measureTimingOffset(metronome.tickTimes, onsets, intervalMs));
      }, intervalMs / 2);
    },
  });
  metronome.start();

  return {
    result,
    cancel() {
      metronome.stop();
      clearTimeout(settleTimer);
      unsubscribe();
    },
  };
}
