/**
 * Shot resolver (SPEC "Shot resolver and target solver", ADR 0001): decides
 * from Swing timing alone whether a Feed is returned, and where the Return goes.
 * The game never checks whether the Paddle touches the ball.
 */

import type { SwingEvent } from '../input/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { launchBall, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import {
  BALL_RADIUS,
  DIRECTION_SPREAD_M,
  EARLY_SWING_USES_TRY,
  HIT_WINDOW_MS,
  LATE_GRACE_MS,
  LIFT_FULL,
  RETURN_DEPTH_HARD_M,
  RETURN_DEPTH_SOFT_M,
  RETURN_FLIGHT_HARD_S,
  RETURN_FLIGHT_SOFT_S,
  RETURN_LONG_PUSH_M,
  RETURN_MIN_DEPTH_M,
  RETURN_SAFE_FRACTION,
  RETURN_SCATTER_M,
  RETURN_TOPSPIN_MAX_REVS,
  SPIN_ANSWER_M,
  FEED_SPIN_MAX_REVS,
  SWING_FAST,
  SWING_MIN_RISE,
  SWING_ON,
  TABLE_TOP_Y,
  TIMING_OFFSET_MS,
} from './constants.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { judgeReturnFlight, type ReturnFlightResult } from './score.ts';
import { solveShot, type ShotIntent, type ShotSolution, type ShotSolver, type TablePoint } from './solver.ts';

/** Live tuning values, read on every use (knobs in the game). */
export interface ResolverParams {
  /** Half-width W of the Hit Window around the Ideal Time, ms. */
  hitWindowMs: number;
  /** The player's Timing Offset: how much later the game sees a Swing Onset than the player means it, ms. */
  timingOffsetMs: number;
  /** A Swing more than W early uses up the Feed's one try. */
  earlySwingUsesTry: boolean;
  /** How long after the Hit Window closes a Swing still counts as Late (not Miss), ms. */
  lateGraceMs: number;
  /** `SWING_ON`: the softest Swing, shoulder widths/s. */
  swingOn: number;
  /** `SWING_FAST`: a full-power Swing, shoulder widths/s. */
  swingFast: number;
  /** How far timing pushes a Return sideways at the edge of the window, metres. */
  directionSpreadM: number;
  /** Share of the window (around the Ideal Time) whose Returns always land in. */
  safeFraction: number;
  /** How far past its depth a Return at the very edge of the window is pushed long, metres. */
  longPushM: number;
  /** Flight time of the softest Return, simulated seconds. */
  flightTimeSoftS: number;
  /** Flight time of a full-power Return, simulated seconds. */
  flightTimeHardS: number;
  /** Landing distance past the net of the softest Return, metres. */
  depthSoftM: number;
  /** Landing distance past the net of a full-power Return, metres. */
  depthHardM: number;
  /** Most random scatter on x and z (scaled by 1 − timing quality), metres. */
  scatterM: number;
  /** `SWING_MIN_RISE`: vertical wrist speed where Lift is 0, shoulder widths/s. */
  minRise: number;
  /** `LIFT_FULL`: vertical wrist speed where Lift is 1, shoulder widths/s. */
  liftFull: number;
  /** Topspin of a Return with Lift 1, revolutions/s. */
  returnTopspinMaxRevs: number;
  /** `SPIN_ANSWER_M`: how far an unanswered Feed spin moves a Return's landing spot, metres. */
  spinAnswerM: number;
  /** `FEED_SPIN_MAX_REVS`: the Feed Topspin (rev/s) that counts as full spin when answering it. */
  feedSpinMaxRevs: number;
}

/** What a Return is planned from: an accepted Swing, its timing and the player's hand. */
export interface ReturnInput {
  /** Corrected Swing Onset minus Ideal Time, ms (negative = early); within the Hit Window. */
  delta: number;
  peakSpeed: number;
  /** The Swing's `vertPath`: vertical wrist speed at Onset, shoulder widths/s, + up. */
  vertPath: number;
  side: SwingEvent['side'];
  hand: Hand;
  /** Topspin of the Feed being returned, rad/s (negative = Backspin). */
  feedTopspin: number;
}

/** Where and how fast a Return is aimed; the target solver turns it into a launch. */
export interface ReturnPlan {
  /** Landing spot on the Feeder's half (z < 0), or past its edge for a deliberate miss. */
  target: TablePoint;
  /** Simulated seconds from contact to landing. */
  flightTime: number;
  /** Timing quality q = 1 − |delta| / W: 1 at the Ideal Time, 0 at the edge of the window. */
  quality: number;
  /** The Swing's Lift, 0 (flat) to 1 (full). */
  lift: number;
  /** Topspin of the Return, rad/s: Lift × the Return-Topspin knob. Returns never carry Backspin or Sidespin. */
  topspin: number;
}

