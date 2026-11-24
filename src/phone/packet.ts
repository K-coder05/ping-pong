/**
 * Motion packets on the wire (docs/specs/p3.md, P3-a): one fixed-size binary
 * message per sensor event on the lossy `motion` channel.
 *
 * Layout, little-endian, `PACKET_BYTES` = 48:
 *
 * | Offset | Field                | Type    | Precision                                                    |
 * | ------ | -------------------- | ------- | ------------------------------------------------------------ |
 * | 0      | seq                  | uint32  | exact for 0 … 2³²−1; other values wrap modulo 2³²             |
 * | 4      | tPhone               | float64 | exact (a JS number)                                           |
 * | 12     | rot alpha/beta/gamma | float32 | relative error ≤ 2⁻²⁴ (≈ 6e-8): within 0.0001 deg/s at 2000 deg/s |
 * | 24     | acc x/y/z            | float32 | relative error ≤ 2⁻²⁴: within 0.000001 m/s² at 9.8 m/s²       |
 * | 36     | ori alpha/beta/gamma | float32 | relative error ≤ 2⁻²⁴: within 0.00002 deg at 360 deg          |
 *
 * Sensor values come back as `Math.fround` of what was sent: far finer than
 * any Phone's sensor noise. Beyond float32's range (±3.4e38) they become
 * ±Infinity; NaN stays NaN. `tPhone` stays float64 because float32 would lose
 * whole milliseconds after a few hours of `performance.now()`. At 2³²
 * packets, `seq` wraps; that is over 200 days at 200 Hz.
 */
import type { MotionPacket } from './types.ts';

export const PACKET_BYTES = 48;

const SEQ = 0;
const T_PHONE = 4;
const ROT = 12;
const ACC = 24;
const ORI = 36;
const F32 = 4;

export function encodePacket(p: MotionPacket): ArrayBuffer {
  const buf = new ArrayBuffer(PACKET_BYTES);
  const v = new DataView(buf);
  v.setUint32(SEQ, p.seq >>> 0, true);
  v.setFloat64(T_PHONE, p.tPhone, true);
  for (let i = 0; i < 3; i++) {
    v.setFloat32(ROT + i * F32, p.rot[i]!, true);
    v.setFloat32(ACC + i * F32, p.acc[i]!, true);
    v.setFloat32(ORI + i * F32, p.ori[i]!, true);
  }
  return buf;
}

/** Throws on a buffer that isn't exactly `PACKET_BYTES` long. */
export function decodePacket(b: ArrayBuffer): MotionPacket {
  if (b.byteLength !== PACKET_BYTES) throw new Error(`motion packet must be ${PACKET_BYTES} bytes, got ${b.byteLength}`);
  const v = new DataView(b);
  const three = (at: number): [number, number, number] => [
    v.getFloat32(at, true),
    v.getFloat32(at + F32, true),
    v.getFloat32(at + 2 * F32, true),
  ];
  return {
    seq: v.getUint32(SEQ, true),
    tPhone: v.getFloat64(T_PHONE, true),
    rot: three(ROT),
    acc: three(ACC),
    ori: three(ORI),
  };
}
