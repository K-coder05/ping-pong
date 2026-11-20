import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { launchBall, stepBall, type BallEvent, type BallState } from './ball.ts';
import { BALL_RADIUS, FEEDER_MOUTH, PLAYER_END_Z, TABLE_TOP_Y, TIMING_OFFSET_MS } from './constants.ts';
import { findIdealTime } from './feeder.ts';
import { createShotResolver, feedResult, judgeSwingTiming, knobResolverParams, planReturn, type ResolverParams, type ShotEvent } from './shotResolver.ts';
import { solveLaunch } from './solver.ts';

/** SPEC "Shot resolver and target solver" starting values. */
const SPEC: ResolverParams = {
  hitWindowMs: 200,
  timingOffsetMs: 0,
  earlySwingUsesTry: true,
  lateGraceMs: 300,
  swingOn: 3,
  swingFast: 8,
  directionSpreadM: 0.6,
  safeFraction: 0.7,
  longPushM: 0.4,
  flightTimeSoftS: 1.0,
  flightTimeHardS: 0.55,
  depthSoftM: 0.6,
  depthHardM: 1.2,
  scatterM: 0.1,
};

describe('knobResolverParams', () => {
  it('starts from the SPEC values, with SWING_ON as tuned from the logs (#12)', () => {
    expect(knobResolverParams()).toEqual({ ...SPEC, swingOn: 5.2 });
  });

  it('applies the Timing Offset knob live, so changing it shifts which Swings count as Early or Late', () => {
    const idealAtMs = 10_000;
    const judge = (seenAtMs: number) => {
      const resolver = createShotResolver({ params: knobResolverParams, hand: () => 'right', random: noScatter });
      resolver.startFeed({ idealAtMs });
      return resolver.swing({ t: seenAtMs, peakSpeed: 3, side: 'forehand', vertPath: 0 }, seenAtMs)[0]?.type;
    };
    try {
      expect(judge(idealAtMs + 300)).toBe('late');
      expect(judge(idealAtMs - 150)).toBe('accepted');
      TIMING_OFFSET_MS.set(150); // the game sees this player's Swings 150 ms late
      expect(judge(idealAtMs + 300)).toBe('accepted');
      expect(judge(idealAtMs - 150)).toBe('early');
    } finally {
      TIMING_OFFSET_MS.reset();
    }
  });
});

describe('Hit Window', () => {
  it('accepts a Swing Onset within W of the Ideal Time, and calls it Early or Late outside', () => {
    const ideal = 10_000;
    expect(judgeSwingTiming(ideal - 200, ideal, SPEC)).toEqual({ timing: 'accepted', delta: -200 });
    expect(judgeSwingTiming(ideal + 150, ideal, SPEC)).toEqual({ timing: 'accepted', delta: 150 });
    expect(judgeSwingTiming(ideal - 201, ideal, SPEC)).toEqual({ timing: 'early', delta: -201 });
    expect(judgeSwingTiming(ideal + 250, ideal, SPEC)).toEqual({ timing: 'late', delta: 250 });
  });

  it('corrects the Swing Onset by the Timing Offset first', () => {
    // Seen 180 ms after the player meant to hit: a Swing seen 350 ms late was meant 170 ms late.
    const params = { ...SPEC, timingOffsetMs: 180 };
    expect(judgeSwingTiming(10_350, 10_000, params)).toEqual({ timing: 'accepted', delta: 170 });
  });
});

/** Random numbers that give no scatter at all (the middle of [0, 1)). */
const noScatter = () => 0.5;

describe('Return direction from timing', () => {
  // World x: + is the player's right (screen right from the play camera).
  it("sends a right-hander's early Forehand cross-court (to their left) and a late one down the line", () => {
    const swing = { peakSpeed: 3, side: 'forehand', hand: 'right' } as const;
    expect(planReturn({ ...swing, delta: -100 }, SPEC, noScatter).target.x).toBeCloseTo(-0.3);
    expect(planReturn({ ...swing, delta: 100 }, SPEC, noScatter).target.x).toBeCloseTo(0.3);
    expect(planReturn({ ...swing, delta: 0 }, SPEC, noScatter).target.x).toBeCloseTo(0);
  });

  it('flips the direction for a Backhand and for a left-hander', () => {
    const early = { peakSpeed: 3, delta: -100 } as const;
    expect(planReturn({ ...early, side: 'backhand', hand: 'right' }, SPEC, noScatter).target.x).toBeCloseTo(0.3);
    expect(planReturn({ ...early, side: 'forehand', hand: 'left' }, SPEC, noScatter).target.x).toBeCloseTo(0.3);
    expect(planReturn({ ...early, side: 'backhand', hand: 'left' }, SPEC, noScatter).target.x).toBeCloseTo(-0.3);
  });
});

