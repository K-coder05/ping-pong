/**
 * Target solver (SPEC "Shot resolver and target solver", spec P1-c): turns a
 * Shot intent (landing spot, flight time, Topspin, Sidespin) into a launch
 * velocity and spin. Shared by the Feeder (Feeds) and the shot resolver
 * (Returns); nothing here knows which one is asking.
 *
 * Closed form without drag or spin first, then a few refinement passes
 * against the real integrator (drag, Magnus, spin decay), so the actual ball
 * lands where it was aimed, when it was asked to. If the path would not clear
 * the net by the margin, the arc is raised (a longer flight time) and solved
 * again. The solver either lands within SOLVER_MAX_MISS_M and clears the net,
 * or reports failure (null): it never moves the target (ADR 0001).
 */

import { spinVector } from '../physics/spin.ts';
import { add, sub } from '../physics/vec3.ts';
import { knobFlightParams, launchBall, simulate, type BallState, type FlightParams, type Vec3 } from './ball.ts';
import {
  ARC_RAISE_FACTOR,
  BALL_RADIUS,
  GRAVITY,
  NET_CLEARANCE,
  NET_HEIGHT,
  PHYSICS_DT,
  SOLVER_MAX_MISS_M,
  SOLVER_MAX_PASSES,
  SOLVER_MAX_RAISES,
  SOLVER_STOP_MISS_M,
  SOLVER_STOP_TIME_S,
  TABLE_HALF_LENGTH,
  TABLE_TOP_Y,
  TABLE_WIDTH,
} from './constants.ts';

/** A spot on the table top (or its plane, for a deliberate miss off the table). */
export interface TablePoint {
  x: number;
  z: number;
}

/** What a Shot should do: where and when it first lands, and with what spin. */
export interface ShotIntent {
  /** Landing spot on the table plane (may be off the table for a deliberate miss). */
  target: TablePoint;
  /** Simulated seconds, launch to first landing. */
  flightTime: number;
  /** rad/s about the Shot's horizontal direction; negative = Backspin. */
  topspin: number;
  /** rad/s about the vertical. */
  sidespin: number;
}

export interface SolveOptions {
  /** Minimum gap between the ball's bottom and the net top as it crosses z = 0, metres (NET_CLEARANCE). */
  netMargin: number;
  /** Most refinement passes per flight time (SOLVER_MAX_PASSES). */
  maxPasses: number;
  /** Most arc raises to clear the net (SOLVER_MAX_RAISES). */
  maxRaises: number;
  /** Return the last attempt instead of null when the solve fails. */
  bestEffort: boolean;
}

export interface ShotSolution {
  velocity: Vec3;
  /** Spin vector to launch with, rad/s. */
  spin: Vec3;
  /** The flight time actually used: longer than asked when the arc had to be raised to clear the net. */
  flightTime: number;
  /** Refinement passes (simulations) used, over every flight time tried. */
  passes: number;
}

export const DEFAULT_SOLVE_OPTIONS: Readonly<SolveOptions> = {
  netMargin: NET_CLEARANCE,
  maxPasses: SOLVER_MAX_PASSES,
  maxRaises: SOLVER_MAX_RAISES,
  bestEffort: false,
};

/**
 * `solveShot`, or a stand-in for it: the Feeder and the shot resolver take one
 * so tests can make it fail. A stand-in keeps the contract: with
 * `bestEffort: true` it always returns a launch.
 */
export type ShotSolver = typeof solveShot;

/** Ball centre height when its bottom touches the table top: where a landing is measured. */
const LANDING_Y = TABLE_TOP_Y + BALL_RADIUS;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

/**
 * The launch from `from` that first lands at `intent.target` after
 * `intent.flightTime` seconds, with drag and the intent's spin. If that path
 * would not clear the net by `netMargin`, the arc is raised (flight time ×
 * ARC_RAISE_FACTOR) up to `maxRaises` times. Null if it still misses by more
 * than SOLVER_MAX_MISS_M or can't clear the net, unless `bestEffort`, which
 * returns the last attempt instead.
 *
 * A target off the table (a deliberate miss) is met where the ball comes down
 * through table height, and only by a path that doesn't bounce on the table
 * first. To make a Shot miss on purpose, move the target; never add noise to
 * the returned launch (ADR 0001).
 */
