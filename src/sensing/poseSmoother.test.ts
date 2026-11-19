import { describe, expect, it } from 'vitest';
import type { PoseLandmark } from './landmarks.ts';
import { createPoseSmoother } from './poseSmoother.ts';

const FRAME_MS = 1000 / 30;
const NO_SMOOTHING = () => ({ minCutoff: 1000, beta: 0 });
const HEAVY_SMOOTHING = () => ({ minCutoff: 0.1, beta: 0 });

/** A 33-landmark pose with every point at (0, 0), overridden by index. */
function pose(points: Record<number, Partial<PoseLandmark>>): PoseLandmark[] {
  return Array.from({ length: 33 }, (_, i) => ({ x: 0, y: 0, z: 0, visibility: 0.9, ...points[i] }));
}

// MediaPipe indices (the person's own sides): 11/12 shoulders, 15/16 wrists.
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;

const sampleOverrides = {
  [LEFT_SHOULDER]: { x: 0.6, y: 0.4 },
  [RIGHT_SHOULDER]: { x: 0.4, y: 0.41 },
  [LEFT_WRIST]: { x: 0.7, y: 0.6, visibility: 0.3 },
  [RIGHT_WRIST]: { x: 0.25, y: 0.55, visibility: 0.95 },
};
const sample = pose(sampleOverrides);

describe('pose smoother', () => {
  it('picks the right wrist and shoulder as the hitting side for a right-hander', () => {
    const smoother = createPoseSmoother({ params: NO_SMOOTHING, hand: 'right' });
    const out = smoother.update(0, sample);
    expect(out.wrist).toEqual({ x: 0.25, y: 0.55 });
    expect(out.hittingShoulder).toEqual({ x: 0.4, y: 0.41 });
    expect(out.otherShoulder).toEqual({ x: 0.6, y: 0.4 });
    expect(out.wristVisibility).toBe(0.95);
  });

  it('switches to the left wrist when the hitting hand changes, without dragging from the old wrist', () => {
    const smoother = createPoseSmoother({ params: HEAVY_SMOOTHING, hand: 'right' });
    smoother.update(0, sample);
    smoother.setHand('left');
    const out = smoother.update(FRAME_MS, sample);
    expect(smoother.hand).toBe('left');
    expect(out.wrist).toEqual({ x: 0.7, y: 0.6 });
    expect(out.hittingShoulder).toEqual({ x: 0.6, y: 0.4 });
    expect(out.otherShoulder).toEqual({ x: 0.4, y: 0.41 });
    expect(out.wristVisibility).toBe(0.3);
  });

  it('smooths the wrist between frames', () => {
    const smoother = createPoseSmoother({ params: HEAVY_SMOOTHING, hand: 'right' });
    smoother.update(0, sample);
    const moved = pose({ ...sampleOverrides, [RIGHT_WRIST]: { x: 0.75, y: 0.55 } });
    const x = smoother.update(FRAME_MS, moved).wrist?.x ?? NaN;
    expect(x).toBeGreaterThan(0.25);
    expect(x).toBeLessThan(0.3);
  });

  it('reports no points and zero wrist visibility when no pose is found', () => {
    const smoother = createPoseSmoother({ params: NO_SMOOTHING, hand: 'right' });
    for (const none of [null, []]) {
      expect(smoother.update(0, none)).toEqual({ wrist: null, hittingShoulder: null, otherShoulder: null, wristVisibility: 0 });
    }
  });

  it('restarts smoothing when the pose comes back after being lost', () => {
    const smoother = createPoseSmoother({ params: HEAVY_SMOOTHING, hand: 'right' });
    smoother.update(0, sample);
    smoother.update(FRAME_MS, null);
    const back = pose({ ...sampleOverrides, [RIGHT_WRIST]: { x: 0.75, y: 0.5 } });
    expect(smoother.update(2 * FRAME_MS, back).wrist).toEqual({ x: 0.75, y: 0.5 });
  });
});
