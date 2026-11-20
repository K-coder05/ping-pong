import { describe, expect, it } from 'vitest';
import { decaySpin, flightAcceleration, type FlightParams } from './flight.ts';
import { length, sub, ZERO, type Vec3 } from './vec3.ts';

/** Spec starting values; the drag constant is ½·ρ·C_D·A / m for a 40 mm, 2.7 g ball. */
const P: FlightParams = {
  g: -9.81,
  k: (0.5 * 1.2 * 0.5 * Math.PI * 0.02 ** 2) / 0.0027,
  kM: 0.003,
  spinTau: 4,
};
const NO_MAGNUS: FlightParams = { ...P, kM: 0 };

describe('flightAcceleration', () => {
  it('is gravity alone for a ball at rest', () => {
    expect(flightAcceleration(ZERO, ZERO, P)).toEqual({ x: 0, y: -9.81, z: 0 });
  });

  it('drags against the velocity as k|v|v', () => {
    const v = { x: 0, y: 0, z: -10 };
    const a = flightAcceleration(v, ZERO, P);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.y).toBeCloseTo(-9.81, 12);
    expect(a.z).toBeCloseTo(P.k * 10 * 10, 12); // about 1.4 g, opposing −z
  });

  it('gives 7.4–7.7 m/s² of Magnus for 314 rad/s at 8 m/s, spin perpendicular to velocity', () => {
    const v = { x: 0, y: 0, z: -8 };
    const spin = { x: -314, y: 0, z: 0 }; // Topspin on a Shot toward the Feeder
    const magnus = sub(flightAcceleration(v, spin, P), flightAcceleration(v, ZERO, P));
    const size = length(magnus);
    expect(size).toBeGreaterThanOrEqual(7.4);
    expect(size).toBeLessThanOrEqual(7.7);
    // Topspin dips: the push is straight down.
    expect(magnus.y).toBeCloseTo(-size, 9);
  });

  it('pushes along ω × v: Backspin lifts, Sidespin curves', () => {
    const v = { x: 0, y: 0, z: -8 };
    const backspin = sub(flightAcceleration(v, { x: 314, y: 0, z: 0 }, P), flightAcceleration(v, ZERO, P));
    expect(backspin.y).toBeGreaterThan(7.4);
    // Spin about +y on a −z Shot: ŷ × (−ẑ) = −x̂.
    const sidespin = sub(flightAcceleration(v, { x: 0, y: 100, z: 0 }, P), flightAcceleration(v, ZERO, P));
    expect(sidespin.x).toBeCloseTo(-0.003 * 100 * 8, 9);
    expect(sidespin.y).toBeCloseTo(0, 9);
  });

  it('spin along the velocity has no Magnus effect', () => {
    const v = { x: 0, y: 0, z: -8 };
    expect(flightAcceleration(v, { x: 0, y: 0, z: 300 }, P)).toEqual(flightAcceleration(v, ZERO, P));
  });

  it('settles a falling ball with no spin at a terminal speed of 8.2–8.5 m/s', () => {
    let v: Vec3 = { x: 0, y: 0, z: 0 };
    const dt = 1 / 240;
    for (let i = 0; i < 240 * 10; i++) {
      const a = flightAcceleration(v, ZERO, NO_MAGNUS);
      v = { x: v.x + a.x * dt, y: v.y + a.y * dt, z: v.z + a.z * dt };
    }
    const speed = -v.y;
    expect(speed).toBeGreaterThanOrEqual(8.2);
    expect(speed).toBeLessThanOrEqual(8.5);
    // Settled: one more step barely changes it.
    expect(Math.abs(flightAcceleration(v, ZERO, NO_MAGNUS).y)).toBeLessThan(1e-6);
  });

  it('does not mutate its inputs', () => {
    const v = Object.freeze({ x: 1, y: 2, z: -8 });
    const spin = Object.freeze({ x: -300, y: 20, z: 0 });
    const p = Object.freeze({ ...P });
    expect(() => flightAcceleration(v, spin, p)).not.toThrow();
    expect(v).toEqual({ x: 1, y: 2, z: -8 });
    expect(spin).toEqual({ x: -300, y: 20, z: 0 });
  });
});

describe('decaySpin', () => {
  it('falls to 1/e of its start after one time constant (within 1%), stepped at 240 Hz', () => {
    const start = { x: -314, y: 50, z: 10 };
    const dt = 1 / 240;
    let spin: Vec3 = start;
    for (let i = 0; i < 240 * P.spinTau; i++) spin = decaySpin(spin, dt, P.spinTau);
    const ratio = length(spin) / length(start);
    expect(Math.abs(ratio / Math.exp(-1) - 1)).toBeLessThan(0.01);
    // Decay keeps the spin axis.
    expect(spin.x / spin.y).toBeCloseTo(start.x / start.y, 9);
  });

  it('leaves zero spin at zero and never flips its sign', () => {
    expect(decaySpin(ZERO, 1, 4)).toEqual({ x: 0, y: 0, z: 0 });
    const spin = decaySpin({ x: -10, y: 5, z: 1 }, 100, 4);
    expect(spin.x).toBeLessThanOrEqual(0);
    expect(spin.y).toBeGreaterThanOrEqual(0);
  });

  it('returns a new object without mutating its input', () => {
    const spin = Object.freeze({ x: -314, y: 0, z: 0 });
    const out = decaySpin(spin, 1 / 240, 4);
    expect(out).not.toBe(spin);
    expect(spin).toEqual({ x: -314, y: 0, z: 0 });
  });
});
