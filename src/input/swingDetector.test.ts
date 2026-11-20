import { describe, expect, it } from 'vitest';
import type { Hand, Point2 } from '../sensing/landmarks.ts';
import { createSwingDetector, type SwingDetectorInput, type SwingParams } from './swingDetector.ts';
import type { SwingEvent } from './types.ts';

const FRAME_MS = 1000 / 30;
const PARAMS: SwingParams = { swingOn: 3, swingOff: 1, cooldownMs: 400 };

/**
 * A wrist position in body terms, in shoulder widths: `u` toward the hitting
 * side from the midline, `up` above shoulder height.
 */
interface BodyPoint {
  u: number;
  up: number;
}

interface Player {
  hand: Hand;
  /** Whether the image is mirrored (it must not matter). */
  mirrored?: boolean;
  /** Shoulder width in normalized image units. */
  shoulderWidth?: number;
}

/**
 * A player facing the camera: in the unmirrored image the person's right
 * shoulder is on the image's left.
 */
function framesFor(player: Player, path: BodyPoint[], startT = 1000, frameMs = FRAME_MS): SwingDetectorInput[] {
  const sw = player.shoulderWidth ?? 0.2;
  const mid = { x: 0.5, y: 0.4 };
  let towardHitting = player.hand === 'right' ? -1 : 1;
  if (player.mirrored) towardHitting = -towardHitting;
  const toImage = (u: number, up: number): Point2 => ({ x: mid.x + towardHitting * u * sw, y: mid.y - up * sw });
  return path.map((point, i) => ({
    t: startT + i * frameMs,
    wrist: toImage(point.u, point.up),
    hittingShoulder: toImage(0.5, 0),
    otherShoulder: toImage(-0.5, 0),
  }));
}

/** Holds still at `at` for `ms`. */
function hold(at: BodyPoint, ms: number): BodyPoint[] {
  return Array.from({ length: Math.round(ms / FRAME_MS) }, () => ({ ...at }));
}

/** Moves at constant speed from `from` to `to` over `ms` (endpoint included, start excluded). */
function move(from: BodyPoint, to: BodyPoint, ms: number): BodyPoint[] {
  const n = Math.max(1, Math.round(ms / FRAME_MS));
  return Array.from({ length: n }, (_, i) => {
    const k = (i + 1) / n;
    return { u: from.u + (to.u - from.u) * k, up: from.up + (to.up - from.up) * k };
  });
}

/** A path made of segments, each starting where the last one ended. */
function path(start: BodyPoint, ...segments: ((from: BodyPoint) => BodyPoint[])[]): BodyPoint[] {
  const points: BodyPoint[] = [start];
  for (const segment of segments) points.push(...segment(points[points.length - 1]!));
  return points;
}
const stay = (ms: number) => (from: BodyPoint) => hold(from, ms);
const to = (target: BodyPoint, ms: number) => (from: BodyPoint) => move(from, target, ms);

function run(frames: SwingDetectorInput[], params: SwingParams = PARAMS): SwingEvent[] {
  const detector = createSwingDetector(() => params);
  return frames.flatMap((frame) => detector.update(frame) ?? []);
}

