import { describe, expect, it } from 'vitest';
import { launchBall, stepBall, type BallEvent, type BallState, type Vec3 } from './ball.ts';
import { makeRng } from '../util/rng.ts';
import {
  BALL_RADIUS,
  FEED_FLIGHT_TIME_S,
  FEED_MAX_DRAWS,
  FEED_TARGET_HALF_WIDTH,
  FEED_TARGET_Z_MAX,
  FEED_TARGET_Z_MIN,
  FEEDER_MOUTH,
  HIT_WINDOW_MS,
  PHYSICS_DT,
  PLAYER_END_Z,
  TABLE_TOP_Y,
  TIME_SCALE,
  TIMING_OFFSET_MS,
} from './constants.ts';
import { createFeeder, findIdealTime, type Feed, type Feeder } from './feeder.ts';
import { createSimClock } from './simClock.ts';
import { solveShot, type ShotIntent, type ShotSolution, type ShotSolver, type SolveOptions } from './solver.ts';

describe('Ideal Time', () => {
  it('is the moment the Feed crosses the player end of the table, after its bounce', () => {
    const { velocity } = solveShot(FEEDER_MOUTH, { target: { x: -0.3, z: 0.7 }, flightTime: 1.0, topspin: 0, sidespin: 0 })!;
    const feed = launchBall(FEEDER_MOUTH, velocity);

    const ideal = findIdealTime(feed);
    expect(ideal).not.toBeNull();

    // Step the same Feed by hand, through the substep that contains the Ideal Time.
    const steps = Math.ceil(ideal!.simSeconds / PHYSICS_DT);
    let ball: BallState = feed;
    let bounces = 0;
    let before: BallState = feed;
    for (let i = 0; i < steps; i++) {
      before = ball;
      const step = stepBall(ball);
      bounces += step.events.filter((e) => e.type === 'bounce').length;
      ball = step.state;
    }
    expect(bounces).toBe(1);
    expect(ball.lastBounceHalf).toBe('player');
    expect(before.position.z).toBeLessThan(PLAYER_END_Z);
    expect(ball.position.z).toBeGreaterThanOrEqual(PLAYER_END_Z);
    expect(ideal!.position.z).toBeCloseTo(PLAYER_END_Z, 6);
    // Within that one substep's travel (about a centimetre) of where the ball really was.
    expect(Math.abs(ideal!.position.x - ball.position.x)).toBeLessThanOrEqual(Math.abs(ball.position.x - before.position.x) + 1e-9);
    expect(Math.abs(ideal!.position.y - ball.position.y)).toBeLessThanOrEqual(Math.abs(ball.position.y - before.position.y) + 1e-9);
    // A 1 s Feed reaches the end a few tenths of a second after it lands.
    expect(ideal!.simSeconds).toBeGreaterThan(1.0);
    expect(ideal!.simSeconds).toBeLessThan(1.8);
  });

  // Guards the target area against bounce changes (µ, the bounce model) that
  // would make short or slow Feeds bounce twice on the player half.
  it.each([
    ['fastest', FEED_FLIGHT_TIME_S.min],
    ['default', FEED_FLIGHT_TIME_S.default],
    ['slowest', FEED_FLIGHT_TIME_S.max],
  ])('exists for Feeds aimed anywhere on the edges of the target area, at the %s flight time', (_label, flightTime) => {
    const xs = [-FEED_TARGET_HALF_WIDTH, 0, FEED_TARGET_HALF_WIDTH];
    const zs = [FEED_TARGET_Z_MIN, (FEED_TARGET_Z_MIN + FEED_TARGET_Z_MAX) / 2, FEED_TARGET_Z_MAX];
    for (const x of xs) {
      for (const z of zs) {
        const solution = solveShot(FEEDER_MOUTH, { target: { x, z }, flightTime, topspin: 0, sidespin: 0 });
        expect(solution, `solve (${x}, ${z})`).not.toBeNull();
        expect(findIdealTime(launchBall(FEEDER_MOUTH, solution!.velocity)), `target (${x}, ${z})`).not.toBeNull();
      }
    }
  });

  it('is null for a ball that never reaches the player end after a bounce on the player half', () => {
    const intoNet = launchBall({ x: 0, y: FEEDER_MOUTH.y - 0.25, z: -0.6 }, { x: 0, y: 0, z: 6 });
    expect(findIdealTime(intoNet)).toBeNull();
  });
});

