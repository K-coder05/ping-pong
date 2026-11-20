import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { makeRng } from '../util/rng.ts';
import { launchBall, type BallEvent } from './ball.ts';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import {
  BALL_RADIUS,
  FEED_COUNTDOWN_STEP_S,
  FEED_PAUSE_S,
  OPPONENT_END_Z,
  PLAYER_END_Z,
  SWING_FAST,
  SWING_ON,
  TABLE_TOP_Y,
  TIMING_OFFSET_MS,
} from './constants.ts';
import { createGameCore, describeMatchEvent, GAME_BREAK_S, gameModeFromSearch, type GameCore, type MatchEvent } from './core.ts';
import type { Feed } from './feeder.ts';
import type { MatchConfig } from './match.ts';
import type { Incoming, Opponent, RallyEvent } from './rally.ts';
import { judgeServe, OPPONENT_SERVE_FROM, solveServe } from './serve.ts';
import { feedResult, knobResolverParams, type ShotEvent } from './shotResolver.ts';
import { otherSide, type Side } from './side.ts';
import type { Hand } from '../sensing/landmarks.ts';
import { solveShot, type ShotSolution } from './solver.ts';

const FRAME_S = 1 / 60;
const START_MS = 1000;

function newCore(seed: number): GameCore {
  return createGameCore({ random: makeRng(seed), resolverParams: knobResolverParams, hand: () => 'right' });
}

/**
 * A scripted player: for each Feed, one medium-speed, flat Forehand whose
 * Swing Onset is seen exactly at the Feed's Ideal Time (Timing Offset applied).
 * Returns the Swing due by `nowMs`, if any, once.
 */
function scriptedPlayer(core: GameCore): (nowMs: number) => SwingEvent | null {
  let due: SwingEvent | null = null;
  core.feeder.onFeed((feed: Feed) => {
    if (feed.idealAtMs === null) return;
    due = { t: feed.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 };
  });
  return (nowMs) => {
    if (!due || nowMs < due.t) return null;
    const swing = due;
    due = null;
    return swing;
  };
}

interface DrillRun {
  feeds: number;
  shots: ShotEvent[];
  bounces: Extract<BallEvent, { type: 'bounce' }>[];
  core: GameCore;
}

/**
 * Return Drill at 60 fps for `seconds` of real time with the scripted player,
 * then on until the last Feed's rally is over (no Feed is cut off mid-flight).
 */
function runDrill(seed: number, seconds: number): DrillRun {
  const core = newCore(seed);
  const nextSwing = scriptedPlayer(core);
  const shots: ShotEvent[] = [];
  const bounces: Extract<BallEvent, { type: 'bounce' }>[] = [];
  let feeds = 0;
  core.feeder.onFeed(() => feeds++);
  core.onShot((event) => shots.push(event));
  core.onBounce((event) => bounces.push(event));

  const frames = Math.round(seconds / FRAME_S);
  const maxFrames = frames + Math.round(10 / FRAME_S);
  for (let i = 1; i <= maxFrames; i++) {
    const nowMs = START_MS + i * FRAME_S * 1000;
    const swing = nextSwing(nowMs);
    if (swing) core.swing(swing, nowMs);
    core.frame({ nowMs, elapsedSeconds: FRAME_S });
    if (i >= frames && core.feeder.phase !== 'feeding') break;
  }
  return { feeds, shots, bounces, core };
}

describe('GameCore: Return Drill, headless', () => {
  it('a scripted player who swings at each Ideal Time returns every Feed', () => {
    const { feeds, shots, core } = runDrill(1234, 60);

    expect(feeds).toBeGreaterThan(5);
    const results = shots.map(feedResult).filter((r) => r !== null);
    expect(results).toEqual(Array(feeds).fill('returned'));
    expect(core.streak.streak).toBe(feeds);
    expect(core.streak.best).toBe(feeds);
  });

  it('replays identically from the same seed and the same scripted Swings', () => {
    const first = runDrill(42, 30);
    const second = runDrill(42, 30);
    expect(first.shots.length).toBeGreaterThan(0);
    expect(second.shots).toEqual(first.shots);
    expect(second.bounces).toEqual(first.bounces);
  });

  it('plays a different session from a different seed', () => {
    const contacts = (run: DrillRun) => run.shots.filter((e) => e.type === 'contact').map((e) => e.position);
    expect(contacts(runDrill(7, 20))).not.toEqual(contacts(runDrill(8, 20)));
  });
});

