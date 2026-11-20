/**
 * Serves (spec P2-f1): the first Shot of a Rally, which must bounce once on
 * the server's half, then on the receiver's half (GLOSSARY "Serve"). Anything
 * else is a Fault; one that clips the net and then lands legally is a Let.
 *
 * `solveServe` turns a ServeIntent (both bounces, Spin) into a launch with a
 * shooting method: `solveShot` to the first bounce, simulate through it, and
 * correct the first segment's flight time (how far the ball carries after the
 * bounce) and, a little, the aim of the first bounce (to bring the second
 * back onto the line) until the second bounce is on target. Like `solveShot`,
 * it never moves the target (ADR 0001): it meets the intent or reports
 * failure.
 *
 * `judgeServe` simulates a launched Serve and calls it under the referee's
 * Serve rules (`rally.ts`), so the rules live in one place.
 *
 * Pure and headless: no randomness, the same integrator as the live ball.
 */

import { launchBall, simulate, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { BALL_RADIUS, NET_HEIGHT, OPPONENT_END_Z, TABLE_TOP_Y } from './constants.ts';
import { createReferee } from './rally.ts';
import type { Side } from './side.ts';
import { solveShot, type ShotSolution, type ShotSolver, type TablePoint } from './solver.ts';

/** A Serve's call under the Serve rules. */
export type ServeResult = 'legal' | 'fault' | 'let';

/** What a Serve should do: where it bounces on each half, and with what Spin. */
export interface ServeIntent {
  /** Its first bounce, on the server's half. */
  bounce1: TablePoint;
  /** Its second bounce, on the receiver's half. */
  target: TablePoint;
  /**
   * Simulated seconds from launch to the first bounce: the shooting method's
   * first guess. The solution's `flightTime` is the one that meets the target.
   */
  flightTime: number;
  /** rad/s about the Serve's horizontal direction; negative = Backspin. */
  topspin: number;
  /** rad/s about the vertical. */
  sidespin: number;
}

/**
 * Where the Opponent strikes its Serve: 0.1 m behind its end line on the
 * centre line, 0.4 m above the table. Struck lower, the first bounce comes
 * off the table so flat that few Serves both clear the net and land deep
 * (at 0.25 m about a quarter of the Opponent's drawn Serves have no
 * solution; at 0.4 m, about one in twenty).
 */
export const OPPONENT_SERVE_FROM: Readonly<Vec3> = Object.freeze({ x: 0, y: TABLE_TOP_Y + 0.4, z: OPPONENT_END_Z - 0.1 });

/** A solved Serve's first bounce lands within this of `bounce1`, m. */
export const SERVE_BOUNCE1_TOLERANCE_M = 0.05;
/** A solved Serve's second bounce lands within this of `target`, m. */
export const SERVE_TARGET_TOLERANCE_M = 0.1;
/** A solved Serve's ball bottom clears the net top by at least this, m: never a Let. */
export const SERVE_NET_MARGIN_M = 0.02;

/** Most simulated attempts of the shooting method. */
const SERVE_MAX_PASSES = 10;
/** The first segment's flight time stays within this range, simulated s. */
const MIN_FIRST_FLIGHT_S = 0.08;
const MAX_FIRST_FLIGHT_S = 1;
/** Most the first segment's flight time changes in one correction, as a factor. */
const MAX_TIME_STEP = 1.6;
/** Look-ahead for one attempt, simulated s: any Serve has bounced twice well inside it. */
const SERVE_HORIZON_S = 3;

/** Ball centre height when its bottom touches the table top: where a landing is measured. */
const LANDING_Y = TABLE_TOP_Y + BALL_RADIUS;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

export interface ServeSolveOptions {
  /** Least gap between the ball's bottom and the net top as it crosses, m (SERVE_NET_MARGIN_M). */
  netMargin: number;
  /** Return the last attempt instead of null when the solve fails. */
  bestEffort: boolean;
}

/**
 * The launch from `from` that bounces first within SERVE_BOUNCE1_TOLERANCE_M
 * of `s.bounce1` on the server's half (the half `from` is at), then within
 * SERVE_TARGET_TOLERANCE_M of `s.target` on the receiver's half, clearing the
 * net by `netMargin`; null if there is none. The solution's `flightTime` is
 * the first segment's, launch to first bounce. The ball goes on in line with
 * `from` and the first bounce (Sidespin aside), so an intent whose target is
 * far off that line has no solution.
 */
export function solveServe(from: Vec3, s: ServeIntent, solve: ShotSolver, opts: Partial<ServeSolveOptions> & { bestEffort: true }): ShotSolution;
export function solveServe(from: Vec3, s: ServeIntent, solve?: ShotSolver, opts?: Partial<ServeSolveOptions>): ShotSolution | null;
export function solveServe(from: Vec3, s: ServeIntent, solve: ShotSolver = solveShot, opts: Partial<ServeSolveOptions> = {}): ShotSolution | null {
  const netMargin = opts.netMargin ?? SERVE_NET_MARGIN_M;
  const server: Side = from.z < 0 ? 'opponent' : 'player';
  // Along the Serve (first bounce toward target), and across it.
  const along = unit({ x: s.target.x - s.bounce1.x, z: s.target.z - s.bounce1.z });
  const across = { x: -along.z, z: along.x };

  let aim: TablePoint = { ...s.bounce1 };
  let firstFlight = clamp(s.flightTime, MIN_FIRST_FLIGHT_S, MAX_FIRST_FLIGHT_S);
  /** The previous attempt's first flight time and carry, for a secant step. */
  let previousTry: { time: number; carry: number } | null = null;
  let last: ShotSolution | null = null;
  let passes = 0;
  for (let pass = 0; pass < SERVE_MAX_PASSES; pass++) {
    const solution = solve(from, { target: aim, flightTime: firstFlight, topspin: s.topspin, sidespin: s.sidespin });
    if (!solution) break;
    passes += solution.passes;
    last = { ...solution, passes };
    const flight = flyServe(from, solution);
    const b1 = flight.bounce1;
    if (!b1 || b1.half !== server) break;
    if (meets(flight, s, netMargin)) return last;

    // How far it carried past the first bounce along the Serve: to its second
    // bounce, where it came down off the table, or (into the net) to the net.
    const b2 = flight.bounce2 ?? flight.landing2;
    const wanted = dot(sub(s.target, b1), along);
    const carry = b2 ? dot(sub(b2, b1), along) : -b1.z / along.z;
    if (!(wanted > 0) || !(carry > 0) || !Number.isFinite(carry)) break;
    // The carry shrinks as the first flight time grows (a slower, steeper
    // first segment bounces shorter): a secant step, or a step as if carry ∝ 1 / time.
    let next = firstFlight * (carry / wanted);
    if (previousTry && previousTry.carry !== carry && previousTry.time !== firstFlight) {
      const slope = (carry - previousTry.carry) / (firstFlight - previousTry.time);
      if (slope < 0) next = firstFlight + (wanted - carry) / slope;
    }
    previousTry = { time: firstFlight, carry };
    firstFlight = clamp(clamp(next, firstFlight / MAX_TIME_STEP, firstFlight * MAX_TIME_STEP), MIN_FIRST_FLIGHT_S, MAX_FIRST_FLIGHT_S);

    // A sideways miss at the second bounce is fixed by moving the first, scaled by the lever from the launch.
    if (b2) {
      const lever = horizontalDistance(from, b1) / Math.max(horizontalDistance(from, b2), 1e-6);
      const sideways = dot(sub(b2, s.target), across) * lever;
      aim = { x: aim.x - across.x * sideways, z: aim.z - across.z * sideways };
    }
  }
  if (!opts.bestEffort) return null;
  return last ?? solve(from, { target: s.bounce1, flightTime: s.flightTime, topspin: s.topspin, sidespin: s.sidespin }, { bestEffort: true });
}

/** How a Serve flies through its first two bounces. */
interface ServeFlight {
  /** Its first table bounce, if any (null if it met the net or left the table first). */
  bounce1: (TablePoint & { half: Side }) | null;
  /** Its second table bounce, if any. */
  bounce2: (TablePoint & { half: Side }) | null;
  /** If it left the table after the first bounce: where its centre came down through table height. */
  landing2: TablePoint | null;
  /** Least gap between the ball's bottom and the net top as it crossed z = 0; −Infinity if it never did. */
  netClearance: number;
  /** Every ball event up to the second bounce. */
  events: BallEvent[];
}

/** Fly a solved Serve (seed 0: it never touches the net when it meets the intent) through its second bounce, or until it is no longer live. */
function flyServe(from: Vec3, solution: ShotSolution): ServeFlight {
  const flight: ServeFlight = { bounce1: null, bounce2: null, landing2: null, netClearance: -Infinity, events: [] };
  let previous = launchBall(from, solution.velocity, solution.spin);
  simulate(previous, {
    maxTime: SERVE_HORIZON_S,
    until: (state, _time, events) => {
      const a = previous.position;
      const b = state.position;
      previous = state;
      flight.events.push(...events);
      if (a.z !== 0 && Math.sign(a.z) !== Math.sign(b.z) && flight.netClearance === -Infinity) {
        const f = a.z / (a.z - b.z);
        flight.netClearance = a.y + f * (b.y - a.y) - BALL_RADIUS - NET_TOP_Y;
      }
      for (const event of events) {
        if (event.type !== 'bounce') continue;
        const bounce = { x: event.position.x, z: event.position.z, half: event.half };
        if (!flight.bounce1) flight.bounce1 = bounce;
        else if (!flight.bounce2) flight.bounce2 = bounce;
      }
      if (flight.bounce2) return true;
      if (flight.bounce1 && state.velocity.y < 0 && b.y <= LANDING_Y && a.y > LANDING_Y && Math.sign(b.z) !== Math.sign(from.z)) {
        // Came down through table height off the table, on the receiver's side.
        const f = (a.y - LANDING_Y) / (a.y - b.y);
        flight.landing2 = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
        return true;
      }
      return state.status !== 'live';
    },
  });
  return flight;
}

/** The flight meets the intent: both bounces on the right halves and on target, clear of the net, no Net-cord. */
function meets(flight: ServeFlight, s: ServeIntent, netMargin: number): boolean {
  const { bounce1, bounce2 } = flight;
  if (!bounce1 || !bounce2) return false;
  if (bounce1.half === bounce2.half) return false;
  if (flight.events.some((e) => e.type === 'net' || e.type === 'cord' || e.type === 'out')) return false;
  return (
    distance(bounce1, s.bounce1) <= SERVE_BOUNCE1_TOLERANCE_M &&
    distance(bounce2, s.target) <= SERVE_TARGET_TOLERANCE_M &&
    flight.netClearance >= netMargin
  );
}

/**
 * Call a just-launched Serve by `server` under the Serve rules, by simulating
 * it ahead through the referee: `legal`, `fault` or `let`. A Serve still
 * undecided at the end of the look-ahead (it never bounced again) is a Fault.
 */
export function judgeServe(ball: BallState, server: Side): ServeResult {
  const referee = createReferee();
  referee.serve(server);
  simulate(ball, {
    maxTime: SERVE_HORIZON_S,
    until: (_state, _time, events) => {
      for (const event of events) referee.ballEvent(event);
      return referee.serveResult !== null;
    },
  });
  return referee.serveResult ?? 'fault';
}

function sub(a: TablePoint, b: TablePoint): TablePoint {
  return { x: a.x - b.x, z: a.z - b.z };
}

function dot(a: TablePoint, b: TablePoint): number {
  return a.x * b.x + a.z * b.z;
}

function distance(a: TablePoint, b: TablePoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function horizontalDistance(from: Readonly<Vec3>, p: TablePoint): number {
  return Math.hypot(p.x - from.x, p.z - from.z);
}

function unit(v: TablePoint): TablePoint {
  const n = Math.hypot(v.x, v.z);
  return n < 1e-9 ? { x: 0, z: 1 } : { x: v.x / n, z: v.z / n };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
