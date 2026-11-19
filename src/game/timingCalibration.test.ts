import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSwingEmitter } from '../input/swingEmitter.ts';
import { measureTimingOffset, runTimingCalibration } from './timingCalibration.ts';

const swingAt = (t: number) => ({ t, peakSpeed: 5, side: 'forehand' as const, vertPath: 0 });

describe('runTimingCalibration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  /** Calibration on a fake clock: 6 ticks, 1 s apart, the first at 2000 ms. */
  function start() {
    const swings = createSwingEmitter();
    const ticks: number[] = [];
    const run = runTimingCalibration({
      swings,
      count: 6,
      intervalMs: 1000,
      leadInMs: 2000,
      now: () => Date.now(),
      onTick: (_index, time) => ticks.push(time),
    });
    let outcome: unknown = 'pending';
    void run.result.then((result) => (outcome = result));
    /** Swing `afterTickMs` after each tick as it plays. */
    const swingOnEachTick = (afterTickMs: number[]) => {
      for (const [i, after] of afterTickMs.entries()) {
        vi.advanceTimersByTime(2000 + i * 1000 + after - Date.now());
        swings.emit(swingAt(Date.now()));
      }
    };
    return { swings, ticks, run, swingOnEachTick, outcome: () => outcome };
  }

  it('measures the Timing Offset from Swings made on the ticks', async () => {
    const { ticks, swingOnEachTick, outcome } = start();
    swingOnEachTick([100, 140, 120, 160, 130, 150]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toEqual([2000, 3000, 4000, 5000, 6000, 7000]);
    expect(outcome()).toEqual({ offsetMs: 135, paired: 6 });
  });

  it('waits after the last tick for its Swing', async () => {
    const { swings, swingOnEachTick, outcome } = start();
    swingOnEachTick([100, 140, 120, 160, 130]);
    await vi.advanceTimersByTimeAsync(7000 + 300 - Date.now());
    expect(outcome()).toBe('pending');
    swings.emit(swingAt(Date.now())); // the last tick's Swing, 300 ms late
    await vi.advanceTimersByTimeAsync(1000);
    expect(outcome()).toEqual({ offsetMs: 135, paired: 6 }); // 100 120 130 | 140 160 300
  });

  it('ignores Swings once cancelled and never resolves', async () => {
    const { swings, run, outcome } = start();
    run.cancel();
    swings.emit(swingAt(Date.now()));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome()).toBe('pending');
  });
});

const TICKS = [1000, 2500, 4000, 5500, 7000, 8500];
const INTERVAL = 1500;

describe('measureTimingOffset', () => {
  it('is the median of Swing Onset minus tick time', () => {
    const onsets = [1120, 2650, 4130, 5640, 7110, 8660]; // 120 150 130 140 110 160
    expect(measureTimingOffset(TICKS, onsets, INTERVAL)).toEqual({ offsetMs: 135, paired: 6 });
  });

  it('skips a tick the player missed instead of pairing it with the next Swing', () => {
    const onsets = [1120, /* missed 2500 */ 4130, 5640, 7110, 8660]; // 120 130 140 110 160
    expect(measureTimingOffset(TICKS, onsets, INTERVAL)).toEqual({ offsetMs: 130, paired: 5 });
  });

  it('pairs each tick with its nearest Swing and ignores extra Swings', () => {
    // A second Swing 500 ms after the first tick's, and a stray one before the first tick's window.
    const onsets = [-200, 1120, 1620, 2650, 4130, 5640, 7110, 8660];
    expect(measureTimingOffset(TICKS, onsets, INTERVAL)).toEqual({ offsetMs: 135, paired: 6 });
  });

  it('pairs a Swing made before its tick (negative difference)', () => {
    const onsets = [940, 2440, 3950, 5450, 6960, 8460]; // −60 −60 −50 −50 −40 −40
    expect(measureTimingOffset(TICKS, onsets, INTERVAL)).toEqual({ offsetMs: -50, paired: 6 });
  });

  it('lets one wild Swing barely move the result', () => {
    const onsets = [1120, 2650, 4130, 5640 + 600, 7110, 8660]; // 120 150 130 740 110 160
    expect(measureTimingOffset(TICKS, onsets, INTERVAL)).toEqual({ offsetMs: 140, paired: 6 });
  });

  it('gives no measurement when fewer than half the ticks have a Swing', () => {
    expect(measureTimingOffset(TICKS, [1120, 2650], INTERVAL)).toBeNull();
    expect(measureTimingOffset(TICKS, [], INTERVAL)).toBeNull();
  });
});
