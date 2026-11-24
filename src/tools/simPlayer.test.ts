import { describe, expect, it } from 'vitest';
import type { SwingEvent } from '../input/types.ts';
import { SWING_FAST, SWING_ON, TIMING_OFFSET_MS } from '../game/constants.ts';
import { createGameCore } from '../game/core.ts';
import type { Incoming, RallyEvent } from '../game/rally.ts';
import { knobResolverParams, type ShotEvent } from '../game/shotResolver.ts';
import { createBrain } from '../opponent/brain.ts';
import { DIFFICULTIES } from '../opponent/difficulty.ts';
import { makeRng } from '../util/rng.ts';
import { faceAngleForShare, faceAngleShare, knobFaceAngleParams } from '../game/faceAngle.ts';
import { revsToRadPerSec, spinVector } from '../physics/spin.ts';
import type { PlayerModel } from './fitPlayer.ts';
import { createSimPlayer, topspinOf } from './simPlayer.ts';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** A player who swings exactly at every Ideal Time and is always seen: medium speed, flat. */
const PERFECT: PlayerModel = {
  name: 'perfect',
  timingMeanMs: 0,
  timingSdMs: 0,
  detectRate: 1,
  speedMean: (SWING_ON.value + SWING_FAST.value) / 2,
  speedSd: 0,
  vertPathMean: 0,
  vertPathSd: 0,
};

