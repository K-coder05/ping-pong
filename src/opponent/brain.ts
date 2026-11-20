/**
 * The Opponent's brain (spec P2-c, ADR 0002): when a Shot toward the Opponent
 * launches, it rates how hard that ball is and decides the Shot it will play
 * at the Ideal Time, at its Difficulty:
 *
 * - a **good Shot**: a corner more often at higher Difficulty, else anywhere
 *   on the player's half, with Gaussian scatter and a pull toward
 *   cross-court, Topspin or Backspin, kept on the table;
 * - or a mistake, more likely against a harder ball: a **Pop-up** (a high,
 *   slow ball to the middle the player can attack), an **Error** (just past
 *   the player's end line or wide of a sideline) or a **Whiff**.
 *
 * ADR 0001: a mistake moves the Shot's target, never its launch. The brain
 * only returns the Shot's intent; the core strikes it at the Ideal Time with
 * `solveReturn`, which never moves an Error's target. Every draw comes from
 * the `random` it is given, in a fixed order, so a seed replays a Match.
 */

import { launchBall, type Vec3 } from '../game/ball.ts';
import { PLAYER_END_Z, TABLE_WIDTH } from '../game/constants.ts';
import { findIdealTime, type Incoming, type Opponent } from '../game/rally.ts';
import { contactPoint } from '../game/shotResolver.ts';
import { solveShot, type ShotIntent, type ShotSolver, type SolveOptions, type TablePoint } from '../game/solver.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { OPPONENT_MAX_FLIGHT_S, type DifficultyParams } from './difficulty.ts';

/** An incoming ball this fast (m/s, at the strike) or faster is as hard as speed gets. */
export const HARD_SPEED = 12;
/** An incoming ball with this much Spin (rev/s, at the strike) or more is as hard as Spin gets. */
export const HARD_SPIN_REVS = 50;
/** An incoming ball this far from the centre line (m, at the strike) or further is as wide as it gets. */
export const HARD_WIDTH_M = 0.76;
/** How much speed, Spin and width count toward an incoming ball's difficulty. */
const SPEED_WEIGHT = 0.5;
const SPIN_WEIGHT = 0.25;
const WIDTH_WEIGHT = 0.25;

/** A Pop-up: a high, slow ball with no spin to the middle of the player's half. */
export const POP_UP_TARGET: Readonly<TablePoint> = Object.freeze({ x: 0, z: 0.9 });
/** Where a good Shot or Pop-up the solver can't play is moved toward, then sent with no spin. */
export const SAFE_TARGET: Readonly<TablePoint> = Object.freeze({ x: 0, z: 0.7 });
/** How far an unsolvable good Shot or Pop-up moves toward SAFE_TARGET for its one retry, m. */
const RETRY_STEP_M = 0.2;
/** Float slack on the flight-time cap. */
const FLIGHT_CAP_SLACK_S = 1e-9;

/** A corner aim: x = ±CORNER_X, z = CORNER_Z. */
const CORNER_X = 0.6;
const CORNER_Z = 1.1;
/** A non-corner aim is uniform over x ∈ ±AIM_HALF_WIDTH, z ∈ [AIM_Z_MIN, AIM_Z_MAX]. */
const AIM_HALF_WIDTH = 0.6;
const AIM_Z_MIN = 0.4;
const AIM_Z_MAX = 1.2;
/** At full earlyBias, a good Shot's target moves this far cross-court, m. */
const CROSS_COURT_PULL_M = 0.3;
/** A good Shot lands at least this far inside the table edges and the net line, so only Errors land out. */
const TABLE_MARGIN_M = 0.05;
/** Chance a good Shot carries Topspin; otherwise Backspin. */
const TOPSPIN_CHANCE = 0.75;

/** An Error lands this far (uniform, m) past the player's end line or wide of a sideline. */
const ERROR_MIN_M = 0.2;
const ERROR_MAX_M = 0.4;

/**
 * How hard an incoming ball is to return, 0..1, from the ball at its Ideal
 * Time: its speed against HARD_SPEED, its Spin against HARD_SPIN_REVS and its
 * distance from the centre line against HARD_WIDTH_M, weighted 0.5, 0.25 and
 * 0.25, each clamped.
 */
export function incomingDifficulty(incoming: Pick<Incoming, 'strike'>): number {
  const { velocity, spin, position } = incoming.strike;
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) / HARD_SPEED;
  const spinRate = Math.hypot(spin.x, spin.y, spin.z) / revsToRadPerSec(HARD_SPIN_REVS);
  const width = Math.abs(position.x) / HARD_WIDTH_M;
  return clamp01(SPEED_WEIGHT * clamp01(speed) + SPIN_WEIGHT * clamp01(spinRate) + WIDTH_WEIGHT * clamp01(width));
}

/** The mistake chance at this Difficulty against a ball of difficulty `d` (0..1). */
export function mistakeChance(params: DifficultyParams, d: number): number {
  return params.mistakeBase + params.mistakeSlope * d;
}

/**
 * `solveShot`, but a Shot that, launched, wouldn't bounce once on the player's
 * half and reach the player's end line (no Ideal Time there) counts as
 * unsolved. The brain's default solver: it checks its good Shots and Pop-ups
 * with it. Best effort is passed straight through.
 */
