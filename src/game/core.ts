/**
 * The headless game core: the one ball in play, the Feeder, the shot resolver
 * and the Streak, clocked by whoever drives it (the browser's animation loop,
 * or a test or simulation in Node). No rendering, sound, DOM or input device:
 * the caller feeds in frames and Swings, and listens for Shot and bounce events.
 *
 * Two modes. Return Drill (the default): the Feeder sends Feeds and the
 * player returns each one. Match (specs P2-b, P2-f1, P2-f2): a scored Match
 * (`match.ts`) against the Opponent. Each Rally starts with a Serve by the
 * Match's server after a pause and the "3, 2, 1" cue: the Opponent's at
 * once, the player's from an automatic toss they swing at (a missed toss
 * drops, and the cue and toss start over, with no Point). The Opponent
 * returns the player's Returns, and a referee (`rally.ts`) calls the Serve
 * (legal, Fault or Let) and the Rally End, which awards the Point. Every
 * Shot heading to either side is looked ahead to its Ideal Time; a Shot
 * toward the Opponent asks it for its Shot at launch (ADR 0002), and the
 * Opponent strikes at the Ideal Time. The Streak is Return Drill's only.
 *
 * Each frame: advance the simulation in fixed PHYSICS_DT substeps (slowed by
 * TIME_SCALE), report this frame's table bounces, let the referee judge them
 * (Match), let the resolver strike a due Return and judge its flight, let the
 * Opponent strike a due Shot (Match), then let the Feeder (Return Drill) or
 * the Match's Serve clock react (rally end, "3, 2, 1", next Feed or Serve).
 * Swings arrive between frames and are judged at once.
 *
 * Every random draw comes from the injected `random`, in a fixed order (the
 * Feeder's draws at each launch, the resolver's at each accepted Swing and
 * contact, the same for a Swing at the toss and the player's Serve; in a
 * Match also the first server when the core is made, the Opponent's Serve
 * and its seed at each of its Serves, the Opponent's draws when a Shot
 * toward it launches, and each of its Shots' seed at the strike), so the
 * same seed and the same Swings replay the same session.
 */

import type { SwingEvent } from '../input/types.ts';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { launchBall, stepBall, type BallEvent, type BallState } from './ball.ts';
import {
  BALL_RADIUS,
  FEED_COUNTDOWN_FROM,
  FEED_COUNTDOWN_STEP_S,
  FEED_PAUSE_S,
  MAX_FRAME_DT,
  PHYSICS_DT,
  TABLE_TOP_Y,
  TIME_SCALE,
} from './constants.ts';
import { createFeeder, type Feeder } from './feeder.ts';
import { createListeners } from './listeners.ts';
import { awardPoint, cancelRally, newMatch, nextGame, startRally, type MatchConfig, type MatchState } from './match.ts';
import { createReferee, lookAhead, type Incoming, type Opponent, type RallyEnd, type RallyEndCall, type RallyEvent } from './rally.ts';
import { createScore, type StreakState } from './score.ts';
import { findTossIdealTime, launchToss, OPPONENT_SERVE_FROM, solveServe } from './serve.ts';
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
  /** The Match's length: one Game to 11 (DEFAULT_MATCH_CONFIG) unless told otherwise. Match mode only. */
  match?: MatchConfig;
  /** The Serve solver for both sides' Serves; `solveServe` unless a test stands one in. */
  solveServe?: typeof solveServe;
}

/** One Game to 11, win by 2. */
export const DEFAULT_MATCH_CONFIG: Readonly<MatchConfig> = Object.freeze({ pointsToWin: 11, winBy: 2, bestOf: 1 });

/** Real seconds between Games, on top of the usual pause before a Serve (FEED_PAUSE_S). */
export const GAME_BREAK_S = 3;

/**
 * What happened to the Match score, with the MatchState after it:
 * - `point`: a Rally End (or Fault) won `to` the Point; `match.phase` says
 *   whether it also won a Game (`game-over`) or the Match (`match-over`);
 * - `let`: the Serve was a Let and will be served again, no Point;
 * - `next-game`: after a Game, the core started the next one (0–0).
 */
