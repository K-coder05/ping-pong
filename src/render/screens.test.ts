import { describe, expect, it, vi } from 'vitest';
import { SWING_FAST, SWING_ON, TIMING_OFFSET_MS } from '../game/constants.ts';
import { createGameCore, type MatchEvent } from '../game/core.ts';
import type { MatchState } from '../game/match.ts';
import type { RallyEvent } from '../game/rally.ts';
import { knobResolverParams } from '../game/shotResolver.ts';
import { createScriptedOpponent } from '../opponent/scripted.ts';
import { DIFFICULTIES } from '../opponent/difficulty.ts';
import { makeRng } from '../util/rng.ts';
import {
  coreOptionsFromChoice,
  createMatchStats,
  gameOverModel,
  nextScreen,
  playingFromSearch,
  skipsStartScreen,
  START_SCREEN,
  watchMatch,
  type MatchResult,
  type ScreenAction,
  type ScreenState,
} from './screens.ts';

/** Press the buttons `actions` names, in order, from `state`. */
function press(state: ScreenState, ...actions: ScreenAction[]): ScreenState {
  return actions.reduce(nextScreen, state);
}

const RESULT: MatchResult = {
  winner: 'player',
  games: { player: 1, opponent: 0 },
  gameScores: [{ player: 11, opponent: 7 }],
  longestRally: 9,
  returns: 23,
  failed: { early: 2, late: 1, miss: 3, offTarget: 2 },
};

const coreFor = (options: ReturnType<typeof coreOptionsFromChoice>) =>
  createGameCore({ random: makeRng(5), resolverParams: knobResolverParams, hand: () => 'right', ...options });

describe('the start screen', () => {
  it('takes Match, a Difficulty and best of 3 to the GameCore: a Match against that Difficulty\'s brain, best of 3 Games to 11', () => {
    const state = press(START_SCREEN, { type: 'match' }, { type: 'difficulty', difficulty: 'expert' }, { type: 'length', bestOf: 3 }, { type: 'start' });
    expect(state).toMatchObject({ screen: 'playing', choice: { mode: 'match', difficulty: 'expert', bestOf: 3 } });
    if (state.screen !== 'playing') throw new Error('not playing');

    const opponent = createScriptedOpponent();
    const makeOpponent = vi.fn(() => opponent);
    const options = coreOptionsFromChoice(state.choice, makeOpponent);
    expect(makeOpponent).toHaveBeenCalledWith(DIFFICULTIES.expert);
    expect(options).toEqual({ mode: 'match', opponent, match: { pointsToWin: 11, winBy: 2, bestOf: 3 } });

    const core = coreFor(options);
    expect(core.mode).toBe('match');
    expect(core.match).toMatchObject({ phase: 'pre-serve', games: { player: 0, opponent: 0 } });
  });

  it('defaults to Intermediate and 1 Game', () => {
    const state = press(START_SCREEN, { type: 'match' }, { type: 'start' });
    if (state.screen !== 'playing') throw new Error('not playing');
    const makeOpponent = vi.fn(createScriptedOpponent);
    expect(coreOptionsFromChoice(state.choice, makeOpponent).match).toEqual({ pointsToWin: 11, winBy: 2, bestOf: 1 });
    expect(makeOpponent).toHaveBeenCalledWith(DIFFICULTIES.intermediate);
  });

  it('takes Return Drill to a Return Drill core, with no Opponent or Match', () => {
    const state = press(START_SCREEN, { type: 'return-drill' });
    expect(state).toMatchObject({ screen: 'playing', choice: { mode: 'drill' } });
    if (state.screen !== 'playing') throw new Error('not playing');
    const options = coreOptionsFromChoice(state.choice);
    expect(options).toEqual({ mode: 'drill' });
    const core = coreFor(options);
    expect(core.mode).toBe('drill');
    expect(core.match).toBeNull();
  });

  it('goes Back from the Match screen to the start, keeping the picks', () => {
    const state = press(START_SCREEN, { type: 'match' }, { type: 'difficulty', difficulty: 'novice' }, { type: 'back' });
    expect(state).toEqual({ screen: 'start', draft: { difficulty: 'novice', bestOf: 1 } });
    expect(press(state, { type: 'match' })).toEqual({ screen: 'match-setup', draft: { difficulty: 'novice', bestOf: 1 } });
  });

  it('ignores a button the current screen doesn\'t show', () => {
    expect(nextScreen(START_SCREEN, { type: 'start' })).toBe(START_SCREEN);
    expect(nextScreen(START_SCREEN, { type: 'rematch' })).toBe(START_SCREEN);
    const drill = press(START_SCREEN, { type: 'return-drill' });
    expect(nextScreen(drill, { type: 'match-over', result: RESULT })).toBe(drill); // Return Drill has no Game over
  });
});

