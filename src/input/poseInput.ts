import { SWING_COOLDOWN_MS, SWING_OFF, SWING_ON } from '../game/constants.ts';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createSwingDetector, type SwingParams, type SwingReading } from './swingDetector.ts';
import type { SwingEvent, SwingSource } from './types.ts';

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
  /** Live thresholds; defaults to the `SWING_ON`, `SWING_OFF` and `SWING_COOLDOWN_MS` knobs. */
  params?: () => SwingParams;
  /**
   * Video width / height. MediaPipe normalizes x by width and y by height,
   * so x is stretched by this to make distances true.
   */
  aspect: () => number;
}

const knobParams = (): SwingParams => ({ swingOn: SWING_ON.value, swingOff: SWING_OFF.value, cooldownMs: SWING_COOLDOWN_MS.value });

export function createPoseInput(sensing: FrameSource, options: PoseInputOptions): PoseInput {
  const detector = createSwingDetector(options.params ?? knobParams);
  const listeners = new Set<(swing: SwingEvent) => void>();
  let hand: Hand | null = null;

  function read(frame: SensingFrame): SwingReading | null {
    if (frame.hand !== hand) {
      hand = frame.hand;
      detector.reset();
    }
    const aspect = options.aspect();
    const stretch = (p: Point2 | null): Point2 | null => (p ? { x: p.x * aspect, y: p.y } : null);
    const swing = detector.update({
      t: frame.t,
      wrist: stretch(frame.wrist),
      hittingShoulder: stretch(frame.hittingShoulder),
      otherShoulder: stretch(frame.otherShoulder),
    });
    if (swing) {
      for (const listener of listeners) {
        try {
          listener(swing);
        } catch (error) {
          console.error('Swing listener failed', error);
        }
      }
    }
    // A repeated frame is ignored by the detector, and reads back the same reading.
    return detector.latest?.t === frame.t ? detector.latest : null;
  }

  const unsubscribe = sensing.subscribe((frame) => void read(frame));

  return {
    read,
    stop: unsubscribe,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