describe('GameCore: pause, Swings and the ball', () => {
  it('sends no Feed while paused, and Feeds once resumed', () => {
    const core = newCore(1);
    let feeds = 0;
    core.feeder.onFeed(() => feeds++);
    core.setPaused(true);
    let nowMs = START_MS;
    for (let i = 0; i < 600; i++) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(feeds).toBe(0);
    core.setPaused(false);
    for (let i = 0; i < 600 && feeds === 0; i++) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(feeds).toBe(1);
  });

  it('ignores Swings while paused', () => {
    const core = newCore(1);
    let feed: Feed | null = null;
    core.feeder.onFeed((f) => (feed = f));
    let nowMs = START_MS;
    while (!feed) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    const shots: ShotEvent[] = [];
    core.onShot((e) => shots.push(e));

    // A Feed in flight plays out while paused, but a Swing at its Ideal Time is ignored: a Miss.
    core.setPaused(true);
    const idealAtMs = (feed as Feed).idealAtMs!;
    core.swing({ t: idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: SWING_FAST.value, side: 'forehand', vertPath: 0 }, idealAtMs);
    expect(shots).toEqual([]);
    while (shots.length === 0) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(shots).toEqual([{ type: 'miss' }]);
  });

  it('judges a Swing when not paused: accepted, then contact launches the Return as the ball in play', () => {
    const core = newCore(3);
    let feed: Feed | null = null;
    core.feeder.onFeed((f) => (feed = f));
    let nowMs = START_MS;
    while (!feed) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(core.ball).toBe((feed as Feed).ball);

    const shots: ShotEvent[] = [];
    core.onShot((e) => shots.push(e));
    const idealAtMs = (feed as Feed).idealAtMs!;
    core.swing({ t: idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: SWING_FAST.value, side: 'forehand', vertPath: 0 }, nowMs);
    expect(shots.map((e) => e.type)).toEqual(['accepted']);
    while (shots.length === 1) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    const contact = shots[1]!;
    expect(contact.type).toBe('contact');
    if (contact.type === 'contact') expect(core.ball).toBe(contact.ball);
  });

  it('setBall replaces the ball in play, and its bounces reach onBounce', () => {
    const core = newCore(1);
    core.setPaused(true);
    const dropped = launchBall({ x: 0, y: TABLE_TOP_Y + BALL_RADIUS + 0.3, z: 0.7 }, { x: 0, y: 0, z: 0 });
    core.setBall(dropped);
    expect(core.ball).toBe(dropped);
    const bounces: Extract<BallEvent, { type: 'bounce' }>[] = [];
    const unsubscribe = core.onBounce((e) => bounces.push(e));
    let nowMs = START_MS;
    for (let i = 0; i < 60; i++) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(bounces.length).toBeGreaterThan(0);
    expect(bounces[0]!.half).toBe('player');
    unsubscribe();
    const seen = bounces.length;
    core.setBall(dropped);
    for (let i = 0; i < 60; i++) core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    expect(bounces.length).toBe(seen);
  });
});

// ---------------------------------------------------------------------------
// Match (spec P2-b): Rallies against the Opponent
// ---------------------------------------------------------------------------

/**
 * A Match core. The Match's first server is its first draw from `random`
 * (`random() < 0.5` is the player): `firstServer` fixes it by standing in for
 * that one draw, or `drawn` leaves it to the seed. The Opponent serves first
 * unless told otherwise.
 */
function newMatchCore(
  seed: number,
  opponent?: Opponent,
  extra: { match?: MatchConfig; solveServe?: typeof solveServe; firstServer?: Side | 'drawn'; hand?: Hand } = {},
): GameCore {
  const { firstServer = 'opponent', hand = 'right', ...rest } = extra;
  const rng = makeRng(seed);
  let drawn = firstServer === 'drawn';
  const random = () => {
    if (drawn) return rng();
    drawn = true;
    return firstServer === 'player' ? 0.25 : 0.75;
  };
  return createGameCore({ random, resolverParams: knobResolverParams, hand: () => hand, mode: 'match', opponent, ...rest });
}

/**
 * A scripted player for a Match: for each Shot coming to the player (a Feed
 * or the Opponent's), one medium-speed, flat Forehand seen exactly at its
 * Ideal Time, while `willSwing` says so. Returns the Swing due by `nowMs`, once.
 */
function scriptedMatchPlayer(core: GameCore, willSwing: (incoming: Incoming) => boolean = () => true): (nowMs: number) => SwingEvent | null {
  let due: SwingEvent | null = null;
  core.onIncoming((incoming) => {
    if (incoming.receiver !== 'player' || !willSwing(incoming)) return;
    due = { t: incoming.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 };
  });
  return (nowMs) => {
    if (!due || nowMs < due.t) return null;
    const swing = due;
    due = null;
    return swing;
  };
}

interface MatchRun {
  rally: RallyEvent[];
  match: MatchEvent[];
  shots: ShotEvent[];
  core: GameCore;
}