export type MatchEvent =
  | { readonly type: 'point'; readonly atMs: number; readonly to: Side; readonly end: RallyEnd; readonly match: Readonly<MatchState> }
  | { readonly type: 'let'; readonly atMs: number; readonly match: Readonly<MatchState> }
  | { readonly type: 'next-game'; readonly atMs: number; readonly match: Readonly<MatchState> };

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
  /** Return Drill's Feeder. It sends nothing in a Match: the Match's Serve clock starts each Rally. */
  readonly feeder: Feeder;
  /** The Streak and the best Streak this session (Return Drill; it stays 0 in a Match). */
  readonly streak: StreakState;
  /**
   * The Match score and phase (read-only: a new object after each change);
   * null in Return Drill. The first server is drawn from `random`, and each
   * Rally's Serve is by `server`. The phase stays `pre-serve` through the
   * player's toss, until the Serve is struck.
   */
  readonly match: Readonly<MatchState> | null;
  /**
   * In a Match, the player's Serve toss while it is up (from the end of the
   * "3, 2, 1" until the Serve is struck or the toss is missed), as the
   * Incoming the player swings at: `ball` is the toss, `ideal` and `strike`
   * the falling ball at the strike height. Null otherwise.
   */
  readonly toss: Incoming | null;
  /** 3, 2 or 1 while the "3, 2, 1" cue before a Feed (Return Drill) or a Serve (Match) is showing, else null. */
  readonly countdown: number | null;
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
   * sends no new Feed and Swings are ignored; a Feed in flight plays out. In a
   * Match, pausing mid-Rally voids it (no Point, the Serve is played again
   * after the "3, 2, 1" once resumed); between Rallies it just waits. Cheap to
   * call every frame.
   */
  setPaused(paused: boolean): void;
  /** Make `ball` the ball in play (debug throws). */
  setBall(ball: BallState): void;
  /** Every resolver event, after the core has acted on it. Returns an unsubscribe function. */
  onShot(listener: (e: ShotEvent) => void): () => void;
  /** Every table bounce, live or not (for the bounce sound). Returns an unsubscribe function. */
  onBounce(listener: (e: BounceEvent) => void): () => void;
  /**
   * In a Match, each Rally's Shots (the Serve is Shot 0), its table bounces
   * while it is on, its Serve's result, and its end. Never in Return Drill.
   * Returns an unsubscribe function.
   */
  onRally(listener: (e: RallyEvent) => void): () => void;
  /**
   * In a Match, each change to the score: a Point, a Let, the next Game.
   * `core.match` is already updated. Never in Return Drill. Returns an
   * unsubscribe function.
   */
  onMatch(listener: (e: MatchEvent) => void): () => void;
  /**
   * Each Shot that will reach its receiver's end (it has an Ideal Time), as
   * it launches: every Feed and, in a Match, every Shot by either side that
   * first lands on the other half; and each of the player's Serve tosses,
   * as it goes up (`core.toss` is already that Incoming), so whoever swings
   * at Shots coming to the player swings at the toss the same way. Returns
   * an unsubscribe function.
   */
  onIncoming(listener: (incoming: Incoming) => void): () => void;
}

