import { describe, expect, it } from 'vitest';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import { createPhonePresence } from '../phone/presence.ts';
import type { LinkStatus } from '../phone/types.ts';
import { makeRng } from '../util/rng.ts';
import { FEED_COUNTDOWN_STEP_S, FEED_PAUSE_S } from './constants.ts';
import { createGameCore, type GameCore, type MatchEvent } from './core.ts';
import { HAND_LOST_TEXT, handPause, PHONE_AWAY_TEXT, type HandSignals } from './handPause.ts';
import type { Opponent, RallyEvent } from './rally.ts';
import { knobResolverParams } from './shotResolver.ts';

describe('handPause', () => {
  it('Camera: waits until the wrist is tracked; the banner once it is lost', () => {
    expect(handPause({ input: 'camera', tracking: 'starting' })).toEqual({ waiting: true, banner: null });
    expect(handPause({ input: 'camera', tracking: 'tracked' })).toEqual({ waiting: false, banner: null });
    expect(handPause({ input: 'camera', tracking: 'lost' })).toEqual({ waiting: true, banner: HAND_LOST_TEXT });
  });

  it('Phone: waits while not sending or away; "Phone disconnected: unlock your phone" while away', () => {
    expect(handPause({ input: 'phone', sending: true, away: false })).toEqual({ waiting: false, banner: null });
    expect(handPause({ input: 'phone', sending: false, away: false })).toEqual({ waiting: true, banner: null });
    expect(handPause({ input: 'phone', sending: false, away: true })).toEqual({ waiting: true, banner: PHONE_AWAY_TEXT });
    expect(handPause({ input: 'phone', sending: true, away: true })).toEqual({ waiting: true, banner: PHONE_AWAY_TEXT });
    expect(PHONE_AWAY_TEXT).toBe('Phone disconnected: unlock your phone');
  });

  it('the developer mouse never waits', () => {
    expect(handPause({ input: 'mouse' })).toEqual({ waiting: false, banner: null });
  });
});

const FRAME_S = 1 / 60;
/** From resuming to the next Serve: the wait between Rallies, then "3, 2, 1". */
const SERVE_WAIT_MS = 1000 * (FEED_PAUSE_S.value + 3 * FEED_COUNTDOWN_STEP_S.value);

function countingOpponent(): Opponent & { serves: number } {
  const scripted = createScriptedOpponent();
  const opponent = {
    serves: 0,
    chooseShot: scripted.chooseShot,
    chooseServe: (random: () => number) => (opponent.serves++, scripted.chooseServe(random)),
  };
  return opponent;
}

/** A Match where the Opponent serves first, stepped a frame at a time with the pause from `signals()`, as the game loop does. */
function matchWith(signals: (nowMs: number) => HandSignals) {
  const rng = makeRng(17);
  let first = true;
  const random = () => (first ? ((first = false), 0.75) : rng()); // the Opponent serves first
  const opponent = countingOpponent();
  const core: GameCore = createGameCore({ random, resolverParams: knobResolverParams, hand: () => 'right', mode: 'match', opponent });
  const run = { rally: [] as RallyEvent[], match: [] as MatchEvent[], banners: [] as (string | null)[], countdowns: [] as number[] };
  core.onRally((e) => run.rally.push(e));
  core.onMatch((e) => run.match.push(e));
  let nowMs = 1000;
  const step = () => {
    nowMs += 1000 * FRAME_S;
    const pause = handPause(signals(nowMs));
    core.setPaused(pause.waiting);
    core.frame({ nowMs, elapsedSeconds: FRAME_S });
    run.banners.push(pause.banner);
    if (core.countdown !== null && core.countdown !== run.countdowns.at(-1)) run.countdowns.push(core.countdown);
  };
  return { core, opponent, run, step, now: () => nowMs };
}

describe('the disconnect pause', () => {
  it('a Phone that disconnects mid-Rally pauses play like a lost hand, and its return resumes after "3, 2, 1"', () => {
    // The Phone: a link status and a packet stream, through the same presence the game polls.
    let status: LinkStatus = 'connected';
    let streaming = true;
    let lastPacketAt = -Infinity;
    const presence = createPhonePresence();
    const game = matchWith((nowMs) => {
      if (streaming) lastPacketAt = nowMs;
      const sending = nowMs - lastPacketAt <= 500;
      return { input: 'phone', sending, away: presence.update({ status, lastPacketAt }, nowMs) };
    });
    // Same Match, same moment, with the Camera losing the hand instead.
    let tracking: 'tracked' | 'lost' = 'tracked';
    const camera = matchWith(() => ({ input: 'camera', tracking }));

    for (const g of [game, camera]) {
      while (g.opponent.serves === 0) g.step();
      for (let i = 0; i < 10; i++) g.step(); // the Serve is in flight
      expect(g.core.match!.phase).toBe('rally');
    }
    const before = game.core.match!;

    // The Phone locks: its page closes the link (peer-left) and the packets stop.
    status = 'disconnected';
    streaming = false;
    tracking = 'lost';
    for (const g of [game, camera]) g.step();
    expect(game.run.banners.at(-1)).toBe('Phone disconnected: unlock your phone');
    expect(camera.run.banners.at(-1)).toBe("Can't see your hand");
    // The Rally is void for both, the same way: no Point, the same Serve to come.
    for (const g of [game, camera]) {
      expect(g.core.match).toMatchObject({ phase: 'pre-serve', points: before.points, server: before.server, servesLeft: before.servesLeft });
    }
    for (let i = 0; i < 1200; i++) for (const g of [game, camera]) g.step();
    for (const g of [game, camera]) {
      expect(g.run.match).toEqual([]);
      expect(g.run.rally.filter((e) => e.type === 'end')).toEqual([]);
      expect(g.opponent.serves).toBe(1);
      expect(g.core.countdown).toBeNull();
    }
    expect(game.core.match).toEqual(camera.core.match);

    // Unlocked: the page rejoins the same room, the link comes up and packets flow again.
    status = 'connected';
    streaming = true;
    tracking = 'tracked';
    const resumedAt = game.now();
    const countdownsBefore = game.run.countdowns.length;
    while (game.opponent.serves === 1) game.step();
    expect(game.run.banners.at(-1)).toBeNull();
    expect(game.now() - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(game.run.countdowns.slice(countdownsBefore)).toEqual([3, 2, 1]); // the existing Match countdown
    expect(game.core.match).toMatchObject({ phase: 'rally', points: before.points, server: before.server, servesLeft: before.servesLeft });
    expect(game.run.match).toEqual([]);
  });

  it('a Phone in relay that goes quiet without a word is away too, and resumes the same way', () => {
    let lastPacketAt = -Infinity;
    let streaming = true;
    const presence = createPhonePresence();
    const game = matchWith((nowMs) => {
      if (streaming) lastPacketAt = nowMs;
      return { input: 'phone', sending: nowMs - lastPacketAt <= 500, away: presence.update({ status: 'relay', lastPacketAt }, nowMs) };
    });
    while (game.opponent.serves === 0) game.step();
    for (let i = 0; i < 10; i++) game.step();
    streaming = false; // the page froze; the link still says relay
    for (let i = 0; i < 90; i++) game.step();
    expect(game.run.banners.at(-1)).toBe(PHONE_AWAY_TEXT);
    expect(game.core.match!.phase).toBe('pre-serve');
    streaming = true;
    const resumedAt = game.now();
    while (game.opponent.serves === 1) game.step();
    expect(game.now() - resumedAt).toBeGreaterThanOrEqual(SERVE_WAIT_MS);
    expect(game.run.match).toEqual([]);
  });
});
