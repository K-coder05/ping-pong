import { describe, expect, it } from 'vitest';
import { classifyNetCrossing, cordVelocity, NET_CORD_KEEP, NET_CORD_NUDGE } from './net.ts';
import { makeRng } from '../util/rng.ts';

const NET_TOP = 0.76 + 0.1525;
const R = 0.02;
const EPS = 1e-9;

describe('classifyNetCrossing', () => {
  it('is dead when the ball bottom is more than one radius below the net top', () => {
    expect(classifyNetCrossing(NET_TOP - R - EPS, NET_TOP, R)).toBe('dead');
    expect(classifyNetCrossing(0.8, NET_TOP, R)).toBe('dead');
  });

  it('is a Net-cord from one radius below the net top up to just below it', () => {
    expect(classifyNetCrossing(NET_TOP - R, NET_TOP, R)).toBe('cord');
    expect(classifyNetCrossing(NET_TOP - R + EPS, NET_TOP, R)).toBe('cord');
    expect(classifyNetCrossing(NET_TOP - R / 2, NET_TOP, R)).toBe('cord');
    expect(classifyNetCrossing(NET_TOP - EPS, NET_TOP, R)).toBe('cord');
  });

  it('is clear when the ball bottom is at or above the net top', () => {
    expect(classifyNetCrossing(NET_TOP, NET_TOP, R)).toBe('clear');
    expect(classifyNetCrossing(NET_TOP + 0.05, NET_TOP, R)).toBe('clear');
  });
});

describe('cordVelocity', () => {
  /** A random() that always returns `value`. */
  const fixed = (value: number) => () => value;

  it('pops the ball up at half its vertical speed, whichever way it was moving', () => {
    expect(cordVelocity({ x: 0, y: -2, z: -4 }, fixed(0.5)).y).toBe(1);
    expect(cordVelocity({ x: 0, y: 3, z: -4 }, fixed(0.5)).y).toBe(1.5);
  });

  it('keeps 0.3 of the speed along z and x, plus a nudge of up to ±0.5 m/s along z', () => {
    const v = { x: 1, y: -1, z: -4 };
    // random() = 0.5 is no nudge; 0 pulls the ball back by the most; → 1 pushes it on by the most.
    expect(cordVelocity(v, fixed(0.5))).toEqual({ x: 0.3, y: 0.5, z: -1.2 });
    expect(cordVelocity(v, fixed(0)).z).toBeCloseTo(-1.2 + 0.5, 12);
    expect(cordVelocity(v, fixed(1 - 1e-12)).z).toBeCloseTo(-1.2 - 0.5, 9);
    expect(NET_CORD_KEEP).toBe(0.3);
    expect(NET_CORD_NUDGE).toBe(0.5);
  });

  it('nudges along the direction of travel for a ball moving toward the player too', () => {
    const v = { x: 0, y: -1, z: 1 };
    expect(cordVelocity(v, fixed(0)).z).toBeCloseTo(0.3 - 0.5, 12);
    expect(cordVelocity(v, fixed(1 - 1e-12)).z).toBeCloseTo(0.3 + 0.5, 9);
  });

  it('gives the same result for the same seed', () => {
    const v = { x: 0.2, y: -1.5, z: -1 };
    expect(cordVelocity(v, makeRng(1234))).toEqual(cordVelocity(v, makeRng(1234)));
  });

  it('across 100 seeds, some slow cords trickle over and some drop back', () => {
    // At 1 m/s along z the kept 0.3 m/s is smaller than the biggest nudge.
    const v = { x: 0, y: -1, z: -1 };
    let over = 0;
    let back = 0;
    for (let seed = 0; seed < 100; seed++) {
      const out = cordVelocity(v, makeRng(seed));
      if (out.z < 0) over++;
      else if (out.z > 0) back++;
      expect(out.y).toBeGreaterThan(0);
    }
    expect(over).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(0);
  });

  it('does not mutate its input and returns a new object', () => {
    const v = Object.freeze({ x: 1, y: -2, z: -3 });
    const out = cordVelocity(v, makeRng(7));
    expect(v).toEqual({ x: 1, y: -2, z: -3 });
    expect(out).not.toBe(v);
  });
});