describe('the Game-over screen', () => {
  const playing = press(START_SCREEN, { type: 'match' }, { type: 'difficulty', difficulty: 'novice' }, { type: 'length', bestOf: 3 }, { type: 'start' });
  const over = nextScreen(playing, { type: 'match-over', result: RESULT });

  it('shows when the Match is over', () => {
    expect(over).toMatchObject({ screen: 'game-over', result: RESULT, choice: { mode: 'match', difficulty: 'novice', bestOf: 3 } });
  });

  it('Rematch plays the same Match again', () => {
    expect(press(over, { type: 'rematch' })).toEqual(playing);
  });

  it('Change Difficulty goes to the Match screen with the last picks', () => {
    expect(press(over, { type: 'change-difficulty' })).toEqual({ screen: 'match-setup', draft: { difficulty: 'novice', bestOf: 3 } });
    const harder = press(over, { type: 'change-difficulty' }, { type: 'difficulty', difficulty: 'expert' }, { type: 'start' });
    expect(harder).toMatchObject({ screen: 'playing', choice: { mode: 'match', difficulty: 'expert', bestOf: 3 } });
  });

  it('Back to start goes to the start screen; so does leaving play', () => {
    expect(press(over, { type: 'back-to-start' })).toMatchObject({ screen: 'start' });
    expect(press(playing, { type: 'back-to-start' })).toMatchObject({ screen: 'start' });
  });
});

describe('developer URL flags', () => {
  it('skip the start screen', () => {
    for (const search of ['?mode=match', '?difficulty=expert', '?input=mouse', '?seed=42']) expect(skipsStartScreen(search)).toBe(true);
    expect(skipsStartScreen('')).toBe(false);
    expect(skipsStartScreen('?overlay')).toBe(false);
  });

  it('play as they ask: a one-Game Match at the Difficulty asked for, else Return Drill', () => {
    expect(playingFromSearch('?mode=match&difficulty=expert').choice).toEqual({ mode: 'match', difficulty: 'expert', bestOf: 1 });
    expect(playingFromSearch('?mode=match').choice).toEqual({ mode: 'match', difficulty: 'intermediate', bestOf: 1 });
    expect(playingFromSearch('?seed=3').choice).toEqual({ mode: 'drill' });
  });
});

describe('createMatchStats', () => {
  const at = 0;
  const shot = (by: 'player' | 'opponent', shotIndex: number): RallyEvent => ({ type: 'shot', atMs: at, by, shotIndex });
  const bounce = (half: 'player' | 'opponent'): RallyEvent => ({ type: 'bounce', atMs: at, half });
  const end = (loser: 'player' | 'opponent', how: 'net' | 'out' | 'own-half' | 'unreturned' = 'unreturned'): RallyEvent => ({ type: 'end', atMs: at, end: how, loser });
  const state = (phase: MatchState['phase'], points: [number, number], games: [number, number]): MatchState => ({
    games: { player: games[0], opponent: games[1] },
    points: { player: points[0], opponent: points[1] },
    server: 'player',
    servesLeft: 2,
    gameFirstServer: 'player',
    phase,
    ...(phase === 'match-over' ? { winner: games[0] > games[1] ? 'player' : 'opponent' } : {}),
  });
  const point = (to: 'player' | 'opponent', match: MatchState): MatchEvent => ({ type: 'point', atMs: at, to, end: 'unreturned', match });

  it('tallies the longest Rally, the player\'s Returns and failed Shots, and the final score', () => {
    const stats = createMatchStats();
    // Rally 1: Opponent serves, player returns, Opponent returns, player Returns again, the Opponent misses: 4 Shots.
    stats.incoming('player', false);
    for (const e of [shot('opponent', 0), bounce('opponent'), bounce('player'), shot('player', 1), bounce('opponent'), shot('opponent', 2), bounce('player'), shot('player', 3), bounce('opponent'), end('opponent')]) stats.rally(e);
    // Rally 2: a Let (void), then the Opponent serves again and the player Misses.
    stats.rally(shot('opponent', 0));
    stats.rally({ type: 'serve', atMs: at, by: 'opponent', result: 'let' });
    stats.rally(shot('opponent', 0));
    stats.incoming('player', false);
    stats.shot({ type: 'miss' });
    stats.rally(end('player'));
    // Rally 3: the player's toss is missed (not a failed Shot), then they serve; the Opponent returns, and the player's Return goes into the net.
    stats.incoming('player', true);
    stats.shot({ type: 'late', delta: 200 });
    stats.incoming('player', true);
    for (const e of [shot('player', 0), bounce('player'), bounce('opponent')]) stats.rally(e);
    stats.incoming('player', false);
    stats.shot({ type: 'early', delta: -300, final: false }); // kept the try
    for (const e of [shot('opponent', 1), bounce('player'), shot('player', 2), end('player', 'net')]) stats.rally(e);
    // Rally 4: Late.
    stats.incoming('player', false);
    stats.shot({ type: 'late', delta: 180 });
    stats.shot({ type: 'early', delta: -250, final: true });

    expect(stats.result).toBeNull();
    stats.match(point('player', state('pre-serve', [1, 0], [0, 0])));
    stats.match(point('player', state('game-over', [11, 6], [1, 0])));
    stats.match(point('opponent', state('match-over', [9, 11], [1, 2])));
    expect(stats.result).toEqual({
      winner: 'opponent',
      games: { player: 1, opponent: 2 },
      gameScores: [
        { player: 11, opponent: 6 },
        { player: 9, opponent: 11 },
      ],
      longestRally: 4,
      returns: 2,
      failed: { early: 1, late: 1, miss: 1, offTarget: 1 },
    });
  });
});