describe('Return pace and depth from peak speed', () => {
  const onTime = { delta: 0, side: 'forehand', hand: 'right' } as const;
  const plan = (peakSpeed: number) => planReturn({ ...onTime, peakSpeed }, SPEC, noScatter);

  it('sends a soft Swing slow and short, and a full-power one fast and deep', () => {
    expect(plan(3)).toMatchObject({ flightTime: 1.0, target: { z: -0.6 } });
    expect(plan(8).flightTime).toBeCloseTo(0.55);
    expect(plan(8).target.z).toBeCloseTo(-1.2);
  });

  it('scales in between, and clamps outside SWING_ON..SWING_FAST', () => {
    expect(plan(5.5).flightTime).toBeCloseTo(0.775);
    expect(plan(5.5).target.z).toBeCloseTo(-0.9);
    expect(plan(1).flightTime).toBeCloseTo(1.0);
    expect(plan(20).target.z).toBeCloseTo(-1.2);
  });
});

describe('Return risk from timing quality', () => {
  const soft = { peakSpeed: 3, side: 'forehand', hand: 'right' } as const;
  const depthAt = (delta: number) => planReturn({ ...soft, delta }, SPEC, noScatter).target.z;

  it('keeps Swings in the inner 70% of the Hit Window at their safe depth', () => {
    expect(depthAt(0)).toBeCloseTo(-0.6);
    expect(depthAt(-140)).toBeCloseTo(-0.6);
    expect(depthAt(140)).toBeCloseTo(-0.6);
  });

  it('pushes Swings in the outer 30% long, by up to 0.4 m at the edge', () => {
    expect(depthAt(170)).toBeCloseTo(-0.8);
    expect(depthAt(-200)).toBeCloseTo(-1.0);
  });

  it('reports the timing quality', () => {
    expect(planReturn({ ...soft, delta: -50 }, SPEC, noScatter).quality).toBeCloseTo(0.75);
  });
});

describe('Return scatter', () => {
  const soft = { peakSpeed: 3, side: 'forehand', hand: 'right' } as const;

  it('never scatters a perfectly timed Swing', () => {
    const plan = planReturn({ ...soft, delta: 0 }, SPEC, () => 0);
    expect(plan.target.x).toBeCloseTo(0);
    expect(plan.target.z).toBeCloseTo(-0.6);
  });

  it('scatters up to ±0.1 m on x and z, scaled by 1 − quality', () => {
    // delta −100: q = 0.5, so at most ±0.05 m around (−0.3, −0.6).
    const low = planReturn({ ...soft, delta: -100 }, SPEC, () => 0);
    expect(low.target.x).toBeCloseTo(-0.35);
    expect(low.target.z).toBeCloseTo(-0.65);
    const high = planReturn({ ...soft, delta: -100 }, SPEC, () => 0.999999);
    expect(high.target.x).toBeCloseTo(-0.25);
    expect(high.target.z).toBeCloseTo(-0.55);
  });
});

// ---------------------------------------------------------------------------
// One Feed, played frame by frame like the game loop (TIME_SCALE 1, 60 FPS)
// ---------------------------------------------------------------------------

const FRAME_MS = 1000 / 60;
const SUBSTEPS_PER_FRAME = 4; // 4 × 1/240 s

/** A Feed to (x, z) on the player's half, launched at t = 0 ms. */
function makeFeed(target = { x: 0.2, z: 0.7 }) {
  const { velocity } = solveLaunch(FEEDER_MOUTH, target, 1.0);
  const ball = launchBall(FEEDER_MOUTH, velocity);
  const ideal = findIdealTime(ball)!;
  return { ball, idealAtMs: ideal.simSeconds * 1000 };
}

interface PlayedFeed {
  events: ShotEvent[];
  /** Each event with the frame time it came out at. */
  timeline: { atMs: number; event: ShotEvent }[];
  /** The ball in play at the end. */
  ball: BallState;
}

/**
 * Run the game loop for one Feed: each frame steps the ball, hands any Swing
 * that is due to the resolver, then updates it; a contact replaces the ball.
 */
