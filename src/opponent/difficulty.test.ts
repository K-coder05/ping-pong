import { describe, expect, it } from 'vitest';
import { DEFAULT_DIFFICULTY, DIFFICULTIES, DIFFICULTY_ORDER, OPPONENT_MAX_FLIGHT_S, difficultyFromSearch } from './difficulty.ts';

describe('DIFFICULTIES', () => {
  it('holds the spec P2-c starting values', () => {
    expect(DIFFICULTIES).toEqual({
      novice: { mistakeBase: 0.15, mistakeSlope: 0.35, popUpShare: 0.6, scatterM: 0.25, minFlightS: 0.85, maxFlightS: 1.1, maxSpinRevs: 15, cornerAim: 0.1, earlyBias: 0.5 },
      intermediate: { mistakeBase: 0.07, mistakeSlope: 0.25, popUpShare: 0.4, scatterM: 0.15, minFlightS: 0.7, maxFlightS: 1.1, maxSpinRevs: 30, cornerAim: 0.4, earlyBias: 0.2 },
      expert: { mistakeBase: 0.02, mistakeSlope: 0.15, popUpShare: 0.2, scatterM: 0.07, minFlightS: 0.5, maxFlightS: 1.0, maxSpinRevs: 50, cornerAim: 0.75, earlyBias: 0.05 },
    });
    expect(DIFFICULTY_ORDER).toEqual(['novice', 'intermediate', 'expert']);
  });

  it.each(DIFFICULTY_ORDER)('%s: flights within the 1.1 s cap, chances in 0..1', (name) => {
    const p = DIFFICULTIES[name];
    expect(OPPONENT_MAX_FLIGHT_S).toBe(1.1);
    expect(p.minFlightS).toBeGreaterThan(0);
    expect(p.minFlightS).toBeLessThanOrEqual(p.maxFlightS);
    expect(p.maxFlightS).toBeLessThanOrEqual(OPPONENT_MAX_FLIGHT_S);
    // Even the hardest ball can't make a mistake certain.
    expect(p.mistakeBase + p.mistakeSlope).toBeLessThan(1);
    for (const chance of [p.mistakeBase, p.popUpShare, p.cornerAim, p.earlyBias]) {
      expect(chance).toBeGreaterThanOrEqual(0);
      expect(chance).toBeLessThanOrEqual(1);
    }
  });

  it('never changes: the table and each Difficulty are frozen', () => {
    expect(Object.isFrozen(DIFFICULTIES)).toBe(true);
    for (const name of DIFFICULTY_ORDER) expect(Object.isFrozen(DIFFICULTIES[name])).toBe(true);
  });
});

describe('difficultyFromSearch', () => {
  it('reads ?difficulty=, defaulting to Intermediate', () => {
    expect(DEFAULT_DIFFICULTY).toBe('intermediate');
    expect(difficultyFromSearch('?difficulty=novice')).toBe('novice');
    expect(difficultyFromSearch('?mode=match&difficulty=expert&seed=3')).toBe('expert');
    expect(difficultyFromSearch('?difficulty=intermediate')).toBe('intermediate');
    expect(difficultyFromSearch('?difficulty=EXPERT')).toBe('expert');
    expect(difficultyFromSearch('')).toBe('intermediate');
    expect(difficultyFromSearch('?difficulty=')).toBe('intermediate');
    expect(difficultyFromSearch('?difficulty=hard')).toBe('intermediate');
    expect(difficultyFromSearch('?difficulty=toString')).toBe('intermediate');
  });
});