/** A stand-in for the core's Incoming stream: `send` emits one Incoming to its listeners. */
function fakeCore() {
  const listeners: ((incoming: Incoming) => void)[] = [];
  const at = { x: 0.2, y: 0.9, z: 1.37 };
  const ball = { position: at, velocity: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, status: 'live', lastBounceHalf: null } as unknown as Incoming['ball'];
  return {
    onIncoming(listener: (incoming: Incoming) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    send(idealAtMs: number, receiver: Incoming['receiver'] = 'player', x = 0.2) {
      const strike = { ...ball, position: { ...at, x } };
      const incoming: Incoming = { receiver, ball, launchedAtMs: idealAtMs - 800, ideal: { simSeconds: 0.64, position: strike.position }, idealAtMs, strike, shotIndex: 1 };
      for (const listener of listeners) listener(incoming);
    },
  };
}

/** Feed `n` Incomings to a SimPlayer one second apart and collect its Swings with their Ideal Times. */
function swingsFor(model: PlayerModel, n: number, seed: number): { swing: SwingEvent; idealAtMs: number }[] {
  const core = fakeCore();
  const player = createSimPlayer(model, core, makeRng(seed));
  const out: { swing: SwingEvent; idealAtMs: number }[] = [];
  let idealAtMs = 0;
  player.subscribe((swing) => out.push({ swing, idealAtMs }));
  for (let i = 0; i < n; i++) {
    idealAtMs = 10_000 + i * 1000;
    core.send(idealAtMs);
    player.advance(idealAtMs + 500);
  }
  return out;
}

describe('createSimPlayer', () => {
  it('swings once at each Ideal Time toward the player, Timing Offset added, and not before it is due', () => {
    const core = fakeCore();
    const player = createSimPlayer({ ...PERFECT, timingMeanMs: 30 }, core, makeRng(1));
    const swings: SwingEvent[] = [];
    player.subscribe((s) => swings.push(s));
    core.send(5000);
    player.advance(5000);
    expect(swings).toHaveLength(0);
    player.advance(5000 + TIMING_OFFSET_MS.value + 30);
    expect(swings).toHaveLength(1);
    expect(swings[0]!.t).toBeCloseTo(5000 + TIMING_OFFSET_MS.value + 30, 9);
    expect(swings[0]!.peakSpeed).toBe(PERFECT.speedMean);
    expect(swings[0]!.vertPath).toBe(0);
    player.advance(9000);
    expect(swings).toHaveLength(1);
  });

  it("ignores Shots toward the Opponent, and a new Incoming replaces a Swing that wasn't due yet", () => {
    const core = fakeCore();
    const player = createSimPlayer(PERFECT, core, makeRng(2));
    const swings: SwingEvent[] = [];
    player.subscribe((s) => swings.push(s));
    core.send(1000, 'opponent');
    player.advance(5000);
    expect(swings).toHaveLength(0);
    core.send(6000);
    core.send(7000);
    player.advance(8000);
    expect(swings.map((s) => s.t)).toEqual([7000 + TIMING_OFFSET_MS.value]);
  });

  it('plays a Forehand on the hitting-hand side and a Backhand across the body', () => {
    const core = fakeCore();
    const player = createSimPlayer(PERFECT, core, makeRng(3), { hand: 'right' });
    const sides: string[] = [];
    player.subscribe((s) => sides.push(s.side));
    core.send(1000, 'player', 0.3);
    player.advance(2000);
    core.send(3000, 'player', -0.3);
    player.advance(4000);
    expect(sides).toEqual(['forehand', 'backhand']);
  });

  it('draws timing, speed and vertical path from the model, and drops Swings at 1 − detectRate', () => {
    const model: PlayerModel = { name: 'noisy', timingMeanMs: 20, timingSdMs: 60, detectRate: 0.8, speedMean: 6.5, speedSd: 1.2, vertPathMean: 0.8, vertPathSd: 0.9 };
    const n = 5000;
    const swings = swingsFor(model, n, 4);
    expect(swings.length / n).toBeGreaterThan(0.78);
    expect(swings.length / n).toBeLessThan(0.82);
    const timing = swings.map(({ swing, idealAtMs }) => swing.t - TIMING_OFFSET_MS.value - idealAtMs);
    expect(Math.abs(mean(timing) - 20)).toBeLessThan(3);
    expect(Math.abs(sd(timing) - 60)).toBeLessThan(3);
    expect(Math.abs(mean(swings.map((s) => s.swing.peakSpeed)) - 6.5)).toBeLessThan(0.1);
    expect(Math.abs(sd(swings.map((s) => s.swing.peakSpeed)) - 1.2)).toBeLessThan(0.1);
    expect(Math.abs(mean(swings.map((s) => s.swing.vertPath)) - 0.8)).toBeLessThan(0.1);
    expect(Math.abs(sd(swings.map((s) => s.swing.vertPath)) - 0.9)).toBeLessThan(0.1);
  });

  it('replays the same Swings from the same seed', () => {
    const model: PlayerModel = { ...PERFECT, timingSdMs: 80, detectRate: 0.9, speedSd: 1, vertPathSd: 1 };
    expect(swingsFor(model, 200, 9)).toEqual(swingsFor(model, 200, 9));
    expect(swingsFor(model, 200, 9)).not.toEqual(swingsFor(model, 200, 10));
  });

  it('with zero timing error and detectRate 1, returns every good Shot in headless Rallies against the Opponent', () => {
    for (const name of ['novice', 'expert'] as const) {
      const core = createGameCore({
        random: makeRng(33),
        resolverParams: knobResolverParams,
        hand: () => 'right',
        mode: 'match',
        opponent: createBrain(DIFFICULTIES[name]),
        match: { pointsToWin: 3, winBy: 1, bestOf: 1 },
      });
      const player = createSimPlayer(PERFECT, core, makeRng(34));
      let nowMs = 0;
      player.subscribe((swing) => core.swing(swing, nowMs));
      const toPlayer: Incoming[] = [];
      const shots: ShotEvent[] = [];
      const ends: Extract<RallyEvent, { type: 'end' }>[] = [];
      core.onIncoming((i) => i.receiver === 'player' && toPlayer.push(i));
      core.onShot((e) => shots.push(e));
      core.onRally((e) => e.type === 'end' && ends.push(e));
      for (let frame = 0; frame < 60 * 600 && core.match?.phase !== 'match-over'; frame++) {
        nowMs += 1000 / 60;
        player.advance(nowMs);
        core.frame({ nowMs, elapsedSeconds: 1 / 60 });
      }
      expect(core.match?.phase).toBe('match-over');
      // Every Shot toward the player (and every toss) is struck, and every Return lands: the player never loses a Point.
      // (An Opponent Error that never reaches the player has no Ideal Time; the resolver calls it a Miss at once.)
      expect(shots.filter((e) => e.type === 'contact')).toHaveLength(toPlayer.length);
      expect(shots.filter((e) => ['early', 'late', 'off-target'].includes(e.type))).toEqual([]);
      expect(ends.filter((e) => e.loser === 'player')).toEqual([]);
      expect(ends.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('topspinOf', () => {
  it('recovers the Topspin or Backspin a Shot was launched with, in any direction of travel', () => {
    for (const [topspin, d] of [
      [120, { x: 0, y: 0, z: 1 }],
      [-90, { x: 0.6, y: 0, z: -0.8 }],
      [45, { x: -0.28, y: 0, z: 0.96 }],
    ] as const) {
      const velocity = { x: 7 * d.x, y: 1.5, z: 7 * d.z };
      expect(topspinOf({ velocity, spin: spinVector(topspin, 0, d) })).toBeCloseTo(topspin, 9);
      expect(topspinOf({ velocity, spin: spinVector(topspin, 30, d) })).toBeCloseTo(topspin, 9);
    }
    expect(topspinOf({ velocity: { x: 0, y: 2, z: 0 }, spin: { x: 5, y: 0, z: 0 } })).toBe(0);
  });
});

describe('createSimPlayer with the Phone', () => {
  const FULL = revsToRadPerSec(40); // SPIN_ANSWER_FULL_REVS
  const DEG = Math.PI / 180;

  /** Like `fakeCore`, but each Incoming is a Shot toward the player carrying `topspin` (rad/s). */
  function spinningCore() {
    const listeners: ((incoming: Incoming) => void)[] = [];
    return {
      onIncoming(listener: (incoming: Incoming) => void) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      send(idealAtMs: number, topspin: number) {
        const d = { x: 0, y: 0, z: 1 };
        const ball = { position: { x: 0, y: 1, z: -1.4 }, velocity: { x: 0, y: 1, z: 8 }, spin: spinVector(topspin, 0, d), seed: 0, status: 'live', lastBounceHalf: null } as Incoming['ball'];
        const strike = { ...ball, position: { x: 0.2, y: 0.9, z: 1.37 } };
        const incoming: Incoming = { receiver: 'player', ball, launchedAtMs: idealAtMs - 800, ideal: { simSeconds: 0.64, position: strike.position }, idealAtMs, strike, shotIndex: 1 };
        for (const listener of listeners) listener(incoming);
      },
    };
  }

  function phoneSwings(model: PlayerModel, faceAngleSdDeg: number, topspin: number, n: number, seed: number): SwingEvent[] {
    const core = spinningCore();
    const player = createSimPlayer(model, core, makeRng(seed), { phone: { faceAngleSdDeg } });
    const out: SwingEvent[] = [];
    player.subscribe((swing) => out.push(swing));
    for (let i = 0; i < n; i++) {
      core.send(10_000 + i * 1000, topspin);
      player.advance(10_000 + i * 1000 + 500);
    }
    return out;
  }

  it('with no error, sets the Face Angle that exactly answers the incoming Spin: open against Backspin, closed against Topspin, Zero against none', () => {
    const face = knobFaceAngleParams();
    for (const s of [-1, -0.5, 0, 0.3, 1]) {
      const [swing] = phoneSwings(PERFECT, 0, s * FULL, 1, 1);
      expect(swing!.faceAngle).toBeCloseTo(faceAngleForShare(s, face), 9);
      expect(faceAngleShare(swing!.faceAngle!, face)).toBeCloseTo(s, 9);
    }
    // Spin past full is answered as full.
    expect(phoneSwings(PERFECT, 0, -3 * FULL, 1, 1)[0]!.faceAngle).toBeCloseTo(faceAngleForShare(-1, face), 9);
  });

  it('adds Gaussian error to the Face Angle, with the given spread in degrees', () => {
    const target = faceAngleForShare(-0.5, knobFaceAngleParams());
    const errors = phoneSwings(PERFECT, 15, -0.5 * FULL, 5000, 7).map((s) => (s.faceAngle! - target) / DEG);
    expect(Math.abs(mean(errors))).toBeLessThan(0.7);
    expect(Math.abs(sd(errors) - 15)).toBeLessThan(0.7);
  });

  it('draws everything else as the Camera model does, with vertPath 0 as the Phone sends it', () => {
    const model: PlayerModel = { name: 'noisy', timingMeanMs: 20, timingSdMs: 60, detectRate: 0.8, speedMean: 6.5, speedSd: 1.2, vertPathMean: 0.8, vertPathSd: 0.9 };
    const n = 5000;
    const swings = phoneSwings(model, 15, 0, n, 4);
    expect(swings.length / n).toBeGreaterThan(0.78);
    expect(swings.length / n).toBeLessThan(0.82);
    expect(Math.abs(mean(swings.map((s) => s.peakSpeed)) - 6.5)).toBeLessThan(0.1);
    expect(Math.abs(sd(swings.map((s) => s.peakSpeed)) - 1.2)).toBeLessThan(0.1);
    expect(swings.every((s) => s.vertPath === 0)).toBe(true);
    // The first Incoming's draws are the Camera model's, in the same order.
    const camera = swingsFor({ ...model, detectRate: 1 }, 1, 11)[0]!.swing;
    const phone = phoneSwings({ ...model, detectRate: 1 }, 15, 0, 1, 11)[0]!;
    expect({ ...phone, vertPath: camera.vertPath, faceAngle: undefined }).toEqual(camera);
  });

  it('leaves Camera Swings without a Face Angle', () => {
    expect(swingsFor(PERFECT, 20, 3).every(({ swing }) => !('faceAngle' in swing))).toBe(true);
  });

  it('replays the same Swings from the same seed', () => {
    expect(phoneSwings(PERFECT, 15, FULL, 100, 5)).toEqual(phoneSwings(PERFECT, 15, FULL, 100, 5));
    expect(phoneSwings(PERFECT, 15, FULL, 100, 5)).not.toEqual(phoneSwings(PERFECT, 15, FULL, 100, 6));
  });

  it('with zero timing and Face Angle error, returns every good Shot in headless Rallies against the Opponent', () => {
    for (const name of ['novice', 'expert'] as const) {
      const core = createGameCore({
        random: makeRng(33),
        resolverParams: knobResolverParams,
        hand: () => 'right',
        mode: 'match',
        opponent: createBrain(DIFFICULTIES[name]),
        match: { pointsToWin: 3, winBy: 1, bestOf: 1 },
      });
      const player = createSimPlayer(PERFECT, core, makeRng(34), { phone: { faceAngleSdDeg: 0 } });
      let nowMs = 0;
      player.subscribe((swing) => core.swing(swing, nowMs));
      const toPlayer: Incoming[] = [];
      const shots: ShotEvent[] = [];
      const ends: Extract<RallyEvent, { type: 'end' }>[] = [];
      core.onIncoming((i) => i.receiver === 'player' && toPlayer.push(i));
      core.onShot((e) => shots.push(e));
      core.onRally((e) => e.type === 'end' && ends.push(e));
      for (let frame = 0; frame < 60 * 600 && core.match?.phase !== 'match-over'; frame++) {
        nowMs += 1000 / 60;
        player.advance(nowMs);
        core.frame({ nowMs, elapsedSeconds: 1 / 60 });
      }
      expect(core.match?.phase).toBe('match-over');
      expect(shots.filter((e) => e.type === 'contact')).toHaveLength(toPlayer.length);
      expect(shots.filter((e) => ['early', 'late', 'off-target'].includes(e.type))).toEqual([]);
      expect(ends.filter((e) => e.loser === 'player')).toEqual([]);
      expect(ends.length).toBeGreaterThanOrEqual(3);
    }
  }, 60_000);
});
