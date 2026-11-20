/**
 * The Opponent's body (spec P2-d): how it moves and swings so that its Shots
 * look like they come from a player. Pure and headless; the renderer
 * (`render/opponent.ts`) only draws the `BodyPose` this returns.
 *
 * ADR 0002: the brain decides each Shot at its launch, and the body is
 * cosmetic. It reads the core's `opponentPlan` and never feeds anything back:
 * however far it is from the ball, the Shot happens exactly as chosen, and the
 * core never imports this module.
 *
 * All times are simulated seconds (they slow with the ball, like the Shot):
 *
 * - Footwork: `reactionS` after the incoming Shot's launch, the body slides
 *   sideways to play the ball on its forehand or backhand, within `maxSpeed`
 *   and `maxAccel`; between Shots it drifts back to the centre.
 * - Reach: the paddle reaches up to `reach` from the body; if the body can't
 *   get that close by the Ideal Time, it leans and stretches up to
 *   LEAN_REACH_M further instead of teleporting.
 * - Swing: backswing from SWING_BACKSWING_S before contact, the contact pose at
 *   the Ideal Time (WHIFF_LATE_S late on a Whiff, through empty air), then a
 *   follow-through for SWING_FOLLOW_THROUGH_S and a recovery to the ready.
 * - Paddle face: closed for Topspin, open for Backspin.
 *
 * The Opponent is right-handed and faces the player (+z), so its forehand side
 * is −x.
 */

import { OPPONENT_END_Z, TABLE_TOP_Y } from '../game/constants.ts';
import type { Incoming } from '../game/rally.ts';
import { contactPoint } from '../game/shotResolver.ts';
import type { ShotIntent } from '../game/solver.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import type { Difficulty } from './difficulty.ts';

export interface BodyParams {
  /** Simulated seconds after the incoming Shot's launch before the body starts moving to it. */
  reactionS: number;
  /** Fastest sideways slide, m/s (simulated). */
  maxSpeed: number;
  /** Hardest sideways acceleration or braking, m/s² (simulated). */
  maxAccel: number;
  /** How far sideways the paddle reaches from the body without leaning, m. */
  reach: number;
}

/** Starting guesses from the spec, per Difficulty (cosmetic, so not knobs and not balance-tuned). */
export const BODY_PARAMS: Readonly<Record<Difficulty, Readonly<BodyParams>>> = Object.freeze({
  novice: Object.freeze({ reactionS: 0.25, maxSpeed: 2.5, maxAccel: 12, reach: 0.7 }),
  intermediate: Object.freeze({ reactionS: 0.18, maxSpeed: 3, maxAccel: 12, reach: 0.7 }),
  expert: Object.freeze({ reactionS: 0.12, maxSpeed: 3.5, maxAccel: 12, reach: 0.7 }),
});

export interface BodyPose {
  /** The body's centre across the table, m. */
  readonly x: number;
  /** Its sideways velocity, m/s (simulated): the footwork's state, kept within maxSpeed and maxAccel. */
  readonly vx: number;
  /** Sideways lean, rad, positive toward +x: only when the ball is out of plain reach. */
  readonly lean: number;
  /** 0 when not swinging; through a swing, 0 at the start of the backswing, CONTACT_PHASE at contact, 1 at the end of the follow-through. */
  readonly swingPhase: number;
  /** Paddle face about the across-table axis, rad: positive closed (Topspin), negative open (Backspin). */
  readonly paddleTilt: number;
  /** The paddle's blade centre, world frame. */
  readonly paddle: Readonly<Vec3>;
}

/** What the body is playing: the core's `opponentPlan`, with the simulated time since that Shot's launch. */
export interface BodyPlan {
  readonly incoming: Incoming;
  readonly choice: ShotIntent | 'whiff';
  readonly simSecondsSinceLaunch: number;
}

/** The core's plan, as `GameCore.opponentPlan` gives it. */
export type OpponentPlanLike = Pick<BodyPlan, 'incoming' | 'choice'>;

/** Where the Opponent stands: this far behind its end line, m. */
export const OPPONENT_STANCE_Z = OPPONENT_END_Z - 0.5;

/** The swing, simulated seconds: backswing before contact, follow-through and recovery after it. */
export const SWING_BACKSWING_S = 0.25;
export const SWING_FOLLOW_THROUGH_S = 0.3;
export const SWING_RECOVERY_S = 0.25;
/** On a Whiff, the contact pose comes this late, after the ball has passed. */
export const WHIFF_LATE_S = 0.15;
/** `swingPhase` at the contact pose. */
export const CONTACT_PHASE = SWING_BACKSWING_S / (SWING_BACKSWING_S + SWING_FOLLOW_THROUGH_S);

/** The top of the backswing comes this long before contact; the forward swing takes the rest. */
const BACKSWING_TOP_S = 0.1;
/** The backswing takes the paddle this far back from the contact point, the follow-through this far forward, m. */
const BACKSWING_BACK_M = 0.35;
const FOLLOW_THROUGH_FORWARD_M = 0.35;
/** Vertical swing path, m: Topspin brushes up from low, Backspin chops down from high, a flat swing in between. */
const SWING_PATH: Record<'topspin' | 'backspin' | 'flat', { back: number; through: number }> = {
  topspin: { back: -0.15, through: 0.3 },
  backspin: { back: 0.15, through: -0.08 },
  flat: { back: -0.05, through: 0.15 },
};

