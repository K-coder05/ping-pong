/**
 * Tracking loss (SPEC "Sensing", Tracking loss): whether the game can see the
 * hitting wrist, from its MediaPipe visibility once per camera frame.
 *
 * The wrist is lost when its visibility stays below `minVisibility` for more
 * than `lostAfterFrames` frames in a row, so a short dip (a motion-blurred
 * Swing) never counts. It is found again once it is seen for
 * `foundAfterFrames` frames in a row, so a wrist hovering near the threshold
 * doesn't flicker between the two. It starts out lost: never seen yet.
 */

export interface TrackingLossParams {
  /** Visibility at or above this counts as seen (`TRACKING_MIN_VISIBILITY`). */
  minVisibility: number;
  /** Lost on the frame after this many unseen frames in a row. */
  lostAfterFrames: number;
  /** Found again after this many seen frames in a row. */
  foundAfterFrames: number;
}

export interface TrackingLossDetector {
  /** Feed one camera frame's wrist visibility (0 when no pose was found). Returns `tracked`. */
  update(wristVisibility: number): boolean;
  /** Whether the hitting wrist is being tracked. */
  readonly tracked: boolean;
  /** Back to never seen (e.g. after a hitting-hand change). */
  reset(): void;
}

/** `params` is read every frame (live knobs). */
export function createTrackingLossDetector(params: () => TrackingLossParams): TrackingLossDetector {
  let tracked = false;
  /** Frames in a row that disagree with `tracked`. */
  let disagreeing = 0;

  return {
    get tracked() {
      return tracked;
    },
    update(wristVisibility) {
      const { minVisibility, lostAfterFrames, foundAfterFrames } = params();
      const seen = wristVisibility >= minVisibility;
      disagreeing = seen === tracked ? 0 : disagreeing + 1;
      const needed = tracked ? lostAfterFrames + 1 : foundAfterFrames;
      if (disagreeing >= needed) {
        tracked = seen;
        disagreeing = 0;
      }
      return tracked;
    },
    reset() {
      tracked = false;
      disagreeing = 0;
    },
  };
}