export function createGameCore(options: GameCoreOptions): GameCore {
  const { random } = options;
  const mode = options.mode ?? 'drill';
  const opponent = options.opponent ?? createScriptedOpponent();
  const serveSolver = options.solveServe ?? solveServe;
  const matchConfig: Readonly<MatchConfig> = { ...(options.match ?? DEFAULT_MATCH_CONFIG) };

  /**
   * The one ball in play: at rest on the player's half until something launches
   * it. Anything that launches a ball (a Feed, a Serve, a Return, an Opponent
   * Shot, a debug throw) replaces it; the Feeder (or, in a Match, the Serve
   * clock) watches whichever ball is here to tell when the rally is over.
   */
  let ball: BallState = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
  let paused = false;
  const simClock = createSimClock();
  const referee = createReferee();
  /** In a Match, from a Rally's Serve until its Rally End or Let. */
  let rallyOn = false;
  /** The index of the latest Shot in the current Rally (0 = the Serve, or the Feed in Return Drill). */
  let shotIndex = 0;
  /** Who served the current Rally. */
  let server: Side = 'opponent';
  /** The Opponent's choice for the Shot coming toward it, struck at its Ideal Time. */
  let opponentPlan: OpponentPlan | null = null;
  /** The Match score; the first server is the Match's first draw from `random`. Null in Return Drill. */
  let match: MatchState | null = mode === 'match' ? newMatch(matchConfig, random() < 0.5 ? 'player' : 'opponent') : null;
  /** The player's Serve toss while it is up; null otherwise. */
  let toss: Incoming | null = null;
  /**
   * In a Match, the time between Rallies, like the Feeder's: `serving` while
   * a Rally is on or its ball plays out (or a missed toss drops); then
   * `waiting` FEED_PAUSE_S (plus GAME_BREAK_S after a Game); then the "3, 2,
   * 1" `countdown`; then the Serve, or for the player the `toss` until they
   * serve or miss it. Real seconds, in the current phase.
   */
  let serveClock: { phase: 'waiting' | 'countdown' | 'toss' | 'serving'; seconds: number } = { phase: 'waiting', seconds: 0 };
  const feeder = createFeeder({ random });
  const newResolver = () => createShotResolver({ params: options.resolverParams, hand: options.hand, random, solveServe: serveSolver });
  let resolver = newResolver();
  const score = createScore();
  const shotEvents = createListeners<ShotEvent>();
  const bounces = createListeners<BounceEvent>();
  const rallyEvents = createListeners<RallyEvent>();
  const matchEvents = createListeners<MatchEvent>();
  const incomings = createListeners<Incoming>();

  /** End the Rally, if the referee has just called a Rally End, and award its Point. */
  function endRally(call: RallyEndCall | null, atMs: number): void {
    if (!call || !rallyOn || !match) return;
    rallyOn = false;
    opponentPlan = null;
    const to = otherSide(call.loser);
    match = awardPoint(match, to, matchConfig);
    rallyEvents.emit({ type: 'end', atMs, end: call.end, loser: call.loser });
    matchEvents.emit({ type: 'point', atMs, to, end: call.end, match });
  }

  /** Let the referee judge one event of the ball in play; report a Serve's result, a Let, a Rally End. */
  function judge(event: BallEvent, atMs: number): void {
    const before = referee.serveResult;
    const call = referee.ballEvent(event);
    const result = referee.serveResult;
    if (result && result !== before) {
      rallyEvents.emit({ type: 'serve', atMs, by: server, result });
      if (result === 'let' && match) {
        // No Point: the Rally is void and the same server serves again.
        rallyOn = false;
        opponentPlan = null;
        match = cancelRally(match);
        matchEvents.emit({ type: 'let', atMs, match });
      }
    }
    endRally(call, atMs);
  }

  /**
   * A Shot by `by` has just launched as the ball in play: in a Match, tell the
   * referee (a Serve when `serve`); then look it ahead to its Ideal Time at
   * the receiver's end. Returns its Incoming, or null if it never gets there:
   * the receiver has no chance at it, and the referee ends the Rally on its flight.
   */
  function launched(by: Side, struck: BallState, atMs: number, serve = false): Incoming | null {
    if (rallyOn) {
      if (serve) referee.serve(by);
      else referee.shot(by);
      rallyEvents.emit({ type: 'shot', atMs, by, shotIndex });
    }
    const receiver = otherSide(by);
    const ahead = lookAhead(struck, receiver, { serve });
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

  /** The "3, 2, 1" is over: the Match's server serves (the player from a toss). */
  function serve(nowMs: number): void {
    if (!match) return;
    if (match.server === 'player') tossUp(nowMs);
    else opponentServe(nowMs);
  }

  /** A Serve by `by` is about to launch: the Rally starts. */
  function startServe(by: Side): void {
    if (!match) return;
    serveClock = { phase: 'serving', seconds: 0 };
    match = startRally(match);
    referee.reset();
    rallyOn = true;
    shotIndex = 0;
    opponentPlan = null;
    server = by;
  }

  /**
   * Start a Rally with the Opponent's Serve. It is solved as the brain checked
   * it; if it somehow can't be, it is served best effort, and the referee
   * calls whatever it does.
   */
  function opponentServe(nowMs: number): void {
    startServe('opponent');
    const intent = opponent.chooseServe(random);
    const solution = serveSolver(OPPONENT_SERVE_FROM, intent) ?? serveSolver(OPPONENT_SERVE_FROM, intent, solveShot, { bestEffort: true });
    const seed = Math.floor(random() * 2 ** 32);
    ball = launchBall(OPPONENT_SERVE_FROM, solution.velocity, solution.spin, seed);
    const incoming = launched(server, ball, nowMs, true);
    resolver.startIncoming({ idealAtMs: incoming?.idealAtMs ?? null, topspin: intent.topspin });
  }

  /**
   * The player's Serve turn: the toss goes up as the ball in play, and the
   * resolver judges a Swing at it against its Ideal Time. The Rally doesn't
   * start (the Match stays `pre-serve`) until the Serve is struck.
   */
  function tossUp(nowMs: number): void {
    serveClock = { phase: 'toss', seconds: 0 };
    opponentPlan = null;
    ball = launchToss(options.hand());
    const ahead = findTossIdealTime(ball);
    if (!ahead) throw new Error('The toss never falls through the strike height: check the TOSS_* constants');
    toss = {
      receiver: 'player',
      ball,
      launchedAtMs: nowMs,
      ideal: ahead.ideal,
      idealAtMs: nowMs + simSecondsToRealMs(ahead.ideal.simSeconds, TIME_SCALE.value),
      strike: ahead.strike,
      shotIndex: 0,
    };
    resolver.startToss({ idealAtMs: toss.idealAtMs, strike: ahead.strike.position });
    incomings.emit(toss);
  }

  /** The player struck their Serve off the toss (the resolver's contact): the Rally starts, and the Opponent decides its Shot. */
  function playerServe(contact: Extract<ShotEvent, { type: 'contact' }>): void {
    toss = null;
    startServe('player');
    const incoming = launched('player', contact.ball, contact.atMs, true);
    if (incoming) opponentPlan = { incoming, choice: opponent.chooseShot(incoming, random) };
  }

  /** The player missed the toss (no Swing, or one outside the Hit Window): it drops, then the cue and toss start over. No Fault, no Point. */
  function tossMissed(): void {
    toss = null;
    serveClock = { phase: 'serving', seconds: 0 };
  }

  /**
   * The Match's Serve clock, once per frame after physics: when the Rally is
   * over and its ball done, wait, count "3, 2, 1" and serve. Paused, it sends
   * no Serve and cancels a "3, 2, 1" in progress (resumed, it waits and
   * counts again). After a Game it waits GAME_BREAK_S longer, then starts the
   * next Game (`nextGame`) before the cue. After the Match, it never serves.
   */
  function updateServeClock(realSeconds: number, nowMs: number): void {
    if (!match || serveClock.phase === 'toss') return;
    if (serveClock.phase === 'serving') {
      if (rallyOn || !ballIsDone(ball)) return;
      serveClock = { phase: 'waiting', seconds: 0 };
    }
    if (paused || match.phase === 'match-over') return;
    serveClock.seconds += realSeconds;
    if (serveClock.phase === 'waiting') {
      const gameOver = match.phase === 'game-over';
      if (serveClock.seconds < FEED_PAUSE_S.value + (gameOver ? GAME_BREAK_S : 0)) return;
      if (gameOver) {
        match = nextGame(match, matchConfig);
        matchEvents.emit({ type: 'next-game', atMs: nowMs, match });
      }
      serveClock = { phase: 'countdown', seconds: 0 };
    }
    if (serveClock.seconds >= FEED_COUNTDOWN_FROM * FEED_COUNTDOWN_STEP_S.value) serve(nowMs);
  }

  /**
   * Pausing mid-Rally in a Match (the player's hand is lost): the Rally is
   * void, with no Point, and the same Serve is played again after the usual
   * wait and "3, 2, 1" once resumed. The ball is put back at rest and the
   * resolver's pending try dropped, so nothing more is judged from it.
   */
  function replayRally(): void {
    if (!match || !rallyOn) return;
    rallyOn = false;
    opponentPlan = null;
    match = cancelRally(match);
    ball = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS, z: 0.7 }, { x: 0, y: 0, z: 0 });
    resolver = newResolver();
  }

  function handleShot(event: ShotEvent, nowMs: number): void {
    if (event.type === 'contact') ball = event.ball;
    if (mode === 'drill') {
      const result = feedResult(event);
      if (result === 'returned') score.addReturn();
      else if (result === 'failed') score.breakStreak();
    } else if (toss) {
      if (event.type === 'contact') playerServe(event);
      else if (chancePassed(event)) tossMissed();
    } else if (rallyOn) {
      if (event.type === 'contact') {
        // The player's Return: the Opponent decides its Shot as it launches (ADR 0002).
        shotIndex++;
        const incoming = launched('player', event.ball, event.atMs);
        if (incoming) opponentPlan = { incoming, choice: opponent.chooseShot(incoming, random) };
      } else if (chancePassed(event)) {
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

  // Return Drill: each Feed is the ball in play and the player's next Shot to return.
  feeder.onFeed((feed) => {
    ball = feed.ball;
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
    get match() {
      return match;
    },
    get toss() {
      return toss;
    },
    get countdown() {
      if (mode === 'drill') return feeder.countdown;
      if (serveClock.phase !== 'countdown') return null;
      return FEED_COUNTDOWN_FROM - Math.floor(serveClock.seconds / FEED_COUNTDOWN_STEP_S.value);
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
        judge(event, nowMs);
      }

      // Judge the Return in flight, strike a due contact (replacing the ball),
      // or call a Miss; then the Opponent strikes a due Shot; then the Feeder
      // or the Serve clock looks at the ball.
      for (const event of resolver.update(nowMs, ball, ballEvents)) handleShot(event, nowMs);
      opponentStrike(nowMs);

      // The pause and "3, 2, 1" run on real time, capped like the simulation so
      // a background tab doesn't fire a Feed or Serve the moment it comes back.
      const realSeconds = Math.min(elapsedSeconds, MAX_FRAME_DT);
      if (mode === 'drill') feeder.update({ realSeconds, simSeconds: steps * PHYSICS_DT, nowMs }, ball);
      else updateServeClock(realSeconds, nowMs);
    },

    swing(swing, nowMs) {
      if (paused) return;
      for (const event of resolver.swing(swing, nowMs)) handleShot(event, nowMs);
    },

    setPaused(next) {
      if (next && !paused) replayRally();
      paused = next;
      feeder.setPaused(next);
      // Between Rallies, the wait and any "3, 2, 1" start over. A toss already
      // up plays out: Swings are ignored, so it is missed and starts over.
      if (next && (serveClock.phase === 'waiting' || serveClock.phase === 'countdown')) serveClock = { phase: 'waiting', seconds: 0 };
    },

    setBall(next) {
      ball = next;
    },

    onShot: shotEvents.subscribe,
    onBounce: bounces.subscribe,
    onRally: rallyEvents.subscribe,
    onMatch: matchEvents.subscribe,
    onIncoming: incomings.subscribe,
  };
}

/** The player's chance at the Shot (or toss) has passed with nothing struck: a Miss, a Late Swing, or an Early one that used the try. */
function chancePassed(event: ShotEvent): boolean {
  return event.type === 'miss' || event.type === 'late' || (event.type === 'early' && event.final);
}

/** Below this speed (m/s), on the table, a live ball has come to rest. */
const AT_REST_SPEED = 0.05;
/** How close (m) the ball's bottom must be to the table top to count as resting on it. */
const AT_REST_HEIGHT = 0.001;

/** The ball in play can do nothing more: dead or out, or come to rest on the table (as the Feeder judges it). */
function ballIsDone(ball: BallState): boolean {
  if (ball.status !== 'live') return true;
  const { x, y, z } = ball.velocity;
  const onTable = ball.position.y <= TABLE_TOP_Y + BALL_RADIUS + AT_REST_HEIGHT;
  return onTable && Math.hypot(x, y, z) < AT_REST_SPEED;
}

const WHO: Record<Side, string> = { player: 'you', opponent: 'Opponent' };
const END_TEXT: Record<RallyEnd, string> = { net: 'net', out: 'out', 'own-half': 'own half', unreturned: 'unreturned', fault: 'Fault' };

/**
 * One line describing a Match event, for the console until the Match HUD
 * (P2-h1): e.g. "Point to you (Opponent: net). You 3 – 5 Opponent, Opponent
 * to serve (2 left)".
 */
export function describeMatchEvent(e: MatchEvent): string {
  const s = e.match;
  const score = `You ${s.points.player} – ${s.points.opponent} Opponent`;
  const games = s.games.player + s.games.opponent > 0 ? ` (Games ${s.games.player} – ${s.games.opponent})` : '';
  const serving = `${WHO[s.server]} to serve (${s.servesLeft} left)`;
  if (e.type === 'let') return `Let: serve again. ${score}${games}`;
  if (e.type === 'next-game') return `Next Game. ${score}${games}, ${serving}`;
  const why = `${WHO[otherSide(e.to)]}: ${END_TEXT[e.end]}`;
  const head = `Point to ${WHO[e.to]} (${why}). ${score}${games}`;
  if (s.phase === 'match-over') return `${head}. Match to ${WHO[s.winner ?? e.to]}`;
  if (s.phase === 'game-over') return `${head}. Game to ${WHO[e.to]}`;
  return `${head}, ${serving}`;
}
