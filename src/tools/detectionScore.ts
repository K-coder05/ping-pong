/**
 * Detection test scoring (SPEC "Detection test"): a tick is detected iff
 * exactly one Swing Onset falls within ±`windowMs` of it; every Onset during
 * the idle phase is a false trigger. All times are on the `performance.now()` clock.
 */

/** Half-width of the window around a tick, ms. */
export const DETECTION_WINDOW_MS = 300;

export interface SessionData {
  tickTimes: readonly number[];
  /** Every Swing Onset time seen during the session. */
  onsets: readonly number[];
  /** The idle ("stand and talk") phase, start inclusive, end exclusive. */
  idle: { start: number; end: number };
  windowMs?: number;
}

export interface SessionScore {
  detected: number;
  total: number;
  falseTriggers: number;
  falseTriggersPerMinute: number;
}

export function scoreSession({ tickTimes, onsets, idle, windowMs = DETECTION_WINDOW_MS }: SessionData): SessionScore {
  const detected = tickTimes.filter((tick) => onsets.filter((t) => Math.abs(t - tick) <= windowMs).length === 1).length;
  const falseTriggers = onsets.filter((t) => t >= idle.start && t < idle.end).length;
  const minutes = (idle.end - idle.start) / 60_000;
  return {
    detected,
    total: tickTimes.length,
    falseTriggers,
    falseTriggersPerMinute: minutes > 0 ? falseTriggers / minutes : 0,
  };
}
