import { describe, expect, it } from 'vitest';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createPoseInput, type FrameSource } from './poseInput.ts';
import type { SwingParams } from './swingDetector.ts';
import type { SwingEvent } from './types.ts';

const FRAME_MS = 1000 / 30;
const params = (): SwingParams => ({ swingOn: 3, swingOff: 1, cooldownMs: 400 });

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

/** A right-hander facing the camera: right shoulder on the image's left. */
function frame(i: number, wrist: Point2, hand: Hand = 'right'): SensingFrame {
  const [hittingShoulder, otherShoulder] = hand === 'right' ? [{ x: 0.45, y: 0.4 }, { x: 0.55, y: 0.4 }] : [{ x: 0.55, y: 0.4 }, { x: 0.45, y: 0.4 }];
  return {
    t: 1000 + i * FRAME_MS,
    timeSource: 'capture',
    hand,
    landmarks: null,
    wrist,
    hittingShoulder,
    otherShoulder,
    wristVisibility: 0.9,
    inferenceMs: 10,
    meanInferenceMs: 10,
    processedAt: 1000 + i * FRAME_MS + 20,
    cameraFps: 30,
    poseFps: 30,
  };
}

/** A right-handed Forehand: rest on the hitting side, then sweep across at ~9 sw/s (aspect 1). */
const forehandFrames = [0.3, 0.3, 0.3, 0.33, 0.36, 0.39, 0.42, 0.45, 0.45, 0.45].map((x, i) => frame(i, { x, y: 0.5 }));

describe('pose input', () => {
  it('turns sensing frames into Swing events for its subscribers', () => {
    const sensing = fakeSensing();
    const input = createPoseInput(sensing, { params, aspect: () => 1 });
    const swings: SwingEvent[] = [];
    input.subscribe((swing) => swings.push(swing));
    forehandFrames.forEach(sensing.emit);
    expect(swings).toEqual([expect.objectContaining({ t: forehandFrames[4]!.t, side: 'forehand' })]);
  });

  it('processes each frame once, however many times it is read', () => {
    const sensing = fakeSensing();
    const input = createPoseInput(sensing, { params, aspect: () => 1 });
    const swings: SwingEvent[] = [];
    input.subscribe((swing) => swings.push(swing));
    for (const f of forehandFrames) {
      // e.g. the debug overlay reading a frame before the input's own subscription sees it
      const first = input.read(f);
      expect(input.read(f)).toBe(first);
      sensing.emit(f);
    }
    expect(swings).toHaveLength(1);
  });

  it('starts over when the hitting hand changes, so the jump to the other wrist is not a Swing', () => {
    const sensing = fakeSensing();
    const input = createPoseInput(sensing, { params, aspect: () => 1 });
    const swings: SwingEvent[] = [];
    input.subscribe((swing) => swings.push(swing));
    sensing.emit(frame(0, { x: 0.7, y: 0.5 }, 'right'));
    sensing.emit(frame(1, { x: 0.7, y: 0.5 }, 'right'));
    // Now the left wrist is tracked, and it is sweeping in the Forehand Stroke Direction.
    // Measured from the right wrist, frame 2 would already count as fast in the Stroke Direction.
    sensing.emit(frame(2, { x: 0.65, y: 0.5 }, 'left'));
    sensing.emit(frame(3, { x: 0.6, y: 0.5 }, 'left'));
    sensing.emit(frame(4, { x: 0.55, y: 0.5 }, 'left'));
    expect(swings).toHaveLength(1);
    expect(swings[0]!.t).toBe(frame(4, { x: 0, y: 0 }).t);
  });

  it('measures distances in true proportions, stretching normalized x by the video aspect ratio', () => {
    const sensing = fakeSensing();
    const input = createPoseInput(sensing, { params, aspect: () => 4 / 3 });
    // Shoulders 0.1 apart in x (64 px of 640), wrist moving 0.02 in y per frame (9.6 px of 480): 0.15 sw/frame.
    input.read(frame(0, { x: 0.3, y: 0.5 }));
    const reading = input.read(frame(1, { x: 0.3, y: 0.52 }));
    expect(reading?.s).toBeCloseTo(0.15 * 30);
    expect(reading?.vertSpeed).toBeCloseTo(-0.15 * 30);
  });

  it('stops listening to sensing when stopped', () => {
    const sensing = fakeSensing();
    const input = createPoseInput(sensing, { params, aspect: () => 1 });
    const swings: SwingEvent[] = [];
    input.subscribe((swing) => swings.push(swing));
    input.stop();
    forehandFrames.forEach(sensing.emit);
    expect(swings).toEqual([]);
  });
});
