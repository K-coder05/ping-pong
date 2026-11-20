/**
 * Headless Rallies of a scripted player against the Opponent's brain, through
 * the core (spec P2-c). In their own file so they run alongside the brain's
 * unit tests: each Rally solves and simulates every Shot for real.
 */

import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { SWING_FAST, SWING_ON, TIMING_OFFSET_MS } from '../game/constants.ts';
import { createGameCore, type GameCore } from '../game/core.ts';
import type { RallyEvent } from '../game/rally.ts';
import { knobResolverParams } from '../game/shotResolver.ts';
import { makeRng } from '../util/rng.ts';
import { createBrain } from './brain.ts';
import { DIFFICULTIES, type Difficulty } from './difficulty.ts';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const FRAME_S = 1 / 60;

/** A scripted player: a medium-speed, flat Forehand seen exactly at each Ideal Time toward the player. */
function scriptedPlayer(core: GameCore): (nowMs: number) => SwingEvent | null {
  let due: SwingEvent | null = null;
  core.onIncoming((incoming) => {
    if (incoming.receiver !== 'player') return;
    due = { t: incoming.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 };
  });
  return (nowMs) => {
    if (!due || nowMs < due.t) return null;
    const swing = due;
    due = null;
    return swing;
  };
}

/** `rallies` Rallies of the scripted player against the brain at `name`; the Shots in each (the Serve is Shot 0). */
/** A Match long enough never to end within these Rallies. */
const ENDLESS_MATCH = { pointsToWin: 10_000, winBy: 2, bestOf: 1 };

function playRallies(name: Difficulty, rallies: number, seed: number): { lengths: number[]; ends: Extract<RallyEvent, { type: 'end' }>[] } {
  const core = createGameCore({ random: makeRng(seed), resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent: createBrain(DIFFICULTIES[name]), match: ENDLESS_MATCH });
  const nextSwing = scriptedPlayer(core);
  const lengths: number[] = [];
  const ends: Extract<RallyEvent, { type: 'end' }>[] = [];
  let shots = 0;
  core.onRally((e) => {
    if (e.type === 'shot') shots++;
    if (e.type === 'end') {
      ends.push(e);
      lengths.push(shots);
      shots = 0;
    }
  });
  // A generous cap (an Expert Rally against a player who never misses runs about a minute): none may go on for ever.
  const maxFrames = Math.round((rallies * 300) / FRAME_S);
  for (let i = 1; i <= maxFrames && ends.length < rallies; i++) {
    const nowMs = 1000 + i * FRAME_S * 1000;
    const swing = nextSwing(nowMs);
    if (swing) core.swing(swing, nowMs);
    core.frame({ nowMs, elapsedSeconds: FRAME_S });
  }
  return { lengths, ends };
}

describe('Headless Rallies of the scripted player against the brain', () => {
  /** 200 Rallies where the spec compares Difficulties; fewer for Intermediate, which is only checked to end. */
  const RALLIES: Record<Difficulty, number> = { novice: 200, intermediate: 40, expert: 200 };
  const lengths = new Map<Difficulty, number[]>();

  it.each(['novice', 'intermediate', 'expert'] as const)('%s: every Rally ends', (name) => {
    const run = playRallies(name, RALLIES[name], 61);
    expect(run.ends).toHaveLength(RALLIES[name]);
    // The scripted player swings at every Ideal Time: most Rallies end on an Opponent mistake.
    expect(run.ends.filter((e) => e.loser === 'opponent').length).toBeGreaterThan(RALLIES[name] / 2);
    lengths.set(name, run.lengths);
  }, 60_000);

  it('Expert Rallies are longer than Novice on average over 200 Rallies', () => {
    const novice = lengths.get('novice') ?? playRallies('novice', RALLIES.novice, 61).lengths;
    const expert = lengths.get('expert') ?? playRallies('expert', RALLIES.expert, 61).lengths;
    expect(novice).toHaveLength(200);
    expect(expert).toHaveLength(200);
    console.log(`[rallies] average Shots per Rally: Novice ${mean(novice).toFixed(1)}, Expert ${mean(expert).toFixed(1)}`);
    expect(mean(expert)).toBeGreaterThan(mean(novice));
  }, 60_000);
});

describe('GameCore.opponentPlan with the brain', () => {
  it('holds the brain\'s choice from the launch of each Shot toward the Opponent until its strike, and is null otherwise', () => {
    const core = createGameCore({ random: makeRng(71), resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent: createBrain(DIFFICULTIES.novice) });
    const nextSwing = scriptedPlayer(core);
    const plans: NonNullable<GameCore['opponentPlan']>[] = [];
    core.onIncoming((incoming) => {
      // Listeners hear the launch before the brain is asked: the plan for this Shot isn't set yet.
      if (incoming.receiver === 'opponent') expect(core.opponentPlan).toBeNull();
    });
    core.onRally((e) => {
      // The Opponent's strike clears its plan before its Shot launches.
      if (e.type === 'shot' && e.by === 'opponent') expect(core.opponentPlan).toBeNull();
      if (e.type === 'end') expect(core.opponentPlan).toBeNull();
    });
    let ends = 0;
    core.onRally((e) => e.type === 'end' && ends++);
    for (let i = 1; i <= 60 * 600 && ends < 3; i++) {
      const nowMs = 1000 + i * FRAME_S * 1000;
      const swing = nextSwing(nowMs);
      if (swing) core.swing(swing, nowMs);
      core.frame({ nowMs, elapsedSeconds: FRAME_S });
      const plan = core.opponentPlan;
      if (plan && plans.at(-1) !== plan) plans.push(plan);
      if (plan) {
        expect(plan.incoming.receiver).toBe('opponent');
        expect(nowMs).toBeLessThan(plan.incoming.idealAtMs);
      }
    }
    expect(ends).toBe(3);
    expect(plans.length).toBeGreaterThan(3);
    for (const { choice } of plans) if (choice !== 'whiff') expect(choice.flightTime).toBeLessThanOrEqual(1.1);
    expect(createGameCore({ random: makeRng(1), resolverParams: knobResolverParams, hand: () => 'right' }).opponentPlan).toBeNull();
  });
});
