import { describe, expect, it } from 'vitest';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createPoseHand } from './poseHand.ts';
import { createPoseInput, type FrameSource } from './poseInput.ts';
import type { SwingParams } from './swingDetector.ts';

const FRAME_MS = 1000 / 30;
const params = (): SwingParams => ({ swingOn: 3, swingOff: 1, cooldownMs: 400 });
const tracking = { minVisibility: 0.5, lostAfterFrames: 5, foundAfterFrames: 3 };

function fakeSensing(): FrameSource & { emit(frame: SensingFrame): void } {
  const listeners = new Set<(frame: SensingFrame) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (frame) => listeners.forEach((listener) => listener(frame)),
  };
}

let nextFrame = 0;

/**
 * The next camera frame of a right-hander facing the camera (right shoulder
 * on the image's left), shoulders 0.1 apart at y 0.4. A wrist at (0.3, 0.5)
 * is 2 shoulder widths out on the hitting side, 1 below the shoulders.
 */
function frame(wrist: Point2 | null, wristVisibility: number, hand: Hand = 'right'): SensingFrame {
  const [hittingShoulder, otherShoulder] = hand === 'right' ? [{ x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 }] : [{ x: 0.55, y: 0.4 }, { x: 0.45, y: 0.4 }];
  const t = 1000 + nextFrame++ * FRAME_MS;
  return {
    t,
    timeSource: 'capture',
    hand,
    landmarks: null,
    wrist,
    hittingShoulder: wrist && hittingShoulder,
    otherShoulder: wrist && otherShoulder,
    wristVisibility,
    inferenceMs: 10,
    meanInferenceMs: 10,
    processedAt: t + 20,
    cameraFps: 30,
    poseFps: 30,
  };
}

const AT_SIDE = { x: 0.3, y: 0.5 };

function setup() {
  const sensing = fakeSensing();
  const input = createPoseInput(sensing, { params, aspect: () => 1 });
  const hand = createPoseHand(sensing, input, { tracking: () => tracking });
  const emit = (wrist: Point2 | null, visibility: number, n = 1, side: Hand = 'right') => {
    for (let i = 0; i < n; i++) sensing.emit(frame(wrist, visibility, side));
  };
  return { hand, emit };
}

describe('pose hand', () => {
  it('follows the tracked wrist, in shoulder widths, once it has been seen for a few frames', () => {
    const { hand, emit } = setup();
    emit(AT_SIDE, 0.9, 2);
    expect(hand.tracked).toBe(false);
    expect(hand.latest).toBeNull();

    emit(AT_SIDE, 0.9);
    expect(hand.tracked).toBe(true);
    expect(hand.latest).toEqual({ t: expect.any(Number), u: expect.closeTo(2, 6), py: expect.closeTo(1, 6) });
  });

  it('keeps the last wrist position through a brief dropout, then clears it once the wrist is lost', () => {
    const { hand, emit } = setup();
    emit(AT_SIDE, 0.9, 3);
    const seen = hand.latest;

    emit(null, 0, 5); // no pose for five frames: still tracked, the Paddle stays put
    expect(hand.tracked).toBe(true);
    expect(hand.latest).toEqual(seen);

    emit(null, 0); // the sixth: lost
    expect(hand.tracked).toBe(false);
    expect(hand.latest).toBeNull();
  });

  it('finds the wrist again when it comes back into view', () => {
    const { hand, emit } = setup();
    emit(AT_SIDE, 0.9, 3);
    emit(AT_SIDE, 0.2, 6); // hidden behind the back
    expect(hand.tracked).toBe(false);

    emit({ x: 0.5, y: 0.6 }, 0.9, 3); // at the midline, 2 below the shoulders
    expect(hand.tracked).toBe(true);
    expect(hand.latest).toEqual({ t: expect.any(Number), u: expect.closeTo(0, 6), py: expect.closeTo(2, 6) });
  });

  it('must see the new wrist after a hitting-hand change', () => {
    const { hand, emit } = setup();
    emit(AT_SIDE, 0.9, 3);
    emit({ x: 0.7, y: 0.5 }, 0.9, 1, 'left');
    expect(hand.tracked).toBe(false);
    expect(hand.latest).toBeNull();
    emit({ x: 0.7, y: 0.5 }, 0.9, 2, 'left');
    expect(hand.tracked).toBe(true);
    expect(hand.latest?.u).toBeCloseTo(2, 6);
  });
});