/** Balls at x ≤ this are played on the forehand (−x side), wider ones on the backhand. */
const FOREHAND_MAX_X = 0.15;
/** Where the body stands relative to the ball: the ball this far to its forehand or backhand side, m. */
const FOREHAND_OFFSET_M = 0.3;
const BACKHAND_OFFSET_M = 0.25;

/** The paddle at the ready: this far to the side, above the table top and in front of the body, m. */
const READY_SIDE_M = { neutral: -0.15, forehand: -0.3, backhand: 0.2 } as const;
const READY_HEIGHT_M = 0.25;
const READY_FORWARD_M = 0.3;
/** Time constant the paddle eases to the ready with, outside a swing, and the paddle face with, s. */
const READY_EASE_S = 0.1;
const TILT_EASE_S = 0.08;

/** The most extra sideways reach a full lean gives, m, and that lean's angle, rad. */
export const LEAN_REACH_M = 0.3;
const LEAN_MAX_RAD = 0.45;
/** The lean builds over this long before contact, s. */
const LEAN_IN_S = 0.4;

/** Paddle face, rad: a flat Shot is square; a Topspin or Backspin of this much or more gets the full tilt. */
const TILT_MIN_RAD = 0.25;
const TILT_MAX_RAD = 0.6;
const TILT_FULL_SPIN = revsToRadPerSec(30);
/** A Whiff still swings with a slightly closed face. */
const WHIFF_TILT_RAD = 0.2;

function readyPaddle(x: number, side: number): Vec3 {
  return { x: x + side, y: TABLE_TOP_Y + READY_HEIGHT_M, z: OPPONENT_STANCE_Z + READY_FORWARD_M };
}

/** The body at rest in the centre, paddle at the ready. */
export const READY_POSE: BodyPose = Object.freeze({
  x: 0,
  vx: 0,
  lean: 0,
  swingPhase: 0,
  paddleTilt: 0,
  paddle: Object.freeze(readyPaddle(0, READY_SIDE_M.neutral)),
});

/** When the contact pose comes, simulated seconds after the incoming Shot's launch: the Ideal Time, or WHIFF_LATE_S after it on a Whiff. */
export function contactSimSeconds(plan: OpponentPlanLike): number {
  return plan.incoming.ideal.simSeconds + (plan.choice === 'whiff' ? WHIFF_LATE_S : 0);
}

/** When the swing (follow-through and recovery included) is over, simulated seconds after the launch. */
export function swingEndSimSeconds(plan: OpponentPlanLike): number {
  return contactSimSeconds(plan) + SWING_FOLLOW_THROUGH_S + SWING_RECOVERY_S;
}

/**
 * The plan for the body this frame: the core's plan while it is set; after the
 * core clears it at the strike (or Whiff), the last one, until its swing is
 * over, so the follow-through completes. `simSecondsSinceLaunch` tells the
 * simulated time since an Incoming's launch.
 */
export function followOpponentPlan(
  current: OpponentPlanLike | null,
  held: BodyPlan | null,
  simSecondsSinceLaunch: (incoming: Incoming) => number,
): BodyPlan | null {
  if (current) return { incoming: current.incoming, choice: current.choice, simSecondsSinceLaunch: simSecondsSinceLaunch(current.incoming) };
  if (!held) return null;
  const t = simSecondsSinceLaunch(held.incoming);
  return t <= swingEndSimSeconds(held) ? { ...held, simSecondsSinceLaunch: t } : null;
}

/**
 * The body's next pose, `dtSim` simulated seconds after `prev`, playing
 * `plan` (or none: drift back to the centre at the ready).
 */