export function solveShot(from: Vec3, intent: ShotIntent, opts: Partial<SolveOptions> & { bestEffort: true }): ShotSolution;
export function solveShot(from: Vec3, intent: ShotIntent, opts?: Partial<SolveOptions>): ShotSolution | null;
export function solveShot(from: Vec3, intent: ShotIntent, opts: Partial<SolveOptions> = {}): ShotSolution | null {
  const options = { ...DEFAULT_SOLVE_OPTIONS, ...opts };
  const { target } = intent;
  const spin = spinVector(intent.topspin, intent.sidespin, horizontalDirection(from, target));
  const mustCrossNet = Math.sign(from.z) !== Math.sign(target.z);
  const targetOnTable = isOverTable(target);
  const params = knobFlightParams();

  let flightTime = intent.flightTime;
  let passes = 0;
  // What the passes added to the drag-free launch: a head start for the next, raised, flight time.
  let correction: Vec3 = { x: 0, y: 0, z: 0 };
  let last: Attempt | null = null;
  for (let raise = 0; raise <= options.maxRaises; raise++) {
    if (raise > 0) flightTime *= ARC_RAISE_FACTOR;
    const start = dragFreeLaunch(from, target, flightTime);
    last = refine(from, target, flightTime, spin, add(start, correction), options.maxPasses, params);
    passes += last.passes;
    correction = sub(last.velocity, start);

    const clearsNet = !mustCrossNet || (last.flight !== null && last.flight.netClearance >= options.netMargin);
    const onTarget = last.flight !== null && last.miss <= SOLVER_MAX_MISS_M && last.flight.bounced === targetOnTable;
    if (clearsNet && onTarget) return solution(last, spin, flightTime, passes);
    // Only the net is a reason to raise the arc; a clear path that still misses has failed.
    if (clearsNet) break;
  }
  return options.bestEffort && last ? solution(last, spin, flightTime, passes) : null;
}

function solution(attempt: Attempt, spin: Vec3, flightTime: number, passes: number): ShotSolution {
  return { velocity: attempt.velocity, spin, flightTime, passes };
}

/** One simulated launch and how it went. */
interface Attempt {
  velocity: Vec3;
  /** Null if the ball never landed within the look-ahead. */
  flight: Flight | null;
  /** Distance from the landing to the target, metres (Infinity if it never landed). */
  miss: number;
  passes: number;
}

/**
 * Refinement passes for one flight time: simulate, then take a Newton step on
 * the landing and flight-time errors, until both are within the stopping
 * tolerances or the passes run out. Returns the best simulated attempt, so the
 * result is always one the integrator actually flew.
 */
function refine(from: Vec3, target: TablePoint, T: number, spin: Vec3, start: Vec3, maxPasses: number, params: FlightParams): Attempt {
  let velocity = { ...start };
  let best: Omit<Attempt, 'passes'> | null = null;
  let pass = 0;
  while (pass < maxPasses) {
    pass++;
    const flight = fly(from, velocity, spin, T, params);
    const miss = flight ? Math.hypot(target.x - flight.landing.x, target.z - flight.landing.z) : Infinity;
    if (!best || miss < best.miss) best = { velocity, flight, miss };
    if (!flight) break;
    const residual: Vec3 = { x: flight.landing.x - target.x, y: flight.time - T, z: flight.landing.z - target.z };
    if (miss < SOLVER_STOP_MISS_M && Math.abs(residual.y) < SOLVER_STOP_TIME_S) break;
    const step = solve3(flight.jacobian, residual);
    if (!step) break;
    velocity = sub(velocity, step);
  }
  return { ...best!, passes: pass };
}

/** The drag-free, spin-free launch that reaches the target at table-contact height after T seconds. */
function dragFreeLaunch(from: Vec3, target: TablePoint, T: number): Vec3 {
  return {
    x: (target.x - from.x) / T,
    y: (LANDING_Y - from.y - 0.5 * GRAVITY * T * T) / T,
    z: (target.z - from.z) / T,
  };
}

/** A 3×3 matrix, row-major. */
type Matrix3 = number[];

/** A launch flown with the real integrator up to its first landing. */
interface Flight {
  /** First table bounce, or where the centre comes down through LANDING_Y off the table. */
  landing: Vec3;
  /** Simulated seconds to the landing, interpolated within its substep. */
  time: number;
  /** Whether the landing was a bounce on the table. */
  bounced: boolean;
  /**
   * Height of the ball's bottom above the net top where its centre crossed
   * z = 0 before landing; −Infinity if it never crossed (it hit the net and
   * dropped back, or landed short of it).
   */
  netClearance: number;
  /**
   * How (landing x, flight time, landing z) change with the launch velocity
   * (v.x, v.y, v.z): rows in that order. Drives the Newton step.
   */
  jacobian: Matrix3;
}

/**
 * Fly a launch (seed 0) until it first lands, as the old `hasLanded` did: a
 * table bounce, or coming down through LANDING_Y off the table. Only on the
 * way down: a Shot struck below table height (a late Return) must rise first.
 * Net clearance is measured from the path itself, so a Net-cord or a ball
 * that drops back off the net counts as not clearing, live or not.
 *
 * Alongside, it carries the sensitivity of position and velocity to the
 * launch velocity through each substep, linearising the same semi-implicit
 * Euler step `stepBall` takes (v += a(v, ω)·dt, then p += v·dt), so the
 * Jacobian is the integrator's own, not a drag-free guess.
 */
