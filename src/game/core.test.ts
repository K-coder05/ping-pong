import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { makeRng } from '../util/rng.ts';
import { launchBall, type BallEvent } from './ball.ts';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import { BALL_RADIUS, OPPONENT_END_Z, PLAYER_END_Z, SWING_FAST, SWING_ON, TABLE_TOP_Y, TIMING_OFFSET_MS } from './constants.ts';
import { createGameCore, gameModeFromSearch, type GameCore } from './core.ts';
import type { Feed } from './feeder.ts';
import type { Incoming, Opponent, RallyEvent } from './rally.ts';
import { feedResult, knobResolverParams, type ShotEvent } from './shotResolver.ts';

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

function newMatchCore(seed: number, opponent?: Opponent): GameCore {
  return createGameCore({ random: makeRng(seed), resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent });
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
  shots: ShotEvent[];
  core: GameCore;
}

/** A Match at 60 fps with the scripted player, until `done` says so or `maxSeconds` of real time pass. */
function runMatch(core: GameCore, nextSwing: (nowMs: number) => SwingEvent | null, done: (run: MatchRun) => boolean, maxSeconds: number): MatchRun {
  const run: MatchRun = { rally: [], shots: [], core };
  core.onRally((e) => run.rally.push(e));
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
    // One Rally: the Feed is Shot 0, then the sides alternate.
    shots.forEach((e, i) => expect(e).toMatchObject({ shotIndex: i, by: i % 2 === 0 ? 'opponent' : 'player' }));
    // Every bounce is on the half the latest Shot was aimed at.
    let receiver = 'player';
    for (const e of run.rally) {
      if (e.type === 'shot') receiver = e.by === 'player' ? 'opponent' : 'player';
      if (e.type === 'bounce') expect(e.half).toBe(receiver);
    }
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

  it('calls an unreturned Shot against the player, then starts the next Rally from a Feed', () => {
    const core = newMatchCore(5);
    const run = runMatch(core, scriptedMatchPlayer(core, (i) => i.shotIndex === 0), (r) => rallyShots(r).length >= 4, 60);
    // Feed, player Return, Opponent Shot (unreturned); then the next Rally's Feed.
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'opponent:2', 'unreturned:player', 'opponent:0']);
    expect(run.shots.map((e) => e.type)).toContain('miss');
  });

  it('calls an Opponent Whiff unreturned against the Opponent', () => {
    const whiffs: Opponent = { chooseShot: () => 'whiff' };
    const core = newMatchCore(6, whiffs);
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => ends(r).length >= 1, 60);
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'unreturned:opponent']);
  });

  it('calls an Opponent Shot past the end line Out, against the Opponent', () => {
    const long: Opponent = { chooseShot: () => ({ target: { x: 0, z: PLAYER_END_Z + 0.3 }, flightTime: 0.9, topspin: 0, sidespin: 0 }) };
    const core = newMatchCore(7, long);
    const run = runMatch(core, scriptedMatchPlayer(core), (r) => ends(r).length >= 1, 60);
    expect(outline(run)).toEqual(['opponent:0', 'player:1', 'opponent:2', 'out:opponent']);
  });

  it('asks the Opponent at launch, and strikes on the first frame at its Ideal Time', () => {
    const seen: Incoming[] = [];
    const recording: Opponent = {
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

  it('never asks the Opponent, nor reports Rally events, in Return Drill', () => {
    const asked: Incoming[] = [];
    const core = createGameCore({
      random: makeRng(9),
      resolverParams: knobResolverParams,
      hand: () => 'right',
      opponent: { chooseShot: (i) => (asked.push(i), 'whiff') },
    });
    expect(core.mode).toBe('drill');
    const run = runMatch(core, scriptedMatchPlayer(core), () => false, 20);
    expect(core.streak.streak).toBeGreaterThanOrEqual(3);
    expect(asked).toEqual([]);
    expect(run.rally).toEqual([]);
  });
});
