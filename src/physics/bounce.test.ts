import { describe, expect, it } from 'vitest';
import { tableBounce, type BounceParams } from './bounce.ts';
import { revsToRadPerSec, spinVector } from './spin.ts';
import { cross, scale, sub, ZERO, type Vec3 } from './vec3.ts';

/** Spec starting values: e = 0.88, µ = 0.25, κ = 3/2 (thin shell), r = 20 mm. */
const P: BounceParams = { e: 0.88, mu: 0.25, kappa: 1.5, r: 0.02 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const TOWARD_FEEDER = { x: 0, y: 0, z: -1 };
const TOWARD_PLAYER = { x: 0, y: 0, z: 1 };
const SPIN_50 = revsToRadPerSec(50);

const horizontal = (v: Vec3) => ({ x: v.x, y: 0, z: v.z });
const horizontalSpeed = (v: Vec3) => Math.hypot(v.x, v.z);
/** Contact-point slip velocity u = v_T − r(ω × n). */
const slip = (v: Vec3, spin: Vec3) => sub(horizontal(v), scale(cross(spin, UP), P.r));

/** 6 m/s in the direction of `d` (horizontal unit), `degrees` below horizontal. */
function incoming(degrees: number, d: Vec3 = TOWARD_FEEDER, speed = 6): Vec3 {
  const a = (degrees * Math.PI) / 180;
  return { x: d.x * speed * Math.cos(a), y: -speed * Math.sin(a), z: d.z * speed * Math.cos(a) };
}

describe('tableBounce', () => {
  it('a no-spin ball dropped from 30 cm rebounds to 22–24 cm (restitution only)', () => {
    const g = 9.81;
    const drop = { x: 0, y: -Math.sqrt(2 * g * 0.3), z: 0 };
    const out = tableBounce(drop, ZERO, P);
    const rebound = out.velocity.y ** 2 / (2 * g);
    expect(rebound).toBeGreaterThanOrEqual(0.22);
    expect(rebound).toBeLessThanOrEqual(0.24);
    // Straight down with no spin: nothing to slip, so nothing sideways and no spin.
    expect(out.velocity.x).toBe(0);
    expect(out.velocity.z).toBe(0);
    expect(out.spin).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('always reverses the vertical speed by the restitution e, whatever the spin', () => {
    for (const spin of [ZERO, spinVector(SPIN_50, 0, TOWARD_FEEDER), spinVector(-SPIN_50, 30, TOWARD_FEEDER)]) {
      const v = incoming(30);
      expect(tableBounce(v, spin, P).velocity.y).toBeCloseTo(-P.e * v.y, 12);
    }
  });

  it('a slipping ball whose α reaches 2/5 leaves rolling: |u⁺| < 1e-6', () => {
    // 60° down with no spin: µ(1+e)|v_y| / |u| = 0.81, so α is capped at 2/5.
    const v = incoming(60);
    const out = tableBounce(v, ZERO, P);
    const u = slip(out.velocity, out.spin);
    expect(Math.hypot(u.x, u.z)).toBeLessThan(1e-6);
    // Rolling forward toward the Feeder is Topspin on that Shot (spin along −x).
    expect(out.spin.x).toBeLessThan(0);
  });

  it('an over-spun ball also leaves rolling when α caps', () => {
    // A slow, steep ball toward the player with more Topspin than rolling needs.
    const v = incoming(70, TOWARD_PLAYER, 3);
    const spin = spinVector(revsToRadPerSec(10), 0, TOWARD_PLAYER);
    const out = tableBounce(v, spin, P);
    const u = slip(out.velocity, out.spin);
    expect(Math.hypot(u.x, u.z)).toBeLessThan(1e-6);
  });

  describe('6 m/s toward the Feeder, 30° down, 50 rev/s', () => {
    const v = incoming(30);
    const none = tableBounce(v, ZERO, P);
    const topspin = tableBounce(v, spinVector(SPIN_50, 0, TOWARD_FEEDER), P);
    const backspin = tableBounce(v, spinVector(-SPIN_50, 0, TOWARD_FEEDER), P);

    it('no spin leaves at 3.79 m/s horizontally (the spec value)', () => {
      expect(horizontalSpeed(none.velocity)).toBeCloseTo(3.79, 2);
    });

    it('Topspin leaves with more horizontal speed than no spin (it kicks forward)', () => {
      expect(horizontalSpeed(topspin.velocity)).toBeGreaterThan(horizontalSpeed(none.velocity));
      expect(topspin.velocity.z).toBeLessThan(0); // still toward the Feeder
    });

    it('Backspin leaves with no more horizontal speed than no spin (equal within 1e-9 here)', () => {
      expect(Math.abs(horizontalSpeed(backspin.velocity) - horizontalSpeed(none.velocity))).toBeLessThan(1e-9);
    });

    it('Topspin leaves lower than no spin: same vertical speed, more horizontal', () => {
      const angle = (out: { velocity: Vec3 }) => out.velocity.y / horizontalSpeed(out.velocity);
      expect(angle(topspin)).toBeLessThan(angle(none));
    });
  });

  describe('6 m/s toward the Feeder, 60° down, 50 rev/s', () => {
    const v = incoming(60);
    const none = tableBounce(v, ZERO, P);
    const backspin = tableBounce(v, spinVector(-SPIN_50, 0, TOWARD_FEEDER), P);

    it('no spin leaves at 1.80 m/s and 50 rev/s Backspin at 0.56 m/s (the spec values)', () => {
      expect(horizontalSpeed(none.velocity)).toBeCloseTo(1.8, 2);
      expect(horizontalSpeed(backspin.velocity)).toBeCloseTo(0.56, 2);
    });

    it('Backspin leaves with strictly less horizontal speed than no spin (it checks up)', () => {
      expect(horizontalSpeed(backspin.velocity)).toBeLessThan(horizontalSpeed(none.velocity));
    });
  });

  it('works the same way for a Shot toward the player', () => {
    const v = incoming(30, TOWARD_PLAYER);
    const none = tableBounce(v, ZERO, P);
    const topspin = tableBounce(v, spinVector(SPIN_50, 0, TOWARD_PLAYER), P);
    expect(horizontalSpeed(topspin.velocity)).toBeGreaterThan(horizontalSpeed(none.velocity));
    expect(topspin.velocity.z).toBeGreaterThan(0);
  });

  it('pure Sidespin leaves with the same horizontal velocity as no spin, and keeps its Sidespin', () => {
    const v = { x: 1.2, y: -4, z: -5 };
    const none = tableBounce(v, ZERO, P);
    const side = tableBounce(v, { x: 0, y: revsToRadPerSec(30), z: 0 }, P);
    expect(side.velocity.x).toBeCloseTo(none.velocity.x, 12);
    expect(side.velocity.z).toBeCloseTo(none.velocity.z, 12);
    expect(side.velocity.y).toBeCloseTo(none.velocity.y, 12);
    expect(side.spin.y).toBe(revsToRadPerSec(30));
  });

  it('a ball already rolling keeps its velocity and spin (no slip, no friction)', () => {
    const v = { x: 0, y: -3, z: -4 };
    const rolling = spinVector(4 / P.r, 0, TOWARD_FEEDER); // ω r = |v_T|
    const out = tableBounce(v, rolling, P);
    expect(out.velocity.x).toBeCloseTo(0, 12);
    expect(out.velocity.z).toBeCloseTo(-4, 9);
    expect(out.spin).toEqual(rolling);
  });

  it('does not mutate its inputs and returns new objects', () => {
    const v = Object.freeze({ x: 0.5, y: -4, z: -5 });
    const spin = Object.freeze({ x: 200, y: 40, z: -10 });
    const p = Object.freeze({ ...P });
    const out = tableBounce(v, spin, p);
    expect(v).toEqual({ x: 0.5, y: -4, z: -5 });
    expect(spin).toEqual({ x: 200, y: 40, z: -10 });
    expect(out.velocity).not.toBe(v);
    expect(out.spin).not.toBe(spin);
  });
});
