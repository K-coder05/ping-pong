import { describe, expect, it } from 'vitest';
import { launchBall, simulate, type BallEvent, type BallState } from '../game/ball.ts';
import { OPPONENT_END_Z, PLAYER_END_Z, TABLE_WIDTH } from '../game/constants.ts';
import type { Incoming } from '../game/rally.ts';
import { contactPoint, solveReturn } from '../game/shotResolver.ts';
import { solveShot, type ShotIntent, type ShotSolver, type SolveOptions } from '../game/solver.ts';
import type { Vec3 } from '../physics/vec3.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { makeRng } from '../util/rng.ts';
import { createBrain, incomingDifficulty, mistakeChance, POP_UP_TARGET, SAFE_TARGET, solveToPlayer } from './brain.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER, OPPONENT_MAX_FLIGHT_S, type Difficulty, type DifficultyParams } from './difficulty.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An Incoming toward the Opponent whose ball at the Ideal Time is `strike`; the brain reads only the strike. */
function incomingAt(strike: BallState): Incoming {
  return { receiver: 'opponent', ball: strike, launchedAtMs: 0, ideal: { simSeconds: 1, position: strike.position }, idealAtMs: 1250, strike, shotIndex: 1 };
}

/**
 * A synthetic incoming ball at the Opponent's end line, spread from easy to
 * hard: slow to faster than HARD_SPEED, no Spin to more than HARD_SPIN_REVS,
 * centre to wider than HARD_WIDTH_M.
 */
function syntheticIncoming(random: () => number, x = (2 * random() - 1) * 0.9): Incoming {
  const speed = 1 + random() * 13;
  const spinRevs = random() * 60;
  const position = { x, y: 0.8 + random() * 0.25, z: OPPONENT_END_Z };
  return incomingAt(launchBall(position, { x: 0, y: -0.2 * speed, z: -0.98 * speed }, { x: revsToRadPerSec(spinRevs), y: 0, z: 0 }));
}

/** A stand-in solver that solves anything at the asked flight time, without simulating. */
const alwaysSolves = ((_from: Vec3, intent: ShotIntent) => ({ velocity: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, flightTime: intent.flightTime, passes: 1 })) as ShotSolver;

/** A stand-in solver that records each intent and answers with `answer(call number, intent)`. */
function recordingSolver(answer: (call: number, intent: ShotIntent) => number | null) {
  const intents: ShotIntent[] = [];
  const solve = ((_from: Vec3, intent: ShotIntent, opts?: Partial<SolveOptions>) => {
    intents.push(intent);
    const flightTime = opts?.bestEffort ? intent.flightTime : answer(intents.length, intent);
    return flightTime === null ? null : { velocity: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, flightTime, passes: 1 };
  }) as ShotSolver;
  return { solve, intents };
}

type Kind = 'good' | 'pop-up' | 'error' | 'whiff';

const offTable = (t: { x: number; z: number }) => Math.abs(t.x) > TABLE_WIDTH / 2 || t.z > PLAYER_END_Z || t.z < 0;

/** What the brain chose. Only exact with a solver that never fails (no retries, no fallbacks). */
function kindOf(choice: ShotIntent | 'whiff'): Kind {
  if (choice === 'whiff') return 'whiff';
  if (offTable(choice.target)) return 'error';
  const { target, flightTime, topspin } = choice;
  return target.x === POP_UP_TARGET.x && target.z === POP_UP_TARGET.z && flightTime === OPPONENT_MAX_FLIGHT_S && topspin === 0 ? 'pop-up' : 'good';
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

const SAMPLES = 10_000;

interface Sample {
  incoming: Incoming;
  choice: ShotIntent | 'whiff';
  kind: Kind;
}

/** 10,000 synthetic Incomings at one Difficulty, with a solver that never fails. Memoised: several tests read them. */
const sampled = new Map<Difficulty, { samples: Sample[]; expectedMistakeRate: number }>();
function sampleChoices(name: Difficulty) {
  const cached = sampled.get(name);
  if (cached) return cached;
  const params = DIFFICULTIES[name];
  const brain = createBrain(params, alwaysSolves);
  const balls = makeRng(1000);
  const random = makeRng(3);
  const samples: Sample[] = [];
  let chance = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const incoming = syntheticIncoming(balls);
    chance += mistakeChance(params, incomingDifficulty(incoming));
    const choice = brain.chooseShot(incoming, random);
    samples.push({ incoming, choice, kind: kindOf(choice) });
  }
  const result = { samples, expectedMistakeRate: chance / SAMPLES };
  sampled.set(name, result);
  return result;
}

