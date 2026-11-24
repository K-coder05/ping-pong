import { describe, expect, it } from 'vitest';
import type { MotionPacket } from '../phone/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { angularSpeed, DEFAULT_PHONE_SWING_PARAMS, PhoneSwingDetector, rotationMatrix, verticalTurnRate } from './phoneSwing.ts';
import { gripMatrix, gripOrientation, makePacket, orientationFromMatrix, rotationRateTurning, type GripPose } from './phoneSwing.testkit.ts';
import type { SwingEvent } from './types.ts';

const PARAMS = DEFAULT_PHONE_SWING_PARAMS;
const DEG = Math.PI / 180;

/** Packets every 10 ms: one per angular speed, all spinning about the same axis (beta: the vertical in a right-hander's grip). */
function spins(dps: number[], startSeq = 0, startT = 1000): { p: MotionPacket; t: number }[] {
  return dps.map((d, i) => ({ p: makePacket({ seq: startSeq + i, tPhone: startT + i * 10, rot: [0, d, 0], ori: gripOrientation({ hand: 'right' }) }), t: startT + i * 10 }));
}

function zeroed(hand: Hand = 'right', neutral: GripPose = { hand }): PhoneSwingDetector {
  const d = new PhoneSwingDetector(PARAMS, hand);
  d.zero(makePacket({ seq: 0, tPhone: 0, ori: gripOrientation(neutral) }));
  return d;
}

function run(d: PhoneSwingDetector, packets: { p: MotionPacket; t: number }[]): (SwingEvent & { at: number })[] {
  const swings: (SwingEvent & { at: number })[] = [];
  packets.forEach(({ p, t }, at) => {
    const s = d.push(p, t);
    if (s) swings.push({ ...s, at });
  });
  return swings;
}

/** One stroke turning about the true vertical (+ = counterclockwise from above) in a pose, two packets at `dps`. */
function stroke(d: PhoneSwingDetector, pose: GripPose, dps: number, seq = 10, t = 2000): SwingEvent | null {
  const m = gripMatrix(pose);
  const ori = orientationFromMatrix(m);
  const rot = rotationRateTurning(m, dps);
  d.push(makePacket({ seq, tPhone: t, rot, ori }), t);
  return d.push(makePacket({ seq: seq + 1, tPhone: t + 10, rot, ori }), t + 10);
}

describe('orientation (W3C DeviceOrientation axes)', () => {
  it('angular speed is the magnitude of the rotation rate', () => {
    expect(angularSpeed([300, 400, 0])).toBe(500);
    expect(angularSpeed([-300, 0, -400])).toBe(500);
  });

  it('round-trips the test kit grips through reported angles, including the grip on its long edge (gamma = ±90°)', () => {
    for (const pose of [
      { hand: 'right' as const },
      { hand: 'left' as const },
      { hand: 'right' as const, turnDeg: 30, screenDownDeg: 40, raiseDeg: 20 },
      { hand: 'left' as const, turnDeg: -60, screenDownDeg: -35 },
    ]) {
      const m = gripMatrix(pose);
      rotationMatrix(orientationFromMatrix(m)).forEach((v, i) => expect(v).toBeCloseTo(m[i]!, 9));
    }
  });

  it('a phone flat on a table, screen up, turning counterclockwise from above is +alpha (about z)', () => {
    expect(verticalTurnRate({ ori: [0, 0, 0], rot: [100, 0, 0] })).toBeCloseTo(100);
  });

  it("in a right-hander's grip (x up) a counterclockwise turn is +beta; in a left-hander's (x down), −beta", () => {
    expect(verticalTurnRate({ ori: gripOrientation({ hand: 'right' }), rot: [0, 100, 0] })).toBeCloseTo(100);
    expect(verticalTurnRate({ ori: gripOrientation({ hand: 'left' }), rot: [0, 100, 0] })).toBeCloseTo(-100);
  });
});

describe('PhoneSwingDetector: Swing Onset', () => {
  it('emits no Swing before the first Zeroing', () => {
    const d = new PhoneSwingDetector(PARAMS, 'right');
    expect(run(d, spins([0, 900, 900, 900, 900, 0]))).toEqual([]);
    expect(d.zeroed).toBe(false);
    expect(d.attitude(makePacket({ seq: 0, tPhone: 0 }))).toBeNull();
  });

  it('needs 2 consecutive packets above onDps: Onset is the second', () => {
    const swings = run(zeroed(), spins([0, 500, 100, 500, 500, 100]));
    expect(swings).toHaveLength(1);
    expect(swings[0]!.at).toBe(4);
    expect(swings[0]!.t).toBe(1040);
  });

  it('does not count a packet exactly at onDps as above it', () => {
    expect(run(zeroed(), spins([0, 400, 400, 400]))).toEqual([]);
  });

  it('re-arms only once the speed drops below offDps', () => {
    // Onset, then hovering between offDps and onDps, then fast again after the cooldown: no new Swing.
    const hovering = [0, 500, 500, ...Array<number>(50).fill(200), 500, 500];
    expect(run(zeroed(), spins(hovering))).toHaveLength(1);
    // The same with a dip below offDps in between: a second Swing.
    const dipping = [0, 500, 500, ...Array<number>(49).fill(200), 100, 500, 500];
    expect(run(zeroed(), spins(dipping))).toHaveLength(2);
  });

  it('ignores a re-armed Swing inside the cooldown (400 ms from Onset)', () => {
    // Onset at 20 ms; re-armed at 30 ms; fast again at 40–50 ms and on until 420 ms, when the cooldown ends.
    const inside = [0, 500, 500, 100, 500, 500, 100, 500, 500];
    expect(run(zeroed(), spins(inside))).toHaveLength(1);
    const spanning = [0, 500, 500, 100, ...Array<number>(40).fill(500)];
    const swings = run(zeroed(), spins(spanning));
    expect(swings).toHaveLength(2);
    expect(swings[1]!.t - swings[0]!.t).toBe(400);
  });

  it('scales the peak over the 2 onset packets by dpsPerUnit (400 deg/s ≈ 3.3)', () => {
    const [swing] = run(zeroed(), spins([0, 480, 600, 1200]));
    expect(swing!.peakSpeed).toBe(5); // 600 / 120: the third packet comes after Onset
  });

  it('has no Lift: vertPath is 0', () => {
    expect(run(zeroed(), spins([0, 500, 500]))[0]!.vertPath).toBe(0);
  });

  it('ignores packets that arrive out of order, but not a restarted Phone page', () => {
    const d = zeroed();
    const late = (seq: number, t: number) => ({ p: makePacket({ seq, tPhone: t, rot: [0, 500, 0], ori: gripOrientation({ hand: 'right' }) }), t });
    expect(run(d, [late(10, 1000), late(9, 1010)])).toEqual([]);
    expect(run(d, [late(11, 1020)])).toHaveLength(1);
    const restarted = zeroed();
    expect(run(restarted, [late(5000, 1000), late(0, 1010), late(1, 1020)])).toHaveLength(1);
  });
});

