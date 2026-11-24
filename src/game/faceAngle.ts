/**
 * Face Angle (GLOSSARY, ADR 0003, spec P3-f): with the Phone, how far the
 * bat's face is tipped from upright at Swing Onset, in radians from Zero,
 * + closed (toward the floor), − open (toward the ceiling). It sets a Return's
 * or Serve's Spin and answers an incoming Shot's Spin instead of Lift.
 *
 * The Face Angle share f in [−1, 1] is what the resolver works with: 0 within
 * ±`deadDeg` of Zero, rising linearly to ±1 at `fullDeg`, positive when closed.
 */

import { FACE_ANGLE_DEAD_DEG, FACE_ANGLE_FULL_DEG, PHONE_SPEED_FULL, RETURN_BACKSPIN_MAX_REVS } from './constants.ts';

/** What `faceAngleShare` needs: the dead zone and the angle of full Spin, degrees from Zero. */
export interface FaceAngleShareParams {
  /** `FACE_ANGLE_DEAD_DEG`: within this of Zero, either way, the share is 0. */
  deadDeg: number;
  /** `FACE_ANGLE_FULL_DEG`: at or past this, either way, the share is ±1. */
  fullDeg: number;
}

/** Live tuning values for Swings with a Face Angle (knobs in the game). */
export interface FaceAngleParams extends FaceAngleShareParams {
  /** `RETURN_BACKSPIN_MAX_REVS`: Backspin of a fully open, full-speed Swing, revolutions/s. */
  backspinMaxRevs: number;
  /** `PHONE_SPEED_FULL`: the peakSpeed at which a Face Angle sets its full Spin. */
  speedFull: number;
}

const DEG = Math.PI / 180;

/**
 * The Face Angle share f in [−1, 1] of a Face Angle in radians: 0 within
 * ±`deadDeg`, linear to ±1 at `fullDeg`, + when closed. A non-finite Face
 * Angle is 0. If the knobs overlap (`fullDeg` ≤ `deadDeg`) it is a step: 0 up
 * to `deadDeg`, ±1 past it.
 */
export function faceAngleShare(faceAngleRad: number, params: FaceAngleShareParams): number {
  if (!Number.isFinite(faceAngleRad)) return 0;
  const deg = Math.abs(faceAngleRad) / DEG;
  if (deg <= params.deadDeg) return 0;
  const size = params.fullDeg <= params.deadDeg ? 1 : Math.min(1, (deg - params.deadDeg) / (params.fullDeg - params.deadDeg));
  return Math.sign(faceAngleRad) * size;
}

/**
 * The smallest Face Angle (radians, + closed) whose share is `share`: Zero for
 * 0, else from the edge of the dead zone out to `fullDeg` for ±1. The share is
 * clamped to [−1, 1]. The inverse of `faceAngleShare` outside the dead zone.
 */
export function faceAngleForShare(share: number, params: FaceAngleShareParams): number {
  if (!Number.isFinite(share) || share === 0) return 0;
  const size = Math.min(1, Math.abs(share));
  const span = Math.max(0, params.fullDeg - params.deadDeg);
  return Math.sign(share) * (params.deadDeg + size * span) * DEG;
}

/** The Face Angle parameters from the live knobs. */
export function knobFaceAngleParams(): FaceAngleParams {
  return {
    deadDeg: FACE_ANGLE_DEAD_DEG.value,
    fullDeg: FACE_ANGLE_FULL_DEG.value,
    backspinMaxRevs: RETURN_BACKSPIN_MAX_REVS.value,
    speedFull: PHONE_SPEED_FULL.value,
  };
}