/** Small seeded PRNG so random Feeds are repeatable. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A ball that has ended its rally (out), as it is between Feeds. */
const OUT_BALL: BallState = { ...launchBall({ x: 0, y: 0.02, z: 2 }, { x: 0, y: 0, z: 0 }), status: 'out' };

/**
 * Drive a Feeder in 50 ms frames like the game loop does, without physics: a
 * launched Feed becomes the ball in play and stays frozen at launch (live)
 * until the test swaps it.
 */
function driver(feeder: Feeder) {
  let nowMs = 0;
  let ball = OUT_BALL;
  feeder.onFeed((feed) => (ball = feed.ball));
  return {
    run(seconds: number) {
      const frames = Math.round(seconds / 0.05);
      for (let i = 0; i < frames; i++) {
        nowMs += 50;
        feeder.update({ realSeconds: 0.05, simSeconds: 0.05, nowMs }, ball);
      }
    },
    setBall(next: BallState) {
      ball = next;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

describe('Feeder scheduling', () => {
  it('waits about 1.5 s, counts "3, 2, 1", then sends a Feed', () => {
    const feeder = createFeeder({ random: seededRandom(1) });
    const feeds: Feed[] = [];
    feeder.onFeed((feed) => feeds.push(feed));
    const game = driver(feeder);

    game.run(1.4);
    expect(feeder.phase).toBe('waiting');
    expect(feeder.countdown).toBeNull();

    game.run(0.2); // 1.6 s
    expect(feeder.phase).toBe('countdown');
    expect(feeder.countdown).toBe(3);
    game.run(0.5); // 2.1 s
    expect(feeder.countdown).toBe(2);
    game.run(0.5); // 2.6 s
    expect(feeder.countdown).toBe(1);
    expect(feeds).toHaveLength(0);

    game.run(0.5); // 3.1 s
    expect(feeder.phase).toBe('feeding');
    expect(feeder.countdown).toBeNull();
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.ball.status).toBe('live');
    expect(feeder.currentFeed).toBe(feeds[0]);
  });

  it('keeps feeding while the ball is live, then after the rally ends waits and counts down again', () => {
    const feeder = createFeeder({ random: seededRandom(2) });
    const feeds: Feed[] = [];
    let rallyEnds = 0;
    feeder.onFeed((feed) => feeds.push(feed));
    feeder.onRallyEnd(() => rallyEnds++);
    const game = driver(feeder);
    game.run(3.1);
    expect(feeds).toHaveLength(1);

    game.run(5); // the Feed (or a Return replacing it) is still live
    expect(feeder.phase).toBe('feeding');
    expect(rallyEnds).toBe(0);

    game.setBall(OUT_BALL); // the ball went out: rally over
    game.run(0.05);
    expect(rallyEnds).toBe(1);
    expect(feeder.phase).toBe('waiting');

    game.run(1.4);
    expect(feeder.countdown).toBeNull();
    game.run(0.2);
    expect(feeder.countdown).toBe(3);
    game.run(1.5);
    expect(feeds).toHaveLength(2);
  });

  it('keeps the rally on until the Hit Window after the Ideal Time closes, even if the Feed is already out', () => {
    const feeder = createFeeder({ random: seededRandom(4) });
    let rallyEnds = 0;
    feeder.onRallyEnd(() => rallyEnds++);
    const game = driver(feeder);
    game.run(3.1);
    const feed = feeder.currentFeed!;
    const windowClosesAtMs = feed.idealAtMs! + HIT_WINDOW_MS.value;

    game.setBall(OUT_BALL); // the Feed dropped past the end, but a late Swing could still return it
    game.run((windowClosesAtMs - 100 - game.nowMs) / 1000);
    expect(rallyEnds).toBe(0);
    expect(feeder.phase).toBe('feeding');

    game.run(0.2);
    expect(rallyEnds).toBe(1);
    expect(feeder.phase).toBe('waiting');
  });

  it('holds the rally longer by the Timing Offset, since a Swing is seen that much later than meant', () => {
    TIMING_OFFSET_MS.set(150);
    try {
      const feeder = createFeeder({ random: seededRandom(4) });
      let rallyEnds = 0;
      feeder.onRallyEnd(() => rallyEnds++);
      const game = driver(feeder);
      game.run(3.1);
      const lastAcceptedOnsetMs = feeder.currentFeed!.idealAtMs! + HIT_WINDOW_MS.value + 150;

      game.setBall(OUT_BALL);
      game.run((lastAcceptedOnsetMs - 100 - game.nowMs) / 1000);
      expect(rallyEnds).toBe(0);
      game.run(0.2);
      expect(rallyEnds).toBe(1);
    } finally {
      TIMING_OFFSET_MS.reset();
    }
  });

  it('does not take a ball at the top of a bounce for one at rest', () => {
    const feeder = createFeeder({ random: seededRandom(5) });
    let rallyEnds = 0;
    feeder.onRallyEnd(() => rallyEnds++);
    const game = driver(feeder);
    game.run(3.1);
    game.run(3); // past the Hit Window

    game.setBall(launchBall({ x: 0, y: FEEDER_MOUTH.y, z: 0.7 }, { x: 0, y: 0, z: 0 })); // a live ball at its apex
    game.run(0.1);
    expect(rallyEnds).toBe(0);

    game.setBall({ ...launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 }), lastBounceHalf: 'player' }); // settled on the table
    game.run(0.1);
    expect(rallyEnds).toBe(1);
  });

  it('cuts the Feed flight time by about 5% for every 10 Returns in the Streak, and restores it when the Streak resets', () => {
    const feeder = createFeeder({ random: seededRandom(3) });
    const feeds: Feed[] = [];
    feeder.onFeed((feed) => feeds.push(feed));
    const game = driver(feeder);
    const nextFeed = () => {
      const count = feeds.length;
      game.setBall(OUT_BALL); // end any rally in progress (once its Hit Window has closed)
      for (let i = 0; i < 400 && feeds.length === count; i++) game.run(0.05);
      return feeds.at(-1)!;
    };

    expect(nextFeed().flightTime).toBeCloseTo(1.0, 6);
    feeder.setStreak(9);
    expect(nextFeed().flightTime).toBeCloseTo(1.0, 6);
    feeder.setStreak(10);
    expect(nextFeed().flightTime).toBeCloseTo(0.95, 6);
    feeder.setStreak(25);
    expect(nextFeed().flightTime).toBeCloseTo(0.9025, 6);
    feeder.setStreak(0);
    expect(nextFeed().flightTime).toBeCloseTo(1.0, 6);
  });
});

