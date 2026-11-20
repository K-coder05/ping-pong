import { describe, expect, it } from 'vitest';
import { revsToRadPerSec, spinVector } from '../physics/spin.ts';
import { makeRng } from '../util/rng.ts';
import { launchBall, simulate, type BallState, type Vec3 } from './ball.ts';
import {
  ARC_RAISE_FACTOR,
  BALL_RADIUS,
  FEEDER_MOUTH,
  GRAVITY,
  NET_CLEARANCE,
  NET_HEIGHT,
  PHYSICS_DT,
  PLAYER_END_Z,
  TABLE_HALF_LENGTH,
  TABLE_TOP_Y,
  TABLE_WIDTH,
} from './constants.ts';
import { solveShot, type ShotIntent, type ShotSolution, type TablePoint } from './solver.ts';

/** Ball centre height when its bottom touches the table top: where a landing is measured. */
const LANDING_Y = TABLE_TOP_Y + BALL_RADIUS;
const NET_TOP_Y = TABLE_TOP_Y + NET_HEIGHT;

interface Flight {
  /** Where the ball first lands: its first table bounce, or where its centre comes down through table-contact height off the table. */
  landing: Vec3;
  /** Simulated seconds from launch to that landing, interpolated within the substep. */
  time: number;
  /** Whether that landing was a bounce on the table. */
  bounced: boolean;
  /** Height of the ball's bottom above the net top as its centre crossed z = 0 before landing; null if it never crossed. */
  netClearance: number | null;
}

/** Fly a launch with the real integrator (seed 0) up to its first landing, measured independently of the solver. */
function fly(from: Vec3, velocity: Vec3, spin: Vec3 = { x: 0, y: 0, z: 0 }): Flight {
  let previous: BallState = launchBall(from, velocity, spin);
  let netClearance: number | null = null;
  let flight: Flight | null = null;
  simulate(previous, {
    maxTime: 5,
    until: (state, time, events) => {
      const before = previous;
      previous = state;
      const a = before.position;
      const b = state.position;
      if (netClearance === null && Math.sign(a.z) !== Math.sign(b.z) && a.z !== 0) {
        const f = a.z / (a.z - b.z);
        netClearance = a.y + f * (b.y - a.y) - BALL_RADIUS - NET_TOP_Y;
      }
      const bounce = events.find((e) => e.type === 'bounce');
      if (!bounce && !(state.velocity.y < 0 && b.y <= LANDING_Y)) return false;
      // Fraction of the substep at which the centre came down through LANDING_Y.
      const vy = before.velocity.y + GRAVITY * PHYSICS_DT;
      const f = Math.min(1, Math.max(0, (a.y - LANDING_Y) / (-vy * PHYSICS_DT)));
      const landing = bounce ? { ...bounce.position } : { x: a.x + (b.x - a.x) * f, y: LANDING_Y, z: a.z + (b.z - a.z) * f };
      flight = { landing, time: time - (1 - f) * PHYSICS_DT, bounced: bounce !== undefined, netClearance };
      return true;
    },
  });
  if (!flight) throw new Error('the ball never landed');
  return flight;
}

const flyShot = (from: Vec3, s: ShotSolution) => fly(from, s.velocity, s.spin);
const miss = (flight: Flight, target: TablePoint) => Math.hypot(flight.landing.x - target.x, flight.landing.z - target.z);
const flat = (target: TablePoint, flightTime: number): ShotIntent => ({ target, flightTime, topspin: 0, sidespin: 0 });

// ---------------------------------------------------------------------------
// Golden values: the old `solveLaunch(from, target, T)` on these zero-spin
// intents, measured with `fly` before Solver v2 replaced it. Each row: the
// launch, the intent, and where the old solution landed and when.
// ---------------------------------------------------------------------------

interface Golden {
  label: string;
  from: Vec3;
  target: TablePoint;
  flightTime: number;
  oldLanding: TablePoint;
  oldTime: number;
}

