import { describe, expect, it } from 'vitest';
import { PACKET_BYTES, decodePacket, encodePacket } from './packet.ts';
import type { MotionPacket } from './types.ts';

/** What a float32 field gives back: the nearest float32 to each value. */
function asSent(p: MotionPacket): MotionPacket {
  const f = (xs: [number, number, number]) => xs.map(Math.fround) as [number, number, number];
  return { seq: p.seq, tPhone: p.tPhone, rot: f(p.rot), acc: f(p.acc), ori: f(p.ori) };
}

describe('encodePacket / decodePacket', () => {
  it('is fixed size', () => {
    const small: MotionPacket = { seq: 0, tPhone: 0, rot: [0, 0, 0], acc: [0, 0, 0], ori: [0, 0, 0] };
    const big: MotionPacket = { seq: 4_294_967_295, tPhone: 1e15, rot: [-1e6, 1e6, 3.3], acc: [1, 2, 3], ori: [359.9, -180, 90] };
    expect(encodePacket(small).byteLength).toBe(PACKET_BYTES);
    expect(encodePacket(big).byteLength).toBe(PACKET_BYTES);
    expect(PACKET_BYTES).toBe(48);
  });

  it('round-trips integer-valued fields exactly', () => {
    const p: MotionPacket = { seq: 7, tPhone: 1234, rot: [100, -250, 0], acc: [0, -9, 9], ori: [180, -90, 45] };
    expect(decodePacket(encodePacket(p))).toEqual(p);
  });

  it('round-trips negative and large values: seq and tPhone exactly, sensor values to float32', () => {
    const p: MotionPacket = {
      seq: 4_294_967_295, // largest uint32
      tPhone: 98_765_432.123_456_7, // over a day of performance.now(), sub-ms
      rot: [-1999.123_456, 2000.987_654, -0.000_123],
      acc: [-78.4532, 39.2266, -9.806_65],
      ori: [359.999_99, -179.999_9, -89.123_45],
    };
    const back = decodePacket(encodePacket(p));
    expect(back).toEqual(asSent(p));
    expect(back.seq).toBe(p.seq);
    expect(back.tPhone).toBe(p.tPhone);
    // Honest about precision: float32 is not exact, but within 2^-24 relative (round to nearest).
    expect(back.rot[0]).not.toBe(p.rot[0]);
    for (const k of ['rot', 'acc', 'ori'] as const) {
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(back[k][i]! - p[k][i]!)).toBeLessThanOrEqual(Math.abs(p[k][i]!) * 2 ** -24);
      }
    }
  });

  it('keeps tPhone to the microsecond after ten hours (float32 would be off by over a ms)', () => {
    const tPhone = 36_000_122.001; // 10 h in ms, where float32 steps by 4 ms
    expect(decodePacket(encodePacket({ seq: 1, tPhone, rot: [0, 0, 0], acc: [0, 0, 0], ori: [0, 0, 0] })).tPhone).toBe(tPhone);
    expect(Math.abs(Math.fround(tPhone) - tPhone)).toBeGreaterThan(1);
  });

  it('sensor values beyond float32 range become ±Infinity; NaN stays NaN', () => {
    // No real sensor gets near 3.4e38; this pins down what the wire does if one did.
    const p: MotionPacket = { seq: 0, tPhone: 0, rot: [1e39, -1e39, Number.NaN], acc: [0, 0, 0], ori: [0, 0, 0] };
    expect(decodePacket(encodePacket(p)).rot).toEqual([Infinity, -Infinity, Number.NaN]);
  });

  it('wraps seq modulo 2^32', () => {
    const p: MotionPacket = { seq: 2 ** 32 + 5, tPhone: 0, rot: [0, 0, 0], acc: [0, 0, 0], ori: [0, 0, 0] };
    expect(decodePacket(encodePacket(p)).seq).toBe(5);
  });

  it('rejects a buffer of the wrong size', () => {
    expect(() => decodePacket(new ArrayBuffer(47))).toThrow(/48 bytes/);
    expect(() => decodePacket(new ArrayBuffer(0))).toThrow();
  });
});