describe('Feeder pause (tracking loss)', () => {
  it('sends no Feed while paused, however long, then waits and counts down again once resumed', () => {
    const feeder = createFeeder({ random: seededRandom(6) });
    const feeds: Feed[] = [];
    feeder.onFeed((feed) => feeds.push(feed));
    const game = driver(feeder);

    feeder.setPaused(true);
    game.run(10);
    expect(feeds).toHaveLength(0);
    expect(feeder.paused).toBe(true);
    expect(feeder.countdown).toBeNull();

    feeder.setPaused(false);
    game.run(1.4);
    expect(feeder.countdown).toBeNull();
    game.run(0.2);
    expect(feeder.countdown).toBe(3);
    game.run(1.5);
    expect(feeds).toHaveLength(1);
  });

  it('cancels a "3, 2, 1" in progress, and starts the wait over on resume', () => {
    const feeder = createFeeder({ random: seededRandom(6) });
    const feeds: Feed[] = [];
    feeder.onFeed((feed) => feeds.push(feed));
    const game = driver(feeder);
    game.run(2.6);
    expect(feeder.countdown).toBe(1);

    feeder.setPaused(true);
    expect(feeder.countdown).toBeNull();
    game.run(1);
    expect(feeds).toHaveLength(0);

    feeder.setPaused(false);
    game.run(1.4);
    expect(feeder.phase).toBe('waiting');
    expect(feeder.countdown).toBeNull();
    game.run(0.2);
    expect(feeder.countdown).toBe(3);
  });

  it('lets a Feed in flight play out, then sends no new one until resumed', () => {
    const feeder = createFeeder({ random: seededRandom(6) });
    const feeds: Feed[] = [];
    let rallyEnds = 0;
    feeder.onFeed((feed) => feeds.push(feed));
    feeder.onRallyEnd(() => rallyEnds++);
    const game = driver(feeder);
    game.run(3.1);
    expect(feeds).toHaveLength(1);

    feeder.setPaused(true);
    expect(feeder.phase).toBe('feeding');
    expect(feeder.currentFeed).toBe(feeds[0]);
    game.run(3); // past the Hit Window
    game.setBall(OUT_BALL);
    game.run(0.05);
    expect(rallyEnds).toBe(1);

    game.run(10);
    expect(feeds).toHaveLength(1);
    expect(feeder.countdown).toBeNull();

    feeder.setPaused(false);
    game.run(3.1);
    expect(feeds).toHaveLength(2);
  });
});

