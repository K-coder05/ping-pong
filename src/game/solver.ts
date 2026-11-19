/**
 * Target solver (SPEC "Shot resolver and target solver"): the launch velocity
 * that takes a ball from a start point to a landing spot on the table in a
 * given flight time. Shared by the Feeder (Feeds) and the shot resolver
 * (Returns); nothing here knows which one is asking.
 *
 * Closed form without drag first, then a few corrections against the real
 * integrator, so the actual ball (with drag) lands where it was aimed.
 */

import { launchBall, simulate, type Vec3 } from './ball.ts';
import { BALL_RADIUS, GRAVITY, NET_HEIGHT, TABLE_TOP_Y } from './constants.ts';

/** A spot on the table top (or its plane, for a deliberate miss off the table). */
export interface TablePoint {
  x: number;
  z: number;
}

export interface LaunchSolution {
  velocity: Vec3;
  /** The flight time actually used: longer than asked when the arc had to be raised to clear the net. */
  flightTime: number;
}

/** Ball centre height when its bottom touches the table top: where a landing is measured. */
const LANDING_Y = TABLE_TOP_Y + BALL_RADIUS;
const DRAG_CORRECTIONS = 8;
/** Stop correcting once the simulated landing is this close to the target, metres. */
const LANDING_TOLERANCE = 0.001;
/** Minimum gap between the ball's bottom and the net top as it crosses z = 0, metres. */
export const NET_CLEARANCE = 0.05;
/** Each raise lengthens the flight time by this factor (a higher, slower arc). */
const ARC_RAISE_FACTOR = 1.1;
/** Enough raises to more than triple the flight time; past that, give up and return the last try. */
const MAX_ARC_RAISES = 12;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

/**
 * The launch velocity from `from` that first lands at `target` after
 * `flightTime` seconds, with drag. If that path would not clear the net by
 * NET_CLEARANCE, the arc is raised (flight time × 1.1) until it does.
 *
 * To make a shot miss on purpose, move the target (long or wide); never add
 * noise to the returned velocity (ADR 0001).
 */
export function solveLaunch(from: Vec3, target: TablePoint, flightTime: number): LaunchSolution {
  let T = flightTime;
  let velocity = solveForFlightTime(from, target, T);
  for (let raise = 0; raise < MAX_ARC_RAISES && !clearsNet(from, velocity); raise++) {
    T *= ARC_RAISE_FACTOR;
    velocity = solveForFlightTime(from, target, T);
  }
  return { velocity, flightTime: T };
}

function solveForFlightTime(from: Vec3, target: TablePoint, T: number): Vec3 {
  const velocity = {
    x: (target.x - from.x) / T,
    y: (LANDING_Y - from.y - 0.5 * GRAVITY * T * T) / T,
    z: (target.z - from.z) / T,
  };
  for (let i = 0; i < DRAG_CORRECTIONS; i++) {
    const land = landingPoint(from, velocity, T);
    const errX = target.x - land.x;
    const errZ = target.z - land.z;
    if (Math.hypot(errX, errZ) < LANDING_TOLERANCE) break;
    velocity.x += errX / T;
    velocity.z += errZ / T;
  }
  return velocity;
}

/**
 * Whether the ball's bottom passes at least NET_CLEARANCE above the net top
 * where its centre crosses z = 0. A path that never crosses the net plane
 * (both ends on one side) has nothing to clear.
 */
function clearsNet(from: Vec3, velocity: Vec3): boolean {
  let previous = launchBall(from, velocity);
  let clears = true;
  simulate(previous, {
    maxTime: 5,
    until: (state, _time, events) => {
      if (events.some((e) => e.type === 'net')) {
        clears = false;
        return true;
      }
      const before = previous.position;
      const after = state.position;
      previous = state;
      if (before.z !== 0 && Math.sign(after.z) === Math.sign(before.z)) {
        // Not crossed yet; stop once the ball lands or drops to table height off the table.
        return events.some((e) => e.type === 'bounce') || after.y <= LANDING_Y;
      }
      const f = before.z / (before.z - after.z);
      const crossingY = before.y + f * (after.y - before.y);
      clears = crossingY - BALL_RADIUS >= NET_TOP_Y + NET_CLEARANCE;
      return true;
    },
  });
  return clears;
}

/** Where the ball first lands: its first table bounce, or where it reaches table height off the table. */
function landingPoint(from: Vec3, velocity: Vec3, flightTime: number): Vec3 {
  const run = simulate(launchBall(from, velocity), {
    maxTime: 3 * flightTime + 1,
    until: (state, _time, events) => events.some((e) => e.type === 'bounce') || state.position.y <= LANDING_Y,
  });
  const bounce = run.events.find((e) => e.event.type === 'bounce');
  return bounce ? bounce.event.position : run.state.position;
}
