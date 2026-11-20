/**
 * The headless game core: the one ball in play, the Feeder, the shot resolver
 * and the Streak, clocked by whoever drives it (the browser's animation loop,
 * or a test or simulation in Node). No rendering, sound, DOM or input device:
 * the caller feeds in frames and Swings, and listens for Shot and bounce events.
 *
 * Two modes. Return Drill (the default): the Feeder sends Feeds and the
 * player returns each one. Match (spec P2-b): each Rally starts with a Feed
 * as its Shot 0 (a stand-in for the Serve until P2-f1), the Opponent returns
 * the player's Returns, and a referee (`rally.ts`) ends the Rally with its
 * Rally End and loser. Every Shot heading to either side is looked ahead to
 * its Ideal Time; a Shot toward the Opponent asks it for its Shot at launch
 * (ADR 0002), and the Opponent strikes at the Ideal Time. The Streak is
 * Return Drill's only.
 *
 * Each frame: advance the simulation in fixed PHYSICS_DT substeps (slowed by
 * TIME_SCALE), report this frame's table bounces, let the referee judge them
 * (Match), let the resolver strike a due Return and judge its flight, let the
 * Opponent strike a due Shot (Match), then let the Feeder react (rally end,
 * "3, 2, 1", next Feed). Swings arrive between frames and are judged at once.
 *
 * Every random draw comes from the injected `random`, in a fixed order (the
 * Feeder's draws at each launch, the resolver's at each accepted Swing and
 * contact; in a Match also the Opponent's when a Shot toward it launches, and
 * each of its Shots' seed at the strike), so the same seed and the same Swings
 * replay the same session.
 */

import type { SwingEvent } from '../input/types.ts';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { launchBall, stepBall, type BallEvent, type BallState } from './ball.ts';
import { BALL_RADIUS, MAX_FRAME_DT, PHYSICS_DT, TABLE_TOP_Y, TIME_SCALE } from './constants.ts';
import { createFeeder, type Feeder } from './feeder.ts';
import { createListeners } from './listeners.ts';
import { createReferee, lookAhead, type Incoming, type Opponent, type RallyEndCall, type RallyEvent } from './rally.ts';
import { createScore, type StreakState } from './score.ts';
import { contactPoint, createShotResolver, feedResult, solveReturn, type ResolverParams, type ShotEvent } from './shotResolver.ts';
import { otherSide, type Side } from './side.ts';
import { createSimClock, simSecondsToRealMs } from './simClock.ts';
import { solveShot, type ShotIntent } from './solver.ts';

/** Return Drill (Feeds only) or a Match against the Opponent. */
export type GameMode = 'drill' | 'match';

/** The mode a page URL asks for: `?mode=match` is a Match; anything else is Return Drill. */
export function gameModeFromSearch(search: string): GameMode {
  return new URLSearchParams(search).get('mode') === 'match' ? 'match' : 'drill';
}

export interface GameCoreOptions {
  /** Uniform random numbers in [0, 1): the one source of randomness. Build one with `makeRng(seed)`. */
  random: () => number;
  /** The resolver's parameters, read on every use: `knobResolverParams` in the game. */
  resolverParams: () => ResolverParams;
  /** The player's hitting hand, read at each accepted Swing. */
  hand: () => Hand;
  /** Return Drill unless told otherwise. */
  mode?: GameMode;
  /**
   * Who plays the far end in a Match: the game passes the Opponent's brain at
   * the Match's Difficulty (`createBrain`, spec P2-c); the scripted Opponent
   * (no mistakes) unless told otherwise, for tests.
   */
  opponent?: Opponent;
}

/** One frame of the game loop. TIME_SCALE is read inside. */
export interface CoreFrame {
  /** performance.now() for this frame. */
  nowMs: number;
  /** Real seconds since the last frame. */
  elapsedSeconds: number;
}

export type BounceEvent = Extract<BallEvent, { type: 'bounce' }>;

/** The Opponent's decision for the Shot coming toward it (ADR 0002), made at that Shot's launch. */
export interface OpponentPlan {
  /** The Shot coming toward the Opponent, with its Ideal Time and the ball there. */
  readonly incoming: Incoming;
  /** The Shot it will strike at the Ideal Time, or a Whiff. */
  readonly choice: ShotIntent | 'whiff';
}