export function planBody(prev: BodyPose, plan: BodyPlan | null, dtSim: number, p: BodyParams): BodyPose {
  const dt = Math.max(0, dtSim);
  const strike = plan ? contactPoint(plan.incoming.strike.position) : null;
  const forehand = strike ? strike.x <= FOREHAND_MAX_X : true;

  // Footwork: to the ball once reacted, else back to the centre.
  const reacted = plan !== null && strike !== null && plan.simSecondsSinceLaunch >= p.reactionS;
  const target = reacted ? (forehand ? strike.x + FOREHAND_OFFSET_M : strike.x - BACKHAND_OFFSET_M) : 0;
  const { x, vx } = slide(prev.x, prev.vx, target, dt, p);

  const easeReady = 1 - Math.exp(-dt / READY_EASE_S);
  const easeTilt = 1 - Math.exp(-dt / TILT_EASE_S);
  if (!plan || !strike) {
    const ready = readyPaddle(x, READY_SIDE_M.neutral);
    return { x, vx, lean: 0, swingPhase: 0, paddleTilt: prev.paddleTilt * (1 - easeTilt), paddle: lerp(prev.paddle, ready, easeReady) };
  }

  // s: simulated seconds relative to the contact pose.
  const s = plan.simSecondsSinceLaunch - contactSimSeconds(plan);
  const sPrev = s - dt;

  // Reach and lean: within plain reach the paddle meets the ball; beyond it, lean in as contact nears.
  const dx = strike.x - x;
  const excess = Math.min(Math.max(Math.abs(dx) - p.reach, 0), LEAN_REACH_M);
  const leanShare = excess > 0 ? (excess / LEAN_REACH_M) * leanWeight(s) : 0;
  const lean = leanShare > 0 ? Math.sign(dx) * leanShare * LEAN_MAX_RAD : 0;
  const armReach = p.reach + leanShare * LEAN_REACH_M;
  const contact: Vec3 = { x: x + clamp(dx, -armReach, armReach), y: strike.y, z: strike.z };

  // The swing path around the contact point.
  const tilt = tiltFor(plan.choice);
  const path = SWING_PATH[plan.choice === 'whiff' || tilt === 0 ? 'flat' : tilt > 0 ? 'topspin' : 'backspin'];
  const top: Vec3 = { x: contact.x, y: contact.y + path.back, z: contact.z - BACKSWING_BACK_M };
  const finish: Vec3 = { x: contact.x, y: contact.y + path.through, z: contact.z + FOLLOW_THROUGH_FORWARD_M };
  const ready = readyPaddle(x, forehand ? READY_SIDE_M.forehand : READY_SIDE_M.backhand);

  let paddle: Vec3;
  if (s > -SWING_BACKSWING_S && s <= -BACKSWING_TOP_S) {
    // Backswing: from wherever the paddle is, arriving at the top on time.
    const remaining = -BACKSWING_TOP_S - sPrev;
    paddle = lerp(prev.paddle, top, remaining <= dt ? 1 : dt / remaining);
  } else if (s > -BACKSWING_TOP_S && s <= 0) {
    // Forward swing, speeding up into contact; the contact pose exactly at s = 0.
    const u = (s + BACKSWING_TOP_S) / BACKSWING_TOP_S;
    paddle = lerp(top, contact, u * u);
  } else if (s > 0 && s <= SWING_FOLLOW_THROUGH_S) {
    // Follow-through, slowing down.
    const u = s / SWING_FOLLOW_THROUGH_S;
    paddle = lerp(contact, finish, 1 - (1 - u) * (1 - u));
  } else {
    // Before the swing, and recovering after it: ease to the ready.
    paddle = lerp(prev.paddle, ready, easeReady);
  }

  const swinging = s > -SWING_BACKSWING_S && s <= SWING_FOLLOW_THROUGH_S;
  const swingPhase = swinging ? (s + SWING_BACKSWING_S) / (SWING_BACKSWING_S + SWING_FOLLOW_THROUGH_S) : 0;
  const paddleTilt = prev.paddleTilt + (tilt - prev.paddleTilt) * easeTilt;
  return { x, vx, lean, swingPhase, paddleTilt, paddle };
}

/**
 * One step of a time-optimal slide to `target`: as fast as `maxSpeed` allows,
 * braking in time to stop there, with the velocity changing by at most
 * `maxAccel · dt`. Semi-implicit, so the step's displacement is `vx · dt`.
 */
function slide(x: number, vx: number, target: number, dt: number, p: BodyParams): { x: number; vx: number } {
  if (dt <= 0) return { x, vx };
  const error = target - x;
  const distance = Math.abs(error);
  const wanted = Math.sign(error) * Math.min(p.maxSpeed, Math.sqrt(2 * p.maxAccel * distance), distance / dt);
  const dv = clamp(wanted - vx, -p.maxAccel * dt, p.maxAccel * dt);
  const next = clamp(vx + dv, -p.maxSpeed, p.maxSpeed);
  return { x: x + next * dt, vx: next };
}

/** How much of its lean the body uses: building over LEAN_IN_S before contact, held through the follow-through, gone by the end of the recovery. */
function leanWeight(s: number): number {
  if (s <= -LEAN_IN_S) return 0;
  if (s <= 0) return smoothstep((s + LEAN_IN_S) / LEAN_IN_S);
  if (s <= SWING_FOLLOW_THROUGH_S) return 1;
  return 1 - smoothstep((s - SWING_FOLLOW_THROUGH_S) / SWING_RECOVERY_S);
}

/** The paddle face for a choice: closed for Topspin, open for Backspin, square for a flat Shot. */
function tiltFor(choice: ShotIntent | 'whiff'): number {
  if (choice === 'whiff') return WHIFF_TILT_RAD;
  if (choice.topspin === 0) return 0;
  const share = Math.min(1, Math.abs(choice.topspin) / TILT_FULL_SPIN);
  return Math.sign(choice.topspin) * (TILT_MIN_RAD + (TILT_MAX_RAD - TILT_MIN_RAD) * share);
}

function lerp(a: Readonly<Vec3>, b: Readonly<Vec3>, k: number): Vec3 {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
}

function smoothstep(u: number): number {
  const c = clamp(u, 0, 1);
  return c * c * (3 - 2 * c);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