/** Same Onsets, up to floating-point rounding. */
function expectSameSwings(actual: SwingEvent[], expected: SwingEvent[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((swing, i) => {
    expect(actual[i]).toEqual({ ...swing, peakSpeed: expect.closeTo(swing.peakSpeed), vertPath: expect.closeTo(swing.vertPath) });
  });
}

/** Ready on the hitting side, Backswing further out, then sweep across the body (~9 sw/s). */
const FOREHAND = path(
  { u: 1.2, up: -0.5 },
  stay(300),
  to({ u: 2, up: -0.4 }, 250), // Backswing: away from the ball
  stay(100),
  to({ u: -0.7, up: 0.1 }, 300), // stroke toward the non-hitting side
  stay(500),
);

/** Ready across the body, Backswing toward the other shoulder, then sweep out to the hitting side. */
const BACKHAND = path(
  { u: -0.3, up: -0.5 },
  stay(300),
  to({ u: -1, up: -0.5 }, 250), // Backswing
  stay(100),
  to({ u: 1.5, up: -0.1 }, 300), // stroke toward the hitting side
  stay(500),
);

describe('swing detector', () => {
  for (const hand of ['right', 'left'] as const) {
    describe(`${hand}-handed player`, () => {
      it('fires exactly one Forehand Onset for a Forehand Swing', () => {
        const swings = run(framesFor({ hand }, FOREHAND));
        expect(swings).toHaveLength(1);
        expect(swings[0]!.side).toBe('forehand');
      });

      it('fires exactly one Backhand Onset for a Backhand Swing', () => {
        const swings = run(framesFor({ hand }, BACKHAND));
        expect(swings).toHaveLength(1);
        expect(swings[0]!.side).toBe('backhand');
      });

      it('never fires on a fast Backswing on either side', () => {
        const forehandBackswing = path({ u: 0.8, up: -0.5 }, stay(200), to({ u: 2.5, up: -0.3 }, 150), stay(500));
        const backhandBackswing = path({ u: -0.1, up: -0.5 }, stay(200), to({ u: -1.5, up: -0.3 }, 150), stay(500));
        expect(run(framesFor({ hand }, forehandBackswing))).toEqual([]);
        expect(run(framesFor({ hand }, backhandBackswing))).toEqual([]);
      });

      it('never fires on fast up and down arm movement', () => {
        const raiseAndLower = path({ u: 0.8, up: -1.5 }, stay(200), to({ u: 0.9, up: 1 }, 200), to({ u: 0.8, up: -1.5 }, 200), stay(200));
        const acrossBodyUpDown = path({ u: -0.4, up: -1.5 }, stay(200), to({ u: -0.3, up: 1 }, 200), to({ u: -0.4, up: -1.5 }, 200), stay(200));
        expect(run(framesFor({ hand }, raiseAndLower))).toEqual([]);
        expect(run(framesFor({ hand }, acrossBodyUpDown))).toEqual([]);
      });
    });
  }

  it('never fires when the torso turns for a Backswing and unwinds while the wrist stays put', () => {
    // From the #12 logs: turning side-on shrinks the shoulder width on screen
    // to a fraction of its size and shifts the midpoint. Unwinding brings both
    // back fast, which moves the wrist relative to the midline even though the
    // wrist itself barely moves.
    const wrist = { x: 0.12, y: 0.55 };
    const at = (i: number, halfWidth: number, midX: number): SwingDetectorInput => ({
      t: 1000 + i * 43,
      wrist: { x: wrist.x + i * 0.001, y: wrist.y },
      hittingShoulder: { x: midX - halfWidth, y: 0.4 },
      otherShoulder: { x: midX + halfWidth, y: 0.4 },
    });
    const turned = [0.1, 0.1, 0.1, 0.1, 0.06, 0.03, 0.015, 0.015, 0.015];
    const unwinding = [0.03, 0.05, 0.07, 0.09, 0.1, 0.1, 0.1];
    const frames = [...turned, ...unwinding].map((halfWidth, i) => at(i, halfWidth, 0.5 + (0.1 - halfWidth) * 0.5));
    expect(run(frames)).toEqual([]);
  });

  describe('a fast stroke that crosses the midline between frames (~23 FPS)', () => {
    const FRAME_23_FPS = 43;

    it('fires a Forehand on the frame it crosses', () => {
      const frames = framesFor({ hand: 'right' }, [{ u: 1.5, up: 0 }, { u: 1.5, up: 0 }, { u: 0.6, up: 0 }, { u: -0.4, up: 0 }, { u: -1, up: 0 }], 1000, FRAME_23_FPS);
      const swings = run(frames);
      expect(swings).toHaveLength(1);
      expect(swings[0]).toMatchObject({ t: frames[3]!.t, side: 'forehand' });
    });

    it('fires a Backhand that starts at the midline and is only one frame on the Backhand side', () => {
      // From the #12 detection test: Backhand ready position just across the midline, no Backswing.
      const frames = framesFor({ hand: 'right' }, [{ u: -0.1, up: 0 }, { u: -0.1, up: 0 }, { u: 0.2, up: 0 }, { u: 0.6, up: 0 }, { u: 1, up: 0 }, { u: 1.4, up: 0 }], 1000, FRAME_23_FPS);
      const swings = run(frames);
      expect(swings).toHaveLength(1);
      expect(swings[0]).toMatchObject({ t: frames[3]!.t, side: 'backhand' });
    });

    it('fires a Backhand on the frame it crosses', () => {
      const frames = framesFor({ hand: 'left' }, [{ u: -1.2, up: 0 }, { u: -1.2, up: 0 }, { u: -0.3, up: 0 }, { u: 0.7, up: 0 }, { u: 1.3, up: 0 }], 1000, FRAME_23_FPS);
      const swings = run(frames);
      expect(swings).toHaveLength(1);
      expect(swings[0]).toMatchObject({ t: frames[3]!.t, side: 'backhand' });
    });
  });

  it('gives the same Swings whether or not the image is mirrored', () => {
    for (const stroke of [FOREHAND, BACKHAND]) {
      expectSameSwings(run(framesFor({ hand: 'right', mirrored: true }, stroke)), run(framesFor({ hand: 'right' }, stroke)));
    }
  });

  it('gives the same Swings near to and far from the camera', () => {
    expectSameSwings(run(framesFor({ hand: 'right', shoulderWidth: 0.1 }, FOREHAND)), run(framesFor({ hand: 'right', shoulderWidth: 0.3 }, FOREHAND)));
  });

  it('fires on the second consecutive frame over SWING_ON, not the first', () => {
    // Rest, then one frame at 4.5 sw/s in the Stroke Direction, then two.
    const frames = framesFor({ hand: 'right' }, [
      { u: 1, up: 0 },
      { u: 1, up: 0 },
      { u: 0.85, up: 0 }, // one fast frame…
      { u: 0.85, up: 0 }, // …then stop: no Swing
      { u: 0.7, up: 0 },
      { u: 0.55, up: 0 }, // second fast frame in a row: Onset here
      { u: 0.4, up: 0 },
    ]);
    const swings = run(frames);
    expect(swings).toHaveLength(1);
    expect(swings[0]!.t).toBe(frames[5]!.t);
  });

  it('measures velocity from real frame timestamps, not an assumed frame rate', () => {
    // 0.075 sw per frame: 2.25 sw/s at 30 FPS (below SWING_ON), 4.5 sw/s at 60 FPS.
    const slowSweep = path({ u: 1, up: 0 }, stay(100), to({ u: 0.25, up: 0 }, 333), stay(200));
    expect(run(framesFor({ hand: 'right' }, slowSweep, 0, 1000 / 30))).toEqual([]);
    expect(run(framesFor({ hand: 'right' }, slowSweep, 0, 1000 / 60))).toHaveLength(1);
  });

  it('reports peak speed as the max total speed over the last 3 frames, in shoulder widths per second', () => {
    // Frame-to-frame moves on the Forehand side at 30 FPS.
    const frames = framesFor({ hand: 'right' }, [
      { u: 1.7, up: 0 },
      { u: 2, up: 0 }, // 9 sw/s Backswing: 4 frames before Onset, so not in the peak
      { u: 1.92, up: 0 }, // 2.4 sw/s: not over SWING_ON
      { u: 1.72, up: 0 }, // 6 sw/s
      { u: 1.57, up: 0 }, // 4.5 sw/s: Onset
    ]);
    const [swing] = run(frames);
    expect(swing?.t).toBe(frames[4]!.t);
    expect(swing?.peakSpeed).toBeCloseTo(6);
  });

  it('reports vertical movement as positive when the wrist moves up', () => {
    const upward = path({ u: 2, up: -1 }, stay(100), to({ u: 0, up: 0 }, 200), stay(300));
    const downward = path({ u: 2, up: 1 }, stay(100), to({ u: 0, up: 0 }, 200), stay(300));
    const [up] = run(framesFor({ hand: 'right' }, upward));
    const [down] = run(framesFor({ hand: 'left' }, downward));
    expect(up?.vertPath).toBeCloseTo(5);
    expect(down?.vertPath).toBeCloseTo(-5);
  });

  describe('with a minimum rise at Onset', () => {
    const RISING = { ...PARAMS, minRise: 0.5 };
    /** A fast Forehand sweep (10 sw/s) that moves up by `rise` shoulder widths over its 200 ms. */
    const sweep = (rise: number) => path({ u: 1.5, up: 0 }, stay(100), to({ u: -0.5, up: rise }, 200), stay(300));

    it('fires when the wrist rises faster than the minimum at Onset', () => {
      expect(run(framesFor({ hand: 'right' }, sweep(0.2)), RISING)).toHaveLength(1); // 1 sw/s up
    });

    it('never fires on a flat or falling stroke, like a return to ready position', () => {
      expect(run(framesFor({ hand: 'right' }, sweep(0)), RISING)).toEqual([]);
      expect(run(framesFor({ hand: 'left' }, sweep(-0.4)), RISING)).toEqual([]);
    });

    it('does not let a rejected stroke start the cooldown', () => {
      // From the #12 detection test: sliding across to Forehand ready at waist height,
      // then the real Forehand 500 ms later.
      const slideThenSwing = path({ u: -0.5, up: -1 }, stay(100), to({ u: 1.5, up: -1 }, 250), to({ u: 2, up: -1.2 }, 250), to({ u: -0.5, up: 0 }, 200), stay(300));
      const swings = run(framesFor({ hand: 'right' }, slideThenSwing), { ...RISING, cooldownMs: 700 });
      expect(swings.map((swing) => swing.side)).toEqual(['forehand']);
    });

    it('needs no rise when no minimum is set (mouse mode)', () => {
      expect(run(framesFor({ hand: 'right' }, sweep(0)))).toHaveLength(1);
    });
  });

  describe('cooldown and re-arm', () => {
    /** Two Forehand strokes with a full stop between them, the second starting `gapMs` after the first. */
    function twoStrokes(gapMs: number): BodyPoint[] {
      const stroke = (from: BodyPoint) => move(from, { u: 0, up: 0 }, 200);
      const back = (from: BodyPoint) => move(from, { u: 2, up: 0 }, 1); // jump back within one frame (Backswing)
      return path({ u: 2, up: 0 }, stay(100), stroke, stay(gapMs - 200 - FRAME_MS), back, stroke, stay(300));
    }

    it('ignores a stroke that starts within the cooldown, even after the wrist stopped, and never fires it late', () => {
      expect(run(framesFor({ hand: 'right' }, twoStrokes(300)))).toHaveLength(1);
    });

    it('accepts a second Swing after the cooldown once the wrist has stopped', () => {
      expect(run(framesFor({ hand: 'right' }, twoStrokes(600)))).toHaveLength(2);
    });

    it('uses the live cooldown value', () => {
      expect(run(framesFor({ hand: 'right' }, twoStrokes(300)), { ...PARAMS, cooldownMs: 200 })).toHaveLength(2);
    });

    it('re-arms once the stroke ends, even if the wrist never stops before the next one', () => {
      // From the #12 logs: the follow-through flows into the return to ready and the
      // Backswing, and on into the next Swing; the wrist never stops in between.
      const rally = path(
        { u: 1.5, up: 0 },
        stay(100),
        to({ u: -0.5, up: 0 }, 200), // Forehand, 10 sw/s
        to({ u: 2, up: 0 }, 1000), // back to ready and into the Backswing, 2.5 sw/s
        to({ u: -0.5, up: 0 }, 250), // Forehand again, 10 sw/s
        stay(300),
      );
      expect(run(framesFor({ hand: 'right' }, rally)).map((swing) => swing.side)).toEqual(['forehand', 'forehand']);
    });

    it('fires once for a long stroke that slows and speeds up again without ending', () => {
      const stroke = path({ u: 2, up: 0 }, stay(100), to({ u: 1, up: 0 }, 150), to({ u: 0.8, up: 0 }, 150), to({ u: -0.5, up: 0 }, 150), stay(300));
      expect(run(framesFor({ hand: 'right' }, stroke), { ...PARAMS, cooldownMs: 100 })).toHaveLength(1);
    });
  });

  it('starts over after losing the pose, without a velocity spike from the jump', () => {
    const detector = createSwingDetector(() => PARAMS);
    const [before, ...after] = framesFor({ hand: 'right' }, [
      { u: 2, up: 0 },
      { u: 2, up: 0 },
      { u: -1, up: 0 },
      { u: -1, up: 0 },
      { u: -1, up: 0 },
    ]);
    detector.update(before!);
    detector.update(after[0]!);
    // Pose lost for a frame, then found again far away.
    expect(detector.update({ ...after[1]!, wrist: null })).toBeNull();
    expect(detector.latest).toBeNull();
    expect(detector.update(after[2]!)).toBeNull();
    expect(detector.latest?.s).toBeNull();
    expect(detector.update(after[3]!)).toBeNull();
    expect(detector.latest?.s).toBe(0);
  });

  it('reads the body-axis position, side and stroke speed for the overlay', () => {
    const detector = createSwingDetector(() => PARAMS);
    const [a, b] = framesFor({ hand: 'left' }, [
      { u: 1, up: 0.5 },
      { u: 0.9, up: 0.5 },
    ]);
    detector.update(a!);
    detector.update(b!);
    expect(detector.latest).toMatchObject({ u: expect.closeTo(0.9), side: 'forehand', sStroke: expect.closeTo(3), vertSpeed: expect.closeTo(0) });
    expect(detector.latest?.s).toBeCloseTo(3);
  });
});