const golden: Golden[] = [
  { label: 'Feed to the centre', from: FEEDER_MOUTH, target: { x: 0, z: 0.75 }, flightTime: 1, oldLanding: { x: 0, z: 0.7493 }, oldTime: 0.9268 },
  { label: 'Feed short left', from: FEEDER_MOUTH, target: { x: -0.3, z: 0.6 }, flightTime: 1, oldLanding: { x: -0.2999, z: 0.5995 }, oldTime: 0.9284 },
  { label: 'Feed deep right', from: FEEDER_MOUTH, target: { x: 0.4, z: 0.8 }, flightTime: 1, oldLanding: { x: 0.3998, z: 0.7992 }, oldTime: 0.9257 },
  { label: 'Feed after a speed-up', from: FEEDER_MOUTH, target: { x: 0.5, z: 1 }, flightTime: 0.9025, oldLanding: { x: 0.4999, z: 0.9996 }, oldTime: 0.8417 },
  { label: 'fast Feed, short corner', from: FEEDER_MOUTH, target: { x: -0.5, z: 0.5 }, flightTime: 0.4, oldLanding: { x: -0.4998, z: 0.4992 }, oldTime: 0.397 },
  { label: 'slow Feed', from: FEEDER_MOUTH, target: { x: 0.3, z: 0.5 }, flightTime: 1.1, oldLanding: { x: 0.2999, z: 0.4996 }, oldTime: 1.0099 },
  { label: 'fast deep Feed', from: FEEDER_MOUTH, target: { x: 0, z: 1 }, flightTime: 0.4, oldLanding: { x: 0, z: 0.9993 }, oldTime: 0.3968 },
  { label: 'hard Return', from: { x: 0.3, y: TABLE_TOP_Y + 0.2, z: 1.5 }, target: { x: -0.5, z: -1.1 }, flightTime: 0.55, oldLanding: { x: -0.4999, z: -1.0995 }, oldTime: 0.5218 },
  { label: 'late Return from table height', from: { x: -0.2, y: LANDING_Y, z: 1.6 }, target: { x: 0.3, z: -0.9 }, flightTime: 0.8, oldLanding: { x: 0.2998, z: -0.8992 }, oldTime: 0.7289 },
  { label: 'soft Return', from: { x: 0, y: TABLE_TOP_Y + 0.25, z: 1.4 }, target: { x: 0, z: -0.6 }, flightTime: 1, oldLanding: { x: 0, z: -0.5994 }, oldTime: 0.9246 },
  { label: 'hard Return to the corner', from: { x: 0.4, y: TABLE_TOP_Y + 0.1, z: 1.45 }, target: { x: 0.6, z: -1.2 }, flightTime: 0.55, oldLanding: { x: 0.6, z: -1.1994 }, oldTime: 0.5128 },
  { label: 'Return pushed long (a deliberate miss)', from: { x: 0, y: TABLE_TOP_Y + 0.25, z: 1.45 }, target: { x: -0.2, z: -1.6 }, flightTime: 0.55, oldLanding: { x: -0.1995, z: -1.5922 }, oldTime: 0.5235 },
  { label: 'low fast Return (arc raised)', from: { x: 0, y: TABLE_TOP_Y + 0.05, z: 1.5 }, target: { x: 0.2, z: -0.7 }, flightTime: 0.4, oldLanding: { x: 0.1999, z: -0.6994 }, oldTime: 0.4529 },
];

describe('solveShot: zero-spin golden values from the old solver', () => {
  it.each(golden)('$label lands where it used to, and no further from the asked flight time', (g) => {
    const solution = solveShot(g.from, flat(g.target, g.flightTime));
    expect(solution).not.toBeNull();
    const flight = flyShot(g.from, solution!);
    expect(miss(flight, g.oldLanding)).toBeLessThan(0.01);
    expect(Math.abs(flight.time - g.flightTime)).toBeLessThanOrEqual(Math.abs(g.oldTime - g.flightTime));
  });
});

