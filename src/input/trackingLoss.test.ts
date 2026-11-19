import { describe, expect, it } from 'vitest';
import { createTrackingLossDetector } from './trackingLoss.ts';

const params = { minVisibility: 0.5, lostAfterFrames: 5, foundAfterFrames: 3 };

/** Feed visibilities in order; returns `tracked` after each one. */
function run(visibilities: number[], detector = createTrackingLossDetector(() => params)): boolean[] {
  return visibilities.map((v) => detector.update(v));
}

describe('tracking loss', () => {
  it('is not tracking until the wrist has been seen for a few frames', () => {
    const detector = createTrackingLossDetector(() => params);
    expect(detector.tracked).toBe(false);
    expect(run([0.9, 0.9, 0.9], detector)).toEqual([false, false, true]);
    expect(detector.tracked).toBe(true);
  });

  it('loses the wrist only when visibility stays below the threshold for more than a few frames', () => {
    const tracked = run([0.9, 0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    // Five low frames are still tracked; the sixth in a row is lost.
    expect(tracked.slice(3)).toEqual([true, true, true, true, true, false]);
  });

  it('rides through a short dip, such as a motion-blurred Swing', () => {
    const tracked = run([0.9, 0.9, 0.9, 0.2, 0.2, 0.2, 0.2, 0.2, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(tracked.slice(2).every(Boolean)).toBe(true);
  });

  it('counts visibility exactly at the threshold as seen', () => {
    expect(run([0.5, 0.5, 0.5])).toEqual([false, false, true]);
  });

  it('finds the wrist again once it is seen for a few frames in a row', () => {
    const detector = createTrackingLossDetector(() => params);
    run([0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0], detector);
    expect(detector.tracked).toBe(false);
    // One visible frame between losses doesn't flicker it back.
    expect(run([0.9, 0.1, 0.9, 0.9, 0.9], detector)).toEqual([false, false, false, false, true]);
  });

  it('forgets everything on reset, as if the wrist had never been seen', () => {
    const detector = createTrackingLossDetector(() => params);
    run([0.9, 0.9, 0.9], detector);
    detector.reset();
    expect(detector.tracked).toBe(false);
    expect(run([0.9, 0.9, 0.9], detector)).toEqual([false, false, true]);
  });
});