/** A Match at 60 fps with the scripted player, until `done` says so or `maxSeconds` of real time pass. */
function runMatch(core: GameCore, nextSwing: (nowMs: number) => SwingEvent | null, done: (run: MatchRun) => boolean, maxSeconds: number): MatchRun {
  const run: MatchRun = { rally: [], match: [], shots: [], core };
  core.onRally((e) => run.rally.push(e));
  core.onMatch((e) => run.match.push(e));
  core.onShot((e) => run.shots.push(e));
  const maxFrames = Math.round(maxSeconds / FRAME_S);
  for (let i = 1; i <= maxFrames && !done(run); i++) {
    const nowMs = START_MS + i * FRAME_S * 1000;
    const swing = nextSwing(nowMs);
    if (swing) core.swing(swing, nowMs);
    core.frame({ nowMs, elapsedSeconds: FRAME_S });
  }
  return run;
}

const ends = (run: MatchRun) => run.rally.filter((e) => e.type === 'end');
const rallyShots = (run: MatchRun) => run.rally.filter((e) => e.type === 'shot');
/** The Rally log without bounces, as short strings: `by:shotIndex` or `end:loser`. */
const outline = (run: MatchRun) =>
  run.rally.flatMap((e) => (e.type === 'shot' ? [`${e.by}:${e.shotIndex}`] : e.type === 'end' ? [`${e.end}:${e.loser}`] : []));

describe('gameModeFromSearch', () => {
  it('is a Match only with ?mode=match; Return Drill otherwise', () => {
    expect(gameModeFromSearch('?mode=match')).toBe('match');
    expect(gameModeFromSearch('?seed=4&mode=match&input=mouse')).toBe('match');
    expect(gameModeFromSearch('')).toBe('drill');
    expect(gameModeFromSearch('?mode=drill')).toBe('drill');
    expect(gameModeFromSearch('?mode=other')).toBe('drill');
  });
});