/**
 * Lift of a Swing, 0 to 1: 0 at `minRise`, 1 at `liftFull` and above, linear between. A falling
 * Swing (mouse input) is 0. If the knobs overlap (`liftFull` ≤ `minRise`) Lift is a step: 0 up to
 * `minRise`, 1 above it.
 */
export function liftOf(vertPath: number, minRise: number, liftFull: number): number {
  if (!Number.isFinite(vertPath)) return 0;
  if (liftFull <= minRise) return vertPath > minRise ? 1 : 0;
  return clamp01((vertPath - minRise) / (liftFull - minRise));
}

/**
 * Pick a Return's landing spot and pace (SPEC "From Swing to Return"). Timing
 * picks the direction: early goes cross-court, late down the line, mirrored
 * for a Backhand and for a left-hander.
 */
export function planReturn(input: ReturnInput, params: ResolverParams, random: () => number): ReturnPlan {
  const W = params.hitWindowMs;
  const quality = 1 - Math.abs(input.delta) / W;
  // World +x is the player's right. A right-hander's Forehand is struck on
  // their right, so cross-court (early) goes left: −x.
  const sideSign = (input.side === 'forehand' ? -1 : 1) * (input.hand === 'left' ? -1 : 1);
  const x = sideSign * (-input.delta / W) * params.directionSpreadM;
  // Swing power, 0 (SWING_ON) to 1 (SWING_FAST), picks pace and depth.
  const power = clamp01((input.peakSpeed - params.swingOn) / (params.swingFast - params.swingOn));
  const flightTime = lerp(params.flightTimeSoftS, params.flightTimeHardS, power);
  // The inner safeFraction of the window always lands in; past it, the target
  // moves long, up to longPushM at the very edge, so the Return can miss.
  const offCentre = Math.abs(input.delta) / W;
  const risk = clamp01((offCentre - params.safeFraction) / (1 - params.safeFraction));
  const depth = lerp(params.depthSoftM, params.depthHardM, power) + risk * params.longPushM;
  // Natural variation, none for a perfectly timed Swing. It moves the target,
  // never the launch velocity (ADR 0001).
  const scatter = () => (2 * random() - 1) * params.scatterM * (1 - quality);
  const lift = liftOf(input.vertPath, params.minRise, params.liftFull);
  const topspin = lift * revsToRadPerSec(params.returnTopspinMaxRevs);
  const targetX = x + scatter();
  const finalDepth = answerSpin(depth - scatter(), input.feedTopspin, lift, params);
  return { target: { x: targetX, z: -finalDepth }, flightTime, quality, lift, topspin };
}

/**
 * Answer a Feed's spin by moving a Return's depth past the net (ADR 0001: only the target moves).
 * With `s` the Feed's Topspin as a share of `feedSpinMaxRevs`, in [−1, 1]: against Backspin, depth
 * shrinks by `spinAnswerM × max(0, −s − lift)`; against Topspin it grows by
 * `spinAnswerM × max(0, lift − (1 − s))`. The shortening never takes the Return closer than
 * `RETURN_MIN_DEPTH_M`, but never pushes out one that was already closer. `depth` is the final
 * depth including scatter, so the minimum holds for the target the solver gets.
 */