export interface GameCore {
  readonly mode: GameMode;
  /** The one ball in play; replaced by each Feed, Return, Opponent Shot and debug throw. */
  readonly ball: BallState;
  readonly feeder: Feeder;
  /** The Streak and the best Streak this session (Return Drill; it stays 0 in a Match). */
  readonly streak: StreakState;
  /**
   * In a Match, the Opponent's plan for the Shot coming toward it: set when
   * that Shot launches, cleared when the Opponent strikes or Whiffs at the
   * Ideal Time, or the Rally ends. Null otherwise (and always in Return
   * Drill). The Opponent's body reads it to move and swing (P2-d); it never
   * changes an outcome.
   */
  readonly opponentPlan: OpponentPlan | null;
  /** Advance one frame: physics, the referee, the resolver, the Opponent, then the Feeder. */
  frame(f: CoreFrame): void;
  /** Judge a Swing received at `nowMs`. Ignored while paused. */
  swing(swing: SwingEvent, nowMs: number): void;
  /**
   * Pause or resume (onboarding, calibration, hand lost). Paused, the Feeder
   * sends no new Feed and Swings are ignored; a ball in flight plays out (in a
   * Match, so does the Rally). Cheap to call every frame.
   */
  setPaused(paused: boolean): void;
  /** Make `ball` the ball in play (debug throws). */
  setBall(ball: BallState): void;
  /** Every resolver event, after the core has acted on it. Returns an unsubscribe function. */
  onShot(listener: (e: ShotEvent) => void): () => void;
  /** Every table bounce, live or not (for the bounce sound). Returns an unsubscribe function. */
  onBounce(listener: (e: BounceEvent) => void): () => void;
  /**
   * In a Match, each Rally's Shots, its table bounces while it is on, and its
   * end. Never in Return Drill. Returns an unsubscribe function.
   */
  onRally(listener: (e: RallyEvent) => void): () => void;
  /**
   * Each Shot that will reach its receiver's end (it has an Ideal Time), as
   * it launches: every Feed and, in a Match, every Shot by either side that
   * first lands on the other half. Returns an unsubscribe function.
   */
  onIncoming(listener: (incoming: Incoming) => void): () => void;
}

