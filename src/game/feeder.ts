/**
 * The Feeder (SPEC "Feeder and ball physics"): the machine at the far end that
 * sends one Feed at a time onto the player's half.
 *
 * It is a small state machine clocked by the game loop:
 *
 *   waiting ──FEED_PAUSE_S──▶ countdown "3, 2, 1" ──▶ feeding ──rally ends──▶ waiting
 *
 * The pause and the cue run on real time (they are for the player); the
 * flight runs on simulated time. The Feeder never steps or owns the ball: it
 * hands each Feed's launched ball to `onFeed` listeners (the game loop makes
 * it the ball in play) and watches whatever ball it is given each frame, so a
 * Return that replaces the Feed mid-rally needs no Feeder call. The rally ends
 * when that ball is no longer live (net, out) or has come to rest on the
 * table, but never before the Feed's Hit Window has closed.
 *
 * While paused (the player's hand can't be seen), it stays in `waiting` and
 * sends nothing; a "3, 2, 1" in progress is cancelled. A Feed already in
 * flight plays out as usual (Returned, or failed like any other), so tracking
 * loss never changes a rally's outcome; only the next Feed waits. Resumed, it
 * starts the wait and the cue over, giving the player time to get ready.
 */

import { launchBall, type BallState } from './ball.ts';
import {
  BALL_RADIUS,
  FEED_COUNTDOWN_FROM,
  FEED_COUNTDOWN_STEP_S,
  FEED_FLIGHT_TIME_S,
  FEED_MAX_DRAWS,
  FEED_PAUSE_S,
  FEED_SPIN_MAX_REVS,
  FEED_SPIN_STEP_REVS,
  FEED_SPEEDUP_EVERY,
  FEED_SPEEDUP_FACTOR,
  FEED_TARGET_HALF_WIDTH,
  FEED_TARGET_Z_MAX,
  FEED_TARGET_Z_MIN,
  FEEDER_MOUTH,
  HIT_WINDOW_MS,
  TABLE_TOP_Y,
  TIME_SCALE,
  TIMING_OFFSET_MS,
} from './constants.ts';
import { revsToRadPerSec } from '../physics/spin.ts';
import { findIdealTime, type IdealTime } from './rally.ts';
import { simSecondsToRealMs } from './simClock.ts';
import { solveShot, type ShotIntent, type ShotSolution, type ShotSolver, type TablePoint } from './solver.ts';

/** One Feed, as launched. */
export interface Feed {
  /** The ball at launch, from FEEDER_MOUTH; the game loop makes it the ball in play. */
  readonly ball: BallState;
  /** Where it was aimed to land on the player's half. */
  readonly target: TablePoint;
  /**
   * The flight time the solver aimed with, in simulated seconds (raised if the
   * arc had to clear the net): launch to landing, within about 10 ms. For
   * timing, use `idealTime`.
   */
  readonly flightTime: number;
  /** The Topspin it was drawn with (rad/s); negative is Backspin. Zero for the fallback Feed. */
  readonly topspin: number;
  /**
   * When and where it reaches the player's end. A draw without one is redrawn,
   * so this is null only if even the centre fallback has none (never at the
   * knobs' ranges).
   */
  readonly idealTime: IdealTime | null;
  /** performance.now() at launch. */
  readonly launchedAtMs: number;
  /**
   * The Ideal Time on the performance.now() clock, converted with TIME_SCALE
   * at launch. If TIME_SCALE changes mid-flight, recompute from
   * `simSecondsSinceFeed` with `simSecondsToRealMs`.
   */
  readonly idealAtMs: number | null;
}

export type FeederPhase = 'waiting' | 'countdown' | 'feeding';

/** One game-loop frame, as the Feeder sees it. */
export interface FeederFrame {
  /** Real seconds since the last frame (drives the pause and the cue). */
  realSeconds: number;
  /** Simulated seconds the ball was stepped this frame (drives `simSecondsSinceFeed`). */
  simSeconds: number;
  /** performance.now() for this frame. */
  nowMs: number;
}