function fly(from: Vec3, velocity: Vec3, spin: Vec3, T: number, params: FlightParams): Flight | null {
  let previous: BallState = launchBall(from, velocity, spin);
  let netClearance = -Infinity;
  let crossed = false;
  let flight: Flight | null = null;
  let dv: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let dp: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  simulate(
    previous,
    {
      maxTime: 3 * T + 1,
      until: (state, time, events) => {
        const before = previous;
        previous = state;
        dv = addScaled(dv, multiply(accelerationJacobian(before.velocity, before.spin, params), dv), PHYSICS_DT);
        dp = addScaled(dp, dv, PHYSICS_DT);
        const a = before.position;
        const b = state.position;
        if (!crossed && a.z !== 0 && Math.sign(a.z) !== Math.sign(b.z)) {
          crossed = true;
          const f = a.z / (a.z - b.z);
          netClearance = a.y + f * (b.y - a.y) - BALL_RADIUS - NET_TOP_Y;
        }
        const bounce = events.find((e) => e.type === 'bounce');
        if (!bounce && !(state.velocity.y < 0 && b.y <= LANDING_Y)) return false;
        // The substep's velocity before any bounce (a bounce has already reflected it; gravity dominates over one substep).
        const v = bounce ? { ...before.velocity, y: before.velocity.y + params.g * PHYSICS_DT } : state.velocity;
        const f = Math.min(1, Math.max(0, (a.y - LANDING_Y) / (-v.y * PHYSICS_DT)));
        const landing = bounce ? { ...bounce.position } : { x: a.x + (b.x - a.x) * f, y: LANDING_Y, z: a.z + (b.z - a.z) * f };
        // Landing is where y = LANDING_Y: a launch change δ moves the landing time by −(dp_y·δ)/v_y.
        const dt = [0, 1, 2].map((j) => -dp[3 + j]! / v.y);
        const jacobian = [...[0, 1, 2].map((j) => dp[j]! + v.x * dt[j]!), ...dt, ...[0, 1, 2].map((j) => dp[6 + j]! + v.z * dt[j]!)];
        flight = { landing, time: time - (1 - f) * PHYSICS_DT, bounced: bounce !== undefined, netClearance, jacobian };
        return true;
      },
    },
    params,
  );
  return flight;
}

/**
 * ∂a/∂v of a = g ŷ − k|v|v + kM (ω × v): drag −k(|v| I + v vᵀ/|v|), Magnus kM [ω]×.
 * Spin doesn't depend on the launch velocity, so it is just carried along.
 */
function accelerationJacobian(v: Vec3, w: Vec3, p: FlightParams): Matrix3 {
  const speed = Math.hypot(v.x, v.y, v.z);
  const u = speed > 1e-12 ? [v.x / speed, v.y / speed, v.z / speed] : [0, 0, 0];
  const cross = [0, -w.z, w.y, w.z, 0, -w.x, -w.y, w.x, 0];
  return cross.map((c, i) => {
    const r = Math.floor(i / 3);
    const col = i % 3;
    return -p.k * speed * ((r === col ? 1 : 0) + u[r]! * u[col]!) + p.kM * c;
  });
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out: Matrix3 = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!);
  }
  return out;
}

function addScaled(a: Matrix3, b: Matrix3, s: number): Matrix3 {
  return a.map((value, i) => value + b[i]! * s);
}

/** x with m·x = r (Cramer's rule), or null if m is (nearly) singular. */
function solve3(m: Matrix3, r: Vec3): Vec3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    x: (r.x * (e * i - f * h) - b * (r.y * i - f * r.z) + c * (r.y * h - e * r.z)) / det,
    y: (a * (r.y * i - f * r.z) - r.x * (d * i - f * g) + c * (d * r.z - r.y * g)) / det,
    z: (a * (e * r.z - r.y * h) - b * (d * r.z - r.y * g) + r.x * (d * h - e * g)) / det,
  };
}

/** Unit vector along the horizontal from `from` to `target`; straight down the table if they coincide. */
function horizontalDirection(from: Vec3, target: TablePoint): Vec3 {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const n = Math.hypot(dx, dz);
  if (n < 1e-9) return { x: 0, y: 0, z: from.z > 0 ? -1 : 1 };
  return { x: dx / n, y: 0, z: dz / n };
}

function isOverTable(p: TablePoint): boolean {
  return Math.abs(p.x) <= TABLE_WIDTH / 2 && Math.abs(p.z) <= TABLE_HALF_LENGTH;
}