describe('GameCore: Match against the scripted Opponent, headless', () => {
  it('a scripted player and the scripted Opponent rally 100 Shots without the Rally ending', () => {
    const core = newMatchCore(1234);
    expect(core.mode).toBe('match');
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => rallyShots(r).length > 100 || ends(r).length > 0, 400);
    expect(ends(run)).toEqual([]);
    const shots = rallyShots(run);
    expect(shots.length).toBeGreaterThan(100);
    // One Rally: the Opponent's Serve is Shot 0, then the sides alternate.
    shots.forEach((e, i) => expect(e).toMatchObject({ shotIndex: i, by: i % 2 === 0 ? 'opponent' : 'player' }));
    // The Serve bounces on the Opponent's half, then the player's, and is legal;
    // after it, every bounce is on the half the latest Shot was aimed at.
    const serveBounces = run.rally.slice(0, 4);
    expect(serveBounces.map((e) => e.type)).toEqual(['shot', 'bounce', 'bounce', 'serve']);
    expect(serveBounces.slice(1).map((e) => (e.type === 'bounce' ? e.half : e.type === 'serve' ? e.result : null))).toEqual(['opponent', 'player', 'legal']);
    let receiver = 'player';
    for (const e of run.rally.slice(4)) {
      if (e.type === 'shot') receiver = e.by === 'player' ? 'opponent' : 'player';
      if (e.type === 'bounce') expect(e.half).toBe(receiver);
    }
    expect(run.match).toEqual([]);
    expect(core.streak).toEqual({ streak: 0, best: 0 });
  });

  it('replays an identical Rally event log from the same seed and the same scripted Swings', () => {
    // The player stops swinging after a few Shots, so Rallies end and new ones start.
    const play = (seed: number) => {
      const core = newMatchCore(seed);
      return runMatch(core, scriptedMatchPlayer(core, (i) => i.shotIndex < 6), (r) => ends(r).length >= 3, 120).rally;
    };
    const first = play(42);
    expect(first.filter((e) => e.type === 'end')).toHaveLength(3);
    expect(play(42)).toEqual(first);
  });

  it('calls an unreturned Shot against the player, then starts the next Rally from a Serve', () => {
    const core = newMatchCore(5);
    const run = runMatch(core, scriptedMatchPlayer(core, (i) => i.shotIndex === 0), (r) => rallyShots(r).length >= 4, 60);
    // Serve, player Return, Opponent Shot (unreturned); then the next Rally's Serve.
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'opponent:2', 'unreturned:player', 'opponent:0']);
    expect(run.shots.map((e) => e.type)).toContain('miss');
  });

  it('calls an Opponent Whiff unreturned against the Opponent', () => {
    const whiffs: Opponent = { ...createScriptedOpponent(), chooseShot: () => 'whiff' };
    const core = newMatchCore(6, whiffs);
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => ends(r).length >= 1, 60);
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'unreturned:opponent']);
  });

  it('calls an Opponent Shot past the end line Out, against the Opponent', () => {
    const long: Opponent = { ...createScriptedOpponent(), chooseShot: () => ({ target: { x: 0, z: PLAYER_END_Z + 0.3 }, flightTime: 0.9, topspin: 0, sidespin: 0 }) };
    const core = newMatchCore(7, long);
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => ends(r).length >= 1, 60);
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'opponent:2', 'out:opponent']);
  });

  it('asks the Opponent at launch, and strikes on the first frame at its Ideal Time', () => {
    const seen: Incoming[] = [];
    const recording: Opponent = {
      ...createScriptedOpponent(),
      chooseShot: (incoming, random) => {
        seen.push(incoming);
        return createScriptedOpponent().chooseShot(incoming, random);
      },
    };
    const core = newMatchCore(8, recording);
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => rallyShots(r).length >= 3, 60);
    const contact = run.shots.find((e) => e.type === 'contact');
    expect(seen).toHaveLength(1);
    const incoming = seen[0]!;
    expect(incoming).toMatchObject({ receiver: 'opponent', shotIndex: 1, launchedAtMs: contact?.type === 'contact' ? contact.atMs : NaN });
    expect(incoming.ideal.position.z).toBeCloseTo(OPPONENT_END_Z, 6);
    expect(incoming.strike.position).toEqual(incoming.ideal.position);
    const strike = rallyShots(run)[2]!;
    expect(strike.atMs).toBeGreaterThanOrEqual(incoming.idealAtMs);
    expect(strike.atMs - incoming.idealAtMs).toBeLessThan(1000 * FRAME_S);
  });

  it('never asks the Opponent, nor reports Rally or Match events, in Return Drill', () => {
    const asked: Incoming[] = [];
    let served = 0;
    const core = createGameCore({
      random: makeRng(9),
      resolverParams: knobResolverParams,
      hand: () => 'right',
      opponent: { chooseShot: (i) => (asked.push(i), 'whiff'), chooseServe: () => (served++, createScriptedOpponent().chooseServe(() => 0)) },
    });
    expect(core.mode).toBe('drill');
    const run = runMatch(core, scriptedMatchPlayer(core), () => false, 20);
    expect(core.streak.streak).toBeGreaterThanOrEqual(3);
    expect(asked).toEqual([]);
    expect(served).toBe(0);
    expect(run.rally).toEqual([]);
    expect(run.match).toEqual([]);
    expect(core.match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A scored Match (spec P2-f1): Opponent Serves, Points, Lets and Faults
// ---------------------------------------------------------------------------

/** Real ms from the end of a Rally's ball to its next Serve: the pause, then "3, 2, 1". */
const SERVE_WAIT_MS = 1000 * (FEED_PAUSE_S.value + 3 * FEED_COUNTDOWN_STEP_S.value);

/** The scripted Opponent, counting its Serves. */
function countingOpponent(): Opponent & { serves: number } {
  const scripted = createScriptedOpponent();
  const opponent = {
    serves: 0,
    chooseShot: scripted.chooseShot,
    chooseServe: (random: () => number) => (opponent.serves++, scripted.chooseServe(random)),
  };
  return opponent;
}

/**
 * A Serve launch from OPPONENT_SERVE_FROM that clips the net and lands on the
 * player's half (a Let) whatever its Net-cord seed, found by scanning first
 * segments with solveShot.
 */
function letLaunch(): ShotSolution {
  for (let z = -0.6; z <= -0.1; z += 0.05) {
    for (let flightTime = 0.08; flightTime <= 0.6; flightTime += 0.01) {
      const solution = solveShot(OPPONENT_SERVE_FROM, { target: { x: 0, z }, flightTime, topspin: 0, sidespin: 0 });
      if (!solution) continue;
      const seeds = Array.from({ length: 12 }, (_, i) => i * 7919 + 1);
      if (seeds.every((seed) => judgeServe(launchBall(OPPONENT_SERVE_FROM, solution.velocity, solution.spin, seed), 'opponent') === 'let')) return solution;
    }
  }
  throw new Error('no Let found');
}

const points = (run: MatchRun) => run.match.filter((e) => e.type === 'point');
const serves = (run: MatchRun) => run.rally.filter((e) => e.type === 'serve');

describe('GameCore: a scored Match', () => {
  it('holds a MatchState in a Match, its first server drawn from random; none in Return Drill', () => {
    const first = (seed: number) => newMatchCore(seed, undefined, { firstServer: 'drawn' }).match!;
    expect(first(1)).toMatchObject({ points: { player: 0, opponent: 0 }, games: { player: 0, opponent: 0 }, servesLeft: 2, phase: 'pre-serve' });
    const servers = new Set(Array.from({ length: 20 }, (_, i) => first(i).server));
    expect(servers).toEqual(new Set(['player', 'opponent']));
    for (let seed = 0; seed < 5; seed++) expect(first(seed)).toEqual(first(seed));
    expect(newCore(1).match).toBeNull();
  });

  it('starts each Rally with an Opponent Serve after the pause and "3, 2, 1", which it calls legal', () => {
    const opponent = countingOpponent();
    const core = newMatchCore(11, opponent);
    const countdowns: number[] = [];
    let servedAtMs: number | null = null;
    core.onRally((e) => {
      if (e.type === 'shot' && e.shotIndex === 0 && servedAtMs === null) servedAtMs = e.atMs;
    });
    const run = runMatch(core, () => {
      const c = core.countdown;
      if (c !== null && countdowns.at(-1) !== c) countdowns.push(c);
      return null;
    }, (r) => serves(r).length >= 1, 20);
    expect(countdowns).toEqual([3, 2, 1]);
    expect(servedAtMs! - START_MS).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    // Within a frame or two: the cue starts on the frame after the pause ends, as the Feeder's does.
    expect(servedAtMs! - START_MS).toBeLessThan(SERVE_WAIT_MS + 2000 * FRAME_S + 1);
    expect(opponent.serves).toBe(1);
    expect(run.rally.slice(0, 4).map((e) => (e.type === 'shot' ? `${e.by}:${e.shotIndex}` : e.type === 'bounce' ? e.half : e.type === 'serve' ? e.result : e.type))).toEqual(['opponent:0', 'opponent', 'player', 'legal']);
    expect(core.match!.phase).toBe('rally');
    expect(core.feeder.phase).toBe('waiting');
  });

  it('awards each Rally End\'s Point to the other side, and keeps the score', () => {
    // The Opponent Whiffs every other Shot; the player returns each Serve only: the Rallies end both ways.
    const opponent = countingOpponent();
    let shots = 0;
    opponent.chooseShot = (incoming, random) => (shots++ % 2 === 0 ? 'whiff' : createScriptedOpponent().chooseShot(incoming, random));
    const core = newMatchCore(12, opponent);
    // Listeners of a Rally End already see its Point in the score.
    const scoredAtEnd: number[] = [];
    core.onRally((e) => e.type === 'end' && scoredAtEnd.push(core.match!.points.player + core.match!.points.opponent));
    const run = runMatch(core, scriptedMatchPlayer(core, (i) => i.shotIndex === 0), (r) => points(r).length >= 6, 200);
    expect(scoredAtEnd).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(points(run).map((p) => p.to))).toEqual(new Set(['player', 'opponent']));
    const ends = run.rally.filter((e) => e.type === 'end');
    expect(points(run)).toHaveLength(6);
    expect(ends).toHaveLength(6);
    points(run).forEach((point, i) => {
      const end = ends[i]!;
      expect(point).toMatchObject({ to: otherSide(end.loser), end: end.end, atMs: end.atMs });
    });
    const last = points(run).at(-1)!.match;
    expect(core.match).toEqual(last);
    expect(last.points.player + last.points.opponent).toBe(6);
    expect(last.points.player).toBe(points(run).filter((p) => p.to === 'player').length);
    // The Serve passes every 2 Points: the Opponent served Points 1, 2, 5 and 6, the player (off the toss) 3 and 4.
    expect(opponent.serves).toBe(4);
    expect(serves(run).map((e) => e.type === 'serve' && e.by)).toEqual(['opponent', 'opponent', 'player', 'player', 'opponent', 'opponent']);
    expect(serves(run).every((e) => e.type === 'serve' && e.result === 'legal')).toBe(true);
    expect(describeMatchEvent(points(run)[0]!)).toMatch(/^Point to (you|Opponent) \(.*\)\. You \d+ – \d+ Opponent, (you|Opponent) to serve \(\d left\)/);
  });

  it('calls a Serve that breaks the rule a Fault: the receiver wins the Point', () => {
    // Its first bounce aimed at the player's half: no Serve meets it, so it is served best effort and Faults.
    const faulty: Opponent = { ...createScriptedOpponent(), chooseServe: () => ({ bounce1: { x: 0, z: 0.5 }, target: { x: 0, z: 1 }, flightTime: 0.5, topspin: 0, sidespin: 0 }) };
    const core = newMatchCore(13, faulty);
    const run = runMatch(core, () => null, (r) => points(r).length >= 1, 20);
    expect(run.rally.filter((e) => e.type !== 'bounce').map((e) => e.type)).toEqual(['shot', 'serve', 'end']);
    expect(serves(run)[0]).toMatchObject({ by: 'opponent', result: 'fault' });
    expect(points(run)[0]).toMatchObject({ to: 'player', end: 'fault' });
    expect(core.match!.points).toEqual({ player: 1, opponent: 0 });
  });

  it('serves a Let again, with no Point', () => {
    const launch = letLaunch();
    const opponent = countingOpponent();
    const core = newMatchCore(14, opponent, { solveServe: (() => launch) as unknown as typeof solveServe });
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => r.match.length >= 2 && opponent.serves >= 3, 40);
    expect(run.match.slice(0, 2).map((e) => e.type)).toEqual(['let', 'let']);
    expect(serves(run).slice(0, 2).map((e) => e.type === 'serve' && e.result)).toEqual(['let', 'let']);
    expect(run.rally.filter((e) => e.type === 'end')).toEqual([]);
    expect(run.match[0]!.match).toMatchObject({ points: { player: 0, opponent: 0 }, phase: 'pre-serve' });
    expect(run.match[0]!.match.server).toBe(core.match!.server);
    expect(describeMatchEvent(run.match[0]!)).toMatch(/^Let: serve again\./);
  });

  it('sends no Serve while paused, and starts the wait and "3, 2, 1" over once resumed', () => {
    const opponent = countingOpponent();
    const core = newMatchCore(15, opponent);
    let nowMs = START_MS;
    const step = () => core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    while (core.countdown !== 2) step();
    core.setPaused(true);
    expect(core.countdown).toBeNull();
    for (let i = 0; i < 600; i++) step();
    expect(opponent.serves).toBe(0);
    expect(core.countdown).toBeNull();
    core.setPaused(false);
    const resumedAt = nowMs;
    while (opponent.serves === 0) step();
    expect(nowMs - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
  });

  it('losing the hand mid-Rally voids it: no Point, and the same Serve is played again after "3, 2, 1"', () => {
    const opponent = countingOpponent();
    const core = newMatchCore(17, opponent);
    const run: { rally: RallyEvent[]; match: MatchEvent[]; shots: ShotEvent[] } = { rally: [], match: [], shots: [] };
    core.onRally((e) => run.rally.push(e));
    core.onMatch((e) => run.match.push(e));
    core.onShot((e) => run.shots.push(e));
    let nowMs = START_MS;
    const step = () => core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    while (opponent.serves === 0) step();
    for (let i = 0; i < 10; i++) step(); // the Serve is in flight
    expect(core.match!.phase).toBe('rally');
    const before = core.match!;

    core.setPaused(true);
    expect(core.match).toMatchObject({ phase: 'pre-serve', points: before.points, server: before.server, servesLeft: before.servesLeft });
    for (let i = 0; i < 1200; i++) step(); // the ball would have been long dead
    expect(run.match).toEqual([]);
    expect(run.rally.filter((e) => e.type === 'end')).toEqual([]);
    expect(run.shots).toEqual([]); // no Miss either
    expect(opponent.serves).toBe(1);

    core.setPaused(false);
    const resumedAt = nowMs;
    while (opponent.serves === 1) step();
    expect(nowMs - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(core.match).toMatchObject({ phase: 'rally', points: before.points, server: before.server, servesLeft: before.servesLeft });
    expect(run.match).toEqual([]);
  });

  it('losing the hand between Rallies just pauses: no Point, nothing replayed', () => {
    const core = newMatchCore(18);
    const run = runMatch(core, () => null, (r) => points(r).length >= 1, 60);
    core.setPaused(true);
    const after = core.match;
    for (let i = 0; i < 600; i++) core.frame({ nowMs: START_MS + 100000 + i * 16, elapsedSeconds: FRAME_S });
    expect(core.match).toEqual(after);
    expect(points(run)).toHaveLength(1);
  });

  it('after a Game, waits GAME_BREAK_S more and starts the next; after the Match, never serves again', () => {
    const core = newMatchCore(16, undefined, { match: { pointsToWin: 2, winBy: 1, bestOf: 3 } });
    const firstServer = core.match!.server;
    // The player serves off its tosses but never returns: the Opponent wins every Point, 2–0, 2–0.
    const run = runMatch(core, scriptedMatchPlayer(core, (i) => i === core.toss), () => false, 120);
    const kinds = run.match.map((e) => e.type);
    expect(kinds).toEqual(['point', 'point', 'next-game', 'point', 'point']);
    const [, gamePoint, next] = run.match;
    expect(gamePoint!.match).toMatchObject({ phase: 'game-over', games: { player: 0, opponent: 1 } });
    expect(next!.match).toMatchObject({ phase: 'pre-serve', points: { player: 0, opponent: 0 }, games: { player: 0, opponent: 1 } });
    expect(next!.match).toMatchObject({ gameFirstServer: otherSide(firstServer), server: otherSide(firstServer) });
    expect(next!.atMs - gamePoint!.atMs).toBeGreaterThanOrEqual(1000 * (FEED_PAUSE_S.value + GAME_BREAK_S));
    expect(core.match).toMatchObject({ phase: 'match-over', winner: 'opponent', games: { player: 0, opponent: 2 } });
    expect(describeMatchEvent(run.match.at(-1)!)).toMatch(/Match to Opponent$/);
    // Long after the Match: still four Serves.
    expect(serves(run)).toHaveLength(4);
    expect(core.countdown).toBeNull();
  });

  it('replays an identical Rally and Match event log from the same seed and the same scripted Swings', () => {
    const play = (seed: number) => {
      const core = newMatchCore(seed, undefined, { match: { pointsToWin: 3, winBy: 2, bestOf: 1 } });
      const run = runMatch(core, scriptedMatchPlayer(core, (i) => i.shotIndex < 4), (r) => r.core.match!.phase === 'match-over', 200);
      return { rally: run.rally, match: run.match };
    };
    const first = play(21);
    expect(first.match.at(-1)!.match.phase).toBe('match-over');
    expect(play(21)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// The player's Serve (spec P2-f2): an automatic toss, then the Serve rotation
// ---------------------------------------------------------------------------

describe("GameCore: the player's Serve", () => {
  it('tosses after the pause and "3, 2, 1"; a Swing at its Ideal Time serves, legal, and the Rally starts', () => {
    const opponent = countingOpponent();
    const core = newMatchCore(31, opponent, { firstServer: 'player' });
    const countdowns: number[] = [];
    const tosses: Incoming[] = [];
    core.onIncoming((i) => {
      if (i === core.toss) {
        tosses.push(i);
        // Up as the ball in play, before the Rally starts.
        expect(core.ball).toBe(i.ball);
        expect(core.match!.phase).toBe('pre-serve');
        expect(core.countdown).toBeNull();
      }
    });
    const nextSwing = scriptedMatchPlayer(core, (i) => i === core.toss);
    const run = runMatch(
      core,
      (nowMs) => {
        const c = core.countdown;
        if (c !== null && countdowns.at(-1) !== c) countdowns.push(c);
        return nextSwing(nowMs);
      },
      (r) => serves(r).length >= 1,
      20,
    );
    expect(countdowns).toEqual([3, 2, 1]);
    expect(tosses).toHaveLength(1);
    const toss = tosses[0]!;
    expect(toss).toMatchObject({ receiver: 'player', shotIndex: 0 });
    expect(toss.launchedAtMs - START_MS).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(toss.ball.position).toEqual({ x: 0.3, y: TABLE_TOP_Y + 0.1, z: PLAYER_END_Z + 0.1 });
    expect(toss.ideal.position.y).toBeCloseTo(TABLE_TOP_Y + 0.25, 6);
    expect(core.toss).toBeNull();
    // Struck on the first frame at the toss's Ideal Time, from its strike point.
    const contact = run.shots.find((e) => e.type === 'contact');
    if (contact?.type !== 'contact') throw new Error('expected a contact');
    expect(contact.position).toEqual(toss.ideal.position);
    expect(contact.atMs - toss.idealAtMs).toBeGreaterThanOrEqual(0);
    expect(contact.atMs - toss.idealAtMs).toBeLessThan(1000 * FRAME_S);
    expect(run.rally.slice(0, 4).map((e) => (e.type === 'shot' ? `${e.by}:${e.shotIndex}` : e.type === 'bounce' ? e.half : e.type === 'serve' ? `${e.by}:${e.result}` : e.type))).toEqual([
      'player:0',
      'player',
      'opponent',
      'player:legal',
    ]);
    expect(core.match!.phase).toBe('rally');
    expect(core.opponentPlan?.incoming).toMatchObject({ receiver: 'opponent', shotIndex: 0 });
    expect(opponent.serves).toBe(0);
  });

  it('tosses on the hitting-hand side: x < 0 for a left-hander', () => {
    const core = newMatchCore(32, undefined, { firstServer: 'player', hand: 'left' });
    runMatch(core, () => null, () => core.toss !== null, 20);
    expect(core.toss!.ball.position.x).toBeCloseTo(-0.3, 9);
  });

  it.each([
    ['no Swing', null],
    ['an Early Swing', -1],
    ['a Late Swing', 1],
  ] as const)('a toss missed with %s drops, and is tossed again after the pause and "3, 2, 1": no Fault, no Point', (_name, side) => {
    const core = newMatchCore(33, undefined, { firstServer: 'player' });
    const tosses: Incoming[] = [];
    core.onIncoming((i) => i === core.toss && tosses.push(i));
    const pending: { swing: SwingEvent | null } = { swing: null };
    core.onIncoming((i) => {
      if (i !== core.toss || side === null || tosses.length > 1) return;
      const outside = side * (knobResolverParams().hitWindowMs + 50);
      pending.swing = { t: i.idealAtMs + TIMING_OFFSET_MS.value + outside, peakSpeed: SWING_FAST.value, side: 'forehand', vertPath: 0 };
    });
    const shots: { atMs: number; event: ShotEvent }[] = [];
    let nowMs = START_MS;
    core.onShot((event) => shots.push({ atMs: nowMs, event }));
    const rally: RallyEvent[] = [];
    const match: MatchEvent[] = [];
    core.onRally((e) => rally.push(e));
    core.onMatch((e) => match.push(e));
    for (let i = 0; i < 20 / FRAME_S && tosses.length < 2; i++) {
      nowMs += 1000 * FRAME_S;
      if (pending.swing && nowMs >= pending.swing.t) {
        core.swing(pending.swing, nowMs);
        pending.swing = null;
      }
      core.frame({ nowMs, elapsedSeconds: FRAME_S });
    }
    expect(shots.map((s) => s.event.type)).toEqual([side === null ? 'miss' : side < 0 ? 'early' : 'late']);
    expect(tosses).toHaveLength(2);
    expect(tosses[1]!.launchedAtMs - shots[0]!.atMs).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(rally).toEqual([]);
    expect(match).toEqual([]);
    expect(core.match).toMatchObject({ points: { player: 0, opponent: 0 }, phase: 'pre-serve', server: 'player', servesLeft: 2 });
  });

  it('lets a toss that is up when the game pauses play out as missed, and tosses again only once resumed', () => {
    const core = newMatchCore(34, undefined, { firstServer: 'player' });
    let tosses = 0;
    core.onIncoming((i) => i === core.toss && tosses++);
    let nowMs = START_MS;
    const step = () => core.frame({ nowMs: (nowMs += 1000 * FRAME_S), elapsedSeconds: FRAME_S });
    while (!core.toss) step();
    const toss = core.toss!;
    core.setPaused(true);
    expect(core.toss).toBe(toss);
    core.swing({ t: toss.idealAtMs + TIMING_OFFSET_MS.value, peakSpeed: SWING_FAST.value, side: 'forehand', vertPath: 0 }, toss.idealAtMs);
    for (let i = 0; i < 600; i++) step();
    expect(core.toss).toBeNull();
    expect(tosses).toBe(1);
    expect(core.match).toMatchObject({ points: { player: 0, opponent: 0 }, phase: 'pre-serve' });
    core.setPaused(false);
    const resumedAt = nowMs;
    while (tosses === 1) step();
    expect(nowMs - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
  });

  it('losing the hand mid-Rally on the player\'s own Serve voids it: no Point, and the player tosses again after "3, 2, 1"', () => {
    const core = newMatchCore(36, undefined, { firstServer: 'player' });
    const nextSwing = scriptedMatchPlayer(core, (i) => i === core.toss);
    let tosses = 0;
    core.onIncoming((i) => i === core.toss && tosses++);
    const match: MatchEvent[] = [];
    core.onMatch((e) => match.push(e));
    let nowMs = START_MS;
    const step = () => {
      nowMs += 1000 * FRAME_S;
      const swing = nextSwing(nowMs);
      if (swing) core.swing(swing, nowMs);
      core.frame({ nowMs, elapsedSeconds: FRAME_S });
    };
    while (core.match!.phase !== 'rally') step();
    for (let i = 0; i < 5; i++) step();
    expect(core.match!.phase).toBe('rally');

    core.setPaused(true);
    expect(core.match).toMatchObject({ phase: 'pre-serve', points: { player: 0, opponent: 0 }, server: 'player', servesLeft: 2 });
    for (let i = 0; i < 1200; i++) step();
    expect(match).toEqual([]);
    expect(tosses).toBe(1);

    core.setPaused(false);
    const resumedAt = nowMs;
    while (tosses === 1) step();
    expect(nowMs - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(core.match).toMatchObject({ points: { player: 0, opponent: 0 }, server: 'player', servesLeft: 2 });
  });

  it('serves in the Match\'s order for a whole Game through a deuce: every 2 Points, then every Point from 10–10', () => {
    // Who wins each Point: alternately to 10–10, 11–11 and 12–12, then the player twice: 14–12.
    const winners: Side[] = [...Array.from({ length: 24 }, (_, i): Side => (i % 2 === 0 ? 'player' : 'opponent')), 'player', 'player'];
    let core: GameCore | null = null;
    const pointWinner = () => winners[core!.match!.points.player + core!.match!.points.opponent]!;
    // The Opponent Whiffs the Points the player is to win; the player lets the others go by, but always serves off its toss.
    const scripted = createScriptedOpponent();
    const opponent: Opponent = { ...scripted, chooseShot: (i, random) => (pointWinner() === 'player' ? 'whiff' : scripted.chooseShot(i, random)) };
    core = newMatchCore(35, opponent, { firstServer: 'player' });
    const run = runMatch(core, scriptedMatchPlayer(core, (i) => i === core!.toss || pointWinner() === 'player'), (r) => r.core.match!.phase === 'match-over', 600);

    expect(core.match).toMatchObject({ phase: 'match-over', winner: 'player', points: { player: 14, opponent: 12 } });
    expect(points(run).map((p) => p.to)).toEqual(winners);
    expect(points(run).some((p) => p.end === 'fault')).toBe(false);
    // Before 10–10 the Serve passes every 2 Points; from 10–10, every Point. The player served first.
    const expected = winners.map((_, n): Side => ((n < 20 ? Math.floor(n / 2) : n) % 2 === 0 ? 'player' : 'opponent'));
    expect(serves(run).map((e) => e.type === 'serve' && e.by)).toEqual(expected);
    expect(serves(run).every((e) => e.type === 'serve' && e.result === 'legal')).toBe(true);
    // Each Rally's first Shot is the server's.
    expect(rallyShots(run).filter((e) => e.shotIndex === 0).map((e) => e.by)).toEqual(expected);
  });
});