describe('solveShot', () => {
  it('lands a zero-spin Feed on its target in the asked flight time, despite drag', () => {
    const target = { x: 0.4, z: 0.8 };
    const solution = solveShot(FEEDER_MOUTH, flat(target, 1.0))!;
    const flight = flyShot(FEEDER_MOUTH, solution);
    expect(miss(flight, target)).toBeLessThan(0.01);
    expect(Math.abs(flight.time - 1.0)).toBeLessThan(0.01);
    expect(solution.flightTime).toBe(1.0);
    expect(solution.spin).toEqual({ x: 0, y: 0, z: 0 });
    expect(solution.passes).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['Topspin', 50, 0],
    ['Backspin', -50, 0],
    ['Sidespin', 0, 20],
    ['Topspin and Sidespin', 30, -15],
  ])('lands a Return with %s on its target and clears the net', (_label, topRevs, sideRevs) => {
    const from = { x: 0.2, y: TABLE_TOP_Y + 0.3, z: 1.5 };
    const target = { x: -0.4, z: -0.9 };
    const solution = solveShot(from, { target, flightTime: 0.8, topspin: revsToRadPerSec(topRevs), sidespin: revsToRadPerSec(sideRevs) })!;
    expect(solution).not.toBeNull();
    const flight = flyShot(from, solution);
    expect(miss(flight, target)).toBeLessThan(0.02);
    expect(flight.bounced).toBe(true);
    expect(flight.netClearance!).toBeGreaterThanOrEqual(NET_CLEARANCE);
  });

  it('launches with the spin vector of the intent, about the Shot’s horizontal direction', () => {
    const from = { x: 0, y: TABLE_TOP_Y + 0.3, z: 1.4 };
    const target = { x: 0.6, z: -0.8 };
    const intent = { target, flightTime: 0.8, topspin: 100, sidespin: -40 };
    const solution = solveShot(from, intent)!;
    const d = { x: target.x - from.x, y: 0, z: target.z - from.z };
    const n = Math.hypot(d.x, d.z);
    const expected = spinVector(100, -40, { x: d.x / n, y: 0, z: d.z / n });
    expect(solution.spin.x).toBeCloseTo(expected.x, 9);
    expect(solution.spin.y).toBeCloseTo(expected.y, 9);
    expect(solution.spin.z).toBeCloseTo(expected.z, 9);
    // Topspin toward −z points along −x (more or less, for this diagonal Shot).
    expect(solution.spin.x).toBeLessThan(0);
  });

  it('raises the arc (longer flight time) when the asked-for Shot would not clear the net by the margin', () => {
    // Low and fast: in 0.3 s from just above the table, the straight solution skims into the net.
    const low = { x: 0, y: TABLE_TOP_Y + 0.05, z: -1.2 };
    const target = { x: 0.2, z: 0.7 };
    const solution = solveShot(low, flat(target, 0.3))!;
    expect(solution).not.toBeNull();
    expect(solution.flightTime).toBeGreaterThan(0.3);
    const raises = Math.round(Math.log(solution.flightTime / 0.3) / Math.log(ARC_RAISE_FACTOR));
    expect(solution.flightTime).toBeCloseTo(0.3 * ARC_RAISE_FACTOR ** raises, 9);
    const flight = flyShot(low, solution);
    expect(flight.netClearance!).toBeGreaterThanOrEqual(NET_CLEARANCE);
    expect(miss(flight, target)).toBeLessThan(0.02);
  });

  it('keeps the asked-for flight time when the Shot already clears the net', () => {
    const solution = solveShot(FEEDER_MOUTH, flat({ x: 0, z: 0.6 }, 1.0))!;
    expect(solution.flightTime).toBe(1.0);
    expect(flyShot(FEEDER_MOUTH, solution).netClearance!).toBeGreaterThanOrEqual(NET_CLEARANCE);
  });

  it('fails (null) when the net cannot be cleared within the allowed raises, or returns the last attempt when asked for best effort', () => {
    const low = { x: 0, y: TABLE_TOP_Y + 0.05, z: -1.2 };
    const intent = flat({ x: 0.2, z: 0.7 }, 0.3);
    expect(solveShot(low, intent, { maxRaises: 0 })).toBeNull();

    const last = solveShot(low, intent, { maxRaises: 0, bestEffort: true })!;
    expect(last).not.toBeNull();
    expect(last.flightTime).toBe(0.3);
    expect(last.passes).toBeGreaterThanOrEqual(1);
    expect(last.passes).toBeLessThanOrEqual(4);
  });

  it('fails (null) for a target it cannot reach in the passes allowed, with no raise to blame', () => {
    // One pass is just the drag-free guess: it clears the net easily but drag makes it land half a metre short.
    const intent = flat({ x: 0.4, z: 0.8 }, 1.0);
    expect(solveShot(FEEDER_MOUTH, intent, { maxPasses: 1 })).toBeNull();
    const last = solveShot(FEEDER_MOUTH, intent, { maxPasses: 1, bestEffort: true })!;
    expect(last.passes).toBe(1);
    expect(last.flightTime).toBe(1.0);
    const flight = flyShot(FEEDER_MOUTH, last);
    expect(miss(flight, intent.target)).toBeGreaterThan(0.1);
    expect(flight.netClearance!).toBeGreaterThan(NET_CLEARANCE);
  });

  it('demands a larger margin when asked', () => {
    const from = { x: 0, y: TABLE_TOP_Y + 0.2, z: 1.5 };
    const intent = flat({ x: 0, z: -1.0 }, 0.5);
    const solution = solveShot(from, intent, { netMargin: 0.2 })!;
    expect(solution).not.toBeNull();
    expect(flyShot(from, solution).netClearance!).toBeGreaterThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------------------
// Seeded property test (spec P1-c "Done"): every result is null or lands
// within 2 cm and clears the net by the margin; at most 5% null; mean passes ≤ 4.
// ---------------------------------------------------------------------------

const INTENTS_PER_DIRECTION = 1000;
/** Targets stay at least this far inside the edges of the far half (including the net). */
const EDGE_GAP = 0.1;

function uniform(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/** A random intent onto the far half, with spin, as the property test draws it. */
function randomIntent(random: () => number, towardFeeder: boolean): ShotIntent {
  const x = uniform(random, -(TABLE_WIDTH / 2 - EDGE_GAP), TABLE_WIDTH / 2 - EDGE_GAP);
  const depth = uniform(random, EDGE_GAP, TABLE_HALF_LENGTH - EDGE_GAP);
  return {
    target: { x, z: towardFeeder ? -depth : depth },
    flightTime: uniform(random, 0.5, 1.2),
    topspin: revsToRadPerSec(uniform(random, -50, 50)),
    sidespin: revsToRadPerSec(uniform(random, -20, 20)),
  };
}

/**
 * Where the player strikes a Return: around the player's end, 0.2–0.6 m above
 * the table, or (one in five) a late Return from 0.1 m below table height,
 * past the end.
 */
function randomContact(random: () => number): Vec3 {
  const x = uniform(random, -0.6, 0.6);
  if (random() < 0.2) return { x, y: TABLE_TOP_Y - 0.1, z: uniform(random, PLAYER_END_Z + 0.1, PLAYER_END_Z + 0.5) };
  return { x, y: TABLE_TOP_Y + uniform(random, 0.2, 0.6), z: uniform(random, PLAYER_END_Z - 0.1, PLAYER_END_Z + 0.4) };
}

describe.each([
  ['player → Feeder (Returns)', true],
  ['Feeder → player (Feeds)', false],
])('solveShot property test, %s', (label, towardFeeder) => {
  it(`${INTENTS_PER_DIRECTION} seeded intents with spin: each lands within 2 cm and clears the net, or is null; ≤ 5% null; mean passes ≤ 4`, () => {
    const random = makeRng(towardFeeder ? 18 : 81);
    let nulls = 0;
    let passes = 0;
    let solved = 0;
    const started = performance.now();
    for (let i = 0; i < INTENTS_PER_DIRECTION; i++) {
      const from = towardFeeder ? randomContact(random) : { ...FEEDER_MOUTH };
      const intent = randomIntent(random, towardFeeder);
      const solution = solveShot(from, intent);
      if (!solution) {
        nulls++;
        continue;
      }
      solved++;
      passes += solution.passes;
      const flight = flyShot(from, solution);
      const where = `intent ${i}: ${JSON.stringify({ from, intent })}`;
      expect(miss(flight, intent.target), where).toBeLessThanOrEqual(0.02);
      expect(flight.bounced, where).toBe(true);
      expect(flight.netClearance, where).not.toBeNull();
      expect(flight.netClearance!, where).toBeGreaterThanOrEqual(NET_CLEARANCE);
    }
    const nullRate = nulls / INTENTS_PER_DIRECTION;
    const meanPasses = passes / solved;
    console.info(`[solver property] ${label}: null ${(100 * nullRate).toFixed(1)}%, mean passes ${meanPasses.toFixed(2)}, ${Math.round(performance.now() - started)} ms`);
    expect(nullRate).toBeLessThanOrEqual(0.05);
    expect(meanPasses).toBeLessThanOrEqual(4);
  });
});

describe('solveShot: deliberate misses', () => {
  /** A target off the far half: past its end line, or past a side line. */
  function randomMissTarget(random: () => number, towardFeeder: boolean): TablePoint {
    const sign = towardFeeder ? -1 : 1;
    if (random() < 0.5) {
      // Long: past the end line.
      return { x: uniform(random, -0.6, 0.6), z: sign * uniform(random, TABLE_HALF_LENGTH + 0.05, TABLE_HALF_LENGTH + 0.4) };
    }
    // Wide: past a side line.
    const side = random() < 0.5 ? -1 : 1;
    return { x: side * uniform(random, TABLE_WIDTH / 2 + 0.05, TABLE_WIDTH / 2 + 0.4), z: sign * uniform(random, 0.3, TABLE_HALF_LENGTH) };
  }

  it.each([
    ['Returns', true],
    ['Feeds', false],
  ])('%s aimed past the end or side line pass table height within 2 cm of the target and never bounce on the table, or are null', (_label, towardFeeder) => {
    const random = makeRng(towardFeeder ? 404 : 405);
    let solved = 0;
    for (let i = 0; i < 200; i++) {
      const from = towardFeeder ? randomContact(random) : { ...FEEDER_MOUTH };
      const intent: ShotIntent = {
        target: randomMissTarget(random, towardFeeder),
        flightTime: uniform(random, 0.5, 1.2),
        topspin: revsToRadPerSec(uniform(random, -50, 50)),
        sidespin: revsToRadPerSec(uniform(random, -20, 20)),
      };
      const solution = solveShot(from, intent);
      if (!solution) continue;
      solved++;
      const flight = flyShot(from, solution);
      const where = `miss ${i}: ${JSON.stringify({ from, intent })}`;
      expect(flight.bounced, where).toBe(false);
      expect(miss(flight, intent.target), where).toBeLessThanOrEqual(0.02);
    }
    // The misses are real solutions, not all null.
    expect(solved).toBeGreaterThan(150);
  });
});