function playFeed(options: {
  swingsAtMs?: number[];
  swing?: Partial<SwingEvent>;
  params?: Partial<ResolverParams>;
  hand?: Hand;
  untilMs?: number;
  feedTarget?: { x: number; z: number };
}): PlayedFeed {
  const feed = makeFeed(options.feedTarget);
  const resolver = createShotResolver({ params: () => ({ ...SPEC, ...options.params }), hand: () => options.hand ?? 'right', random: noScatter });
  resolver.startFeed(feed);
  let ball: BallState = feed.ball;
  const pending = [...(options.swingsAtMs ?? [])];
  const timeline: PlayedFeed['timeline'] = [];
  const untilMs = options.untilMs ?? feed.idealAtMs + 3000;
  for (let now = FRAME_MS; now <= untilMs; now += FRAME_MS) {
    const frameEvents: BallEvent[] = [];
    for (let i = 0; i < SUBSTEPS_PER_FRAME; i++) {
      const step = stepBall(ball);
      ball = step.state;
      frameEvents.push(...step.events);
    }
    while (pending.length && pending[0]! <= now) {
      const t = pending.shift()!;
      const swing: SwingEvent = { t, peakSpeed: 3, side: 'forehand', vertPath: 0, ...options.swing };
      for (const event of resolver.swing(swing, now)) timeline.push({ atMs: now, event });
    }
    for (const event of resolver.update(now, ball, frameEvents)) {
      timeline.push({ atMs: now, event });
      if (event.type === 'contact') ball = event.ball;
    }
  }
  return { events: timeline.map((e) => e.event), timeline, ball };
}

const types = (played: PlayedFeed) => played.events.map((e) => e.type);

describe('a Feed with a Swing in the Hit Window', () => {
  it('is returned: contact at the Ideal Time, then the Return lands on the Feeder half', () => {
    const { idealAtMs } = makeFeed();
    const played = playFeed({ swingsAtMs: [idealAtMs - 100] });
    expect(types(played)).toEqual(['accepted', 'contact', 'return']);

    const accepted = played.events[0] as Extract<ShotEvent, { type: 'accepted' }>;
    expect(accepted.delta).toBeCloseTo(-100);
    expect(accepted.contactAtMs).toBeCloseTo(idealAtMs);

    // An early accepted Swing waits for the ball: contact on the first frame at or after the Ideal Time.
    const contact = played.timeline[1]!;
    expect(contact.atMs).toBeGreaterThanOrEqual(idealAtMs);
    expect(contact.atMs).toBeLessThan(idealAtMs + FRAME_MS);
    if (contact.event.type !== 'contact') throw new Error('expected contact');
    expect(contact.event.position.z).toBeGreaterThan(PLAYER_END_Z - 0.05);

    // Early Forehand from a right-hander: cross-court, to the left (−x).
    const landed = played.events[2] as Extract<ShotEvent, { type: 'return' }>;
    expect(landed.position.z).toBeLessThan(0);
    expect(landed.position.x).toBeCloseTo(-0.3, 1);
    expect(landed.position.z).toBeCloseTo(-0.6, 1);
  });

  it('strikes a late Swing at once, from wherever the ball is now, and sends it down the line', () => {
    const { idealAtMs } = makeFeed();
    const swingAt = idealAtMs + 120;
    const played = playFeed({ swingsAtMs: [swingAt] });
    expect(types(played)).toEqual(['accepted', 'contact', 'return']);

    const contact = played.timeline[1]!;
    expect(contact.atMs).toBeLessThan(swingAt + FRAME_MS);
    if (contact.event.type !== 'contact') throw new Error('expected contact');
    expect(contact.event.position.z).toBeGreaterThan(PLAYER_END_Z + 0.1); // past the end
    expect(played.events[2]).toMatchObject({ type: 'return' });
    expect((played.events[2] as { position: { x: number } }).position.x).toBeGreaterThan(0.1);
  });

  it('still returns a late Swing when the ball has already dropped below the table top past its end', () => {
    // A short Feed falls fast after its Ideal Time: 190 ms later it is under the table top.
    const feedTarget = { x: 0.3, z: 0.5 };
    const { idealAtMs } = makeFeed(feedTarget);
    const played = playFeed({ feedTarget, swingsAtMs: [idealAtMs + 190] });
    expect(types(played)).toEqual(['accepted', 'contact', 'return']);
    const contact = played.events[1] as Extract<ShotEvent, { type: 'contact' }>;
    // Struck from just above the table top, not from under it (where it would be out at once).
    expect(contact.position.y).toBeCloseTo(TABLE_TOP_Y + BALL_RADIUS, 6);
  });
});

