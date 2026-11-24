import { describe, expect, it } from 'vitest';
import { TABLE_TOP_Y } from '../game/constants.ts';
import { PADDLE_BLADE_THICKNESS, contactAssistWeight, createPaddle, extrapolateHand, type PaddleParams, swingFrameAt, tipByFaceAngle, wristToPaddle, type SwingAnimation } from './paddle.ts';

const REST_PY = 0.75;

describe('wrist → Paddle mapping', () => {
  const at = (u: number, py = REST_PY, hand: 'left' | 'right' = 'right', rangeSw = 2) =>
    wristToPaddle({ u, py }, { hand, rangeSw, restPy: REST_PY });

  it("spans the table's width over ±range shoulder widths, the hitting side on the hitting hand's side of the screen", () => {
    expect(at(2).x).toBeCloseTo(0.76, 2); // right-hander's hitting side is the player's right: +x, screen right
    expect(at(-2).x).toBeCloseTo(-0.76, 2);
    expect(at(1).x).toBeCloseTo(0.38, 2);
    expect(at(0).x).toBe(0);
  });

  it('mirrors for a left-hander, so the Paddle moves like the hand in the mirrored video', () => {
    expect(at(2, REST_PY, 'left').x).toBeCloseTo(-0.76, 2);
  });

  it('stops at the table edges', () => {
    expect(at(5).x).toBeCloseTo(0.76, 2);
    expect(at(-5).x).toBeCloseTo(-0.76, 2);
  });

  it('takes the range as a knob', () => {
    expect(at(1, REST_PY, 'right', 1).x).toBeCloseTo(0.76, 2);
  });

  it('raises the Paddle as the wrist rises (image y grows downward)', () => {
    const rest = at(0).y;
    expect(rest).toBeGreaterThan(TABLE_TOP_Y);
    expect(at(0, REST_PY - 0.5).y).toBeCloseTo(rest + 0.19, 2); // half a shoulder width = 0.19 m at range 2
    expect(at(0, REST_PY + 0.2).y).toBeLessThan(rest);
  });

  it('keeps the Paddle above the table top', () => {
    expect(at(0, REST_PY + 10).y).toBeGreaterThan(TABLE_TOP_Y);
  });
});

