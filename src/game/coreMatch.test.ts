/**
 * Headless Matches (spec P2-f1): a scripted player against the Opponent's
 * brain at each Difficulty, through the core, from the first Serve to
 * match-over. In their own file so they run alongside the core's other tests.
 */

import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { createBrain } from '../opponent/brain.ts';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../opponent/difficulty.ts';
import { makeRng } from '../util/rng.ts';
import { SWING_FAST, SWING_ON, TIMING_OFFSET_MS } from './constants.ts';
import { createGameCore, DEFAULT_MATCH_CONFIG, describeMatchEvent, type GameCore, type MatchEvent } from './core.ts';
import type { RallyEvent } from './rally.ts';
import { knobResolverParams } from './shotResolver.ts';
import { otherSide } from './side.ts';

const FRAME_S = 1 / 60;

/**
 * A scripted player: a medium-speed, flat Forehand seen exactly at the Ideal
 * Time of each Shot coming to it, but it lets a share `missChance` of them go by
 * (its own seeded draw), so both sides win Points.
 */
function scriptedPlayer(core: GameCore, missChance: number, random: () => number): (nowMs: number) => SwingEvent | null {
  let due: SwingEvent | null = null;
  core.onIncoming((incoming) => {
    if (incoming.receiver !== 'player' || random() < missChance) return;
    due = { t: incoming.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 };
  });
  return (nowMs) => {
    if (!due || nowMs < due.t) return null;
    const swing = due;
    due = null;
    return swing;
  };
}

describe.each(DIFFICULTY_ORDER)('Headless Match: the scripted player against %s', (name) => {
  it('runs from the first Serve to match-over, every Serve legal, with a legal final score', () => {
    const core = createGameCore({ random: makeRng(77), resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent: createBrain(DIFFICULTIES[name]) });
    const nextSwing = scriptedPlayer(core, 0.05, makeRng(78));
    const rally: RallyEvent[] = [];
    const match: MatchEvent[] = [];
    core.onRally((e) => rally.push(e));
    core.onMatch((e) => match.push(e));
    // One Game to 11: well under an hour of play.
    const maxFrames = Math.round(3600 / FRAME_S);
    for (let i = 1; i <= maxFrames && core.match!.phase !== 'match-over'; i++) {
      const nowMs = 1000 + i * FRAME_S * 1000;
      const swing = nextSwing(nowMs);
      if (swing) core.swing(swing, nowMs);
      core.frame({ nowMs, elapsedSeconds: FRAME_S });
    }

    const final = core.match!;
    expect(final.phase).toBe('match-over');
    const winner = final.winner!;
    const loser = otherSide(winner);
    const { pointsToWin, winBy } = DEFAULT_MATCH_CONFIG;
    // A legal final score: 11 with a lead of 2 or more, or past 11 by exactly 2 after a deuce.
    expect(final.points[winner]).toBeGreaterThanOrEqual(pointsToWin);
    expect(final.points[winner] - final.points[loser]).toBeGreaterThanOrEqual(winBy);
    if (final.points[winner] > pointsToWin) expect(final.points[winner] - final.points[loser]).toBe(winBy);
    expect(final.games).toEqual({ [winner]: 1, [loser]: 0 });

    // Every Point came from a Rally End, to the side that didn't lose it; no Lets, no Faults.
    const ends = rally.filter((e) => e.type === 'end');
    const points = match.filter((e) => e.type === 'point');
    expect(match.every((e) => e.type === 'point')).toBe(true);
    expect(points).toHaveLength(final.points.player + final.points.opponent);
    expect(ends).toHaveLength(points.length);
    points.forEach((p, i) => expect(p.to).toBe(otherSide(ends[i]!.loser)));
    const serves = rally.filter((e) => e.type === 'serve');
    expect(serves).toHaveLength(points.length);
    expect(serves.every((e) => e.type === 'serve' && e.by === 'opponent' && e.result === 'legal')).toBe(true);
    expect(ends.some((e) => e.end === 'fault')).toBe(false);
    console.log(`[match] ${name}: ${describeMatchEvent(points.at(-1)!)}`);
  });
});
