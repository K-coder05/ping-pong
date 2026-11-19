/**
 * MediaPipe Pose landmark indices and the hitting-side selection.
 * MediaPipe's left/right is the *person's* side, not the image's.
 */

/** Which hand holds the paddle. */
export type Hand = 'left' | 'right';

/** A point in normalized image coordinates: x, y in 0..1 from the top-left of the *unmirrored* camera frame. */
export interface Point2 {
  x: number;
  y: number;
}

/** One pose landmark (structurally MediaPipe's `NormalizedLandmark`). */
export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  /** Likelihood the landmark is visible in the image, 0..1. */
  visibility: number;
}

export const LANDMARK = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
} as const;

export type LandmarkName = keyof typeof LANDMARK;

/** The landmarks the game tracks (SPEC "Landmarks you need"), drawn by the debug overlay. */
export const TRACKED_LANDMARKS: readonly LandmarkName[] = Object.keys(LANDMARK) as LandmarkName[];

export interface HittingSide {
  wrist: number;
  hittingShoulder: number;
  otherShoulder: number;
}

/** Landmark indices of the hitting wrist and the two shoulders for a hand. */
export function hittingSide(hand: Hand): HittingSide {
  return hand === 'right'
    ? { wrist: LANDMARK.rightWrist, hittingShoulder: LANDMARK.rightShoulder, otherShoulder: LANDMARK.leftShoulder }
    : { wrist: LANDMARK.leftWrist, hittingShoulder: LANDMARK.leftShoulder, otherShoulder: LANDMARK.rightShoulder };
}
