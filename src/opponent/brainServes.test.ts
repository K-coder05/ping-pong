/**
 * The Opponent's Serves (spec P2-f1): 1,000 seeded Serves per Difficulty,
 * each solved and simulated for real. In their own file so they run
 * alongside the brain's other tests.
 */

import { describe, expect, it } from 'vitest';
import { launchBall, simulate, type BallEvent } from '../game/ball.ts';
import { PLAYER_END_Z, TABLE_WIDTH } from '../game/constants.ts';
import { lookAhead } from '../game/rally.ts';
import { judgeServe, OPPONENT_SERVE_FROM, solveServe, type ServeIntent } from '../game/serve.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { makeRng } from '../util/rng.ts';
import { createBrain, SAFE_SERVE, SERVE_BOUNCE1_Z_MAX, SERVE_BOUNCE1_Z_MIN } from './brain.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from './difficulty.ts';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Distance from a Serve's target to the nearer deep corner of the player's half, m. */
const toCorner = (s: ServeIntent) => Math.hypot(TABLE_WIDTH / 2 - Math.abs(s.target.x), PLAYER_END_Z - s.target.z);

const SERVES = 1000;

/** 1,000 seeded Serves at one Difficulty, each checked as it is drawn. Memoised: the ordering test reads them. */
const served = new Map<Difficulty, ServeIntent[]>();

describe.each(DIFFICULTY_ORDER)('createBrain(%s).chooseServe', (name) => {
  it(`${SERVES} seeded Serves are all legal, clear the net and reach the player's end line`, () => {
    const brain = createBrain(DIFFICULTIES[name]);
    const random = makeRng(2024);
    const intents: ServeIntent[] = [];
    for (let i = 0; i < SERVES; i++) {
      const intent = brain.chooseServe(random);
      intents.push(intent);
      const what = `Serve ${i}: ${JSON.stringify(intent)}`;
      expect(intent.bounce1.z, what).toBeGreaterThanOrEqual(SERVE_BOUNCE1_Z_MIN);
      expect(intent.bounce1.z, what).toBeLessThanOrEqual(SERVE_BOUNCE1_Z_MAX);
      expect(Math.abs(intent.topspin), what).toBeLessThanOrEqual(revsToRadPerSec(DIFFICULTIES[name].maxSpinRevs));
      // Solved and launched as the core does, with a Net-cord seed drawn from the same random.
      const solution = solveServe(OPPONENT_SERVE_FROM, intent);
      expect(solution, what).not.toBeNull();
      const ball = launchBall(OPPONENT_SERVE_FROM, solution!.velocity, solution!.spin, Math.floor(random() * 2 ** 32));
      expect(judgeServe(ball, 'opponent'), what).toBe('legal');
      const toSecondBounce: BallEvent[] = [];
      let bounces = 0;
      simulate(ball, {
        maxTime: 3,
        until: (_s, _t, events) => {
          toSecondBounce.push(...events);
          bounces += events.filter((e) => e.type === 'bounce').length;
          return bounces >= 2;
        },
      });
      expect(toSecondBounce.filter((e) => e.type === 'cord' || e.type === 'net'), what).toEqual([]);
      expect(lookAhead(ball, 'player', { serve: true }), what).not.toBeNull();
    }
    served.set(name, intents);
  });
});

describe('createBrain.chooseServe across Difficulties', () => {
  it('aims closer to the corners, with more Spin, at higher Difficulty', () => {
    const corner = DIFFICULTY_ORDER.map((name) => mean(served.get(name)!.map(toCorner)));
    const spin = DIFFICULTY_ORDER.map((name) => mean(served.get(name)!.map((s) => Math.abs(s.topspin))));
    console.log(`[serves] mean distance to a corner, m: ${corner.map((c) => c.toFixed(2)).join(' > ')}; mean |spin|, rev/s: ${spin.map((s) => (s / (2 * Math.PI)).toFixed(1)).join(' < ')}`);
    expect(corner[0]).toBeGreaterThan(corner[1]!);
    expect(corner[1]).toBeGreaterThan(corner[2]!);
    expect(spin[0]).toBeLessThan(spin[1]!);
    expect(spin[1]).toBeLessThan(spin[2]!);
  });

  it('serves both Topspin and Backspin', () => {
    const signs = new Set(served.get('expert')!.map((s) => Math.sign(s.topspin)));
    expect(signs).toEqual(new Set([1, -1]));
  });
});

describe('createBrain.chooseServe', () => {
  it('the same seed gives the same Serves; another seed different ones', () => {
    const play = (seed: number) => {
      const brain = createBrain(DIFFICULTIES.intermediate);
      const random = makeRng(seed);
      return Array.from({ length: 20 }, () => brain.chooseServe(random));
    };
    const first = play(7);
    expect(play(7)).toEqual(first);
    expect(play(8)).not.toEqual(first);
  });

  it('serves the safe Serve when none it draws can be served', () => {
    let calls = 0;
    const never = (() => (calls++, null)) as unknown as typeof solveServe;
    const brain = createBrain(DIFFICULTIES.expert, undefined, never);
    expect(brain.chooseServe(makeRng(1))).toEqual(SAFE_SERVE);
    expect(calls).toBeGreaterThan(1);
  });

  it('the safe Serve itself is legal and reaches the player\'s end line', () => {
    const solution = solveServe(OPPONENT_SERVE_FROM, SAFE_SERVE)!;
    expect(solution).not.toBeNull();
    const ball = launchBall(OPPONENT_SERVE_FROM, solution.velocity, solution.spin);
    expect(judgeServe(ball, 'opponent')).toBe('legal');
    expect(lookAhead(ball, 'player', { serve: true })).not.toBeNull();
  });
});
