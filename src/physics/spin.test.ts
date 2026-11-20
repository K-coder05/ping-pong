import { describe, expect, it } from 'vitest';
import { revsToRadPerSec, spinVector } from './spin.ts';
import { ZERO } from './vec3.ts';

const TOWARD_FEEDER = { x: 0, y: 0, z: -1 };
const TOWARD_PLAYER = { x: 0, y: 0, z: 1 };

describe('spinVector', () => {
  it('Topspin on a Shot toward the Feeder points along -x', () => {
    expect(spinVector(10, 0, TOWARD_FEEDER)).toEqual({ x: -10, y: 0, z: 0 });
  });

  it('Topspin on a Shot toward the player points along +x', () => {
    expect(spinVector(10, 0, TOWARD_PLAYER)).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('Backspin (negative Topspin) reverses the axis', () => {
    expect(spinVector(-10, 0, TOWARD_FEEDER)).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('Sidespin points along +y or -y, whatever the direction of travel', () => {
    expect(spinVector(0, 7, TOWARD_FEEDER)).toEqual({ x: 0, y: 7, z: 0 });
    expect(spinVector(0, -7, TOWARD_PLAYER)).toEqual({ x: 0, y: -7, z: 0 });
  });

  it('zero spin is the zero vector', () => {
    const v = spinVector(0, 0, TOWARD_FEEDER);
    expect(v.x + 0).toBe(0);
    expect(v.y + 0).toBe(0);
    expect(v.z + 0).toBe(0);
    expect(v).toEqual(ZERO);
  });

  it('combines Topspin and Sidespin', () => {
    expect(spinVector(3, 4, TOWARD_FEEDER)).toEqual({ x: -3, y: 4, z: 0 });
  });
});

describe('revsToRadPerSec', () => {
  it('converts revolutions per second to radians per second', () => {
    expect(revsToRadPerSec(1)).toBeCloseTo(2 * Math.PI, 12);
    expect(revsToRadPerSec(0)).toBe(0);
    expect(revsToRadPerSec(-2.5)).toBeCloseTo(-5 * Math.PI, 12);
  });
});
