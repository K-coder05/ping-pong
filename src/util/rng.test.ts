import { describe, expect, it } from 'vitest';
import { makeRng, seedFromSearch } from './rng.ts';

function draw(random: () => number, n: number): number[] {
  return Array.from({ length: n }, () => random());
}

describe('seeded RNG', () => {
  it('the same seed gives the same sequence', () => {
    expect(draw(makeRng(42), 50)).toEqual(draw(makeRng(42), 50));
  });

  it('different seeds give different sequences', () => {
    expect(draw(makeRng(1), 10)).not.toEqual(draw(makeRng(2), 10));
  });

  it('every draw is in [0, 1)', () => {
    for (const seed of [0, 1, 7, 123456789, 0xffffffff]) {
      for (const x of draw(makeRng(seed), 10_000)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }
    }
  });

  it('the mean of 10,000 draws is within 0.01 of 0.5', () => {
    const xs = draw(makeRng(2026), 10_000);
    const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
  });
});

describe('seedFromSearch', () => {
  it('reads ?seed=<n>', () => {
    expect(seedFromSearch('?seed=1234')).toBe(1234);
    expect(seedFromSearch('?input=mouse&seed=7')).toBe(7);
  });

  it('picks a seed when none, or a bad one, is given', () => {
    for (const search of ['', '?input=mouse', '?seed=', '?seed=abc']) {
      const seed = seedFromSearch(search);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });
});
