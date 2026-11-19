/**
 * Metronome scheduling logic, reusable by the detection test and Timing
 * calibration. No audio or DOM here: tick times are fixed up front on the
 * `performance.now()` clock (the same clock as Swing Onsets), and callbacks
 * announce each tick shortly before it (`onSchedule`, so audio can be
 * scheduled sample-accurately) and at it (`onTick`, for the visual flash).
 * The clock and the polling timer are injectable for deterministic tests.
 */

export interface MetronomeTimer {
  /** Call `fn` repeatedly, every few ms, until `stop`. */
  start(fn: () => void): void;
  stop(): void;
}

export interface MetronomeOptions {
  count: number;
  intervalMs: number;
  /** Delay from `start()` to the first tick. Default 1500. */
  leadInMs?: number;
  /** How far ahead of a tick `onSchedule` fires. Default 150. */
  lookaheadMs?: number;
  /** Clock, default `performance.now`. */
  now?: () => number;
  timer?: MetronomeTimer;
  /** Tick `index` is due at `time` (ms, `performance.now()` clock), shortly from now. */
  onSchedule?(index: number, time: number): void;
  /** Tick `index` (due at `time`) is happening now. */
  onTick?(index: number, time: number): void;
  /** All ticks have fired (not called after `stop()`). */
  onEnd?(): void;
}

export interface Metronome {
  /** Begin ticking; tick times are fixed now. Restarts if already running. */
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Scheduled tick times, `performance.now()` clock; empty before the first start. */
  readonly tickTimes: readonly number[];
}

const POLL_MS = 5;

const intervalTimer = (): MetronomeTimer => {
  let id: ReturnType<typeof setInterval> | undefined;
  return {
    start(fn) {
      id = setInterval(fn, POLL_MS);
    },
    stop() {
      clearInterval(id);
    },
  };
};

export function createMetronome(options: MetronomeOptions): Metronome {
  const { count, intervalMs, leadInMs = 1500, lookaheadMs = 150, onSchedule, onTick, onEnd } = options;
  const now = options.now ?? (() => performance.now());
  const timer = options.timer ?? intervalTimer();
  let tickTimes: number[] = [];
  let scheduled = 0;
  let ticked = 0;
  let running = false;

  function poll(): void {
    const t = now();
    while (scheduled < count && t >= tickTimes[scheduled]! - lookaheadMs) {
      onSchedule?.(scheduled, tickTimes[scheduled]!);
      scheduled++;
    }
    while (ticked < count && t >= tickTimes[ticked]!) {
      onTick?.(ticked, tickTimes[ticked]!);
      ticked++;
    }
    if (ticked >= count) {
      stop();
      onEnd?.();
    }
  }

  function stop(): void {
    if (!running) return;
    running = false;
    timer.stop();
  }

  return {
    start() {
      stop();
      const first = now() + leadInMs;
      tickTimes = Array.from({ length: count }, (_, i) => first + i * intervalMs);
      scheduled = 0;
      ticked = 0;
      running = true;
      timer.start(poll);
    },
    stop,
    get running() {
      return running;
    },
    get tickTimes() {
      return tickTimes;
    },
  };
}