describe('PhoneSwingDetector: Forehand or Backhand', () => {
  it("a right-hander's Forehand turns counterclockwise from above (toward their left); a Backhand clockwise", () => {
    expect(stroke(zeroed('right'), { hand: 'right' }, 600)?.side).toBe('forehand');
    expect(stroke(zeroed('right'), { hand: 'right' }, -600)?.side).toBe('backhand');
  });

  it("a left-hander's is mirrored", () => {
    expect(stroke(zeroed('left'), { hand: 'left' }, -600)?.side).toBe('forehand');
    expect(stroke(zeroed('left'), { hand: 'left' }, 600)?.side).toBe('backhand');
  });

  it('judges the turn about the true vertical, whatever the Face Angle or how far the Phone has turned', () => {
    const pose = { hand: 'right' as const, screenDownDeg: 50, turnDeg: 60, raiseDeg: 25 };
    expect(stroke(zeroed('right'), pose, 600)?.side).toBe('forehand');
    expect(stroke(zeroed('right'), pose, -600)?.side).toBe('backhand');
  });
});

describe('PhoneSwingDetector: Face Angle', () => {
  it('is + (closed) when the Forehand face (the screen) tips toward the floor, − when toward the ceiling', () => {
    expect(stroke(zeroed(), { hand: 'right', screenDownDeg: 30 }, 600)!.faceAngle).toBeCloseTo(30 * DEG, 6);
    expect(stroke(zeroed(), { hand: 'right', screenDownDeg: -30 }, 600)!.faceAngle).toBeCloseTo(-30 * DEG, 6);
    expect(stroke(zeroed('left'), { hand: 'left', screenDownDeg: 30 }, -600)!.faceAngle).toBeCloseTo(30 * DEG, 6);
  });

  it("on a Backhand it is the Backhand face's: the back of the hand toward the floor (screen up) is closed", () => {
    expect(stroke(zeroed(), { hand: 'right', screenDownDeg: -30 }, -600)!.faceAngle).toBeCloseTo(30 * DEG, 6);
    expect(stroke(zeroed(), { hand: 'right', screenDownDeg: 30 }, -600)!.faceAngle).toBeCloseTo(-30 * DEG, 6);
  });

  it('is measured from Zero', () => {
    const d = zeroed('right', { hand: 'right', screenDownDeg: 20 });
    expect(stroke(d, { hand: 'right', screenDownDeg: 20 }, 600)!.faceAngle).toBeCloseTo(0, 6);
  });

  it('is unchanged by turning or raising the Phone, only by tipping its face', () => {
    expect(stroke(zeroed(), { hand: 'right', turnDeg: 70, raiseDeg: 30 }, 600)!.faceAngle).toBeCloseTo(0, 6);
  });

  it('is continuous through the grip where the reported beta and gamma jump (gamma = ±90°)', () => {
    const d = zeroed();
    let last: number | null = null;
    for (let down = -10; down <= 10; down += 0.5) {
      const ori = gripOrientation({ hand: 'right', screenDownDeg: down, raiseDeg: 3 });
      const angle = d.attitude({ ori })!.forehandFaceAngle;
      if (last !== null) expect(Math.abs(angle - last)).toBeLessThan(1 * DEG);
      last = angle;
    }
  });

  it('gives the turn toward the hitting side since Zero', () => {
    const d = zeroed('right');
    expect(d.attitude({ ori: gripOrientation({ hand: 'right', turnDeg: -45 }) })!.turnToHitting).toBeCloseTo(45 * DEG, 6);
    expect(d.attitude({ ori: gripOrientation({ hand: 'right', turnDeg: 30 }) })!.turnToHitting).toBeCloseTo(-30 * DEG, 6);
    const l = zeroed('left');
    expect(l.attitude({ ori: gripOrientation({ hand: 'left', turnDeg: 45 }) })!.turnToHitting).toBeCloseTo(45 * DEG, 6);
  });
});
