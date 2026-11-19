import type { TimeSource } from './camera.ts';
import type { CsvRow } from './frameLog.ts';
import { hittingSide, type Hand, type PoseLandmark } from './landmarks.ts';
import type { SmoothedPose } from './poseSmoother.ts';

/**
 * Everything sensing knows about one camera frame. Emitted once per camera
 * frame that went through pose inference; subscribers (debug overlay, latency
 * harness, Swing detector) never need to touch the camera or MediaPipe.
 *
 * Positions are normalized image coordinates of the *unmirrored* camera frame
 * (x, y in 0..1 from top-left). Mirror only when drawing.
 */
export interface SensingFrame extends SmoothedPose {
  /**
   * When the camera captured this frame, ms on the `performance.now()` clock.
   * Use this (not the time the frame was processed) for velocities and for
   * comparing against game time.
   */
  t: number;
  /** Which `requestVideoFrameCallback` timestamp `t` came from (see `TimeSource`). */
  timeSource: TimeSource;
  /** The hitting hand the wrist and shoulders were picked for. */
  hand: Hand;
  /** All 33 raw (unsmoothed) MediaPipe landmarks, or null when no pose was found. */
  landmarks: readonly PoseLandmark[] | null;
  /** Wall time `detectForVideo` took for this frame, ms. */
  inferenceMs: number;
  /** Mean `inferenceMs` over the last ~second, ms. */
  meanInferenceMs: number;
  /**
   * When this frame's result was ready (end of `detectForVideo` and
   * smoothing), ms on the `performance.now()` clock. `processedAt - t` is the
   * capture-to-result delay (SPEC "Latency harness" step 5).
   */
  processedAt: number;
  /** Real camera frame rate over the last ~second, or null at start. */
  cameraFps: number | null;
  /** Frames per second that went through pose inference, or null at start. */
  poseFps: number | null;
}

/** The frame-log CSV row for one frame. Every frame has the same columns. */
export function frameLogRow(frame: SensingFrame): CsvRow {
  const rawWrist = frame.landmarks?.[hittingSide(frame.hand).wrist];
  return {
    t: frame.t,
    hand: frame.hand,
    wristVisibility: frame.wristVisibility,
    wristRawX: rawWrist?.x ?? null,
    wristRawY: rawWrist?.y ?? null,
    wristX: frame.wrist?.x ?? null,
    wristY: frame.wrist?.y ?? null,
    hittingShoulderX: frame.hittingShoulder?.x ?? null,
    hittingShoulderY: frame.hittingShoulder?.y ?? null,
    otherShoulderX: frame.otherShoulder?.x ?? null,
    otherShoulderY: frame.otherShoulder?.y ?? null,
    inferenceMs: frame.inferenceMs,
    captureToResultMs: frame.processedAt - frame.t,
    cameraFps: frame.cameraFps,
    poseFps: frame.poseFps,
  };
}
