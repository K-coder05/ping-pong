import { describe, expect, it } from 'vitest';
import { BALL_DRAW_SCALE, DRAG_K, HIT_WINDOW_MS, TIME_SCALE } from './constants.ts';
import { knobs } from './knobs.ts';

describe('constants', () => {
  it('registers its tuning knobs in the app registry with SPEC starting values', () => {
    const names = knobs.entries().map((e) => e.name);
    expect(names).toContain('BALL_DRAW_SCALE');
    expect(BALL_DRAW_SCALE.value).toBe(2);
    expect(HIT_WINDOW_MS.value).toBe(200);
    expect(TIME_SCALE.value).toBe(0.8);
  });

  it('derives the drag constant SPEC quotes as about 0.14 /m', () => {
    expect(DRAG_K).toBeCloseTo(0.14, 2);
  });
});
