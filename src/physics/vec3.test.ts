import { describe, expect, it } from 'vitest';
import { ZERO, add, cross, length, scale, sub, type Vec3 } from './vec3.ts';

const a: Vec3 = { x: 1, y: 2, z: 3 };
const b: Vec3 = { x: 4, y: -5, z: 6 };

describe('vec3', () => {
  it('ZERO is the zero vector', () => {
    expect(ZERO).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('adds, subtracts and scales componentwise', () => {
    expect(add(a, b)).toEqual({ x: 5, y: -3, z: 9 });
    expect(sub(a, b)).toEqual({ x: -3, y: 7, z: -3 });
    expect(scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
  });

  it('crosses right-handed: x × y = z, y × z = x, z × x = y', () => {
    const x = { x: 1, y: 0, z: 0 };
    const y = { x: 0, y: 1, z: 0 };
    const z = { x: 0, y: 0, z: 1 };
    expect(cross(x, y)).toEqual(z);
    expect(cross(y, z)).toEqual(x);
    expect(cross(z, x)).toEqual(y);
    expect(cross(a, b)).toEqual({ x: 27, y: 6, z: -13 });
  });

  it('length is the Euclidean norm', () => {
    expect(length({ x: 3, y: 4, z: 12 })).toBe(13);
    expect(length(ZERO)).toBe(0);
  });

  it('returns new objects and never mutates its inputs', () => {
    const a1 = { ...a };
    const b1 = { ...b };
    for (const out of [add(a1, b1), sub(a1, b1), scale(a1, 3), cross(a1, b1)]) {
      expect(out).not.toBe(a1);
      expect(out).not.toBe(b1);
    }
    expect(a1).toEqual(a);
    expect(b1).toEqual(b);
  });
});
