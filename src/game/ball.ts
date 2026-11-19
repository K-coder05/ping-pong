/**
 * Ball physics: a point mass under gravity and air drag, stepped at a fixed
 * PHYSICS_DT with a hand-written table bounce (SPEC "Feeder and ball physics").
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
  BOUNCE_FRICTION,
  DRAG_K,
  FLOOR_FRICTION,
  FLOOR_RESTITUTION,
  GRAVITY,
  NET_HEIGHT,
  NET_LENGTH,
  NET_REBOUND,
  PHYSICS_DT,
  SETTLE_SPEED,
  TABLE_HALF_LENGTH,
  TABLE_RESTITUTION,
  TABLE_TOP_Y,
  TABLE_WIDTH,
} from './constants.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Which half of the table, split by the net at z = 0. */
export type TableHalf = 'player' | 'feeder';

/** `live` while the rally is on; `dead` after the net; `out` after leaving the table or a double bounce. */
export type BallStatus = 'live' | 'dead' | 'out';

export interface BallState {
  readonly position: Readonly<Vec3>;
  readonly velocity: Readonly<Vec3>;
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
  /** A live ball crossed z = 0 with its bottom below the net top: it is now dead. */
  | { readonly type: 'net'; readonly position: Readonly<Vec3> }
  /** A live ball ended the rally: below the table top outside its edges, or a second bounce on one half. */
  | { readonly type: 'out'; readonly reason: OutReason; readonly position: Readonly<Vec3> };

export type OutReason = 'off-table' | 'double-bounce';

export interface TimedBallEvent {
  readonly event: BallEvent;
  /** Simulated seconds from the start, at the end of the substep the event happened in. */
  readonly time: number;
}

/** A fresh, live ball in flight from `position` with `velocity`. Use it for every Feed and Return. */
export function launchBall(position: Vec3, velocity: Vec3): BallState {
  return { position: { ...position }, velocity: { ...velocity }, status: 'live', lastBounceHalf: null };
}

/** Ball centre height when its bottom touches the table top. */
const TABLE_CONTACT_Y = TABLE_TOP_Y + BALL_RADIUS;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

/** Where the ball meets a surface along the rest of its substep. */
interface Crossing {
  /** Fraction of the remaining segment at which the crossing happens, 0..1. */
  fraction: number;
  surface: 'table' | 'net' | 'floor';
}

/** Advance one substep. Collisions are swept along the substep, so a fast ball can't skip through. */
export function stepBall(state: BallState, dt: number = PHYSICS_DT): { state: BallState; events: BallEvent[] } {
  const events: BallEvent[] = [];
  let { status, lastBounceHalf } = state;
  const p = { ...state.position };
  const v = { ...state.velocity };

  // Semi-implicit Euler: a = g − k|v|v, then v += a·dt, then p += v·dt.
  const speed = Math.hypot(v.x, v.y, v.z);
  v.x += -DRAG_K * speed * v.x * dt;
  v.y += (GRAVITY - DRAG_K * speed * v.y) * dt;
  v.z += -DRAG_K * speed * v.z * dt;

  // Move along the substep, stopping at the earliest crossing, resolving it,
  // then carrying on with the new velocity for the time that is left.
  let remaining = dt;
  for (let guard = 0; guard < 4 && remaining > 0; guard++) {
    const next = { x: p.x + v.x * remaining, y: p.y + v.y * remaining, z: p.z + v.z * remaining };
    const crossing = earliestCrossing(p, next);
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
      if (!bounceOffSurface(v, TABLE_RESTITUTION, BOUNCE_FRICTION.value)) continue;
      const half = halfAt(p.z);
      events.push({ type: 'bounce', half, position: { ...p } });
      if (status === 'live') {
        if (lastBounceHalf === half) {
          status = 'out';
          events.push({ type: 'out', reason: 'double-bounce', position: { ...p } });
        }
        lastBounceHalf = half;
      }
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

  return { state: { position: p, velocity: v, status, lastBounceHalf }, events };
}

/**
 * Bounce a ball moving down off a horizontal surface: restitution on the
 * vertical speed, friction on the horizontal. Returns false when the ball was
 * too slow to bounce and has settled on the surface instead.
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

/** The first table, net or floor crossing on the segment from `a` to `b`, if any. */
function earliestCrossing(a: Vec3, b: Vec3): Crossing | null {
  let best: Crossing | null = null;

  // Table: the ball's bottom passes down through the table top, over the table.
  const table = downwardCrossing(a, b, TABLE_CONTACT_Y);
  if (table !== null && isOverTable(lerp(a, b, table))) best = { fraction: table, surface: 'table' };

  // Floor: anywhere (nothing can be lower, so it never competes with the table).
  const floor = downwardCrossing(a, b, BALL_RADIUS);
  if (!best && floor !== null) best = { fraction: floor, surface: 'floor' };

  // Net: the ball's centre crosses z = 0 while any part of it is below the net
  // top (clearing the net means the ball's bottom clears it), anywhere along
  // the net including its overhang past the side lines.
  if ((a.z >= 0 && b.z < 0) || (a.z <= 0 && b.z > 0)) {
    const fraction = a.z / (a.z - b.z);
    const at = lerp(a, b, fraction);
    const overlapsNet = at.y - BALL_RADIUS < NET_TOP_Y && at.y + BALL_RADIUS > TABLE_TOP_Y && Math.abs(at.x) <= NET_LENGTH / 2;
    if (overlapsNet && (!best || fraction < best.fraction)) best = { fraction, surface: 'net' };
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

/** Run the same integrator ahead without rendering. Deterministic for a given start and knob values. */
export function simulate(start: BallState, options: SimulateOptions): Simulation {
  let state = start;
  let time = 0;
  const events: TimedBallEvent[] = [];
  // Count whole substeps (not summed floats), so maxTime = n·PHYSICS_DT runs exactly n substeps.
  const maxSteps = Math.round(options.maxTime / PHYSICS_DT);
  for (let i = 1; i <= maxSteps; i++) {
    const step = stepBall(state);
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
