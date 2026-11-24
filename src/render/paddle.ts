/**
 * The Paddle (SPEC "Scene, Paddle and sound"): where it is drawn and how it
 * moves, as pure functions the scene draws from. It follows the hitting
 * wrist, plays a Swing animation timed to the contact moment, and (contact
 * assist) eases toward the ball at contact. With the Phone it also tips by
 * the Face Angle. It is drawn for feel only: it never decides whether a
 * Return happens (ADR 0001).
 */

import type { Vec3 } from '../game/ball.ts';
import { PADDLE_REST_HEIGHT_M, PADDLE_REST_PY, PADDLE_Z, TABLE_TOP_Y, TABLE_WIDTH } from '../game/constants.ts';
import type { HandPosition } from '../input/handPosition.ts';
import type { SwingEvent } from '../input/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { drawnBall } from './drawnBall.ts';

/** The blade's thickness (rubber faces included), metres; the scene draws it this thick. */
export const PADDLE_BLADE_THICKNESS = 0.012;

/** How far the Paddle reaches either side of the centre line: the table's half-width. */
const REACH_M = TABLE_WIDTH / 2;
/** Lowest and highest Paddle centre above the table top, metres. */
const MIN_HEIGHT_M = 0.04;
const MAX_HEIGHT_M = 0.8;

export interface PaddleMapping {
  hand: Hand;
  /** Shoulder widths of wrist travel either side of the midline that span the table's half-width (`PADDLE_MAPPING_RANGE`). */
  rangeSw: number;
  /** The wrist's vertical position at the ready (`p.y`, shoulder widths below the shoulder line): the Paddle's rest height. */
  restPy: number;
}

/**
 * Where the Paddle sits for a wrist position: body-axis position `u` across
 * the table's width (±range shoulder widths → ±the table's half-width),
 * height from `p.y`, at the player's end. A right-hander's hitting side is
 * the player's right (+x), which is screen right, as in the mirrored video;
 * a left-hander's is mirrored. Clamped to the table's width and above its top.
 */
export function wristToPaddle(wrist: Pick<HandPosition, 'u' | 'py'>, mapping: PaddleMapping): Vec3 {
  const metresPerSw = REACH_M / mapping.rangeSw;
  const handSign = mapping.hand === 'left' ? -1 : 1;
  const x = clamp(handSign * wrist.u * metresPerSw, -REACH_M, REACH_M);
  const height = PADDLE_REST_HEIGHT_M - (wrist.py - mapping.restPy) * metresPerSw;
  return { x, y: TABLE_TOP_Y + clamp(height, MIN_HEIGHT_M, MAX_HEIGHT_M), z: PADDLE_Z };
}

/**
 * A wrist sample older than this (relative to now) carries no current motion:
 * the mouse has stopped moving, or pose frames stalled. Pose arrives every
 * ~33 ms at 30 FPS.
 */
const STALE_SAMPLE_MS = 100;

/**
 * Velocity for latency extrapolation is measured over about this long, not
 * between the last two samples: pointer events arrive every ~16 ms, and
 * multiplying one such step by a 150 ms latency would magnify its jitter ~9×.
 */
export const VELOCITY_WINDOW_MS = 60;

/**
 * Latency extrapolation: where the wrist will be `latencyMs` from its latest
 * sample, at the average velocity since `prev` (an earlier sample). With no velocity to
 * go on (one sample, or a stale one), the wrist itself.
 */
export function extrapolateHand(prev: HandPosition | null, latest: HandPosition, latencyMs: number, nowMs: number): HandPosition {
  if (!prev || latest.t <= prev.t || nowMs - latest.t > STALE_SAMPLE_MS) return latest;
  const ahead = latencyMs / (latest.t - prev.t);
  return { t: latest.t, u: latest.u + (latest.u - prev.u) * ahead, py: latest.py + (latest.py - prev.py) * ahead };
}