interface Rally {
  feed: Feed;
  /** Ball events while the ball was live. */
  events: BallEvent[];
  /** Real ms of the first frame that saw the ball at or past the player's end after its bounce. */
  reachedEndAtMs: number | null;
}

/** Run the Feeder, the sim clock and the integrator together, as the game loop does, at 60 FPS. */
function playRallies(count: number, seed: number): Rally[] {
  const feeder = createFeeder({ random: seededRandom(seed) });
  const simClock = createSimClock();
  const rallies: Rally[] = [];
  let ball = OUT_BALL;
  let nowMs = 0;
  feeder.onFeed((feed) => {
    ball = feed.ball;
    rallies.push({ feed, events: [], reachedEndAtMs: null });
  });

  for (let frame = 0; frame < 60 * 60 * 10 && (rallies.length < count || feeder.phase === 'feeding'); frame++) {
    nowMs += 1000 / 60;
    const steps = simClock.advance(1 / 60, TIME_SCALE.value);
    const rally = rallies.at(-1);
    for (let i = 0; i < steps; i++) {
      const step = stepBall(ball);
      if (ball.status === 'live') rally?.events.push(...step.events);
      ball = step.state;
    }
    if (rally && rally.reachedEndAtMs === null && ball.lastBounceHalf === 'player' && ball.position.z >= PLAYER_END_Z) {
      rally.reachedEndAtMs = nowMs;
    }
    feeder.update({ realSeconds: 1 / 60, simSeconds: steps * PHYSICS_DT, nowMs }, ball);
  }
  return rallies;
}

