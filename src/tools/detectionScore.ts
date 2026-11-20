/**
 * Detection test scoring (SPEC "Detection test"): a tick is detected iff
 * exactly one Swing Onset falls within ±`windowMs` of the tick plus the
 * player's Timing Offset (when the game expects to see a Swing made on the
 * tick); every Onset during the idle phase is a false trigger. All times are
 * on the `performance.now()` clock.
 */

/** Half-width of the window around a tick, ms. */
export const DETECTION_WINDOW_MS = 300;
/** Idle phase starts this long after the last tick, so its follow-through isn't a false trigger. */
export const IDLE_GRACE_MS = 1500;
/** Length of the idle ("stand and talk") phase. */
export const IDLE_MS = 60_000;

/** The idle phase that follows a session whose last tick was at `lastTick`. */
export function idlePhase(lastTick: number): SessionData['idle'] {
  return { start: lastTick + IDLE_GRACE_MS, end: lastTick + IDLE_GRACE_MS + IDLE_MS };
}

export interface SessionData {
  tickTimes: readonly number[];
  /** Every Swing Onset time seen during the session. */
  onsets: readonly number[];
  /** The idle ("stand and talk") phase, start inclusive, end exclusive. */
  idle: { start: number; end: number };
  windowMs?: number;
  /** The player's Timing Offset from calibration, ms (0 if not calibrated); positive = Onsets seen late. */
  timingOffsetMs?: number;
}

export interface SessionScore {
  detected: number;
  total: number;
  falseTriggers: number;
  falseTriggersPerMinute: number;
}

/** Whether exactly one Onset falls in the tick's window (the tick plus the Timing Offset, ±`windowMs`). */
export function isTickDetected(tick: number, onsets: readonly number[], timingOffsetMs = 0, windowMs = DETECTION_WINDOW_MS): boolean {
  return onsets.filter((t) => Math.abs(t - (tick + timingOffsetMs)) <= windowMs).length === 1;
}

export function scoreSession({ tickTimes, onsets, idle, windowMs = DETECTION_WINDOW_MS, timingOffsetMs = 0 }: SessionData): SessionScore {
  const detected = tickTimes.filter((tick) => isTickDetected(tick, onsets, timingOffsetMs, windowMs)).length;
  const falseTriggers = onsets.filter((t) => t >= idle.start && t < idle.end).length;
  const minutes = (idle.end - idle.start) / 60_000;
  return {
    detected,
    total: tickTimes.length,
    falseTriggers,
    falseTriggersPerMinute: minutes > 0 ? falseTriggers / minutes : 0,
  };
}
