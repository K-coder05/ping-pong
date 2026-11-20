/**
 * Ball physics: a point mass under gravity, air drag and the Magnus force of
 * its Spin (`physics/flight.ts`), stepped at a fixed PHYSICS_DT. A table
 * bounce trades speed and Spin (`physics/bounce.ts`); a ball clipping the net
 * top makes a Net-cord and carries on (`physics/net.ts`). Spin fades in
 * flight; the floor and slow table contacts (settles) don't change it.
 *
 * Everything here is pure and headless: the game loop steps it in real time,
 * and the Feeder and target solver call `simulate` to look ahead.
 *
 * Physical contacts (table, net, floor) always happen; the rally rules only
 * apply while the ball is live. A ball that hits the net is dead; one that
 * drops below the table top outside its edges, or bounces twice on one half,
 * is out. Either way it keeps falling and bouncing so it looks right, but it
 * never changes status again.
 */

import {
  BALL_RADIUS,
  DRAG_K,
  FLOOR_FRICTION,
  FLOOR_RESTITUTION,
  GRAVITY,
  MAGNUS_K,
  NET_HEIGHT,
  NET_LENGTH,
  NET_REBOUND,
  PHYSICS_DT,
  SETTLE_SPEED,
  SPIN_TAU_S,
  TABLE_HALF_LENGTH,
  TABLE_KAPPA,
  TABLE_MU,
  TABLE_RESTITUTION,
  TABLE_SETTLE_FRICTION,
  TABLE_TOP_Y,
  TABLE_WIDTH,
} from './constants.ts';

import { tableBounce, type BounceParams } from '../physics/bounce.ts';
import { decaySpin, flightAcceleration, type FlightParams } from '../physics/flight.ts';
import { classifyNetCrossing, cordVelocity } from '../physics/net.ts';
import { add, scale, ZERO, type Vec3 } from '../physics/vec3.ts';
import { makeRng } from '../util/rng.ts';

export type { BounceParams, FlightParams, Vec3 };

/** Which half of the table, split by the net at z = 0. */
export type TableHalf = 'player' | 'feeder';

/** `live` while the rally is on; `dead` after the net; `out` after leaving the table or a double bounce. */
export type BallStatus = 'live' | 'dead' | 'out';

export interface BallState {
  readonly position: Readonly<Vec3>;
  readonly velocity: Readonly<Vec3>;
  /** Spin vector, rad/s (`physics/spin.ts` builds it from Topspin and Sidespin). */
  readonly spin: Readonly<Vec3>;
  /** Per-Shot seed, for randomness at contacts (the Net-cord); 0 unless the launcher draws one. */
  readonly seed: number;
  readonly status: BallStatus;
  /** Half of the latest table bounce since launch while live, or null before the first one. */
  readonly lastBounceHalf: TableHalf | null;
}

export type BallEvent =
  /**
   * The ball bounced on the table top. Fires for every audible bounce, live or
   * not, so it drives the bounce sound; rules (Returns) must also check status.
   */
  | { readonly type: 'bounce'; readonly half: TableHalf; readonly position: Readonly<Vec3> }
  /** A live ball crossed z = 0 with its bottom more than a radius below the net top: it is now dead. */
  | { readonly type: 'net'; readonly position: Readonly<Vec3> }
  /**
   * A Net-cord: the ball clipped the net top (its bottom within a radius below
   * it) and carries on, popping up. Status doesn't change: one that then lands
   * on the far half is a normal bounce there. Fires live or not, like `bounce`.
   */
  | { readonly type: 'cord'; readonly position: Readonly<Vec3> }
  /** A live ball ended the rally: below the table top outside its edges, or a second bounce on one half. */
  | { readonly type: 'out'; readonly reason: OutReason; readonly position: Readonly<Vec3> };

export type OutReason = 'off-table' | 'double-bounce';

export interface TimedBallEvent {
  readonly event: BallEvent;
  /** Simulated seconds from the start, at the end of the substep the event happened in. */
  readonly time: number;
}

/** A fresh, live ball in flight from `position` with `velocity` and `spin`. Use it for every Feed and Return. */
export function launchBall(position: Vec3, velocity: Vec3, spin: Vec3 = ZERO, seed = 0): BallState {
  return { position: { ...position }, velocity: { ...velocity }, spin: { ...spin }, seed, status: 'live', lastBounceHalf: null };
}

