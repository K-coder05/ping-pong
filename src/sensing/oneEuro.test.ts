import { describe, expect, it } from 'vitest';
import { createOneEuroFilter, type OneEuroParams } from './oneEuro.ts';

const FRAME_MS = 1000 / 30;

function fixed(params: OneEuroParams) {
  return () => params;
}

describe('One Euro filter', () => {
  it('passes the first sample through unchanged', () => {
    const filter = createOneEuroFilter(fixed({ minCutoff: 1, beta: 0 }));
    expect(filter.filter(0.42, 1000)).toBe(0.42);
  });

  it('with beta 0 acts as a 1 Hz low-pass: a step at 30 FPS moves about 17% of the way', () => {
    // alpha = 1 / (1 + tau / dt), tau = 1 / (2π · 1 Hz), dt = 1/30 s → 0.17317
    const filter = createOneEuroFilter(fixed({ minCutoff: 1, beta: 0 }));
    filter.filter(0, 0);
    expect(filter.filter(1, FRAME_MS)).toBeCloseTo(0.17317, 4);
  });

  it('lags less behind a fast-moving value when beta is raised', () => {
    const lagAfterRamp = (beta: number) => {
      const filter = createOneEuroFilter(fixed({ minCutoff: 1, beta }));
      let out = 0;
      let value = 0;
      for (let i = 0; i < 10; i++) {
        value = i * 0.1; // 3 units/s
        out = filter.filter(value, i * FRAME_MS);
      }
      return value - out;
    };
    expect(lagAfterRamp(1)).toBeLessThan(lagAfterRamp(0) / 2);
  });

  it('reads its parameters on every sample, so live knob changes apply immediately', () => {
    let params: OneEuroParams = { minCutoff: 1, beta: 0 };
    const filter = createOneEuroFilter(() => params);
    filter.filter(0, 0);
    params = { minCutoff: 1000, beta: 0 }; // effectively no smoothing
    expect(filter.filter(1, FRAME_MS)).toBeGreaterThan(0.99);
  });

  it('holds its last output for a repeated or out-of-order timestamp instead of returning NaN', () => {
    const filter = createOneEuroFilter(fixed({ minCutoff: 1, beta: 0.01 }));
    filter.filter(0, 0);
    const out = filter.filter(1, FRAME_MS);
    expect(filter.filter(5, FRAME_MS)).toBe(out);
    expect(filter.filter(5, 0)).toBe(out);
  });

  it('starts fresh after reset', () => {
    const filter = createOneEuroFilter(fixed({ minCutoff: 1, beta: 0 }));
    filter.filter(0, 0);
    filter.filter(0, FRAME_MS);
    filter.reset();
    expect(filter.filter(0.7, 2 * FRAME_MS)).toBe(0.7);
  });
});
