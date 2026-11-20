import { launchBall, simulate, type Vec3 } from '../game/ball.ts';
import { BALL_RADIUS, NET_HEIGHT, PHYSICS_DT, TABLE_TOP_Y } from '../game/constants.ts';
import { solveShot, type ShotIntent } from '../game/solver.ts';

/**
 * The physics debug page's per-Shot numbers (spec P1-d): solve a Shot, fly it
 * with the real integrator and read off where it landed, how it cleared the
 * net, how high it went and how fast it left the table. Pure, so the page
 * itself stays a thin shell around it.
 */

export type MarkerKind = 'bounce' | 'cord' | 'net';

export interface ShotMarker {
  kind: MarkerKind;
  position: Vec3;
}

export interface ShotReadouts {
  /** Metres from the first bounce to the target; null if the Shot never bounced. */
  landingError: number | null;
  /** Height of the ball's bottom above the net top as it crossed z = 0, metres; null if it never crossed. */
  netClearance: number | null;
  /** Highest the ball got before its first bounce, metres above the table top. */
  apexHeight: number;
  /** Horizontal speed just after the first bounce, m/s; null if it never bounced. */
  speedAfterBounce: number | null;
  /** Solver passes used. */
  passes: number;
  /** The flight time the solver actually used (longer than asked if it had to raise the arc). */
  flightTime: number;
}

export interface AnalysedShot {
  /** Ball centre every PHYSICS_DT from launch (index 0) until the rally would end or the look-ahead runs out. */
  path: Vec3[];
  markers: ShotMarker[];
  spin: Vec3;
  readouts: ShotReadouts;
}

/** Simulated seconds flown past the flight time, to show the bounce and what follows. */
const FOLLOW_ON_S = 0.8;

/** Solve and fly one Shot. Null when the solver reports no solution. */
export function analyseShot(from: Vec3, intent: ShotIntent): AnalysedShot | null {
  const solution = solveShot(from, intent);
  if (!solution) return null;

  const path: Vec3[] = [{ ...from }];
  const markers: ShotMarker[] = [];
  let firstBounce = null as Vec3 | null; // assigned in the callback below
  let speedAfterBounce: number | null = null;
  let apexY = from.y;
  let netClearance: number | null = null;
  let afterBounce = false;

  simulate(launchBall(from, solution.velocity, solution.spin), {
    maxTime: solution.flightTime + FOLLOW_ON_S,
    until: (state, _time, events) => {
      const previous = path[path.length - 1]!;
      const position = { ...state.position };
      path.push(position);
      if (!afterBounce) apexY = Math.max(apexY, position.y);
      if (netClearance === null && previous.z * position.z <= 0 && previous.z !== position.z) {
        const f = previous.z / (previous.z - position.z);
        const y = previous.y + (position.y - previous.y) * f;
        netClearance = y - BALL_RADIUS - (TABLE_TOP_Y + NET_HEIGHT);
      }
      for (const event of events) {
        if (event.type === 'bounce' || event.type === 'cord' || event.type === 'net') {
          markers.push({ kind: event.type, position: { ...event.position } });
        }
        if (event.type === 'bounce' && !firstBounce) {
          firstBounce = { ...event.position };
          afterBounce = true;
          speedAfterBounce = Math.hypot(state.velocity.x, state.velocity.z);
        }
      }
      return state.status !== 'live';
    },
  });

  return {
    path,
    markers,
    spin: solution.spin,
    readouts: {
      landingError: firstBounce ? Math.hypot(firstBounce.x - intent.target.x, firstBounce.z - intent.target.z) : null,
      netClearance,
      apexHeight: apexY - TABLE_TOP_Y,
      speedAfterBounce,
      passes: solution.passes,
      flightTime: solution.flightTime,
    },
  };
}

/** The ball's position `seconds` after launch, held at the end of the path. */
export function positionAt(path: readonly Vec3[], seconds: number): Vec3 {
  const index = Math.min(path.length - 1, Math.max(0, Math.round(seconds / PHYSICS_DT)));
  return path[index]!;
}

/** Seconds a path takes to fly. */
export function pathDuration(path: readonly Vec3[]): number {
  return (path.length - 1) * PHYSICS_DT;
}
