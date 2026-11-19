import { describe, expect, it } from 'vitest';
import { createSimClock } from './simClock.ts';

describe('simulation clock', () => {
  it('turns a 60 Hz frame into four 240 Hz substeps at full speed', () => {
    const clock = createSimClock();
    expect(clock.advance(1 / 60, 1)).toBe(4);
  });

  it('slows the simulation by the time scale, carrying leftover time between frames', () => {
    const clock = createSimClock();
    let steps = 0;
    for (let frame = 0; frame < 60; frame++) steps += clock.advance(1 / 60, 0.8);
    // One real second at 0.8 is 0.8 simulated seconds: 192 substeps (give or take the carry).
    expect(steps).toBeGreaterThanOrEqual(191);
    expect(steps).toBeLessThanOrEqual(192);
  });

  it('catches up at most a tenth of a second after a long stall (e.g. a background tab)', () => {
    const clock = createSimClock();
    expect(clock.advance(5, 1)).toBe(24);
  });
});
