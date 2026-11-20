import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { makeRng } from '../util/rng.ts';
import { launchBall, type BallEvent } from './ball.ts';
import { BALL_RADIUS, SWING_FAST, SWING_ON, TABLE_TOP_Y, TIMING_OFFSET_MS } from './constants.ts';
import { createGameCore, type GameCore } from './core.ts';
import type { Feed } from './feeder.ts';
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
