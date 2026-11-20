import { describe, expect, it } from 'vitest';
import type { SwingParams } from '../input/swingDetector.ts';
import { replayLog } from './logReplay.ts';

const PARAMS: SwingParams = { swingOn: 5.2, swingOff: 0.5, cooldownMs: 700, minRise: 0.5 };
const FRAME_MS = 40;

type Row = Record<string, string | number | null>;

/** A frame-log CSV, as the debug overlay or detection test downloads it. */
function csv(rows: Row[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.join(','), ...rows.map((row) => columns.map((c) => row[c] ?? '').join(','))].join('\n') + '\n';
}

/**
 * A right-hander facing the camera (unmirrored: their right shoulder on the
 * image's left), shoulders 0.2 of the image width apart. Each entry is the
 * wrist's normalized (x, y); `null` is a frame with no pose.
 */
function frames(wrists: ([number, number] | null)[], startT = 1000): Row[] {
  return wrists.map((w, i) => ({
    t: startT + i * FRAME_MS,
    hand: 'right',
    wristX: w?.[0] ?? null,
    wristY: w?.[1] ?? null,
    hittingShoulderX: w ? 0.4 : null,
    hittingShoulderY: w ? 0.4 : null,
    otherShoulderX: w ? 0.6 : null,
    otherShoulderY: w ? 0.4 : null,
  }));
}

/** Ready on the hitting side, then a rising Forehand across the body (~6 sw/s, ~1 sw/s up at 4:3). */
const FOREHAND: [number, number][] = [
  [0.3, 0.7],
  [0.3, 0.7],
  [0.3, 0.7],
  [0.35, 0.69],
  [0.4, 0.68],
  [0.45, 0.67],
  [0.5, 0.66],
  [0.5, 0.66],
];

describe('replayLog', () => {
  it('turns a logged session back into Swing Onsets through the real pose input', () => {
    const { onsets } = replayLog(csv(frames(FOREHAND)), { params: PARAMS });
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toMatchObject({ t: 1000 + 4 * FRAME_MS, side: 'forehand' });
  });

  it('gives no score for a log without metronome ticks', () => {
    expect(replayLog(csv(frames(FOREHAND)), { params: PARAMS }).score).toBeNull();
  });

  describe('a detection-test log', () => {
    /** A tick on row `tickRow`, then the Forehand, then idle frames. */
    function session(tickRow: number, tickTime?: number): string {
      const rows = frames([...FOREHAND, ...Array.from({ length: 3 }, () => FOREHAND.at(-1)!)]);
      return csv(rows.map((row, i) => ({ ...row, phase: 'ticks', tick: i === tickRow ? 0 : null, ...(i === tickRow && tickTime !== undefined ? { tickTime } : {}) })));
    }

    it('scores the replayed Onsets against the ticks, offset by the Timing Offset', () => {
      // Onset at 1160; the tick's frame is at 1000.
      expect(replayLog(session(0), { params: PARAMS }).score).toMatchObject({ detected: 1, total: 1, falseTriggers: 0 });
      expect(replayLog(session(0), { params: PARAMS, timingOffsetMs: 500 }).score).toMatchObject({ detected: 0 });
    });

    it('uses the exact tick time when the log has it, not the first frame after the tick', () => {
      // Tick frame at 1000, but the tick itself was at 780: the Onset at 1160 is 380 ms late.
      expect(replayLog(session(0, 780), { params: PARAMS }).score).toMatchObject({ detected: 0 });
      expect(replayLog(session(0, 780), { params: PARAMS }).tickTimes).toEqual([780]);
    });

    it('counts Onsets in the idle phase after the last tick as false triggers', () => {
      // The last tick 1.5 s before the Forehand: the idle phase has started.
      const rows = frames(FOREHAND, 2500).map((row) => ({ ...row, phase: 'idle', tick: null }));
      const log = csv([{ ...frames([[0.3, 0.7]], 0)[0]!, phase: 'ticks', tick: 0 }, ...rows]);
      expect(replayLog(log, { params: PARAMS }).score).toMatchObject({ detected: 0, falseTriggers: 1 });
    });
  });
});
