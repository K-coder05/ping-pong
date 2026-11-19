import { describe, expect, it } from 'vitest';
import type { BallEvent } from './ball.ts';
import { createScore, judgeReturnFlight } from './score.ts';

const at = { x: 0, y: 0.78, z: 0 };
const bounce = (half: 'player' | 'feeder'): BallEvent => ({ type: 'bounce', half, position: at });

describe('a struck ball', () => {
  it('is a Return when its first bounce is on the Feeder half', () => {
    expect(judgeReturnFlight([bounce('feeder'), { type: 'out', reason: 'off-table', position: at }])).toEqual({ type: 'return', position: at });
  });

  it('is not a Return when the net, the floor or the player half comes first', () => {
    expect(judgeReturnFlight([{ type: 'net', position: at }, bounce('feeder')])).toEqual({ type: 'off-target', reason: 'net', position: at });
    expect(judgeReturnFlight([{ type: 'out', reason: 'off-table', position: at }])).toEqual({ type: 'off-target', reason: 'out', position: at });
    expect(judgeReturnFlight([bounce('player')])).toEqual({ type: 'off-target', reason: 'own-half', position: at });
  });

  it('is undecided while it is still in the air', () => {
    expect(judgeReturnFlight([])).toBeNull();
  });
});

describe('Streak', () => {
  it('counts consecutive Returns', () => {
    const score = createScore();
    score.addReturn();
    score.addReturn();
    expect(score.streak).toBe(2);
  });

  it('resets on a failed Feed but keeps the best Streak', () => {
    const score = createScore();
    score.addReturn();
    score.addReturn();
    score.addReturn();
    score.breakStreak();
    score.addReturn();
    expect(score.streak).toBe(1);
    expect(score.best).toBe(3);
  });

  it('tells subscribers each time the Streak changes', () => {
    const score = createScore();
    const seen: [number, number][] = [];
    score.subscribe(({ streak, best }) => seen.push([streak, best]));
    score.addReturn();
    score.addReturn();
    score.breakStreak();
    score.breakStreak(); // already 0: nothing changes
    expect(seen).toEqual([
      [1, 1],
      [2, 2],
      [0, 2],
    ]);
  });
});