export interface Feeder {
  readonly phase: FeederPhase;
  /** 3, 2 or 1 while the cue is showing, else null. */
  readonly countdown: number | null;
  /** The latest Feed, while its rally is on; null between rallies. */
  readonly currentFeed: Feed | null;
  /** Simulated seconds since the current Feed launched (compare with its `idealTime.simSeconds`). */
  readonly simSecondsSinceFeed: number;
  /** Advance by one frame. `ball` is the ball in play after this frame's physics. */
  update(frame: FeederFrame, ball: BallState): void;
  /**
   * Tell the Feeder the current Streak: every FEED_SPEEDUP_EVERY Returns, the
   * flight time of later Feeds is multiplied by FEED_SPEEDUP_FACTOR (about 5%
   * shorter); a reset Streak restores the base pace.
   */
  setStreak(streak: number): void;
  /** Whether the Feeder is paused (see `setPaused`). */
  readonly paused: boolean;
  /**
   * Pause or resume the Feeder, e.g. while the player's hand can't be seen.
   * Cheap to call every frame.
   * Paused, it sends no new Feed and cancels a "3, 2, 1" in progress; a Feed
   * in flight plays out. Resumed, it waits FEED_PAUSE_S and counts "3, 2, 1"
   * again before the next one.
   */
  setPaused(paused: boolean): void;
  /** Called when a Feed launches. Returns an unsubscribe function. */
  onFeed(listener: (feed: Feed) => void): () => void;
  /**
   * Called when the rally ends: the ball in play is no longer live or has
   * stopped, and the Feed's Hit Window has closed. Returns an unsubscribe function.
   */
  onRallyEnd(listener: (ball: BallState) => void): () => void;
}

export interface FeederOptions {
  /** Uniform random numbers in [0, 1); build one with `makeRng(seed)`. */
  random: () => number;
  /** The target solver; `solveShot` unless a test stands one in. */
  solve?: ShotSolver;
  /**
   * While this returns true, the rally is not over even if the ball is done
   * (in a Match, until the referee has called the Rally End: a late but
   * accepted Swing can still strike a ball that has dropped past the table).
   * Return Drill leaves it out.
   */
  holdRally?: () => boolean;
}

/** Below this speed (m/s), on the table, a live ball has come to rest and the rally is over. */
const AT_REST_SPEED = 0.05;
/** How close (m) the ball's bottom must be to the table top to count as resting on it. */
const AT_REST_HEIGHT = 0.001;

export function createFeeder(options: FeederOptions): Feeder {
  const random = options.random;
  const solve = options.solve ?? solveShot;
  const feedListeners = new Set<(feed: Feed) => void>();
  const rallyEndListeners = new Set<(ball: BallState) => void>();

  let phase: FeederPhase = 'waiting';
  /** Real seconds spent in the current waiting or countdown phase. */
  let phaseSeconds = 0;
  let currentFeed: Feed | null = null;
  let simSecondsSinceFeed = 0;
  let streak = 0;
  let paused = false;

  function launch(nowMs: number): void {
    const speedUps = Math.floor(streak / FEED_SPEEDUP_EVERY);
    const flightTime = FEED_FLIGHT_TIME_S.value * FEED_SPEEDUP_FACTOR ** speedUps;
    const maxTopspin = revsToRadPerSec(Math.min(speedUps * FEED_SPIN_STEP_REVS.value, FEED_SPIN_MAX_REVS.value));
    const feed = planFeed(random, solve, flightTime, maxTopspin, nowMs);
    phase = 'feeding';
    currentFeed = feed;
    simSecondsSinceFeed = 0;
    for (const listener of feedListeners) listener(feed);
  }

  function endRally(ball: BallState): void {
    phase = 'waiting';
    phaseSeconds = 0;
    currentFeed = null;
    for (const listener of rallyEndListeners) listener(ball);
  }

  return {
    get phase() {
      return phase;
    },
    get countdown() {
      if (phase !== 'countdown') return null;
      return FEED_COUNTDOWN_FROM - Math.floor(phaseSeconds / FEED_COUNTDOWN_STEP_S.value);
    },
    get currentFeed() {
      return currentFeed;
    },
    get simSecondsSinceFeed() {
      return simSecondsSinceFeed;
    },
    update(frame, ball) {
      if (phase === 'feeding') {
        simSecondsSinceFeed += frame.simSeconds;
        if (ballIsDone(ball) && !hitWindowIsOpen(currentFeed, frame.nowMs) && !options.holdRally?.()) endRally(ball);
        return;
      }
      if (paused) return;
      phaseSeconds += frame.realSeconds;
      if (phase === 'waiting' && phaseSeconds >= FEED_PAUSE_S.value) {
        phase = 'countdown';
        phaseSeconds = 0;
      }
      if (phase === 'countdown' && phaseSeconds >= FEED_COUNTDOWN_FROM * FEED_COUNTDOWN_STEP_S.value) {
        launch(frame.nowMs);
      }
    },
    setStreak(next) {
      streak = next;
    },
    get paused() {
      return paused;
    },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      // Between rallies, the wait and any "3, 2, 1" start over.
      if (paused && phase !== 'feeding') {
        phase = 'waiting';
        phaseSeconds = 0;
      }
    },
    onFeed(listener) {
      feedListeners.add(listener);
      return () => void feedListeners.delete(listener);
    },
    onRallyEnd(listener) {
      rallyEndListeners.add(listener);
      return () => void rallyEndListeners.delete(listener);
    },
  };
}

