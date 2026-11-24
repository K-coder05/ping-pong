/**
 * One Detection test run (SPEC "Detection test"), for either Input: collects
 * the Swing Onsets from any `SwingSource` while the ticks and the idle phase
 * run, then scores them with `scoreSession`. Pure apart from the
 * subscription; the page (`detectionTest.ts`) drives the phases from its
 * metronome and timers.
 *
 * The Camera's Swings are stamped with their frame's capture time and the
 * Phone's with its motion event put on the laptop's clock by clock sync, so
 * both land on the same `performance.now()` clock as the ticks.
 */
import type { SwingSource } from '../input/types.ts';
import { idlePhase, scoreSession, type SessionData, type SessionScore } from './detectionScore.ts';

export type DetectionPhase = 'setup' | 'ticks' | 'idle' | 'done';

export interface DetectionRun {
  readonly phase: DetectionPhase;
  /** The Swing Onsets seen during the ticks and the idle phase, ms. */
  readonly onsets: readonly number[];
  readonly tickTimes: readonly number[];
  /** Part 1: Swing on each of `tickTimes`, judged against the tick plus `timingOffsetMs`. Forgets any earlier run. */
  begin(tickTimes: readonly number[], timingOffsetMs: number): void;
  /** Part 2: the idle phase after the last tick. Returns it. */
  startIdle(): SessionData['idle'];
  /** Stop collecting and score the run. */
  finish(): SessionScore;
  /** Back to setup: Swings are ignored until the next `begin`. */
  reset(): void;
}

export function createDetectionRun(swings: SwingSource): DetectionRun {
  let phase: DetectionPhase = 'setup';
  let onsets: number[] = [];
  let tickTimes: readonly number[] = [];
  let timingOffsetMs = 0;
  let idle: SessionData['idle'] = { start: 0, end: 0 };

  swings.subscribe((swing) => {
    if (phase === 'ticks' || phase === 'idle') onsets.push(swing.t);
  });

  return {
    get phase() {
      return phase;
    },
    get onsets() {
      return onsets;
    },
    get tickTimes() {
      return tickTimes;
    },
    begin(ticks, offsetMs) {
      phase = 'ticks';
      onsets = [];
      tickTimes = ticks;
      timingOffsetMs = offsetMs;
    },
    startIdle() {
      idle = idlePhase(tickTimes[tickTimes.length - 1] ?? 0);
      phase = 'idle';
      return idle;
    },
    finish() {
      phase = 'done';
      return scoreSession({ tickTimes, onsets, idle, timingOffsetMs });
    },
    reset() {
      phase = 'setup';
    },
  };
}
