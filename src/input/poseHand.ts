import { TRACKING_FOUND_FRAMES, TRACKING_LOST_FRAMES, TRACKING_MIN_VISIBILITY } from '../game/constants.ts';
import type { Hand } from '../sensing/landmarks.ts';
import type { SensingFrame } from '../sensing/sensingFrame.ts';
import { createHandPositionStore, handPositionFromReading, type HandPositionSource } from './handPosition.ts';
import type { FrameSource, PoseInput } from './poseInput.ts';
import { createTrackingLossDetector, type TrackingLossParams } from './trackingLoss.ts';

/**
 * The hitting wrist as pose sees it, for the game: whether it is tracked
 * (SPEC "Tracking loss") and where it is, for the Paddle to follow.
 *
 * Positions are the pose Swing detector's own readings, so the Paddle and
 * Swings agree on where the wrist is. A frame without a reading (no pose
 * found) keeps the last position, so a brief dropout doesn't snap the
 * Paddle away; once the wrist is lost, there is no position until it is
 * tracked again.
 */
export interface PoseHand extends HandPositionSource {
  /** Whether the hitting wrist is tracked; false until first seen, and while lost. */
  readonly tracked: boolean;
  /** Stop listening to sensing. */
  stop(): void;
}

export interface PoseHandOptions {
  /** Tracking-loss thresholds, read every frame; defaults to the `TRACKING_MIN_VISIBILITY`, `TRACKING_LOST_FRAMES` and `TRACKING_FOUND_FRAMES` knobs. */
  tracking?: () => TrackingLossParams;
}

const defaultTracking = (): TrackingLossParams => ({
  minVisibility: TRACKING_MIN_VISIBILITY.value,
  lostAfterFrames: TRACKING_LOST_FRAMES.value,
  foundAfterFrames: TRACKING_FOUND_FRAMES.value,
});

/**
 * Track the hitting wrist from `sensing`'s frames, positioned by `input`'s
 * readings of the same frames (each frame is read once, whoever asks first).
 */
export function createPoseHand(sensing: FrameSource, input: Pick<PoseInput, 'read'>, options: PoseHandOptions = {}): PoseHand {
  const tracking = createTrackingLossDetector(options.tracking ?? defaultTracking);
  const wrist = createHandPositionStore();
  let hand: Hand | null = null;

  function update(frame: SensingFrame): void {
    if (frame.hand !== hand) {
      // A different wrist: it must be seen before it counts as tracked.
      hand = frame.hand;
      tracking.reset();
      wrist.clear();
    }
    const tracked = tracking.update(frame.wristVisibility);
    const reading = input.read(frame);
    if (!tracked) wrist.clear();
    else if (reading) wrist.set(handPositionFromReading(reading));
  }

  const unsubscribe = sensing.subscribe(update);

  return {
    get tracked() {
      return tracking.tracked;
    },
    get latest() {
      return wrist.latest;
    },
    stop: unsubscribe,
  };
}