const intents = (samples: Sample[], kind?: Kind) =>
  samples.filter((s) => (kind ? s.kind === kind : s.kind !== 'whiff')).map((s) => s.choice as ShotIntent);

// ---------------------------------------------------------------------------
// Incoming difficulty
// ---------------------------------------------------------------------------

describe('incomingDifficulty', () => {
  const strikeOf = (x: number, speed: number, spinRevs: number) =>
    incomingAt(launchBall({ x, y: 0.9, z: OPPONENT_END_Z }, { x: 0, y: 0, z: -speed }, { x: revsToRadPerSec(spinRevs), y: 0, z: 0 }));

  it('weighs speed against 12 m/s by 0.5, Spin against 50 rev/s by 0.25, width against 0.76 m by 0.25', () => {
    expect(incomingDifficulty(strikeOf(0, 0, 0))).toBe(0);
    expect(incomingDifficulty(strikeOf(0, 6, 0))).toBeCloseTo(0.25, 12);
    expect(incomingDifficulty(strikeOf(0, 0, 25))).toBeCloseTo(0.125, 12);
    expect(incomingDifficulty(strikeOf(-0.38, 0, 0))).toBeCloseTo(0.125, 12);
    expect(incomingDifficulty(strikeOf(0.38, 6, 25))).toBeCloseTo(0.5, 12);
    expect(incomingDifficulty(strikeOf(0.76, 12, 50))).toBeCloseTo(1, 12);
  });

  it('clamps each part, so nothing is harder than 1', () => {
    expect(incomingDifficulty(strikeOf(0, 30, 0))).toBeCloseTo(0.5, 12);
    expect(incomingDifficulty(strikeOf(2, 30, 200))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Choices over 10,000 synthetic Incomings per Difficulty
// ---------------------------------------------------------------------------

describe.each(DIFFICULTY_ORDER)('createBrain at %s, over 10,000 synthetic Incomings', (name) => {
  const params = DIFFICULTIES[name];

  it('spreads the Incomings from easy to hard', () => {
    const ds = sampleChoices(name).samples.map((s) => incomingDifficulty(s.incoming));
    expect(Math.min(...ds)).toBeLessThan(0.1);
    expect(Math.max(...ds)).toBeGreaterThan(0.9);
  });

  it('makes mistakes within ±2 points of mistakeBase + mistakeSlope · d, and Pop-ups within ±3 points of popUpShare', () => {
    const { samples, expectedMistakeRate } = sampleChoices(name);
    const mistakes = samples.filter((s) => s.kind !== 'good');
    expect(Math.abs(mistakes.length / SAMPLES - expectedMistakeRate)).toBeLessThan(0.02);
    const popUps = mistakes.filter((s) => s.kind === 'pop-up').length;
    expect(Math.abs(popUps / mistakes.length - params.popUpShare)).toBeLessThan(0.03);
    // The rest split evenly into Errors and Whiffs.
    const whiffs = mistakes.filter((s) => s.kind === 'whiff').length;
    const errors = mistakes.filter((s) => s.kind === 'error').length;
    expect(whiffs + errors + popUps).toBe(mistakes.length);
    expect(Math.abs(whiffs / (whiffs + errors) - 0.5)).toBeLessThan(0.06);
  });

  it('makes more mistakes against harder balls', () => {
    const { samples } = sampleChoices(name);
    const rate = (lo: number, hi: number) => {
      const band = samples.filter((s) => incomingDifficulty(s.incoming) >= lo && incomingDifficulty(s.incoming) < hi);
      return band.filter((s) => s.kind !== 'good').length / band.length;
    };
    expect(rate(0.6, 1.01)).toBeGreaterThan(rate(0, 0.4));
  });

  it('plays good Shots on the table with a 5 cm margin, flights in [minFlightS, maxFlightS], Topspin 3 in 4, Spin up to maxSpinRevs', () => {
    const good = intents(sampleChoices(name).samples, 'good');
    const margin = 0.05 - 1e-12;
    for (const { target, flightTime, topspin, sidespin } of good) {
      expect(Math.abs(target.x)).toBeLessThanOrEqual(TABLE_WIDTH / 2 - margin);
      expect(target.z).toBeGreaterThanOrEqual(margin);
      expect(target.z).toBeLessThanOrEqual(PLAYER_END_Z - margin);
      expect(flightTime).toBeGreaterThanOrEqual(params.minFlightS);
      expect(flightTime).toBeLessThanOrEqual(params.maxFlightS);
      expect(Math.abs(topspin)).toBeLessThanOrEqual(revsToRadPerSec(params.maxSpinRevs));
      expect(sidespin).toBe(0);
    }
    const topspinShare = good.filter((g) => g.topspin > 0).length / good.length;
    expect(Math.abs(topspinShare - 0.75)).toBeLessThan(0.03);
  });

  it('plays Pop-ups to (0, 0.9 m) at the 1.1 s cap with no spin', () => {
    const popUps = intents(sampleChoices(name).samples, 'pop-up');
    expect(popUps.length).toBeGreaterThan(50);
    for (const p of popUps) expect(p).toEqual({ target: { x: 0, z: 0.9 }, flightTime: 1.1, topspin: 0, sidespin: 0 });
  });

  it('plays Errors 0.2–0.4 m past the end line or wide of a sideline, half each, flights in range', () => {
    const errors = intents(sampleChoices(name).samples, 'error');
    expect(errors.length).toBeGreaterThan(50);
    let long = 0;
    for (const { target, flightTime, topspin } of errors) {
      if (target.z > PLAYER_END_Z) {
        long++;
        expect(target.z - PLAYER_END_Z).toBeGreaterThanOrEqual(0.2);
        expect(target.z - PLAYER_END_Z).toBeLessThanOrEqual(0.4);
        expect(Math.abs(target.x)).toBeLessThanOrEqual(0.6);
      } else {
        const wide = Math.abs(target.x) - TABLE_WIDTH / 2;
        expect(wide).toBeGreaterThanOrEqual(0.2);
        expect(wide).toBeLessThanOrEqual(0.4);
        expect(target.z).toBeGreaterThan(0);
      }
      expect(flightTime).toBeGreaterThanOrEqual(params.minFlightS);
      expect(flightTime).toBeLessThanOrEqual(params.maxFlightS);
      expect(topspin).toBe(0);
    }
    expect(Math.abs(long / errors.length - 0.5)).toBeLessThan(0.1);
  });

  it('pulls good Shots cross-court, away from the strike\'s side', () => {
    // The same draws struck from either side: only the pull's direction differs.
    const meanX = (strikeX: number) => {
      const brain = createBrain(params, alwaysSolves);
      const random = makeRng(7);
      const balls = makeRng(8);
      const xs = Array.from({ length: 2000 }, () => brain.chooseShot(syntheticIncoming(balls, strikeX), random))
        .filter((c) => kindOf(c) === 'good')
        .map((c) => (c as ShotIntent).target.x);
      return mean(xs);
    };
    const pull = params.earlyBias * 0.3;
    // Clamping to the table trims the pull a little at the far sideline.
    expect(meanX(-0.5) - meanX(0.5)).toBeGreaterThan(2 * 0.8 * pull);
    expect(meanX(-0.5) - meanX(0.5)).toBeLessThanOrEqual(2 * pull + 1e-12);
    expect(meanX(0.5)).toBeLessThan(0);
  });
});

describe('createBrain: Difficulties ordered Novice > Intermediate > Expert', () => {
  it('in average flight time', () => {
    const flights = DIFFICULTY_ORDER.map((name) => mean(intents(sampleChoices(name).samples).map((i) => i.flightTime)));
    expect(flights[0]).toBeGreaterThan(flights[1]!);
    expect(flights[1]).toBeGreaterThan(flights[2]!);
  });

  it('in target scatter around the aim', () => {
    // Every good Shot aimed at a corner, struck from the centre line (no cross-court pull): the spread is the scatter.
    const scatter = DIFFICULTY_ORDER.map((name) => {
      const brain = createBrain({ ...DIFFICULTIES[name], cornerAim: 1 }, alwaysSolves);
      const random = makeRng(11);
      const balls = makeRng(12);
      const misses = Array.from({ length: 3000 }, () => brain.chooseShot(syntheticIncoming(balls, 0), random))
        .filter((c) => kindOf(c) === 'good')
        .map((c) => {
          const { x, z } = (c as ShotIntent).target;
          return { dx: Math.abs(x) - 0.6, dz: z - 1.1 };
        });
      return { distance: mean(misses.map((m) => Math.hypot(m.dx, m.dz))), sdZ: sd(misses.map((m) => m.dz)) };
    });
    expect(scatter[0]!.distance).toBeGreaterThan(scatter[1]!.distance);
    expect(scatter[1]!.distance).toBeGreaterThan(scatter[2]!.distance);
    // Expert's corners are rarely clamped: its spread is scatterM itself.
    expect(scatter[2]!.sdZ).toBeCloseTo(DIFFICULTIES.expert.scatterM, 2);
  });
});

// ---------------------------------------------------------------------------
// Solving, retries and fallbacks
// ---------------------------------------------------------------------------

describe('createBrain: solving', () => {
  const alwaysGood: DifficultyParams = { ...DIFFICULTIES.intermediate, mistakeBase: 0, mistakeSlope: 0 };
  const alwaysPopUp: DifficultyParams = { ...DIFFICULTIES.intermediate, mistakeBase: 1, mistakeSlope: 0, popUpShare: 1 };
  const alwaysMistake: DifficultyParams = { ...DIFFICULTIES.intermediate, mistakeBase: 1, mistakeSlope: 0, popUpShare: 0 };
  const choose = (params: DifficultyParams, solve: ShotSolver, seed = 1) => createBrain(params, solve).chooseShot(syntheticIncoming(makeRng(seed)), makeRng(seed));

  it('a good Shot that solves is played as drawn', () => {
    const { solve, intents: asked } = recordingSolver((_, i) => i.flightTime);
    const choice = choose(alwaysGood, solve);
    expect(asked).toHaveLength(1);
    expect(choice).toEqual(asked[0]);
  });

  it('a good Shot with no solution retries once 0.2 m closer to (0, 0.7), same flight and spin', () => {
    const { solve, intents: asked } = recordingSolver((call, i) => (call === 1 ? null : i.flightTime));
    const choice = choose(alwaysGood, solve, 3);
    expect(asked).toHaveLength(2);
    const [first, retry] = asked as [ShotIntent, ShotIntent];
    const toSafe = (t: { x: number; z: number }) => Math.hypot(t.x - SAFE_TARGET.x, t.z - SAFE_TARGET.z);
    expect(toSafe(first.target)).toBeGreaterThan(0.2);
    expect(toSafe(retry.target)).toBeCloseTo(toSafe(first.target) - 0.2, 12);
    // Along the straight line to (0, 0.7).
    expect(Math.hypot(retry.target.x - first.target.x, retry.target.z - first.target.z)).toBeCloseTo(0.2, 12);
    expect(retry).toMatchObject({ flightTime: first.flightTime, topspin: first.topspin, sidespin: 0 });
    expect(choice).toEqual(retry);
  });

  it('then falls back to (0, 0.7) with no spin at the drawn flight time', () => {
    const { solve, intents: asked } = recordingSolver(() => null);
    const choice = choose(alwaysGood, solve, 4);
    expect(asked).toHaveLength(2);
    expect(choice).toEqual({ target: { x: 0, z: 0.7 }, flightTime: asked[0]!.flightTime, topspin: 0, sidespin: 0 });
  });

  it('a Pop-up with no solution falls back the same way', () => {
    const { solve, intents: asked } = recordingSolver(() => null);
    const choice = choose(alwaysPopUp, solve);
    expect(asked[0]).toEqual({ target: { x: 0, z: 0.9 }, flightTime: 1.1, topspin: 0, sidespin: 0 });
    expect(asked[1]!.target).toEqual({ x: 0, z: 0.7 });
    expect(choice).toEqual({ target: { x: 0, z: 0.7 }, flightTime: 1.1, topspin: 0, sidespin: 0 });
  });

  it('plays the solver\'s raised flight time, but never one above the 1.1 s cap', () => {
    const raised = recordingSolver((_, i) => i.flightTime * 1.05);
    const choice = choose({ ...alwaysGood, minFlightS: 0.5, maxFlightS: 0.6 }, raised.solve);
    expect(choice).toMatchObject({ flightTime: raised.intents[0]!.flightTime * 1.05 });

    const tooSlow = recordingSolver((call, i) => (call === 1 ? OPPONENT_MAX_FLIGHT_S + 0.01 : i.flightTime));
    const retried = choose(alwaysGood, tooSlow.solve);
    expect(tooSlow.intents).toHaveLength(2);
    expect(retried).toEqual(tooSlow.intents[1]);
  });

  it('never solves an Error or a Whiff: the core strikes an Error with solveReturn, so its target never moves', () => {
    const { solve, intents: asked } = recordingSolver(() => null);
    const brain = createBrain(alwaysMistake, solve);
    const random = makeRng(5);
    const balls = makeRng(6);
    const kinds = Array.from({ length: 200 }, () => kindOf(brain.chooseShot(syntheticIncoming(balls), random)));
    expect(new Set(kinds)).toEqual(new Set(['error', 'whiff']));
    expect(asked).toEqual([]);
  });

  it('solveToPlayer is solveShot, but a Shot that never reaches the player\'s end line is unsolved', () => {
    const from = { x: 0.2, y: 0.9, z: OPPONENT_END_Z };
    const onTable: ShotIntent = { target: { x: 0.3, z: 0.8 }, flightTime: 0.9, topspin: 50, sidespin: 0 };
    expect(solveToPlayer(from, onTable)).toEqual(solveShot(from, onTable));
    const long: ShotIntent = { ...onTable, target: { x: 0, z: PLAYER_END_Z + 0.3 } };
    expect(solveShot(from, long)).not.toBeNull();
    expect(solveToPlayer(from, long)).toBeNull();
    expect(solveToPlayer(from, long, { bestEffort: true })).toEqual(solveShot(from, long, { bestEffort: true }));
  });
});

// ---------------------------------------------------------------------------
// Real flights (sampled: each choice is solved and simulated)
// ---------------------------------------------------------------------------

/**
 * How the struck ball flies, struck like the core does (`solveReturn`): its
 * events until it stops being live, or, if `toEndLine`, until it crosses the
 * player's end line live.
 */
function flyStruck(from: Vec3, choice: ShotIntent, toEndLine: boolean) {
  const solution = solveReturn(solveShot, from, choice);
  const events: BallEvent[] = [];
  let crossedLive = false;
  simulate(launchBall(from, solution.velocity, solution.spin), {
    maxTime: 4,
    until: (state, _time, stepEvents) => {
      events.push(...stepEvents);
      if (state.status !== 'live') return true;
      crossedLive = state.position.z > PLAYER_END_Z;
      return toEndLine && crossedLive;
    },
  });
  return { events, crossedLive };
}

describe.each(DIFFICULTY_ORDER)('createBrain at %s, real flights (sampled)', (name) => {
  /** Sampled, not 10,000: every choice is solved and simulated. Half the samples force a mistake, for enough Pop-ups and Errors. */
  const SAMPLED = 150;

  it('every good Shot and Pop-up is solvable and bounces exactly once on the player\'s half before its end line; every Error lands off the table', () => {
    const balls = makeRng(31);
    const random = makeRng(32);
    const brains = [createBrain(DIFFICULTIES[name]), createBrain({ ...DIFFICULTIES[name], mistakeBase: 1, mistakeSlope: 0 })];
    const seen = { good: 0, popUp: 0, error: 0 };
    for (let i = 0; i < SAMPLED; i++) {
      const incoming = syntheticIncoming(balls);
      const choice = brains[i % 2]!.chooseShot(incoming, random);
      if (choice === 'whiff') continue;
      expect(choice.flightTime).toBeLessThanOrEqual(OPPONENT_MAX_FLIGHT_S);
      const from = contactPoint(incoming.strike.position);
      const error = offTable(choice.target);
      const { events, crossedLive } = flyStruck(from, choice, !error);
      const bounces = events.filter((e) => e.type === 'bounce');
      if (error) {
        seen.error++;
        expect(bounces, `Error to ${JSON.stringify(choice.target)}`).toEqual([]);
        expect(events.filter((e) => e.type === 'net')).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: 'out', reason: 'off-table' });
      } else {
        if (choice.target.x === POP_UP_TARGET.x && choice.target.z === POP_UP_TARGET.z) seen.popUp++;
        else seen.good++;
        expect(solveShot(from, choice), `solve ${JSON.stringify(choice)}`).not.toBeNull();
        expect(crossedLive, `reaches the end line live: ${JSON.stringify(choice)}`).toBe(true);
        expect(bounces.map((b) => b.type === 'bounce' && b.half)).toEqual(['player']);
      }
    }
    expect(seen.good).toBeGreaterThan(40);
    expect(seen.popUp).toBeGreaterThan(5);
    expect(seen.error).toBeGreaterThan(5);
  });
});

describe('createBrain: replays', () => {
  it('the same seed gives the same sequence; another seed a different one', () => {
    const play = (seed: number) => {
      const brain = createBrain(DIFFICULTIES.intermediate);
      const balls = makeRng(41);
      const random = makeRng(seed);
      return Array.from({ length: 60 }, () => brain.chooseShot(syntheticIncoming(balls), random));
    };
    const first = play(42);
    expect(play(42)).toEqual(first);
    expect(play(43)).not.toEqual(first);
  });

  it('the Difficulty it was made with never changes, even if the params object does', () => {
    const params = { ...DIFFICULTIES.expert };
    const brain = createBrain(params, alwaysSolves);
    const run = () => {
      const balls = makeRng(51);
      const random = makeRng(52);
      return Array.from({ length: 200 }, () => brain.chooseShot(syntheticIncoming(balls), random));
    };
    const before = run();
    params.mistakeBase = 1;
    expect(run()).toEqual(before);
  });
});