describe('Swing animation', () => {
  const forehand = (contactAtMs: number): SwingAnimation => ({ onsetMs: 1000, contactAtMs, side: 'forehand' });
  const backhand = (contactAtMs: number): SwingAnimation => ({ onsetMs: 1000, contactAtMs, side: 'backhand' });

  it('starts wound up at Swing Onset: a Forehand back and on the hitting side', () => {
    const frame = swingFrameAt(forehand(1300), 1000, 'right');
    expect(frame.phase).toBe('wind-up');
    expect(frame.offset.x).toBeGreaterThan(0); // right-hander's hitting side
    expect(frame.offset.z).toBeGreaterThan(0); // back, toward the player
  });

  it('lands its contact frame exactly at the contact moment', () => {
    const frame = swingFrameAt(forehand(1300), 1300, 'right');
    expect(frame.phase).toBe('follow-through');
    expect(frame.progress).toBe(0);
    expect(frame.offset).toEqual({ x: 0, y: 0, z: 0 });
    expect(swingFrameAt(forehand(1300), 1299, 'right').phase).toBe('wind-up');
  });

  it('stretches the wind-up for an early Swing and compresses it for a late one', () => {
    expect(swingFrameAt(forehand(1600), 1300, 'right').progress).toBeCloseTo(0.5); // early: contact 600 ms after Onset
    expect(swingFrameAt(forehand(1040), 1020, 'right').progress).toBeCloseTo(0.5); // late: contact 40 ms after Onset
  });

  it('goes straight to contact when contact is due at Onset', () => {
    expect(swingFrameAt(forehand(1000), 1000, 'right').offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('follows a Forehand through toward the non-hitting side, forward and up, then settles back on the wrist', () => {
    const through = swingFrameAt(forehand(1300), 1450, 'right');
    expect(through.offset.x).toBeLessThan(0);
    expect(through.offset.z).toBeLessThan(0);
    expect(through.offset.y).toBeGreaterThan(0);
    const done = swingFrameAt(forehand(1300), 3000, 'right');
    expect(done.phase).toBe('done');
    expect(done.offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('winds a Backhand up on the non-hitting side and follows through toward the hitting side', () => {
    expect(swingFrameAt(backhand(1300), 1000, 'right').offset.x).toBeLessThan(0);
    expect(swingFrameAt(backhand(1300), 1450, 'right').offset.x).toBeGreaterThan(0);
  });

  it('turns the blade over for a Backhand', () => {
    expect(swingFrameAt(forehand(1300), 1300, 'right').backhandFace).toBe(false);
    expect(swingFrameAt(backhand(1300), 1300, 'right').backhandFace).toBe(true);
  });

  it("mirrors a left-hander's Swings", () => {
    expect(swingFrameAt(forehand(1300), 1000, 'left').offset.x).toBeLessThan(0);
    expect(swingFrameAt(backhand(1300), 1000, 'left').offset.x).toBeGreaterThan(0);
  });
});

describe('contact assist easing', () => {
  const swing: SwingAnimation = { onsetMs: 1000, contactAtMs: 1300, side: 'forehand' };

  it('eases from the wrist at Onset fully onto the ball at the contact moment', () => {
    expect(contactAssistWeight(swing, 1000)).toBe(0);
    const mid = contactAssistWeight(swing, 1150);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(contactAssistWeight(swing, 1250)).toBeGreaterThan(mid);
    expect(contactAssistWeight(swing, 1300)).toBe(1);
  });

  it('is fully on the ball at contact even when contact is due at Onset (a late Swing)', () => {
    expect(contactAssistWeight({ ...swing, contactAtMs: 1000 }, 1000)).toBe(1);
  });

  it('then hands the Paddle back to the wrist as the Swing finishes', () => {
    const after = contactAssistWeight(swing, 1500);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(1);
    expect(contactAssistWeight(swing, 1300 + 2000)).toBe(0);
  });
});

describe('latency extrapolation', () => {
  const prev = { t: 1000, u: 0, py: 1 };
  const latest = { t: 1020, u: 0.2, py: 0.9 }; // 10 shoulder widths/s along the body axis, 5 upward

  it('draws the wrist ahead by its current velocity times the latency', () => {
    const ahead = extrapolateHand(prev, latest, 100, 1030);
    expect(ahead.u).toBeCloseTo(1.2);
    expect(ahead.py).toBeCloseTo(0.4);
  });

  it('stays on the wrist with no motion to go on', () => {
    expect(extrapolateHand(null, latest, 100, 1030)).toEqual(latest);
    expect(extrapolateHand(latest, latest, 100, 1030)).toEqual(latest);
  });

  it('stays on the wrist once samples stop arriving (the hand has stopped, or tracking stalled)', () => {
    expect(extrapolateHand(prev, latest, 100, 1020 + 500)).toEqual(latest);
  });
});

describe('the Paddle', () => {
  /** Where the resolver will strike the ball: on the player's left, at the end line. */
  const BALL_AT_CONTACT = { x: -0.3, y: 1.0, z: 1.37 };
  /** The ball is drawn at twice its 0.02 m radius, lifted so its bottom stays put: its centre is 0.02 m higher. */
  const DRAWN_RADIUS = 0.04;
  const WRIST = { u: 1, py: REST_PY }; // a shoulder width out on the hitting side: x = 0.38 m

  function paddle(overrides: Partial<PaddleParams> = {}) {
    const params: PaddleParams = { rangeSw: 2, contactAssist: true, latencyExtrapolation: false, latencyMs: 100, ballDrawScale: 2, ...overrides };
    return createPaddle({ params: () => params, hand: () => 'right', predictContact: () => BALL_AT_CONTACT });
  }

  /** Accept a Swing at Onset 1000 with contact due at `contactAtMs`, then strike at that moment; the Paddle's pose there. */
  function poseAtContact(contactAtMs: number, overrides: Partial<PaddleParams> = {}) {
    const p = paddle(overrides);
    p.update(990, { t: 990, ...WRIST });
    p.swing({ onsetMs: 1000, contactAtMs, side: 'forehand' });
    p.update((1000 + contactAtMs) / 2, { t: (1000 + contactAtMs) / 2, ...WRIST });
    p.contact(contactAtMs, BALL_AT_CONTACT);
    return p.update(contactAtMs, { t: contactAtMs, ...WRIST });
  }

  it('follows the wrist', () => {
    const pose = paddle().update(1000, { t: 1000, ...WRIST });
    expect(pose.position.x).toBeCloseTo(0.38, 2);
  });

  it('rests at the centre while the wrist is unknown', () => {
    expect(paddle().update(1000, null).position.x).toBe(0);
  });

  it.each([
    ['early', 1400],
    ['on time', 1150],
    ['late', 1030],
  ])('meets the ball from behind at contact for an %s Swing', (_timing, contactAtMs) => {
    const { position } = poseAtContact(contactAtMs);
    expect(position.x).toBeCloseTo(BALL_AT_CONTACT.x);
    expect(position.y).toBeCloseTo(BALL_AT_CONTACT.y + 0.02);
    expect(position.z).toBeCloseTo(BALL_AT_CONTACT.z + DRAWN_RADIUS + PADDLE_BLADE_THICKNESS / 2);
  });

  it('meets the ball at the actual contact, a frame after the planned one', () => {
    const p = paddle();
    p.swing({ onsetMs: 1000, contactAtMs: 1200, side: 'forehand' });
    p.contact(1212, BALL_AT_CONTACT);
    expect(p.update(1212, { t: 1212, ...WRIST }).position.x).toBeCloseTo(BALL_AT_CONTACT.x);
  });

  it('shows the real gap at contact with contact assist off', () => {
    const { position } = poseAtContact(1150, { contactAssist: false });
    expect(position.x).toBeCloseTo(0.38, 2);
  });

  it('returns to following the wrist once the Swing is over', () => {
    const p = paddle();
    p.swing({ onsetMs: 1000, contactAtMs: 1150, side: 'forehand' });
    p.contact(1150, BALL_AT_CONTACT);
    expect(p.update(3000, { t: 3000, ...WRIST }).position.x).toBeCloseTo(0.38, 2);
  });

  it('draws ahead of a moving wrist with latency extrapolation on', () => {
    const run = (latencyExtrapolation: boolean) => {
      const p = paddle({ latencyExtrapolation });
      p.update(1000, { t: 1000, u: 0, py: REST_PY });
      return p.update(1020, { t: 1020, u: 0.2, py: REST_PY }).position.x;
    };
    expect(run(false)).toBeCloseTo(0.0763, 3); // 0.2 shoulder widths at 0.381 m each (half the 1.525 m table per 2)
    expect(run(true)).toBeCloseTo(0.4575, 3); // 0.2 + 10 sw/s × 100 ms = 1.2 shoulder widths
  });

  it("tips by the Phone's Face Angle: closed tilts the face forward, even drawn ahead by latency extrapolation", () => {
    expect(paddle().update(1000, { t: 1000, ...WRIST, faceAngle: 0.4 }).pitch).toBeCloseTo(0.4);
    expect(paddle().update(1000, { t: 1000, ...WRIST, faceAngle: -0.3 }).pitch).toBeCloseTo(-0.3);
    const p = paddle({ latencyExtrapolation: true });
    p.update(1000, { t: 1000, ...WRIST, faceAngle: 0.2 });
    expect(p.update(1020, { t: 1020, u: 1.1, py: REST_PY, faceAngle: 0.2 }).pitch).toBeCloseTo(0.2);
    expect(paddle().update(1000, { t: 1000, ...WRIST }).pitch).toBe(0);
  });

  it('adds the Face Angle to the Swing animation, the other way when the Backhand face is shown', () => {
    const p = paddle({ contactAssist: false });
    p.swing({ onsetMs: 1000, contactAtMs: 1150, side: 'backhand' });
    const plain = swingFrameAt({ onsetMs: 1000, contactAtMs: 1150, side: 'backhand' }, 1100, 'right').pitch;
    // The Phone's Forehand face closed by 0.3 is the Backhand face open by 0.3.
    expect(p.update(1100, { t: 1100, ...WRIST, faceAngle: 0.3 }).pitch).toBeCloseTo(plain - 0.3);
    expect(tipByFaceAngle(0.1, false, 0.3)).toBeCloseTo(0.4);
    expect(tipByFaceAngle(0.1, true, 0.3)).toBeCloseTo(-0.2);
  });

  it('measures the velocity it extrapolates over a window, so one jittery sample is not magnified', () => {
    const p = paddle({ latencyExtrapolation: true });
    // Steady at 10 shoulder widths/s, sampled every 16 ms, then one sample jitters back by 0.05.
    for (let t = 1000; t <= 1064; t += 16) p.update(t, { t, u: (t - 1000) / 100, py: REST_PY });
    const jittered = p.update(1080, { t: 1080, u: 0.8 - 0.05, py: REST_PY }).position.x;
    // Two-sample velocity would give (0.75 − 0.64) / 16 ms × 100 ms = 0.69 sw ahead; the 64 ms window gives (0.75 − 0.16) / 64 ms × 100 ms ≈ 0.92.
    const windowed = 0.75 + ((0.75 - 0.16) / 64) * 100;
    expect(jittered).toBeCloseTo(windowed * (0.7625 / 2), 3);
  });
});
