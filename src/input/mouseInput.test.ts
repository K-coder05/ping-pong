import { describe, expect, it } from 'vitest';
import type { Hand } from '../sensing/landmarks.ts';
import { createMouseSwingTracker, swingInputMode } from './mouseInput.ts';
import type { SwingEvent } from './types.ts';

const WIDTH = 1000;
const HEIGHT = 600;
const STEP_MS = 16;

function tracker(hand: Hand = 'right') {
  return createMouseSwingTracker({
    params: () => ({ swingOn: 3, swingOff: 1, cooldownMs: 400 }),
    hand: () => hand,
    shoulderWidth: () => 1,
  });
}

/** Press at `fromX`, then move `dxPerStep` pixels every 16 ms for `steps` samples; returns the Swings. */
function drag(t: ReturnType<typeof tracker>, fromX: number, dxPerStep: number, steps = 6, startMs = 1000): SwingEvent[] {
  const swings: SwingEvent[] = [];
  const size = { width: WIDTH, height: HEIGHT };
  t.press({ t: startMs, x: fromX, y: 300, ...size });
  for (let i = 1; i <= steps; i++) {
    const swing = t.move({ t: startMs + i * STEP_MS, x: fromX + i * dxPerStep, y: 300, ...size });
    if (swing) swings.push(swing);
  }
  t.release();
  return swings;
}

describe('mouse Swings (screen width = shoulder width, canvas centre = midline)', () => {
  it("turns a right-hander's fast leftward drag on the right half into a Forehand", () => {
    // 100 px per 16 ms on a 1000 px canvas: 6.25 screen widths per second.
    const swings = drag(tracker(), 900, -100);
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ side: 'forehand', t: 1000 + 2 * STEP_MS });
    expect(swings[0]!.peakSpeed).toBeCloseTo(6.25);
  });

  it('turns a fast rightward drag on the left half into a Backhand', () => {
    const swings = drag(tracker(), 100, 100);
    expect(swings).toHaveLength(1);
    expect(swings[0]!.side).toBe('backhand');
  });

  it('never triggers on a drag in the wrong direction for its side (a Backswing)', () => {
    expect(drag(tracker(), 500 + 10, 60)).toEqual([]); // right half, moving right
    expect(drag(tracker(), 500 - 10, -60)).toEqual([]); // left half, moving left
  });

  it('mirrors the sides for a left-hander', () => {
    const swings = drag(tracker('left'), 100, 100);
    expect(swings[0]!.side).toBe('forehand');
  });

  it('ignores slow drags', () => {
    expect(drag(tracker(), 900, -20)).toEqual([]); // 1.25 widths/s
  });

  it('does nothing while no button is held', () => {
    const t = tracker();
    const size = { width: WIDTH, height: HEIGHT };
    const swings = [0, 1, 2, 3, 4].map((i) => t.move({ t: 1000 + i * STEP_MS, x: 900 - i * 100, y: 300, ...size }));
    expect(swings.every((s) => s === null)).toBe(true);
  });

  it('lets each new drag Swing again', () => {
    const t = tracker();
    expect(drag(t, 900, -100, 6, 1000)).toHaveLength(1);
    expect(drag(t, 900, -100, 6, 2000)).toHaveLength(1);
  });
});

describe('swingInputMode', () => {
  it('uses the mouse only with ?input=mouse, otherwise pose', () => {
    expect(swingInputMode('?input=mouse')).toBe('mouse');
    expect(swingInputMode('?overlay&input=mouse')).toBe('mouse');
    expect(swingInputMode('')).toBe('pose');
    expect(swingInputMode('?input=pose')).toBe('pose');
    expect(swingInputMode('?mouse')).toBe('pose');
  });
});