describe('a Feed that is not returned', () => {
  const { idealAtMs } = makeFeed();

  it('is Early when the Swing comes before the Hit Window, which uses up the try', () => {
    const played = playFeed({ swingsAtMs: [idealAtMs - 300, idealAtMs] });
    expect(played.events).toEqual([{ type: 'early', delta: -300, final: true }]);
  });

  it('is Late when the Swing comes after the Hit Window', () => {
    const played = playFeed({ swingsAtMs: [idealAtMs + 250] });
    expect(played.events).toEqual([{ type: 'late', delta: 250 }]);
  });

  it('is a Miss, once, when no Swing comes before the Late grace runs out', () => {
    const played = playFeed({});
    expect(played.events).toEqual([{ type: 'miss' }]);
    expect(played.timeline[0]!.atMs).toBeGreaterThan(idealAtMs + 200 + 300);
    expect(played.timeline[0]!.atMs).toBeLessThan(idealAtMs + 200 + 300 + FRAME_MS + 1);
  });

  it('waits for Swings seen late by the Timing Offset before calling a Miss', () => {
    const played = playFeed({ params: { timingOffsetMs: 400 }, swingsAtMs: [idealAtMs + 400 + 100] });
    expect(types(played)).toEqual(['accepted', 'contact', 'return']);
  });

  it('ignores Swings once the Feed is decided', () => {
    expect(playFeed({ swingsAtMs: [idealAtMs + 900] }).events).toEqual([{ type: 'miss' }]);
    expect(types(playFeed({ swingsAtMs: [idealAtMs, idealAtMs + 50] }))).toEqual(['accepted', 'contact', 'return']);
  });
});

describe('with EARLY_SWING_USES_TRY off', () => {
  const { idealAtMs } = makeFeed();
  const params = { earlySwingUsesTry: false };

  it('shows Early but keeps the try, so a later Swing can still return the Feed', () => {
    const played = playFeed({ params, swingsAtMs: [idealAtMs - 300, idealAtMs] });
    expect(played.events[0]).toEqual({ type: 'early', delta: -300, final: false });
    expect(types(played)).toEqual(['early', 'accepted', 'contact', 'return']);
  });

  it('ends the Feed as Early (not Miss) when only early Swings came', () => {
    const played = playFeed({ params, swingsAtMs: [idealAtMs - 300] });
    expect(played.events).toEqual([
      { type: 'early', delta: -300, final: false },
      { type: 'early', delta: -300, final: true },
    ]);
  });
});

describe('a struck ball that misses', () => {
  it('is off target when a full-power Swing at the edge of the window is pushed long', () => {
    const { idealAtMs } = makeFeed();
    const played = playFeed({ swingsAtMs: [idealAtMs - 200], swing: { peakSpeed: 8 } });
    expect(types(played)).toEqual(['accepted', 'contact', 'off-target']);
    expect(played.events[2]).toMatchObject({ reason: 'out' });
  });
});

describe('feedResult', () => {
  it('says which events end a Feed, and whether it was returned', () => {
    const at = { x: 0, y: 0, z: 0 };
    expect(feedResult({ type: 'return', position: at })).toBe('returned');
    expect(feedResult({ type: 'off-target', reason: 'net', position: at })).toBe('failed');
    expect(feedResult({ type: 'late', delta: 300 })).toBe('failed');
    expect(feedResult({ type: 'miss' })).toBe('failed');
    expect(feedResult({ type: 'early', delta: -300, final: true })).toBe('failed');
    expect(feedResult({ type: 'early', delta: -300, final: false })).toBeNull();
  });
});

describe('a Feed that never reaches the player', () => {
  it('is a Miss at once, so the Streak still resets', () => {
    const resolver = createShotResolver({ params: () => SPEC, hand: () => 'right', random: noScatter });
    resolver.startFeed({ idealAtMs: null });
    const ball = makeFeed().ball;
    expect(resolver.update(16, ball, [])).toEqual([{ type: 'miss' }]);
    expect(resolver.update(32, ball, [])).toEqual([]);
  });
});

describe('Swings with no Feed', () => {
  it('are ignored', () => {
    const resolver = createShotResolver({ params: () => SPEC, hand: () => 'right', random: noScatter });
    expect(resolver.swing({ t: 0, peakSpeed: 5, side: 'forehand', vertPath: 0 }, 0)).toEqual([]);
  });
});
