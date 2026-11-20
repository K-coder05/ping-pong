import { SWING_COOLDOWN_MS, SWING_MIN_RISE, SWING_OFF, SWING_ON } from '../game/constants.ts';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createSwingDetector, type SwingParams, type SwingReading, type Vec2 } from './swingDetector.ts';
import { createSwingEmitter } from './swingEmitter.ts';
import type { SwingSource } from './types.ts';

/**
 * Pose input: sensing frames → Swing detector → `SwingEvent`s. The game
 * subscribes to it as a `SwingSource`, exactly like the mouse input.
 *
 * The hitting hand comes from the frames themselves (sensing picks the wrist
 * and shoulders for `Sensing.hand`); when it changes, detection starts over.
 */
export interface PoseInput extends SwingSource {
  /**
   * The detector's reading for this frame. Each frame is processed once,
   * whoever asks first (this input's own sensing subscription, or the debug
   * overlay drawing or logging the frame); later reads of it return the same
   * reading, so the order of sensing subscribers doesn't matter.
   */
  read(frame: SensingFrame): SwingReading | null;
  /** Stop listening to sensing. */
  stop(): void;
}

/** The part of `Sensing` pose input needs. */
export interface FrameSource {
  subscribe(listener: (frame: SensingFrame) => void): () => void;
}

export interface PoseInputOptions {
  /** Live thresholds; defaults to the `SWING_*` knobs. */
  params?: () => SwingParams;
  /**
   * Video width / height. MediaPipe normalizes x by width and y by height,
   * so x is stretched by this to make distances true (in units of image
   * height). The detector's readings, and so the CSV's px/py, are in these
   * true proportions, not raw normalized coordinates.
   */
  aspect: () => number;
}

/**
 * Shoulders closer than this (in units of image height) mean the player is
 * turned almost side-on: a player at 2 m is about 0.15–0.25 wide. Dividing by
 * such a tiny width would turn any wrist wobble into a fast Swing, so the
 * frame counts as not tracked.
 */
const MIN_SHOULDER_WIDTH = 0.04;

/** Swing detector thresholds from the live `SWING_*` knobs (pose and mouse; mouse mode ignores `minRise`). */
export const knobSwingParams = (): SwingParams => ({
  swingOn: SWING_ON.value,
  swingOff: SWING_OFF.value,
  cooldownMs: SWING_COOLDOWN_MS.value,
  minRise: SWING_MIN_RISE.value,
});

export function createPoseInput(sensing: FrameSource, options: PoseInputOptions): PoseInput {
  const detector = createSwingDetector(options.params ?? knobSwingParams);
  const swings = createSwingEmitter();
  let hand: Hand | null = null;

  function read(frame: SensingFrame): SwingReading | null {
    if (frame.hand !== hand) {
      hand = frame.hand;
      detector.reset();
    }
    const aspect = options.aspect();
    const stretch = (p: Point2 | null): Vec2 | null => (p ? { x: p.x * aspect, y: p.y } : null);
    const H = stretch(frame.hittingShoulder);
    const N = stretch(frame.otherShoulder);
    const sideOn = H && N && Math.hypot(H.x - N.x, H.y - N.y) < MIN_SHOULDER_WIDTH;
    const swing = detector.update({
      t: frame.t,
      wrist: stretch(frame.wrist),
      hittingShoulder: sideOn ? null : H,
      otherShoulder: sideOn ? null : N,
    });
    if (swing) swings.emit(swing);
    // A repeated frame is ignored by the detector, and reads back the same reading.
    return detector.latest?.t === frame.t ? detector.latest : null;
  }

  const unsubscribe = sensing.subscribe((frame) => void read(frame));

  return {
    read,
    stop: unsubscribe,
    subscribe: swings.subscribe,
  };
}