export const solveToPlayer = ((from: Vec3, intent: ShotIntent, opts?: Partial<SolveOptions>) => {
  const solution = solveShot(from, intent, opts);
  if (!solution || opts?.bestEffort) return solution;
  return findIdealTime(launchBall(from, solution.velocity, solution.spin), 'player') ? solution : null;
}) as ShotSolver;

/**
 * An Opponent playing at `params` (one row of DIFFICULTIES; it never changes
 * during a Match). `solve` (solveToPlayer unless a test stands one in)
 * decides whether a good Shot or Pop-up can be played.
 */
export function createBrain(params: DifficultyParams, solve: ShotSolver = solveToPlayer): Opponent {
  const p: Readonly<DifficultyParams> = Object.freeze({ ...params });
  return {
    chooseShot(incoming, random) {
      const from = contactPoint(incoming.strike.position);
      if (random() < mistakeChance(p, incomingDifficulty(incoming))) {
        if (random() < p.popUpShare) return playable(solve, from, popUp());
        // An Error isn't solved here: the core strikes it with solveReturn, which never moves its target.
        return random() < 0.5 ? 'whiff' : error(p, random);
      }
      return playable(solve, from, goodShot(p, incoming.strike.position.x, random));
    },
  };
}

function popUp(): ShotIntent {
  return { target: { ...POP_UP_TARGET }, flightTime: OPPONENT_MAX_FLIGHT_S, topspin: 0, sidespin: 0 };
}

/** Just past the player's end line or wide of a sideline (half each): only the target is off (ADR 0001). */
function error(p: DifficultyParams, random: () => number): ShotIntent {
  const long = random() < 0.5;
  const off = ERROR_MIN_M + random() * (ERROR_MAX_M - ERROR_MIN_M);
  let target: TablePoint;
  if (long) {
    target = { x: (2 * random() - 1) * AIM_HALF_WIDTH, z: PLAYER_END_Z + off };
  } else {
    const side = random() < 0.5 ? -1 : 1;
    target = { x: side * (TABLE_WIDTH / 2 + off), z: AIM_Z_MIN + random() * (AIM_Z_MAX - AIM_Z_MIN) };
  }
  return { target, flightTime: flightTime(p, random), topspin: 0, sidespin: 0 };
}

/**
 * Aim at a corner (chance cornerAim) or anywhere on the half, add Gaussian
 * scatter, pull cross-court (away from the strike's side), keep it on the
 * table; then a flight time and a Topspin or Backspin.
 */
function goodShot(p: DifficultyParams, strikeX: number, random: () => number): ShotIntent {
  let x: number;
  let z: number;
  if (random() < p.cornerAim) {
    x = random() < 0.5 ? -CORNER_X : CORNER_X;
    z = CORNER_Z;
  } else {
    x = (2 * random() - 1) * AIM_HALF_WIDTH;
    z = AIM_Z_MIN + random() * (AIM_Z_MAX - AIM_Z_MIN);
  }
  const [gx, gz] = gaussianPair(random);
  x += gx * p.scatterM - Math.sign(strikeX) * p.earlyBias * CROSS_COURT_PULL_M;
  z += gz * p.scatterM;
  const halfWidth = TABLE_WIDTH / 2 - TABLE_MARGIN_M;
  const target = { x: clamp(x, -halfWidth, halfWidth), z: clamp(z, TABLE_MARGIN_M, PLAYER_END_Z - TABLE_MARGIN_M) };
  const time = flightTime(p, random);
  const spinSign = random() < TOPSPIN_CHANCE ? 1 : -1;
  const topspin = spinSign * revsToRadPerSec(random() * p.maxSpinRevs);
  return { target, flightTime: time, topspin, sidespin: 0 };
}

function flightTime(p: DifficultyParams, random: () => number): number {
  return p.minFlightS + random() * (p.maxFlightS - p.minFlightS);
}

/**
 * The intent, if it can be played; else the same Shot moved RETRY_STEP_M
 * toward SAFE_TARGET; else SAFE_TARGET with no spin, at the same flight time.
 * A playable intent comes back with the solver's flight time (longer than
 * asked if the arc was raised to clear the net), which must stay within
 * OPPONENT_MAX_FLIGHT_S.
 */
function playable(solve: ShotSolver, from: Vec3, intent: ShotIntent): ShotIntent {
  const first = check(solve, from, intent);
  if (first) return first;
  const retry = check(solve, from, { ...intent, target: toward(intent.target, SAFE_TARGET, RETRY_STEP_M) });
  if (retry) return retry;
  return { target: { ...SAFE_TARGET }, flightTime: intent.flightTime, topspin: 0, sidespin: 0 };
}

function check(solve: ShotSolver, from: Vec3, intent: ShotIntent): ShotIntent | null {
  const solution = solve(from, intent);
  if (!solution || solution.flightTime > OPPONENT_MAX_FLIGHT_S + FLIGHT_CAP_SLACK_S) return null;
  return { ...intent, flightTime: solution.flightTime };
}

/** `from` moved `step` m toward `to`, stopping at it. */
function toward(from: TablePoint, to: TablePoint, step: number): TablePoint {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= step) return { ...to };
  return { x: from.x + (dx / distance) * step, z: from.z + (dz / distance) * step };
}

/** Two independent standard normal draws (Box–Muller) from two uniform draws. */
function gaussianPair(random: () => number): [number, number] {
  const radius = Math.sqrt(-2 * Math.log(1 - random()));
  const angle = 2 * Math.PI * random();
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