/** The flight parameters from the live knobs; `stepBall` and `simulate` use these by default. */
export function knobFlightParams(): FlightParams {
  return { g: GRAVITY, k: DRAG_K, kM: MAGNUS_K.value, spinTau: SPIN_TAU_S.value };
}

/** The table-bounce parameters from the live knobs; `stepBall` reads these at each bounce. */
export function knobBounceParams(): BounceParams {
  return { e: TABLE_RESTITUTION, mu: TABLE_MU.value, kappa: TABLE_KAPPA, r: BALL_RADIUS };
}

/** Ball centre height when its bottom touches the table top. */
const TABLE_CONTACT_Y = TABLE_TOP_Y + BALL_RADIUS;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

/** Where the ball meets a surface along the rest of its substep. */
interface Crossing {
  /** Fraction of the remaining segment at which the crossing happens, 0..1. */
  fraction: number;
  surface: 'table' | 'net' | 'cord' | 'floor';
}

/** Advance one substep. Collisions are swept along the substep, so a fast ball can't skip through. */
export function stepBall(
  state: BallState,
  dt: number = PHYSICS_DT,
  params: FlightParams = knobFlightParams(),
): { state: BallState; events: BallEvent[] } {
  const events: BallEvent[] = [];
  let { status, lastBounceHalf } = state;
  const p = { ...state.position };
  let spin: Vec3 = { ...state.spin };

  // Semi-implicit Euler: a = g − k|v|v + kM(ω × v), then v += a·dt, then p += v·dt.
  const v = add(state.velocity, scale(flightAcceleration(state.velocity, state.spin, params), dt));

  // Move along the substep, stopping at the earliest crossing, resolving it,
  // then carrying on with the new velocity for the time that is left.
  let remaining = dt;
  let corded = false; // a Net-cord leaves the ball on the net plane: don't classify the net again this substep
  for (let guard = 0; guard < 4 && remaining > 0; guard++) {
    const next = { x: p.x + v.x * remaining, y: p.y + v.y * remaining, z: p.z + v.z * remaining };
    const crossing = earliestCrossing(p, next, !corded);
    if (!crossing) {
      Object.assign(p, next);
      break;
    }
    Object.assign(p, lerp(p, next, crossing.fraction));
    remaining *= 1 - crossing.fraction;

    if (crossing.surface === 'floor') {
      p.y = BALL_RADIUS;
      bounceOffSurface(v, FLOOR_RESTITUTION, FLOOR_FRICTION);
    } else if (crossing.surface === 'table') {
      p.y = TABLE_CONTACT_Y;
      if (-v.y < SETTLE_SPEED) {
        // Too slow to bounce: settle on the table, so resting balls stop. Spin unchanged.
        v.x *= TABLE_SETTLE_FRICTION;
        v.z *= TABLE_SETTLE_FRICTION;
        v.y = 0;
        continue;
      }
      const out = tableBounce(v, spin, knobBounceParams());
      Object.assign(v, out.velocity);
      spin = out.spin;
      const half = halfAt(p.z);
      events.push({ type: 'bounce', half, position: { ...p } });
      if (status === 'live') {
        if (lastBounceHalf === half) {
          status = 'out';
          events.push({ type: 'out', reason: 'double-bounce', position: { ...p } });
        }
        lastBounceHalf = half;
      }
    } else if (crossing.surface === 'cord') {
      // Clipped the net top: sit the ball's bottom on it and carry on. The
      // nudge comes from the Shot's own seed, so look-ahead cords identically.
      corded = true;
      p.y = NET_TOP_Y + BALL_RADIUS;
      events.push({ type: 'cord', position: { ...p } });
      Object.assign(v, cordVelocity(v, makeRng(state.seed)));
    } else {
      if (status === 'live') {
        status = 'dead';
        events.push({ type: 'net', position: { ...p } });
      }
      const towardNet = Math.sign(v.z);
      p.z = -towardNet * BALL_RADIUS; // touching the net on the side it came from
      v.z = -NET_REBOUND * v.z;
    }
  }

  if (status === 'live' && p.y < TABLE_TOP_Y && !isOverTable(p)) {
    status = 'out';
    events.push({ type: 'out', reason: 'off-table', position: { ...p } });
  }

  // Spin fades in flight (after any change at a table bounce this substep).
  spin = decaySpin(spin, dt, params.spinTau);

  return { state: { position: p, velocity: v, spin, seed: state.seed, status, lastBounceHalf }, events };
}

