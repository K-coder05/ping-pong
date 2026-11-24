import { describe, expect, it } from 'vitest';
import type { ControlMessage, LinkStatus, MotionPacket, PhoneLink } from '../phone/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { createPhoneInput, createPhoneInputCore, naiveOffset, PHONE_STALE_MS, replayPhoneLog } from './phoneInput.ts';
import { gripMatrix, makePacket, orientationFromMatrix, rotationRateTurning, syntheticClip } from './phoneSwing.testkit.ts';
import type { SwingEvent } from './types.ts';

const DEG = Math.PI / 180;

/** A fast packet in the right-hander's grip, turning toward their left (a Forehand) with the screen tipped down. */
function fast(seq: number, tPhone: number, screenDownDeg = 0, dps = 600): MotionPacket {
  const m = gripMatrix({ hand: 'right', screenDownDeg });
  return makePacket({ seq, tPhone, rot: rotationRateTurning(m, dps), ori: orientationFromMatrix(m) });
}

function still(seq: number, tPhone: number, pose: Parameters<typeof gripMatrix>[0] = { hand: 'right' }): MotionPacket {
  return makePacket({ seq, tPhone, ori: orientationFromMatrix(gripMatrix(pose)) });
}

describe('naiveOffset', () => {
  it('adds nothing before the first packet', () => {
    expect(naiveOffset().toLocal(123)).toBe(123);
  });

  it('uses the smallest (tRecv − tPhone) over the last 2 s', () => {
    const o = naiveOffset();
    o.observe(1000, 6020); // 5020
    o.observe(1010, 6015); // 5005: the fastest
    o.observe(1020, 6050); // 5030
    expect(o.toLocal(1100)).toBe(6105);
  });

  it('forgets packets older than 2 s', () => {
    const o = naiveOffset();
    o.observe(1000, 6005); // 5005
    o.observe(1500, 6520); // 5020
    o.observe(3200, 8230); // 5030; the 5005 is now 2,225 ms old
    expect(o.toLocal(0)).toBe(5020);
    o.observe(3600, 8640); // 5040; the 5020 is 2,120 ms old
    expect(o.toLocal(0)).toBe(5030);
  });
});

describe('createPhoneInputCore', () => {
  const core = (hand: () => Hand = () => 'right') => createPhoneInputCore({ offset: naiveOffset(), hand });

  it('emits no Swings and no position before the first Zeroing', () => {
    const c = core();
    expect([fast(0, 0), fast(1, 10), fast(2, 20)].map((p) => c.packet(p, p.tPhone + 5000))).toEqual([null, null, null]);
    expect(c.position).toBeNull();
  });

  it('makes the packet after a Zeroing the neutral one', () => {
    const c = core();
    c.packet(still(0, 0, { hand: 'right', screenDownDeg: 40 }), 5000);
    c.zero();
    // Not yet: the Zeroing waits for the next packet.
    expect(c.position).toBeNull();
    c.packet(still(1, 10, { hand: 'right', screenDownDeg: 20 }), 5010);
    expect(c.position!.faceAngle).toBeCloseTo(0, 6);
    c.packet(still(2, 20, { hand: 'right', screenDownDeg: 50 }), 5020);
    expect(c.position!.faceAngle).toBeCloseTo(30 * DEG, 6);
  });

  it('defers a Zeroing held during a Rally to the first packet after the Rally', () => {
    const c = core();
    c.zero();
    c.packet(still(0, 0, { hand: 'right', screenDownDeg: 20 }), 5000); // Zeroed here, between Rallies
    c.setZeroHold(true); // a Rally begins
    c.zero(); // tapped mid-Rally
    c.packet(still(1, 10, { hand: 'right', screenDownDeg: 50 }), 5010);
    c.packet(still(2, 20, { hand: 'right', screenDownDeg: 50 }), 5020);
    expect(c.position!.faceAngle).toBeCloseTo(30 * DEG, 6); // no jump during the Rally
    c.setZeroHold(false); // the Rally ends
    c.packet(still(3, 30, { hand: 'right', screenDownDeg: 50 }), 5030);
    expect(c.position!.faceAngle).toBeCloseTo(0, 6);
  });

  it('applies a Zeroing between Rallies to the next packet', () => {
    const c = core();
    c.setZeroHold(false);
    c.zero();
    c.packet(still(0, 0, { hand: 'right', screenDownDeg: 40 }), 5000);
    expect(c.position!.faceAngle).toBeCloseTo(0, 6);
  });

  it('puts Swings on the laptop clock, never later than they arrived', () => {
    const c = core();
    c.zero();
    c.packet(still(0, 100), 5108); // offset 5008
    c.packet(fast(1, 110), 5130); // 5020
    const swing = c.packet(fast(2, 120), 5129); // 5009
    expect(swing).toMatchObject({ t: 5128, side: 'forehand', vertPath: 0 });
  });

  it('puts the Paddle at the hitting point, shifted a shoulder width per 45° of turn toward the hitting side, carrying the Face Angle', () => {
    const c = core();
    c.zero();
    c.packet(still(0, 0), 5000);
    expect(c.position).toMatchObject({ t: 5000, u: 1, py: 0, faceAngle: 0 });
    c.packet(still(1, 10, { hand: 'right', turnDeg: -22.5 }), 5010); // toward a right-hander's right
    expect(c.position!.u).toBeCloseTo(1.5, 6);
    c.packet(still(2, 20, { hand: 'right', turnDeg: 90, screenDownDeg: -20 }), 5020); // far to the left: capped
    expect(c.position!.u).toBeCloseTo(0, 6);
    expect(c.position!.faceAngle).toBeCloseTo(-20 * DEG, 6);
  });

  it('follows a change of hitting hand, keeping the Zero', () => {
    let hand: Hand = 'right';
    const c = core(() => hand);
    c.zero();
    c.packet(still(0, 0), 5000);
    hand = 'left';
    // The same counterclockwise turn is now a left-hander's Backhand.
    c.packet(fast(1, 10), 5010);
    expect(c.packet(fast(2, 20), 5020)?.side).toBe('backhand');
  });
});