export function createGameCore(options: GameCoreOptions): GameCore {
  const { random } = options;
  const mode = options.mode ?? 'drill';
  const opponent = options.opponent ?? createScriptedOpponent();

  /**
   * The one ball in play: at rest on the player's half until something launches
   * it. Anything that launches a ball (a Feed, a Return, an Opponent Shot, a
   * debug throw) replaces it; the Feeder watches whichever ball is here to tell
   * when the rally ends.
   */
  let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
  let paused = false;
  const simClock = createSimClock();
  const referee = createReferee();
  /** In a Match, from a Rally's Shot 0 until its Rally End. */
  let rallyOn = false;
  /** The index of the latest Shot in the current Rally (0 = the Feed). */
  let shotIndex = 0;
  /** The Opponent's choice for the Shot coming toward it, struck at its Ideal Time. */
  let opponentPlan: OpponentPlan | null = null;
  // In a Match, the Feeder's rally lasts until the referee calls the Rally End.
  const feeder = createFeeder({ random, holdRally: () => rallyOn });
  const resolver = createShotResolver({ params: options.resolverParams, hand: options.hand, random });
  const score = createScore();
  const shotEvents = createListeners<ShotEvent>();
  const bounces = createListeners<BounceEvent>();
  const rallyEvents = createListeners<RallyEvent>();
  const incomings = createListeners<Incoming>();

  /** End the Rally, if the referee has just called a Rally End. */
  function endRally(call: RallyEndCall | null, atMs: number): void {
    if (!call || !rallyOn) return;
    rallyOn = false;
    opponentPlan = null;
    rallyEvents.emit({ type: 'end', atMs, end: call.end, loser: call.loser });
  }

  /**
   * A Shot by `by` has just launched as the ball in play: in a Match, tell the
   * referee; then look it ahead to its Ideal Time at the receiver's end.
   * Returns its Incoming, or null if it never gets there: the receiver has no
   * chance at it, and the referee ends the Rally on its flight.
   */
  function launched(by: Side, struck: BallState, atMs: number): Incoming | null {
    if (rallyOn) {
      referee.shot(by);
      rallyEvents.emit({ type: 'shot', atMs, by, shotIndex });
    }
    const receiver = otherSide(by);
    const ahead = lookAhead(struck, receiver);
    if (!ahead) {
      if (rallyOn) endRally(referee.noReturn(), atMs);
      return null;
    }
    const incoming: Incoming = {
      receiver,
      ball: struck,
      launchedAtMs: atMs,
      ideal: ahead.ideal,
      idealAtMs: atMs + simSecondsToRealMs(ahead.ideal.simSeconds, TIME_SCALE.value),
      strike: ahead.strike,
      shotIndex,
    };
    incomings.emit(incoming);
    return incoming;
  }

  function handleShot(event: ShotEvent, nowMs: number): void {
    if (event.type === 'contact') ball = event.ball;
    if (mode === 'drill') {
      const result = feedResult(event);
      if (result === 'returned') score.addReturn();
      else if (result === 'failed') score.breakStreak();
    } else if (rallyOn) {
      if (event.type === 'contact') {
        // The player's Return: the Opponent decides its Shot as it launches (ADR 0002).
        shotIndex++;
        const incoming = launched('player', event.ball, event.atMs);
        if (incoming) opponentPlan = { incoming, choice: opponent.chooseShot(incoming, random) };
      } else if (event.type === 'miss' || event.type === 'late' || (event.type === 'early' && event.final)) {
        // The player's chance has passed: nothing launches, the ball flies on.
        endRally(referee.noReturn(), nowMs);
      }
    }
    shotEvents.emit(event);
  }

  /** At the Ideal Time, the Opponent strikes the ball with the Shot it chose, or Whiffs. */
  function opponentStrike(nowMs: number): void {
    if (!opponentPlan || nowMs < opponentPlan.incoming.idealAtMs) return;
    const { choice } = opponentPlan;
    opponentPlan = null;
    if (choice === 'whiff') {
      endRally(referee.noReturn(), nowMs);
      return;
    }
    // Like a player Return (ADR 0001): the target never moves because the solver failed.
    const position = contactPoint(ball.position);
    const solution = solveReturn(solveShot, position, choice);
    const seed = Math.floor(random() * 2 ** 32);
    ball = launchBall(position, solution.velocity, solution.spin, seed);
    shotIndex++;
    const incoming = launched('opponent', ball, nowMs);
    resolver.startIncoming({ idealAtMs: incoming?.idealAtMs ?? null, topspin: choice.topspin });
  }

  feeder.onFeed((feed) => {
    ball = feed.ball;
    if (mode === 'match') {
      // The Feed is the Rally's Shot 0, from the Opponent's end.
      referee.reset();
      rallyOn = true;
      shotIndex = 0;
      opponentPlan = null;
    }
    resolver.startIncoming(feed);
    launched('opponent', feed.ball, feed.launchedAtMs);
  });
  // Faster Feeds every FEED_SPEEDUP_EVERY Returns.
  score.subscribe(({ streak }) => feeder.setStreak(streak));

  return {
    mode,
    get ball() {
      return ball;
    },
    feeder,
    get streak() {
      return { streak: score.streak, best: score.best };
    },
    get opponentPlan() {
      return opponentPlan;
    },

    frame({ nowMs, elapsedSeconds }) {
      // Fixed 240 Hz substeps, slowed by TIME_SCALE. This frame's ball events
      // (bounces for the sound, net and out for the rally) are collected for
      // the bounce listeners, the referee and the shot resolver to consume.
      const steps = simClock.advance(elapsedSeconds, TIME_SCALE.value);
      const ballEvents: BallEvent[] = [];
      for (let i = 0; i < steps; i++) {
        const step = stepBall(ball);
        ball = step.state;
        ballEvents.push(...step.events);
      }
      for (const event of ballEvents) if (event.type === 'bounce') bounces.emit(event);

      // In a Match, the referee judges this frame's flight of the Shot in play.
      for (const event of ballEvents) {
        if (!rallyOn) break;
        if (event.type === 'bounce') rallyEvents.emit({ type: 'bounce', atMs: nowMs, half: event.half });
        endRally(referee.ballEvent(event), nowMs);
      }

      // Judge the Return in flight, strike a due contact (replacing the ball),
      // or call a Miss; then the Opponent strikes a due Shot; then the Feeder
      // looks at the ball.
      for (const event of resolver.update(nowMs, ball, ballEvents)) handleShot(event, nowMs);
      opponentStrike(nowMs);

      // The pause and "3, 2, 1" run on real time, capped like the simulation so
      // a background tab doesn't fire a Feed the moment it comes back.
      feeder.update({ realSeconds: Math.min(elapsedSeconds, MAX_FRAME_DT), simSeconds: steps * PHYSICS_DT, nowMs }, ball);
    },

    swing(swing, nowMs) {
      if (paused) return;
      for (const event of resolver.swing(swing, nowMs)) handleShot(event, nowMs);
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
    onRally: rallyEvents.subscribe,
    onIncoming: incomings.subscribe,
  };
}
