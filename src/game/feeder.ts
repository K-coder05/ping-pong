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
 */

import { launchBall, simulate, type BallState, type Vec3 } from './ball.ts';
import {
  BALL_RADIUS,
  FEED_COUNTDOWN_FROM,
  FEED_COUNTDOWN_STEP_S,
  FEED_FLIGHT_TIME_S,
  FEED_PAUSE_S,
  FEED_SPEEDUP_EVERY,
  FEED_SPEEDUP_FACTOR,
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
import { simSecondsToRealMs } from './simClock.ts';
import { solveLaunch, type TablePoint } from './solver.ts';

/** When and where a Feed reaches the player's end of the table, after its bounce. */
export interface IdealTime {
  /** Simulated seconds after launch. Convert to real time with `simSecondsToRealMs`. */
  simSeconds: number;
  /** Ball centre as it crosses z = PLAYER_END_Z. */
  position: Vec3;
}

/** Longest look-ahead: a slow Feed reaches the player's end well inside this. */
const IDEAL_TIME_HORIZON_S = 4;

/**
 * Simulate a just-launched Feed ahead (deterministic, same integrator) to find
 * its Ideal Time: the moment its centre crosses the player's end of the table
 * after bouncing on the player's half. Null if it never does (net, out first).
 * Time and position are interpolated within the crossing substep.
 */
export function findIdealTime(feed: BallState): IdealTime | null {
  let previous = feed;
  let ideal: IdealTime | null = null;
  simulate(feed, {
    maxTime: IDEAL_TIME_HORIZON_S,
    until: (state, time) => {
      const before = previous;
      previous = state;
      if (state.status !== 'live') return true;
      if (state.lastBounceHalf !== 'player' || state.position.z < PLAYER_END_Z) return false;
      const a = before.position;
      const b = state.position;
      const f = b.z === a.z ? 1 : Math.min(1, Math.max(0, (PLAYER_END_Z - a.z) / (b.z - a.z)));
      ideal = {
        simSeconds: time - (1 - f) * PHYSICS_DT,
        position: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f },
      };
      return true;
    },
  });
  return ideal;
}

/** One Feed, as launched. */
export interface Feed {
  /** The ball at launch, from FEEDER_MOUTH; the game loop makes it the ball in play. */
  readonly ball: BallState;
  /** Where it was aimed to land on the player's half. */
  readonly target: TablePoint;
  /**
   * The flight time the solver aimed with, in simulated seconds (raised if the
   * arc had to clear the net). A pace setting, not a timestamp: drag makes the
   * real landing a few percent earlier. For timing, use `idealTime`.
   */
  readonly flightTime: number;
  /** When and where it reaches the player's end; null only if it never would (extreme knob values). */
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
  /** Called when a Feed launches. Returns an unsubscribe function. */
  onFeed(listener: (feed: Feed) => void): () => void;
  /**
   * Called when the rally ends: the ball in play is no longer live or has
   * stopped, and the Feed's Hit Window has closed. Returns an unsubscribe function.
   */
  onRallyEnd(listener: (ball: BallState) => void): () => void;
}

export interface FeederOptions {
  /** Uniform random numbers in [0, 1); inject a seeded one in tests. */
  random?: () => number;
}

/** Below this speed (m/s), on the table, a live ball has come to rest and the rally is over. */
const AT_REST_SPEED = 0.05;
/** How close (m) the ball's bottom must be to the table top to count as resting on it. */
const AT_REST_HEIGHT = 0.001;

export function createFeeder(options: FeederOptions = {}): Feeder {
  const random = options.random ?? Math.random;
  const feedListeners = new Set<(feed: Feed) => void>();
  const rallyEndListeners = new Set<(ball: BallState) => void>();

  let phase: FeederPhase = 'waiting';
  /** Real seconds spent in the current waiting or countdown phase. */
  let phaseSeconds = 0;
  let currentFeed: Feed | null = null;
  let simSecondsSinceFeed = 0;
  let streak = 0;

  function launch(nowMs: number): void {
    const speedUps = Math.floor(streak / FEED_SPEEDUP_EVERY);
    const flightTime = FEED_FLIGHT_TIME_S.value * FEED_SPEEDUP_FACTOR ** speedUps;
    const feed = planFeed(random, flightTime, nowMs);
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
        if (ballIsDone(ball) && !hitWindowIsOpen(currentFeed, frame.nowMs)) endRally(ball);
        return;
      }
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

/** A Feed to a random spot on the player's half, solved for `flightTime` and launched at `nowMs`. */
function planFeed(random: () => number, flightTime: number, nowMs: number): Feed {
  const target = {
    x: (2 * random() - 1) * FEED_TARGET_HALF_WIDTH,
    z: FEED_TARGET_Z_MIN + random() * (FEED_TARGET_Z_MAX - FEED_TARGET_Z_MIN),
  };
  const solution = solveLaunch(FEEDER_MOUTH, target, flightTime);
  const ball = launchBall(FEEDER_MOUTH, solution.velocity);
  const idealTime = findIdealTime(ball);
  return {
    ball,
    target,
    flightTime: solution.flightTime,
    idealTime,
    launchedAtMs: nowMs,
    idealAtMs: idealTime ? nowMs + simSecondsToRealMs(idealTime.simSeconds, TIME_SCALE.value) : null,
  };
}
