import { hittingSide, type Hand, type Point2, type PoseLandmark } from './landmarks.ts';
import { createOneEuroFilter, type OneEuroParams } from './oneEuro.ts';

/**
 * Picks the hitting wrist and both shoulders out of one frame's landmarks and
 * One-Euro-smooths each coordinate (SPEC "Smoothing: One Euro filter").
 */
export interface SmoothedPose {
  /** Smoothed hitting wrist, or null when no pose was found this frame. */
  wrist: Point2 | null;
  /** Smoothed shoulder on the hitting side, or null. */
  hittingShoulder: Point2 | null;
  /** Smoothed shoulder on the other side, or null. */
  otherShoulder: Point2 | null;
  /** Raw visibility of the hitting wrist, 0..1; 0 when no pose was found. */
  wristVisibility: number;
}

export interface PoseSmoother {
  /** `t` in ms (increasing); `landmarks` null or empty when no pose was found. */
  update(t: number, landmarks: readonly PoseLandmark[] | null): SmoothedPose;
  readonly hand: Hand;
  /** Change the hitting hand; smoothing restarts from the new wrist. */
  setHand(hand: Hand): void;
}

export function createPoseSmoother(options: { params: () => OneEuroParams; hand: Hand }): PoseSmoother {
  let hand = options.hand;
  const wrist = createPointFilter(options.params);
  const hittingShoulder = createPointFilter(options.params);
  const otherShoulder = createPointFilter(options.params);
  const resetAll = () => [wrist, hittingShoulder, otherShoulder].forEach((f) => f.reset());

  return {
    get hand() {
      return hand;
    },
    setHand(next) {
      if (next === hand) return;
      hand = next;
      resetAll();
    },
    update(t, landmarks) {
      const side = hittingSide(hand);
      const w = landmarks?.[side.wrist];
      const h = landmarks?.[side.hittingShoulder];
      const o = landmarks?.[side.otherShoulder];
      if (!w || !h || !o) {
        // Lost: the next pose may be anywhere, so don't drag it from here.
        resetAll();
        return { wrist: null, hittingShoulder: null, otherShoulder: null, wristVisibility: 0 };
      }
      return {
        wrist: wrist.filter(t, w),
        hittingShoulder: hittingShoulder.filter(t, h),
        otherShoulder: otherShoulder.filter(t, o),
        wristVisibility: w.visibility,
      };
    },
  };
}

function createPointFilter(params: () => OneEuroParams) {
  const x = createOneEuroFilter(params);
  const y = createOneEuroFilter(params);
  return {
    filter: (t: number, p: PoseLandmark): Point2 => ({ x: x.filter(p.x, t), y: y.filter(p.y, t) }),
    reset() {
      x.reset();
      y.reset();
    },
  };
}