function answerSpin(depth: number, feedTopspin: number, lift: number, params: ResolverParams): number {
  const fullSpin = revsToRadPerSec(params.feedSpinMaxRevs);
  const s = fullSpin > 0 && Number.isFinite(feedTopspin) ? Math.min(1, Math.max(-1, feedTopspin / fullSpin)) : 0;
  if (s < 0) {
    const shortened = depth - params.spinAnswerM * Math.max(0, -s - lift);
    return Math.max(shortened, Math.min(depth, RETURN_MIN_DEPTH_M));
  }
  if (s > 0) return depth + params.spinAnswerM * Math.max(0, lift - (1 - s));
  return depth;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** The resolver's parameters from the live knobs; the game passes this as `params`. */
export function knobResolverParams(): ResolverParams {
  return {
    hitWindowMs: HIT_WINDOW_MS.value,
    timingOffsetMs: TIMING_OFFSET_MS.value,
    earlySwingUsesTry: EARLY_SWING_USES_TRY.value,
    lateGraceMs: LATE_GRACE_MS.value,
    swingOn: SWING_ON.value,
    swingFast: SWING_FAST.value,
    directionSpreadM: DIRECTION_SPREAD_M.value,
    safeFraction: RETURN_SAFE_FRACTION.value,
    longPushM: RETURN_LONG_PUSH_M.value,
    flightTimeSoftS: RETURN_FLIGHT_SOFT_S.value,
    flightTimeHardS: RETURN_FLIGHT_HARD_S.value,
    depthSoftM: RETURN_DEPTH_SOFT_M.value,
    depthHardM: RETURN_DEPTH_HARD_M.value,
    scatterM: RETURN_SCATTER_M.value,
    minRise: SWING_MIN_RISE.value,
    liftFull: LIFT_FULL.value,
    returnTopspinMaxRevs: RETURN_TOPSPIN_MAX_REVS.value,
    spinAnswerM: SPIN_ANSWER_M.value,
    feedSpinMaxRevs: FEED_SPIN_MAX_REVS.value,
  };
}

export type SwingTiming = 'early' | 'accepted' | 'late';

/**
 * Compare a Swing Onset with the Feed's Ideal Time, both on the
 * performance.now() clock: `delta` is the Onset corrected by the Timing
 * Offset, minus the Ideal Time (negative = early).
 */
export function judgeSwingTiming(onsetMs: number, idealAtMs: number, params: ResolverParams): { timing: SwingTiming; delta: number } {
  const delta = onsetMs - params.timingOffsetMs - idealAtMs;
  const W = params.hitWindowMs;
  const timing: SwingTiming = delta < -W ? 'early' : delta > W ? 'late' : 'accepted';
  return { timing, delta };
}

/**
 * What the resolver reports, as it happens. A Feed ends with exactly one
 * `return`, `off-target`, final `early`, `late` or `miss` (see `feedResult`).
 */
export type ShotEvent =
  /**
   * A Swing more than W before the Ideal Time. `final` when it used up the
   * Feed's try (EARLY_SWING_USES_TRY); otherwise the try is kept, and if no
   * later Swing is accepted the Feed ends with a final `early`.
   */
  | { readonly type: 'early'; readonly delta: number; readonly final: boolean }
  /** A Swing more than W after the Ideal Time. */
  | { readonly type: 'late'; readonly delta: number }
  /** No Swing by the end of the Late grace after the Hit Window. */
  | { readonly type: 'miss' }
  /** A Swing in the Hit Window: the Feed will be returned at `contactAtMs`. */
  | {
      readonly type: 'accepted';
      readonly swing: SwingEvent;
      readonly delta: number;
      /** When contact will happen: max(now, Ideal Time), performance.now() clock. */
      readonly contactAtMs: number;
      readonly plan: ReturnPlan;
    }
  /** Contact: the Return was launched (the game makes `ball` the ball in play). */
  | {
      readonly type: 'contact';
      /** performance.now() of the launch (the frame at or just after the planned contact). */
      readonly atMs: number;
      /** Where the ball was struck. */
      readonly position: Readonly<Vec3>;
      readonly swing: SwingEvent;
      readonly side: SwingEvent['side'];
      readonly delta: number;
      readonly plan: ReturnPlan;
      /** The Return, just launched. */
      readonly ball: BallState;
    }
  | ReturnFlightResult;

/** Whether `event` ends its Feed: `returned` for a Return, `failed` for anything that breaks the Streak, else null. */
export function feedResult(event: ShotEvent): 'returned' | 'failed' | null {
  switch (event.type) {
    case 'return':
      return 'returned';
    case 'off-target':
    case 'late':
    case 'miss':
      return 'failed';
    case 'early':
      return event.final ? 'failed' : null;
    default:
      return null;
  }
}

/** The part of a Feed the resolver judges against. */
export interface FeedTiming {
  /** The Feed's Ideal Time on the performance.now() clock; null if it never reaches the player. */
  readonly idealAtMs: number | null;
  /** The Feed's Topspin, rad/s (negative = Backspin): the Swing's Lift must answer it. */
  readonly topspin: number;
}

export interface ShotResolver {
  /** A new Feed was launched: its one try is available. */
  startFeed(feed: FeedTiming): void;
  /** Judge a Swing, received at `nowMs`. Swings with no Feed to judge, or after the try is used, are ignored. */
  swing(swing: SwingEvent, nowMs: number): ShotEvent[];
  /**
   * Once per frame, after physics: `ball` is the ball in play and
   * `ballEvents` what it did this frame. Launches a due contact and judges
   * the Return's flight.
   */
  update(nowMs: number, ball: BallState, ballEvents: readonly BallEvent[]): ShotEvent[];
}

export interface ShotResolverOptions {
  params: () => ResolverParams;
  /** The player's hitting hand, read at each accepted Swing. */
  hand: () => Hand;
  /** Uniform random numbers in [0, 1) for scatter and each Return's seed; build one with `makeRng(seed)`. */
  random: () => number;
  /** The target solver; `solveShot` unless a test stands one in. */
  solve?: ShotSolver;
}

type FeedState =
  | { readonly phase: 'none' }
  /** Waiting for a Swing. `earlyDelta`: the last early Swing that kept the try, if any. */
  | { readonly phase: 'open'; readonly idealAtMs: number | null; readonly topspin: number; readonly earlyDelta: number | null }
  | { readonly phase: 'accepted'; readonly accepted: Extract<ShotEvent, { type: 'accepted' }> }
  | { readonly phase: 'returning' }
  | { readonly phase: 'done' };

export function createShotResolver(options: ShotResolverOptions): ShotResolver {
  const random = options.random;
  const solve = options.solve ?? solveShot;
  let state: FeedState = { phase: 'none' };

  return {
    startFeed(feed) {
      state = { phase: 'open', idealAtMs: feed.idealAtMs, topspin: feed.topspin, earlyDelta: null };
    },

    swing(swing, nowMs) {
      if (state.phase !== 'open' || state.idealAtMs === null) return [];
      const params = options.params();
      const { timing, delta } = judgeSwingTiming(swing.t, state.idealAtMs, params);
      if (timing === 'early') {
        const final = params.earlySwingUsesTry;
        state = final ? { phase: 'done' } : { ...state, earlyDelta: delta };
        return [{ type: 'early', delta, final }];
      }
      if (timing === 'late') {
        state = { phase: 'done' };
        return [{ type: 'late', delta }];
      }
      const plan = planReturn({ delta, peakSpeed: swing.peakSpeed, vertPath: swing.vertPath, side: swing.side, hand: options.hand(), feedTopspin: state.topspin }, params, random);
      const accepted = { type: 'accepted', swing, delta, contactAtMs: Math.max(nowMs, state.idealAtMs), plan } as const;
      state = { phase: 'accepted', accepted };
      return [accepted];
    },

    update(nowMs, ball, ballEvents) {
      const events: ShotEvent[] = [];
      if (state.phase === 'returning') {
        const flight = judgeReturnFlight(ballEvents);
        if (flight) {
          state = { phase: 'done' };
          events.push(flight);
        }
      }
      if (state.phase === 'accepted' && nowMs >= state.accepted.contactAtMs) {
        const { swing, delta, plan } = state.accepted;
        const position = contactPoint(ball.position);
        const solution = solveReturn(solve, position, { target: plan.target, flightTime: plan.flightTime, topspin: plan.topspin, sidespin: 0 });
        const seed = Math.floor(random() * 2 ** 32);
        const struck = launchBall(position, solution.velocity, solution.spin, seed);
        events.push({ type: 'contact', atMs: nowMs, position, swing, side: swing.side, delta, plan, ball: struck });
        state = { phase: 'returning' };
      }
      if (state.phase === 'open') {
        // No Swing judged by the end of the Late grace (a Swing is seen
        // timingOffsetMs late): a Miss. A Feed that never reaches the player
        // (no Ideal Time, only at extreme knob values) can't be hit at all.
        const { hitWindowMs, lateGraceMs, timingOffsetMs } = options.params();
        if (state.idealAtMs === null || nowMs > state.idealAtMs + timingOffsetMs + hitWindowMs + lateGraceMs) {
          events.push(state.earlyDelta === null ? { type: 'miss' } : { type: 'early', delta: state.earlyDelta, final: true });
          state = { phase: 'done' };
        }
      }
      return events;
    },
  };
}

/**
 * Solve a Return for its planned target, which never moves because the solver
 * failed (ADR 0001): a planned miss, long or wide, stays a miss. If the
 * intent can't be solved, it is tried again with no spin (when it had any),
 * then solved best-effort with no spin, and that launch is used. A Return
 * with Topspin takes this path whenever its spun Shot has no solution.
 */
export function solveReturn(solve: ShotSolver, from: Vec3, intent: ShotIntent): ShotSolution {
  const solved = solve(from, intent);
  if (solved) return solved;
  const flat = { ...intent, topspin: 0, sidespin: 0 };
  const hasSpin = intent.topspin !== 0 || intent.sidespin !== 0;
  return (hasSpin ? solve(from, flat) : null) ?? solve(from, flat, { bestEffort: true });
}

/**
 * Where a Return is struck: the ball's position now, but never below the
 * table top. A late Swing can meet a ball that has already dropped past the
 * end of the table; struck from there it would count as out at once, but a
 * Swing in the Hit Window is always struck (ADR 0001).
 */
export function contactPoint(ball: Readonly<Vec3>): Vec3 {
  return { x: ball.x, y: Math.max(ball.y, TABLE_TOP_Y + BALL_RADIUS), z: ball.z };
}