/**
 * The blade's pitch tipped by the Face Angle (radians, + = the Forehand face
 * closed, as the Phone Input gives it). Pitch closes whichever face is shown,
 * so the Backhand face, the other side of the blade, tips the other way.
 */
export function tipByFaceAngle(pitch: number, backhandFace: boolean, forehandFaceAngle: number): number {
  return pitch + (backhandFace ? -forehandFaceAngle : forehandFaceAngle) + 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** An accepted Swing's animation: from Swing Onset, with its contact frame at the contact moment. */
export interface SwingAnimation {
  /** Swing Onset, ms, `performance.now()` clock. */
  onsetMs: number;
  /** When the Paddle meets the ball, ms, same clock. */
  contactAtMs: number;
  side: SwingEvent['side'];
}

export type SwingPhase = 'wind-up' | 'follow-through' | 'recover' | 'done';

/** The Swing animation's pose at one moment, relative to where the Paddle would otherwise be. */
export interface SwingFrame {
  phase: SwingPhase;
  /** How far through the phase, 0 to 1. */
  progress: number;
  /** World offset of the Paddle's centre, metres; zero at contact. */
  offset: Vec3;
  /** Turn about the vertical axis (opening or closing the face), radians. */
  yaw: number;
  /** Tilt of the face forward (+, closing over the ball) or back, radians. */
  pitch: number;
  /** Whether the Backhand face (the other side of the blade) faces the ball. */
  backhandFace: boolean;
}

/** Milliseconds from contact to the end of the follow-through, then back onto the wrist. */
const FOLLOW_THROUGH_MS = 220;
const RECOVER_MS = 280;

/**
 * One key pose of a stroke, in stroke-relative terms: `along` the Stroke
 * Direction, `back` toward the player, `up`; metres and radians.
 */
interface StrokeKey {
  along: number;
  back: number;
  up: number;
  yaw: number;
  pitch: number;
}

/** Wind-up and finish of each stroke; contact is the zero pose. A Forehand is the longer, looser stroke. */
const STROKES: Record<SwingEvent['side'], { windUp: StrokeKey; finish: StrokeKey }> = {
  forehand: {
    windUp: { along: -0.3, back: 0.18, up: -0.08, yaw: 0.6, pitch: 0.25 },
    finish: { along: 0.35, back: -0.25, up: 0.25, yaw: -0.5, pitch: -0.5 },
  },
  backhand: {
    windUp: { along: -0.2, back: 0.1, up: -0.04, yaw: -0.45, pitch: 0.2 },
    finish: { along: 0.25, back: -0.2, up: 0.18, yaw: 0.4, pitch: -0.4 },
  },
};

const CONTACT_KEY: StrokeKey = { along: 0, back: 0, up: 0, yaw: 0, pitch: 0 };

/**
 * The Swing animation at `nowMs`. The wind-up runs from Swing Onset to the
 * contact moment, however long that is: stretched for an early Swing (which
 * waits for the ball), compressed for a late one, so the contact frame always
 * lands exactly at `contactAtMs` and the follow-through never starts before
 * the ball leaves. A Forehand sweeps toward the non-hitting side, a Backhand
 * toward the hitting side, each with its own key poses and blade face.
 */
export function swingFrameAt(swing: SwingAnimation, nowMs: number, hand: Hand): SwingFrame {
  const stroke = STROKES[swing.side];
  const windUpMs = swing.contactAtMs - swing.onsetMs;
  const sinceContact = nowMs - swing.contactAtMs;

  let phase: SwingPhase;
  let progress: number;
  let key: StrokeKey;
  if (sinceContact < 0 && windUpMs > 0) {
    phase = 'wind-up';
    progress = clamp((nowMs - swing.onsetMs) / windUpMs, 0, 1);
    key = mixKeys(stroke.windUp, CONTACT_KEY, progress * progress); // accelerating into contact
  } else if (sinceContact < FOLLOW_THROUGH_MS) {
    phase = 'follow-through';
    progress = Math.max(0, sinceContact) / FOLLOW_THROUGH_MS;
    key = mixKeys(CONTACT_KEY, stroke.finish, 1 - (1 - progress) ** 2); // decelerating after it
  } else if (sinceContact < FOLLOW_THROUGH_MS + RECOVER_MS) {
    phase = 'recover';
    progress = (sinceContact - FOLLOW_THROUGH_MS) / RECOVER_MS;
    key = mixKeys(stroke.finish, CONTACT_KEY, smoothstep(progress));
  } else {
    phase = 'done';
    progress = 1;
    key = CONTACT_KEY;
  }

  // The Stroke Direction in world x: a Forehand toward the non-hitting side, a Backhand toward the hitting side.
  const hitting = hand === 'left' ? -1 : 1;
  const strokeX = swing.side === 'forehand' ? -hitting : hitting;
  // `+ 0` turns −0 (zero times a negative sign) into 0.
  return {
    phase,
    progress,
    offset: { x: key.along * strokeX + 0, y: key.up + 0, z: key.back + 0 },
    yaw: key.yaw * hitting,
    pitch: key.pitch,
    backhandFace: swing.side === 'backhand',
  };
}

/**
 * Contact assist: how far (0 to 1) the Paddle is pulled from the wrist onto
 * the ball. It eases in from Swing Onset to exactly 1 at the contact moment,
 * so the ball always leaves the Paddle, then eases back to the wrist over the
 * follow-through and recovery.
 */
export function contactAssistWeight(swing: SwingAnimation, nowMs: number): number {
  const sinceContact = nowMs - swing.contactAtMs;
  if (sinceContact >= 0) return 1 - smoothstep(sinceContact / (FOLLOW_THROUGH_MS + RECOVER_MS));
  const windUpMs = swing.contactAtMs - swing.onsetMs;
  return smoothstep((nowMs - swing.onsetMs) / windUpMs);
}

function mixKeys(a: StrokeKey, b: StrokeKey, f: number): StrokeKey {
  return {
    along: lerp(a.along, b.along, f),
    back: lerp(a.back, b.back, f),
    up: lerp(a.up, b.up, f),
    yaw: lerp(a.yaw, b.yaw, f),
    pitch: lerp(a.pitch, b.pitch, f),
  };
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function smoothstep(f: number): number {
  const t = clamp(f, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Live tuning values, read every frame (knobs in the game). */
export interface PaddleParams {
  /** `PADDLE_MAPPING_RANGE`, shoulder widths. */
  rangeSw: number;
  /** `CONTACT_ASSIST`. */
  contactAssist: boolean;
  /** `LATENCY_EXTRAPOLATION`. */
  latencyExtrapolation: boolean;
  /** `LATENCY_EXTRAPOLATION_MS`: how far ahead to draw the wrist. */
  latencyMs: number;
  /** `BALL_DRAW_SCALE`: the Paddle meets the ball as drawn. */
  ballDrawScale: number;
}

/** Everything the scene needs to draw the Paddle. */
export interface PaddlePose {
  /** Centre of the blade, world metres. */
  position: Vec3;
  /** Radians about the vertical axis; 0 faces the Feeder. */
  yaw: number;
  /** Radians, + tilts the face forward (closing it over the ball). */
  pitch: number;
  /** Whether the Backhand face of the blade faces the Feeder. */
  backhandFace: boolean;
}

export interface PaddleOptions {
  params: () => PaddleParams;
  /** The player's hitting hand, read every frame. */
  hand: () => Hand;
  /** Where the ball will be struck at `contactAtMs`, as seen at `nowMs` (before the contact happens). */
  predictContact: (contactAtMs: number, nowMs: number) => Vec3;
}

export interface Paddle {
  /** An accepted Swing: animate from its Onset, contact due at `contactAtMs`. */
  swing(animation: SwingAnimation): void;
  /** Contact happened at `atMs` (the frame at or just after the planned one), striking the ball at `position`. */
  contact(atMs: number, position: Readonly<Vec3>): void;
  /**
   * Once per frame, with the latest wrist sample (or null while it is
   * unknown): where to draw the Paddle. A sample's `faceAngle` (the Phone's,
   * for the Forehand face) tips the blade.
   */
  update(nowMs: number, wrist: HandPosition | null): PaddlePose;
}

/**
 * The Paddle's motion, frame by frame: it follows the wrist (optionally drawn
 * ahead by the latency), plays the accepted Swing's animation, and with
 * contact assist eases onto the ball so that, at the contact frame, the
 * blade's face touches the back of the ball as drawn. Without contact assist
 * the animation still plays around the wrist, showing the real gap.
 */
export function createPaddle(options: PaddleOptions): Paddle {
  let swing: SwingAnimation | null = null;
  /** The ball's contact point once struck; before that it is predicted each frame. */
  let struckAt: Vec3 | null = null;
  /** Recent wrist samples, oldest first, spanning about VELOCITY_WINDOW_MS. */
  let recent: HandPosition[] = [];

  function followWrist(nowMs: number, wrist: HandPosition | null, params: PaddleParams): HandPosition | null {
    if (!wrist) {
      recent = [];
      return null;
    }
    if (wrist.t !== recent.at(-1)?.t) {
      recent.push(wrist);
      // Keep the newest sample at least VELOCITY_WINDOW_MS old, so the window is always spanned.
      while (recent.length > 2 && (recent[1]?.t ?? Infinity) <= wrist.t - VELOCITY_WINDOW_MS) recent.shift();
    }
    const oldest = recent.length > 1 ? (recent[0] ?? null) : null;
    return params.latencyExtrapolation ? extrapolateHand(oldest, wrist, params.latencyMs, nowMs) : wrist;
  }

  return {
    swing(animation) {
      swing = { ...animation };
      struckAt = null;
    },

    contact(atMs, position) {
      if (swing) swing = { ...swing, contactAtMs: atMs };
      struckAt = { ...position };
    },

    update(nowMs, wrist) {
      const params = options.params();
      const hand = options.hand();
      const followed = followWrist(nowMs, wrist, params);
      const faceAngle = wrist?.faceAngle ?? 0;
      const onWrist = wristToPaddle(followed ?? { u: 0, py: PADDLE_REST_PY }, { hand, rangeSw: params.rangeSw, restPy: PADDLE_REST_PY });

      const frame = swing ? swingFrameAt(swing, nowMs, hand) : null;
      if (!swing || !frame || frame.phase === 'done') {
        swing = null;
        const backhandFace = (followed?.u ?? 0) < 0;
        return { position: onWrist, yaw: 0, pitch: tipByFaceAngle(0, backhandFace, faceAngle), backhandFace };
      }

      let base = onWrist;
      const assist = params.contactAssist ? contactAssistWeight(swing, nowMs) : 0;
      if (assist > 0) {
        const ball = drawnBall(struckAt ?? options.predictContact(swing.contactAtMs, nowMs), params.ballDrawScale);
        // The blade's face touches the back of the ball (the player's side).
        const onBall = { ...ball.centre, z: ball.centre.z + ball.radius + PADDLE_BLADE_THICKNESS / 2 };
        base = { x: lerp(onWrist.x, onBall.x, assist), y: lerp(onWrist.y, onBall.y, assist), z: lerp(onWrist.z, onBall.z, assist) };
      }
      return {
        position: { x: base.x + frame.offset.x, y: base.y + frame.offset.y, z: base.z + frame.offset.z },
        yaw: frame.yaw,
        pitch: tipByFaceAngle(frame.pitch, frame.backhandFace, faceAngle),
        backhandFace: frame.backhandFace,
      };
    },
  };
}