describe('Feeds in play', () => {
  it.each([
    ['the default flight time', FEED_FLIGHT_TIME_S.default],
    ['the fastest flight-time knob setting', FEED_FLIGHT_TIME_S.min],
    ['the slowest flight-time knob setting', FEED_FLIGHT_TIME_S.max],
  ])('50 Feeds in a row at %s each land once on the player half, inside the target area, then go out past the end', (_label, flightTime) => {
    FEED_FLIGHT_TIME_S.set(flightTime);
    let rallies: Rally[];
    try {
      rallies = playRallies(50, 7);
    } finally {
      FEED_FLIGHT_TIME_S.reset();
    }
    expect(rallies).toHaveLength(50);

    for (const { events } of rallies) {
      const bounces = events.filter((e) => e.type === 'bounce');
      expect(bounces.map((b) => b.half)).toEqual(['player']);
      expect(events.some((e) => e.type === 'net')).toBe(false);
      expect(events.filter((e) => e.type === 'out')).toEqual([expect.objectContaining({ reason: 'off-table' })]);

      const landing = bounces[0]!.position;
      expect(Math.abs(landing.x)).toBeLessThanOrEqual(0.5 + 0.01);
      expect(landing.z).toBeGreaterThanOrEqual(0.5 - 0.01);
      expect(landing.z).toBeLessThanOrEqual(1.0 + 0.01);
    }
  });

  it('gives the Ideal Time on the performance.now() clock, slowed by TIME_SCALE', () => {
    TIME_SCALE.set(0.5);
    try {
      const rallies = playRallies(5, 11);
      for (const { feed, reachedEndAtMs } of rallies) {
        expect(feed.idealAtMs).not.toBeNull();
        expect(reachedEndAtMs).not.toBeNull();
        // At half speed a ~1.4 s Ideal Time is ~2.8 s of real time after launch.
        expect(feed.idealAtMs! - feed.launchedAtMs).toBeGreaterThan(2000);
        // The game loop first sees the ball at the end within one frame (plus a substep) of the Ideal Time.
        expect(reachedEndAtMs! - feed.idealAtMs!).toBeGreaterThanOrEqual(-5);
        expect(reachedEndAtMs! - feed.idealAtMs!).toBeLessThan(1000 / 60 + 5);
      }
    } finally {
      TIME_SCALE.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// Solver failure (spec P1-c): failed draws are redrawn, then the centre fallback
// ---------------------------------------------------------------------------

interface SolveCall {
  intent: ShotIntent;
  opts: Partial<SolveOptions> | undefined;
}

/**
 * A stand-in solver that records its calls. `fails(call number)` says whether
 * to fail that call (with `failure`); otherwise, and always for best effort
 * (the contract), it solves for real.
 */
function stubSolver(fails: (call: number) => boolean, failure: (from: Vec3, intent: ShotIntent) => ShotSolution | null = () => null) {
  const calls: SolveCall[] = [];
  const solve = ((from: Vec3, intent: ShotIntent, opts?: Partial<SolveOptions>) => {
    calls.push({ intent, opts });
    if (!opts?.bestEffort && fails(calls.length)) return failure(from, intent);
    return solveShot(from, intent, opts);
  }) as ShotSolver;
  return { solve, calls };
}

/** A "solution" that drives the Feed into the net: it never reaches the player, so it has no Ideal Time. */
const intoTheNet = (): ShotSolution => ({ velocity: { x: 0, y: 0, z: 6 }, spin: { x: 0, y: 0, z: 0 }, flightTime: 1, passes: 1 });

/** Run a Feeder until its first Feed (3.1 s: the pause, then "3, 2, 1"). */
function firstFeed(feeder: Feeder): Feed {
  const feeds: Feed[] = [];
  feeder.onFeed((feed) => feeds.push(feed));
  driver(feeder).run(3.1);
  expect(feeds).toHaveLength(1);
  return feeds[0]!;
}

const CENTRE = { x: 0, z: (FEED_TARGET_Z_MIN + FEED_TARGET_Z_MAX) / 2 };

describe('Feeder with a failing solver', () => {
  it(`redraws the target with the same random, and after ${FEED_MAX_DRAWS} failed draws sends a zero-spin Feed to the centre of the target area`, () => {
    const { solve, calls } = stubSolver(() => true);
    const feed = firstFeed(createFeeder({ random: makeRng(1), solve }));

    expect(calls).toHaveLength(FEED_MAX_DRAWS + 1);
    const draws = calls.slice(0, FEED_MAX_DRAWS);
    for (const { intent, opts } of draws) {
      expect(opts?.bestEffort).toBeFalsy();
      expect(Math.abs(intent.target.x)).toBeLessThanOrEqual(FEED_TARGET_HALF_WIDTH);
      expect(intent.target.z).toBeGreaterThanOrEqual(FEED_TARGET_Z_MIN);
      expect(intent.target.z).toBeLessThanOrEqual(FEED_TARGET_Z_MAX);
    }
    // Every redraw is a new target.
    expect(new Set(draws.map((c) => `${c.intent.target.x},${c.intent.target.z}`)).size).toBe(FEED_MAX_DRAWS);

    const fallback = calls[FEED_MAX_DRAWS]!;
    expect(fallback.intent).toEqual({ target: CENTRE, flightTime: FEED_FLIGHT_TIME_S.value, topspin: 0, sidespin: 0 });
    expect(fallback.opts?.bestEffort).toBe(true);

    expect(feed.target).toEqual(CENTRE);
    expect(feed.ball.spin).toEqual({ x: 0, y: 0, z: 0 });
    expect(feed.idealTime).not.toBeNull();
    expect(feed.idealAtMs).not.toBeNull();
  });

  it('counts a Feed that would never reach the player (no Ideal Time) as a failed draw, and redraws', () => {
    const { solve, calls } = stubSolver((call) => call <= 2, intoTheNet);
    const feed = firstFeed(createFeeder({ random: makeRng(2), solve }));

    expect(calls).toHaveLength(3);
    expect(feed.target).toEqual(calls[2]!.intent.target);
    expect(feed.target).not.toEqual(CENTRE);
    expect(feed.idealAtMs).not.toBeNull();
  });

  it('sends the centre fallback after draws that all have no Ideal Time', () => {
    const { solve, calls } = stubSolver(() => true, intoTheNet);
    const feed = firstFeed(createFeeder({ random: makeRng(3), solve }));
    expect(calls).toHaveLength(FEED_MAX_DRAWS + 1);
    expect(feed.target).toEqual(CENTRE);
    expect(feed.idealAtMs).not.toBeNull();
  });

  it.each([FEED_FLIGHT_TIME_S.min, FEED_FLIGHT_TIME_S.default, FEED_FLIGHT_TIME_S.max])(
    'never emits a Feed without an Ideal Time, over 200 Feeds from a solver that often fails (flight time %s s)',
    (flightTime) => {
      const failures = makeRng(99);
      const { solve } = stubSolver(() => failures() < 0.6, () => (failures() < 0.5 ? null : intoTheNet()));
      FEED_FLIGHT_TIME_S.set(flightTime);
      try {
        const feeder = createFeeder({ random: makeRng(4), solve });
        const feeds: Feed[] = [];
        feeder.onFeed((feed) => feeds.push(feed));
        const game = driver(feeder);
        while (feeds.length < 200) {
          game.setBall(OUT_BALL); // end any rally in progress (once its Hit Window has closed)
          game.run(0.05);
        }
        expect(feeds.every((feed) => feed.idealAtMs !== null && feed.idealTime !== null)).toBe(true);
      } finally {
        FEED_FLIGHT_TIME_S.reset();
      }
    },
  );
});

describe('Feed launch', () => {
  it('launches with the solution’s spin and a per-Shot seed drawn from the injected random', () => {
    // Draws: target x, target z, then the seed.
    const draws = [0.5, 0.5, 0.25];
    const random = () => draws.shift() ?? 0;
    const feed = firstFeed(createFeeder({ random }));
    expect(feed.target).toEqual(CENTRE);
    expect(feed.ball.seed).toBe(Math.floor(0.25 * 2 ** 32));
    expect(feed.ball.spin).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('gives each Feed its own seed, the same for the same random seed', () => {
    const seeds = (seed: number) => {
      const feeder = createFeeder({ random: makeRng(seed) });
      const feeds: Feed[] = [];
      feeder.onFeed((feed) => feeds.push(feed));
      const game = driver(feeder);
      while (feeds.length < 3) {
        game.setBall(OUT_BALL);
        game.run(0.05);
      }
      return feeds.map((feed) => feed.ball.seed);
    };
    const first = seeds(7);
    expect(new Set(first).size).toBe(3);
    expect(seeds(7)).toEqual(first);
  });
});
