import { describe, expect, it } from 'vitest';
import { FACE_ANGLE_DEAD_DEG, FACE_ANGLE_FULL_DEG, PHONE_SPEED_FULL, RETURN_BACKSPIN_MAX_REVS } from './constants.ts';
import { faceAngleForShare, faceAngleShare, knobFaceAngleParams } from './faceAngle.ts';

const SPEC = { deadDeg: 10, fullDeg: 45 };
const rad = (deg: number) => (deg * Math.PI) / 180;
const share = (deg: number) => faceAngleShare(rad(deg), SPEC);

describe('faceAngleShare', () => {
  it('is 0 within ±10° of Zero (the dead zone), edges included', () => {
    for (const deg of [0, 3, -3, 9.9, -9.9, 10, -10]) expect(share(deg)).toBe(0);
  });

  it('rises linearly from the dead zone to ±1 at 45°', () => {
    expect(share(27.5)).toBeCloseTo(0.5);
    expect(share(17)).toBeCloseTo(7 / 35);
    expect(share(45)).toBeCloseTo(1);
  });

  it('saturates at ±1 past 45°', () => {
    expect(share(60)).toBe(1);
    expect(share(90)).toBe(1);
    expect(share(-80)).toBe(-1);
  });

  it('is positive when closed and negative when open, by the same amount', () => {
    for (const deg of [15, 27.5, 40, 70]) {
      expect(share(deg)).toBeGreaterThan(0);
      expect(share(-deg)).toBeCloseTo(-share(deg));
    }
  });

  it('treats a non-finite Face Angle as Zero, and overlapping knobs as a step', () => {
    expect(faceAngleShare(Number.NaN, SPEC)).toBe(0);
    expect(faceAngleShare(rad(20), { deadDeg: 30, fullDeg: 30 })).toBe(0);
    expect(faceAngleShare(rad(-31), { deadDeg: 30, fullDeg: 30 })).toBe(-1);
  });
});

describe('faceAngleForShare', () => {
  it('is Zero for no Spin, and inverts faceAngleShare outside the dead zone', () => {
    expect(faceAngleForShare(0, SPEC)).toBe(0);
    for (const f of [-1, -0.6, -0.2, 0.3, 0.75, 1]) expect(faceAngleShare(faceAngleForShare(f, SPEC), SPEC)).toBeCloseTo(f);
    expect(faceAngleForShare(1, SPEC)).toBeCloseTo(rad(45));
    expect(faceAngleForShare(-3, SPEC)).toBeCloseTo(rad(-45));
  });
});

describe('knobFaceAngleParams', () => {
  it('reads the spec P3-f starting values from the knobs', () => {
    expect(knobFaceAngleParams()).toEqual({ deadDeg: 10, fullDeg: 45, backspinMaxRevs: RETURN_BACKSPIN_MAX_REVS.value, speedFull: 7.5 });
    expect([FACE_ANGLE_DEAD_DEG.value, FACE_ANGLE_FULL_DEG.value, PHONE_SPEED_FULL.value]).toEqual([10, 45, 7.5]);
  });

  it('applies the knobs live', () => {
    try {
      FACE_ANGLE_DEAD_DEG.set(5);
      expect(knobFaceAngleParams().deadDeg).toBe(5);
    } finally {
      FACE_ANGLE_DEAD_DEG.reset();
    }
  });
});
