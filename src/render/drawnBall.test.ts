import { describe, expect, it } from 'vitest';
import { SPIN_DRAW_MAX_REVS } from '../game/constants.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { drawnSpinRate } from './drawnBall.ts';

const about = (revs: number) => ({ x: 0, y: 0, z: -revsToRadPerSec(revs) });

describe('drawnSpinRate', () => {
  it('is zero for no spin', () => {
    expect(drawnSpinRate({ x: 0, y: 0, z: 0 }, SPIN_DRAW_MAX_REVS.default)).toBe(0);
  });

  it('is monotonic in the real rate and never above the maximum, at every knob setting', () => {
    for (const max of [SPIN_DRAW_MAX_REVS.min, SPIN_DRAW_MAX_REVS.default, SPIN_DRAW_MAX_REVS.max]) {
      let previous = -1;
      for (let revs = 0; revs <= 500; revs += 0.5) {
        const rate = drawnSpinRate(about(revs), max);
        expect(rate).toBeGreaterThanOrEqual(previous);
        expect(rate).toBeLessThanOrEqual(max);
        previous = rate;
      }
    }
  });

  it('depends on the spin vector’s size only, not its direction', () => {
    const w = revsToRadPerSec(40);
    expect(drawnSpinRate({ x: w, y: 0, z: 0 }, 4)).toBeCloseTo(drawnSpinRate({ x: 0, y: -w, z: 0 }, 4), 12);
  });

  it('tells 20 rev/s from 80 rev/s, and follows the formula', () => {
    expect(drawnSpinRate(about(20), 4)).toBeLessThan(drawnSpinRate(about(80), 4));
    expect(drawnSpinRate(about(30), 4)).toBeCloseTo(4 * Math.tanh(1), 12);
  });
});