describe('gameOverModel', () => {
  it('words a one-Game Match: winner, the Game\'s score and the tally', () => {
    expect(gameOverModel(RESULT, { difficulty: 'intermediate', bestOf: 1 })).toEqual({
      title: 'You win!',
      score: '11 – 7',
      gameScores: null,
      setting: 'Intermediate · 1 Game',
      facts: [
        { label: 'Longest Rally', value: '9 Shots' },
        { label: 'Your Returns', value: '23' },
        { label: 'Failed Shots', value: '8 (Early 2 · Late 1 · Miss 3 · Net or out 2)' },
      ],
    });
  });

  it('words a best of 3 by Games, with each Game\'s score', () => {
    const result: MatchResult = {
      ...RESULT,
      winner: 'opponent',
      games: { player: 1, opponent: 2 },
      gameScores: [
        { player: 11, opponent: 7 },
        { player: 9, opponent: 11 },
        { player: 5, opponent: 11 },
      ],
      longestRally: 1,
      failed: { early: 0, late: 0, miss: 4, offTarget: 0 },
    };
    const model = gameOverModel(result, { difficulty: 'expert', bestOf: 3 });
    expect(model).toMatchObject({ title: 'The Opponent wins', score: '1 – 2', gameScores: '11–7 · 9–11 · 5–11', setting: 'Expert · Best of 3' });
    expect(model.facts).toContainEqual({ label: 'Longest Rally', value: '1 Shot' });
    expect(model.facts).toContainEqual({ label: 'Failed Shots', value: '4 (Miss 4)' });
  });
});

describe('watchMatch', () => {
  it('tallies a headless Match played from the start screen\'s choice, matching the core\'s final score', () => {
    const choice = press(START_SCREEN, { type: 'match' }, { type: 'difficulty', difficulty: 'novice' }, { type: 'start' });
    if (choice.screen !== 'playing') throw new Error('not playing');
    const core = coreFor(coreOptionsFromChoice(choice.choice));
    const { stats, unsubscribe } = watchMatch(core);

    // A scripted player: a flat Forehand exactly at each Ideal Time (tosses too), letting a few go by.
    const random = makeRng(9);
    let due: number | null = null;
    core.onIncoming((incoming) => {
      if (incoming.receiver === 'player' && random() >= 0.1) due = incoming.idealAtMs + TIMING_OFFSET_MS.value;
    });
    const FRAME_S = 1 / 60;
    for (let i = 1; i <= 3600 / FRAME_S && core.match!.phase !== 'match-over'; i++) {
      const nowMs = 1000 + i * FRAME_S * 1000;
      if (due !== null && nowMs >= due) {
        core.swing({ t: due, peakSpeed: (SWING_ON.value + SWING_FAST.value) / 2, side: 'forehand', vertPath: 0 }, nowMs);
        due = null;
      }
      core.frame({ nowMs, elapsedSeconds: FRAME_S });
    }
    unsubscribe();

    const final = core.match!;
    expect(final.phase).toBe('match-over');
    const result = stats.result!;
    expect(result.winner).toBe(final.winner);
    expect(result.gameScores).toEqual([final.points]);
    expect(result.longestRally).toBeGreaterThanOrEqual(3);
    expect(result.returns).toBeGreaterThan(0);
    expect(result.failed.miss).toBeGreaterThan(0);
  });
});