/** The ball in play can do nothing more: dead or out, or come to rest on the table. */
function ballIsDone(ball: BallState): boolean {
  if (ball.status !== 'live') return true;
  const { x, y, z } = ball.velocity;
  const onTable = ball.position.y <= TABLE_TOP_Y + BALL_RADIUS + AT_REST_HEIGHT;
  return onTable && Math.hypot(x, y, z) < AT_REST_SPEED;
}

/**
 * Whether a Swing could still return the Feed: until HIT_WINDOW_MS after its
 * Ideal Time, plus the Timing Offset (a Swing is seen that much later than
 * the player meant it). A Feed is out moments after it passes the player's
 * end, but a late Swing launches the Return from wherever the ball is, so the
 * rally waits.
 */
function hitWindowIsOpen(feed: Feed | null, nowMs: number): boolean {
  return feed?.idealAtMs != null && nowMs < feed.idealAtMs + HIT_WINDOW_MS.value + TIMING_OFFSET_MS.value;
}

/**
 * A Feed to a random spot on the player's half, with a Topspin drawn
 * uniformly from ±`maxTopspin` (rad/s), solved for `flightTime` and
 * launched at `nowMs`. A draw the solver can't solve, or whose Feed would
 * never reach the player (no Ideal Time), is redrawn with the same `random`;
 * after FEED_MAX_DRAWS failed draws, the Feed goes to the centre of the
 * target area with no spin, solved best-effort. Each Feed launches with the
 * solution's spin and its own seed (for the Net-cord), drawn from `random`.
 */
function planFeed(random: () => number, solve: ShotSolver, flightTime: number, maxTopspin: number, nowMs: number): Feed {
  for (let draw = 0; draw < FEED_MAX_DRAWS; draw++) {
    const target = {
      x: (2 * random() - 1) * FEED_TARGET_HALF_WIDTH,
      z: FEED_TARGET_Z_MIN + random() * (FEED_TARGET_Z_MAX - FEED_TARGET_Z_MIN),
    };
    // No spin to draw, no random consumed: a spinless Feed's draws are the same as before spin existed.
    const topspin = maxTopspin > 0 ? (2 * random() - 1) * maxTopspin : 0;
    const intent: ShotIntent = { target, flightTime, topspin, sidespin: 0 };
    const solution = solve(FEEDER_MOUTH, intent);
    if (!solution) continue;
    const feed = launchFeed(random, target, topspin, solution, nowMs);
    if (feed.idealTime) return feed;
  }
  const centre: ShotIntent = { target: { x: 0, z: (FEED_TARGET_Z_MIN + FEED_TARGET_Z_MAX) / 2 }, flightTime, topspin: 0, sidespin: 0 };
  return launchFeed(random, centre.target, 0, solve(FEEDER_MOUTH, centre, { bestEffort: true }), nowMs);
}

/** Launch a solved Feed with its own seed, and look ahead for its Ideal Time. */
function launchFeed(random: () => number, target: TablePoint, topspin: number, solution: ShotSolution, nowMs: number): Feed {
  const seed = Math.floor(random() * 2 ** 32);
  const ball = launchBall(FEEDER_MOUTH, solution.velocity, solution.spin, seed);
  const idealTime = findIdealTime(ball, 'player');
  return {
    ball,
    target,
    flightTime: solution.flightTime,
    topspin,
    idealTime,
    launchedAtMs: nowMs,
    idealAtMs: idealTime ? nowMs + simSecondsToRealMs(idealTime.simSeconds, TIME_SCALE.value) : null,
  };
}