/**
 * Bounce a ball moving down off the floor: restitution on the vertical speed,
 * friction on the horizontal. Returns false when the ball was too slow to
 * bounce and has settled on the floor instead.
 */
function bounceOffSurface(v: Vec3, restitution: number, friction: number): boolean {
  v.x *= friction;
  v.z *= friction;
  if (-v.y < SETTLE_SPEED) {
    v.y = 0;
    return false;
  }
  v.y = -restitution * v.y;
  return true;
}

/**
 * The first table, net (dead or Net-cord) or floor crossing on the segment
 * from `a` to `b`, if any. With `withNet` false, the net is ignored.
 */
function earliestCrossing(a: Vec3, b: Vec3, withNet: boolean): Crossing | null {
  let best: Crossing | null = null;

  // Table: the ball's bottom passes down through the table top, over the table.
  const table = downwardCrossing(a, b, TABLE_CONTACT_Y);
  if (table !== null && isOverTable(lerp(a, b, table))) best = { fraction: table, surface: 'table' };

  // Floor: anywhere (nothing can be lower, so it never competes with the table).
  const floor = downwardCrossing(a, b, BALL_RADIUS);
  if (!best && floor !== null) best = { fraction: floor, surface: 'floor' };

  // Net: the ball's centre crosses z = 0 while any part of it is below the net
  // top (clearing the net means the ball's bottom clears it), anywhere along
  // the net including its overhang past the side lines. A bottom within one
  // radius below the net top clips the top (a Net-cord); lower hits the net.
  if (withNet && ((a.z >= 0 && b.z < 0) || (a.z <= 0 && b.z > 0))) {
    const fraction = a.z / (a.z - b.z);
    const at = lerp(a, b, fraction);
    const contact = classifyNetCrossing(at.y - BALL_RADIUS, NET_TOP_Y, BALL_RADIUS);
    const alongNet = at.y + BALL_RADIUS > TABLE_TOP_Y && Math.abs(at.x) <= NET_LENGTH / 2;
    if (contact !== 'clear' && alongNet && (!best || fraction < best.fraction)) {
      best = { fraction, surface: contact === 'cord' ? 'cord' : 'net' };
    }
  }

  return best;
}

/** Fraction along `a` → `b` at which the ball centre passes down through height `y`, or null. */
function downwardCrossing(a: Vec3, b: Vec3, y: number): number | null {
  if (!(b.y < a.y && a.y >= y && b.y < y)) return null;
  return (a.y - y) / (a.y - b.y);
}

export interface SimulateOptions {
  /** Stop after this much simulated time, in seconds. */
  maxTime: number;
  /** Checked after each substep with that substep's events; return true to stop. */
  until?: (state: BallState, time: number, events: readonly BallEvent[]) => boolean;
}

export interface Simulation {
  /** The ball when the simulation stopped. */
  state: BallState;
  /** Simulated seconds from the start. */
  time: number;
  /** Every event, stamped with the end of the substep it happened in. */
  events: TimedBallEvent[];
}

/**
 * Run the same integrator ahead without rendering. Deterministic for a given
 * start and flight parameters; without `params`, it reads the knobs once at the start.
 */
export function simulate(start: BallState, options: SimulateOptions, params: FlightParams = knobFlightParams()): Simulation {
  let state = start;
  let time = 0;
  const events: TimedBallEvent[] = [];
  // Count whole substeps (not summed floats), so maxTime = n·PHYSICS_DT runs exactly n substeps.
  const maxSteps = Math.round(options.maxTime / PHYSICS_DT);
  for (let i = 1; i <= maxSteps; i++) {
    const step = stepBall(state, PHYSICS_DT, params);
    state = step.state;
    time = i * PHYSICS_DT;
    for (const event of step.events) events.push({ event, time });
    if (options.until?.(state, time, step.events)) break;
  }
  return { state, time, events };
}

function isOverTable(p: Vec3): boolean {
  return Math.abs(p.x) <= TABLE_WIDTH / 2 && Math.abs(p.z) <= TABLE_HALF_LENGTH;
}

function halfAt(z: number): TableHalf {
  return z >= 0 ? 'player' : 'feeder';
}

function lerp(a: Vec3, b: Vec3, fraction: number): Vec3 {
  return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, z: a.z + (b.z - a.z) * fraction };
}
