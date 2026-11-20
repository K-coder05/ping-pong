/**
 * The headless game core: the one ball in play, the Feeder, the shot resolver
 * and the Streak, clocked by whoever drives it (the browser's animation loop,
 * or a test or simulation in Node). No rendering, sound, DOM or input device:
 * the caller feeds in frames and Swings, and listens for Shot and bounce events.
 *
 * Each frame: advance the simulation in fixed PHYSICS_DT substeps (slowed by
 * TIME_SCALE), report this frame's table bounces, let the resolver strike a
 * due Return and judge its flight, then let the Feeder react (rally end,
 * "3, 2, 1", next Feed). Swings arrive between frames and are judged at once.
 *
 * Every random draw comes from the injected `random`, in a fixed order (the
 * Feeder's draws at each launch, the resolver's at each accepted Swing and
 * contact), so the same seed and the same Swings replay the same session.
 */

import type { SwingEvent } from '../input/types.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { launchBall, stepBall, type BallEvent, type BallState } from './ball.ts';
import { BALL_RADIUS, MAX_FRAME_DT, PHYSICS_DT, TABLE_TOP_Y, TIME_SCALE } from './constants.ts';
import { createFeeder, type Feeder } from './feeder.ts';
import { createListeners } from './listeners.ts';
import { createScore, type StreakState } from './score.ts';
import { createShotResolver, feedResult, type ResolverParams, type ShotEvent } from './shotResolver.ts';
import { createSimClock } from './simClock.ts';

export interface GameCoreOptions {
  /** Uniform random numbers in [0, 1): the one source of randomness. Build one with `makeRng(seed)`. */
  random: () => number;
  /** The resolver's parameters, read on every use: `knobResolverParams` in the game. */
  resolverParams: () => ResolverParams;
  /** The player's hitting hand, read at each accepted Swing. */
  hand: () => Hand;
}

/** One frame of the game loop. TIME_SCALE is read inside. */
export interface CoreFrame {
  /** performance.now() for this frame. */
  nowMs: number;
  /** Real seconds since the last frame. */
  elapsedSeconds: number;
}

export type BounceEvent = Extract<BallEvent, { type: 'bounce' }>;

export interface GameCore {
  /** The one ball in play; replaced by each Feed, Return and debug throw. */
  readonly ball: BallState;
  readonly feeder: Feeder;
  /** The Streak and the best Streak this session. */
  readonly streak: StreakState;
  /** Advance one frame: physics, the resolver, then the Feeder. */
  frame(f: CoreFrame): void;
  /** Judge a Swing received at `nowMs`. Ignored while paused. */
  swing(swing: SwingEvent, nowMs: number): void;
  /**
   * Pause or resume (onboarding, calibration, hand lost). Paused, the Feeder
   * sends no new Feed and Swings are ignored; a ball in flight plays out.
   * Cheap to call every frame.
   */
  setPaused(paused: boolean): void;
  /** Make `ball` the ball in play (debug throws). */
  setBall(ball: BallState): void;
  /** Every resolver event, after the core has acted on it. Returns an unsubscribe function. */
  onShot(listener: (e: ShotEvent) => void): () => void;
  /** Every table bounce, live or not (for the bounce sound). Returns an unsubscribe function. */
  onBounce(listener: (e: BounceEvent) => void): () => void;
}

export function createGameCore(options: GameCoreOptions): GameCore {
  const { random } = options;

  /**
   * The one ball in play: at rest on the player's half until something launches
   * it. Anything that launches a ball (a Feed, a Return, a debug throw) replaces
   * it; the Feeder watches whichever ball is here to tell when the rally ends.
   */
  let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
  let paused = false;
  const simClock = createSimClock();
  const feeder = createFeeder({ random });
  const resolver = createShotResolver({ params: options.resolverParams, hand: options.hand, random });
  const score = createScore();
  const shotEvents = createListeners<ShotEvent>();
  const bounces = createListeners<BounceEvent>();

  function handleShot(event: ShotEvent): void {
    if (event.type === 'contact') ball = event.ball;
    const result = feedResult(event);
    if (result === 'returned') score.addReturn();
    else if (result === 'failed') score.breakStreak();
    shotEvents.emit(event);
  }

  feeder.onFeed((feed) => {
    ball = feed.ball;
    resolver.startFeed(feed);
  });
  // Faster Feeds every FEED_SPEEDUP_EVERY Returns.
  score.subscribe(({ streak }) => feeder.setStreak(streak));

  return {
    get ball() {
      return ball;
    },
    feeder,
    get streak() {
      return { streak: score.streak, best: score.best };
    },

    frame({ nowMs, elapsedSeconds }) {
      // Fixed 240 Hz substeps, slowed by TIME_SCALE. This frame's ball events
      // (bounces for the sound, net and out for the rally) are collected for
      // the bounce listeners and the shot resolver to consume.
      const steps = simClock.advance(elapsedSeconds, TIME_SCALE.value);
      const ballEvents: BallEvent[] = [];
      for (let i = 0; i < steps; i++) {
        const step = stepBall(ball);
        ball = step.state;
        ballEvents.push(...step.events);
      }
      for (const event of ballEvents) if (event.type === 'bounce') bounces.emit(event);

      // Judge the Return in flight, strike a due contact (replacing the ball),
      // or call a Miss, before the Feeder looks at the ball.
      resolver.update(nowMs, ball, ballEvents).forEach(handleShot);

      // The pause and "3, 2, 1" run on real time, capped like the simulation so
      // a background tab doesn't fire a Feed the moment it comes back.
      feeder.update({ realSeconds: Math.min(elapsedSeconds, MAX_FRAME_DT), simSeconds: steps * PHYSICS_DT, nowMs }, ball);
    },

    swing(swing, nowMs) {
      if (paused) return;
      resolver.swing(swing, nowMs).forEach(handleShot);
    },

    setPaused(next) {
      paused = next;
      feeder.setPaused(next);
    },

    setBall(next) {
      ball = next;
    },

    onShot: shotEvents.subscribe,
    onBounce: bounces.subscribe,
  };
}
