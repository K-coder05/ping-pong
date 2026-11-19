import type { SwingEvent } from './types.ts';

/**
 * Pose Swing detector (SPEC "Swing detection", steps 1–9): turns the hitting
 * wrist and both shoulders, once per camera frame, into Swing Onsets.
 *
 * Everything is measured in shoulder widths along the body axis (the unit
 * vector from the other shoulder toward the hitting shoulder), so the same
 * thresholds work at any distance, for either hand, mirrored or not.
 *
 * Points must share one scale on both axes for distances and the body axis to
 * be true; `poseInput.ts` stretches MediaPipe's normalized x by the video's
 * aspect ratio before calling `update`.
 */

/**
 * A point or vector in any coordinates with the same scale on both axes
 * (unlike MediaPipe's normalized `Point2`), y pointing down as in images.
 */
export interface Vec2 {
  x: number;
  y: number;
}

/** One camera frame's hitting-side points. */
export interface SwingDetectorInput {
  /** Capture time, ms. Velocities use real frame-to-frame time. */
  t: number;
  wrist: Vec2 | null;
  hittingShoulder: Vec2 | null;
  otherShoulder: Vec2 | null;
}

/** Live thresholds, read every frame (knobs). */
export interface SwingParams {
  /** Stroke speed that starts a Swing, shoulder widths/s (`SWING_ON`). */
  swingOn: number;
  /** Total speed the wrist must drop below once before the next Swing (`SWING_OFF`). */
  swingOff: number;
  /** Onsets closer than this to the last one are ignored (`SWING_COOLDOWN_MS`). */
  cooldownMs: number;
}

/** What the detector measured on one frame: the overlay's bar and the CSV columns. */
export interface SwingReading {
  t: number;
  /** Normalized wrist position, (wrist − midline) / shoulder width. */
  p: Vec2;
  /** Wrist position along the body axis, shoulder widths; > 0 on the hitting side. */
  u: number;
  side: SwingEvent['side'];
  /** Total wrist speed, shoulder widths/s; null on the first frame after (re)acquiring the pose. */
  s: number | null;
  /** Wrist speed in the Stroke Direction for the current side, shoulder widths/s; negative for a Backswing. */
  sStroke: number | null;
  /** Vertical wrist speed, shoulder widths/s; + = moving upward. */
  vertSpeed: number | null;
  /** Whether the wrist has slowed below `swingOff` since the last Onset. */
  armed: boolean;
  /** The Swing whose Onset is this frame, if any. */
  swing: SwingEvent | null;
}

export interface SwingDetector {
  /** Feed one camera frame (in capture order). Returns the Swing whose Onset is this frame, or null. */
  update(input: SwingDetectorInput): SwingEvent | null;
  /** What the last accepted frame measured; null before the first one or while the pose is lost. */
  readonly latest: SwingReading | null;
  /** Forget all motion history (e.g. after a hitting-hand change). */
  reset(): void;
}

/** Onset needs the stroke speed over `swingOn` on this many frames in a row. */
const ONSET_FRAMES = 2;
/** `peakSpeed` is the max total speed over this many frames. */
const PEAK_FRAMES = 3;
/** Shoulders closer than this (in input units) give no body scale at all; callers set a practical floor. */
const MIN_SHOULDER_WIDTH = 1e-6;

export function createSwingDetector(params: () => SwingParams): SwingDetector {
  let prev: { t: number; p: Vec2 } | null = null;
  let recentSpeeds: number[] = [];
  let framesOverThreshold = 0;
  let armed = true;
  let lastOnsetT = -Infinity;
  let latest: SwingReading | null = null;

  function loseTrack(): void {
    prev = null;
    recentSpeeds = [];
    framesOverThreshold = 0;
    latest = null;
  }

  return {
    get latest() {
      return latest;
    },

    reset() {
      loseTrack();
      armed = true;
      lastOnsetT = -Infinity;
    },

    update({ t, wrist, hittingShoulder: H, otherShoulder: N }) {
      if (!wrist || !H || !N) {
        loseTrack();
        return null;
      }
      // Ignore repeated or out-of-order frames: they carry no new motion.
      if (prev && t <= prev.t) return null;

      // 1–3. Body scale, midline and axis; normalized wrist position.
      const sw = Math.hypot(H.x - N.x, H.y - N.y);
      if (sw < MIN_SHOULDER_WIDTH) {
        loseTrack();
        return null;
      }
      const axis = { x: (H.x - N.x) / sw, y: (H.y - N.y) / sw };
      const p = { x: (wrist.x - (H.x + N.x) / 2) / sw, y: (wrist.y - (H.y + N.y) / 2) / sw };

      // 5. Side from the position along the body axis.
      const u = p.x * axis.x + p.y * axis.y;
      const side: SwingEvent['side'] = u > 0 ? 'forehand' : 'backhand';

      const reading: SwingReading = { t, p, u, side, s: null, sStroke: null, vertSpeed: null, armed, swing: null };
      if (prev) {
        // 4. Velocity from real frame timestamps.
        const dt = (t - prev.t) / 1000;
        const v = { x: (p.x - prev.p.x) / dt, y: (p.y - prev.p.y) / dt };
        const s = Math.hypot(v.x, v.y);
        // 6. Stroke speed: Forehand sweeps toward the non-hitting side, Backhand toward the hitting side.
        const uDot = v.x * axis.x + v.y * axis.y;
        const sStroke = side === 'forehand' ? -uDot : uDot;
        // Image y grows downward.
        const vertSpeed = -v.y;

        recentSpeeds.push(s);
        if (recentSpeeds.length > PEAK_FRAMES) recentSpeeds.shift();

        const { swingOn, swingOff, cooldownMs } = params();
        // 9. Re-arm once the wrist has (nearly) stopped since the last Swing.
        if (s < swingOff) armed = true;
        // 7–8. Onset: the 2nd frame in a row that is fast enough in the Stroke
        // Direction, if armed and outside the cooldown. A stroke whose Onset
        // is blocked is ignored as a whole; it never fires late, mid-stroke.
        framesOverThreshold = sStroke > swingOn ? framesOverThreshold + 1 : 0;
        let swing: SwingEvent | null = null;
        if (framesOverThreshold === ONSET_FRAMES && armed && t - lastOnsetT >= cooldownMs) {
          swing = { t, peakSpeed: Math.max(...recentSpeeds), side, vertPath: vertSpeed };
          armed = false;
          lastOnsetT = t;
        }
        Object.assign(reading, { s, sStroke, vertSpeed, armed, swing });
      }
      prev = { t, p };
      latest = reading;
      return reading.swing;
    },
  };
}