describe('replayPhoneLog', () => {
  it('replays a recorded clip: Zeroing, then one Swing', () => {
    const swings = replayPhoneLog(syntheticClip({ hand: 'right', side: 'forehand', screenDownDeg: 30 }), 'right');
    expect(swings).toHaveLength(1);
    expect(swings[0]!.side).toBe('forehand');
    expect(swings[0]!.faceAngle).toBeCloseTo(30 * DEG, 6);
  });

  it('finds no Swing in a clip without a Zeroing', () => {
    const clip = syntheticClip({ hand: 'right', side: 'forehand' }).filter((e) => e.type === 'packet');
    expect(replayPhoneLog(clip, 'right')).toEqual([]);
  });
});

/** A link the test drives: `packet` and `control` play the Phone. */
function fakeLink() {
  const packetCbs = new Set<(p: MotionPacket, tRecv: number) => void>();
  const controlCbs = new Set<(m: ControlMessage, tRecv: number) => void>();
  const link: PhoneLink = {
    status: (): LinkStatus => 'connected',
    onStatus: () => () => {},
    onPacket: (cb) => (packetCbs.add(cb), () => packetCbs.delete(cb)),
    onControl: (cb) => (controlCbs.add(cb), () => controlCbs.delete(cb)),
    sendPacket: () => {},
    sendControl: () => {},
    close: () => {},
  };
  return {
    link,
    packet: (p: MotionPacket, tRecv: number) => packetCbs.forEach((cb) => cb(p, tRecv)),
    control: (m: ControlMessage, tRecv: number) => controlCbs.forEach((cb) => cb(m, tRecv)),
  };
}

describe('createPhoneInput', () => {
  it('Zeroes on a zero control message and emits Swings to subscribers', () => {
    const phone = fakeLink();
    let now = 0;
    const input = createPhoneInput(phone.link, () => now, naiveOffset(), () => 'right');
    const swings: SwingEvent[] = [];
    input.subscribe((s) => swings.push(s));

    phone.packet(fast(0, 0), 5000);
    phone.packet(fast(1, 10), 5010);
    expect(swings).toEqual([]); // not Zeroed yet
    expect(input.zeroed).toBe(false);
    phone.control({ type: 'ping', t0: 1 }, 5015);
    phone.control({ type: 'zero' }, 5020);
    expect(input.zeroed).toBe(false); // applied to the next packet
    phone.packet(still(2, 20), 5020);
    expect(input.zeroed).toBe(true);
    now = 5020;
    expect(input.latest).toMatchObject({ u: 1, py: 0 });
    phone.packet(fast(3, 30, 25), 5030);
    phone.packet(fast(4, 40, 25), 5040);
    expect(swings).toHaveLength(1);
    expect(swings[0]!.faceAngle).toBeCloseTo(25 * DEG, 6);
  });

  it('holds a Zero control message through a Rally and applies it afterwards', () => {
    const phone = fakeLink();
    const input = createPhoneInput(phone.link, () => 5000, naiveOffset(), () => 'right');
    input.setZeroHold(true);
    phone.control({ type: 'zero' }, 5000);
    phone.packet(still(0, 0), 5000);
    expect(input.zeroed).toBe(false);
    input.setZeroHold(false);
    phone.packet(still(1, 10), 5010);
    expect(input.zeroed).toBe(true);
  });

  it('has no hand position once the Phone has gone quiet', () => {
    const phone = fakeLink();
    let now = 5000;
    const input = createPhoneInput(phone.link, () => now, naiveOffset(), () => 'right');
    phone.control({ type: 'zero' }, 5000);
    phone.packet(still(0, 0), 5000);
    expect(input.latest).not.toBeNull();
    now = 5000 + PHONE_STALE_MS + 1;
    expect(input.latest).toBeNull();
  });
});
